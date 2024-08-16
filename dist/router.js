/* Author: Hudson S. Borges */
import Bottleneck from 'bottleneck';
import { default as proxy } from 'http-proxy';
import { StatusCodes } from 'http-status-codes';
import minBy from 'lodash/minBy.js';
import EventEmitter from 'node:events';
class ProxyWorker extends EventEmitter {
    queue;
    proxy;
    token;
    schedule;
    defaults;
    remaining;
    reset = Date.now() / 1000;
    constructor(token, opts) {
        super({});
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
        fetch('https://api.github.com/rate_limit', {
            headers: {
                authorization: `token ${token}`,
                'user-agent': 'GitHub API Proxy Server (@hsborges/github-proxy-server)'
            }
        }).then(async (response) => {
            if (response.status === 401) {
                this.remaining = 0;
                this.reset = Infinity;
                this.emit('warn', `Invalid token detected (${token}).`);
            }
            else {
                const res = (await response.json());
                this.remaining = res.resources[opts.resource].limit;
                this.reset = res.resources[opts.resource].reset;
            }
        });
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
            if (this.remaining-- <= opts.minRemaining) {
                this.emit('retry', req, res);
                return;
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
            this.remaining = parseInt(headers['x-ratelimit-remaining'], 10) - this.pending;
            this.reset = parseInt(headers['x-ratelimit-reset'], 10);
        }
    }
    log(status, startedAt) {
        this.emit('log', {
            resource: this.defaults.resource,
            token: this.token.slice(-4),
            pending: this.queued,
            remaining: this.remaining,
            reset: this.reset,
            status: status,
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
    destroy() {
        this.proxy.close();
        return this;
    }
}
export var ProxyRouterResponse;
(function (ProxyRouterResponse) {
    ProxyRouterResponse[ProxyRouterResponse["PROXY_ERROR"] = 600] = "PROXY_ERROR";
})(ProxyRouterResponse || (ProxyRouterResponse = {}));
export default class ProxyRouter extends EventEmitter {
    clients;
    options;
    constructor(tokens, opts) {
        super({});
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
        const available = clients.filter((client) => client.actualRemaining > (isSearch ? 1 : this.options.minRemaining));
        if (available.length === 0) {
            setTimeout(() => this.schedule(req, res), Math.max(0, Math.min(...clients.map((c) => c.reset)) * 1000 - Date.now()) + 1000);
            return;
        }
        else {
            const worker = minBy(available, (client) => client.pending + 1 / client.remaining);
            return worker.schedule(req, res);
        }
    }
    addToken(token) {
        if (this.clients.map((client) => client.token).includes(token))
            return;
        const core = new ProxyWorker(token, { ...this.options, resource: 'core' });
        const search = new ProxyWorker(token, { ...this.options, resource: 'search' });
        const codeSearch = new ProxyWorker(token, { ...this.options, resource: 'code_search' });
        const graphql = new ProxyWorker(token, { ...this.options, resource: 'graphql' });
        for (const worker of [core, search, codeSearch, graphql]) {
            worker.on('log', (log) => this.emit('log', log));
            worker.on('retry', (req, res) => this.schedule(req, res));
        }
        this.clients.push({ token, core, search, code_search: codeSearch, graphql });
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
    get tokens() {
        return this.clients.map((client) => client.token);
    }
    destroy() {
        this.clients.forEach((client) => this.removeToken(client.token));
        return this;
    }
}
