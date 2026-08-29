#!/usr/bin/env node
/* Author: Hudson S. Borges */
import { pathToFileURL } from 'node:url';

import chalk from 'chalk';
import { Command, Option } from 'commander';
import consola from 'consola';
import ip from 'ip';
import isNil from 'lodash/isNil.js';
import isObjectLike from 'lodash/isObjectLike.js';
import omit from 'lodash/omit.js';
import omitBy from 'lodash/omitBy.js';

import packageJson from '../package.json' with { type: 'json' };
import {
  parseExternalBaseUrl,
  parseMaxQueueDepthPerWorker,
  parseMaxRequestBodyBytes,
  parseMinRemaining,
  parsePort,
  parseQueueWaitTimeout,
  parseRequestLifetimeTimeout,
  parseRequestTimeout,
  parseTimeBudgetMultiplier
} from './router.js';
import { type CliOpts, concatTokens, createProxyServer, readTokensFile } from './server.js';

export const PARTIAL_AUTHENTICATION_ERROR =
  'Authentication requires both username and password when configured.';

export function createAuthConfiguration(
  username: string | undefined,
  password: string | undefined
): CliOpts['auth'] {
  const hasUsername = username !== undefined;
  const hasPassword = password !== undefined;

  if (hasUsername !== hasPassword) {
    throw new Error(PARTIAL_AUTHENTICATION_ERROR);
  }

  return hasUsername && hasPassword ? { username, password } : undefined;
}

