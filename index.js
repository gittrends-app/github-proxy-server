#!/usr/bin/env node

/* Author: Hudson S. Borges */
const fs = require('fs');
const path = require('path');
const https = require('https');
const polka = require('polka');
const consola = require('consola');
const send = require('@polka/send-type');
const bodyParser = require('body-parser');
const compression = require('compression');
const cliProgress = require('cli-progress');

const { uniq, pick, compact } = require('lodash');
const { program } = require('commander');

const loadBalancer = require('./load-balancer.js');
const formatter = require('./helpers/formatter');

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
  const filepath = path.resolve(process.cwd(), filename);
  if (!fs.existsSync(filepath)) throw new Error(`File "${filename}" not found!`);
  const tokens = tokensParser(fs.readFileSync(filepath, 'utf8'));
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
  .option('--verbose', 'Enable verbose mode')
  .parse(process.argv);

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
          new Promise((resolve) =>
            https.get(
              'https://api.github.com/user',
              {
                headers: {
                  authorization: `token ${token}`,
                  'user-agent': 'GitHub API Proxy Server (@hsborges/github-proxy-server)'
                }
              },
              ({ statusCode }) => resolve(statusCode === 200 ? token : null)
            )
          )
      )
    )
  );

  const balancer = loadBalancer(
    tokens,
    pick(program, ['requestInterval', 'requestTimeout', 'minRemaining', 'verbose'])
  );

  // create progress bars
  if (!program.verbose && process.stderr.isTTY) {
    const multibar = new cliProgress.MultiBar({
      format: '{version} |{bar}| {value} remaining | {queued} queued',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      clearOnComplete: false,
      hideCursor: true,
      formatValue: (v) =>
        `${v}`.padStart(Math.floor(Math.log10(balancer.clients.length * 5000)))
    });

    ['rest', 'graphql'].forEach((api) => {
      const bar = multibar.create();
      bar.start(0, 0, { version: api.padStart(7), queued: 0 });

      setInterval(() => {
        const { clients } = balancer;
        const rem = clients.reduce((a, c) => a + c[api].remaining, 0);
        const queued = clients.reduce((a, c) => a + c[api].queued(), 0);
        bar.update(rem, { queued });
        bar.setTotal(clients.reduce((a, c) => a + c[api].limit, 0));
      }, 500);
    });
  }

  // start proxy server
  const app = polka();

  app.use(compression());
  app.use(bodyParser.json());

  app.post('/graphql', balancer.graphql);
  app.get('/*', balancer.rest);
  app.all('/*', (req, res) =>
    send(res, 501, { message: 'Only GET requests are supported by the proxy server' })
  );

  app.listen(program.port, () => {
    consola.success(`Proxy server running on ${program.port} (tokens: ${tokens.length})`);
    consola.success(
      `Options: ${formatter.object(
        pick(program, ['requestInterval', 'requestTimeout', 'minRemaining', 'verbose'])
      )}`
    );
  });
})();
