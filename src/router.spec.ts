import express, { type Express, type Request, type Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import repeat from 'lodash/repeat.js';
import times from 'lodash/times.js';
import nock from 'nock';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import Middleware from './router';

let app: Express;

const FAKE_TOKEN = repeat('t', 40);

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
    ['timeBudgetMultiplier', { timeBudgetMultiplier: 11 }]
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

  test('it should remove/add tokens', async () => {
    const middleware = new Middleware([FAKE_TOKEN]);
    expect(middleware.tokens).toHaveLength(1);

    await middleware.removeToken(FAKE_TOKEN);
    expect(middleware.tokens).toHaveLength(0);

    middleware.addToken(FAKE_TOKEN);
    expect(middleware.tokens).toHaveLength(1);
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
});

describe('Middleware core', () => {
  let scope: nock.Scope;
  let middleware: Middleware;

  const requestTimeout = 1000;

  beforeEach(async () => {
    if (!nock.isActive()) nock.activate();

    scope = nock('https://api.github.com', { allowUnmocked: false })
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

    app = express();

    middleware = new Middleware([FAKE_TOKEN], {
      requestTimeout,
      minRemaining: 0,
      overrideAuthorization: false
    });

    await new Promise((resolve) => middleware.on('ready', resolve));

    app.get('{/*path}', (req, res) => middleware.schedule(req, res));
  });

  afterEach(async () => {
    nock.cleanAll();
    nock.restore();

    await middleware.destroy();
  });

  afterAll(() => {
    nock.abortPendingRequests();
  });

  describe('GitHub API is down or not reachable', () => {
    beforeEach(() => {
      scope.get(/.*/).replyWithError({
        code: 'ECONNREFUSED',
        errno: 'ECONNREFUSED',
        syscall: 'getaddrinfo'
      });
    });

    test(`it should respond with Bad Gateway (${StatusCodes.BAD_GATEWAY})`, async () => {
      await request(app).get('/').expect(StatusCodes.BAD_GATEWAY);
    });
  });

  describe('GitHub API is online', () => {
    let scope: nock.Scope;

    beforeEach(async () => {
      scope = nock('https://api.github.com')
        .persist()
        .defaultReplyHeaders({
          'access-control-expose-headers':
            'ETag, Link, Location, Retry-After, X-GitHub-OTP, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Used, X-RateLimit-Resource, X-RateLimit-Reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval, X-GitHub-Media-Type, Deprecation, Sunset',
          'x-oauth-scopes': 'public_repo, read:org, read:user, user:emai',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': `${Math.floor((Date.now() + 60 * 60 * 1000) / 1000)}`
        });
    });

    test('it should wait if no requests available', async () => {
      const reset = Date.now() + 1000; // must be greather or equal to 1

      scope
        .get('/reset')
        .reply(StatusCodes.OK, '', {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': `${Math.floor(reset / 1000)}`
        })
        .get('/')
        .reply(StatusCodes.OK);

      await request(app).get('/reset').expect(StatusCodes.OK);

      await request(app).get('/').expect(StatusCodes.OK);
      expect(Date.now()).toBeGreaterThanOrEqual(reset);
    });

    test('it should forward responses received from GitHub', async () => {
      scope.get('/').reply(200);
      await request(app)
        .get('/')
        .then(({ status }) => expect(status).toEqual(200));

      scope.get('/300').reply(300);
      await request(app)
        .get('/300')
        .catch(({ response }) => expect(response.status).toEqual(300));

      scope.get('/400').reply(400);
      await request(app)
        .get('/400')
        .catch(({ response }) => expect(response.status).toEqual(400));

      scope.get('/500').reply(500);
      await request(app)
        .get('/500')
        .catch(({ response }) => expect(response.status).toEqual(500));
    });

    test('it should interrupt long requests', async () => {
      scope
        .get('/')
        .delay(requestTimeout * 2)
        .reply(StatusCodes.OK);

      return request(app).get('/').expect(StatusCodes.BAD_GATEWAY);
    });

    test('it should respond to broken connections', async () => {
      scope.get('/').replyWithError(new Error('Server Error'));

      return request(app).get('/').expect(StatusCodes.BAD_GATEWAY);
    });

    test('it should not break proxy when client disconnect', async () => {
      scope.get('/').delay(500).reply(StatusCodes.OK);

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
      scope.get('/').delay(250).reply(200);

      const tokens = times<string>(5, (n) => `${repeat('t', 39)}${n}`)
        .concat(FAKE_TOKEN)
        .reduce((memo: Record<string, number>, token) => ({ ...memo, [token]: 0 }), {});

      for (const token of Object.keys(tokens)) {
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
      scope.get('/').delay(250).reply(200);

      return request(app)
        .get('/')
        .then(({ headers }) => {
          expect(Object.keys(headers).filter((h) => h.indexOf('ratelimit') >= 0)).toHaveLength(0);
          expect(Object.keys(headers).filter((h) => h.indexOf('scopes') >= 0)).toHaveLength(0);
        });
    });

    test('it should handle unauthorized requests to API', async () => {
      scope
        .defaultReplyHeaders({
          'x-ratelimit-remaining': '59',
          'x-ratelimit-reset': `${Math.floor((Date.now() + 60 * 60 * 1000) / 1000)}`
        })
        .get('/user')
        .matchHeader('authorization', `token ${repeat('i', 40)}`)
        .reply(401, '', { 'x-ratelimit-limit': '60' })
        .get('/user')
        .matchHeader('authorization', `token ${repeat('j', 40)}`)
        .reply(401, '')
        .intercept('/user', 'get')
        .reply(200)
        .intercept('/', 'get')
        .reply(200);

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

      await middleware.refreshRateLimits();

      expect(errors.join('\n')).not.toContain(FAKE_TOKEN);
      expect(errors.join('\n')).toContain(FAKE_TOKEN.slice(-4));
    });

    test('it should not update limits when "x-ratelimit-remaining" is not on header', async () => {
      scope
        .defaultReplyHeaders({
          'x-ratelimit-reset': `${Math.floor((Date.now() + 60 * 60 * 1000) / 1000)}`
        })
        .get('/')
        .reply(401);

      await request(app).get('/').expect(401);
    });

    test('it should allow users to override authorization header', async () => {
      const token = repeat('i', 40);
      const tokenStr = `token ${token}`;

      scope.get('/').matchHeader('authorization', tokenStr).reply(401).get('/').reply(200);

      await request(app).get('/').set('Authorization', tokenStr).expect(401);
      await request(app).get('/').expect(200);

      await middleware.destroy();
      middleware = new Middleware([FAKE_TOKEN], {
        requestTimeout,
        minRemaining: 0,
        overrideAuthorization: true
      });

      await request(app).get('/').set('Authorization', tokenStr).expect(200);
    });

    test('it should replace base url on response header', async () => {
      const linkStr =
        '<https://api.github.com/repositories/000/tags?page=2>; rel="next", <https://api.github.com/repositories/000/tags?page=10>; rel="last"';

      scope.get('/').reply(200, {}, { link: linkStr });

      await request(app)
        .get('/')
        .expect(({ headers, request }) => {
          expect(headers.link).toEqual(linkStr.replace(/https:\/\/api.github.com\//g, request.url));
        });
    });
  });
});
