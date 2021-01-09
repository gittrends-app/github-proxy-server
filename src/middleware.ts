/* Author: Hudson S. Borges */
import shuffle from 'lodash/shuffle';

import { Readable, PassThrough } from 'stream';
import { queue, QueueObject } from 'async';
import { Response, Request, NextFunction } from 'express';
import { createProxyMiddleware, RequestHandler } from 'http-proxy-middleware';

interface MiddlewareInterface {
  req: Request;
  res: Response;
  next: NextFunction;
}

class Client extends Readable {
  readonly queue: QueueObject<MiddlewareInterface>;
  readonly middleware: RequestHandler;
  readonly token: string;

  limit = 5000;
  remaining: number;
  reset: number;

  constructor(token: string, opts?: { requestTimeout: number; requestInterval: number }) {
    super({ objectMode: true, read: () => null });
    this.token = token;
    this.remaining = 5000;
    this.reset = Date.now() + 1000 * 60 * 60;

    this.middleware = createProxyMiddleware({
      target: 'https://api.github.com',
      changeOrigin: true,
      headers: {
        authorization: `token ${token}`,
        'accept-encoding': 'gzip'
      },
      timeout: opts?.requestTimeout || 15000,
      onProxyReq(proxyReq, req) {
        req.headers.started_at = new Date().toISOString();
        if (req.method.toLowerCase() === 'post') {
          const buffer = Buffer.from(JSON.stringify(req.body));
          proxyReq.setHeader('content-length', Buffer.byteLength(buffer));
          proxyReq.end(buffer);
        }
      },
      onProxyRes: (proxyRes, req, res) => {
        this.updateLimits(proxyRes.headers as Record<string, string>);
        this.log(res.statusCode, new Date(req.headers.started_at as string));

        if (!proxyRes.socket.destroyed) {
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
        }
      },
      logLevel: 'silent'
    });

    this.queue = queue(({ req, res, next }, callback) => {
      if (req.timedout) {
        return callback(new Error('Request timedout'));
      }

      if (req.socket.destroyed) {
        return callback(new Error('Client disconnected before proxing request'));
      }

      return new Promise((resolve, reject) => {
        res.on('close', resolve);
        res.on('error', reject);
        this.middleware(req, res, next);
      })
        .then(() => new Promise((resolve) => setTimeout(resolve, opts?.requestInterval || 100)))
        .then(() => callback())
        .catch((err) => callback(err));
    }, 1);
  }

  updateLimits(headers: Record<string, string>): void {
    if (!headers['x-ratelimit-remaining']) return;
    if (/401/i.test(headers.status)) {
      if (parseInt(headers['x-ratelimit-limit'], 10) > 0) {
        this.remaining = 0;
        this.limit = 0;
        this.reset = Date.now() + 1000 * 60 * 60;
      } else {
        this.remaining -= 1;
      }
    } else {
      this.remaining = parseInt(headers['x-ratelimit-remaining'], 10);
      this.limit = parseInt(headers['x-ratelimit-limit'], 10);
      this.reset = parseInt(headers['x-ratelimit-reset'], 10);
    }
  }

  log(status: number, startedAt: Date): void {
    this.push({
      token: this.token.substring(0, 4),
      queued: this.queued,
      remaining: this.remaining,
      reset: this.reset,
      status,
      duration: Date.now() - startedAt.getTime()
    });
  }

  schedule(req: Request, res: Response, next: NextFunction): void {
    return this.queue.push({ req, res, next }, (err) => {
      if (err && !res.socket?.destroyed) res.status(500).json({ message: err.message });
    });
  }

  get queued(): number {
    return this.queue.length();
  }

  get running(): number {
    return this.queue.running();
  }

  get totalRunning(): number {
    return this.queued + this.running;
  }
}

export default class Proxy extends PassThrough {
  private readonly clients: Client[];
  private readonly requestInterval: number;
  private readonly requestTimeout: number;
  private readonly minRemaining: number;

  constructor(
    tokens: string[],
    opts?: { requestInterval?: number; requestTimeout?: number; minRemaining?: number }
  ) {
    super({ objectMode: true });

    this.requestInterval = opts?.requestInterval || 100;
    this.requestTimeout = opts?.requestTimeout || 15000;
    this.minRemaining = opts?.minRemaining || 100;

    this.clients = tokens.map(
      (token) =>
        new Client(token, {
          requestInterval: this.requestInterval,
          requestTimeout: this.requestTimeout
        })
    );

    this.clients.forEach((client) => client.pipe(this, { end: false }));
  }

  // function to select the best client and queue request
  schedule(req: Request, res: Response, next: NextFunction): void {
    const client = shuffle(this.clients)
      .filter((client) => client.remaining - client.totalRunning > this.minRemaining)
      .reduce((lowest: Client | null, client) => {
        if (!lowest) return client;
        if (lowest.remaining - lowest.totalRunning < client.remaining - client.totalRunning)
          return client;
        return lowest;
      }, null);

    if (!client) {
      res.status(503).json({
        message: 'Proxy Server: no requests available',
        reset: Math.min(...this.clients.map((client) => client.reset))
      });
      return;
    }

    const requiresUserInformation =
      // rest api
      (req.method === 'GET' && /^\/user\/?$/i.test(req.originalUrl)) ||
      // graphql api
      (req.method === 'POST' &&
        /^\/graphql\/?$/i.test(req.originalUrl) &&
        /\Wviewer(.|\s)*{(.|\s)+}/i.test(req.body.query));

    if (requiresUserInformation) {
      res.status(401).json({
        message: 'You cannot request information of the logged user.'
      });
      return;
    }

    return client.schedule(req, res, next);
  }

  removeToken(token: string): void {
    this.clients.splice(this.clients.map((c) => c.token).indexOf(token), 1);
  }
}
