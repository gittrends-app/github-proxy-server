"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/* Author: Hudson S. Borges */
var dayjs_1 = __importDefault(require("dayjs"));
var consola_1 = __importDefault(require("consola"));
var lodash_1 = require("lodash");
var stream_1 = require("stream");
var async_1 = require("async");
var http_proxy_middleware_1 = require("http-proxy-middleware");
var Client = /** @class */ (function (_super) {
    __extends(Client, _super);
    function Client(token, opts) {
        var _this = _super.call(this, { objectMode: true, read: function () { return null; } }) || this;
        _this.limit = 5000;
        _this.token = token;
        _this.remaining = 5000;
        _this.reset = dayjs_1.default().add(1, 'hour').unix();
        _this.middleware = http_proxy_middleware_1.createProxyMiddleware({
            target: 'https://api.github.com',
            changeOrigin: true,
            headers: {
                authorization: "token " + token,
                'accept-encoding': 'gzip'
            },
            timeout: (opts === null || opts === void 0 ? void 0 : opts.requestTimeout) || 15000,
            onProxyReq: function (proxyReq, req) {
                req.headers.started_at = new Date().toISOString();
                if (req.method.toLowerCase() === 'post') {
                    var buffer = Buffer.from(JSON.stringify(req.body));
                    proxyReq.setHeader('content-length', Buffer.byteLength(buffer));
                    proxyReq.end(buffer);
                }
            },
            onProxyRes: function (proxyRes, req, res) {
                _this.updateLimits(res.getHeaders());
                _this.log(res.statusCode, dayjs_1.default(req.headers.started_at).toDate());
                proxyRes.headers['access-control-expose-headers'] = (proxyRes.headers['access-control-expose-headers'] || '')
                    .split(', ')
                    .filter(function (header) {
                    if (/(ratelimit|scope)/i.test(header)) {
                        delete proxyRes.headers[header.toLowerCase()];
                        return false;
                    }
                    return true;
                })
                    .join(', ');
            },
            logLevel: 'silent',
            logProvider: function () { return consola_1.default; }
        });
        _this.queue = async_1.queue(function (_a, callback) {
            var req = _a.req, res = _a.res, next = _a.next;
            if (req.timedout) {
                return callback(new Error('Request timedout'));
            }
            if (req.socket.destroyed) {
                return callback(new Error('Client disconnected before proxing request'));
            }
            return new Promise(function (resolve, reject) {
                req.socket.on('close', resolve);
                req.socket.on('error', reject);
                _this.middleware(req, res, next);
            })
                .then(function () { return new Promise(function (resolve) { return setTimeout(resolve, (opts === null || opts === void 0 ? void 0 : opts.requestInterval) || 100); }); })
                .then(function () { return callback(); })
                .catch(function (err) { return callback(err); });
        }, 1);
        return _this;
    }
    Client.prototype.updateLimits = function (headers) {
        if (!headers['x-ratelimit-remaining'])
            return;
    };
    Client.prototype.log = function (status, startedAt) {
        this.push({
            token: this.token.substring(0, 4),
            queued: this.queued,
            remaining: this.remaining,
            reset: this.reset,
            status: status,
            duration: Date.now() - startedAt.getTime()
        });
    };
    Client.prototype.schedule = function (req, res, next) {
        return this.queue.push({ req: req, res: res, next: next }, function (err) {
            if (err) {
                consola_1.default.warn(err.message || err);
                res.status(500).json({ message: err.message });
            }
        });
    };
    Object.defineProperty(Client.prototype, "queued", {
        get: function () {
            return this.queue.length();
        },
        enumerable: false,
        configurable: true
    });
    Object.defineProperty(Client.prototype, "running", {
        get: function () {
            return this.queue.running();
        },
        enumerable: false,
        configurable: true
    });
    return Client;
}(stream_1.Readable));
var Proxy = /** @class */ (function (_super) {
    __extends(Proxy, _super);
    function Proxy(tokens, opts) {
        var _this = _super.call(this, { objectMode: true }) || this;
        _this.requestInterval = (opts === null || opts === void 0 ? void 0 : opts.requestInterval) || 100;
        _this.requestTimeout = (opts === null || opts === void 0 ? void 0 : opts.requestTimeout) || 15000;
        _this.minRemaining = (opts === null || opts === void 0 ? void 0 : opts.minRemaining) || 100;
        _this.clients = tokens.map(function (token) {
            return new Client(token, {
                requestInterval: _this.requestInterval,
                requestTimeout: _this.requestTimeout
            });
        });
        _this.clients.forEach(function (client) { return client.pipe(_this, { end: false }); });
        return _this;
    }
    // function to select the best client and queue request
    Proxy.prototype.schedule = function (req, res, next) {
        var client = lodash_1.chain(this.clients)
            .shuffle()
            .minBy(function (client) { return client.running + client.queued; })
            .value();
        if (!client || client.remaining - client.queued < this.minRemaining) {
            res.status(503).json({
                message: 'Proxy Server: no requests available',
                reset: lodash_1.min(this.clients.map(function (client) { return client.reset; }))
            });
            return;
        }
        var requiresUserInformation = 
        // rest api
        (req.method === 'GET' && /^\/user\/?$/i.test(req.originalUrl)) ||
            // graphql api
            (req.method === 'POST' &&
                /^\/graphql\/?$/i.test(req.originalUrl) &&
                /\Wviewer(.|\s)*{(.|\s)+}/i.test(req.body.query));
        if (requiresUserInformation) {
            res.status(401).json({
                message: 'You cannot request information of the logged user.'
            });
            return;
        }
        return client.schedule(req, res, next);
    };
    Proxy.prototype.removeToken = function (token) {
        this.clients.splice(this.clients.map(function (c) { return c.token; }).indexOf(token), 1);
    };
    return Proxy;
}(stream_1.PassThrough));
exports.default = Proxy;
