import EventEmitter from 'node:events';

import express, { type Express, type Request, type Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import repeat from 'lodash/repeat.js';
import times from 'lodash/times.js';
import nock from 'nock';
import request from 'supertest';
import { MockAgent, type MockPool } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { PayloadTooLargeError } from './proxy-client';
import Middleware from './router';

let app: Express;

const FAKE_TOKEN = repeat('t', 40);
const SECOND_TOKEN = `${repeat('u', 39)}1`;

const RATE_LIMIT_RESOURCES = {
  core: { limit: 5000, remaining: 4000, reset: 2000000000 },
  search: { limit: 30, remaining: 25, reset: 2000000000 },
  code_search: { limit: 10, remaining: 8, reset: 2000000000 },
  graphql: { limit: 5000, remaining: 4500, reset: 2000000000 }
};

function rateLimitResponse(
  resources: unknown = RATE_LIMIT_RESOURCES,
  status = StatusCodes.OK
): globalThis.Response {
  return {
    status,
    json: async () => ({ resources })
  } as unknown as globalThis.Response;
}

describe('Middleware constructor and methods', () => {
  beforeAll(() => {
    nock('https://api.github.com', { allowUnmocked: false })
      .get('/rate_limit')
      .reply(StatusCodes.OK, {
        resources: {
          core: { limit: 5000, remaining: 5000, reset: Date.now() + 60 * 60 },
          search: { limit: 30, remaining: 30, reset: Date.now() + 60 * 60 },
          code_search: { limit: 10, remaining: 10, reset: Date.now() + 60 * 60 },
          graphql: { limit: 5000, remaining: 5000, reset: Date.now() + 60 * 60 }
        }
      })
      .persist();
  });

  afterAll(() => {
    nock.cleanAll();
    nock.restore();
  });

  test('it should throw an error if no token is provided', () => {
    expect(() => new Middleware([])).toThrowError();
  });

  test.each([
    ['requestTimeout', { requestTimeout: 0 }],
    ['minRemaining', { minRemaining: -1 }],
    ['timeBudgetMultiplier', { timeBudgetMultiplier: 11 }],
    ['maxRequestBodyBytes', { maxRequestBodyBytes: 1024 * 1024 - 1 }],
    ['maxQueueDepthPerWorker', { maxQueueDepthPerWorker: 0 }],
    ['queueWaitTimeout', { queueWaitTimeout: 0 }],
    ['requestLifetimeTimeout', { requestLifetimeTimeout: 0 }]
  ])('it should reject invalid direct %s options', (_name, invalidOptions) => {
    expect(() => new Middleware([FAKE_TOKEN], invalidOptions)).toThrow(`Invalid ${_name}`);
  });

  test('it should validate every token before allocating worker resources', () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval');

    try {
      expect(() => new Middleware([FAKE_TOKEN, 'invalid-token'])).toThrow(
        'unsupported GitHub credential format'
      );
      expect(setInterval).not.toHaveBeenCalled();
    } finally {
      setInterval.mockRestore();
    }
  });

  test('it should use token refresh intervals but no per-worker polling intervals', async () => {
    vi.useFakeTimers();
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    const middleware = new Middleware([FAKE_TOKEN, SECOND_TOKEN]);

    try {
      expect(setInterval).toHaveBeenCalledTimes(2);
      const workersByResource = (
        middleware as unknown as {
          workersByResource: Record<string, Array<Record<string, unknown>>>;
        }
      ).workersByResource;
      for (const workers of Object.values(workersByResource)) {
        for (const worker of workers) {
          expect(worker).not.toHaveProperty('pullInterval');
          expect(worker).not.toHaveProperty('checkForWork');
        }
      }
    } finally {
      setInterval.mockRestore();
      await middleware.destroy();
      vi.useRealTimers();
    }
  });

  test('it should remove/add tokens', async () => {
    const middleware = new Middleware([FAKE_TOKEN]);
    const notifyDispatch = vi.spyOn(
      middleware as unknown as { notifyDispatch: (resource: 'core') => void },
      'notifyDispatch'
    );
    expect(middleware.tokens).toHaveLength(1);

    await middleware.removeToken(FAKE_TOKEN);
    expect(middleware.tokens).toHaveLength(0);
    expect(notifyDispatch).toHaveBeenCalledTimes(4);

    middleware.addToken(FAKE_TOKEN);
    expect(middleware.tokens).toHaveLength(1);
    expect(notifyDispatch).toHaveBeenCalledTimes(12);
    return middleware.destroy();
  });

  test('it should create only one client per token', async () => {
    const middleware = new Middleware(times(2, () => FAKE_TOKEN));
    expect(middleware.tokens).toHaveLength(1);
    await middleware.destroy();
  });

  test('it should destroy every token and its lifecycle timers exactly once', async () => {
    vi.useFakeTimers();
    try {
      const middleware = new Middleware(times(3, (index) => `${repeat('t', 39)}${index}`));

      const timerCount = vi.getTimerCount();
      expect(timerCount).toBeGreaterThan(0);

      const destruction = middleware.destroy();
      expect(middleware.destroy()).toBe(destruction);
      await destruction;

      expect(middleware.tokens).toEqual([]);
      expect(vi.getTimerCount()).toBeLessThan(timerCount);

      middleware.addToken(FAKE_TOKEN);
      expect(middleware.tokens).toEqual([]);
      await middleware.removeToken('missing-token');
    } finally {
      vi.useRealTimers();
    }
  });

  test('it should clear dispatcher timers synchronously during destruction', async () => {
    vi.useFakeTimers();
    const middleware = new Middleware([FAKE_TOKEN], { minRemaining: 5000 });
    const requestResponse = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    const state = middleware as unknown as {
      dispatchStates: Record<string, { resetTimer?: NodeJS.Timeout; notificationQueued: boolean }>;
      budgetResetTimer?: NodeJS.Timeout;
      dispatch: (resource: 'core') => void;
    };
    const dispatch = vi.spyOn(state, 'dispatch');

    try {
      await middleware.schedule(requestResponse.req, requestResponse.res);
      await Promise.resolve();
      await Promise.resolve();
      expect(state.dispatchStates.core.resetTimer).toBeDefined();

      const dispatchCallsBeforeDestroy = dispatch.mock.calls.length;
      const destruction = middleware.destroy();
      expect(state.budgetResetTimer).toBeUndefined();
      for (const resource of Object.values(state.dispatchStates)) {
        expect(resource.resetTimer).toBeUndefined();
        expect(resource.notificationQueued).toBe(false);
      }
      await destruction;
      vi.advanceTimersByTime(120000);
      await Promise.resolve();
      expect(dispatch.mock.calls.length).toBe(dispatchCallsBeforeDestroy);
    } finally {
      await middleware.destroy();
      vi.useRealTimers();
    }
  });

  test('it should terminate queued responses and ignore work after destroy', async () => {
    const middleware = new Middleware([FAKE_TOKEN], { minRemaining: 5000 });
    const response = {
      destroyed: false,
      destroy: vi.fn(),
      writableEnded: false
    } as unknown as Response;

    await middleware.schedule({ method: 'GET', path: '/' } as Request, response);
    await middleware.destroy();

    expect(response.destroy).toHaveBeenCalledTimes(1);

    await middleware.schedule({ method: 'GET', path: '/' } as Request, response);
    expect(response.destroy).toHaveBeenCalledTimes(2);
  });

  test('it should settle worker schedule promises cleared during destruction', async () => {
    const middleware = new Middleware([FAKE_TOKEN], { minRemaining: 0 });
    const worker = (
      middleware as unknown as {
        workersByResource: {
          core: Array<{
            remaining: number;
            reset: number;
            proxy: { proxy: (...args: never[]) => Promise<void> };
            schedule: (req: Request, res: Response) => Promise<void>;
          }>;
        };
      }
    ).workersByResource.core[0];
    worker.remaining = 1000;
    worker.reset = 0;

    vi.spyOn(worker.proxy, 'proxy').mockImplementation(() => new Promise<void>(() => undefined));

    const requests = times(11, () => {
      const request = {
        headers: {},
        method: 'GET',
        path: '/',
        socket: { destroyed: false, writableFinished: false }
      } as unknown as Request;
      const response = {
        destroy: vi.fn(),
        destroyed: false,
        writableEnded: false
      } as unknown as Response;
      return { request, response };
    });

    const schedules = requests.map(({ request, response }) => worker.schedule(request, response));
    const destruction = middleware.destroy();

    await expect(Promise.all(schedules)).resolves.toHaveLength(11);
    await destruction;
    requests.forEach(({ response }) => expect(response.destroy).toHaveBeenCalled());
  });

  test('it should await concurrent token removal during router destruction', async () => {
    const firstToken = `${repeat('a', 39)}0`;
    const secondToken = `${repeat('a', 39)}1`;
    const middleware = new Middleware([firstToken, secondToken]);
    const removal = middleware.removeToken(firstToken);
    const destruction = middleware.destroy();

    await Promise.all([removal, destruction]);
    expect(middleware.tokens).toEqual([]);
  });

  test('it should aggregate Agent destruction failures after attempting every worker', async () => {
    const middleware = new Middleware([FAKE_TOKEN]);
    const worker = (
      middleware as unknown as {
        workersByResource: { core: Array<{ agent: { destroy: () => Promise<void> } }> };
      }
    ).workersByResource.core[0];
    vi.spyOn(worker.agent, 'destroy').mockRejectedValue(new Error('agent cleanup failed'));

    await expect(middleware.destroy()).rejects.toThrow('agent cleanup failed');
    await expect(middleware.destroy()).rejects.toThrow('agent cleanup failed');
  });

  test('manual refresh should reject and not emit ready when a worker refresh fails', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('refresh failed'));
    const middleware = new Middleware([FAKE_TOKEN]);
    const ready = vi.fn();
    middleware.on('ready', ready);

    try {
      await expect(middleware.refreshRateLimits()).rejects.toThrow('refresh failed');
      expect(ready).not.toHaveBeenCalled();
    } finally {
      await middleware.destroy();
      fetch.mockRestore();
    }
  });

  test('should not write or destroy an already-completed response after a proxy error', async () => {
    const middleware = new Middleware([FAKE_TOKEN]);
    const worker = (
      middleware as unknown as {
        workersByResource: {
          core: Array<{
            remaining: number;
            reset: number;
            proxy: { proxy: (...args: never[]) => Promise<void> };
            schedule: (req: Request, res: Response) => Promise<void>;
          }>;
        };
      }
    ).workersByResource.core[0];
    worker.remaining = 5000;
    worker.reset = 0;
    const { req, res, send, status, destroy } = createStateAwareRequestResponse({
      headersSent: true,
      writableEnded: true,
      destroyed: false
    });
    const proxy = vi.spyOn(worker.proxy, 'proxy').mockRejectedValue(new Error('upstream failed'));

    try {
      await worker.schedule(req, res);
      expect(status).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      proxy.mockRestore();
      await middleware.destroy();
    }
  });

  test('should destroy a connected partial response without sending a duplicate error', async () => {
    const middleware = new Middleware([FAKE_TOKEN]);
    const worker = (
      middleware as unknown as {
        workersByResource: {
          core: Array<{
            remaining: number;
            reset: number;
            proxy: { proxy: (...args: never[]) => Promise<void> };
            schedule: (req: Request, res: Response) => Promise<void>;
          }>;
        };
      }
    ).workersByResource.core[0];
    worker.remaining = 5000;
    worker.reset = 0;
    const { req, res, send, status, destroy } = createStateAwareRequestResponse({
      headersSent: true,
      writableEnded: false,
      destroyed: false
    });
    const proxy = vi.spyOn(worker.proxy, 'proxy').mockRejectedValue(new Error('upstream failed'));

    try {
      await worker.schedule(req, res);
      expect(status).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      proxy.mockRestore();
      await middleware.destroy();
    }
  });

  test('should propagate request cancellation to the active upstream operation', async () => {
    const middleware = new Middleware([FAKE_TOKEN]);
    const worker = (
      middleware as unknown as {
        workersByResource: {
          core: Array<{
            remaining: number;
            reset: number;
            proxy: {
              proxy: (
                req: Request,
                res: Response,
                options?: { abortController?: AbortController }
              ) => Promise<void>;
            };
            schedule: (req: Request, res: Response) => Promise<void>;
          }>;
        };
      }
    ).workersByResource.core[0];
    worker.remaining = 5000;
    worker.reset = 0;
    const { req, res, status, destroy } = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const proxy = vi.spyOn(worker.proxy, 'proxy').mockImplementation((_req, _res, options) => {
      signal = options?.abortController?.signal;
      started();
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted', 'AbortError')),
          { once: true }
        );
      });
    });

    try {
      const scheduled = worker.schedule(req, res);
      await operationStarted;
      req.aborted = true;
      req.emit('aborted');
      await scheduled;
      expect(signal?.aborted).toBe(true);
      expect(status).not.toHaveBeenCalled();
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      proxy.mockRestore();
      await middleware.destroy();
    }
  });

  test('should not write a local rejection response after the request disconnects', async () => {
    const middleware = new Middleware([FAKE_TOKEN]);
    const worker = (
      middleware as unknown as {
        workersByResource: {
          core: Array<{
            remaining: number;
            reset: number;
            proxy: { proxy: (...args: never[]) => Promise<void> };
            schedule: (req: Request, res: Response) => Promise<void>;
          }>;
        };
      }
    ).workersByResource.core[0];
    worker.remaining = 5000;
    worker.reset = 0;
    const { req, res, json } = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    const proxy = vi.spyOn(worker.proxy, 'proxy').mockImplementation(async () => {
      req.aborted = true;
      throw new PayloadTooLargeError();
    });

    try {
      await worker.schedule(req, res);
      expect(json).not.toHaveBeenCalled();
    } finally {
      proxy.mockRestore();
      await middleware.destroy();
    }
  });

  test('should destroy partial responses from the worker lifetime-error path', async () => {
    const middleware = new Middleware([FAKE_TOKEN]);
    const worker = (
      middleware as unknown as {
        workersByResource: {
          core: Array<{
            remaining: number;
            reset: number;
            proxy: { proxy: (...args: never[]) => Promise<void> };
            schedule: (req: Request, res: Response) => Promise<void>;
          }>;
        };
      }
    ).workersByResource.core[0];
    worker.remaining = 5000;
    worker.reset = 0;
    const requestResponse = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    const proxy = vi.spyOn(worker.proxy, 'proxy').mockImplementation(async (req) => {
      requestResponse.res.headersSent = true;
      (req as unknown as { proxyContext?: { timeoutReason?: string } })
        .proxyContext!.timeoutReason = 'lifetime';
      throw new Error('lifetime expired');
    });

    try {
      await worker.schedule(requestResponse.req, requestResponse.res);
      expect(requestResponse.destroy).toHaveBeenCalledTimes(1);
      expect(requestResponse.json).not.toHaveBeenCalled();
    } finally {
      proxy.mockRestore();
      await middleware.destroy();
    }
  });

  test('should abort the active proxy before settling a destroyed worker task', async () => {
    const middleware = new Middleware([FAKE_TOKEN]);
    const worker = (
      middleware as unknown as {
        workersByResource: {
          core: Array<{
            remaining: number;
            reset: number;
            proxy: {
              proxy: (
                req: Request,
                res: Response,
                options?: { abortController?: AbortController }
              ) => Promise<void>;
            };
            schedule: (req: Request, res: Response) => Promise<void>;
            destroy: () => Promise<void>;
          }>;
        };
      }
    ).workersByResource.core[0];
    worker.remaining = 5000;
    worker.reset = 0;
    const { req, res, status, send } = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    let signal: AbortSignal | undefined;
    let started!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const proxy = vi.spyOn(worker.proxy, 'proxy').mockImplementation((_req, _res, options) => {
      signal = options?.abortController?.signal;
      started();
      return new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted', 'AbortError')),
          { once: true }
        );
      });
    });

    try {
      const scheduled = worker.schedule(req, res);
      await operationStarted;
      await Promise.all([scheduled, worker.destroy()]);
      expect(signal?.aborted).toBe(true);
      expect(status).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      proxy.mockRestore();
      await middleware.destroy();
    }
  });

  test('should retain the router while destroying an active request context', async () => {
    const middleware = new Middleware([FAKE_TOKEN], { minRemaining: 0 });
    const worker = (
      middleware as unknown as {
        workersByResource: {
          core: Array<{
            schedule: (req: Request, res: Response) => Promise<void>;
            destroy: () => Promise<void>;
          }>;
        };
      }
    ).workersByResource.core[0];
    const { req, res } = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    (worker as unknown as { remaining: number; reset: number }).remaining = 5000;
    (worker as unknown as { remaining: number; reset: number }).reset = 0;
    const proxy = vi
      .spyOn(
        (worker as unknown as { proxy: { proxy: (...args: never[]) => Promise<void> } }).proxy,
        'proxy'
      )
      .mockImplementation(() => new Promise<void>(() => undefined));

    try {
      await middleware.schedule(req, res);
      await waitFor(
        () => (worker as unknown as { ownedContexts: Set<unknown> }).ownedContexts.size === 1
      );
      const context = (req as Request & { proxyContext?: { controller: AbortController } })
        .proxyContext;
      expect(context).toBeDefined();
      expect((worker as unknown as { ownedContexts: Set<unknown> }).ownedContexts.size).toBe(1);
      await worker.destroy();
      expect(context?.controller.signal.aborted).toBe(true);
      expect((req as Request & { proxyContext?: unknown }).proxyContext).toBeUndefined();
    } finally {
      proxy.mockRestore();
      await middleware.destroy();
    }
  });

  test('should abort the shared controller and return one fresh 504 at the lifetime deadline', async () => {
    const middleware = new Middleware([FAKE_TOKEN], {
      minRemaining: 0,
      requestLifetimeTimeout: 250,
      queueWaitTimeout: 1000
    });
    const worker = (
      middleware as unknown as {
        workersByResource: {
          core: Array<{
            remaining: number;
            reset: number;
            proxy: {
              proxy: (
                req: Request,
                res: Response,
                options?: { abortController?: AbortController }
              ) => Promise<void>;
            };
          }>;
        };
      }
    ).workersByResource.core[0];
    worker.remaining = 5000;
    worker.reset = 0;
    const requestResponse = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    requestResponse.json.mockImplementation(() => {
      requestResponse.res.headersSent = true;
    });
    let observedSignal: AbortSignal | undefined;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const proxy = vi.spyOn(worker.proxy, 'proxy').mockImplementation((_req, _res, options) => {
      observedSignal = options?.abortController?.signal;
      started();
      return new Promise<void>((_resolve, reject) => {
        observedSignal?.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted', 'AbortError')),
          { once: true }
        );
      });
    });

    try {
      await middleware.schedule(requestResponse.req, requestResponse.res);
      await startedPromise;
      const context = (
        requestResponse.req as Request & {
          proxyContext?: { controller: AbortController };
        }
      ).proxyContext;
      expect(context).toBeDefined();
      await waitFor(() => requestResponse.json.mock.calls.length === 1);
      expect(observedSignal).toBe(context?.controller.signal);
      expect(observedSignal?.aborted).toBe(true);
      expect(requestResponse.status).toHaveBeenCalledWith(StatusCodes.GATEWAY_TIMEOUT);
      expect(requestResponse.json).toHaveBeenCalledWith({ message: 'Request lifetime exceeded' });
    } finally {
      proxy.mockRestore();
      await middleware.destroy();
    }
  });

  test('should destroy a partial response on active lifetime expiry', async () => {
    const middleware = new Middleware([FAKE_TOKEN], {
      minRemaining: 0,
      requestLifetimeTimeout: 250,
      queueWaitTimeout: 1000
    });
    const worker = (
      middleware as unknown as {
        workersByResource: {
          core: Array<{
            remaining: number;
            reset: number;
            proxy: {
              proxy: (
                req: Request,
                res: Response,
                options?: { abortController?: AbortController }
              ) => Promise<void>;
            };
          }>;
        };
      }
    ).workersByResource.core[0];
    worker.remaining = 5000;
    worker.reset = 0;
    const requestResponse = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    requestResponse.destroy.mockImplementation(() => {
      requestResponse.res.destroyed = true;
    });
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const proxy = vi.spyOn(worker.proxy, 'proxy').mockImplementation((_req, res, options) => {
      res.headersSent = true;
      started();
      return new Promise<void>((_resolve, reject) => {
        options?.abortController?.signal.addEventListener(
          'abort',
          () => reject(new DOMException('The operation was aborted', 'AbortError')),
          { once: true }
        );
      });
    });

    try {
      await middleware.schedule(requestResponse.req, requestResponse.res);
      await startedPromise;
      await waitFor(() => requestResponse.destroy.mock.calls.length === 1);
      expect(requestResponse.json).not.toHaveBeenCalled();
    } finally {
      proxy.mockRestore();
      await middleware.destroy();
    }
  });

  test.each([
    ['completed', { headersSent: false, writableEnded: true, destroyed: false }],
    ['disconnected', { headersSent: false, writableEnded: false, destroyed: false }]
  ])(
    'should not write or destroy a %s response on active lifetime expiry',
    async (_name, state) => {
      const middleware = new Middleware([FAKE_TOKEN], {
        minRemaining: 0,
        requestLifetimeTimeout: 250,
        queueWaitTimeout: 1000
      });
      const worker = (
        middleware as unknown as {
          workersByResource: {
            core: Array<{
              remaining: number;
              reset: number;
              proxy: {
                proxy: (
                  req: Request,
                  res: Response,
                  options?: { abortController?: AbortController }
                ) => Promise<void>;
              };
            }>;
          };
        }
      ).workersByResource.core[0];
      worker.remaining = 5000;
      worker.reset = 0;
      const requestResponse = createStateAwareRequestResponse({
        headersSent: false,
        writableEnded: false,
        destroyed: false
      });
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      const proxy = vi.spyOn(worker.proxy, 'proxy').mockImplementation((req, res, options) => {
        if (_name === 'disconnected') req.aborted = true;
        if (_name === 'completed') {
          (res as unknown as { writableEnded: boolean }).writableEnded = true;
        }
        started();
        return new Promise<void>((_resolve, reject) => {
          options?.abortController?.signal.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted', 'AbortError')),
            { once: true }
          );
        });
      });

      try {
        await middleware.schedule(requestResponse.req, requestResponse.res);
        await startedPromise;
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(requestResponse.json).not.toHaveBeenCalled();
        expect(requestResponse.destroy).not.toHaveBeenCalled();
      } finally {
        proxy.mockRestore();
        await middleware.destroy();
      }
    }
  );

  test('should destroy a partial response when active lifetime expires', async () => {
    const middleware = new Middleware([FAKE_TOKEN]);
    const requestResponse = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    await middleware.schedule(requestResponse.req, requestResponse.res);
    const queue = (
      middleware as unknown as {
        queues: {
          core: { dequeue: () => { req: Request; res: Response } | undefined; size: number };
        };
      }
    ).queues.core;
    queue.dequeue();
    const context = (
      requestResponse.req as Request & {
        proxyContext?: { state: string; timeoutReason?: string };
      }
    ).proxyContext;
    expect(context).toBeDefined();
    context!.state = 'active';
    context!.timeoutReason = 'lifetime';
    requestResponse.res.headersSent = true;

    try {
      (
        middleware as unknown as {
          expireLifetime: (value: typeof context) => void;
        }
      ).expireLifetime(context);
      expect(requestResponse.destroy).toHaveBeenCalledTimes(1);
      expect(requestResponse.json).not.toHaveBeenCalled();
    } finally {
      await middleware.destroy();
    }
  });

  test.each([
    ['completed', { headersSent: false, writableEnded: true, destroyed: false }],
    ['disconnected', { headersSent: false, writableEnded: false, destroyed: false }]
  ])('should leave %s responses untouched on lifetime expiry', async (_name, state) => {
    const middleware = new Middleware([FAKE_TOKEN]);
    const requestResponse = createStateAwareRequestResponse(state);
    await middleware.schedule(requestResponse.req, requestResponse.res);
    const context = (
      requestResponse.req as Request & {
        proxyContext?: { state: string };
      }
    ).proxyContext;
    expect(context).toBeDefined();
    if (_name === 'disconnected') requestResponse.req.aborted = true;

    try {
      (
        middleware as unknown as {
          expireLifetime: (value: typeof context) => void;
        }
      ).expireLifetime(context);
      expect(requestResponse.json).not.toHaveBeenCalled();
      expect(requestResponse.destroy).not.toHaveBeenCalled();
    } finally {
      await middleware.destroy();
    }
  });
});

