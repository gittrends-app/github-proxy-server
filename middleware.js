/* Author: Hudson S. Borges */
const async = require('async');
const dayjs = require('dayjs');
const axios = require('axios');
const consola = require('consola');

const { Readable } = require('stream');
const { chain, omit, each, shuffle } = require('lodash');

const send = require('./helpers/send');

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = (
  tokens = [],
  { requestInterval = 100, requestTimeout = 15000, minRemaining = 100 } = {}
) => {
  // create stream
  const stream = new Readable({ objectMode: true, read() {} });

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

    async function updateLimits(version, headers) {
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

    async function log(version, status, startedAt) {
      stream.push({
        api: version,
        token: shortToken,
        remaining: metadata[version].remaining,
        queued: metadata[version].queued(),
        reset: metadata[version].reset,
        status,
        duration: Date.now() - startedAt
      });
    }

    const client = axios.create({
      baseURL: 'https://api.github.com',
      timeout: requestTimeout,
      headers: {
        authorization: `token ${token}`,
        'accept-encoding': 'gzip'
      }
    });

    client.interceptors.request.use((config) => ({ ...config, started_at: new Date() }));

    client.interceptors.response.use((response) => {
      const version = response.request.path === '/graphql' ? 'graphql' : 'rest';
      updateLimits(version, response.headers);
      log(version, response.status, response.config.started_at);
      return response;
    });

    async function apiProxy(req, res) {
      return client
        .request({
          method: req.method,
          url: req.url,
          headers: omit(req.headers, ['host', 'connection', 'content-length']),
          data: req.body
        })
        .then(async (response) => {
          if (req.socket.destroyed)
            return consola.warn('Client disconnected after proxing request.');

          const compress = req.headers['accept-encoding'] === 'gzip';
          const headers = response.headers['access-control-expose-headers']
            .split(',')
            .reduce((acc, h) => {
              const key = h.trim().toLowerCase();
              const value = response.headers[key];
              return !value || /(ratelimit|scopes)/gi.test(key)
                ? acc
                : { ...acc, [key]: value };
            }, {});

          return send(res, response.status, response.data, { headers, compress });
        });
    }

    each(metadata, (value) => {
      const queue = async.queue(
        async.timeout(({ req, res }, callback) => {
          if (req.timedout) {
            consola.warn('Request timeout achived.');
            return callback();
          }

          if (req.socket.destroyed) {
            consola.warn('Client disconnected before proxing request.');
            return callback();
          }

          return apiProxy(req, res)
            .then(() => wait(requestInterval))
            .finally(callback);
        }, requestTimeout),
        1
      );

      value.schedule = (req, res, next) => queue.push({ req, res }, next);
      value.queued = queue.length.bind(queue);
      value.running = queue.running.bind(queue);
    });

    return metadata;
  });

  // shuffle client to avoid requests concentration
  setInterval(() => (clients = shuffle(clients)), 5000);

  // function to select the best client and queue request
  function balancer(version, req, res, next) {
    const client = chain(clients)
      .filter((c) => c[version].remaining - c[version].queued() > minRemaining)
      .minBy((c) => c[version].running() + c[version].queued())
      .value();

    if (!client) {
      return send(res, 503, {
        message: 'Proxy Server: no requests available',
        reset: chain(clients)
          .minBy((c) => c[version].reset)
          .get([version, 'reset'])
          .value()
      }).finally(next);
    }

    const requiresUserInformation =
      // rest api
      (req.method === 'GET' && /^\/user\/?$/i.test(req.originalUrl)) ||
      // graphql api
      (req.method === 'POST' &&
        /^\/graphql\/?$/i.test(req.originalUrl) &&
        /\Wviewer(.|\s)*{(.|\s)+}/i.test(req.body.query));

    if (requiresUserInformation) {
      return send(res, 401, {
        message: 'You cannot request information of the logged user.'
      }).finally(next);
    }

    return client[version].schedule(req, res, next);
  }

  stream.graphql = (...args) => balancer('graphql', ...args);
  stream.rest = (...args) => balancer('rest', ...args);

  return stream;
};
