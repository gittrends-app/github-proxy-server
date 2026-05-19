/* Author: Hudson S. Borges */

import { IncomingMessage, ServerResponse } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

import { StatusCodes } from 'http-status-codes';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { ProxyClient } from './proxy-client';

describe('ProxyClient', () => {
  let client: ProxyClient;
  let scope: nock.Scope;

  const TARGET = 'https://api.example.com';
  const TIMEOUT = 5000;

  beforeAll(() => {
    nock.disableNetConnect();
  });

  afterAll(() => {
    nock.cleanAll();
    nock.restore();
    nock.enableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
  });

  describe('constructor', () => {
    test('should create client with basic options', () => {
      const proxyClient = new ProxyClient({
        target: TARGET,
        timeout: TIMEOUT
      });

      expect(proxyClient).toBeInstanceOf(ProxyClient);
    });

    test('should create client with custom agent', () => {
      const agent = new HttpsAgent({ keepAlive: true });
      const proxyClient = new ProxyClient({
        target: TARGET,
        timeout: TIMEOUT,
        agent
      });

      expect(proxyClient).toBeInstanceOf(ProxyClient);
    });
  });

  describe('proxy method', () => {
    beforeEach(() => {
      client = new ProxyClient({
        target: TARGET,
        timeout: TIMEOUT
      });
      scope = nock(TARGET);
    });

    test('should proxy GET request successfully', async () => {
      scope.get('/test').reply(StatusCodes.OK, { success: true });

      const { req, res } = createMockRequestResponse('GET', '/test');

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.OK);
      expect(res.writableFinished).toBe(true);
    });

    test('should proxy POST request with body', async () => {
      const requestBody = { data: 'test' };

      scope.post('/test', requestBody).reply(StatusCodes.CREATED, { id: 123 });

      const { req, res } = createMockRequestResponse('POST', '/test', requestBody);

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.CREATED);
      expect(res.writableFinished).toBe(true);
    });

    test('should copy request headers', async () => {
      let receivedHeaders: Record<string, string> = {};

      scope.get('/test').reply(function () {
        receivedHeaders = this.req.headers as Record<string, string>;
        return [StatusCodes.OK, { success: true }];
      });

      const { req, res } = createMockRequestResponse('GET', '/test', undefined, {
        'user-agent': 'test-agent',
        'x-custom-header': 'custom-value'
      });

      await client.proxy(req, res);

      expect(receivedHeaders['user-agent']).toBe('test-agent');
      expect(receivedHeaders['x-custom-header']).toBe('custom-value');
    });

    test('should add x-forwarded headers', async () => {
      let receivedHeaders: Record<string, string> = {};

      scope.get('/test').reply(function () {
        receivedHeaders = this.req.headers as Record<string, string>;
        return [StatusCodes.OK, { success: true }];
      });

      const { req, res } = createMockRequestResponse('GET', '/test');

      await client.proxy(req, res);

      expect(receivedHeaders['x-forwarded-for']).toBeDefined();
      expect(receivedHeaders['x-forwarded-proto']).toBeDefined();
      expect(receivedHeaders['x-forwarded-host']).toBe('localhost:3000');
    });

    test('should modify headers via modifyHeaders callback', async () => {
      let receivedHeaders: Record<string, string> = {};

      scope.get('/test').reply(function () {
        receivedHeaders = this.req.headers as Record<string, string>;
        return [StatusCodes.OK, { success: true }];
      });

      const { req, res } = createMockRequestResponse('GET', '/test');

      await client.proxy(req, res, {
        modifyHeaders: (headers) => {
          headers.authorization = 'Bearer test-token';
          return headers;
        }
      });

      expect(receivedHeaders.authorization).toBe('Bearer test-token');
    });

    test('should call onResponse callback', async () => {
      scope.get('/test').reply(StatusCodes.OK, { success: true });

      const { req, res } = createMockRequestResponse('GET', '/test');

      const onResponse = vi.fn();

      await client.proxy(req, res, { onResponse });

      expect(onResponse).toHaveBeenCalledOnce();
      expect(onResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          status: StatusCodes.OK,
          statusText: expect.any(String),
          headers: expect.any(Object)
        })
      );
    });

    test('should allow header manipulation in onResponse', async () => {
      scope.get('/test').reply(StatusCodes.OK, { success: true }, { 'x-rate-limit': '100' });

      const { req, res } = createMockRequestResponse('GET', '/test');

      await client.proxy(req, res, {
        onResponse: async (data) => {
          // Remove rate limit header
          delete data.headers['x-rate-limit'];
        }
      });

      // The header should be removed before copying to response
      expect(res.getHeader('x-rate-limit')).toBeUndefined();
    });

    test('should copy response headers', async () => {
      scope.get('/test').reply(
        StatusCodes.OK,
        { success: true },
        {
          'content-type': 'application/json',
          'x-custom-header': 'custom-value'
        }
      );

      const { req, res } = createMockRequestResponse('GET', '/test');

      await client.proxy(req, res);

      expect(res.getHeader('content-type')).toBe('application/json');
      expect(res.getHeader('x-custom-header')).toBe('custom-value');
    });

    test('should handle empty response body', async () => {
      scope.get('/test').reply(StatusCodes.NO_CONTENT);

      const { req, res } = createMockRequestResponse('GET', '/test');

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.NO_CONTENT);
      expect(res.writableFinished).toBe(true);
    });

    test('should handle large response bodies with streaming', async () => {
      const largeBody = 'x'.repeat(1024 * 1024); // 1MB
      scope.get('/large').reply(StatusCodes.OK, largeBody);

      const { req, res } = createMockRequestResponse('GET', '/large');

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.OK);
      expect(res.writableFinished).toBe(true);
    });

    test('should throw ETIMEDOUT on timeout', async () => {
      const shortTimeout = 100;
      const timeoutClient = new ProxyClient({
        target: TARGET,
        timeout: shortTimeout
      });

      scope
        .get('/slow')
        .delay(shortTimeout * 2)
        .reply(StatusCodes.OK);

      const { req, res } = createMockRequestResponse('GET', '/slow');

      await expect(timeoutClient.proxy(req, res)).rejects.toMatchObject({
        code: 'ETIMEDOUT'
      });
    });

    test('should handle network errors', async () => {
      scope.get('/error').replyWithError(new Error('Network error'));

      const { req, res } = createMockRequestResponse('GET', '/error');

      await expect(client.proxy(req, res)).rejects.toThrow('Network error');
    });

    test('should handle HTTP error responses', async () => {
      scope.get('/not-found').reply(StatusCodes.NOT_FOUND, { error: 'Not Found' });

      const { req, res } = createMockRequestResponse('GET', '/not-found');

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.NOT_FOUND);
      expect(res.writableFinished).toBe(true);
    });

    test('should handle redirect responses with redirect: manual', async () => {
      scope.get('/redirect').reply(StatusCodes.MOVED_PERMANENTLY, undefined, {
        location: 'https://api.example.com/new-location'
      });

      const { req, res } = createMockRequestResponse('GET', '/redirect');

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.MOVED_PERMANENTLY);
      expect(res.getHeader('location')).toBe('https://api.example.com/new-location');
    });

    test('should handle array headers', async () => {
      scope.get('/test').reply(StatusCodes.OK, { success: true });

      const { req, res } = createMockRequestResponse('GET', '/test', undefined, {
        accept: ['application/json', 'text/html']
      });

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.OK);
    });

    test('should remove host header to avoid conflicts', async () => {
      let receivedHeaders: Record<string, string> = {};

      scope.get('/test').reply(function () {
        receivedHeaders = this.req.headers as Record<string, string>;
        return [StatusCodes.OK, { success: true }];
      });

      const { req, res } = createMockRequestResponse('GET', '/test', undefined, {
        host: 'original-host.com'
      });

      await client.proxy(req, res);

      // Host header should not be forwarded (or it should be the target host)
      expect(receivedHeaders.host).not.toBe('original-host.com');
    });

    test('should handle PUT requests', async () => {
      const requestBody = { updated: true };

      scope.put('/resource/123', requestBody).reply(StatusCodes.OK, { success: true });

      const { req, res } = createMockRequestResponse('PUT', '/resource/123', requestBody);

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.OK);
      expect(res.writableFinished).toBe(true);
    });

    test('should handle DELETE requests', async () => {
      scope.delete('/resource/123').reply(StatusCodes.NO_CONTENT);

      const { req, res } = createMockRequestResponse('DELETE', '/resource/123');

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.NO_CONTENT);
      expect(res.writableFinished).toBe(true);
    });

    test('should handle PATCH requests', async () => {
      const requestBody = { field: 'new-value' };

      scope.patch('/resource/123', requestBody).reply(StatusCodes.OK, { success: true });

      const { req, res } = createMockRequestResponse('PATCH', '/resource/123', requestBody);

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.OK);
      expect(res.writableFinished).toBe(true);
    });

    test('should handle streaming errors and release reader lock', async () => {
      scope.get('/streaming-error').reply(StatusCodes.OK, 'test response');

      const { req, res } = createMockRequestResponse('GET', '/streaming-error');

      // Simulate a write error during streaming
      res.write = vi.fn(() => {
        throw new Error('Write error during streaming');
      });

      await expect(client.proxy(req, res)).rejects.toThrow('Write error during streaming');
    });

    test('should allow header mutation in onResponse callback', async () => {
      scope.get('/test').reply(
        StatusCodes.OK,
        { success: true },
        {
          'x-rate-limit': '100',
          'x-scope': 'repo'
        }
      );

      const { req, res } = createMockRequestResponse('GET', '/test');

      await client.proxy(req, res, {
        onResponse: async (data) => {
          // Mutate headers: delete existing and add new
          delete data.headers['x-rate-limit'];
          delete data.headers['x-scope'];
          data.headers['x-custom'] = 'value';
        }
      });

      expect(res.getHeader('x-rate-limit')).toBeUndefined();
      expect(res.getHeader('x-scope')).toBeUndefined();
      expect(res.getHeader('x-custom')).toBe('value');
    });

    test('should remove content-encoding and content-length headers', async () => {
      // Mock a response that simulates having encoding headers
      // (fetch will have already decompressed, but headers remain)
      scope.get('/api-response').reply(StatusCodes.OK, JSON.stringify({ success: true }), {
        'content-type': 'application/json'
      });

      const { req, res } = createMockRequestResponse('GET', '/api-response');

      // Manually inject encoding headers in the onResponse to simulate
      // what would come from a real compressed response
      await client.proxy(req, res, {
        onResponse: async (data) => {
          data.headers['content-encoding'] = 'gzip';
          data.headers['content-length'] = '100';
        }
      });

      // These headers should still be removed by the proxy client
      expect(res.getHeader('content-encoding')).toBeUndefined();
      expect(res.getHeader('content-length')).toBeUndefined();
      expect(res.getHeader('content-type')).toBe('application/json');
    });
  });
});