export function createCli(): Command {
  const program = new Command();

  return program
    .addOption(
      new Option('-p, --port [port]', 'Port to start the proxy server')
        .argParser(parsePort)
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
      new Option('--request-timeout [timeout]', 'Request timeout (ms)')
        .argParser(parseRequestTimeout)
        .default(30000)
        .env('GPS_REQUEST_TIMEOUT')
    )
    .addOption(
      new Option('--min-remaining <number>', 'Stop using token on a minimum of')
        .argParser(parseMinRemaining)
        .default(100)
        .env('GPS_MIN_REMAINING')
    )
    .addOption(
      new Option('--max-request-body-bytes [bytes]', 'Maximum request body size (bytes)')
        .argParser(parseMaxRequestBodyBytes)
        .default(1024 * 1024)
        .env('GPS_MAX_REQUEST_BODY_BYTES')
    )
    .addOption(
      new Option('--max-queue-depth [depth]', 'Maximum queued requests per worker')
        .argParser(parseMaxQueueDepthPerWorker)
        .default(50)
        .env('GPS_MAX_QUEUE_DEPTH')
    )
    .addOption(
      new Option('--queue-wait-timeout [timeout]', 'Maximum queue wait (ms)')
        .argParser(parseQueueWaitTimeout)
        .default(30000)
        .env('GPS_QUEUE_WAIT_TIMEOUT')
    )
    .addOption(
      new Option('--request-lifetime-timeout [timeout]', 'Maximum request lifetime (ms)')
        .argParser(parseRequestLifetimeTimeout)
        .default(120000)
        .env('GPS_REQUEST_LIFETIME_TIMEOUT')
    )
    .addOption(
      new Option('--time-budget-multiplier [multiplier]', 'Time budget multiplier (>= 1.0)')
        .argParser(parseTimeBudgetMultiplier)
        .default(1)
        .env('GPS_TIME_BUDGET_MULTIPLIER')
    )
    .addOption(
      new Option('--external-base-url <url>', 'Trusted external HTTP(S) base URL')
        .argParser(parseExternalBaseUrl)
        .env('GPS_EXTERNAL_BASE_URL')
    )
    .addOption(new Option('--silent', "Don't show request output").env('GPS_SILENT'))
    .addOption(
      new Option(
        '--no-override-authorization',
        'By default, the authorization header is overridden with a configured token'
      )
    )
    .addOption(
      new Option('--auth-username [username]', 'Proxy authentication username').env(
        'GPS_AUTH_USERNAME'
      )
    )
    .addOption(
      new Option('--auth-password [password]', 'Proxy authentication password').env(
        'GPS_AUTH_PASSWORD'
      )
    )
    .addOption(new Option('--no-status-monitor', 'Disable requests monitoring on /metrics'))
    .version(packageJson.version || '?', '-v, --version', 'output the current version')
    .action(async (options) => {
      let auth: CliOpts['auth'];
      try {
        auth = createAuthConfiguration(options.authUsername, options.authPassword);
      } catch (error) {
        consola.error(error instanceof Error ? error.message : PARTIAL_AUTHENTICATION_ERROR);
        process.exit(1);
      }

      if (!options.token.length && !options.tokens?.length) {
        consola.info(`${program.helpInformation()}`);
        consola.error(`Arguments missing ("--token" or "--tokens" is mandatory).\n\n`);
        process.exit(1);
      }

      const tokens = [...options.token, ...(options.tokens || [])].reduce(
        (memo: string[], token: string) => concatTokens(token, memo),
        []
      );
      const port = parsePort(options.port);
      const requestTimeout = parseRequestTimeout(options.requestTimeout);
      const minRemaining = parseMinRemaining(options.minRemaining);
      const maxRequestBodyBytes = parseMaxRequestBodyBytes(options.maxRequestBodyBytes);
      const maxQueueDepthPerWorker = parseMaxQueueDepthPerWorker(options.maxQueueDepth);
      const queueWaitTimeout = parseQueueWaitTimeout(options.queueWaitTimeout);
      const requestLifetimeTimeout = parseRequestLifetimeTimeout(options.requestLifetimeTimeout);
      const timeBudgetMultiplier = parseTimeBudgetMultiplier(options.timeBudgetMultiplier);
      const externalBaseUrl = parseExternalBaseUrl(options.externalBaseUrl);

      const appOptions: CliOpts = {
        requestTimeout,
        silent: options.silent,
        overrideAuthorization: options.overrideAuthorization,
        tokens: tokens,
        minRemaining,
        maxRequestBodyBytes,
        maxQueueDepthPerWorker,
        queueWaitTimeout,
        requestLifetimeTimeout,
        timeBudgetMultiplier,
        externalBaseUrl,
        statusMonitor: options.statusMonitor,
        auth
      };

      const app = createProxyServer(appOptions);

      app
        .on('log', (data) => process.stdout.write(data.toString()))
        .on('warn', consola.warn)
        .on('error', consola.error);

      let startupReady = false;
      const server = app.listen({ host: '0.0.0.0', port }, () => {
        if (!server.listening) return;
        startupReady = true;
        const host = `http://${ip.address()}:${port}`;
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

      const closeServer = (): Promise<void> => {
        return new Promise<void>((resolve, reject) => {
          server.close((error?: Error) => {
            const code = (error as NodeJS.ErrnoException | undefined)?.code;
            if (error && code !== 'ERR_SERVER_NOT_RUNNING') {
              reject(error);
            } else {
              resolve();
            }
          });
        });
      };

      let shutdownPromise: Promise<void> | undefined;
      let handleSigterm: () => void;
      let handleSigint: () => void;

      const removeSignalHandlers = (): void => {
        process.off('SIGTERM', handleSigterm);
        process.off('SIGINT', handleSigint);
      };

      const dispose = async (exitCode: number, announce: boolean): Promise<void> => {
        // Start both operations before awaiting either so active requests can drain or abort.
        const serverClose = closeServer();
        const routerDestroy = app.destroy();
        const results = await Promise.allSettled([serverClose, routerDestroy]);
        const errors = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason);

        removeSignalHandlers();
        if (errors.length) {
          consola.error(new AggregateError(errors, 'Proxy server shutdown failed'));
          process.exit(1);
          return;
        }

        if (announce) consola.success('Server closed');
        process.exit(exitCode);
      };

      const shutdown = (): Promise<void> => {
        if (shutdownPromise) return shutdownPromise;

        shutdownPromise = dispose(0, true);

        return shutdownPromise;
      };

      const cleanupStartupFailure = async (startupError: Error): Promise<void> => {
        consola.error(startupError);
        if (!shutdownPromise) shutdownPromise = dispose(1, false);
        await shutdownPromise;
      };

      handleSigterm = (): void => {
        consola.info('SIGTERM signal received: closing HTTP server');
        void shutdown();
      };

      handleSigint = (): void => {
        consola.info('SIGINT signal received: closing HTTP server');
        void shutdown();
      };

      const handleServerError = (error: Error): void => {
        if (startupReady && server.listening) {
          consola.error(error);
          return;
        }
        void cleanupStartupFailure(error);
      };

      server.on('error', handleServerError);
      process.once('SIGTERM', handleSigterm);
      process.once('SIGINT', handleSigint);
    });
}

// parse arguments from command line
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  createCli().parse(process.argv);
}