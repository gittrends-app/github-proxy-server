/* Author: Hudson S. Borges */
const moment = require('moment');
const consola = require('consola');
const Promise = require('bluebird');
const Bottleneck = require('bottleneck');
const send = require('@polka/send-type');

const { chain, omit, each, cloneDeep } = require('lodash');
const { createProxyMiddleware } = require('http-proxy-middleware');

const formatter = require('./helpers/formatter');

module.exports = (
  tokens = [],
  {
    requestInterval = 100,
    requestTimeout = 15000,
    minRemaining = 100,
    verbose = false
  } = {}
) => {
  // prepare clients
  const clients = tokens.map((token) => {
    const shortToken = token && token.substring(0, 4);

    const metadata = {
      rest: {
        remaining: 5000,
        reset: moment().add(1, 'hour').unix(),
        bottleneck: new Bottleneck({
          maxConcurrent: 1,
          minTime: requestInterval,
          Promise
        })
      },
      graphql: {
        remaining: 5000,
        reset: moment().add(1, 'hour').unix(),
        bottleneck: new Bottleneck({
          maxConcurrent: 1,
          minTime: requestInterval,
          Promise
        })
      }
    };

    setInterval(() => {
      each(metadata, (value) => {
        if (!value.reset || !moment.unix(value.reset).isAfter(Date.now())) {
          consola.info(`Rate limit reseted for ${shortToken}`);
          value.remaining = 5000;
          value.reset = moment().add(1, 'hour').unix();
        }
      });
    }, 5000);

    const updateLimits = (version, headers) => {
      if (!headers['x-ratelimit-remaining']) return;
      if (/401/i.test(headers.status)) {
        if (parseInt(headers['x-ratelimit-limit'], 10) > 0) {
          metadata[version].remaining = 0;
          metadata[version].limit = 0;
          metadata[version].reset = moment().add(24, 'hours').unix();
        } else {
          metadata[version].remaining -= 1;
        }
      } else {
        metadata[version].remaining = parseInt(headers['x-ratelimit-remaining'], 10);
        metadata[version].limit = parseInt(headers['x-ratelimit-limit'], 10);
        metadata[version].reset = parseInt(headers['x-ratelimit-reset'], 10);
      }
    };

    const log = (version, status, startedAt) => {
      if (verbose)
        consola.info(
          formatter.object(
            {
              [version]: shortToken,
              queued: metadata[version].bottleneck.queued(),
              remaining: metadata[version].remaining,
              reset: moment.unix(metadata[version].reset).fromNow(),
              status,
              duration: `${(Date.now() - startedAt) / 1000}s`
            },
            { color: /[45]\d{2}/i.test(status) ? 'redBright' : 'green' }
          )
        );
    };

    const apiProxy = createProxyMiddleware({
      target: 'https://api.github.com',
      changeOrigin: true,
      headers: { authorization: `token ${token}` },
      timeout: requestTimeout,
      proxyTimeout: requestTimeout,
      followRedirects: true,
      logLevel: 'silent',
      onProxyReq(proxyReq, req) {
        req.started_at = new Date();
        if (req.method === 'POST') {
          const bodyData = JSON.stringify(req.body);
          proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
          proxyReq.write(bodyData);
        }
      },
      onProxyRes(proxyRes, req) {
        const version = req.path === '/graphql' ? 'graphql' : 'rest';
        updateLimits(version, proxyRes.headers);
        log(version, proxyRes.statusCode, req.started_at);
        Object.assign(proxyRes, {
          headers: omit(proxyRes.headers, [
            'x-ratelimit-limit',
            'x-ratelimit-remaining',
            'x-ratelimit-reset',
            'x-oauth-scopes',
            'x-oauth-client-id'
          ])
        });
      },
      onError(err, req, res) {
        if (res.writableEnded || res.socket.destroyed) return;
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Something went wrong. And we are reporting a custom error message.');
      }
    });

    each(metadata, (value) => {
      const { bottleneck } = value;
      value.schedule = async (req, res, next) => {
        return bottleneck.schedule(() =>
          new Promise((resolve) => {
            if (req.socket.destroyed) {
              consola.warn('Client disconnected before proxing request.');
              return resolve();
            }
            res.on('close', resolve);
            return apiProxy(req, res, next);
          })
            .timeout(requestTimeout)
            .catch(() => null)
        );
      };
      value.jobs = () => bottleneck.jobs().length;
      value.queued = () => bottleneck.queued();
    });

    return metadata;
  });

  // function to select the best client and queue request
  function balancer(version, req, res, next) {
    const client = chain(clients)
      .filter((c) => c[version].remaining - c[version].jobs() > minRemaining)
      .shuffle()
      .minBy((c) => c[version].jobs())
      .value();

    if (!client)
      return send(res, 503, {
        message: 'Proxy Server: no requests available',
        reset: chain(clients)
          .minBy((c) => c[version].reset)
          .get([version, 'reset'])
          .value()
      });

    const requiresUserInformation =
      // rest api
      (req.method === 'GET' && /^\/user\/?$/i.test(req.originalUrl)) ||
      // graphql api
      (req.method === 'POST' &&
        /^\/graphql\/?$/i.test(req.originalUrl) &&
        /\Wviewer(.|\s)*{(.|\s)+}/i.test(req.body.query));

    if (requiresUserInformation)
      return send(res, 401, {
        message: 'Proxy Server: you cannot request information of the logged user.'
      });

    return client[version].schedule(req, res, next);
  }

  return {
    get clients() {
      return clients.map((c) => cloneDeep(omit(c, ['bottleneck', 'schedule'])));
    },
    graphql: (...args) => balancer('graphql', ...args),
    rest: (...args) => balancer('rest', ...args)
  };
};
