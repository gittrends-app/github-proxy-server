/* Author: Hudson S. Borges */
import EventEmitter from 'node:events';

import type { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import PQueue from 'p-queue';
import { Agent } from 'undici';

import { ProxyClient } from './proxy-client.js';

export type ProxyRouterOpts = {
  requestTimeout: number;
  minRemaining: number;
  overrideAuthorization?: boolean;
  timeBudgetMultiplier?: number;
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
  remaining: number;
  reset: number;
  timeBudget?: number;
  status?: number | string;
  duration: number;
}

export interface QueuedRequest {
  req: Request;
  res: Response;
}

export interface RequestQueue {
  items: QueuedRequest[];
  enqueue(req: Request, res: Response): void;
  dequeue(): QueuedRequest | undefined;
  get size(): number;
}

class ProxyWorker extends EventEmitter {
  readonly queue: PQueue;

  readonly proxy: ProxyClient;
  readonly token: string;
  readonly schedule;

  private readonly opts: ProxyRouterOpts;
  private router?: ProxyRouter;
  private resourceQueue?: RequestQueue;
  private pullInterval?: NodeJS.Timeout;
  private _budgetResetInterval?: NodeJS.Timeout;
  private checkForWork?: () => Promise<void>;

  readonly defaults: {
    resource: APIResources;
    limit: number;
    reset: number;
    timeBudget: number;
  };

  remaining = 0;
  reset: number = Date.now() / 1000 + 1;
  timeBudget: number = 60000;

  constructor(token: string, opts: ProxyRouterOpts & { resource: APIResources }) {
    super({});

    this.token = token;
    this.opts = opts;

    switch (opts.resource) {
      case 'code_search':
        this.defaults = { resource: opts.resource, limit: 10, reset: 1000 * 60, timeBudget: 90000 };
        break;
      case 'search':
        this.defaults = { resource: opts.resource, limit: 30, reset: 1000 * 60, timeBudget: 90000 };
        break;
      default:
        this.defaults = {
          resource: opts.resource,
          limit: 5000,
          reset: 1000 * 60 * 60,
          timeBudget: opts.resource === 'graphql' ? 60000 : 90000
        };
    }

    // Initialize time budget tracking
    this._budgetResetInterval = setInterval(() => {
      this.timeBudget =
        (this.defaults.resource === 'graphql' ? 60000 : 90000) * (opts.timeBudgetMultiplier || 1);
    }, 60000).unref();

    this.proxy = new ProxyClient({
      target: 'https://api.github.com',
      timeout: opts.requestTimeout,
      dispatcher: new Agent({
        connections: 20,
        pipelining: 1,
        keepAliveTimeout: 60000,
        keepAliveMaxTimeout: 600000,
        headersTimeout: opts.requestTimeout,
        bodyTimeout: opts.requestTimeout
      })
    });

    let maxConcurrent = 1;
    if (['graphql', 'core'].includes(opts.resource)) maxConcurrent = 10;

    this.queue = new PQueue({ concurrency: maxConcurrent });

    this.schedule = async (req: ExtendedRequest, res: Response): Promise<void> => {
      return this.queue.add(async () => {
        try {
          if (req.socket.destroyed) {
            this.log();
            return;
          }

          const noTimeBudget = this.timeBudget < this.queue.pending * 1000;
          const noRequests =
            this.remaining <= opts.minRemaining && this.reset >= Math.floor(Date.now() / 1000);

          if (noTimeBudget || noRequests) {
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

                if (rateLimitRemaining) {
                  this.updateLimits({
                    status,
                    'x-ratelimit-remaining': rateLimitRemaining,
                    'x-ratelimit-reset': rateLimitReset || '',
                    'x-ratelimit-limit': rateLimitLimit || ''
                  });
                }

                this.timeBudget -= Date.now() - (req.startedAt?.getTime() || 1000);

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
        this.emit('error', `Invalid token detected (${this.token.slice(-4)}).`, this.token);
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
      this.remaining = Number.parseInt(headers['x-ratelimit-remaining'], 10) - this.queue.pending;
      this.reset = Number.parseInt(headers['x-ratelimit-reset'], 10);
    }
  }

  private log(status?: number | string, startedAt?: Date): void {
    this.emit('log', {
      resource: this.defaults.resource,
      token: this.token.slice(-4),
      running: this.queue.pending,
      remaining: this.remaining,
      reset: this.reset,
      timeBudget: this.timeBudget,
      status: status,
      duration: startedAt ? Date.now() - startedAt.getTime() : 0
    } satisfies WorkerLogger);
  }

  canAcceptWork(): boolean {
    return (
      this.queue.pending < (this.queue.concurrency ?? 1) &&
      this.timeBudget >= this.queue.pending * 1000 &&
      (this.remaining > this.opts.minRemaining || this.reset * 1000 < Date.now())
    );
  }

  setRouter(router: ProxyRouter): void {
    this.router = router;
    this.resourceQueue = router.getQueue(this.defaults.resource);
    this.startPullLoop();
  }

  private startPullLoop(): void {
    if (!this.router || !this.resourceQueue) return;

    this.checkForWork = async () => {
      if (!this.canAcceptWork() || !this.resourceQueue) return;
      const work = this.resourceQueue.dequeue();
      if (work) await this.schedule(work.req, work.res);
    };

    // Fallback polling every 100ms for missed events
    this.pullInterval = setInterval(this.checkForWork, 100).unref();
  }

  destroy(): this {
    this.queue.clear();
    if (this.pullInterval) {
      clearInterval(this.pullInterval);
    }
    if (this._budgetResetInterval) {
      clearInterval(this._budgetResetInterval);
    }
    return this;
  }
}

class QueueImpl implements RequestQueue {
  items: QueuedRequest[] = [];

  enqueue(req: Request, res: Response): void {
    this.items.push({ req, res });
  }

  dequeue(): QueuedRequest | undefined {
    return this.items.shift();
  }

  get size(): number {
    return this.items.length;
  }
}

export enum ProxyRouterResponse {
  PROXY_ERROR = 600
}

export default class ProxyRouter extends EventEmitter {
  private readonly options: ProxyRouterOpts;

  private readonly queues: {
    core: RequestQueue;
    search: RequestQueue;
    code_search: RequestQueue;
    graphql: RequestQueue;
  };

  private readonly clients: Array<{
    token: string;
    core: ProxyWorker;
    search: ProxyWorker;
    code_search: ProxyWorker;
    graphql: ProxyWorker;
  }>;

  // Cache worker arrays to avoid repeated map() calls
  private readonly workersByResource: {
    core: ProxyWorker[];
    search: ProxyWorker[];
    code_search: ProxyWorker[];
    graphql: ProxyWorker[];
  } = {
    core: [],
    search: [],
    code_search: [],
    graphql: []
  };

  constructor(tokens: string[], opts?: Partial<ProxyRouterOpts>) {
    super({});

    if (!tokens.length) throw new Error('At least one token is required!');

    this.clients = [];
    this.options = Object.assign({ requestTimeout: 20000, minRemaining: 100 }, opts);

    // Initialize per-resource queues
    this.queues = {
      core: new QueueImpl(),
      search: new QueueImpl(),
      code_search: new QueueImpl(),
      graphql: new QueueImpl()
    };

    tokens.forEach((token) => this.addToken(token));
  }

  async schedule(req: Request, res: Response): Promise<void> {
    const isGraphQL = req.path.startsWith('/graphql') && req.method === 'POST';
    const isCodeSearch = req.path.startsWith('/search/code');
    const isSearch = req.path.startsWith('/search');

    const queue = isGraphQL
      ? this.queues['graphql']
      : isCodeSearch
        ? this.queues['code_search']
        : isSearch
          ? this.queues['search']
          : this.queues['core'];

    queue.enqueue(req, res);
  }

  getQueue(resource: APIResources): RequestQueue {
    return this.queues[resource];
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
      // Phase 3: Set router reference to enable pull mechanism
      worker.setRouter(this);
    }

    this.clients.push({ token, core, search, code_search: codeSearch, graphql });

    // Update worker caches
    this.workersByResource.core.push(core);
    this.workersByResource.search.push(search);
    this.workersByResource.code_search.push(codeSearch);
    this.workersByResource.graphql.push(graphql);
  }

  removeToken(token: string): void {
    const index = this.clients.map((c) => c.token).indexOf(token);
    if (index === -1) return;

    const removed = this.clients.splice(index, 1);
    removed.forEach((client) => {
      for (const worker of [client.core, client.search, client.code_search, client.graphql]) {
        worker.destroy();
      }

      // Update worker caches
      const coreIndex = this.workersByResource.core.indexOf(client.core);
      if (coreIndex !== -1) this.workersByResource.core.splice(coreIndex, 1);

      const searchIndex = this.workersByResource.search.indexOf(client.search);
      if (searchIndex !== -1) this.workersByResource.search.splice(searchIndex, 1);

      const codeSearchIndex = this.workersByResource.code_search.indexOf(client.code_search);
      if (codeSearchIndex !== -1) this.workersByResource.code_search.splice(codeSearchIndex, 1);

      const graphqlIndex = this.workersByResource.graphql.indexOf(client.graphql);
      if (graphqlIndex !== -1) this.workersByResource.graphql.splice(graphqlIndex, 1);
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