/**
 * Helper function to create mock request and response objects
 */
function createMockRequestResponse(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string | string[]> = {}
): { req: IncomingMessage; res: ServerResponse } {
  const req = {
    method,
    url,
    headers: {
      ...headers,
      host: headers.host || 'localhost:3000'
    },
    socket: {
      remoteAddress: '127.0.0.1',
      encrypted: false
    },
    on: vi.fn((event: string, callback: (chunk?: Buffer) => void) => {
      if (event === 'data' && body) {
        // Emit body data
        setImmediate(() => callback(Buffer.from(JSON.stringify(body))));
      } else if (event === 'end') {
        // Emit end event
        setImmediate(() => callback());
      }
      return req;
    })
  } as unknown as IncomingMessage;

  const responseHeaders = new Map<string, string | number | string[]>();
  let responseBody: Buffer[] = [];
  let finished = false;

  const res = {
    statusCode: 0,
    statusMessage: '',
    get writableFinished() {
      return finished;
    },
    setHeader: vi.fn((name: string, value: string | number | string[]) => {
      responseHeaders.set(name.toLowerCase(), value);
    }),
    getHeader: vi.fn((name: string) => {
      return responseHeaders.get(name.toLowerCase());
    }),
    write: vi.fn((chunk: Buffer | string) => {
      if (!finished) {
        responseBody.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        return true;
      }
      return false;
    }),
    end: vi.fn(() => {
      finished = true;
    }),
    once: vi.fn((event: string, callback: () => void) => {
      if (event === 'drain') {
        setImmediate(callback);
      }
      return res;
    }),
    destroy: vi.fn()
  } as unknown as ServerResponse;

  return { req, res };
}
