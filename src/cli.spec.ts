import { afterEach, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import axios, { AxiosInstance } from 'axios';
import { exec } from 'child_process';
import { FastifyInstance } from 'fastify';
import { writeFileSync } from 'fs';
import getPort from 'get-port';
import { address } from 'ip';
import { repeat, times } from 'lodash';
import nock from 'nock';
import { withFile } from 'tmp-promise';

import {
  APIVersion,
  CliOpts,
  ProxyLogTransform,
  createProxyServer,
  parseTokens,
  readTokensFile
} from './cli';

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
    let port: number;
    let fastify: FastifyInstance;
    let client: AxiosInstance;

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
      port = await getPort();

      params = {
        tokens: [repeat('0', 40)],
        minRemaining: 0,
        requestInterval: 100,
        requestTimeout: 500,
        silent: true
      };

      client = axios.create({ baseURL: `http://${address()}:${port}` });
    });

    afterEach(async () => {
      if (fastify) await fastify.close();
    });

    async function createLocalProxyServer(args: CliOpts) {
      const app = createProxyServer(args);
      await app.listen(port, address());
      return app;
    }

    test('it should throw an error if no valid tokens are provided', async () => {
      params.tokens = ['invalid'];
      expect(() => createProxyServer(params)).toThrowError();
    });

    test(`it should accept GET requests`, async () => {
      fastify = await createLocalProxyServer(params);
      await expect(client.get('/')).resolves.toBeDefined();
      await expect(client.post('/')).rejects.toThrowError();
      await expect(client.put('/')).rejects.toThrowError();
      await expect(client.delete('/')).rejects.toThrowError();
    });

    test(`it should accept POSTs only to /graphql`, async () => {
      fastify = await createLocalProxyServer(params);
      await expect(client.post('/graphql')).resolves.toBeDefined();
    });

    test(`it should log the requests when enabled`, async () => {
      fastify = await createLocalProxyServer({ ...params, silent: false });

      const logs: string[] = [];
      fastify.server.on('log', (data) => logs.push(data.toString()));

      await expect(client.get('/')).resolves.toBeDefined();
      expect(logs.length).toBeGreaterThan(0);

      const currentLength = logs.length;
      await expect(client.get('/')).resolves.toBeDefined();
      expect(logs.length).toBe(currentLength + 1);
    });

    test(`it should disable logs when disabled`, async () => {
      fastify = await createLocalProxyServer({ ...params, silent: true });

      const logs: string[] = [];
      fastify.server.on('log', (data) => logs.push(data.toString()));

      await expect(client.get('/')).resolves.toBeDefined();
      expect(logs.length).toBe(0);
    });

    test('it should warn when invalid token are detected', async () => {
      fastify = await createLocalProxyServer({ ...params, tokens: [repeat('i', 40)] });

      const warns: string[] = [];
      fastify.server.on('warn', (data) => warns.push(data.toString()));

      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(warns.length).toBe(1);
    });

    test('it should not pass authorization tokens by default', async () => {
      fastify = await createLocalProxyServer(params);

      await expect(
        client.get('/user', {
          validateStatus: (code) => code === 200,
          headers: { Authorization: `token ${repeat('i', 40)}` }
        })
      ).resolves.toBeDefined();

      await expect(client.get('/user')).resolves.toBeDefined();
    });

    test('it should allow users to user own authorization tokens', async () => {
      fastify = await createLocalProxyServer({ ...params, overrideAuthorization: false });

      await expect(
        client.get('/user', {
          validateStatus: (code) => code === 200,
          headers: { Authorization: `token ${repeat('i', 40)}` }
        })
      ).rejects.toThrowError();

      await expect(client.get('/user')).resolves.toBeDefined();
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
