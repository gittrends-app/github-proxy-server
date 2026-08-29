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

export const NUMERIC_CONFIGURATION_LIMITS = {
  port: { min: 0, max: 65535 },
  requestTimeout: { min: 1, max: 120000 },
  minRemaining: { min: 0, max: 5000 },
  timeBudgetMultiplier: { min: 1, max: 10 }
} as const;

function parseNumericConfiguration(
  value: unknown,
  name: keyof typeof NUMERIC_CONFIGURATION_LIMITS,
  integer: boolean
): number {
  const limits = NUMERIC_CONFIGURATION_LIMITS[name];
  const pattern = integer ? /^\+?\d+$/ : /^\+?(?:\d+(?:\.\d+)?|\.\d+)$/;
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && pattern.test(value)
        ? Number(value)
        : Number.NaN;
  const isValid =
    Number.isFinite(number) &&
    Math.abs(number) <= Number.MAX_SAFE_INTEGER &&
    (!integer || Number.isInteger(number)) &&
    number >= limits.min &&
    number <= limits.max;

  if (!isValid) {
    const kind = integer ? 'a safe integer' : 'a finite safe number';
    throw new Error(`Invalid ${name}: expected ${kind} between ${limits.min} and ${limits.max}.`);
  }

  return number;
}

export function parsePort(value: unknown): number {
  return parseNumericConfiguration(value, 'port', true);
}

export function parseRequestTimeout(value: unknown): number {
  return parseNumericConfiguration(value, 'requestTimeout', true);
}

export function parseMinRemaining(value: unknown): number {
  return parseNumericConfiguration(value, 'minRemaining', true);
}

export function parseTimeBudgetMultiplier(value: unknown): number {
  return parseNumericConfiguration(value, 'timeBudgetMultiplier', false);
}

export function validateProxyRouterOptions(options: ProxyRouterOpts): ProxyRouterOpts {
  const requestTimeout = parseRequestTimeout(options.requestTimeout);
  const minRemaining = parseMinRemaining(options.minRemaining);
  const timeBudgetMultiplier =
    options.timeBudgetMultiplier === undefined
      ? undefined
      : parseTimeBudgetMultiplier(options.timeBudgetMultiplier);

  return { ...options, requestTimeout, minRemaining, timeBudgetMultiplier };
}

const GITHUB_TOKEN_PATTERNS = [
  /^[A-Za-z0-9]{40}$/,
  /^gh[opusr]_[A-Za-z0-9]{36}$/,
  /^github_pat_[A-Za-z0-9_]{82}$/
];

export function validateGitHubToken(token: unknown): asserts token is string {
  if (typeof token !== 'string' || !GITHUB_TOKEN_PATTERNS.some((pattern) => pattern.test(token))) {
    throw new Error('Invalid access token detected (unsupported GitHub credential format).');
  }
}

type ScheduledRequest = QueuedRequest & {
  settle: () => void;
};

function disposalError(errors: unknown[], message: string): Error | undefined {
  if (!errors.length) return undefined;
  if (errors.length === 1) {
    return errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]));
  }
  return new AggregateError(errors, message);
}

