import { writeFileSync } from 'node:fs';

import { StatusCodes } from 'http-status-codes';
import repeat from 'lodash/repeat.js';
import times from 'lodash/times.js';
import nock from 'nock';
import request from 'supertest';
import { withFile } from 'tmp-promise';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { ProxyRouterResponse } from './router.js';
import { type CliOpts, createProxyServer, parseTokens, readTokensFile } from './server.js';

describe('Test tokens file parser', () => {
  test('it should check tokens length', () => {
    expect(() => parseTokens(times(15, () => 'a').join(''))).toThrowError();
    expect(() => parseTokens(times(40, () => 'a').join(''))).not.toThrowError();
  });

  test('it should skip lines starting with # (comments)', () => {
    expect(() => parseTokens('# this is a comment')).not.toThrowError();
    expect(parseTokens('# this is a comment')).toHaveLength(0);
  });

  test('it should support tokens with owner (<owner>:<token>)', () => {
    const token = times(40, () => 'a').join('');
    expect(parseTokens(`gittrends-app:${token}`)).toEqual([token]);
    expect(
      parseTokens(
        times(2, (number) => `gittrends-app-${number}:${times(40, () => number).join('')}`).join(
          '\n'
        )
      )
    ).toHaveLength(2);
  });

  test('it should remove duplicated tokens', () => {
    const token = times(40, () => 'a').join('');
    expect(parseTokens(times(2, () => `gittrends-app:${token}`).join('\n'))).toEqual([token]);
  });

  test('it should read tokens from a file', async () => {
    await withFile(async ({ path }) => {
      const token = repeat('0', 40);
      writeFileSync(path, token);
      expect(readTokensFile(path)).toEqual([token]);
    });
  });

  test('it should throw an error if a file not exists', () => {
    expect(() => readTokensFile('./not-exists.txt')).toThrowError();
  });
});

describe('Test create proxy server', () => {
  let params: CliOpts;

  beforeAll(() => {
    nock('https://api.github.com', { allowUnmocked: false })
      .get('/rate_limit')
      .matchHeader('authorization', `token ${repeat('i', 40)}`)
      .reply(401)
      .get('/rate_limit')
      .reply(StatusCodes.OK, {
        resources: {
          core: { limit: 5000, remaining: 5000, reset: Date.now() + 60 * 60 },
          search: { limit: 30, remaining: 30, reset: Date.now() + 60 * 60 },
          code_search: { limit: 10, remaining: 10, reset: Date.now() + 60 * 60 },
          graphql: { limit: 5000, remaining: 5000, reset: Date.now() + 60 * 60 }
        }
      })
      .persist()
      .get('/user')
      .matchHeader('authorization', `token ${repeat('i', 40)}`)
      .reply(StatusCodes.UNAUTHORIZED)
      .post('/graphql')
      .reply(200)
      .intercept(/.*/, 'get')
      .reply(200)
      .intercept(/.*/, 'post')
      .reply(600)
      .intercept(/.*/, 'put')
      .reply(600)
      .intercept(/.*/, 'delete')
      .reply(600);
  });

  beforeEach(async () => {
    params = {
      tokens: [repeat('0', 40)],
      minRemaining: 0,
      requestTimeout: 500,
      silent: true
    };
  });

  test('it should emit an error if no valid tokens are provided', async () => {
    params.tokens = ['invalid'];
    expect(() => createProxyServer(params)).toThrowError();
  });

  test('it should accept GET requests', async () => {
    const app = createProxyServer(params);
    await request(app).get('/').expect(StatusCodes.OK);
    await request(app).post('/').expect(ProxyRouterResponse.PROXY_ERROR);
    await request(app).patch('/').expect(ProxyRouterResponse.PROXY_ERROR);
    await request(app).put('/').expect(ProxyRouterResponse.PROXY_ERROR);
    await request(app).delete('/').expect(ProxyRouterResponse.PROXY_ERROR);
  });

  test('it should accept POSTs only to /graphql', async () => {
    const app = createProxyServer(params);
    await request(app).post('/graphql').expect(StatusCodes.OK);
  });

  test('it should emit logs when enabled', async () => {
    const app = createProxyServer({ ...params, silent: false });

    const logs: string[] = [];
    app.on('log', (data) => logs.push(data.toString()));

    await request(app).get('/').expect(StatusCodes.OK);
    expect(logs.length).toBeGreaterThan(0);

    const currentLength = logs.length;
    await request(app).get('/').expect(StatusCodes.OK);
    expect(logs.length).toBe(currentLength + 1);
  });

  test('it should not emit logs when disabled', async () => {
    const app = createProxyServer({ ...params, silent: true });

    const logs: string[] = [];
    app.on('log', (data) => logs.push(data.toString()));

    await request(app).get('/').expect(StatusCodes.OK);
    expect(logs.length).toBe(0);
  });

  test('it should emit an error when invalid token are detected', async () => {
    const app = createProxyServer({ ...params, tokens: [repeat('i', 40)] });

    const errors: string[] = [];
    app.on('error', (data) => errors.push(data.toString()));

    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(errors.length).toBeGreaterThan(0);
  });

  test('it should not pass authorization tokens by default', async () => {
    const app = createProxyServer(params);

    await request(app)
      .get('/user')
      .set('Authorization', `token ${repeat('i', 40)}`)
      .expect(StatusCodes.OK);
    await request(app).get('/user').expect(StatusCodes.OK);
  });

  test('it should allow users to user own authorization tokens', async () => {
    const app = createProxyServer({ ...params, overrideAuthorization: false });

    await request(app)
      .get('/user')
      .set('Authorization', `token ${repeat('i', 40)}`)
      .expect(StatusCodes.UNAUTHORIZED);

    await request(app).get('/user').expect(StatusCodes.OK);
  });
});

