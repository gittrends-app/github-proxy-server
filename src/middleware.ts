/* Author: Hudson S. Borges */
import shuffle from 'lodash/shuffle';
import minBy from 'lodash/minBy';

import { Readable, PassThrough } from 'stream';
import { Response, Request } from 'express';
import Server, { createProxyServer } from 'http-proxy';
import Bottleneck from 'bottleneck';

class Client extends Readable {
  readonly queue: Bottleneck;
  readonly middleware: Server;
  readonly token: string;

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
    });

    this.middleware.on('proxyRes', (proxyRes, req) => {
      req.emit('done');
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

    this.middleware.on('error', (err, req, res) => {
      req.emit('done', err);
      this.log(res.statusCode, new Date(req.headers.started_at as string));
    });

    this.queue = new Bottleneck({ maxConcurrent: 1, minTime: opts?.requestInterval || 250 });
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

  async log(status: number, startedAt: Date): Promise<void> {
    this.push({
      token: this.token.substring(0, 4),
      queued: this.queued,
      remaining: this.remaining,
      reset: this.reset,
      status,
      duration: Date.now() - startedAt.getTime()
    });
  }

  schedule(req: Request, res: Response): void {
    this.queue.schedule(async () => {
      if (req.timedout || req.socket.destroyed) return;

      await new Promise((resolve, reject) => {
        req.on('done', resolve);
        req.on('error', (err) => {
          if (err && !res.headersSent) res.status(500).json({ message: err.message });
          reject(err);
        });
        this.middleware.web(req, res);
      });
    });
  }

  get queued(): number {
    return this.queue.counts().QUEUED;
  }

  get running(): number {
    return this.queue.counts().EXECUTING;
  }

  get totalRunning(): number {
    return this.queued + this.running;
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
    const client = minBy(
      shuffle(this.clients),
      (client) => client.totalRunning - client.remaining / 5000
    );

    if (!client || client.remaining <= this.minRemaining) {
      res.status(503).json({
        message: 'Proxy Server: no requests available',
        reset: Math.min(...this.clients.map((client) => client.reset))
      });
      return;
    }

    return client.schedule(req, res);
  }

  removeToken(token: string): void {
    this.clients.splice(this.clients.map((c) => c.token).indexOf(token), 1);
  }
}
