/* Author: Hudson S. Borges */
import Bottleneck from 'bottleneck';
import { Request, Response } from 'express';
import faker from 'faker';
import { ServerResponse } from 'http';
import Server, { createProxyServer } from 'http-proxy';
import { min, shuffle } from 'lodash';
import { PassThrough, Readable } from 'stream';

faker.seed(12345);

type ClientOpts = {
  requestTimeout: number;
  requestInterval: number;
  clustering?: {
    host: string;
    port: number;
    db: number;
  };
};

export interface IClientLogger {
  token: string;
  pending: number;
  remaining: number;
  reset: number;
  status: number;
  duration: number;
}

class Client extends Readable {
  readonly queue: Bottleneck;

  readonly middleware: Server;
  readonly token: string;
  readonly schedule;

  limit = 5000;
  remaining: number;
  reset: number;
  resetTimeout?: ReturnType<typeof setTimeout>;

  constructor(token: string, opts: ClientOpts) {
    super({ objectMode: true, read: () => null });
    this.token = token;
    this.remaining = 5000;
    this.reset = (Date.now() + 1000 * 60 * 60) / 1000;

    this.middleware = createProxyServer({
      target: 'https://api.github.com',
      headers: { Authorization: `token ${token}` },
      proxyTimeout: opts.requestTimeout,
      ws: false,
      xfwd: true,
      changeOrigin: true
    });

    this.middleware.on('proxyReq', (proxyReq, req) => {
      req.startedAt = new Date();
      req.proxyRequest = proxyReq;
    });

    this.middleware.on('proxyRes', (proxyRes, req) => {
      this.updateLimits({
        status: `${proxyRes.statusCode}`,
        ...(proxyRes.headers as Record<string, string>)
      });

      this.log(proxyRes.statusCode, req.startedAt);

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

    this.queue = new Bottleneck({
      maxConcurrent: 1,
      minTime: 0,
      id: `proxy_server:${this.token}`,
      ...(opts?.clustering
        ? {
            datastore: 'ioredis',
            clearDatastore: false,
            clientOptions: {
              host: opts.clustering.host,
              port: opts.clustering.port,
              options: { db: opts.clustering.db }
            },
            timeout: opts.requestTimeout
          }
        : { datastore: 'local' })
    });

    this.schedule = this.queue.wrap(async (req: Request, res: Response) => {
      if (req.destroyed) return Promise.all([req.destroy(), this.log()]);

      await new Promise((resolve, reject) => {
        res.on('close', resolve);
        this.middleware.web(req, res as ServerResponse, undefined, (error) => reject(error));
      })
        .catch(async (error) => {
          this.log(ProxyMiddlewareResponse.PROXY_ERROR, req.startedAt);

          if (!(res.destroyed || res.headersSent)) {
            res.status(ProxyMiddlewareResponse.PROXY_ERROR).json(error);
          }

          req.proxyRequest?.destroy();
        })
        .finally(() => new Promise((resolve) => setTimeout(resolve, opts.requestInterval)));
    });

    this.on('close', () => this.resetTimeout && clearTimeout(this.resetTimeout));
  }

  updateLimits(headers: Record<string, string>): void {
    if (!headers['x-ratelimit-remaining']) return;
    if (/401/i.test(headers.status)) {
      if (parseInt(headers['x-ratelimit-limit'], 10) > 0) this.remaining = 0;
      else this.remaining -= 1;
    } else {
      this.remaining = parseInt(headers['x-ratelimit-remaining'], 10);
      this.limit = parseInt(headers['x-ratelimit-limit'], 10);
      this.reset = parseInt(headers['x-ratelimit-reset'], 10);
      if (this.resetTimeout) clearTimeout(this.resetTimeout);
      const resetIn = Math.max(50, this.reset * 1000 - Date.now());
      this.resetTimeout = setTimeout(() => (this.remaining = 5000), resetIn);
    }
  }

  async log(status?: number, startedAt?: Date): Promise<void> {
    this.push({
      token: this.token.substring(0, 4),
      pending: this.queued,
      remaining: this.remaining,
      reset: this.reset,
      status: status || '-',
      duration: startedAt ? Date.now() - startedAt.getTime() : 0
    } as IClientLogger);
  }

  get pending(): number {
    const { RECEIVED, QUEUED, RUNNING, EXECUTING } = this.queue.counts();
    return RECEIVED + QUEUED + RUNNING + EXECUTING;
  }

  get queued(): number {
    const { RECEIVED, QUEUED } = this.queue.counts();
    return RECEIVED + QUEUED;
  }
}

export type ProxyMiddlewareOpts = ClientOpts & { minRemaining: number };

export enum ProxyMiddlewareResponse {
  PROXY_ERROR = 600,
  NO_REQUESTS = 601
}

export default class ProxyMiddleware extends PassThrough {
  private readonly clients: Client[];
  private readonly options: ProxyMiddlewareOpts;

  constructor(tokens: string[], opts?: ProxyMiddlewareOpts) {
    super({ objectMode: true });

    if (!tokens.length) throw new Error('At least one token is required!');

    this.clients = [];
    this.options = Object.assign({ requestInterval: 250, requestTimeout: 20000 }, opts);

    tokens.forEach((token) => this.addToken(token));
  }

  // function to select the best client and queue request
  schedule(req: Request, res: Response): void {
    const client = shuffle(this.clients).reduce(
      (selected: Client | null, client) =>
        !selected || client.pending < selected.pending ? client : selected,
      null
    );

    if (!client || client.remaining <= this.options.minRemaining) {
      res.status(ProxyMiddlewareResponse.NO_REQUESTS).json({
        message: 'Proxy Server: no requests available',
        reset: min(this.clients.map((client) => client.reset))
      });
      return;
    }

    client.schedule(req, res);
  }

  removeToken(token: string): void {
    this.clients.splice(this.clients.map((c) => c.token).indexOf(token), 1).forEach((client) => {
      client.middleware.close();
      client.queue.stop();
      client.queue.disconnect();
      client.destroy();
    });
  }

  addToken(token: string): void {
    if (this.clients.map((client) => client.token).includes(token)) return;
    const client = new Client(token, this.options);
    client.pipe(this, { end: false });
    this.clients.push(client);
  }

  get tokens(): string[] {
    return this.clients.map((client) => client.token);
  }

  destroy(): void {
    this.clients.forEach((client) => this.removeToken(client.token));
  }
}
