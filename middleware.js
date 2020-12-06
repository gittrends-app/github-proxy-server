/* Author: Hudson S. Borges */
const async = require('async');
const dayjs = require('dayjs');
const consola = require('consola');
const send = require('@polka/send-type');

const { chain, omit, each, shuffle } = require('lodash');
const { createProxyMiddleware } = require('http-proxy-middleware');

const logger = require('./helpers/logger');

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = (
  tokens = [],
  { requestInterval = 100, requestTimeout = 15000, minRemaining = 100 } = {}
) => {
  // prepare clients
  let clients = tokens.map((token) => {
    const shortToken = token && token.substring(0, 4);

    const metadata = ['rest', 'graphql'].reduce(
      (obj, t) => ({
        ...obj,
        [t]: { remaining: 5000, reset: dayjs().add(1, 'hour').unix() }
      }),
      {}
    );

    setInterval(() => {
      each(metadata, (value) => {
        if (!value.reset || dayjs.unix(value.reset).isBefore()) {
          consola.debug(`Rate limit reseted for ${shortToken}`);
          value.remaining = 5000;
          value.reset = dayjs().add(1, 'hour').unix();
        }
      });
    }, 5000);

    function updateLimits(version, headers) {
      if (!headers['x-ratelimit-remaining']) return;
      if (/401/i.test(headers.status)) {
        if (parseInt(headers['x-ratelimit-limit'], 10) > 0) {
          metadata[version].remaining = 0;
          metadata[version].limit = 0;
          metadata[version].reset = dayjs().add(24, 'hours').unix();
        } else {
          metadata[version].remaining -= 1;
        }
      } else {
        metadata[version].remaining = parseInt(headers['x-ratelimit-remaining'], 10);
        metadata[version].limit = parseInt(headers['x-ratelimit-limit'], 10);
        metadata[version].reset = parseInt(headers['x-ratelimit-reset'], 10);
      }
    }

    function log(version, status, startedAt) {
      logger({
        api: version,
        token: shortToken,
        remaining: metadata[version].remaining,
        queued: metadata[version].queue.length(),
        reset: metadata[version].reset,
        status,
        duration: Date.now() - startedAt
      });
    }

    const apiProxy = createProxyMiddleware({
      target: 'https://api.github.com',
      changeOrigin: true,
      headers: { authorization: `token ${token}` },
      timeout: requestTimeout,
      proxyTimeout: requestTimeout,
      followRedirects: true,
      preserveHeaderKeyCase: true,
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
        try {
          if (res.writableEnded || res.socket.destroyed) return;
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Something went wrong. And we are reporting a custom error message.');
        } catch (error) {
          consola.error(error);
        }
      }
    });

    each(metadata, (value) => {
      value.queue = async.queue(
        async ({ req, res, next }) =>
          new Promise((resolve) => {
            if (req.socket.destroyed) {
              consola.warn('Client disconnected before proxing request.');
              return resolve();
            }
            res.on('close', resolve);
            res.on('finish', resolve);
            res.on('error', resolve);
            return apiProxy(req, res, next);
          })
            .timetout(requestTimeout)
            .finally(() => wait(requestInterval)),
        1
      );
      value.schedule = (req, res, next) => value.queue.push({ req, res, next });
      value.queued = () => value.queue.length();
    });

    return metadata;
  });

  // shuffle client to avoid requests concentration
  setInterval(() => (clients = shuffle(clients)), 15000);

  // function to select the best client and queue request
  function balancer(version, req, res, next) {
    const client = chain(clients)
      .filter((c) => c[version].remaining - c[version].queued() > minRemaining)
      .minBy((c) => c[version].queued())
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
    graphql: (...args) => balancer('graphql', ...args),
    rest: (...args) => balancer('rest', ...args)
  };
};
