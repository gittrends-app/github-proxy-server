import { afterAll, afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import express, { Express } from 'express';
import { StatusCodes } from 'http-status-codes';
import repeat from 'lodash/repeat.js';
import times from 'lodash/times.js';
import nock from 'nock';
import request from 'supertest';

import Middleware from './router';

let app: Express;

const FAKE_TOKEN = repeat('t', 40);

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

  const requestTimeout = 1000;

  beforeEach(async () => {
    if (!nock.isActive()) nock.activate();

    scope = nock('https://api.github.com', { allowUnmocked: false }).persist();

    app = express();

    middleware = new Middleware([FAKE_TOKEN], {
      requestTimeout,
      minRemaining: 0,
      overrideAuthorization: false
    });

    app.get('*', (req, res) => middleware.schedule(req, res));
  });

  afterEach(async () => {
    nock.cleanAll();
    nock.restore();

    middleware.destroy();
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

    test.skip(`it should wait if no requests available`, async () => {
      const waitInterval = 500;

      scope
        .get('/reset')
        .reply(StatusCodes.OK, '', {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-limit': '5000',
          'x-ratelimit-reset': `${Math.floor((Date.now() + waitInterval) / 1000)}`
        })
        .get('/')
        .reply(StatusCodes.OK);

      await request(app).get('/reset').expect(StatusCodes.OK);
      await request(app).get('/').expect(StatusCodes.OK);
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
      scope.get('/').delay(100).replyWithError(new Error('Server Error'));

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

      const tokens = times<string>(5, (n) => `${FAKE_TOKEN}**${n}`)
        .concat(FAKE_TOKEN)
        .reduce((memo: Record<string, number>, token) => ({ ...memo, [token]: 0 }), {});

      Object.keys(tokens).forEach((token) => middleware.addToken(token));

      middleware.on('log', (data) => {
        const token = Object.keys(tokens).find((token) => token.endsWith(data.token));
        if (token) tokens[token] += 1;
      });

      await Promise.all(times(100, () => request(app).get('/')));

      Object.values(tokens).forEach((calls) => expect(calls).toBeGreaterThan(0));

      Object.keys(tokens).forEach((token) => middleware.removeToken(token));
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

      middleware.removeToken(FAKE_TOKEN);
      middleware.addToken(repeat('i', 40));

      await request(app).get('/user').expect(401);

      middleware.removeToken(repeat('i', 40));
      middleware.addToken(repeat('j', 40));

      await request(app).get('/user').expect(401);
      await request(app).get('/').expect(200);
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

      middleware.destroy();
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
          expect(headers.link).toEqual(
            linkStr.replace(new RegExp('https://api.github.com/', 'g'), request.url)
          );
        });
    });
  });
});