describe('Test proxy authentication', () => {
  let params: CliOpts;

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
      .persist()
      .intercept(/.*/, 'get')
      .reply(200)
      .post('/graphql')
      .reply(200);
  });

  beforeEach(() => {
    params = {
      tokens: [repeat('0', 40)],
      minRemaining: 0,
      requestTimeout: 500,
      silent: true,
      auth: {
        username: 'testuser',
        password: 'testpass'
      }
    };
  });

  test('it should require authentication when auth is configured', async () => {
    const app = createProxyServer(params);
    await request(app).get('/').expect(StatusCodes.UNAUTHORIZED);
    await request(app).post('/graphql').expect(StatusCodes.UNAUTHORIZED);
  });

  test('it should accept valid credentials', async () => {
    const app = createProxyServer(params);
    await request(app).get('/').auth('testuser', 'testpass').expect(StatusCodes.OK);
  });

  test('it should reject invalid username', async () => {
    const app = createProxyServer(params);
    await request(app).get('/').auth('wronguser', 'testpass').expect(StatusCodes.UNAUTHORIZED);
  });

  test('it should reject invalid password', async () => {
    const app = createProxyServer(params);
    await request(app).get('/').auth('testuser', 'wrongpass').expect(StatusCodes.UNAUTHORIZED);
  });

  test('it should return WWW-Authenticate header on unauthorized', async () => {
    const app = createProxyServer(params);
    const response = await request(app).get('/').expect(StatusCodes.UNAUTHORIZED);
    expect(response.headers['www-authenticate']).toBe('Basic realm="GitHub Proxy Server"');
  });

  test('it should allow access to /status without authentication', async () => {
    const app = createProxyServer({ ...params, statusMonitor: true });
    // /status endpoint redirects to /status/ux - follow the redirect
    const response = await request(app).get('/status').redirects(1);
    expect(response.status).toBe(StatusCodes.OK);
  });

  test('it should work with POST /graphql when authenticated', async () => {
    const app = createProxyServer(params);
    await request(app).post('/graphql').auth('testuser', 'testpass').expect(StatusCodes.OK);
  });

  test('it should not require auth when auth option is not provided', async () => {
    const app = createProxyServer({ ...params, auth: undefined });
    await request(app).get('/').expect(StatusCodes.OK);
  });
});
