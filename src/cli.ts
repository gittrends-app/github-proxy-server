#!/usr/bin/env node

/* Author: Hudson S. Borges */
import chalk from 'chalk';
import { Option, program } from 'commander';
import consola from 'consola';
import { config } from 'dotenv-override-true';
import { EventEmitter } from 'events';
import express from 'express';
import statusMonitor from 'express-status-monitor';
import { existsSync, readFileSync } from 'fs';
import https from 'https';
import { address } from 'ip';
import { compact, isNil, negate, pick, uniq } from 'lodash';
import { resolve } from 'path';

import ProxyLogger from './logger';
import ProxyMiddleware, { ProxyMiddlewareOpts } from './middleware';

config({ path: resolve(__dirname, '.env.version') });

// parse tokens from input
function tokensParser(text: string): string[] {
  return text
    .split(/\n/g)
    .map((v) => v.replace(/\s/g, ''))
    .reduce((acc: string[], v: string) => {
      if (!v || /^(\/{2}|#).*/gi.test(v)) return acc;
      return acc.concat([v.replace(/.*:(.+)/i, '$1')]);
    }, []);
}

// concat tokens in commander
function concatTokens(token: string, list: string[]): string[] {
  if (token.length !== 40) throw new Error('Github access tokens have 40 characters');
  return uniq([...list, token]);
}

// read tokens from a file
function getTokens(filename: string): string[] {
  const filepath = resolve(process.cwd(), filename);
  if (!existsSync(filepath)) throw new Error(`File "${filename}" not found!`);
  const tokens = tokensParser(readFileSync(filepath, 'utf8'));
  return tokens.reduce((acc: string[], token: string) => concatTokens(token, acc), []);
}

enum APIVersion {
  GraphQL = 'graphql',
  REST = 'rest'
}

// parse arguments from command line
program
  .option(
    '-p, --port <port>',
    'Port to start the proxy server',
    Number,
    parseInt(process.env.PORT || '3000', 10)
  )
  .option('-t, --token <token>', 'GitHub token to be used', concatTokens, [])
  .addOption(
    new Option('--api <api>', 'API version to proxy requests')
      .choices([APIVersion.GraphQL, APIVersion.REST])
      .default(APIVersion.GraphQL)
      .argParser((value) => value.toLowerCase())
  )
  .option('--tokens <file>', 'File containing a list of tokens', getTokens)
  .option('--request-interval <interval>', 'Interval between requests (ms)', Number, 250)
  .option('--request-timeout <timeout>', 'Request timeout (ms)', Number, 20000)
  .option('--min-remaining <number>', 'Stop using token on', Number, 100)
  .option('--clustering', 'Enable clustering mode (require redis)')
  .option('--clustering-redis-host <host>', '(clustering) redis host', 'localhost')
  .option('--clustering-redis-port <port>', '(clustering) redis port', Number, 6379)
  .option('--clustering-redis-db <db>', '(clustering) redis db', Number, 0)
  .option('--silent', 'Dont show requests outputs')
  .version(process.env.npm_package_version || '?', '-v, --version', 'output the current version')
  .parse();

const options = program.opts();

if (!options.token.length && !(options.tokens && options.tokens.length)) {
  consola.info(`${program.helpInformation()}`);
  consola.error(`Arguments missing (see "--token" and "--tokens").\n\n`);
  process.exit(1);
}

// create the load balancer
(async () => {
  // increase number os listeners
  EventEmitter.defaultMaxListeners = Number.MAX_SAFE_INTEGER;

  const tokens = compact([...options.token, ...(options.tokens || [])]);

  const middlewareOpts: ProxyMiddlewareOpts = {
    requestInterval: options.requestInterval,
    requestTimeout: options.requestTimeout,
    minRemaining: options.minRemaining,
    clustering: options.clustering
      ? {
          host: options.clusteringRedisHost,
          port: options.clusteringRedisPort,
          db: options.clusteringRedisDb
        }
      : undefined
  };

  const app = express();
  app.use(
    statusMonitor({
      healthChecks: [{ protocol: 'https', host: 'api.github.com', path: '/', port: 443 }]
    })
  );

  const proxy = new ProxyMiddleware(tokens, middlewareOpts);

  tokens.map((token) =>
    https.get(
      'https://api.github.com/user',
      {
        headers: {
          authorization: `token ${token}`,
          'user-agent': 'GitHub API Proxy Server (@hsborges/github-proxy-server)'
        }
      },
      ({ statusCode }) => {
        if (statusCode === 200) return;
        consola.warn(`Invalid token (${token}) detected!`);
        proxy.removeToken(token);
      }
    )
  );

  if (!options.silent) proxy.pipe(new ProxyLogger());

  if (options.api === APIVersion.GraphQL) app.post('/graphql', proxy.schedule.bind(proxy));
  else if (options.api === APIVersion.REST) app.get('/*', proxy.schedule.bind(proxy));

  app.all('/*', (req, res) => {
    res.status(401).json({ message: `Endpoint not supported for "${options.api}" api.` });
  });

  const server = app.listen(options.port);

  server.on('error', (error) => {
    consola.error(error);
    server.close();
    process.exit(1);
  });

  server.on('listening', () => {
    const host = `http://${address()}:${options.port}`;
    consola.success(
      `Proxy server running on ${host} (tokens: ${chalk.greenBright(tokens.length)})`
    );
    consola.success(
      `${chalk.bold('Options')}: %s`,
      Object.entries({
        ...middlewareOpts,
        clustering: !!middlewareOpts.clustering,
        ...pick(options, ['api'])
      })
        .filter(([, vaue]) => negate(isNil)(vaue))
        .sort((a: [string, unknown], b: [string, unknown]) => (a[0] > b[0] ? 1 : -1))
        .map(([k, v]) => `${k}: ${chalk.greenBright(v)}`)
        .join(', ')
    );
  });

  process.on('SIGTERM', async () => {
    consola.info('SIGTERM signal received: closing HTTP server');

    server.close(() => {
      consola.success('Server closed');
      process.exit(0);
    });

    setTimeout(() => process.exit(1), 10 * 1000);
  });
})();
