/* Author: Hudson S. Borges */
import EventEmitter from 'node:events';
import { Agent } from 'node:https';
import { setTimeout } from 'node:timers/promises';

import Bottleneck from 'bottleneck';
import dayjs from 'dayjs';
import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import minBy from 'lodash/minBy.js';
import Limiter from 'p-limit';

import { ProxyClient } from './proxy-client.js';

export type ProxyRouterOpts = {
  requestTimeout: number;
  minRemaining: number;
  overrideAuthorization?: boolean;
  clustering?: {
    host: string;
    port: number;
    db: number;
  };
};

type ExtendedRequest = Request & {
  startedAt?: Date;
  abortController?: AbortController;
};

type APIResources = 'core' | 'search' | 'code_search' | 'graphql';

export interface WorkerLogger {
  resource: APIResources;
  token: string;
  pending: number;
  remaining: number;
  reset: number;
  status?: number | string;
  duration: number;
}

class ProxyWorker extends EventEmitter {
  readonly queue: Bottleneck;

  readonly proxy: ProxyClient;
  readonly token: string;
  readonly schedule;
  private readonly opts: ProxyRouterOpts;

  readonly defaults: {
    resource: APIResources;
    limit: number;
    reset: number;
  };

  remaining = 0;
  reset: number = Date.now() / 1000 + 1;

  constructor(token: string, opts: ProxyRouterOpts & { resource: APIResources }) {
    super({});

    this.token = token;
    this.opts = opts;

    switch (opts.resource) {
      case 'code_search':
        this.defaults = { resource: opts.resource, limit: 10, reset: 1000 * 60 };
        break;
      case 'search':
        this.defaults = { resource: opts.resource, limit: 30, reset: 1000 * 60 };
        break;
      default:
        this.defaults = { resource: opts.resource, limit: 5000, reset: 1000 * 60 * 60 };
    }

    this.proxy = new ProxyClient({
      target: 'https://api.github.com',
      timeout: opts.requestTimeout,
      agent: new Agent({
        keepAlive: true,
        keepAliveMsecs: 15000,
        timeout: opts.requestTimeout,
        scheduling: 'fifo'
      })
    });

    let maxConcurrent = 1;
    if (opts.resource === 'graphql') maxConcurrent = 2;
    else if (opts.resource === 'core') maxConcurrent = 10;

    this.queue = new Bottleneck({
      maxConcurrent,
      id: `proxy_server:${opts.resource}:${this.token}`,
      ...(opts?.clustering
        ? {
            datastore: 'ioredis',
            clearDatastore: false,
            clientOptions: {
              host: opts.clustering.host,
              port: opts.clustering.port,
              options: { db: opts.clustering.db }
            },
            timeout: opts.requestTimeout
          }
        : { datastore: 'local' })
    });

    this.schedule = this.queue.wrap(async (req: ExtendedRequest, res: Response): Promise<void> => {
      if (req.socket.destroyed) return this.log();

      if (this.remaining <= opts.minRemaining && this.reset > Date.now() / 1000) {
        this.emit('retry', req, res);
        return;
      }

      req.startedAt = new Date();
      this.remaining -= 1;

      const task = (async () => {
        try {
          // Check if request has authorization header
          const hasAuthorization = opts.overrideAuthorization ? false : !!req.headers.authorization;

          await this.proxy.proxy(req, res, {
            modifyHeaders: (headers) => {
              // Inject authorization token if not present
              if (!hasAuthorization) {
                headers.authorization = `token ${token}`;
              }
              return headers;
            },
            onResponse: async (data) => {
              // Rewrite Link header URLs from GitHub API to proxy server
              const linkHeader = data.headers.link;
              if (linkHeader && req.headers.host) {
                data.headers.link = linkHeader.replaceAll(
                  'https://api.github.com',
                  `http://${req.headers.host}`
                );
              }

              // Only update rate limits and filter headers if we injected the token
              if (!hasAuthorization) {
                // Update rate limits from response headers
                const status = data.status.toString();
                const rateLimitRemaining = data.headers['x-ratelimit-remaining'];
                const rateLimitReset = data.headers['x-ratelimit-reset'];
                const rateLimitLimit = data.headers['x-ratelimit-limit'];

                if (rateLimitRemaining) {
                  this.updateLimits({
                    status,
                    'x-ratelimit-remaining': rateLimitRemaining,
                    'x-ratelimit-reset': rateLimitReset || '',
                    'x-ratelimit-limit': rateLimitLimit || ''
                  });
                }

                this.log(data.status, req.startedAt);

                // Remove rate limit and scope headers to hide token info from clients
                for (const key of Object.keys(data.headers)) {
                  if (/(ratelimit|scope)/i.test(key)) {
                    delete data.headers[key];
                  }
                }

                // Update access-control-expose-headers to exclude removed headers
                const exposeHeaders = data.headers['access-control-expose-headers'];
                if (exposeHeaders) {
                  const filtered = exposeHeaders
                    .split(', ')
                    .filter((header) => !/(ratelimit|scope)/i.test(header))
                    .join(', ');
                  if (filtered) {
                    data.headers['access-control-expose-headers'] = filtered;
                  } else {
                    delete data.headers['access-control-expose-headers'];
                  }
                }
              }
            }
          });
        } catch (error) {
          const err = error as Error & { code?: string };
          const errorCode = err.code || err.message;
          this.log(
            errorCode === 'ETIMEDOUT' ? 'ETIMEDOUT' : ProxyRouterResponse.PROXY_ERROR,
            req.startedAt
          );

          if (!req.socket.destroyed && !req.socket.writableFinished) {
            res.status(StatusCodes.BAD_GATEWAY).send();
          }

          req.abortController?.abort();
          res.destroy();
        }
      })();

      await Promise.all([
        task,
        setTimeout(['search', 'code_search'].includes(opts.resource) ? 2000 : 1000)
      ]);
    });
  }

