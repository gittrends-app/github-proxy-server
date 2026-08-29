#!/usr/bin/env node
/* Author: Hudson S. Borges */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import basicAuth from 'basic-auth';
import chalk from 'chalk';
import compression from 'compression';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime.js';
import express, { type Express, type Request, type Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import compact from 'lodash/compact.js';
import uniq from 'lodash/uniq.js';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import pinoPretty from 'pino-pretty';
import swaggerStats from 'swagger-stats';
import { getBorderCharacters, table } from 'table';

import ProxyRouter, {
  type ProxyRouterOpts,
  ProxyRouterResponse,
  validateGitHubToken,
  validateProxyRouterOptions,
  type WorkerLogger
} from './router.js';

dayjs.extend(relativeTime);

function statusFormatter(status: number | string): string {
  switch (true) {
    case /[23]\d{2}/.test(`${status}`):
      return chalk.green(status);
    case /[4]\d{2}/.test(`${status}`):
      return chalk.yellow(status);
    default:
      return chalk.red(status);
  }
}

function logTransform(chunk: WorkerLogger): string {
  const data = {
    resource: chunk.resource,
    token: chunk.token,
    running: chunk.running,
    remaining: chunk.remaining,
    reset: dayjs.unix(chunk.reset).fromNow(),
    budget: chunk.timeBudget !== undefined ? `${(chunk.timeBudget / 1000).toFixed(1)}s` : '-',
    duration: `${chunk.duration / 1000}s`,
    status: statusFormatter(chunk.status || '-')
  };

  return `${table([Object.values(data)], {
    columnDefault: { alignment: 'right', width: 5 },
    columns: {
      0: { width: 11 },
      1: { width: 5 },
      2: { width: 5 },
      3: { width: 5 },
      4: { width: 18 },
      5: { width: 7 },
      6: { width: 7 },
      7: { width: `${chunk.status || '-'}`.length, alignment: 'left' }
    },
    border: getBorderCharacters('void'),
    singleLine: true
  }).trimEnd()}\n`;
}

// parse tokens from input
export function parseTokens(text: string): string[] {
  return text
    .split(/\n/g)
    .map((v) => v.replace(/\s/g, ''))
    .reduce((acc: string[], v: string) => {
      if (!v || /^(\/{2}|#).*/gi.test(v)) return acc;
      return acc.concat([v.replace(/.*:(.+)/i, '$1')]);
    }, [])
    .reduce((acc: string[], token: string) => concatTokens(token, acc), []);
}

// concat tokens in commander
export function concatTokens(token: string, list: string[]): string[] {
  validateGitHubToken(token);
  return uniq([...list, token]);
}

// read tokens from a file
export function readTokensFile(filename: string): string[] {
  const filepath = resolve(process.cwd(), filename);
  if (!existsSync(filepath)) throw new Error(`File "${filename}" not found!`);
  return parseTokens(readFileSync(filepath, 'utf8'));
}

export type CliOpts = ProxyRouterOpts & {
  tokens: string[];
  silent?: boolean;
  statusMonitor?: boolean;
  auth?: {
    username: string;
    password: string;
  };
};

export type ProxyServer = Express & {
  destroy(): Promise<void>;
};

export function createProxyServer(options: CliOpts): ProxyServer {
  const validatedOptions = validateProxyRouterOptions(options);

  const tokens = compact(options.tokens).reduce(
    (memo: string[], token: string) => concatTokens(token, memo),
    []
  );

  const app = express();

  app.disable('x-powered-by');

  app.use(
    compression({
      filter: (req, res) =>
        req.headers['x-no-compression'] ? false : compression.filter(req, res),
      level: 6
    })
  );

  app.get(['/status', '/status/'], (_req: Request, res: Response) => {
    res.status(StatusCodes.OK).json({ status: 'ok' });
  });

  // Keep the public health namespace separate from proxy and monitoring routes.
  app.use('/status', (_req: Request, res: Response) => {
    res.status(StatusCodes.NOT_FOUND).send({ message: 'Endpoint not found' });
  });

  if (options.auth) {
    app.use((req: Request, res: Response, next) => {
      if (req.path === '/status' || req.path === '/status/') return next();

      const credentials = basicAuth(req);

      if (
        !credentials ||
        credentials.name !== options.auth?.username ||
        credentials.pass !== options.auth?.password
      ) {
        res.set('WWW-Authenticate', 'Basic realm="GitHub Proxy Server"');
        return res.status(401).send({ message: 'Unauthorized' });
      }

      next();
    });
  }

  if (process.env.DEBUG === 'true') {
    app.use(
      pinoHttp({
        level: 'info',
        serializers: {
          req: (req) => ({ method: req.method, url: req.url }),
          res: ({ statusCode }) => ({ statusCode })
        },
        logger: pino(pinoPretty({ colorize: true }))
      }) as never
    );
  }

  if (options.statusMonitor) {
    const monitoringOptions = {
      name: 'GitHub Proxy Server',
      version: process.env.npm_package_version,
      uriPath: '/metrics',
      pathUI: '/metrics/ui',
      pathDist: '/metrics/dist',
      pathUX: '/metrics/ux',
      pathStats: '/metrics/stats',
      pathMetrics: '/metrics/metrics',
      pathLogout: '/metrics/logout'
    };
    app.use(swaggerStats.getMiddleware(monitoringOptions));
  } else {
    app.use('/metrics', (_req: Request, res: Response) => {
      res.status(StatusCodes.NOT_FOUND).send({ message: 'Monitoring disabled' });
    });
  }

  const proxy = new ProxyRouter(tokens, {
    overrideAuthorization: options.overrideAuthorization ?? true,
    ...validatedOptions
  });

  proxy.on('error', (message) => {
    if (app.listenerCount('error')) app.emit('error', message);
  });
  proxy.on('warn', (message) => app.emit('warn', message));

  if (!options.silent) {
    proxy.on('log', (data) => app.emit('log', logTransform(data)));
  }

  function notSupported(req: Request, res: Response) {
    res.status(ProxyRouterResponse.PROXY_ERROR).send({ message: 'Endpoint not supported' });
  }

  app
    .post('/graphql', (req: Request, reply: Response) => proxy.schedule(req, reply))
    .get('{/*path}', (req: Request, reply: Response) => proxy.schedule(req, reply));

  app.delete('{/*path}', notSupported);
  app.patch('{/*path}', notSupported);
  app.put('{/*path}', notSupported);
  app.post('{/*path}', notSupported);

  const proxyApp = app as ProxyServer;
  proxyApp.destroy = (): Promise<void> => proxy.destroy();

  return proxyApp;
}