function terminateResponse(res: Response): void {
  if (!res.writableEnded && !res.destroyed) res.destroy();
}

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
  private readonly agent: Agent;
  private readonly scheduledRequests = new Set<ScheduledRequest>();
  private router?: ProxyRouter;
  private resourceQueue?: RequestQueue;
  private pullInterval?: NodeJS.Timeout;
  private _budgetResetInterval?: NodeJS.Timeout;
  private checkForWork?: () => Promise<void>;
  private destroyed = false;
  private destroyPromise?: Promise<void>;

  private emitError(error: unknown, token?: string): void {
    if (!this.listenerCount('error')) return;
    try {
      this.emit('error', error, token);
    } catch {
      // Error listeners must not turn refresh failures into unhandled rejections.
    }
  }

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

    this.agent = new Agent({
      connections: 20,
      pipelining: 1,
      keepAliveTimeout: 60000,
      keepAliveMaxTimeout: 600000,
      headersTimeout: opts.requestTimeout,
      bodyTimeout: opts.requestTimeout
    });

    this.proxy = new ProxyClient({
      target: 'https://api.github.com',
      timeout: opts.requestTimeout,
      dispatcher: this.agent
    });

    let maxConcurrent = 1;
    if (['graphql', 'core'].includes(opts.resource)) maxConcurrent = 10;

    this.queue = new PQueue({ concurrency: maxConcurrent });

    this.schedule = async (req: ExtendedRequest, res: Response): Promise<void> => {
      if (this.destroyed) {
        terminateResponse(res);
        return;
      }

      let settleTask!: () => void;
      const completion = new Promise<void>((resolve) => {
        settleTask = resolve;
      });
      const scheduledRequest = { req, res, settle: settleTask };
      this.scheduledRequests.add(scheduledRequest);

      try {
        void this.queue
          .add(async () => {
            try {
              if (this.destroyed || req.socket.destroyed) {
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

              const hasAuthorization = opts.overrideAuthorization
                ? false
                : !!req.headers.authorization;

              await this.proxy.proxy(req, res, {
                modifyHeaders: (headers) => {
                  if (!hasAuthorization) headers.authorization = `token ${token}`;
                  return headers;
                },
                onResponse: async (data) => {
                  if (this.destroyed) return;

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

              if (!req.socket.destroyed && !req.socket.writableFinished && !res.destroyed) {
                res.status(StatusCodes.BAD_GATEWAY).send();
              }

              req.abortController?.abort();
              terminateResponse(res);
            } finally {
              this.scheduledRequests.delete(scheduledRequest);
              settleTask();
            }
          })
          .catch(() => {
            this.scheduledRequests.delete(scheduledRequest);
            settleTask();
          });
        await completion;
      } catch {
        this.scheduledRequests.delete(scheduledRequest);
        settleTask();
      }
    };
  }

  public async refreshRateLimits(): Promise<void> {
    if (this.destroyed) return;

    await fetch('https://api.github.com/rate_limit', {
      headers: {
        authorization: `token ${this.token}`,
        'user-agent': 'GitHub API Proxy Server (@hsborges/github-proxy-server)'
      }
    }).then(async (response) => {
      if (this.destroyed) return;

      if (response.status === 401) {
        this.remaining = 0;
        this.reset = Number.POSITIVE_INFINITY;
        this.emitError(`Invalid token detected (${this.token.slice(-4)}).`, this.token);
      } else {
        const res = (await response.json()) as {
          resources: Record<string, { remaining: number; reset: number }>;
        };
        if (this.destroyed) return;

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
    if (this.destroyed) return;

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
    if (this.destroyed) return false;

    return (
      this.queue.pending < (this.queue.concurrency ?? 1) &&
      this.timeBudget >= this.queue.pending * 1000 &&
      (this.remaining > this.opts.minRemaining || this.reset * 1000 < Date.now())
    );
  }

  setRouter(router: ProxyRouter): void {
    if (this.destroyed) return;

    this.router = router;
    this.resourceQueue = router.getQueue(this.defaults.resource);
    this.startPullLoop();
  }

  private startPullLoop(): void {
    if (this.destroyed || !this.router || !this.resourceQueue) return;

    this.checkForWork = async () => {
      if (this.destroyed || !this.canAcceptWork() || !this.resourceQueue) return;
      const work = this.resourceQueue.dequeue();
      if (work) await this.schedule(work.req, work.res);
    };

    // Fallback polling every 100ms for missed events
    this.pullInterval = setInterval(this.checkForWork, 100).unref();
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;

    this.destroyed = true;
    this.queue.pause();
    this.queue.clear();

    if (this.pullInterval) clearInterval(this.pullInterval);
    if (this._budgetResetInterval) clearInterval(this._budgetResetInterval);
    this.pullInterval = undefined;
    this._budgetResetInterval = undefined;

    this.router = undefined;
    this.resourceQueue = undefined;
    this.checkForWork = undefined;
    this.removeAllListeners();

    this.destroyPromise = (async () => {
      const errors: unknown[] = [];

      for (const { res, settle } of this.scheduledRequests) {
        try {
          terminateResponse(res);
        } catch (error) {
          errors.push(error);
        } finally {
          settle();
        }
      }
      this.scheduledRequests.clear();

      try {
        await this.agent.destroy();
      } catch (error) {
        errors.push(error);
      }

      const error = disposalError(errors, 'Proxy worker destruction failed');
      if (error) throw error;
    })();
    return this.destroyPromise;
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
  PROXY_ERROR = StatusCodes.METHOD_NOT_ALLOWED
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
    refreshTimers: NodeJS.Timeout[];
  }>;

  private destroyed = false;
  private destroyPromise?: Promise<void>;
  private readonly removals = new Set<Promise<void>>();

  private emitError(error: unknown): void {
    if (!this.listenerCount('error')) return;
    try {
      this.emit('error', error);
    } catch {
      // Error listeners must not turn cleanup failures into unhandled exceptions.
    }
  }

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
    tokens.forEach((token) => validateGitHubToken(token));

    this.clients = [];
    this.options = validateProxyRouterOptions(
      Object.assign({ requestTimeout: 20000, minRemaining: 100 }, opts)
    );

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
    if (this.destroyed) {
      terminateResponse(res);
      return;
    }

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
    if (this.destroyed) return;
    validateGitHubToken(token);
    if (this.clients.map((client) => client.token).includes(token)) return;

    const core = new ProxyWorker(token, { ...this.options, resource: 'core' });
    const search = new ProxyWorker(token, { ...this.options, resource: 'search' });
    const codeSearch = new ProxyWorker(token, { ...this.options, resource: 'code_search' });
    const graphql = new ProxyWorker(token, { ...this.options, resource: 'graphql' });

    const workers = [core, search, codeSearch, graphql];
    const refreshTimers: NodeJS.Timeout[] = [];

    for (const worker of workers) {
      worker.on('error', (error: unknown) => this.emitError(error));
      worker.on('retry', (req: ExtendedRequest, res: Response) => this.schedule(req, res));
      worker.on('log', (log: WorkerLogger) => this.emit('log', log));
      worker.on('warn', (message: string) => this.emit('warn', message));
      void worker
        .refreshRateLimits()
        .then(() => {
          if (!this.destroyed && !worker.isDestroyed) this.emit('ready');
        })
        .catch((error: unknown) => {
          if (!this.destroyed && !worker.isDestroyed) this.emitError(error);
        });
      // Auto-refresh rate limits every 15 minutes
      refreshTimers.push(
        setInterval(
          () => {
            if (this.destroyed || worker.isDestroyed) return;
            void worker.refreshRateLimits().catch((error: unknown) => {
              if (!this.destroyed && !worker.isDestroyed) this.emitError(error);
            });
          },
          15 * 60 * 1000
        ).unref()
      );
      // Phase 3: Set router reference to enable pull mechanism
      worker.setRouter(this);
    }

    this.clients.push({
      token,
      core,
      search,
      code_search: codeSearch,
      graphql,
      refreshTimers
    });

    // Update worker caches
    this.workersByResource.core.push(core);
    this.workersByResource.search.push(search);
    this.workersByResource.code_search.push(codeSearch);
    this.workersByResource.graphql.push(graphql);
  }

  private async destroyClient(client: (typeof this.clients)[number]): Promise<void> {
    const workers = [client.core, client.search, client.code_search, client.graphql];
    for (const timer of client.refreshTimers) clearInterval(timer);

    const results = await Promise.allSettled(workers.map((worker) => worker.destroy()));
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);

    const cacheEntries: Array<[ProxyWorker[], ProxyWorker]> = [
      [this.workersByResource.core, client.core],
      [this.workersByResource.search, client.search],
      [this.workersByResource.code_search, client.code_search],
      [this.workersByResource.graphql, client.graphql]
    ];
    for (const [workersByResource, worker] of cacheEntries) {
      const workerIndex = workersByResource.indexOf(worker);
      if (workerIndex !== -1) workersByResource.splice(workerIndex, 1);
      worker.removeAllListeners();
    }

    const error = disposalError(errors, 'Proxy token destruction failed');
    if (error) throw error;
  }

  removeToken(token: string): Promise<void> {
    if (this.destroyed) return this.destroyPromise ?? Promise.resolve();

    const index = this.clients.map((c) => c.token).indexOf(token);
    if (index === -1) return Promise.resolve();

    const client = this.clients.splice(index, 1)[0];
    const removal = this.destroyClient(client);
    this.removals.add(removal);
    void removal.then(
      () => this.removals.delete(removal),
      () => this.removals.delete(removal)
    );
    return removal;
  }

  async refreshRateLimits(): Promise<void> {
    if (this.destroyed) return;

    const clients = [...this.clients];
    await Promise.all(
      clients.map((client) =>
        Promise.all(
          [client.core, client.search, client.code_search, client.graphql].map((worker) =>
            worker.refreshRateLimits()
          )
        )
      )
    );
    if (!this.destroyed) this.emit('ready');
  }

  get tokens(): string[] {
    return this.clients.map((client) => client.token);
  }

  destroy(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;

    this.destroyed = true;

    const clients = this.clients.splice(0);
    const removals = [...this.removals];

    this.destroyPromise = (async () => {
      const errors: unknown[] = [];
      for (const queue of Object.values(this.queues)) {
        let work = queue.dequeue();
        while (work) {
          try {
            terminateResponse(work.res);
          } catch (error) {
            errors.push(error);
          }
          work = queue.dequeue();
        }
      }

      const results = await Promise.allSettled([
        ...clients.map((client) => this.destroyClient(client)),
        ...removals
      ]);
      for (const result of results) {
        if (result.status === 'rejected') errors.push(result.reason);
      }

      for (const workers of Object.values(this.workersByResource)) workers.length = 0;
      this.removeAllListeners();

      const error = disposalError(errors, 'Proxy router destruction failed');
      if (error) throw error;
    })();

    return this.destroyPromise;
  }
}
