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

type RateLimit = {
  remaining: number;
  reset: number;
};

type RateLimitResources = Record<APIResources, RateLimit>;

const REFRESH_MAX_ATTEMPTS = 3;
const REFRESH_BACKOFF_BASE_MS = 250;
const REFRESH_BACKOFF_MAX_MS = 2000;

class RefreshFailure extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseRateLimitResources(value: unknown): RateLimitResources {
  if (!isRecord(value)) throw new RefreshFailure('invalid resource shape');

  const resources = {} as RateLimitResources;
  for (const resource of ['core', 'search', 'code_search', 'graphql'] as APIResources[]) {
    const data = value[resource];
    if (
      !isRecord(data) ||
      typeof data.remaining !== 'number' ||
      !Number.isSafeInteger(data.remaining) ||
      data.remaining < 0 ||
      typeof data.reset !== 'number' ||
      !Number.isSafeInteger(data.reset) ||
      data.reset < 0
    ) {
      throw new RefreshFailure('invalid resource shape');
    }
    resources[resource] = { remaining: data.remaining, reset: data.reset };
  }

  return resources;
}

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

type ScheduledRequest = Omit<QueuedRequest, 'req'> & {
  req: ExtendedRequest;
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

function requestDisconnected(req: ExtendedRequest): boolean {
  return Boolean(req.destroyed || req.aborted || req.socket?.destroyed);
}

function responseUnavailable(res: Response): boolean {
  return Boolean(res.headersSent || res.writableEnded || res.destroyed);
}

function terminatePartialResponse(req: ExtendedRequest, res: Response): void {
  if (requestDisconnected(req) || res.writableEnded || res.destroyed || !res.headersSent) return;
  res.destroy();
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
      let activeAbortController: AbortController | undefined;

      try {
        void this.queue
          .add(async () => {
            try {
              if (
                this.destroyed ||
                requestDisconnected(req) ||
                res.writableEnded ||
                res.destroyed
              ) {
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

              const abortController = new AbortController();
              activeAbortController = abortController;
              req.abortController = abortController;
              const abortRequest = (): void => abortController.abort();
              const abortResponse = (): void => {
                if (!res.writableEnded) abortController.abort();
              };
              req.once?.('aborted', abortRequest);
              req.once?.('error', abortRequest);
              req.socket?.once?.('close', abortRequest);
              res.once?.('close', abortResponse);

              try {
                const hasAuthorization = opts.overrideAuthorization
                  ? false
                  : !!req.headers.authorization;

                await this.proxy.proxy(req, res, {
                  abortController,
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
              } finally {
                req.removeListener?.('aborted', abortRequest);
                req.removeListener?.('error', abortRequest);
                req.socket?.removeListener?.('close', abortRequest);
                res.removeListener?.('close', abortResponse);
                if (req.abortController === abortController) delete req.abortController;
              }
            } catch (error) {
              activeAbortController?.abort();
              const err = error as Error & { code?: string };
              const errorCode = err.code || err.message;
              this.log(
                errorCode === 'ETIMEDOUT' ? 'ETIMEDOUT' : ProxyRouterResponse.PROXY_ERROR,
                req.startedAt
              );

              if (!this.destroyed) {
                if (!requestDisconnected(req) && !responseUnavailable(res)) {
                  res.status(StatusCodes.BAD_GATEWAY).send();
                } else {
                  terminatePartialResponse(req, res);
                }
              }
            } finally {
              activeAbortController = undefined;
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

  applyRateLimit(limit: RateLimit): void {
    if (this.destroyed) return;

    this.remaining = limit.remaining;
    this.reset = limit.reset;
    this.log(undefined, new Date());
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

      for (const { req, res, settle } of this.scheduledRequests) {
        try {
          req.abortController?.abort();
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
    refreshPromise?: Promise<void>;
    refreshController?: AbortController;
    refreshTimeout?: NodeJS.Timeout;
    retryTimer?: NodeJS.Timeout;
    retryWaitResolve?: () => void;
    removed?: boolean;
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

    for (const worker of workers) {
      worker.on('error', (error: unknown) => this.emitError(error));
      worker.on('retry', (req: ExtendedRequest, res: Response) => this.schedule(req, res));
      worker.on('log', (log: WorkerLogger) => this.emit('log', log));
      worker.on('warn', (message: string) => this.emit('warn', message));
      // Phase 3: Set router reference to enable pull mechanism
      worker.setRouter(this);
    }

    const client = {
      token,
      core,
      search,
      code_search: codeSearch,
      graphql,
      refreshTimers: [] as NodeJS.Timeout[]
    };
    this.clients.push(client);

    // Update worker caches
    this.workersByResource.core.push(core);
    this.workersByResource.search.push(search);
    this.workersByResource.code_search.push(codeSearch);
    this.workersByResource.graphql.push(graphql);

    this.startDetachedRefresh(client, true);
    // Auto-refresh rate limits every 15 minutes, once per token.
    client.refreshTimers.push(
      setInterval(() => this.startDetachedRefresh(client, false), 15 * 60 * 1000).unref()
    );
  }

  private startDetachedRefresh(client: (typeof this.clients)[number], emitReady: boolean): void {
    void this.refreshClient(client)
      .then(() => {
        if (emitReady && !this.destroyed && !client.removed) this.emit('ready');
      })
      .catch((error: unknown) => {
        if (!this.destroyed && !client.removed) this.emitError(error);
      });
  }

  private cancelRefresh(client: (typeof this.clients)[number]): void {
    client.refreshController?.abort();
    if (client.refreshTimeout) clearTimeout(client.refreshTimeout);
    client.refreshTimeout = undefined;

    if (client.retryTimer) clearTimeout(client.retryTimer);
    client.retryTimer = undefined;
    const resolveRetry = client.retryWaitResolve;
    client.retryWaitResolve = undefined;
    resolveRetry?.();
  }

  private async waitForRefreshRetry(
    client: (typeof this.clients)[number],
    delay: number
  ): Promise<void> {
    if (this.destroyed || client.removed) return;

    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout;
      const complete = (): void => {
        if (client.retryTimer === timer) client.retryTimer = undefined;
        if (client.retryWaitResolve === complete) client.retryWaitResolve = undefined;
        resolve();
      };
      timer = setTimeout(complete, delay).unref();
      client.retryTimer = timer;
      client.retryWaitResolve = complete;
    });
  }

  private async awaitRefreshAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new RefreshFailure('refresh aborted');

    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new RefreshFailure('refresh aborted'));
      signal.addEventListener('abort', abort, { once: true });
    });

    try {
      return await Promise.race([operation, aborted]);
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
    }
  }

  private async fetchRateLimits(
    client: (typeof this.clients)[number]
  ): Promise<RateLimitResources | undefined> {
    let reason = 'network failure';

    for (let attempt = 0; attempt < REFRESH_MAX_ATTEMPTS; attempt += 1) {
      if (this.destroyed || client.removed) return undefined;

      const controller = new AbortController();
      let timedOut = false;
      client.refreshController = controller;
      client.refreshTimeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.options.requestTimeout).unref();

      try {
        const response = await this.awaitRefreshAbort(
          fetch('https://api.github.com/rate_limit', {
            headers: {
              authorization: `token ${client.token}`,
              'user-agent': 'GitHub API Proxy Server (@hsborges/github-proxy-server)'
            },
            signal: controller.signal
          }),
          controller.signal
        );

        if (response.status < 200 || response.status >= 300) {
          throw new RefreshFailure(`HTTP response ${response.status}`);
        }

        let body: unknown;
        try {
          body = await this.awaitRefreshAbort(response.json(), controller.signal);
        } catch {
          throw new RefreshFailure('malformed JSON');
        }

        if (!isRecord(body) || !('resources' in body)) {
          throw new RefreshFailure('invalid resource shape');
        }
        return parseRateLimitResources(body.resources);
      } catch (error) {
        if (this.destroyed || client.removed) return undefined;
        reason = timedOut
          ? `attempt timed out after ${this.options.requestTimeout}ms`
          : error instanceof RefreshFailure
            ? error.message
            : 'network failure';
        if (attempt + 1 < REFRESH_MAX_ATTEMPTS) {
          const delay = Math.min(REFRESH_BACKOFF_BASE_MS * 2 ** attempt, REFRESH_BACKOFF_MAX_MS);
          await this.waitForRefreshRetry(client, delay);
        }
      } finally {
        if (client.refreshController === controller) client.refreshController = undefined;
        if (client.refreshTimeout) clearTimeout(client.refreshTimeout);
        if (client.refreshController === undefined) client.refreshTimeout = undefined;
      }
    }

    throw new Error(
      `Rate-limit refresh failed for token ending ${client.token.slice(-4)} after ${REFRESH_MAX_ATTEMPTS} attempts: ${reason}`
    );
  }

  private refreshClient(client: (typeof this.clients)[number]): Promise<void> {
    if (this.destroyed || client.removed) return Promise.resolve();
    if (client.refreshPromise) return client.refreshPromise;

    const refreshPromise = (async () => {
      try {
        const resources = await this.fetchRateLimits(client);
        if (!resources || this.destroyed || client.removed) return;

        for (const worker of [client.core, client.search, client.code_search, client.graphql]) {
          worker.applyRateLimit(resources[worker.defaults.resource]);
        }
      } catch (error) {
        if (!this.destroyed && !client.removed) throw error;
      }
    })();
    client.refreshPromise = refreshPromise;
    void refreshPromise.then(
      () => {
        if (client.refreshPromise === refreshPromise) client.refreshPromise = undefined;
      },
      () => {
        if (client.refreshPromise === refreshPromise) client.refreshPromise = undefined;
      }
    );
    return refreshPromise;
  }

  private async destroyClient(client: (typeof this.clients)[number]): Promise<void> {
    const workers = [client.core, client.search, client.code_search, client.graphql];
    client.removed = true;
    for (const timer of client.refreshTimers) clearInterval(timer);
    this.cancelRefresh(client);

    const results = await Promise.allSettled([
      client.refreshPromise ?? Promise.resolve(),
      ...workers.map((worker) => worker.destroy())
    ]);
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
    client.removed = true;
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
    try {
      await Promise.all(clients.map((client) => this.refreshClient(client)));
    } catch (error) {
      if (!this.destroyed) this.emitError(error);
      throw error;
    }
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
