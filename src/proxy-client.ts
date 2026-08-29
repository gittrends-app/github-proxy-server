/* Author: Hudson S. Borges */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Dispatcher } from 'undici';

export interface ProxyClientOptions {
  target: string;
  timeout: number;
  dispatcher?: Dispatcher;
}

export class ProxyClient {
  private readonly target: string;
  private readonly timeout: number;
  private readonly dispatcher?: Dispatcher;

  constructor(options: ProxyClientOptions) {
    this.target = options.target;
    this.timeout = options.timeout;
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
        headers: Record<string, string>;
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

      const forwardedHost = headers.host || '';

      // Remove host header to avoid conflicts
      delete headers.host;

      // Apply header modifications if provided
      const modifiedHeaders = options?.modifyHeaders ? options.modifyHeaders(headers) : headers;

      // Do not trust inbound forwarded headers. The immediate connection is the only trusted hop
      // until a trusted proxy policy is configured at the application boundary.
      modifiedHeaders['x-forwarded-for'] = req.socket.remoteAddress || '';
      const socket = req.socket as IncomingMessage['socket'] & { encrypted?: boolean };
      modifiedHeaders['x-forwarded-proto'] = socket.encrypted ? 'https' : 'http';
      modifiedHeaders['x-forwarded-host'] = forwardedHost;

      // Prepare request body if present
      let body: Buffer | undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        body = await this.readRequestBody(req, controller.signal);
      }

      // Make the fetch request
      const response = await fetch(targetUrl.toString(), {
        method: req.method,
        headers: modifiedHeaders,
        body: body,
        signal: controller.signal,
        redirect: 'manual',
        dispatcher: this.dispatcher
      });

      clearTimeout(timeoutId);

      // Convert immutable response headers to mutable object
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      // Call onResponse callback if provided (with mutable headers)
      if (options?.onResponse) {
        if (!this.canMutateResponse(res, controller.signal)) return;
        await options.onResponse({
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders
        });
      }

      // Remove content-encoding headers since fetch automatically decompresses
      // Keeping them would cause ERR_CONTENT_DECODING_FAILED in browsers
      delete responseHeaders['content-encoding'];
      delete responseHeaders['content-length']; // Also remove as length changes after decompression

      if (!this.canMutateResponse(res, controller.signal)) return;

      // Copy response status
      res.statusCode = response.status;
      if (!this.canMutateResponse(res, controller.signal)) return;
      res.statusMessage = response.statusText;

      // Copy modified response headers
      for (const [key, value] of Object.entries(responseHeaders)) {
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
      const cleanup = (): void => {
        req.removeListener?.('data', onData);
        req.removeListener?.('end', onEnd);
        req.removeListener?.('error', onError);
        signal.removeEventListener('abort', onAbort);
      };
      const onData = (chunk: Buffer): void => {
        chunks.push(chunk);
      };
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
