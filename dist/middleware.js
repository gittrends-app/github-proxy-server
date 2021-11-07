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
exports.ProxyError = void 0;
/* Author: Hudson S. Borges */
const bottleneck_1 = __importDefault(require("bottleneck"));
const faker_1 = __importDefault(require("faker"));
const http_proxy_1 = require("http-proxy");
const lodash_1 = require("lodash");
const shuffle_1 = __importDefault(require("lodash/shuffle"));
const stream_1 = require("stream");
faker_1.default.seed(12345);
class ProxyError extends Error {
    constructor(m) {
        super(m);
        Object.setPrototypeOf(this, ProxyError.prototype);
    }
}
exports.ProxyError = ProxyError;
class Client extends stream_1.Readable {
    constructor(token, opts) {
        super({ objectMode: true, read: () => null });
        this.limit = 5000;
        this.token = token;
        this.remaining = 5000;
        this.reset = Date.now() + 1000 * 60 * 60;
        this.middleware = (0, http_proxy_1.createProxyServer)({
            target: 'https://api.github.com',
            headers: {
                Authorization: `token ${token}`,
                'User-Agent': faker_1.default.internet.userAgent()
            },
            proxyTimeout: opts === null || opts === void 0 ? void 0 : opts.requestTimeout,
            ws: false,
            xfwd: true,
            changeOrigin: true
        });
        this.middleware.on('proxyReq', (proxyReq, req) => {
            req.startedAt = new Date();
            req.proxyRequest = proxyReq;
        });
        this.middleware.on('proxyRes', (proxyRes, req) => {
            var _a;
            this.updateLimits(proxyRes.headers);
            this.log((_a = proxyRes.statusCode) !== null && _a !== void 0 ? _a : 0, req.startedAt);
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
            if (req.destroyed)
                return Promise.all([req.destroy(), this.log()]);
            yield new Promise((resolve, reject) => {
                res.on('close', resolve);
                req.on('aborted', () => reject(new ProxyError('Request aborted')));
                this.middleware.web(req, res, undefined, (error) => reject(error));
            })
                .catch((error) => __awaiter(this, void 0, void 0, function* () {
                var _a;
                this.log(600, req.startedAt);
                if (!(res.destroyed || res.headersSent)) {
                    res.status(600).json({ message: error.message });
                }
                (_a = req.proxyRequest) === null || _a === void 0 ? void 0 : _a.destroy();
            }))
                .finally(() => new Promise((resolve) => setTimeout(resolve, (opts === null || opts === void 0 ? void 0 : opts.requestInterval) || 0)));
        }));
    }
    updateLimits(headers) {
        return __awaiter(this, void 0, void 0, function* () {
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
                if (parseInt(headers['x-ratelimit-reset'], 10) === this.reset)
                    return;
                this.reset = parseInt(headers['x-ratelimit-reset'], 10);
                if (this.resetTimeout)
                    clearTimeout(this.resetTimeout);
                this.resetTimeout = setTimeout(() => (this.remaining = 5000), Math.max(0, this.reset * 1000 - Date.now()));
            }
        });
    }
    log(status, startedAt) {
        return __awaiter(this, void 0, void 0, function* () {
            this.push({
                token: this.token.substring(0, 4),
                queued: this.queued,
                remaining: this.remaining,
                reset: this.reset,
                status: status || '-',
                duration: startedAt ? Date.now() - startedAt.getTime() : 0
            });
        });
    }
    get queued() {
        const { RECEIVED, QUEUED } = this.queue.counts();
        return RECEIVED + QUEUED;
    }
    get running() {
        const { RUNNING, EXECUTING } = this.queue.counts();
        return RUNNING + EXECUTING;
    }
}
class ProxyMiddleware extends stream_1.PassThrough {
    constructor(tokens, opts) {
        super({ objectMode: true });
        if (!tokens.length)
            throw new Error('At least one token is required!');
        this.options = Object.assign({ requestInterval: 250, requestTimeout: 20000 }, opts);
        this.clients = (0, lodash_1.uniq)(tokens).map((token) => new Client(token, this.options));
        this.clients.forEach((client) => client.pipe(this, { end: false }));
    }
    // function to select the best client and queue request
    schedule(req, res) {
        var _a;
        const client = this.clients.length
            ? (0, shuffle_1.default)(this.clients).reduce((selected, client) => !selected || client.running === 0 || client.queued < selected.queued ? client : selected)
            : null;
        if (!client || client.remaining <= ((_a = this.options.minRemaining) !== null && _a !== void 0 ? _a : 0)) {
            res.status(503).json({
                message: 'Proxy Server: no requests available',
                reset: Math.min(...this.clients.map((client) => client.reset))
            });
            return;
        }
        client.schedule(req, res);
    }
    removeToken(token) {
        this.clients.splice(this.clients.map((c) => c.token).indexOf(token), 1);
    }
    addToken(token) {
        if (this.clients.map((client) => client.token).includes(token))
            return;
        this.clients.push(new Client(token, this.options));
    }
    get tokens() {
        return this.clients.map((client) => client.token);
    }
}
exports.default = ProxyMiddleware;
