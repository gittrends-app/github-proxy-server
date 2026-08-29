/* Author: Hudson S. Borges */

import EventEmitter from 'node:events';
import { IncomingMessage, ServerResponse } from 'node:http';

import { StatusCodes } from 'http-status-codes';
import {
  Agent,
  MockAgent,
  type MockPool,
  Headers as UndiciHeaders,
  type Response as UndiciResponse,
  fetch as undiciFetch
} from 'undici';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn(actual.fetch) };
});

import { ProxyClient } from './proxy-client';

describe('ProxyClient', () => {
  let client: ProxyClient;
  let mockAgent: MockAgent | undefined;
  let mockPool!: MockPool;

  const TARGET = 'https://api.example.com';
  const TIMEOUT = 5000;

  function intercept(method: string, path: string, body?: unknown) {
    return mockPool.intercept({
      method,
      path,
      ...(body === undefined
        ? {}
        : {
            body: (value: string): boolean =>
              Buffer.from(value).toString() ===
              (typeof body === 'string' ? body : JSON.stringify(body))
          })
    });
  }

  function normalizeHeaders(
    headers: UndiciHeaders | Record<string, string> | undefined
  ): Record<string, string> {
    return Object.fromEntries(new UndiciHeaders(headers).entries());
  }

  afterEach(async () => {
    await mockAgent?.close();
  });

  describe('constructor', () => {
    test('should create client with basic options', () => {
      const proxyClient = new ProxyClient({
        target: TARGET,
        timeout: TIMEOUT
      });

      expect(proxyClient).toBeInstanceOf(ProxyClient);
    });

    test('should create client with custom agent', async () => {
      const agent = new Agent({ keepAliveTimeout: 60000 });
      const proxyClient = new ProxyClient({
        target: TARGET,
        timeout: TIMEOUT,
        dispatcher: agent
      });

      expect(proxyClient).toBeInstanceOf(ProxyClient);
      await agent.close();
    });
  });

  describe('proxy method', () => {
    beforeEach(() => {
      mockAgent = new MockAgent();
      mockAgent.disableNetConnect();
      mockPool = mockAgent.get(TARGET);
      client = new ProxyClient({
        target: TARGET,
        timeout: TIMEOUT,
        dispatcher: mockAgent
      });
    });

    test('should proxy GET request successfully', async () => {
      intercept('GET', '/test').reply(StatusCodes.OK, { success: true });

      const { req, res } = createMockRequestResponse('GET', '/test');

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.OK);
      expect(res.writableFinished).toBe(true);
    });

    test('should proxy POST request with body', async () => {
      const requestBody = { data: 'test' };

      intercept('POST', '/test', requestBody).reply(StatusCodes.CREATED, { id: 123 });

      const { req, res } = createMockRequestResponse('POST', '/test', requestBody);

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.CREATED);
      expect(res.writableFinished).toBe(true);
    });

    test('should accept a request body exactly at the configured limit', async () => {
      client = new ProxyClient({
        target: TARGET,
        timeout: TIMEOUT,
        maxRequestBodyBytes: 7,
        dispatcher: mockAgent
      });
      intercept('POST', '/at-limit', '"12345"').reply(StatusCodes.OK, 'ok');
      const { req, res } = createMockRequestResponse('POST', '/at-limit', '12345', {
        'content-length': '7'
      });

      await expect(client.proxy(req, res)).resolves.toBeUndefined();
      expect(res.writableFinished).toBe(true);
    });

    test('should reject a declared body larger than the configured limit before buffering', async () => {
      client = new ProxyClient({ target: TARGET, timeout: TIMEOUT, maxRequestBodyBytes: 4 });
      const { req, res } = createMockRequestResponse('POST', '/too-large', '12345', {
        'content-length': '5'
      });

      await expect(client.proxy(req, res)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
      expect(req.resume).toHaveBeenCalledTimes(1);
    });

    test('should reject a chunked body when it exceeds the configured limit', async () => {
      client = new ProxyClient({ target: TARGET, timeout: TIMEOUT, maxRequestBodyBytes: 4 });
      const { req, res } = createMockRequestResponse('POST', '/too-large', '12345');

      await expect(client.proxy(req, res)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    });

    test('should abort and clean up listeners while waiting for a slow upload', async () => {
      const timeoutClient = new ProxyClient({ target: TARGET, timeout: 10 });
      const req = Object.assign(new EventEmitter(), {
        method: 'POST',
        url: '/slow-upload',
        headers: { host: 'localhost:3000' },
        socket: { remoteAddress: '127.0.0.1', encrypted: false }
      }) as unknown as IncomingMessage;
      const { res } = createMockRequestResponse('POST', '/slow-upload');

      await expect(timeoutClient.proxy(req, res)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
      expect(req.listenerCount('data')).toBe(0);
      expect(req.listenerCount('end')).toBe(0);
      expect(req.listenerCount('error')).toBe(0);
    });

    test('should copy request headers', async () => {
      let receivedHeaders: Record<string, string> = {};

      intercept('GET', '/test').reply(({ headers }) => {
        receivedHeaders = normalizeHeaders(headers);
        return { statusCode: StatusCodes.OK, data: { success: true } };
      });

      const { req, res } = createMockRequestResponse('GET', '/test', undefined, {
        'user-agent': 'test-agent',
        'x-custom-header': 'custom-value'
      });

      await client.proxy(req, res);

      expect(receivedHeaders['user-agent']).toBe('test-agent');
      expect(receivedHeaders['x-custom-header']).toBe('custom-value');
    });

    test('should filter hop-by-hop request headers and connection tokens', async () => {
      let receivedHeaders: Record<string, string> = {};

      intercept('GET', '/hop-by-hop').reply(({ headers }) => {
        receivedHeaders = normalizeHeaders(headers);
        return { statusCode: StatusCodes.OK, data: 'ok' };
      });

      const { req, res } = createMockRequestResponse('GET', '/hop-by-hop', undefined, {
        connection: 'keep-alive, x-request-hop',
        'keep-alive': 'timeout=5',
        'x-request-hop': 'remove-me',
        te: 'trailers',
        'x-end-to-end': 'preserve-me'
      });

      await client.proxy(req, res);

      expect(receivedHeaders.connection).toBeUndefined();
      expect(receivedHeaders['keep-alive']).toBeUndefined();
      expect(receivedHeaders['x-request-hop']).toBeUndefined();
      expect(receivedHeaders.te).toBeUndefined();
      expect(receivedHeaders['x-end-to-end']).toBe('preserve-me');
    });

    test('should preserve trusted forwarded headers named by inbound Connection', async () => {
      let receivedHeaders: Record<string, string> = {};

      intercept('GET', '/forwarded-connection').reply(({ headers }) => {
        receivedHeaders = normalizeHeaders(headers);
        return { statusCode: StatusCodes.OK, data: 'ok' };
      });

      const { req, res } = createMockRequestResponse('GET', '/forwarded-connection', undefined, {
        connection: 'x-forwarded-for, x-forwarded-host, x-forwarded-proto',
        'x-forwarded-for': 'spoofed-for',
        'x-forwarded-host': 'spoofed-host',
        'x-forwarded-proto': 'spoofed-proto'
      });

      await client.proxy(req, res);

      expect(receivedHeaders['x-forwarded-for']).toBe('127.0.0.1');
      expect(receivedHeaders['x-forwarded-host']).toBe('localhost:3000');
      expect(receivedHeaders['x-forwarded-proto']).toBe('http');
    });

    test('should preserve modified authorization despite an inbound Connection token', async () => {
      let receivedHeaders: Record<string, string> = {};

      intercept('GET', '/authorization').reply(({ headers }) => {
        receivedHeaders = normalizeHeaders(headers);
        return { statusCode: StatusCodes.OK, data: 'ok' };
      });

      const { req, res } = createMockRequestResponse('GET', '/authorization', undefined, {
        connection: 'authorization'
      });

      await client.proxy(req, res, {
        modifyHeaders: (headers) => ({ ...headers, authorization: 'token injected' })
      });

      expect(receivedHeaders.authorization).toBe('token injected');
    });

    test('should add forwarded metadata from the immediate request', async () => {
      let receivedHeaders: Record<string, string> = {};

      intercept('GET', '/test').reply(({ headers }) => {
        receivedHeaders = normalizeHeaders(headers);
        return { statusCode: StatusCodes.OK, data: { success: true } };
      });

      const { req, res } = createMockRequestResponse('GET', '/test', undefined, {
        host: 'incoming.example.com'
      });

      await client.proxy(req, res);

      expect(receivedHeaders['x-forwarded-for']).toBe('127.0.0.1');
      expect(receivedHeaders['x-forwarded-proto']).toBe('http');
      expect(receivedHeaders['x-forwarded-host']).toBe('incoming.example.com');
    });

    test('should derive HTTPS protocol from the request socket', async () => {
      let receivedHeaders: Record<string, string> = {};

      intercept('GET', '/test').reply(({ headers }) => {
        receivedHeaders = normalizeHeaders(headers);
        return { statusCode: StatusCodes.OK, data: { success: true } };
      });

      const { req, res } = createMockRequestResponse(
        'GET',
        '/test',
        undefined,
        {},
        { encrypted: true }
      );

      await client.proxy(req, res);

      expect(receivedHeaders['x-forwarded-proto']).toBe('https');
    });

    test('should replace spoofed forwarded headers with immediate request metadata', async () => {
      let receivedHeaders: Record<string, string> = {};

      intercept('GET', '/test').reply(({ headers }) => {
        receivedHeaders = normalizeHeaders(headers);
        return { statusCode: StatusCodes.OK, data: { success: true } };
      });

      const { req, res } = createMockRequestResponse('GET', '/test', undefined, {
        host: 'incoming.example.com',
        'x-forwarded-for': 'spoofed-client',
        'x-forwarded-host': 'spoofed.example.com',
        'x-forwarded-proto': 'https'
      });

      await client.proxy(req, res);

      expect(receivedHeaders['x-forwarded-for']).toBe('127.0.0.1');
      expect(receivedHeaders['x-forwarded-host']).toBe('incoming.example.com');
      expect(receivedHeaders['x-forwarded-proto']).toBe('http');
    });

    test('should send an empty forwarded host when the request has no host', async () => {
      let receivedHeaders: Record<string, string> = {};

      intercept('GET', '/test').reply(({ headers }) => {
        receivedHeaders = normalizeHeaders(headers);
        return { statusCode: StatusCodes.OK, data: { success: true } };
      });

      const { req, res } = createMockRequestResponse('GET', '/test');
      delete req.headers.host;

      await client.proxy(req, res);

      expect(receivedHeaders['x-forwarded-host']).toBe('');
    });

    test('should modify headers via modifyHeaders callback', async () => {
      let receivedHeaders: Record<string, string> = {};

      intercept('GET', '/test').reply(({ headers }) => {
        receivedHeaders = normalizeHeaders(headers);
        return { statusCode: StatusCodes.OK, data: { success: true } };
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
      intercept('GET', '/test').reply(StatusCodes.OK, { success: true });

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
      intercept('GET', '/test').reply(
        StatusCodes.OK,
        { success: true },
        {
          headers: { 'x-rate-limit': '100' }
        }
      );

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
      intercept('GET', '/test').reply(
        StatusCodes.OK,
        { success: true },
        { headers: { 'content-type': 'application/json', 'x-custom-header': 'custom-value' } }
      );

      const { req, res } = createMockRequestResponse('GET', '/test');

      await client.proxy(req, res);

      expect(res.getHeader('content-type')).toBe('application/json');
      expect(res.getHeader('x-custom-header')).toBe('custom-value');
    });

    test('should filter hop-by-hop response headers and preserve repeated cookies', async () => {
      const headers = new Headers({
        connection: 'x-response-hop',
        'x-response-hop': 'remove-me',
        'x-end-to-end': 'preserve-me'
      });
      Object.defineProperty(headers, 'getSetCookie', {
        value: () => ['first=1; Path=/', 'second=2; Path=/']
      });
      const fetch = vi.mocked(undiciFetch).mockResolvedValue({
        status: StatusCodes.OK,
        statusText: 'OK',
        headers,
        body: null
      } as unknown as UndiciResponse);

      const { req, res } = createMockRequestResponse('GET', '/response-headers');

      try {
        await client.proxy(req, res);
      } finally {
        fetch.mockRestore();
      }

      expect(res.getHeader('connection')).toBeUndefined();
      expect(res.getHeader('x-response-hop')).toBeUndefined();
      expect(res.getHeader('x-end-to-end')).toBe('preserve-me');
      expect(res.getHeader('set-cookie')).toEqual(['first=1; Path=/', 'second=2; Path=/']);
    });

    test('should handle empty response body', async () => {
      intercept('GET', '/test').reply(StatusCodes.NO_CONTENT);

      const { req, res } = createMockRequestResponse('GET', '/test');

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.NO_CONTENT);
      expect(res.writableFinished).toBe(true);
    });

    test('should handle large response bodies with streaming', async () => {
      const largeBody = 'x'.repeat(1024 * 1024); // 1MB
      intercept('GET', '/large').reply(StatusCodes.OK, largeBody);

      const { req, res } = createMockRequestResponse('GET', '/large');

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.OK);
      expect(res.writableFinished).toBe(true);
    });

    test('should throw ETIMEDOUT on timeout', async () => {
      const shortTimeout = 100;
      const timeoutClient = new ProxyClient({
        target: TARGET,
        timeout: shortTimeout,
        dispatcher: mockAgent
      });

      intercept('GET', '/slow')
        .reply(StatusCodes.OK)
        .delay(shortTimeout * 2);

      const { req, res } = createMockRequestResponse('GET', '/slow');

      await expect(timeoutClient.proxy(req, res)).rejects.toMatchObject({
        code: 'ETIMEDOUT'
      });
    });

    test('should cancel an active upstream request with the caller controller', async () => {
      const controller = new AbortController();
      intercept('GET', '/cancel')
        .reply(StatusCodes.OK)
        .delay(TIMEOUT * 2);

      const { req, res } = createMockRequestResponse('GET', '/cancel');
      const proxy = client.proxy(req, res, { abortController: controller });
      controller.abort();

      await expect(proxy).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    });

    test('should not mutate the response after cancellation during onResponse', async () => {
      const controller = new AbortController();
      let releaseResponse!: () => void;
      const responseHandling = new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      let onResponseStarted!: () => void;
      const responseStarted = new Promise<void>((resolve) => {
        onResponseStarted = resolve;
      });
      intercept('GET', '/cancel-on-response').reply(StatusCodes.OK);

      const { req, res } = createMockRequestResponse('GET', '/cancel-on-response');
      const proxy = client.proxy(req, res, {
        abortController: controller,
        onResponse: async () => {
          onResponseStarted();
          await responseHandling;
        }
      });

      await responseStarted;
      controller.abort();
      releaseResponse();

      await expect(proxy).rejects.toMatchObject({ code: 'ETIMEDOUT' });
      expect(res.statusCode).toBe(0);
      expect(res.writableFinished).toBe(false);
    });

    test('should stop streamed writes after downstream cancellation', async () => {
      const controller = new AbortController();
      const read = vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined));
      const cancel = vi.fn().mockResolvedValue(undefined);
      const releaseLock = vi.fn();
      const fetch = vi.mocked(undiciFetch).mockResolvedValue({
        status: StatusCodes.OK,
        statusText: 'OK',
        headers: new Headers(),
        body: { getReader: () => ({ read, cancel, releaseLock }) }
      } as unknown as UndiciResponse);
      const { req, res } = createMockRequestResponse('GET', '/stream-cancel');

      try {
        const proxy = client.proxy(req, res, { abortController: controller });
        await vi.waitFor(() => expect(read).toHaveBeenCalled());
        controller.abort();

        await expect(proxy).rejects.toMatchObject({ code: 'ETIMEDOUT' });
        expect(res.writableFinished).toBe(false);
        expect(res.write).not.toHaveBeenCalled();
        expect(cancel).toHaveBeenCalled();
        expect(releaseLock).toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
    });

    test('should remove drain listeners when backpressure is cancelled', async () => {
      const controller = new AbortController();
      let drain!: () => void;
      const read = vi
        .fn()
        .mockResolvedValueOnce({ done: false, value: new Uint8Array([1]) })
        .mockImplementation(
          () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined)
        );
      const cancel = vi.fn().mockResolvedValue(undefined);
      const releaseLock = vi.fn();
      const fetch = vi.mocked(undiciFetch).mockResolvedValue({
        status: StatusCodes.OK,
        statusText: 'OK',
        headers: new Headers(),
        body: { getReader: () => ({ read, cancel, releaseLock }) }
      } as unknown as UndiciResponse);
      const { req, res } = createMockRequestResponse('GET', '/backpressure-cancel');
      const removeListener = vi.fn();
      res.write = vi.fn(() => false);
      res.once = vi.fn((event: string, callback: () => void) => {
        if (event === 'drain') drain = callback;
        return res;
      });
      res.removeListener = removeListener;

      try {
        const proxy = client.proxy(req, res, { abortController: controller });
        await vi.waitFor(() => expect(drain).toBeTypeOf('function'));
        controller.abort();

        await expect(proxy).rejects.toMatchObject({ code: 'ETIMEDOUT' });
        expect(res.writableFinished).toBe(false);
        expect(removeListener).toHaveBeenCalledWith('drain', drain);
        expect(removeListener).toHaveBeenCalledWith('close', expect.any(Function));
        expect(cancel).toHaveBeenCalled();
        expect(releaseLock).toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
    });

    test('should handle network errors', async () => {
      intercept('GET', '/error').replyWithError(new Error('Network error'));

      const { req, res } = createMockRequestResponse('GET', '/error');

      await expect(client.proxy(req, res)).rejects.toMatchObject({
        cause: expect.objectContaining({ message: 'Network error' })
      });
    });

    test('should handle HTTP error responses', async () => {
      intercept('GET', '/not-found').reply(StatusCodes.NOT_FOUND, { error: 'Not Found' });

      const { req, res } = createMockRequestResponse('GET', '/not-found');

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.NOT_FOUND);
      expect(res.writableFinished).toBe(true);
    });

    test('should handle redirect responses with redirect: manual', async () => {
      intercept('GET', '/redirect').reply(StatusCodes.MOVED_PERMANENTLY, undefined, {
        headers: { location: 'https://api.example.com/new-location' }
      });

      const { req, res } = createMockRequestResponse('GET', '/redirect');

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.MOVED_PERMANENTLY);
      expect(res.getHeader('location')).toBe('https://api.example.com/new-location');
    });

    test('should handle array headers', async () => {
      intercept('GET', '/test').reply(StatusCodes.OK, { success: true });

      const { req, res } = createMockRequestResponse('GET', '/test', undefined, {
        accept: ['application/json', 'text/html']
      });

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.OK);
    });

    test('should remove host header to avoid conflicts', async () => {
      let receivedHeaders: Record<string, string> = {};

      intercept('GET', '/test').reply(({ headers }) => {
        receivedHeaders = normalizeHeaders(headers);
        return { statusCode: StatusCodes.OK, data: { success: true } };
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

      intercept('PUT', '/resource/123', requestBody).reply(StatusCodes.OK, { success: true });

      const { req, res } = createMockRequestResponse('PUT', '/resource/123', requestBody);

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.OK);
      expect(res.writableFinished).toBe(true);
    });

    test('should handle DELETE requests', async () => {
      intercept('DELETE', '/resource/123').reply(StatusCodes.NO_CONTENT);

      const { req, res } = createMockRequestResponse('DELETE', '/resource/123');

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.NO_CONTENT);
      expect(res.writableFinished).toBe(true);
    });

    test('should handle PATCH requests', async () => {
      const requestBody = { field: 'new-value' };

      intercept('PATCH', '/resource/123', requestBody).reply(StatusCodes.OK, { success: true });

      const { req, res } = createMockRequestResponse('PATCH', '/resource/123', requestBody);

      await client.proxy(req, res);

      expect(res.statusCode).toBe(StatusCodes.OK);
      expect(res.writableFinished).toBe(true);
    });

    test('should handle streaming errors and release reader lock', async () => {
      intercept('GET', '/streaming-error').reply(StatusCodes.OK, 'test response');

      const { req, res } = createMockRequestResponse('GET', '/streaming-error');

      // Simulate a write error during streaming
      res.write = vi.fn(() => {
        throw new Error('Write error during streaming');
      });

      await expect(client.proxy(req, res)).rejects.toThrow('Write error during streaming');
    });

    test('should allow header mutation in onResponse callback', async () => {
      intercept('GET', '/test').reply(
        StatusCodes.OK,
        { success: true },
        { headers: { 'x-rate-limit': '100', 'x-scope': 'repo' } }
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
      intercept('GET', '/api-response').reply(StatusCodes.OK, JSON.stringify({ success: true }), {
        headers: { 'content-type': 'application/json' }
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
  headers: Record<string, string | string[]> = {},
  socketOptions: { encrypted?: boolean; remoteAddress?: string } = {}
): { req: IncomingMessage; res: ServerResponse } {
  const req = {
    method,
    url,
    headers: {
      ...headers,
      host: headers.host || 'localhost:3000'
    },
    socket: {
      remoteAddress: socketOptions.remoteAddress || '127.0.0.1',
      encrypted: socketOptions.encrypted || false
    },
    resume: vi.fn(),
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