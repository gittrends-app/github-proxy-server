/* Author: Hudson S. Borges */
import EventEmitter from 'node:events';
import { setTimeout } from 'node:timers/promises';

import dayjs from 'dayjs';
import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import minBy from 'lodash/minBy.js';
import Limiter from 'p-limit';
import PQueue from 'p-queue';
import { Agent } from 'undici';

import { ProxyClient } from './proxy-client.js';

export type ProxyRouterOpts = {
  requestTimeout: number;
  minRemaining: number;
  overrideAuthorization?: boolean;
};

type ExtendedRequest = Request & {
  startedAt?: Date;
  abortController?: AbortController;
};

type APIResources = 'core' | 'search' | 'code_search' | 'graphql';

export interface WorkerLogger {
  resource: APIResources;
  token: string;
  running: number;
  pending: number;
  remaining: number;
  reset: number;
  timeBudget?: number;
  status?: number | string;
  duration: number;
}

class ProxyWorker extends EventEmitter {
  readonly queue: PQueue;

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

  // Secondary rate limiting: GraphQL 60s, Others 90s per 60s window
  timeBudget: number;
  private _budgetResetAt: number;

  private _queued = 0;
  private _running = 0;

  constructor(token: string, opts: ProxyRouterOpts & { resource: APIResources }) {
    super({});

    this.token = token;
    this.opts = opts;

    // GraphQL: 60s per 60s window, Others: 90s per 60s window (in milliseconds)
    this.timeBudget = opts.resource === 'graphql' ? 60000 : 90000;
    this._budgetResetAt = Date.now() + 60000;

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
      dispatcher: new Agent({
        connections: 100,
        pipelining: 10,
        keepAliveTimeout: 60000,
        keepAliveMaxTimeout: 600000,
        headersTimeout: opts.requestTimeout,
        bodyTimeout: opts.requestTimeout
      })
    });

    let maxConcurrent = 1;
    if (opts.resource === 'graphql') maxConcurrent = 5;
    else if (opts.resource === 'core') maxConcurrent = 10;

    this.queue = new PQueue({ concurrency: maxConcurrent });

    this.schedule = async (req: ExtendedRequest, res: Response): Promise<void> => {
      this._queued += 1;

      return this.queue.add(async () => {
        this._queued -= 1;
        this._running += 1;

        try {
          // Secondary rate limit check (time budget per resource)
          // Wait if budget is less than 6s (10%) for safety margin
          if (this.timeBudget < 6000) {
            const waitTime = this._budgetResetAt - Date.now();
            if (waitTime > 0) await setTimeout(waitTime);
          }

          // Reset time budget if window expired
          const now = Date.now();
          if (now >= this._budgetResetAt) {
            this.timeBudget = opts.resource === 'graphql' ? 60000 : 90000;
            this._budgetResetAt = now + 60000;
          }

          if (req.socket.destroyed) {
            return this.log();
          }

          if (this.remaining <= opts.minRemaining && this.reset > Date.now() / 1000) {
            this.emit('retry', req, res);
            return;
          }

          req.startedAt = new Date();
          this.remaining -= 1;

          const hasAuthorization = opts.overrideAuthorization ? false : !!req.headers.authorization;

          await this.proxy.proxy(req, res, {
            modifyHeaders: (headers) => {
              if (!hasAuthorization) headers.authorization = `token ${token}`;
              return headers;
            },
            onResponse: async (data) => {
              const linkHeader = data.headers.link;
              if (linkHeader && req.headers.host) {
                data.headers.link = linkHeader.replaceAll(
                  'https://api.github.com',
                  `http://${req.headers.host}`
                );
              }

              // Only update rate limits if we injected the token
              if (!hasAuthorization) {
                const status = data.status.toString();
                const rateLimitRemaining = data.headers['x-ratelimit-remaining'];
                const rateLimitReset = data.headers['x-ratelimit-reset'];
                const rateLimitLimit = data.headers['x-ratelimit-limit'];
                const rateLimitUsed = data.headers['x-ratelimit-used'];

                if (rateLimitRemaining) {
                  this.updateLimits({
                    status,
                    'x-ratelimit-remaining': rateLimitRemaining,
                    'x-ratelimit-reset': rateLimitReset || '',
                    'x-ratelimit-limit': rateLimitLimit || ''
                  });
                }

                // Prefer x-ratelimit-used header, fallback to measured duration
                if (rateLimitUsed) {
                  const usedTime = Number.parseFloat(rateLimitUsed);
                  if (!Number.isNaN(usedTime)) {
                    this.timeBudget -= usedTime;
                  }
                } else if (req.startedAt) {
                  const requestDuration = Date.now() - req.startedAt.getTime();
                  this.timeBudget -= requestDuration;
                }

                this.log(data.status, req.startedAt);

                // Remove rate limit and scope headers
                for (const key of Object.keys(data.headers)) {
                  if (/(ratelimit|scope)/i.test(key)) {
                    delete data.headers[key];
                  }
                }

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
        } finally {
          this._running -= 1;
        }
      });
    };
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

        const now = Date.now();
        if (now >= this._budgetResetAt) {
          this.timeBudget = this.defaults.resource === 'graphql' ? 60000 : 90000;
          this._budgetResetAt = now + 60000;
        }

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
      running: this.running,
      pending: this.queued,
      remaining: this.remaining,
      reset: this.reset,
      timeBudget: this.timeBudget,
      status: status,
      duration: startedAt ? Date.now() - startedAt.getTime() : 0
    } satisfies WorkerLogger);
  }

  get pending(): number {
    return this.queue.size + this.queue.pending;
  }

  get running(): number {
    return this._running;
  }

  get queued(): number {
    return this._queued;
  }

  destroy(): this {
    this.queue.clear();
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

      // Select the client with the best score (fewest pending and most remaining)
      const client = minBy(available, (client) => {
        const requestScore = client.pending + 1 / (client.remaining + 1);
        const timeScore = 1 / (client.timeBudget / 1000 + 1);
        return requestScore + timeScore;
      }) as ProxyWorker;

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
      // Auto-refresh rate limits every 15 minutes
      setInterval(() => worker.refreshRateLimits(), 15 * 60 * 1000).unref();
    }

    this.clients.push({ token, core, search, code_search: codeSearch, graphql });
  }

  removeToken(token: string): void {
    this.clients.splice(this.clients.map((c) => c.token).indexOf(token), 1).forEach((client) => {
      for (const worker of [client.core, client.search, client.code_search, client.graphql]) {
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
