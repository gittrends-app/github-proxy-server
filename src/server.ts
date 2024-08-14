#!/usr/bin/env node

/* Author: Hudson S. Borges */
import chalk from 'chalk';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime.js';
import express, { Express, Request, Response } from 'express';
import compact from 'lodash/compact.js';
import uniq from 'lodash/uniq.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import pinoPretty from 'pino-pretty';
import swaggerStats from 'swagger-stats';
import { TableUserConfig, getBorderCharacters, table } from 'table';

import ProxyRouter, { ProxyRouterOpts, ProxyRouterResponse, WorkerLogger } from './router.js';

dayjs.extend(relativeTime);

export class ProxyLogTransform extends Transform {
  private started = false;
  private config?: TableUserConfig;

  constructor() {
    super({ objectMode: true });

    this.config = {
      columnDefault: { alignment: 'right', width: 5 },
      columns: {
        0: { width: 11 },
        1: { width: 5 },
        2: { width: 3 },
        3: { width: 5 },
        4: { width: 18 },
        5: { width: 4 },
        6: { width: 7 }
      },
      border: getBorderCharacters('void'),
      singleLine: true
    };
  }

  _transform(chunk: WorkerLogger, encoding: string, done: (error?: Error) => void): void {
    const data = {
      resource: chunk.resource,
      token: chunk.token,
      pending: chunk.pending,
      remaining: chunk.remaining,
      reset: dayjs.unix(chunk.reset).fromNow(),
      status: chalk[/(?![23])\d{3}/i.test(`${chunk.status}`) ? 'redBright' : 'green'](chunk.status),
      duration: `${chunk.duration / 1000}s`
    };

    if (!this.started) {
      this.started = true;
      this.push(
        chalk.bold('Columns: ') +
          Object.keys(data)
            .map((v) => chalk.underline(v))
            .join(', ') +
          '\n\n'
      );
    }

    this.push(table([Object.values(data)], this.config).trimEnd() + '\n');

    done();
  }
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
};

export function createProxyServer(options: CliOpts): Express {
  const tokens = compact(options.tokens).reduce(
    (memo: string[], token: string) => concatTokens(token, memo),
    []
  );

  const app = express();

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

  if (!options.silent)
    proxy.pipe(new ProxyLogTransform().on('data', (data) => app.emit('log', data)));

  function notSupported(req: Request, res: Response) {
    res.status(ProxyRouterResponse.PROXY_ERROR).send({ message: `Endpoint not supported` });
  }

  app
    .post('/graphql', (req: Request, reply: Response) => proxy.schedule(req, reply))
    .get('/*', (req: Request, reply: Response) => proxy.schedule(req, reply));

  app.delete('/*', notSupported);
  app.patch('/*', notSupported);
  app.put('/*', notSupported);
  app.post('/*', notSupported);

  tokens.map((token) =>
    fetch('https://api.github.com/user', {
      headers: {
        authorization: `token ${token}`,
        'user-agent': 'GitHub API Proxy Server (@hsborges/github-proxy-server)'
      }
    }).then((response) => {
      if (response.status !== 401) return response;
      proxy.removeToken(token);
      app.emit('warn', `Invalid token detected (${token}).`);
    })
  );

  return app;
}
