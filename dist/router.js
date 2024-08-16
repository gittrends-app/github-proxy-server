/* Author: Hudson S. Borges */
import Bottleneck from 'bottleneck';
import { default as proxy } from 'http-proxy';
import { StatusCodes } from 'http-status-codes';
import minBy from 'lodash/minBy.js';
import { setTimeout as asyncSetTimeout } from 'node:timers/promises';
import { PassThrough, Readable } from 'stream';
class ProxyWorker extends Readable {
    queue;
    proxy;
    token;
    schedule;
    defaults;
    remaining;
    reset = Date.now() / 1000;
    constructor(token, opts) {
        super({ objectMode: true, read: () => null });
        this.token = token;
        switch (opts.resource) {
            case 'code_search':
                this.defaults = { resource: opts.resource, limit: 10, reset: 1000 * 60 };
                break;
            case 'search':
                this.defaults = { resource: opts.resource, limit: 30, reset: 1000 * 60 };
                break;
            case 'graphql':
            default:
                this.defaults = { resource: opts.resource, limit: 5000, reset: 1000 * 60 * 60 };
        }
        this.remaining = this.defaults.limit;
        this.proxy = proxy.createProxyServer({
            target: 'https://api.github.com',
            ws: false,
            xfwd: true,
            changeOrigin: true,
            autoRewrite: true,
            timeout: opts.requestTimeout,
            proxyTimeout: opts.requestTimeout
        });
        this.proxy.on('proxyReq', (proxyReq, req) => {
            req.proxyRequest = proxyReq;
            req.startedAt = new Date();
            req.hasAuthorization = opts.overrideAuthorization
                ? false
                : !!proxyReq.getHeader('authorization');
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
        const isSearch = ['search', 'code_search'].includes(opts.resource);
        this.queue = new Bottleneck({
            maxConcurrent: isSearch ? 1 : 10,
            minTime: isSearch ? 2000 : 1,
            id: `proxy_server:${opts.resource}:${this.token}`,
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
            if (--this.remaining <= opts.minRemaining && this.reset && this.reset * 1000 > Date.now()) {
                const resetIn = Math.max(0, this.reset * 1000 - Date.now()) + 1500;
                await asyncSetTimeout(Math.min(resetIn, this.defaults.reset));
            }
            await new Promise((resolve, reject) => {
                req.socket.on('close', resolve);
                req.socket.on('error', reject);
                this.proxy.web(req, res, undefined, (error) => reject(error));
            }).catch(async () => {
                this.log(ProxyRouterResponse.PROXY_ERROR, req.startedAt);
                if (!req.socket.destroyed && !req.socket.writableFinished) {
                    res.sendStatus(StatusCodes.BAD_GATEWAY);
                }
                req.proxyRequest?.destroy();
                res.destroy();
            });
        });
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
            this.reset = parseInt(headers['x-ratelimit-reset'], 10);
        }
    }
    log(status, startedAt) {
        this.push({
            resource: this.defaults.resource,
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
        this.options = Object.assign({ requestTimeout: 20000 }, opts);
        tokens.forEach((token) => this.addToken(token));
    }
    // function to select the best client and queue request
    async schedule(req, res) {
        const isGraphQL = req.path.startsWith('/graphql') && req.method === 'POST';
        const isCodeSearch = req.path.startsWith('/search/code');
        const isSearch = req.path.startsWith('/search');
        let clients;
        if (isGraphQL)
            clients = this.clients.map((client) => client.graphql);
        else if (isCodeSearch)
            clients = this.clients.map((client) => client.code_search);
        else if (isSearch)
            clients = this.clients.map((client) => client.search);
        else
            clients = this.clients.map((client) => client.core);
        const available = clients.filter((client) => client.actualRemaining > 0);
        const worker = minBy(available.length > 0 ? available : clients, (client) => client.pending + 1 / client.remaining);
        return worker.schedule(req, res);
    }
    removeToken(token) {
        this.clients.splice(this.clients.map((c) => c.token).indexOf(token), 1).forEach((client) => {
            for (const worker of [client.core, client.search, client.code_search, client.graphql]) {
                worker.proxy.close();
                worker.queue.stop({ dropWaitingJobs: false });
                worker.queue.disconnect();
                worker.destroy();
            }
        });
    }
    addToken(token) {
        if (this.clients.map((client) => client.token).includes(token))
            return;
        const core = new ProxyWorker(token, { ...this.options, resource: 'core' });
        const search = new ProxyWorker(token, { ...this.options, resource: 'search' });
        const codeSearch = new ProxyWorker(token, { ...this.options, resource: 'code_search' });
        const graphql = new ProxyWorker(token, { ...this.options, resource: 'graphql' });
        for (const worker of [core, search, codeSearch, graphql]) {
            worker.pipe(this, { end: false });
        }
        this.clients.push({ token, core, search, code_search: codeSearch, graphql });
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
