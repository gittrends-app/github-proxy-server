#!/usr/bin/env node

/* Author: Hudson S. Borges */
import axios from 'axios';
import chalk from 'chalk';
import { Option, program } from 'commander';
import consola from 'consola';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { config } from 'dotenv-override-true';
import { EventEmitter } from 'events';
import express, { Express, Request, Response } from 'express';
import { existsSync, readFileSync } from 'fs';
import { address } from 'ip';
import { compact, isNil, isObjectLike, omit, omitBy, uniq } from 'lodash';
import { resolve } from 'path';
import pino from 'pino';
import pinoHttp from 'pino-http';
import pinoPretty from 'pino-pretty';
import { Transform } from 'stream';
import swaggerStats from 'swagger-stats';
import { TableUserConfig, getBorderCharacters, table } from 'table';

import ProxyRouter, { ProxyRouterOpts, ProxyRouterResponse, WorkerLogger } from './router';

config({ path: resolve(__dirname, '.env.version') });
dayjs.extend(relativeTime);

export enum APIVersion {
  GraphQL = 'graphql',
  REST = 'rest'
}

export class ProxyLogTransform extends Transform {
  private started = false;
  private config?: TableUserConfig;

  constructor(private api: APIVersion) {
    super({ objectMode: true });

    this.config = {
      columnDefault: { alignment: 'right', width: 5 },
      columns: {
        0: { width: 7 },
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

  _transform(
    chunk: WorkerLogger & { api: string },
    encoding: string,
    done: (error?: Error) => void
  ): void {
    const data = {
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
          ['api', ...Object.keys(data)].map((v) => chalk.underline(v)).join(', ') +
          '\n\n'
      );
    }

    this.push(table([[this.api, ...Object.values(data)]], this.config).trimEnd() + '\n');

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
function concatTokens(token: string, list: string[]): string[] {
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

  const proxyInstances: { [key: string]: ProxyRouter } = Object.values(APIVersion).reduce(
    (memo, version) => {
      const proxy = new ProxyRouter(tokens, {
        overrideAuthorization: options.overrideAuthorization ?? true,
        ...options
      });

      if (!options.silent)
        proxy.pipe(new ProxyLogTransform(version).on('data', (data) => app.emit('log', data)));

      return { ...memo, [version]: proxy };
    },
    {}
  );

  function notSupported(req: Request, res: Response) {
    res.status(ProxyRouterResponse.PROXY_ERROR).send({ message: `Endpoint not supported` });
  }

  app.delete('/*', notSupported);
  app.patch('/*', notSupported);
  app.put('/*', notSupported);

  app
    .post('/graphql', (req: Request, reply: Response) =>
      proxyInstances[APIVersion.GraphQL].schedule(req, reply)
    )
    .get('/*', (req: Request, reply: Response) =>
      proxyInstances[APIVersion.REST].schedule(req, reply)
    );

  tokens.map((token) =>
    axios
      .get('https://api.github.com/user', {
        headers: {
          authorization: `token ${token}`,
          'user-agent': 'GitHub API Proxy Server (@hsborges/github-proxy-server)'
        }
      })
      .catch((error) => {
        if (error.response?.status !== 401) return;
        Object.values(proxyInstances).forEach((proxy) => proxy.removeToken(token));
        app.emit('warn', `Invalid token detected (${token}).`);
      })
  );

  return app;
}

// parse arguments from command line
if (require.main === module) {
  program
    .addOption(
      new Option('-p, --port [port]', 'Port to start the proxy server')
        .argParser(Number)
        .default(3000)
        .env('PORT')
    )
    .addOption(
      new Option('-t, --token [token]', 'GitHub token to be used')
        .argParser(concatTokens)
        .default([])
    )
    .addOption(
      new Option('--tokens [file]', 'File containing a list of tokens')
        .argParser(readTokensFile)
        .env('GPS_TOKENS_FILE')
    )
    .addOption(
      new Option('--request-interval [interval]', 'Interval between requests (ms)')
        .argParser(Number)
        .default(250)
        .env('GPS_REQUEST_INTERVAL')
    )
    .addOption(
      new Option('--request-timeout [timeout]', 'Request timeout (ms)')
        .argParser(Number)
        .default(30000)
        .env('GPS_REQUEST_TIMEOUT')
    )
    .addOption(
      new Option('--min-remaining <number>', 'Stop using token on a minimum of')
        .argParser(Number)
        .default(100)
        .env('GPS_MIN_REMAINING')
    )
    .addOption(
      new Option('--clustering', '(clustering) enable clustering (requires redis)')
        .default(false)
        .env('GPS_CLUSTERING_HOST')
    )
    .addOption(
      new Option('--clustering-host [host]', '(clustering) redis host')
        .implies({ clustering: true })
        .default('localhost')
        .env('GPS_CLUSTERING_HOST')
    )
    .addOption(
      new Option('--clustering-port [port]', '(clustering) redis port')
        .argParser(Number)
        .implies({ clustering: true })
        .default(6379)
        .env('GPS_CLUSTERING_PORT')
    )
    .addOption(
      new Option('--clustering-db [db]', '(clustering) redis db')
        .argParser(Number)
        .implies({ clustering: true })
        .default(0)
        .env('GPS_CLUSTERING_DB')
    )
    .addOption(new Option('--silent', 'Dont show requests outputs'))
    .addOption(
      new Option(
        '--no-override-authorization',
        'By default, the authorization header is overrided with a configured token'
      )
    )
    .addOption(new Option('--no-status-monitor', 'Disable requests monitoring on /status'))
    .version(process.env.npm_package_version || '?', '-v, --version', 'output the current version')
    .parse();

  const options = program.opts();

  if (!options.token.length && !(options.tokens && options.tokens.length)) {
    consola.info(`${program.helpInformation()}`);
    consola.error(`Arguments missing ("--token" or "--tokens" is mandatory).\n\n`);
    process.exit(1);
  }

  EventEmitter.defaultMaxListeners = Number.MAX_SAFE_INTEGER;

  (async () => {
    const tokens = [...options.token, ...(options.tokens || [])].reduce(
      (memo: string[], token: string) => concatTokens(token, memo),
      []
    );

    const appOptions: CliOpts = {
      requestInterval: options.requestInterval,
      requestTimeout: options.requestTimeout,
      silent: options.silent,
      overrideAuthorization: options.overrideAuthorization,
      tokens: tokens,
      clustering: options.clustering
        ? {
            host: options.clusteringHost,
            port: options.clusteringPort,
            db: options.clusteringDb
          }
        : undefined,
      minRemaining: options.minRemaining,
      statusMonitor: options.statusMonitor
    };

    const app = createProxyServer(appOptions);

    app.on('warn', consola.warn).on('log', (data) => process.stdout.write(data.toString()));

    const server = app.listen({ host: '0.0.0.0', port: options.port }, (error?: Error) => {
      if (error) {
        consola.error(error);
        process.exit(1);
      }

      const host = `http://${address()}:${options.port}`;
      consola.success(
        `Proxy server running on ${host} (tokens: ${chalk.greenBright(tokens.length)})`
      );

      function formatObject(object: Record<string, unknown>): string {
        return Object.entries(omitBy(object, (value) => isNil(value)))
          .sort((a: [string, unknown], b: [string, unknown]) => (a[0] > b[0] ? 1 : -1))
          .map(
            ([k, v]) =>
              `${k}: ${
                isObjectLike(v)
                  ? `{ ${formatObject(v as Record<string, unknown>)} }`
                  : chalk.greenBright(v)
              }`
          )
          .join(', ');
      }

      consola.success(
        `${chalk.bold('Options')}: %s`,
        formatObject(omit(appOptions, ['token', 'tokens']))
      );
    });

    process.on('SIGTERM', async () => {
      consola.info('SIGTERM signal received: closing HTTP server');

      server.close((err?: Error) => {
        if (err) {
          consola.error(err);
          process.exit(1);
        }

        consola.success('Server closed');
        process.exit(0);
      });
    });
  })();
}
