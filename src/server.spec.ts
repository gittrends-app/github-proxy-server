import { beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { exec } from 'child_process';
import { writeFileSync } from 'fs';
import { StatusCodes } from 'http-status-codes';
import repeat from 'lodash/repeat.js';
import times from 'lodash/times.js';
import nock from 'nock';
import request from 'supertest';
import { withFile } from 'tmp-promise';

import { ProxyRouterResponse } from './router.js';
import {
  APIVersion,
  CliOpts,
  ProxyLogTransform,
  createProxyServer,
  parseTokens,
  readTokensFile
} from './server.js';

type CliCmdResult = {
  code: number;
  error?: Error | null;
  stdout?: string | null;
  stderr?: string | null;
};

async function cli(args: string[], cwd: string): Promise<CliCmdResult> {
  return new Promise((resolve) => {
    exec(
      `npm run dev-no-reload --no-status-monitor ${args.join(' ')}`,
      { cwd },
      (error, stdout, stderr) => resolve({ code: error?.code ?? 0, error, stdout, stderr })
    );
  });
}

describe('Test cli utils', () => {
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
      expect(parseTokens('gittrends-app:' + token)).toEqual([token]);
      expect(
        parseTokens(
          times(2, (number) => `gittrends-app-${number}:` + times(40, () => number).join('')).join(
            '\n'
          )
        )
      ).toHaveLength(2);
    });

    test('it should remove duplicated tokens', () => {
      const token = times(40, () => 'a').join('');
      expect(parseTokens(times(2, () => 'gittrends-app:' + token).join('\n'))).toEqual([token]);
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

  describe('Test log transform', () => {
    const sample = {
      token: '-',
      pending: 0,
      remaining: 0,
      reset: Date.now() / 1000,
      status: 0,
      duration: 0
    };

    test('it should push a header in the first request', async () => {
      const logger = new ProxyLogTransform(APIVersion.REST);

      const chunks: string[] = [];
      logger.on('data', (chunk: string) => chunks.push(chunk));

      logger.write(sample);
      expect(chunks).toHaveLength(2);

      logger.write(sample);
      expect(chunks).toHaveLength(3);

      await new Promise((resolve) => logger.end(resolve));
    });
  });

  describe(`Test create proxy server`, () => {
    let params: CliOpts;

    beforeAll(() => {
      nock('https://api.github.com', { allowUnmocked: false })
        .persist()
        .get('/user')
        .matchHeader('authorization', `token ${repeat('i', 40)}`)
        .reply(401, 'invalid')
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
        requestInterval: 100,
        requestTimeout: 500,
        silent: true
      };
    });

    test('it should throw an error if no valid tokens are provided', async () => {
      params.tokens = ['invalid'];
      expect(() => createProxyServer(params)).toThrowError();
    });

    test(`it should accept GET requests`, async () => {
      const app = createProxyServer(params);
      await request(app).get('/').expect(StatusCodes.OK);
      await request(app).post('/').expect(ProxyRouterResponse.PROXY_ERROR);
      await request(app).patch('/').expect(ProxyRouterResponse.PROXY_ERROR);
      await request(app).put('/').expect(ProxyRouterResponse.PROXY_ERROR);
      await request(app).delete('/').expect(ProxyRouterResponse.PROXY_ERROR);
    });

    test(`it should accept POSTs only to /graphql`, async () => {
      const app = createProxyServer(params);
      await request(app).post('/graphql').expect(StatusCodes.OK);
    });

    test(`it should log the requests when enabled`, async () => {
      const app = createProxyServer({ ...params, silent: false });

      const logs: string[] = [];
      app.on('log', (data) => logs.push(data.toString()));

      await request(app).get('/').expect(StatusCodes.OK);
      expect(logs.length).toBeGreaterThan(0);

      const currentLength = logs.length;
      await request(app).get('/').expect(StatusCodes.OK);
      expect(logs.length).toBe(currentLength + 1);
    });

    test(`it should disable logs when disabled`, async () => {
      const app = createProxyServer({ ...params, silent: true });

      const logs: string[] = [];
      app.on('log', (data) => logs.push(data.toString()));

      await request(app).get('/').expect(StatusCodes.OK);
      expect(logs.length).toBe(0);
    });

    test('it should warn when invalid token are detected', async () => {
      const app = createProxyServer({ ...params, tokens: [repeat('i', 40)] });

      const warns: string[] = [];
      app.on('warn', (data) => warns.push(data.toString()));

      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(warns.length).toBe(1);
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
});

describe('Test cli app', () => {
  test('it should thrown an error if token/tokens is not provided', async () => {
    const result = await cli([], '.');
    expect(result.code).toEqual(1);
  });

  test('it should thrown an error if invalid tokens are provided', async () => {
    const result = await cli(['-t', 'invalid'], '.');
    expect(result.code).toEqual(1);
  });
});
