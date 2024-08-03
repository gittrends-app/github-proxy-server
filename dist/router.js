/* Author: Hudson S. Borges */
import Bottleneck from 'bottleneck';
import { default as proxy } from 'http-proxy';
import { StatusCodes } from 'http-status-codes';
import shuffle from 'lodash/shuffle.js';
import { PassThrough, Readable } from 'stream';
class ProxyWorker extends Readable {
    queue;
    proxy;
    token;
    schedule;
    limit = 5000;
    remaining;
    reset;
    resetTimeout;
    constructor(token, opts) {
        super({ objectMode: true, read: () => null });
        this.token = token;
        this.remaining = 5000;
        this.reset = (Date.now() + 1000 * 60 * 60) / 1000;
        this.proxy = proxy.createProxyServer({
            target: 'https://api.github.com',
            proxyTimeout: opts.requestTimeout,
            ws: false,
            xfwd: true,
            changeOrigin: true
        });
        this.proxy.on('proxyReq', (proxyReq, req) => {
            req.proxyRequest = proxyReq;
            req.startedAt = new Date();
            req.hasAuthorization = opts.overrideAuthorization
                ? false
                : proxyReq.hasHeader('authorization');
            if (!req.hasAuthorization)
                proxyReq.setHeader('authorization', `token ${token}`);
        });
        this.proxy.on('proxyRes', (proxyRes, req) => {
            const replaceURL = (url) => req.headers.host
                ? url.replaceAll('https://api.github.com', `http://${req.headers.host}`)
                : url;
            proxyRes.headers.link =
                proxyRes.headers.link &&
                    (Array.isArray(proxyRes.headers.link)
                        ? proxyRes.headers.link.map(replaceURL)
                        : replaceURL(proxyRes.headers.link));
            if (req.hasAuthorization)
                return;
            this.updateLimits({
                status: `${proxyRes.statusCode}`,
                ...proxyRes.headers
            });
            this.log(proxyRes.statusCode, req.startedAt);
            proxyRes.headers['access-control-expose-headers'] = (proxyRes.headers['access-control-expose-headers'] || '')
                .split(', ')
                .filter((header) => {
                if (/(ratelimit|scope)/i.test(header)) {
                    delete proxyRes.headers[header.toLowerCase()];
                    return false;
                }
                return true;
            })
                .join(', ');
        });
        this.queue = new Bottleneck({
            maxConcurrent: 1,
            minTime: 0,
            id: `proxy_server:${this.token}`,
            ...(opts?.clustering
                ? {
                    datastore: 'ioredis',
                    clearDatastore: false,
                    clientOptions: {
                        host: opts.clustering.host,
                        port: opts.clustering.port,
                        options: { db: opts.clustering.db }
                    },
                    timeout: opts.requestTimeout
                }
                : { datastore: 'local' })
        });
        this.schedule = this.queue.wrap(async (req, res) => {
            if (req.socket.destroyed)
                return this.log();
            await new Promise((resolve, reject) => {
                req.socket.on('close', resolve);
                this.proxy.web(req, res, undefined, (error) => reject(error));
            })
                .catch(async () => {
                this.log(ProxyRouterResponse.PROXY_ERROR, req.startedAt);
                if (!req.socket.destroyed && !req.socket.writableFinished) {
                    res.sendStatus(StatusCodes.BAD_GATEWAY);
                }
                req.proxyRequest?.destroy();
                res.destroy();
            })
                .finally(() => new Promise((resolve) => setTimeout(resolve, opts.requestInterval)));
        });
        this.on('close', () => this.resetTimeout && clearTimeout(this.resetTimeout));
    }
    updateLimits(headers) {
        if (!headers['x-ratelimit-remaining'])
            return;
        if (/401/i.test(headers.status)) {
            if (parseInt(headers['x-ratelimit-limit'], 10) > 0)
                this.remaining = 0;
            else
                this.remaining -= 1;
        }
        else {
            this.remaining = parseInt(headers['x-ratelimit-remaining'], 10);
            this.limit = parseInt(headers['x-ratelimit-limit'], 10);
            this.reset = parseInt(headers['x-ratelimit-reset'], 10);
            if (this.resetTimeout)
                clearTimeout(this.resetTimeout);
            const resetIn = Math.max(50, this.reset * 1000 - Date.now());
            this.resetTimeout = setTimeout(() => (this.remaining = 5000), resetIn);
        }
    }
    log(status, startedAt) {
        this.push({
            token: this.token.slice(-4),
            pending: this.queued,
            remaining: this.remaining,
            reset: this.reset,
            status: status || '-',
            duration: startedAt ? Date.now() - startedAt.getTime() : 0
        });
    }
    get pending() {
        const { RECEIVED, QUEUED, RUNNING, EXECUTING } = this.queue.counts();
        return RECEIVED + QUEUED + RUNNING + EXECUTING;
    }
    get queued() {
        const { RECEIVED, QUEUED } = this.queue.counts();
        return RECEIVED + QUEUED;
    }
    get actualRemaining() {
        return this.remaining - this.pending;
    }
    destroy(error) {
        this.proxy.close();
        super.destroy(error);
        return this;
    }
}
export var ProxyRouterResponse;
(function (ProxyRouterResponse) {
    ProxyRouterResponse[ProxyRouterResponse["PROXY_ERROR"] = 600] = "PROXY_ERROR";
})(ProxyRouterResponse || (ProxyRouterResponse = {}));
export default class ProxyRouter extends PassThrough {
    clients;
    options;
    constructor(tokens, opts) {
        super({ objectMode: true });
        if (!tokens.length)
            throw new Error('At least one token is required!');
        this.clients = [];
        this.options = Object.assign({ requestInterval: 250, requestTimeout: 20000 }, opts);
        tokens.forEach((token) => this.addToken(token));
    }
    // function to select the best client and queue request
    async schedule(req, res) {
        let client = null;
        while (true) {
            client = shuffle(this.clients).reduce((selected, client) => {
                if (client.actualRemaining <= this.options.minRemaining)
                    return selected;
                return !selected || client.pending < selected.pending ? client : selected;
            }, null);
            if (client)
                break;
            await new Promise((resolve) => setTimeout(resolve, 1000));
            if (req.closed)
                return;
        }
        return client.schedule(req, res);
    }
    removeToken(token) {
        this.clients.splice(this.clients.map((c) => c.token).indexOf(token), 1).forEach((client) => {
            client.proxy.close();
            client.queue.stop({ dropWaitingJobs: false });
            client.queue.disconnect();
            client.destroy();
        });
    }
    addToken(token) {
        if (this.clients.map((client) => client.token).includes(token))
            return;
        const client = new ProxyWorker(token, this.options);
        client.pipe(this, { end: false });
        this.clients.push(client);
    }
    get tokens() {
        return this.clients.map((client) => client.token);
    }
    destroy(error) {
        this.clients.forEach((client) => this.removeToken(client.token));
        super.destroy(error);
        return this;
    }
}
