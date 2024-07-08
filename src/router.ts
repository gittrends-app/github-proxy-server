/* eslint-disable @typescript-eslint/no-duplicate-enum-values */

/* Author: Hudson S. Borges */
import Bottleneck from 'bottleneck';
import { Request, Response } from 'express';
import { ClientRequest, IncomingMessage } from 'http';
import Server, { createProxyServer } from 'http-proxy';
import { min, shuffle } from 'lodash';
import { PassThrough, Readable } from 'stream';

type ProxyWorkerOpts = {
  requestTimeout: number;
  requestInterval: number;
  overrideAuthorization?: boolean;
  clustering?: {
    host: string;
    port: number;
    db: number;
  };
};

type ExtendedRequest = Request & {
  startedAt?: Date;
  proxyRequest?: ClientRequest;
};

type ExtendedIncomingMessage = IncomingMessage & {
  startedAt?: Date;
  hasAuthorization?: boolean;
  proxyRequest?: ClientRequest;
};

export interface WorkerLogger {
  token: string;
  pending: number;
  remaining: number;
  reset: number;
  status: number;
  duration: number;
}

class ProxyWorker extends Readable {
  readonly queue: Bottleneck;

  readonly proxy: Server;
  readonly token: string;
  readonly schedule;

  limit = 5000;
  remaining: number;
  reset: number;
  resetTimeout?: ReturnType<typeof setTimeout>;

  constructor(token: string, opts: ProxyWorkerOpts) {
    super({ objectMode: true, read: () => null });
    this.token = token;
    this.remaining = 5000;
    this.reset = (Date.now() + 1000 * 60 * 60) / 1000;

    this.proxy = createProxyServer({
      target: 'https://api.github.com',
      proxyTimeout: opts.requestTimeout,
      ws: false,
      xfwd: true,
      changeOrigin: true
    });

    this.proxy.on('proxyReq', (proxyReq, req: ExtendedIncomingMessage) => {
      req.proxyRequest = proxyReq;
      req.startedAt = new Date();
      req.hasAuthorization = opts.overrideAuthorization
        ? false
        : proxyReq.hasHeader('authorization');

      if (!req.hasAuthorization) proxyReq.setHeader('authorization', `token ${token}`);
    });

    this.proxy.on('proxyRes', (proxyRes, req: ExtendedIncomingMessage) => {
      const replaceURL = (url: string): string =>
        req.headers.host
          ? url.replaceAll('https://api.github.com', `http://${req.headers.host}`)
          : url;

      proxyRes.headers.link =
        proxyRes.headers.link &&
        (Array.isArray(proxyRes.headers.link)
          ? proxyRes.headers.link.map(replaceURL)
          : replaceURL(proxyRes.headers.link));

      if (req.hasAuthorization) return;

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

    this.schedule = this.queue.wrap(async (req: ExtendedRequest, res: Response): Promise<void> => {
      if (req.socket.destroyed) return this.log();

      await new Promise((resolve, reject) => {
        req.socket.on('close', resolve);
        this.proxy.web(req, res as never, undefined, (error) => reject(error));
      })
        .catch(async (error) => {
          this.log(ProxyRouterResponse.PROXY_ERROR, req.startedAt);

          if (!req.socket.destroyed && !req.socket.writableFinished)
            res.status(ProxyRouterResponse.PROXY_ERROR).send(error);

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

  log(status?: number, startedAt?: Date): void {
    this.push({
      token: this.token.slice(-4),
      pending: this.queued,
      remaining: this.remaining,
      reset: this.reset,
      status: status || '-',
      duration: startedAt ? Date.now() - startedAt.getTime() : 0
    } as WorkerLogger);
  }

  get pending(): number {
    const { RECEIVED, QUEUED, RUNNING, EXECUTING } = this.queue.counts();
    return RECEIVED + QUEUED + RUNNING + EXECUTING;
  }

  get queued(): number {
    const { RECEIVED, QUEUED } = this.queue.counts();
    return RECEIVED + QUEUED;
  }

  get actualRemaining(): number {
    return this.remaining - this.pending;
  }

  destroy(error?: Error): this {
    this.proxy.close();
    super.destroy(error);
    return this;
  }
}

export type ProxyRouterOpts = ProxyWorkerOpts & { minRemaining: number };

export enum ProxyRouterResponse {
  PROXY_ERROR = 600,
  NO_REQUESTS = 600
}

export default class ProxyRouter extends PassThrough {
  private readonly clients: ProxyWorker[];
  private readonly options: ProxyRouterOpts;

  constructor(tokens: string[], opts?: ProxyRouterOpts) {
    super({ objectMode: true });

    if (!tokens.length) throw new Error('At least one token is required!');

    this.clients = [];
    this.options = Object.assign({ requestInterval: 250, requestTimeout: 20000 }, opts);

    tokens.forEach((token) => this.addToken(token));
  }

  // function to select the best client and queue request
  async schedule(req: Request, res: Response): Promise<void> {
    const client = shuffle(this.clients).reduce(
      (selected: ProxyWorker | null, client) =>
        !selected ||
        (client.actualRemaining > this.options.minRemaining && client.pending < selected.pending)
          ? client
          : selected,
      null
    );

    if (!client || client.remaining <= this.options.minRemaining) {
      res.status(ProxyRouterResponse.NO_REQUESTS).json({
        message: 'Proxy Server: no requests available',
        reset: min(this.clients.map((client) => client.reset))
      });
      return;
    }

    return client.schedule(req, res);
  }

  removeToken(token: string): void {
    this.clients.splice(this.clients.map((c) => c.token).indexOf(token), 1).forEach((client) => {
      client.proxy.close();
      client.queue.stop({ dropWaitingJobs: false });
      client.queue.disconnect();
      client.destroy();
    });
  }

  addToken(token: string): void {
    if (this.clients.map((client) => client.token).includes(token)) return;
    const client = new ProxyWorker(token, this.options);
    client.pipe(this, { end: false });
    this.clients.push(client);
  }

  get tokens(): string[] {
    return this.clients.map((client) => client.token);
  }

  destroy(error?: Error): this {
    this.clients.forEach((client) => this.removeToken(client.token));
    super.destroy(error);
    return this;
  }
}
