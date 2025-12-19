#!/usr/bin/env node
/* Author: Hudson S. Borges */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import basicAuth from 'basic-auth';
import chalk from 'chalk';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime.js';
import express, { type Express, type Request, type Response } from 'express';
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
    pending: chunk.pending,
    remaining: chunk.remaining,
    reset: dayjs.unix(chunk.reset).fromNow(),
    duration: `${chunk.duration / 1000}s`,
    status: statusFormatter(chunk.status || '-')
  };

  return `${table([Object.values(data)], {
    columnDefault: { alignment: 'right', width: 5 },
    columns: {
      0: { width: 11 },
      1: { width: 5 },
      2: { width: 3 },
      3: { width: 5 },
      4: { width: 18 },
      5: { width: 7 },
      6: { width: `${chunk.status || '-'}`.length, alignment: 'left' }
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
  if (token.length !== 40)
    throw new Error('Invalid access token detected (they have 40 characters)');
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

export function createProxyServer(options: CliOpts): Express {
  const tokens = compact(options.tokens).reduce(
    (memo: string[], token: string) => concatTokens(token, memo),
    []
  );

  const app = express();

  if (options.auth) {
    app.use((req: Request, res: Response, next) => {
      if (req.path.startsWith('/status')) return next();

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
    app.use(
      swaggerStats.getMiddleware({
        name: 'GitHub Proxy Server',
        version: process.env.npm_package_version,
        uriPath: '/status'
      })
    );
  }

  const proxy = new ProxyRouter(tokens, {
    overrideAuthorization: options.overrideAuthorization ?? true,
    ...options
  });

  proxy.on('error', (message) => app.emit('error', message));

  if (!options.silent) {
    proxy.on('log', (data) => app.emit('log', logTransform(data)));
    proxy.on('warn', (message) => app.emit('warn', message));
  }

  function notSupported(req: Request, res: Response) {
    res.status(ProxyRouterResponse.PROXY_ERROR).send({ message: 'Endpoint not supported' });
  }

  app
    .post('/graphql', (req: Request, reply: Response) => proxy.schedule(req, reply))
    .get('/*', (req: Request, reply: Response) => proxy.schedule(req, reply));

  app.delete('/*', notSupported);
  app.patch('/*', notSupported);
  app.put('/*', notSupported);
  app.post('/*', notSupported);

  return app;
}
