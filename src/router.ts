/* Author: Hudson S. Borges */
import Bottleneck from 'bottleneck';
import dayjs from 'dayjs';
import { Request, Response } from 'express';
import Server, { default as proxy } from 'http-proxy';
import { StatusCodes } from 'http-status-codes';
import minBy from 'lodash/minBy.js';
import EventEmitter from 'node:events';
import { ClientRequest, IncomingMessage } from 'node:http';
import { Agent } from 'node:https';
import { setTimeout } from 'node:timers/promises';
import Limiter from 'p-limit';

type ProxyWorkerOpts = {
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
  proxyRequest?: ClientRequest;
};

type ExtendedIncomingMessage = IncomingMessage & {
  startedAt?: Date;
  hasAuthorization?: boolean;
  proxyRequest?: ClientRequest;
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

  readonly proxy: Server;
  readonly token: string;
  readonly schedule;

  readonly defaults: {
    resource: APIResources;
    limit: number;
    reset: number;
  };

  remaining: number = 0;
  reset: number = Date.now() / 1000 + 1;

  constructor(token: string, opts: ProxyWorkerOpts & { resource: APIResources }) {
    super({});

    this.token = token;

    switch (opts.resource) {
      case 'code_search':
        this.defaults = { resource: opts.resource, limit: 10, reset: 1000 * 60 };
        break;
      case 'search':
        this.defaults = { resource: opts.resource, limit: 30, reset: 1000 * 60 };
        break;
      case 'graphql':
      default:
        this.defaults = { resource: opts.resource, limit: 5000, reset: 1000 * 60 * 60 };
    }

    fetch('https://api.github.com/rate_limit', {
      headers: {
        authorization: `token ${token}`,
        'user-agent': 'GitHub API Proxy Server (@hsborges/github-proxy-server)'
      }
    }).then(async (response) => {
      if (response.status === 401) {
        this.remaining = 0;
        this.reset = Infinity;
        this.emit('warn', `Invalid token detected (${token}).`);
      } else {
        const res = (await response.json()) as {
          resources: Record<string, { remaining: number; reset: number }>;
        };
        this.remaining = res.resources[opts.resource].remaining;
        this.reset = res.resources[opts.resource].reset;
        this.log(undefined, new Date());
      }
    });

    this.proxy = proxy.createProxyServer({
      target: 'https://api.github.com',
      ws: false,
      xfwd: true,
      changeOrigin: true,
      autoRewrite: true,
      proxyTimeout: opts.requestTimeout,
      agent: new Agent({
        keepAlive: true,
        keepAliveMsecs: 15000,
        timeout: opts.requestTimeout,
        scheduling: 'fifo'
      })
    });

    this.proxy.on('proxyReq', (proxyReq, req: ExtendedIncomingMessage) => {
      req.proxyRequest = proxyReq;
      req.startedAt = new Date();
      req.hasAuthorization = opts.overrideAuthorization
        ? false
        : !!proxyReq.getHeader('authorization');

      if (!req.hasAuthorization) proxyReq.setHeader('authorization', `token ${token}`);
    });

    this.proxy.on('proxyRes', (proxyRes, req: ExtendedIncomingMessage) => {
      const replaceURL = (url: string): string =>
        req.headers.host
          ? url.replaceAll('https://api.github.com', `http://${req.headers.host}`)
          : url;

      proxyRes.headers.link =
        proxyRes.headers.link &&
        (Array.isArray(proxyRes.headers.link)
          ? proxyRes.headers.link.map(replaceURL)
          : replaceURL(proxyRes.headers.link));

      if (req.hasAuthorization) return;

      this.updateLimits({
        status: `${proxyRes.statusCode}`,
        ...(proxyRes.headers as Record<string, string>)
      });

      this.log(proxyRes.statusCode, req.startedAt);

      proxyRes.headers['access-control-expose-headers'] = (
        proxyRes.headers['access-control-expose-headers'] || ''
      )
        .split(', ')
        .filter((header) => {
          if (/(ratelimit|scope)/i.test(header)) {
            delete proxyRes.headers[header.toLowerCase()];
            return false;
          }
          return true;
        })
        .join(', ');
    });

    const isSearch = ['search', 'code_search'].includes(opts.resource);

    this.queue = new Bottleneck({
      maxConcurrent: isSearch ? 1 : 10,
      minTime: isSearch ? 2000 : 250,
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

      await new Promise((resolve, reject) => {
        this.remaining -= 1;
        req.socket.once('close', resolve);
        req.socket.once('error', reject);
        res.once('close', resolve);
        res.once('error', reject);
        this.proxy.web(req, res as never, undefined, (error) => reject(error));
      }).catch(async (error) => {
        this.log(error.code || ProxyRouterResponse.PROXY_ERROR, req.startedAt);

        if (!req.socket.destroyed && !req.socket.writableFinished) {
          res.sendStatus(StatusCodes.BAD_GATEWAY);
        }

        req.proxyRequest?.destroy();
        res.destroy();
      });
    });
  }

  updateLimits(headers: Record<string, string>): void {
    if (!headers['x-ratelimit-remaining']) return;
    if (/401/i.test(headers.status)) {
      if (parseInt(headers['x-ratelimit-limit'], 10) > 0) this.remaining = 0;
      else this.remaining -= 1;
    } else {
      this.remaining = parseInt(headers['x-ratelimit-remaining'], 10) - this.pending;
      this.reset = parseInt(headers['x-ratelimit-reset'], 10);
    }
  }

  log(status?: number | string, startedAt?: Date): void {
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

  get queued(): number {
    const { RECEIVED, QUEUED } = this.queue.counts();
    return RECEIVED + QUEUED;
  }

  destroy(): this {
    this.proxy.close();
    return this;
  }
}

export type ProxyRouterOpts = ProxyWorkerOpts & { minRemaining: number };

export enum ProxyRouterResponse {
  PROXY_ERROR = 600
}

export default class ProxyRouter extends EventEmitter {
  readonly limiter = Limiter(1);

  private readonly clients: Array<{
    token: string;
    core: ProxyWorker;
    search: ProxyWorker;
    code_search: ProxyWorker;
    graphql: ProxyWorker;
  }>;

  private readonly options: ProxyRouterOpts;

  constructor(tokens: string[], opts?: ProxyRouterOpts) {
    super({});

    if (!tokens.length) throw new Error('At least one token is required!');

    this.clients = [];
    this.options = Object.assign({ requestTimeout: 20000 }, opts);

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
      } else {
        const client = minBy(
          available,
          (client) => client.pending + 1 / client.remaining
        ) as ProxyWorker;

        client.schedule(req, res);
      }
    });
  }

  addToken(token: string): void {
    if (this.clients.map((client) => client.token).includes(token)) return;

    const core = new ProxyWorker(token, { ...this.options, resource: 'core' });
    const search = new ProxyWorker(token, { ...this.options, resource: 'search' });
    const codeSearch = new ProxyWorker(token, { ...this.options, resource: 'code_search' });
    const graphql = new ProxyWorker(token, { ...this.options, resource: 'graphql' });

    for (const worker of [core, search, codeSearch, graphql]) {
      worker.on('log', (log: WorkerLogger) => this.emit('log', log));
      worker.on('warn', (message: string) => this.emit('warn', message));
      worker.on('retry', (req: ExtendedRequest, res: Response) => this.schedule(req, res));
    }

    this.clients.push({ token, core, search, code_search: codeSearch, graphql });
  }

  removeToken(token: string): void {
    this.clients.splice(this.clients.map((c) => c.token).indexOf(token), 1).forEach((client) => {
      for (const worker of [client.core, client.search, client.code_search, client.graphql]) {
        worker.proxy.close();
        worker.queue.stop({ dropWaitingJobs: false });
        worker.queue.disconnect();
        worker.destroy();
      }
    });
  }

  get tokens(): string[] {
    return this.clients.map((client) => client.token);
  }

  destroy(): this {
    this.clients.forEach((client) => this.removeToken(client.token));
    return this;
  }
}