  public async refreshRateLimits(): Promise<void> {
    await fetch('https://api.github.com/rate_limit', {
      headers: {
        authorization: `token ${this.token}`,
        'user-agent': 'GitHub API Proxy Server (@hsborges/github-proxy-server)'
      }
    }).then(async (response) => {
      if (response.status === 401) {
        this.remaining = 0;
        this.reset = Number.POSITIVE_INFINITY;
        this.emit('error', `Invalid token detected (${this.token}).`, this.token);
      } else {
        const res = (await response.json()) as {
          resources: Record<string, { remaining: number; reset: number }>;
        };
        this.remaining = res.resources[this.defaults.resource].remaining;
        this.reset = res.resources[this.defaults.resource].reset;
        this.log(undefined, new Date());
      }
    });
  }

  private updateLimits(headers: Record<string, string>): void {
    if (!headers['x-ratelimit-remaining']) return;
    if (/401/i.test(headers.status)) {
      if (Number.parseInt(headers['x-ratelimit-limit'], 10) > 0) this.remaining = 0;
      else this.remaining -= 1;
    } else {
      this.remaining = Number.parseInt(headers['x-ratelimit-remaining'], 10) - this.running;
      this.reset = Number.parseInt(headers['x-ratelimit-reset'], 10);
    }
  }

  private log(status?: number | string, startedAt?: Date): void {
    this.emit('log', {
      resource: this.defaults.resource,
      token: this.token.slice(-4),
      pending: this.queued,
      remaining: this.remaining,
      reset: this.reset,
      status: status,
      duration: startedAt ? Date.now() - startedAt.getTime() : 0
    } satisfies WorkerLogger);
  }

  get pending(): number {
    const { RECEIVED, QUEUED, RUNNING, EXECUTING } = this.queue.counts();
    return RECEIVED + QUEUED + RUNNING + EXECUTING;
  }

  get running(): number {
    const { RUNNING, EXECUTING } = this.queue.counts();
    return RUNNING + EXECUTING;
  }

  get queued(): number {
    const { RECEIVED, QUEUED } = this.queue.counts();
    return RECEIVED + QUEUED;
  }

