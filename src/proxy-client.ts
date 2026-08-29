/* Author: Hudson S. Borges */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Dispatcher } from 'undici';

export type ProxyHeaderValue = string | string[];
export type ProxyResponseHeaders = Record<string, ProxyHeaderValue>;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-connection'
]);

export interface ProxyClientOptions {
  target: string;
  timeout: number;
  maxRequestBodyBytes?: number;
  dispatcher?: Dispatcher;
}

export class PayloadTooLargeError extends Error {
  readonly code = 'PAYLOAD_TOO_LARGE';

  constructor() {
    super('Request body too large');
    this.name = 'PayloadTooLargeError';
  }
}

export class ProxyClient {
  private readonly target: string;
  private readonly timeout: number;
  private readonly maxRequestBodyBytes: number;
  private readonly dispatcher?: Dispatcher;

  constructor(options: ProxyClientOptions) {
    this.target = options.target;
    this.timeout = options.timeout;
    this.maxRequestBodyBytes = options.maxRequestBodyBytes ?? 1024 * 1024;
    this.dispatcher = options.dispatcher;
  }

  /**
   * Proxy an incoming HTTP request to the target server
   * @param req - Incoming request from Express
   * @param res - Outgoing response to Express client
   * @param options - Additional options for request modification
   */
  async proxy(
    req: IncomingMessage,
    res: ServerResponse,
    options?: {
      modifyHeaders?: (headers: Record<string, string>) => Record<string, string>;
      abortController?: AbortController;
      onResponse?: (data: {
        status: number;
        statusText: string;
        headers: ProxyResponseHeaders;
      }) => void | Promise<void>;
    }
  ): Promise<void> {
    const controller = options?.abortController ?? new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      // Build target URL
      const targetUrl = new URL(req.url || '/', this.target);

      // Copy headers from incoming request
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) {
          headers[key] = Array.isArray(value) ? value.join(', ') : value;
        }
      }

      const connectionTokens = this.connectionTokens(headers);
      const forwardedHost = headers.host || '';

      // Remove host header to avoid conflicts
      delete headers.host;

      // Apply header modifications if provided
      const filteredHeaders = this.filterHopByHopHeaders(headers, connectionTokens) as Record<
        string,
        string
      >;
      const modifiedHeaders = options?.modifyHeaders
        ? options.modifyHeaders(filteredHeaders)
        : filteredHeaders;

      // Do not trust inbound forwarded headers. The immediate connection is the only trusted hop
      // until a trusted proxy policy is configured at the application boundary.
      const socket = req.socket as IncomingMessage['socket'] & { encrypted?: boolean };
      const requestHeaders = this.filterHopByHopHeaders(
        modifiedHeaders,
        this.connectionTokens(modifiedHeaders)
      ) as Record<string, string>;
      delete requestHeaders.host;
      requestHeaders['x-forwarded-for'] = req.socket.remoteAddress || '';
      requestHeaders['x-forwarded-proto'] = socket.encrypted ? 'https' : 'http';
      requestHeaders['x-forwarded-host'] = forwardedHost;

      // Prepare request body if present
      let body: Buffer | undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        body = await this.readRequestBody(req, controller.signal);
      }

      // Make the fetch request
      const response = await fetch(targetUrl.toString(), {
        method: req.method,
        headers: requestHeaders,
        body: body,
        signal: controller.signal,
        redirect: 'manual',
        dispatcher: this.dispatcher
      });

      clearTimeout(timeoutId);

      // Convert immutable response headers to mutable object
      const responseHeaders: ProxyResponseHeaders = {};
      response.headers.forEach((value, key) => {
        const current = responseHeaders[key];
        responseHeaders[key] = current
          ? Array.isArray(current)
            ? [...current, value]
            : [current, value]
          : value;
      });
      const setCookies = (
        response.headers as Headers & { getSetCookie?: () => string[] }
      ).getSetCookie?.();
      if (setCookies?.length) responseHeaders['set-cookie'] = setCookies;
      const filteredResponseHeaders = this.filterHopByHopHeaders(
        responseHeaders,
        this.connectionTokens(responseHeaders)
      );

      // Call onResponse callback if provided (with mutable headers)
      if (options?.onResponse) {
        if (!this.canMutateResponse(res, controller.signal)) return;
        await options.onResponse({
          status: response.status,
          statusText: response.statusText,
          headers: filteredResponseHeaders
        });
      }

      // Remove content-encoding headers since fetch automatically decompresses
      // Keeping them would cause ERR_CONTENT_DECODING_FAILED in browsers
      delete filteredResponseHeaders['content-encoding'];
      delete filteredResponseHeaders['content-length']; // Also remove as length changes after decompression

      if (!this.canMutateResponse(res, controller.signal)) return;

      // Copy response status
      res.statusCode = response.status;
      if (!this.canMutateResponse(res, controller.signal)) return;
      res.statusMessage = response.statusText;

      // Copy modified response headers
      for (const [key, value] of Object.entries(filteredResponseHeaders)) {
        if (!this.canMutateResponse(res, controller.signal)) return;
        res.setHeader(key, value);
      }

      // Stream response body
      if (response.body) {
        if (!this.canWriteResponse(res, controller.signal)) return;
        const reader = response.body.getReader();
        try {
          while (true) {
            if (!this.canWriteResponse(res, controller.signal)) {
              void reader.cancel().catch(() => undefined);
              return;
            }
            const { done, value } = await this.awaitAbort(reader.read(), controller.signal);
            if (done) {
              if (this.canWriteResponse(res, controller.signal)) res.end();
              return;
            }
            if (!this.canWriteResponse(res, controller.signal)) {
              void reader.cancel().catch(() => undefined);
              return;
            }
            if (!res.write(value)) {
              // Backpressure: wait for drain event
              if (!this.canWriteResponse(res, controller.signal)) {
                void reader.cancel().catch(() => undefined);
                return;
              }
              const drained = await this.waitForDrain(res, controller.signal);
              if (!drained) {
                void reader.cancel().catch(() => undefined);
                return;
              }
            }
          }
        } catch (error) {
          void reader.cancel().catch(() => undefined);
          throw error;
        } finally {
          try {
            reader.releaseLock();
          } catch {
            // The reader may already be released by the underlying stream.
          }
        }
      } else {
        if (!this.canWriteResponse(res, controller.signal)) return;
        res.end();
      }
    } catch (error) {
      clearTimeout(timeoutId);

      // Convert abort errors to ETIMEDOUT
      if ((error as Error).name === 'AbortError' || (error as Error).name === 'TimeoutError') {
        const timeoutError = new Error('ETIMEDOUT') as Error & { code: string };
        timeoutError.code = 'ETIMEDOUT';
        throw timeoutError;
      }

      throw error;
    }
  }

  /**
   * Read the full request body into a buffer
   */
  private readRequestBody(req: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const contentLength = req.headers['content-length'];
      const declaredLength = Array.isArray(contentLength)
        ? Number(contentLength[0])
        : contentLength === undefined
          ? undefined
          : Number(contentLength);
      const cleanup = (): void => {
        req.removeListener?.('data', onData);
        req.removeListener?.('end', onEnd);
        req.removeListener?.('error', onError);
        signal.removeEventListener('abort', onAbort);
      };
      const onData = (chunk: Buffer): void => {
        size += chunk.length;
        if (size > this.maxRequestBodyBytes) {
          cleanup();
          req.resume?.();
          reject(new PayloadTooLargeError());
          return;
        }
        chunks.push(chunk);
      };

      if (declaredLength !== undefined && declaredLength > this.maxRequestBodyBytes) {
        reject(new PayloadTooLargeError());
        req.resume?.();
        return;
      }
      const onEnd = (): void => {
        cleanup();
        resolve(Buffer.concat(chunks));
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new DOMException('The operation was aborted', 'AbortError'));
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async awaitAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');

    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new DOMException('The operation was aborted', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
    });

    try {
      return await Promise.race([operation, aborted]);
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
    }
  }

  private connectionTokens(headers: Record<string, ProxyHeaderValue>): Set<string> {
    const connection = headers.connection;
    const values =
      connection === undefined ? [] : Array.isArray(connection) ? connection : [connection];
    return new Set(
      values.flatMap((value) => value.split(',')).map((value) => value.trim().toLowerCase())
    );
  }

  private filterHopByHopHeaders(
    headers: Record<string, ProxyHeaderValue>,
    connectionTokens: Set<string>
  ): Record<string, ProxyHeaderValue> {
    return Object.fromEntries(
      Object.entries(headers).filter(([key]) => {
        const normalizedKey = key.toLowerCase();
        return !HOP_BY_HOP_HEADERS.has(normalizedKey) && !connectionTokens.has(normalizedKey);
      })
    );
  }

  private canWriteResponse(res: ServerResponse, signal: AbortSignal): boolean {
    if (signal.aborted) throw new DOMException('The operation was aborted', 'AbortError');
    return !res.destroyed && !res.writableEnded;
  }

  private canMutateResponse(res: ServerResponse, signal: AbortSignal): boolean {
    return this.canWriteResponse(res, signal) && !res.headersSent;
  }

  private waitForDrain(res: ServerResponse, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        res.removeListener?.('drain', onDrain);
        res.removeListener?.('close', onClose);
        signal.removeEventListener('abort', onAbort);
      };
      const onDrain = (): void => {
        cleanup();
        resolve(true);
      };
      const onClose = (): void => {
        cleanup();
        resolve(false);
      };
      const onAbort = (): void => {
        cleanup();
        reject(new DOMException('The operation was aborted', 'AbortError'));
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      if (res.destroyed || res.writableEnded) {
        resolve(false);
        return;
      }

      res.once('drain', onDrain);
      res.once('close', onClose);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
