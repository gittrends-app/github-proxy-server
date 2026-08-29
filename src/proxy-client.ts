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
      onResponse?: (data: {
        status: number;
        statusText: string;
        headers: Record<string, string>;
      }) => void | Promise<void>;
    }
  ): Promise<void> {
    const controller = new AbortController();
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
        body = await this.readRequestBody(req);
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

      // Copy response status
      res.statusCode = response.status;
      res.statusMessage = response.statusText;

      // Copy modified response headers
      for (const [key, value] of Object.entries(responseHeaders)) {
        res.setHeader(key, value);
      }

      // Stream response body
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!res.write(value)) {
              // Backpressure: wait for drain event
              await new Promise((resolve) => res.once('drain', resolve));
            }
          }
          res.end();
        } catch (error) {
          reader.releaseLock();
          throw error;
        }
      } else {
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
  private readRequestBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
}
