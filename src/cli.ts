#!/usr/bin/env node

/* Author: Hudson S. Borges */
import chalk from 'chalk';
import { Option, program } from 'commander';
import consola from 'consola';
import { EventEmitter } from 'events';
import ip from 'ip';
import isNil from 'lodash/isNil.js';
import isObjectLike from 'lodash/isObjectLike.js';
import omit from 'lodash/omit.js';
import omitBy from 'lodash/omitBy.js';
import { pathToFileURL } from 'url';

import packageJson from '../package.json' with { type: "json" };
import { CliOpts, concatTokens, createProxyServer, readTokensFile } from './server.js';

// parse arguments from command line
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
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
    .version(packageJson.version || '?', '-v, --version', 'output the current version')
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

      const host = `http://${ip.address()}:${options.port}`;
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
