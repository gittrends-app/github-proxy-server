import { afterAll, afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import axios, { AxiosInstance } from 'axios';
import express, { Express } from 'express';
import getPort from 'get-port';
import { Server } from 'http';
import { address } from 'ip';
import { range, repeat, times } from 'lodash';
import nock from 'nock';

import Middleware, { ProxyRouterResponse } from './router';

let app: Express;
let server: Server;
let axiosClient: AxiosInstance;

const localServerHost: string = address();
const FAKE_TOKEN = repeat('t', 40);

async function waitPromise(milisseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milisseconds));
}

describe('Middleware constructor and methods', () => {
  test('it should throw an error if no token is provided', () => {
    expect(() => new Middleware([])).toThrowError();
  });

  test('it should remove/add tokens when requested', () => {
    const middleware = new Middleware([FAKE_TOKEN]);
    expect(middleware.tokens).toHaveLength(1);

    middleware.removeToken(FAKE_TOKEN);
    expect(middleware.tokens).toHaveLength(0);

    middleware.addToken(FAKE_TOKEN);
    expect(middleware.tokens).toHaveLength(1);
  });

  test('it should create only one client per token', () => {
    const middleware = new Middleware(times(2, () => FAKE_TOKEN));
    expect(middleware.tokens).toHaveLength(1);
  });
});

