/* Author: Hudson S. Borges */
import dayjs from 'dayjs';
import consola from 'consola';

import { chain, min } from 'lodash';
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
    this.reset = dayjs().add(1, 'hour').unix();

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
        this.updateLimits(res.getHeaders() as Record<string, string>);
        this.log(res.statusCode, dayjs(req.headers.started_at as string).toDate());

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
      },
      logLevel: 'silent',
      logProvider: () => consola
    });

    this.queue = queue(({ req, res, next }, callback) => {
      if (req.timedout) {
        return callback(new Error('Request timedout'));
      }

      if (req.socket.destroyed) {
        return callback(new Error('Client disconnected before proxing request'));
      }

      return new Promise((resolve, reject) => {
        req.socket.on('close', resolve);
        req.socket.on('error', reject);
        this.middleware(req, res, next);
      })
        .then(() => new Promise((resolve) => setTimeout(resolve, opts?.requestInterval || 100)))
        .then(() => callback())
        .catch((err) => callback(err));
    }, 1);
  }

  updateLimits(headers: Record<string, string>): void {
    if (!headers['x-ratelimit-remaining']) return;
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
      if (err) {
        consola.warn(err.message || err);
        res.status(500).json({ message: err.message });
      }
    });
  }

  get queued(): number {
    return this.queue.length();
  }

  get running(): number {
    return this.queue.running();
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
    const client = chain(this.clients)
      .shuffle()
      .minBy((client) => client.running + client.queued)
      .value();

    if (!client || client.remaining - client.queued < this.minRemaining) {
      res.status(503).json({
        message: 'Proxy Server: no requests available',
        reset: min(this.clients.map((client) => client.reset))
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