describe('Rate-limit refresh policy', () => {
  test('should fetch once per token and fan out validated resources', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(rateLimitResponse());
    const middleware = new Middleware([FAKE_TOKEN]);

    try {
      await new Promise((resolve) => middleware.once('ready', resolve));
      expect(fetch).toHaveBeenCalledTimes(1);

      const workers = (
        middleware as unknown as {
          workersByResource: Record<string, Array<{ remaining: number; reset: number }>>;
        }
      ).workersByResource;
      expect(workers.core[0]).toMatchObject({ remaining: 4000, reset: 2000000000 });
      expect(workers.search[0]).toMatchObject({ remaining: 25, reset: 2000000000 });
      expect(workers.code_search[0]).toMatchObject({ remaining: 8, reset: 2000000000 });
      expect(workers.graphql[0]).toMatchObject({ remaining: 4500, reset: 2000000000 });
    } finally {
      await middleware.destroy();
      fetch.mockRestore();
    }
  });

  test('should coalesce concurrent refreshes for a token', async () => {
    let resolveResponse!: (response: globalThis.Response) => void;
    const pendingResponse = new Promise<globalThis.Response>((resolve) => {
      resolveResponse = resolve;
    });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rateLimitResponse())
      .mockImplementation(() => pendingResponse);
    const middleware = new Middleware([FAKE_TOKEN]);

    try {
      await new Promise((resolve) => middleware.once('ready', resolve));
      const first = middleware.refreshRateLimits();
      const second = middleware.refreshRateLimits();
      expect(fetch).toHaveBeenCalledTimes(2);

      resolveResponse(rateLimitResponse());
      await Promise.all([first, second]);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await middleware.destroy();
      fetch.mockRestore();
    }
  });

  test('should retry bounded refresh failures and preserve stale values', async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(rateLimitResponse());
    const middleware = new Middleware([FAKE_TOKEN]);

    try {
      await new Promise((resolve) => middleware.once('ready', resolve));
      const worker = (
        middleware as unknown as {
          workersByResource: { core: Array<{ remaining: number; reset: number }> };
        }
      ).workersByResource.core[0];
      const previous = { remaining: worker.remaining, reset: worker.reset };
      fetch.mockRejectedValue(new Error('network unavailable'));

      const refresh = middleware.refreshRateLimits();
      const rejection = expect(refresh).rejects.toThrow('after 3 attempts');
      await vi.advanceTimersByTimeAsync(250);
      await vi.advanceTimersByTimeAsync(500);
      await rejection;
      expect(fetch).toHaveBeenCalledTimes(4);
      expect(worker).toMatchObject(previous);
    } finally {
      await middleware.destroy();
      fetch.mockRestore();
      vi.useRealTimers();
    }
  });

  test('should reject malformed HTTP, JSON, and resource responses', async () => {
    const invalidResponses = [
      rateLimitResponse(undefined, StatusCodes.BAD_GATEWAY),
      {
        status: StatusCodes.OK,
        json: async () => {
          throw new Error('invalid json');
        }
      } as unknown as globalThis.Response,
      rateLimitResponse({ core: { remaining: 1, reset: 2000000000 } })
    ];

    for (const invalidResponse of invalidResponses) {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(rateLimitResponse());
      const middleware = new Middleware([FAKE_TOKEN]);
      try {
        await new Promise((resolve) => middleware.once('ready', resolve));
        fetch.mockResolvedValue(invalidResponse);
        const refresh = middleware.refreshRateLimits();
        await expect(refresh).rejects.toThrow('Rate-limit refresh failed');
      } finally {
        await middleware.destroy();
        fetch.mockRestore();
      }
    }
  });

  test('should contain refresh failures when destroyed during a retry', async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network unavailable'));
    const middleware = new Middleware([FAKE_TOKEN]);

    try {
      const refresh = middleware.refreshRateLimits();
      await vi.advanceTimersByTimeAsync(250);
      await middleware.destroy();
      await expect(refresh).resolves.toBeUndefined();
    } finally {
      fetch.mockRestore();
      vi.useRealTimers();
    }
  });

  test('should abort a never-settling refresh when destroyed', async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<globalThis.Response>(() => undefined);
    });
    const middleware = new Middleware([FAKE_TOKEN]);

    try {
      await middleware.destroy();
      expect(signal?.aborted).toBe(true);
    } finally {
      fetch.mockRestore();
    }
  });

  test('should stop removed-token retries without later fetches or diagnostics', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rateLimitResponse())
      .mockRejectedValue(new Error('network unavailable'));
    const middleware = new Middleware([FAKE_TOKEN]);
    const errors = vi.fn();
    middleware.on('error', errors);

    try {
      await new Promise((resolve) => middleware.once('ready', resolve));
      const refresh = middleware.refreshRateLimits();
      await Promise.resolve();
      await Promise.resolve();
      await middleware.removeToken(FAKE_TOKEN);
      await expect(refresh).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(5000);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      await middleware.destroy();
      fetch.mockRestore();
      vi.useRealTimers();
    }
  });

  test('should recover after a retry succeeds', async () => {
    vi.useFakeTimers();
    const recovered = rateLimitResponse({
      core: { limit: 5000, remaining: 1234, reset: 2000000100 },
      search: { limit: 30, remaining: 20, reset: 2000000100 },
      code_search: { limit: 10, remaining: 7, reset: 2000000100 },
      graphql: { limit: 5000, remaining: 4321, reset: 2000000100 }
    });
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(rateLimitResponse())
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockResolvedValueOnce(recovered);
    const middleware = new Middleware([FAKE_TOKEN]);

    try {
      await new Promise((resolve) => middleware.once('ready', resolve));
      const refresh = middleware.refreshRateLimits();
      const success = expect(refresh).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(250);
      await success;

      const worker = (
        middleware as unknown as {
          workersByResource: { core: Array<{ remaining: number; reset: number }> };
        }
      ).workersByResource.core[0];
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(worker).toMatchObject({ remaining: 1234, reset: 2000000100 });
    } finally {
      await middleware.destroy();
      fetch.mockRestore();
      vi.useRealTimers();
    }
  });

  test('should perform one refresh fetch per token across multiple tokens', async () => {
    const firstToken = `${repeat('a', 39)}0`;
    const secondToken = `${repeat('b', 39)}1`;
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(rateLimitResponse());
    const middleware = new Middleware([firstToken, secondToken]);

    try {
      await middleware.refreshRateLimits();
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls.map(([, init]) => init?.headers)).toEqual([
        expect.objectContaining({ authorization: `token ${firstToken}` }),
        expect.objectContaining({ authorization: `token ${secondToken}` })
      ]);
    } finally {
      await middleware.destroy();
      fetch.mockRestore();
    }
  });
});