  destroy(): this {
    // ProxyClient doesn't require explicit cleanup
    return this;
  }
}

export enum ProxyRouterResponse {
  PROXY_ERROR = 600
}

export default class ProxyRouter extends EventEmitter {
  private readonly options: ProxyRouterOpts;
  private readonly limiter = Limiter(1);

  private readonly clients: Array<{
    token: string;
    core: ProxyWorker;
    search: ProxyWorker;
    code_search: ProxyWorker;
    graphql: ProxyWorker;
  }>;

  constructor(tokens: string[], opts?: Partial<ProxyRouterOpts>) {
    super({});

    if (!tokens.length) throw new Error('At least one token is required!');

    this.clients = [];
    this.options = Object.assign({ requestTimeout: 20000, minRemaining: 100 }, opts);

    tokens.forEach((token) => this.addToken(token));
  }

  // function to select the best client and queue request
  async schedule(req: Request, res: Response): Promise<void> {
    return this.limiter(async () => {
      const isGraphQL = req.path.startsWith('/graphql') && req.method === 'POST';
      const isCodeSearch = req.path.startsWith('/search/code');
      const isSearch = req.path.startsWith('/search');

      let clients: ProxyWorker[];

      if (isGraphQL) clients = this.clients.map((client) => client.graphql);
      else if (isCodeSearch) clients = this.clients.map((client) => client.code_search);
      else if (isSearch) clients = this.clients.map((client) => client.search);
      else clients = this.clients.map((client) => client.core);

      const available = clients.filter(
        (client) =>
          client.remaining > (isSearch ? 1 : this.options.minRemaining) ||
          client.reset * 1000 < Date.now()
      );

      if (available.length === 0) {
        const resetAt = Math.min(...clients.map((c) => c.reset)) * 1000;

        this.emit(
          'warn',
          `There is no client available. Retrying at ${dayjs(resetAt).format('HH:mm:ss')}.`
        );

        return setTimeout(Math.max(0, resetAt - Date.now()) + 1000).then(() => {
          this.schedule(req, res);
        });
      }
      const client = minBy(
        available,
        (client) => client.pending + 1 / client.remaining
      ) as ProxyWorker;

      client.schedule(req, res);
    });
  }

  addToken(token: string): void {
    if (this.clients.map((client) => client.token).includes(token)) return;

    const core = new ProxyWorker(token, { ...this.options, resource: 'core' });
    const search = new ProxyWorker(token, { ...this.options, resource: 'search' });
    const codeSearch = new ProxyWorker(token, { ...this.options, resource: 'code_search' });
    const graphql = new ProxyWorker(token, { ...this.options, resource: 'graphql' });

    for (const worker of [core, search, codeSearch, graphql]) {
      worker.on('error', (error: unknown) => this.emit('error', error));
      worker.on('retry', (req: ExtendedRequest, res: Response) => this.schedule(req, res));
      worker.on('log', (log: WorkerLogger) => this.emit('log', log));
      worker.on('warn', (message: string) => this.emit('warn', message));
      worker.refreshRateLimits().then(() => this.emit('ready'));
    }

    this.clients.push({ token, core, search, code_search: codeSearch, graphql });
  }

  removeToken(token: string): void {
    this.clients.splice(this.clients.map((c) => c.token).indexOf(token), 1).forEach((client) => {
      for (const worker of [client.core, client.search, client.code_search, client.graphql]) {
        worker.queue.stop({ dropWaitingJobs: false });
        worker.queue.disconnect();
        worker.destroy();
      }
    });
  }

  async refreshRateLimits(): Promise<void> {
    await Promise.all(
      this.clients.map((client) =>
        Promise.all(
          [client.core, client.search, client.code_search, client.graphql].map((w) =>
            w.refreshRateLimits()
          )
        )
      )
    ).then(() => this.emit('ready'));
  }

  get tokens(): string[] {
    return this.clients.map((client) => client.token);
  }

  destroy(): this {
    this.clients.forEach((client) => this.removeToken(client.token));
    return this;
  }
}
