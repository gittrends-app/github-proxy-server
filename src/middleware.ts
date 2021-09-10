/* Author: Hudson S. Borges */
import shuffle from 'lodash/shuffle';

import { Readable, PassThrough } from 'stream';
import { Response, Request } from 'express';
import Server, { createProxyServer } from 'http-proxy';
import Bottleneck from 'bottleneck';

class Client extends Readable {
  readonly queue: Bottleneck;
  readonly middleware: Server;
  readonly token: string;
  readonly schedule;

  limit = 5000;
  remaining: number;
  reset: number;

  constructor(token: string, opts?: { requestTimeout?: number; requestInterval?: number }) {
    super({ objectMode: true, read: () => null });
    this.token = token;
    this.remaining = 5000;
    this.reset = Date.now() + 1000 * 60 * 60;

    this.middleware = createProxyServer({
      target: 'https://api.github.com',
      headers: { authorization: `token ${token}` },
      changeOrigin: true,
      timeout: opts?.requestTimeout ?? 20000,
      proxyTimeout: opts?.requestTimeout ?? 20000
    });

    this.middleware.on('proxyReq', (proxyReq, req) => {
      req.headers.started_at = new Date().toISOString();
      req.proxyRequest = proxyReq;
    });

    this.middleware.on('proxyRes', (proxyRes, req) => {
      this.updateLimits(proxyRes.headers as Record<string, string>);
      this.log(proxyRes.statusCode ?? 0, new Date(req.headers.started_at as string));

      if (req.statusCode === 503 || proxyRes.socket.destroyed) return;

      proxyRes.headers['access-control-expose-headers'] = (
        proxyRes.headers['access-control-expose-headers'] || ''
      )
        .split(', ')
        .filter((header) => {
          if (/(ratelimit|scope)/i.test(header)) {
            delete proxyRes.headers[header.toLowerCase()];
            return false;
          }
          return true;
        })
        .join(', ');
    });

    this.middleware.on('error', (error, req, res) => {
      this.emit('done', error);
      const errorStatusCode = /timedout/gi.test(error.message) ? 504 : 500;
      const statusCode = error ? errorStatusCode : res.statusCode;
      this.log(statusCode, new Date(req.headers.started_at as string));
    });

    this.queue = new Bottleneck({ maxConcurrent: 1 });

    this.schedule = this.queue.wrap(async (req: Request, res: Response) => {
      try {
        if (req.timedout || req.destroyed || req.aborted) {
          throw new Error('Request timedout, destroyed, or aborted');
        }

        let timeout: ReturnType<typeof setTimeout> | null;

        await new Promise((resolve, reject) => {
          res.on('finish', resolve);

          req.on('aborted', () => {
            if (!req.proxyRequest?.destroyed) req.proxyRequest?.abort();
            reject(new Error('Request aborted'));
          });

          this.middleware.web(req, res, undefined, reject);

          timeout = opts?.requestTimeout
            ? setTimeout(() => {
                req.proxyRequest?.abort();
                reject(new Error('Request timedout'));
              }, opts.requestTimeout)
            : null;
        })
          .finally(() => timeout && clearTimeout(timeout))
          .finally(
            () => new Promise((resolve) => setTimeout(resolve, opts?.requestInterval || 250))
          );
      } catch (error: any) {
        const errorStatusCode = /timedout/gi.test(error.message) ? 504 : 500;
        this.log(
          errorStatusCode,
          req.headers.started_at ? new Date(req.headers.started_at as string) : new Date()
        );
        if (!req.proxyRequest?.destroyed) req.proxyRequest?.abort();
        if (!res.socket?.destroyed && !res.headersSent)
          res.status(errorStatusCode).json({ message: error.message });
      }
    });
  }

  async updateLimits(headers: Record<string, string>): Promise<void> {
    if (!headers['x-ratelimit-remaining']) return;
    if (/401/i.test(headers.status)) {
      if (parseInt(headers['x-ratelimit-limit'], 10) > 0) {
        this.remaining = 0;
      } else {
        this.remaining -= 1;
      }
    } else {
      this.remaining = parseInt(headers['x-ratelimit-remaining'], 10);
      this.limit = parseInt(headers['x-ratelimit-limit'], 10);
      this.reset = parseInt(headers['x-ratelimit-reset'], 10);
    }
  }

  async log(status?: number, startedAt?: Date): Promise<void> {
    this.push({
      token: this.token.substring(0, 4),
      queued: this.queued,
      remaining: this.remaining,
      reset: this.reset,
      status: status || '-',
      duration: startedAt ? Date.now() - startedAt.getTime() : 0
    });
  }

  get queued(): number {
    const { RECEIVED, QUEUED } = this.queue.counts();
    return RECEIVED + QUEUED;
  }

  get running(): number {
    const { RUNNING, EXECUTING } = this.queue.counts();
    return RUNNING + EXECUTING;
  }
}

export default class Proxy extends PassThrough {
  private readonly clients: Client[];
  private readonly minRemaining: number;

  constructor(
    tokens: string[],
    opts?: { requestInterval?: number; requestTimeout?: number; minRemaining?: number }
  ) {
    super({ objectMode: true });
    this.minRemaining = opts?.minRemaining ?? 100;

    this.clients = tokens.map(
      (token) =>
        new Client(token, {
          requestInterval: opts?.requestInterval,
          requestTimeout: opts?.requestTimeout
        })
    );

    this.clients.forEach((client) => client.pipe(this, { end: false }));
  }

  // function to select the best client and queue request
  schedule(req: Request, res: Response): void {
    const client = shuffle(this.clients).reduce((selected, client) =>
      !selected || client.running === 0 || client.queued < selected.queued ? client : selected
    );

    if (!client || client.remaining <= this.minRemaining) {
      res.status(503).json({
        message: 'Proxy Server: no requests available',
        reset: Math.min(...this.clients.map((client) => client.reset))
      });
      return;
    }

    client.schedule(req, res);
  }

  removeToken(token: string): void {
    this.clients.splice(this.clients.map((c) => c.token).indexOf(token), 1);
  }
}
