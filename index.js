#!/usr/bin/env node
/* Author: Hudson S. Borges */
const cors = require('cors');
const https = require('https');
const polka = require('polka');
const helmet = require('helmet');
const consola = require('consola');
const bodyParser = require('body-parser');
const compression = require('compression');
const timeout = require('connect-timeout');
const responseTime = require('response-time');

const { resolve } = require('path');
const { program } = require('commander');
const { uniq, pick, compact } = require('lodash');
const { existsSync, readFileSync } = require('fs');

const { version } = require('./package.json');
const middleware = require('./middleware');
const logger = require('./helpers/logger');
const send = require('./helpers/send');

// function to parse tokens from the input
const tokensParser = (string) =>
  string
    .trim()
    .replace(/\s+/gi, ' ')
    .split(/[\s]/i)
    .map((v) => v.replace(/.*:(.+)/i, '$1'));

// function to concat tokens in commander
const concatTokens = (token, list) => {
  if (token.length !== 40) throw new Error('Github access tokens have 40 characters');
  return uniq([...list, token]);
};

// function to read tokens from a file
const getTokens = (filename) => {
  const filepath = resolve(process.cwd(), filename);
  if (!existsSync(filepath)) throw new Error(`File "${filename}" not found!`);
  const tokens = tokensParser(readFileSync(filepath, 'utf8'));
  return tokens.reduce((acc, token) => concatTokens(token, acc), []);
};

// parse arguments from command line
program
  .option('-p, --port <port>', 'Port to start the proxy server', 3000)
  .option('-t, --token <token>', 'GitHub token to be used', concatTokens, [])
  .option('--tokens <file>', 'File containing a list of tokens', getTokens)
  .option('--request-interval <interval>', 'Interval between requests (ms)', Number, 100)
  .option('--request-timeout <timeout>', 'Request timeout (ms)', Number, 15000)
  .option('--min-remaining <number>', 'Stop using token on', Number, 100)
  .version(version, '-v, --version', 'output the current version')
  .parse();

if (!program.token.length && !(program.tokens && program.tokens.length)) {
  consola.info(`${program.helpInformation()}`);
  consola.error(`Arguments missing (see "--token" and "--tokens").\n\n`);
  process.exit(1);
}

// create the load balancer
(async () => {
  const tokens = compact(
    await Promise.all(
      [...program.token, ...(program.tokens || [])].map(
        (token) =>
          new Promise((r) =>
            https.get(
              'https://api.github.com/user',
              {
                headers: {
                  authorization: `token ${token}`,
                  'user-agent': 'GitHub API Proxy Server (@hsborges/github-proxy-server)'
                }
              },
              ({ statusCode }) => r(statusCode === 200 ? token : null)
            )
          )
      )
    )
  );

  const options = pick(program, ['requestInterval', 'minRemaining', 'verbose']);

  const app = polka();
  const balancer = middleware(tokens, options);

  balancer.pipe(logger);

  app.use(cors());
  app.use(helmet());
  app.use(compression());
  app.use(responseTime());
  app.use(bodyParser.json());
  app.use(timeout(`${program.requestTimeout / 1000}s`));

  app.post('/graphql', balancer.graphql);
  app.get('/*', balancer.rest);
  app.all('/*', (req, res) => {
    send(res, 401, { message: 'Only GET requests are supported by the server.' });
  });

  app.listen(program.port, () => {
    consola.success(`Proxy server running on ${program.port} (tokens: ${tokens.length})`);
    consola.success(
      `Options: %s`,
      Object.keys(options)
        .map((k) => `${k}: ${options[k]}`)
        .join(', ')
    );
  });

  process.on('SIGTERM', async () => {
    consola.info('SIGTERM signal received: closing HTTP server');

    app.server.close(() => {
      consola.success('Server closed');
      process.exit(0);
    });

    setTimeout(() => process.exit(1), 10 * 1000);
  });
})();
