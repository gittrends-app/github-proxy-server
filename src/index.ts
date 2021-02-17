#!/usr/bin/env node
/* Author: Hudson S. Borges */
import https from 'https';
import consola from 'consola';
import chalk from 'chalk';
import { EventEmitter } from 'events';

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import timeout from 'connect-timeout';
import responseTime from 'response-time';
import statusMonitor from 'express-status-monitor';

import { resolve } from 'path';
import { program } from 'commander';
import { uniq, pick, compact } from 'lodash';
import { existsSync, readFileSync } from 'fs';
import { version } from './package.json';

import Proxy from './middleware';
import logger from './logger';

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
  .option('--api <api>', 'API version to proxy requests', APIVersion.GraphQL)
  .option('--tokens <file>', 'File containing a list of tokens', getTokens)
  .option('--request-interval <interval>', 'Interval between requests (ms)', Number, 250)
  .option('--request-timeout <timeout>', 'Request timeout (ms)', Number, 20000)
  .option('--connection-timeout <timeout>', 'Connection timeout (ms)', Number, 60000)
  .option('--min-remaining <number>', 'Stop using token on', Number, 100)
  .option('--silent', 'Dont show requests outputs')
  .version(version, '-v, --version', 'output the current version')
  .parse();

if (!program.token.length && !(program.tokens && program.tokens.length)) {
  consola.info(`${program.helpInformation()}`);
  consola.error(`Arguments missing (see "--token" and "--tokens").\n\n`);
  process.exit(1);
}

// create the load balancer
(async () => {
  // increase number os listeners
  EventEmitter.defaultMaxListeners = Number.MAX_SAFE_INTEGER;

  const tokens = compact([...program.token, ...(program.tokens || [])]);

  const options = pick(program, [
    'requestInterval',
    'requestTimeout',
    'connectionTimeout',
    'minRemaining'
  ]);

  const app = express();
  app.use(statusMonitor());
  app.use(cors());
  app.use(helmet());
  app.use(compression());
  app.use(responseTime());
  app.use(timeout(`${program.connectionTimeout / 1000}s`, { respond: true }));

  const proxy = new Proxy(tokens, options);

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
        consola.error(`Invalid token (${token}) detected!`);
        proxy.removeToken(token);
      }
    )
  );

  if (!program.silent) proxy.pipe(logger);

  if (program.api === APIVersion.GraphQL) app.post('/graphql', proxy.schedule.bind(proxy));
  else if (program.api === APIVersion.REST) app.get('/*', proxy.schedule.bind(proxy));

  app.all('/*', (req, res) => {
    res.status(401).json({ message: `Endpoint not supported for "${program.api}" api.` });
  });

  const server = app.listen(program.port, () => {
    consola.success(
      `Proxy server running on ${program.port} (tokens: ${chalk.greenBright(tokens.length)})`
    );
    consola.success(
      `${chalk.bold('Options')}: %s`,
      Object.entries({ ...options, ...pick(program, ['api', 'connectionTimeout']) })
        .sort((a: string[], b: string[]) => (a[0] > b[0] ? 1 : -1))
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
