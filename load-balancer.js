/* Author: Hudson S. Borges */
const Bottleneck = require('bottleneck');
const debug = require('debug')('github-proxy');

const { chain, omit, each, cloneDeep } = require('lodash');
const { createProxyMiddleware } = require('http-proxy-middleware');

const fakeReset = () => Math.floor(Date.now() / 1000) + 60 * 60;

module.exports = (
  tokens = [],
  { requestInterval = 100, requestTimeout = 15000, minRemaining = 100 } = {}
) => {
  // prepare clients
  const clients = tokens.map((token) => {
    const shortToken = token && token.substring(0, 4);

    const metadata = {
      rest: {
        remaining: 5000,
        reset: fakeReset(),
        bottleneck: new Bottleneck({ maxConcurrent: 1, minTime: requestInterval })
      },
      graphql: {
        remaining: 5000,
        reset: fakeReset(),
        bottleneck: new Bottleneck({ maxConcurrent: 1, minTime: requestInterval })
      }
    };

    setInterval(() => {
      each(metadata, (value) => {
        if (value.reset && Math.floor(Date.now() / 1000) > value.reset) {
          debug(`Rate limit reseted for ${shortToken}`);
          value.remaining = 5000;
          value.reset = fakeReset();
        }
      });
    }, 5000);

    const updateLimits = (version, headers) => {
      metadata[version].remaining = parseInt(headers['x-ratelimit-remaining'], 10);
      metadata[version].limit = parseInt(headers['x-ratelimit-limit'], 10);
      metadata[version].reset = parseInt(headers['x-ratelimit-reset'], 10);
    };

    const log = (version, status, startedAt) => {
      if (debug.enabled)
        debug('%o', {
          version,
          token: shortToken,
          queued: metadata[version].bottleneck.queued(),
          rateLimit: {
            remaining: metadata[version].remaining,
            reset: new Date(metadata[version].reset * 1000)
          },
          status,
          duration: `${(Date.now() - startedAt) / 1000}s`
        });
    };

    const apiProxy = createProxyMiddleware({
      target: 'https://api.github.com',
      changeOrigin: true,
      headers: { authorization: `token ${token}` },
      proxyTimeout: requestTimeout,
      followRedirects: true,
      logLevel: 'silent',
      onProxyReq(proxyReq, req) {
        req.headers.date = new Date();
        if (req.method === 'GET' && /^\/user\/?$/i.test(req.originalUrl))
          proxyReq.removeHeader('authorization');
        if (req.method === 'POST' && /^\/graphql\/?$/i.test(req.originalUrl)) {
          if (/viewer(.|\s)*{(.|\s)+}/i.test(req.body.query))
            proxyReq.removeHeader('authorization');
          const bodyData = JSON.stringify(req.body);
          proxyReq.setHeader('Content-Length', Buffer.byteLength(bodyData));
          proxyReq.write(bodyData);
        }
      },
      onProxyRes(proxyRes, req) {
        const version = req.path === '/graphql' ? 'graphql' : 'rest';
        req.emit('finished');
        updateLimits(version, proxyRes.headers);
        log(version, proxyRes.statusCode, req.headers.date);
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
      onError(err, req) {
        req.emit('finished', err);
      }
    });

    each(metadata, (value) => {
      const { bottleneck } = value;
      value.schedule = (req, res, next) =>
        bottleneck.schedule(
          () =>
            new Promise((resolve) => {
              apiProxy(req, res, next);
              req.on('close', resolve);
              req.on('finished', resolve);
            })
        );
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
      .minBy((c) => c.queued())
      .value();

    if (!client)
      return res.status(503).json({
        message: 'Proxy Server: no requests available',
        reset: chain(clients)
          .minBy((c) => c[version].reset)
          .get([version, 'reset'])
          .value()
      });

    return client[version].schedule(req, res, next);
  }

  // express config
  return {
    get clients() {
      return clients.map((c) => cloneDeep(omit(c, ['bottleneck', 'schedule'])));
    },
    graphql: (...args) => balancer('graphql', ...args),
    rest: (...args) => balancer('rest', ...args)
  };
};