describe('Middleware core', () => {
  let scope: nock.Scope;
  let middleware: Middleware;
  let proxyServerPort: number;

  const requestTimeout = 1000;
  const requestInterval = 250;

  beforeEach(async () => {
    if (!nock.isActive()) nock.activate();
    scope = nock('https://api.github.com', { allowUnmocked: false }).persist();

    app = express();

    middleware = new Middleware([FAKE_TOKEN], {
      requestInterval,
      requestTimeout,
      minRemaining: 0,
      overrideAuthorization: false
    });

    app.get('*', (req, res) => middleware.schedule(req, res));

    server = app.listen({ host: localServerHost, port: (proxyServerPort = await getPort()) });
    axiosClient = axios.create({ baseURL: `http://${localServerHost}:${proxyServerPort}` });
  });

  afterEach(async () => {
    nock.cleanAll();
    nock.restore();

    middleware.destroy();

    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
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

    test(`it should respond with Proxy Server Error (${ProxyRouterResponse.PROXY_ERROR})`, async () => {
      return axiosClient.get('/').catch((error) => {
        expect(error.response?.status).toBe(ProxyRouterResponse.PROXY_ERROR);
      });
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

    test(`it should respond with ${ProxyRouterResponse.NO_REQUESTS} if no requests available`, async () => {
      const waitInterval = 500;

      scope
        .get('/reset')
        .reply(200, '', {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': `${Math.floor((Date.now() + waitInterval) / 1000)}`
        })
        .get('/')
        .reply(200);

      await expect(axiosClient.get('/reset')).resolves.toBeDefined();

      await axiosClient
        .get('/reset')
        .catch(({ response }) => expect(response.status).toBe(ProxyRouterResponse.NO_REQUESTS));

      await waitPromise(waitInterval);

      middleware.removeToken(FAKE_TOKEN);
      return axiosClient
        .get('/')
        .catch(({ response }) => expect(response.status).toBe(ProxyRouterResponse.NO_REQUESTS));
    });

    test('it should restore rate limite on reset time', async () => {
      const waitInterval = 1000;

      scope
        .get('/reset')
        .reply(200, '', {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': `${Math.trunc((Date.now() + waitInterval) / 1000)}`
        })
        .get('/')
        .reply(200);

      for (let i = 0; i < 2; i++) {
        await expect(axiosClient.get('/reset')).resolves.toBeDefined();
        await Promise.all([
          expect(axiosClient.get('/')).rejects.toBeDefined(),
          waitPromise(waitInterval)
        ]);
        await expect(axiosClient.get('/')).resolves.toBeDefined();
      }
    });

    test('it should respect the interval between the requests', async () => {
      scope.get('/').delay(100).reply(200);

      const promises: Promise<number>[] = [];
      range(5).forEach(() => promises.push(axiosClient.get('/').then(() => Date.now())));

      const results = await Promise.all(promises);
      expect(results).toBeDefined();

      for (let index = 1; index < results.length; index++)
        expect(results[index]).toBeGreaterThan(results[index - 1] + requestInterval);
    });

    test('it should forward responses received from GitHub', async () => {
      scope.get('/').reply(200);
      await axiosClient.get('/').then(({ status }) => expect(status).toEqual(200));

      scope.get('/300').reply(300);
      await axiosClient
        .get('/300', { maxRedirects: 0 })
        .catch(({ response }) => expect(response.status).toEqual(300));

      scope.get('/400').reply(400);
      await axiosClient.get('/400').catch(({ response }) => expect(response.status).toEqual(400));

      scope.get('/500').reply(500);
      await axiosClient.get('/500').catch(({ response }) => expect(response.status).toEqual(500));
    });

    test('it should interrupt long requests', async () => {
      scope
        .get('/')
        .delay(requestTimeout * 2)
        .reply(200);

      return axiosClient
        .get('/')
        .catch(({ response }) => expect(response.status).toBe(ProxyRouterResponse.PROXY_ERROR));
    });

    test('it should respond to broken connections', async () => {
      scope.get('/').delay(100).replyWithError(new Error('Server Error'));

      return axiosClient
        .get('/')
        .catch(({ response }) => expect(response.status).toBe(ProxyRouterResponse.PROXY_ERROR));
    });

    test('it should not break proxy when client disconnect', async () => {
      scope.get('/').delay(500).reply(200);

      const source = axios.CancelToken.source();
      setTimeout(() => source.cancel('Operation canceled by the user.'), 100);
      await axiosClient
        .get('/', { cancelToken: source.token })
        .catch((err) => expect(err).toBeDefined());

      return expect(axiosClient.get('/')).resolves.toBeDefined();
    });

    test('it should not wait when client disconnected', async () => {
      scope.get('/').delay(250).reply(200).get('/no').reply(200);

      const promises: Promise<number>[] = [];
      const startedAt = Date.now();

      promises.push(axiosClient.get('/').then(() => Date.now()));

      const source = axios.CancelToken.source();
      source.cancel('Operation canceled by the user.');
      expect(axiosClient.get('/', { cancelToken: source.token })).rejects.toBeDefined();

      promises.push(axiosClient.get('/no').then(() => Date.now()));

      const [first, second] = await Promise.all(promises);

      expect(first).toBeGreaterThanOrEqual(startedAt + 250);
      expect(second).toBeGreaterThanOrEqual(first + requestInterval);
      expect(second).toBeLessThan(first + requestInterval + 250);
    });

    test('it should balance the use of the tokens', async () => {
      scope.get('/').delay(250).reply(200);

      const tokens = times<string>(5, (n) => `${n}**${FAKE_TOKEN}`)
        .concat(FAKE_TOKEN)
        .reduce((memo: Record<string, number>, token) => ({ ...memo, [token]: 0 }), {});

      Object.keys(tokens).forEach((token) => middleware.addToken(token));

      middleware.on('data', (data) => {
        const token = Object.keys(tokens).find((token) => token.startsWith(data.token));
        if (token) tokens[token] += 1;
      });

      await Promise.all(times(10, () => axiosClient.get('/')));

      Object.values(tokens).forEach((calls) => expect(calls).toBeGreaterThan(0));
    });

    test('it should not forward ratelimit and scope information', async () => {
      scope.get('/').delay(250).reply(200);

      return axiosClient.get('/').then(({ headers }) => {
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

      await expect(axiosClient.get('/')).resolves.toBeDefined();
      await expect(axiosClient.get('/user')).resolves.toBeDefined();

      middleware.removeToken(FAKE_TOKEN);
      middleware.addToken(repeat('i', 40));

      await expect(axiosClient.get('/user')).rejects.toBeDefined();
      await expect(axiosClient.get('/')).rejects.toBeDefined();

      middleware.removeToken(repeat('i', 40));
      middleware.addToken(repeat('j', 40));

      await expect(axiosClient.get('/user')).rejects.toBeDefined();
      await expect(axiosClient.get('/')).resolves.toBeDefined();
    });

    test('it should not update limits when "x-ratelimit-remaining" is not on header', async () => {
      scope
        .defaultReplyHeaders({
          'x-ratelimit-reset': `${Math.floor((Date.now() + 60 * 60 * 1000) / 1000)}`
        })
        .get('/')
        .reply(401);

      await expect(axiosClient.get('/')).rejects.toHaveProperty('response.status', 401);
      await expect(axiosClient.get('/')).rejects.toHaveProperty('response.status', 401);
    });

    test('it should allow users to override authorization header', async () => {
      const token = repeat('i', 40);
      const tokenStr = `token ${token}`;

      scope.get('/').matchHeader('authorization', tokenStr).reply(401).get('/').reply(200);

      await expect(
        axiosClient.get('/', { headers: { authorization: tokenStr } })
      ).rejects.toHaveProperty('response.status', 401);
      await expect(axiosClient.get('/')).resolves.toBeDefined();

      middleware.destroy();
      middleware = new Middleware([FAKE_TOKEN], {
        requestInterval,
        requestTimeout,
        minRemaining: 0,
        overrideAuthorization: true
      });

      await expect(
        axiosClient.get('/', { headers: { authorization: tokenStr } })
      ).resolves.toBeDefined();
    });

    test('it should replace base url on response header', async () => {
      const linkStr =
        '<https://api.github.com/repositories/000/tags?page=2>; rel="next", <https://api.github.com/repositories/000/tags?page=10>; rel="last"';

      const expectedLinkStr = linkStr.replace(
        new RegExp('https://api.github.com', 'g'),
        `http://${localServerHost}:${proxyServerPort}`
      );

      scope.get('/').reply(200, {}, { link: linkStr });

      await expect(axiosClient.get('/')).resolves.toHaveProperty('headers.link', expectedLinkStr);
    });
  });
});
