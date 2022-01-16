"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyRouterResponse = void 0;
/* Author: Hudson S. Borges */
const bottleneck_1 = __importDefault(require("bottleneck"));
const http_proxy_1 = require("http-proxy");
const lodash_1 = require("lodash");
const stream_1 = require("stream");
class ProxyWorker extends stream_1.Readable {
    constructor(token, opts) {
        super({ objectMode: true, read: () => null });
        this.limit = 5000;
        this.token = token;
        this.remaining = 5000;
        this.reset = (Date.now() + 1000 * 60 * 60) / 1000;
        this.proxy = (0, http_proxy_1.createProxyServer)({
            target: 'https://api.github.com',
            headers: { Authorization: `token ${token}` },
            proxyTimeout: opts.requestTimeout,
            ws: false,
            xfwd: true,
            changeOrigin: true
        });
        this.proxy.on('proxyReq', (proxyReq, req) => {
            req.startedAt = new Date();
            req.proxyRequest = proxyReq;
        });
        this.proxy.on('proxyRes', (proxyRes, req) => {
            this.updateLimits(Object.assign({ status: `${proxyRes.statusCode}` }, proxyRes.headers));
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
        this.queue = new bottleneck_1.default(Object.assign({ maxConcurrent: 1, minTime: 0, id: `proxy_server:${this.token}` }, ((opts === null || opts === void 0 ? void 0 : opts.clustering)
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
            : { datastore: 'local' })));
        this.schedule = this.queue.wrap((req, res) => __awaiter(this, void 0, void 0, function* () {
            if (req.socket.destroyed)
                return this.log();
            yield new Promise((resolve, reject) => {
                req.socket.on('close', resolve);
                this.proxy.web(req.raw, res.raw, undefined, (error) => reject(error));
            })
                .catch((error) => __awaiter(this, void 0, void 0, function* () {
                var _a;
                this.log(ProxyRouterResponse.PROXY_ERROR, req.startedAt);
                if (!req.socket.destroyed && !req.socket.writableFinished)
                    res.status(ProxyRouterResponse.PROXY_ERROR).send(error);
                (_a = req.proxyRequest) === null || _a === void 0 ? void 0 : _a.destroy();
            }))
                .finally(() => new Promise((resolve) => setTimeout(resolve, opts.requestInterval)));
        }));
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
            token: this.token.substring(0, 4),
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
    destroy(error) {
        this.proxy.close();
        super.destroy(error);
        return this;
    }
}
var ProxyRouterResponse;
(function (ProxyRouterResponse) {
    ProxyRouterResponse[ProxyRouterResponse["PROXY_ERROR"] = 600] = "PROXY_ERROR";
    ProxyRouterResponse[ProxyRouterResponse["NO_REQUESTS"] = 600] = "NO_REQUESTS";
})(ProxyRouterResponse = exports.ProxyRouterResponse || (exports.ProxyRouterResponse = {}));
class ProxyRouter extends stream_1.PassThrough {
    constructor(tokens, opts) {
        super({ objectMode: true });
        if (!tokens.length)
            throw new Error('At least one token is required!');
        this.clients = [];
        this.options = Object.assign({ requestInterval: 250, requestTimeout: 20000 }, opts);
        tokens.forEach((token) => this.addToken(token));
    }
    // function to select the best client and queue request
    schedule(req, res) {
        return __awaiter(this, void 0, void 0, function* () {
            const client = (0, lodash_1.shuffle)(this.clients).reduce((selected, client) => !selected || client.pending < selected.pending ? client : selected, null);
            if (!client || client.remaining <= this.options.minRemaining) {
                return res.status(ProxyRouterResponse.NO_REQUESTS).send({
                    message: 'Proxy Server: no requests available',
                    reset: (0, lodash_1.min)(this.clients.map((client) => client.reset))
                });
            }
            return client.schedule(req, res);
        });
    }
    removeToken(token) {
        this.clients.splice(this.clients.map((c) => c.token).indexOf(token), 1).forEach((client) => {
            client.proxy.close();
            client.queue.stop();
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
exports.default = ProxyRouter;
