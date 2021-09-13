import getPort from 'get-port';
import httpProxy from 'http-proxy';
import { times } from 'lodash';
import { mocked } from 'ts-jest/utils';
import express, { Express } from 'express';
import axios, { AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

import Middleware from './middleware';

jest.mock('http-proxy');

const mokedHttpProxy = mocked(httpProxy, true);

let app: ReturnType<typeof express>;
let localServer: ReturnType<typeof app.listen>;
let localServerPort: number;
let axiosClient: AxiosInstance;

beforeEach(async () => {
  localServerPort = await getPort();

  app = express();

  axiosClient = axios.create({ baseURL: `http://127.0.0.1:${localServerPort}` });

  localServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(localServerPort, () => resolve(s));
  });
});

afterEach(async () => {
  return new Promise((resolve) => localServer.close(resolve));
});

describe('Middleware constructor and methods', () => {
  beforeEach(() => {
    mokedHttpProxy.createProxyServer.mockImplementation((options) => {
      const { createProxyServer } = <typeof httpProxy>jest.requireActual('http-proxy');
      return createProxyServer(options);
    });
  });

  test('it should throw an error if no token is provided', () => {
    expect(() => new Middleware([])).toThrowError();
  });

  test('it should remove/add tokens when requested', () => {
    const token = '1234567890';
    const middleware = new Middleware([token]);

    middleware.removeToken(token);
    expect(middleware.tokens).toHaveLength(0);

    middleware.addToken(token);
    expect(middleware.tokens).toHaveLength(1);
  });

  test('it should create only one client per token', () => {
    expect(new Middleware(times(5, () => '1234567890')).tokens).toHaveLength(1);
  });
});

describe('GitHub API is down or not reachable', () => {
  beforeEach(async () => {
    const randomPort = await getPort();

    mokedHttpProxy.createProxyServer.mockImplementation((options) => {
      const { createProxyServer } = <typeof httpProxy>jest.requireActual('http-proxy');
      return createProxyServer({ ...options, target: `http://127.0.0.1:${randomPort}` });
    });

    const middleware = new Middleware(['1234567890'], { requestInterval: 0 });

    app.get('*', middleware.schedule.bind(middleware));
  });

  test('it should respond with Internal Server Error', async () => {
    return Promise.all(
      times(25, () =>
        axiosClient.get('/').catch((error) => {
          expect(error.response?.status).toBe(600);
          expect(error.response?.data?.message).toMatch(/ECONNREFUSED/gi);
        })
      )
    );
  });
});

describe('GitHub API is online', () => {
  let fakeAPI: Express;
  let fakeAPIPort: number;
  let fakeAPIServer: ReturnType<typeof app.listen>;
  let middleware: Middleware;

  beforeEach(async () => {
    fakeAPIPort = await getPort();

    fakeAPI = express();
    fakeAPI.get('/success', (_, res) => res.status(200).send());
    fakeAPI.get('/redirect', (_, res) => res.redirect(300, '/'));
    fakeAPI.get('/client-error', (_, res) => res.status(400).send());
    fakeAPI.get('/server-error', (_, res) => res.status(500).send());
    fakeAPI.get('/too-long-request', (req, res) =>
      setTimeout(() => res.status(200).send(), parseInt((req.query.delay as string) || '1000', 10))
    );
    fakeAPI.get('/broken-request', (_, res) => setTimeout(() => res.destroy(), 100));
    fakeAPI.get('/drain-ratelimite', (_, res) =>
      setTimeout(
        () =>
          res
            .status(200)
            .set({
              'x-ratelimit-remaining': 0,
              'x-ratelimit-limit': 5000,
              'x-ratelimit-reset': (Date.now() + 2 * 1000) / 1000
            })
            .send(),
        100
      )
    );

    fakeAPIServer = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const s = fakeAPI.listen(fakeAPIPort, () => resolve(s));
    });

    mokedHttpProxy.createProxyServer.mockImplementation((options) => {
      const { createProxyServer } = <typeof httpProxy>jest.requireActual('http-proxy');
      return createProxyServer({ ...options, target: `http://127.0.0.1:${fakeAPIPort}` });
    });

    middleware = new Middleware(['1234567890'], {
      requestTimeout: 500,
      requestInterval: 100
    });

    app.get('*', middleware.schedule.bind(middleware));
  });

  afterEach(async () => {
    await new Promise((resolve) => fakeAPIServer.close(resolve));
  });

  test('it should respond with Service Unavailable if no requests available', async () => {
    middleware.removeToken('1234567890');

    await Promise.all(
      times(25, () =>
        expect(axiosClient.get('/success')).rejects.toHaveProperty('response.status', 503)
      )
    );

    middleware.addToken('1234567890');

    await axiosClient.get('/drain-ratelimite');

    return Promise.all(
      times(25, () =>
        expect(axiosClient.get('/success')).rejects.toHaveProperty('response.status', 503)
      )
    );
  });

  test('it should restore rate limite on reset time', async () => {
    for (let round = 0; round < 25; round++) {
      await axiosClient.get('/drain-ratelimite');
      await expect(axiosClient.get('/success')).rejects.toHaveProperty('response.status', 503);
      await new Promise((resolve) =>
        setTimeout(
          () =>
            expect(axiosClient.get('/success'))
              .resolves.toBeDefined()
              .finally(() => resolve(1)),
          2000
        )
      );
    }
  });

  test('it should respect the interval between the requests', async () => {
    const init = Date.now();

    await Promise.all(
      times(25, (num) => {
        const reqInit = Date.now();
        return expect(axiosClient.get('/success'))
          .resolves.toBeDefined()
          .finally(() => expect(Date.now() - reqInit).toBeGreaterThanOrEqual(num > 1 ? 100 : 0));
      })
    );

    expect(Date.now() - init).toBeGreaterThan(25 * 100);
  });

  test('it should forward responses received from GitHub', async () => {
    await Promise.all(
      times(25, () =>
        Promise.all([
          axiosClient.get('/success').then(({ status }) => expect(status).toEqual(200)),
          axiosClient
            .get('/redirect', { maxRedirects: 0 })
            .catch(({ response }) => expect(response.status).toEqual(300)),
          axiosClient
            .get('/client-error')
            .catch(({ response }) => expect(response.status).toEqual(400)),
          axiosClient
            .get('/server-error')
            .catch(({ response }) => expect(response.status).toEqual(500))
        ])
      )
    );
  });

  test('it should interrupt long requests', () => {
    return Promise.all(
      times(25, () =>
        expect(axiosClient.get('/too-long-request')).rejects.toHaveProperty('response.status', 600)
      )
    );
  });

  test('it should respond to broken connections', () => {
    return Promise.all(
      times(25, () =>
        expect(axiosClient.get('/broken-request')).rejects.toHaveProperty('response.status', 600)
      )
    );
  });

  test('it should not break when client disconnect', () => {
    return Promise.all(
      times(25, () => {
        const source = axios.CancelToken.source();
        setTimeout(() => source.cancel('Operation canceled by the user.'), 250);
        return expect(
          axiosClient.get('/too-long-request', { cancelToken: source.token })
        ).rejects.not.toBeNull();
      })
    );
  });
});