async function waitFor(condition: () => boolean, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for test condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function createStateAwareRequestResponse(state: {
  headersSent: boolean;
  writableEnded: boolean;
  destroyed: boolean;
}): {
  req: Request & { aborted: boolean };
  res: Response;
  send: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
} {
  const socket = Object.assign(new EventEmitter(), { destroyed: false });
  const resume = vi.fn();
  const req = Object.assign(new EventEmitter(), {
    method: 'GET',
    url: '/',
    path: '/',
    headers: { host: 'localhost:3000' },
    socket,
    resume,
    aborted: false,
    destroyed: false
  }) as unknown as Request & { aborted: boolean };
  const send = vi.fn();
  const json = vi.fn();
  const status = vi.fn(() => ({ send, json }));
  const setHeader = vi.fn();
  const destroy = vi.fn();
  const res = Object.assign(new EventEmitter(), {
    ...state,
    status,
    setHeader,
    destroy
  }) as unknown as Response;

  return { req, res, send, json, status, setHeader, destroy, resume };
}

describe('Middleware core', () => {
  let mockAgent: MockAgent;
  let mockPool: MockPool;
  let middleware: Middleware;

  const requestTimeout = 1000;

  function proxyReply(
    method: string,
    path: string,
    status: number,
    data?: Record<string, unknown> | string,
    headers: Record<string, string> = {}
  ) {
    return mockPool.intercept({ path, method }).reply(status, data, {
      headers: {
        'x-oauth-scopes': 'public_repo, read:org, read:user, user:emai',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': `${Math.floor((Date.now() + 60 * 60 * 1000) / 1000)}`,
        ...headers
      }
    });
  }

  beforeEach(async () => {
    if (!nock.isActive()) nock.activate();

    nock('https://api.github.com', { allowUnmocked: false })
      .get('/rate_limit')
      .reply(StatusCodes.OK, {
        resources: {
          core: { limit: 5000, remaining: 5000, reset: Date.now() + 60 * 60 },
          search: { limit: 30, remaining: 30, reset: Date.now() + 60 * 60 },
          code_search: { limit: 10, remaining: 10, reset: Date.now() + 60 * 60 },
          graphql: { limit: 5000, remaining: 5000, reset: Date.now() + 60 * 60 }
        }
      })
      .persist();

    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    mockPool = mockAgent.get('https://api.github.com');

    app = express();

    middleware = new Middleware([FAKE_TOKEN], {
      requestTimeout,
      minRemaining: 0,
      overrideAuthorization: false,
      dispatcher: mockAgent
    });

    await new Promise((resolve) => middleware.on('ready', resolve));

    app.get('{/*path}', (req, res) => middleware.schedule(req, res));
  });

  afterEach(async () => {
    await middleware.destroy();
    await mockAgent.close();
    nock.cleanAll();
    nock.restore();
  });

  afterAll(() => {
    nock.abortPendingRequests();
  });

  describe('GitHub API is down or not reachable', () => {
    beforeEach(() => {
      const connectionError = new Error('connect failed');
      Object.assign(connectionError, {
        code: 'ECONNREFUSED',
        errno: 'ECONNREFUSED',
        syscall: 'getaddrinfo'
      });
      mockPool.intercept({ path: '/', method: 'GET' }).replyWithError(connectionError);
    });

    test(`it should respond with Bad Gateway (${StatusCodes.BAD_GATEWAY})`, async () => {
      await request(app).get('/').expect(StatusCodes.BAD_GATEWAY);
    });
  });

  test.each(['ftp://proxy.example', '//proxy.example', 'not-a-url', 'https://proxy.example/?x=1'])(
    'it should reject invalid external base URL %s',
    (externalBaseUrl) => {
      expect(() => new Middleware([FAKE_TOKEN], { externalBaseUrl })).toThrow(
        'Invalid externalBaseUrl'
      );
    }
  );

  test('it should reject requests when the shared resource queue is full', async () => {
    const limited = new Middleware([FAKE_TOKEN], {
      minRemaining: 5000,
      maxQueueDepthPerWorker: 1
    });
    const first = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    const second = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });

    try {
      await limited.schedule(first.req, first.res);
      await limited.schedule(second.req, second.res);
      expect(second.setHeader).toHaveBeenCalledWith('Retry-After', '1');
      expect(second.status).toHaveBeenCalledWith(StatusCodes.SERVICE_UNAVAILABLE);
      expect(second.json).toHaveBeenCalledWith({ message: 'Proxy queue is full' });
      expect(second.resume).toHaveBeenCalledTimes(1);

      limited.addToken(SECOND_TOKEN);
      const third = createStateAwareRequestResponse({
        headersSent: false,
        writableEnded: false,
        destroyed: false
      });
      await limited.schedule(third.req, third.res);
      expect(third.status).not.toHaveBeenCalled();

      await limited.removeToken(SECOND_TOKEN);
      expect(limited.tokens).toEqual([FAKE_TOKEN]);
    } finally {
      await limited.destroy();
    }
  });

  test('it should expire a queued request and remove it from the resource queue', async () => {
    const limited = new Middleware([FAKE_TOKEN], {
      minRemaining: 5000,
      queueWaitTimeout: 1
    });
    const requestResponse = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });

    try {
      await limited.schedule(requestResponse.req, requestResponse.res);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(requestResponse.status).toHaveBeenCalledWith(StatusCodes.GATEWAY_TIMEOUT);
      expect(requestResponse.json).toHaveBeenCalledWith({
        message: 'Request expired in proxy queue'
      });
      expect(requestResponse.resume).toHaveBeenCalledTimes(1);
    } finally {
      await limited.destroy();
    }
  });

  test('it should abort the shared signal when queued lifetime expires', async () => {
    vi.useFakeTimers();
    const limited = new Middleware([FAKE_TOKEN], {
      minRemaining: 5000,
      requestLifetimeTimeout: 10,
      queueWaitTimeout: 100
    });
    const requestResponse = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });

    try {
      await limited.schedule(requestResponse.req, requestResponse.res);
      const context = (
        requestResponse.req as Request & {
          proxyContext?: { controller: AbortController };
        }
      ).proxyContext;
      expect(context).toBeDefined();
      vi.advanceTimersByTime(10);
      expect(context?.controller.signal.aborted).toBe(true);
      expect(requestResponse.json).toHaveBeenCalledWith({ message: 'Request lifetime exceeded' });
    } finally {
      await limited.destroy();
      vi.useRealTimers();
    }
  });

  test('it should remove exactly one queued entry when a client disconnects', async () => {
    const limited = new Middleware([FAKE_TOKEN], {
      minRemaining: 5000,
      maxQueueDepthPerWorker: 2
    });
    const first = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    const second = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });

    try {
      await limited.schedule(first.req, first.res);
      await limited.schedule(second.req, second.res);
      first.req.aborted = true;
      first.req.emit('aborted');
      first.req.emit('aborted');
      const queue = (
        limited as unknown as {
          queues: { core: { size: number; items: Array<{ req: Request }> } };
        }
      ).queues.core;
      expect(queue.size).toBe(1);
      expect(queue.items[0]?.req).toBe(second.req);
      expect((first.req as Request & { proxyContext?: unknown }).proxyContext).toBeUndefined();
    } finally {
      await limited.destroy();
    }
  });

  test('should not spin on an exhausted worker before the budget reset', async () => {
    vi.useFakeTimers();
    const limited = new Middleware([FAKE_TOKEN], {
      minRemaining: 0,
      queueWaitTimeout: 120000,
      requestLifetimeTimeout: 120000
    });
    const worker = (
      limited as unknown as {
        workersByResource: {
          core: Array<{
            remaining: number;
            reset: number;
            timeBudget: number;
            schedule: (req: Request, res: Response) => Promise<void>;
          }>;
        };
      }
    ).workersByResource.core[0];
    const queue = (
      limited as unknown as {
        queues: { core: { size: number } };
      }
    ).queues.core;
    const requestResponse = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    const schedule = vi.spyOn(worker, 'schedule').mockResolvedValue(undefined);
    const notifyDispatch = vi.spyOn(
      limited as unknown as { notifyDispatch: (resource: 'core') => void },
      'notifyDispatch'
    );

    try {
      await limited.refreshRateLimits();
      worker.remaining = 5000;
      worker.reset = 0;
      worker.timeBudget = 0;

      await limited.schedule(requestResponse.req, requestResponse.res);
      await Promise.resolve();
      await Promise.resolve();
      expect(schedule).not.toHaveBeenCalled();
      expect(queue.size).toBe(1);
      const notificationsBeforeAdvance = notifyDispatch.mock.calls.length;

      vi.advanceTimersByTime(59999);
      await Promise.resolve();
      expect(schedule).not.toHaveBeenCalled();
      expect(queue.size).toBe(1);
      expect(notifyDispatch.mock.calls.length).toBe(notificationsBeforeAdvance);

      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
      expect(schedule).toHaveBeenCalledTimes(1);
      expect(queue.size).toBe(0);
    } finally {
      await limited.destroy();
      vi.useRealTimers();
    }
  });

  test('it should dispatch queued work immediately in exact round-robin order', async () => {
    const middleware = new Middleware([FAKE_TOKEN, SECOND_TOKEN], { minRemaining: 0 });
    const workers = (
      middleware as unknown as {
        workersByResource: {
          core: Array<{
            remaining: number;
            reset: number;
            schedule: (req: Request, res: Response) => Promise<void>;
          }>;
        };
        queues: { core: { enqueue: (req: Request, res: Response) => void; size: number } };
        dispatch: (resource: 'core') => void;
      }
    ).workersByResource.core;
    const router = middleware as unknown as {
      queues: { core: { enqueue: (req: Request, res: Response) => void; size: number } };
      dispatch: (resource: 'core') => void;
    };
    const order: number[] = [];
    workers.forEach((worker, index) => {
      worker.remaining = 5000;
      worker.reset = 0;
      vi.spyOn(worker, 'schedule').mockImplementation(async () => {
        order.push(index);
      });
    });

    try {
      for (let index = 0; index < 4; index += 1) {
        const requestResponse = createStateAwareRequestResponse({
          headersSent: false,
          writableEnded: false,
          destroyed: false
        });
        router.queues.core.enqueue(requestResponse.req, requestResponse.res);
      }
      router.dispatch('core');
      expect(order).toEqual([0, 1, 0, 1]);
      expect(router.queues.core.size).toBe(0);
    } finally {
      await middleware.destroy();
    }
  });

  test('it should dispatch an enqueue notification without polling delay', async () => {
    const middleware = new Middleware([FAKE_TOKEN], { minRemaining: 0 });
    const worker = (
      middleware as unknown as {
        workersByResource: {
          core: Array<{
            remaining: number;
            reset: number;
            schedule: (req: Request, res: Response) => Promise<void>;
          }>;
        };
      }
    ).workersByResource.core[0];
    worker.remaining = 5000;
    worker.reset = 0;
    const schedule = vi.spyOn(worker, 'schedule').mockResolvedValue(undefined);
    const requestResponse = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });

    try {
      await middleware.schedule(requestResponse.req, requestResponse.res);
      await Promise.resolve();
      await Promise.resolve();
      expect(schedule).toHaveBeenCalledTimes(1);
    } finally {
      await middleware.destroy();
    }
  });

  test('it should dispatch the next request immediately after a worker completes', async () => {
    const middleware = new Middleware([FAKE_TOKEN], { minRemaining: 0 });
    const worker = (
      middleware as unknown as {
        workersByResource: {
          search: Array<{
            remaining: number;
            reset: number;
            proxy: { proxy: (...args: never[]) => Promise<void> };
          }>;
        };
      }
    ).workersByResource.search[0];
    worker.remaining = 5000;
    worker.reset = 0;
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    let calls = 0;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    vi.spyOn(worker.proxy, 'proxy').mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        markFirstStarted();
        await new Promise<void>((resolveFirst) => (releaseFirst = resolveFirst));
      }
    });
    const first = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    Object.defineProperty(first.req, 'path', { value: '/search', configurable: true });
    const second = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    Object.defineProperty(second.req, 'path', { value: '/search', configurable: true });

    try {
      await middleware.schedule(first.req, first.res);
      await middleware.schedule(second.req, second.res);
      await firstStarted;
      expect(calls).toBe(1);
      releaseFirst();
      await waitFor(() => calls === 2);
    } finally {
      await middleware.destroy();
    }
  });

  test('it should keep resource dispatch queues independent', async () => {
    const middleware = new Middleware([FAKE_TOKEN], { minRemaining: 0 });
    const workers = (
      middleware as unknown as {
        workersByResource: {
          core: Array<{ remaining: number; reset: number }>;
          search: Array<{
            remaining: number;
            reset: number;
            schedule: (req: Request, res: Response) => Promise<void>;
          }>;
        };
      }
    ).workersByResource;
    workers.core[0].remaining = 0;
    workers.core[0].reset = Math.floor(Date.now() / 1000) + 60;
    workers.search[0].remaining = 5000;
    workers.search[0].reset = 0;
    const schedule = vi.spyOn(workers.search[0], 'schedule').mockResolvedValue(undefined);
    const core = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    const search = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    Object.defineProperty(search.req, 'path', { value: '/search', configurable: true });

    try {
      await middleware.schedule(core.req, core.res);
      await middleware.schedule(search.req, search.res);
      await Promise.resolve();
      await Promise.resolve();
      expect(schedule).toHaveBeenCalledTimes(1);
    } finally {
      await middleware.destroy();
    }
  });

  test('it should reserve atomic concurrency slots for each resource', async () => {
    const middleware = new Middleware([FAKE_TOKEN], { minRemaining: 0 });
    const workers = (
      middleware as unknown as {
        workersByResource: Record<
          'core' | 'search' | 'code_search' | 'graphql',
          Array<{
            remaining: number;
            reset: number;
            timeBudget: number;
            reserveWork: () => boolean;
            releaseReservation: () => void;
          }>
        >;
      }
    ).workersByResource;

    try {
      for (const resource of ['core', 'graphql', 'search', 'code_search'] as const) {
        const worker = workers[resource][0];
        worker.remaining = 5000;
        worker.reset = 0;
        worker.timeBudget = 100000;
        const limit = resource === 'core' || resource === 'graphql' ? 10 : 1;
        const reservations = times(limit, () => worker.reserveWork());
        expect(reservations).toEqual(times(limit, () => true));
        expect(worker.reserveWork()).toBe(false);
        times(limit, () => worker.releaseReservation());
      }
    } finally {
      await middleware.destroy();
    }
  });

  test('it should preserve absolute deadlines and clear worker ownership across retries', async () => {
    const middleware = new Middleware([FAKE_TOKEN], { minRemaining: 0 });
    const worker = (
      middleware as unknown as {
        workersByResource: {
          core: Array<{
            remaining: number;
            reset: number;
            schedule: (req: Request, res: Response) => Promise<void>;
          }>;
        };
      }
    ).workersByResource.core[0];
    worker.remaining = 0;
    worker.reset = Math.floor(Date.now() / 1000) + 60;
    const requestResponse = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    const queue = (
      middleware as unknown as {
        queues: {
          core: { dequeue: () => { req: Request; res: Response } | undefined; size: number };
        };
      }
    ).queues.core;

    try {
      await middleware.schedule(requestResponse.req, requestResponse.res);
      const context = (
        requestResponse.req as Request & {
          proxyContext?: { queueDeadline: number; lifetimeDeadline: number; worker?: unknown };
        }
      ).proxyContext;
      const deadlines = [context?.queueDeadline, context?.lifetimeDeadline];
      const work = queue.dequeue();
      await worker.schedule(work!.req, work!.res);
      expect([context?.queueDeadline, context?.lifetimeDeadline]).toEqual(deadlines);
      expect(context?.worker).toBeUndefined();
      expect(queue.size).toBe(1);
    } finally {
      await middleware.destroy();
    }
  });

  test('should preserve a requeued context when worker A is destroyed before worker B claims it', async () => {
    const middleware = new Middleware([FAKE_TOKEN, SECOND_TOKEN], {
      minRemaining: 5000,
      queueWaitTimeout: 1000,
      requestLifetimeTimeout: 2000
    });
    await middleware.refreshRateLimits();
    const workerA = (
      middleware as unknown as {
        workersByResource: {
          core: Array<{
            remaining: number;
            reset: number;
            schedule: (req: Request, res: Response) => Promise<void>;
            destroy: () => Promise<void>;
          }>;
        };
      }
    ).workersByResource.core[0];
    workerA.remaining = 5000;
    workerA.reset = 0;
    const workerB = (
      middleware as unknown as {
        workersByResource: {
          core: Array<{
            remaining: number;
            reset: number;
            applyRateLimit: (limit: { remaining: number; reset: number }) => void;
            proxy: {
              proxy: (
                req: Request,
                res: Response,
                options?: { abortController?: AbortController }
              ) => Promise<void>;
            };
          }>;
        };
      }
    ).workersByResource.core[1];
    workerB.remaining = 0;
    workerB.reset = Math.floor(Date.now() / 1000) + 60;
    const requestResponse = createStateAwareRequestResponse({
      headersSent: false,
      writableEnded: false,
      destroyed: false
    });
    const queue = (
      middleware as unknown as {
        queues: {
          core: { dequeue: () => { req: Request; res: Response } | undefined; size: number };
        };
      }
    ).queues.core;
    let observedSignal: AbortSignal | undefined;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const originalSchedule = workerA.schedule;
    const schedule = vi.spyOn(workerA, 'schedule').mockImplementation((req, res) => {
      workerA.remaining = 0;
      workerA.reset = Math.floor(Date.now() / 1000) + 60;
      return originalSchedule(req, res);
    });

    try {
      await middleware.schedule(requestResponse.req, requestResponse.res);
      const context = (
        requestResponse.req as Request & {
          proxyContext?: {
            controller: AbortController;
            queueDeadline: number;
            lifetimeDeadline: number;
            worker?: unknown;
          };
        }
      ).proxyContext;
      expect(context).toBeDefined();
      const deadlines = [context!.queueDeadline, context!.lifetimeDeadline];
      await waitFor(
        () => schedule.mock.calls.length === 1 && queue.size === 1 && context!.worker === undefined
      );
      expect(queue.size).toBe(1);
      expect(context!.controller.signal.aborted).toBe(false);
      expect([context!.queueDeadline, context!.lifetimeDeadline]).toEqual(deadlines);
      expect(context!.worker).toBeUndefined();

      await workerA.destroy();
      expect(queue.size).toBe(1);
      expect(requestResponse.destroy).not.toHaveBeenCalled();
      expect(context!.controller.signal.aborted).toBe(false);

      const proxy = vi.spyOn(workerB.proxy, 'proxy').mockImplementation((_req, _res, options) => {
        observedSignal = options?.abortController?.signal;
        started();
        return new Promise<void>((_resolve, reject) => {
          observedSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted', 'AbortError')),
            { once: true }
          );
        });
      });

      try {
        workerB.applyRateLimit({ remaining: 5000, reset: 0 });
        await startedPromise;
        expect(observedSignal).toBe(context!.controller.signal);
        expect([context!.queueDeadline, context!.lifetimeDeadline]).toEqual(deadlines);
      } finally {
        proxy.mockRestore();
      }
    } finally {
      schedule.mockRestore();
      await middleware.destroy();
    }
  });

  describe('GitHub API is online', () => {
    test('it should wait if no requests available', async () => {
      const reset = Date.now() + 1000; // must be greather or equal to 1

      proxyReply('GET', '/reset', StatusCodes.OK, '', {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': `${Math.floor(reset / 1000)}`
      });
      proxyReply('GET', '/', StatusCodes.OK);

      await request(app).get('/reset').expect(StatusCodes.OK);

      await request(app).get('/').expect(StatusCodes.OK);
      expect(Date.now()).toBeGreaterThanOrEqual(reset);
    });

    test('it should forward responses received from GitHub', async () => {
      proxyReply('GET', '/', 200).persist();
      await request(app)
        .get('/')
        .then(({ status }) => expect(status).toEqual(200));

      proxyReply('GET', '/300', 300);
      await request(app)
        .get('/300')
        .catch(({ response }) => expect(response.status).toEqual(300));

      proxyReply('GET', '/400', 400);
      await request(app)
        .get('/400')
        .catch(({ response }) => expect(response.status).toEqual(400));

      proxyReply('GET', '/500', 500);
      await request(app)
        .get('/500')
        .catch(({ response }) => expect(response.status).toEqual(500));
    });

    test('it should interrupt long requests', async () => {
      proxyReply('GET', '/', StatusCodes.OK).delay(requestTimeout * 2);

      return request(app).get('/').expect(StatusCodes.BAD_GATEWAY);
    });

    test('it should respond to broken connections', async () => {
      mockPool.intercept({ path: '/', method: 'GET' }).replyWithError(new Error('Server Error'));

      return request(app).get('/').expect(StatusCodes.BAD_GATEWAY);
    });

    test('it should not break proxy when client disconnect', async () => {
      proxyReply('GET', '/', StatusCodes.OK).persist().delay(500);

      await Promise.all(
        times(25, () =>
          request(app)
            .get('/')
            .timeout(50)
            .catch((err) => (err.code === 'ECONNABORTED' ? null : Promise.reject(err)))
        )
      );

      await request(app).get('/').expect(StatusCodes.OK);
    });

    test('it should balance the use of the tokens', async () => {
      proxyReply('GET', '/', 200).persist().delay(250);

      const tokens = times<string>(5, (n) => `${repeat('t', 39)}${n}`)
        .concat(FAKE_TOKEN)
        .reduce((memo: Record<string, number>, token) => ({ ...memo, [token]: 0 }), {});

      for (const token of Object.keys(tokens)) {
        if (middleware.tokens.includes(token)) continue;
        middleware.addToken(token);
        await new Promise((resolve) => middleware.once('ready', resolve));
      }

      middleware.on('log', (data) => {
        const token = Object.keys(tokens).find((token) => token.endsWith(data.token));
        if (token) tokens[token] += 1;
      });

      await Promise.all(times(100, () => request(app).get('/')));

      Object.values(tokens).forEach((calls) => expect(calls).toBeGreaterThan(0));

      await Promise.all(Object.keys(tokens).map((token) => middleware.removeToken(token)));
    });

    test('it should not forward ratelimit and scope information', async () => {
      proxyReply('GET', '/', 200).persist().delay(250);

      return request(app)
        .get('/')
        .then(({ headers }) => {
          expect(Object.keys(headers).filter((h) => h.indexOf('ratelimit') >= 0)).toHaveLength(0);
          expect(Object.keys(headers).filter((h) => h.indexOf('scopes') >= 0)).toHaveLength(0);
        });
    });

    test('it should handle unauthorized requests to API', async () => {
      const tokenI = `token ${repeat('i', 40)}`;
      const tokenJ = `token ${repeat('j', 40)}`;
      mockPool
        .intercept({ path: '/user', method: 'GET', headers: { authorization: tokenI } })
        .reply(401, '', {
          headers: {
            'x-ratelimit-remaining': '59',
            'x-ratelimit-reset': `${Math.floor((Date.now() + 60 * 60 * 1000) / 1000)}`,
            'x-ratelimit-limit': '60'
          }
        });
      mockPool
        .intercept({ path: '/user', method: 'GET', headers: { authorization: tokenJ } })
        .reply(401, '');
      proxyReply('GET', '/user', 200);
      proxyReply('GET', '/', 200).persist();

      await request(app).get('/').expect(200);
      await request(app).get('/user').expect(200);

      await middleware.removeToken(FAKE_TOKEN);
      middleware.addToken(repeat('i', 40));

      await request(app).get('/user').expect(401);

      await middleware.removeToken(repeat('i', 40));
      middleware.addToken(repeat('j', 40));

      await request(app).get('/user').expect(401);
      await request(app).get('/').expect(200);
    });

    test('it should redact invalid tokens from rate-limit errors', async () => {
      const errors: string[] = [];
      middleware.on('error', (error) => errors.push(error.toString()));

      nock.cleanAll();
      nock('https://api.github.com', { allowUnmocked: false })
        .get('/rate_limit')
        .times(4)
        .reply(StatusCodes.UNAUTHORIZED);

      await expect(middleware.refreshRateLimits()).rejects.toThrow('Rate-limit refresh failed');

      expect(errors.join('\n')).not.toContain(FAKE_TOKEN);
      expect(errors.join('\n')).toContain(FAKE_TOKEN.slice(-4));
    });

    test('it should not update limits when "x-ratelimit-remaining" is not on header', async () => {
      mockPool.intercept({ path: '/', method: 'GET' }).reply(401, '', {
        headers: {
          'x-ratelimit-reset': `${Math.floor((Date.now() + 60 * 60 * 1000) / 1000)}`
        }
      });

      await request(app).get('/').expect(401);
    });

    test('it should allow users to override authorization header', async () => {
      const token = repeat('i', 40);
      const tokenStr = `token ${token}`;

      mockPool
        .intercept({ path: '/', method: 'GET', headers: { authorization: tokenStr } })
        .reply(401);
      proxyReply('GET', '/', 200).persist();

      await request(app).get('/').set('Authorization', tokenStr).expect(401);
      await request(app).get('/').expect(200);

      await middleware.destroy();
      middleware = new Middleware([FAKE_TOKEN], {
        requestTimeout,
        minRemaining: 0,
        overrideAuthorization: true,
        dispatcher: mockAgent
      });

      await request(app).get('/').set('Authorization', tokenStr).expect(200);
    });

    test('it should preserve upstream links when no external base URL is configured', async () => {
      const linkStr =
        '<https://api.github.com/repositories/000/tags?page=2>; rel="next", <https://api.github.com/repositories/000/tags?page=10>; rel="last"';

      proxyReply('GET', '/', 200, {}, { link: linkStr });

      await request(app)
        .get('/')
        .expect(({ headers }) => {
          expect(headers.link).toEqual(linkStr);
        });
    });

    test.each([
      'http://proxy.example/base',
      'https://proxy.example',
      'https://proxy.example/$edge'
    ])('it should rewrite redirects and links using trusted external base %s', async (baseUrl) => {
      await middleware.destroy();
      middleware = new Middleware([FAKE_TOKEN], {
        requestTimeout,
        minRemaining: 0,
        externalBaseUrl: baseUrl,
        dispatcher: mockAgent
      });
      await new Promise((resolve) => middleware.once('ready', resolve));

      const linkStr =
        '<https://api.github.com/repos/example?page=2>; rel="next", <https://other.example/?next=https://api.github.com/repos/other>; rel="other"';
      proxyReply('GET', '/redirect', StatusCodes.MOVED_TEMPORARILY, '', {
        location: 'https://api.github.com/repos/example',
        link: linkStr
      });
      proxyReply('GET', '/unrelated-location', StatusCodes.MOVED_TEMPORARILY, '', {
        location: 'https://other.example/redirect?next=https://api.github.com/repos/example',
        link: linkStr
      });

      await request(app)
        .get('/redirect')
        .expect(StatusCodes.MOVED_TEMPORARILY)
        .expect(({ headers }) => {
          expect(headers.location).toBe(`${baseUrl}/repos/example`);
          expect(headers.link).toBe(
            `<${baseUrl}/repos/example?page=2>; rel="next", <https://other.example/?next=https://api.github.com/repos/other>; rel="other"`
          );
        });

      await request(app)
        .get('/unrelated-location')
        .expect(StatusCodes.MOVED_TEMPORARILY)
        .expect(({ headers }) => {
          expect(headers.location).toBe(
            'https://other.example/redirect?next=https://api.github.com/repos/example'
          );
          expect(headers.link).toBe(
            `<${baseUrl}/repos/example?page=2>; rel="next", <https://other.example/?next=https://api.github.com/repos/other>; rel="other"`
          );
        });
    });

    test('should preserve origins when API and external paths begin with double slashes', async () => {
      await middleware.destroy();
      middleware = new Middleware([FAKE_TOKEN], {
        requestTimeout,
        minRemaining: 0,
        externalBaseUrl: 'https://proxy.example//edge',
        dispatcher: mockAgent
      });
      await new Promise((resolve) => middleware.once('ready', resolve));

      proxyReply('GET', '/double-slash', StatusCodes.MOVED_TEMPORARILY, '', {
        location: 'https://api.github.com//repos/example',
        link: '<https://api.github.com//repos/example>; rel="next"'
      });

      await request(app)
        .get('/double-slash')
        .expect(StatusCodes.MOVED_TEMPORARILY)
        .expect(({ headers }) => {
          expect(headers.location).toBe('https://proxy.example//edge//repos/example');
          expect(headers.link).toBe('<https://proxy.example//edge//repos/example>; rel="next"');
        });
    });
  });
});