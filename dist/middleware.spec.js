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
const globals_1 = require("@jest/globals");
const axios_1 = __importDefault(require("axios"));
const express_1 = __importDefault(require("express"));
const get_port_1 = __importDefault(require("get-port"));
const http_proxy_1 = __importDefault(require("http-proxy"));
const lodash_1 = require("lodash");
const utils_1 = require("ts-jest/utils");
const middleware_1 = __importDefault(require("./middleware"));
globals_1.jest.mock('http-proxy');
const mokedHttpProxy = (0, utils_1.mocked)(http_proxy_1.default, true);
let app;
let localServer;
let localServerPort;
let axiosClient;
(0, globals_1.beforeEach)(() => __awaiter(void 0, void 0, void 0, function* () {
    localServerPort = yield (0, get_port_1.default)();
    app = (0, express_1.default)();
    axiosClient = axios_1.default.create({ baseURL: `http://127.0.0.1:${localServerPort}` });
    localServer = yield new Promise((resolve) => {
        const s = app.listen(localServerPort, () => resolve(s));
    });
}));
(0, globals_1.afterEach)(() => __awaiter(void 0, void 0, void 0, function* () {
    return new Promise((resolve) => localServer.close(resolve));
}));
(0, globals_1.describe)('Middleware constructor and methods', () => {
    (0, globals_1.beforeEach)(() => {
        mokedHttpProxy.createProxyServer.mockImplementation((options) => {
            const { createProxyServer } = globals_1.jest.requireActual('http-proxy');
            return createProxyServer(options);
        });
    });
    (0, globals_1.test)('it should throw an error if no token is provided', () => {
        (0, globals_1.expect)(() => new middleware_1.default([])).toThrowError();
    });
    (0, globals_1.test)('it should remove/add tokens when requested', () => {
        const token = '1234567890';
        const middleware = new middleware_1.default([token]);
        middleware.removeToken(token);
        (0, globals_1.expect)(middleware.tokens).toHaveLength(0);
        middleware.addToken(token);
        (0, globals_1.expect)(middleware.tokens).toHaveLength(1);
    });
    (0, globals_1.test)('it should create only one client per token', () => {
        (0, globals_1.expect)(new middleware_1.default((0, lodash_1.times)(5, () => '1234567890')).tokens).toHaveLength(1);
    });
});
(0, globals_1.describe)('GitHub API is down or not reachable', () => {
    (0, globals_1.beforeEach)(() => __awaiter(void 0, void 0, void 0, function* () {
        const randomPort = yield (0, get_port_1.default)();
        mokedHttpProxy.createProxyServer.mockImplementation((options) => {
            const { createProxyServer } = globals_1.jest.requireActual('http-proxy');
            return createProxyServer(Object.assign(Object.assign({}, options), { target: `http://127.0.0.1:${randomPort}` }));
        });
        const middleware = new middleware_1.default(['1234567890'], { requestInterval: 0 });
        app.get('*', middleware.schedule.bind(middleware));
    }));
    (0, globals_1.test)('it should respond with Internal Server Error', () => __awaiter(void 0, void 0, void 0, function* () {
        return Promise.all((0, lodash_1.times)(25, () => axiosClient.get('/').catch((error) => {
            var _a, _b, _c;
            (0, globals_1.expect)((_a = error.response) === null || _a === void 0 ? void 0 : _a.status).toBe(600);
            (0, globals_1.expect)((_c = (_b = error.response) === null || _b === void 0 ? void 0 : _b.data) === null || _c === void 0 ? void 0 : _c.message).toMatch(/ECONNREFUSED/gi);
        })));
    }));
});
(0, globals_1.describe)('GitHub API is online', () => {
    let fakeAPI;
    let fakeAPIPort;
    let fakeAPIServer;
    let middleware;
    (0, globals_1.beforeEach)(() => __awaiter(void 0, void 0, void 0, function* () {
        fakeAPIPort = yield (0, get_port_1.default)();
        fakeAPI = (0, express_1.default)();
        fakeAPI.get('/success', (_, res) => res.status(200).send());
        fakeAPI.get('/redirect', (_, res) => res.redirect(300, '/'));
        fakeAPI.get('/client-error', (_, res) => res.status(400).send());
        fakeAPI.get('/server-error', (_, res) => res.status(500).send());
        fakeAPI.get('/too-long-request', (req, res) => setTimeout(() => res.status(200).send(), parseInt(req.query.delay || '1000', 10)));
        fakeAPI.get('/broken-request', (_, res) => setTimeout(() => res.destroy(), 100));
        fakeAPI.get('/drain-ratelimite', (_, res) => setTimeout(() => res
            .status(200)
            .set({
            'x-ratelimit-remaining': 0,
            'x-ratelimit-limit': 5000,
            'x-ratelimit-reset': (Date.now() + 2 * 1000) / 1000
        })
            .send(), 100));
        fakeAPIServer = yield new Promise((resolve) => {
            const s = fakeAPI.listen(fakeAPIPort, () => resolve(s));
        });
        mokedHttpProxy.createProxyServer.mockImplementation((options) => {
            const { createProxyServer } = globals_1.jest.requireActual('http-proxy');
            return createProxyServer(Object.assign(Object.assign({}, options), { target: `http://127.0.0.1:${fakeAPIPort}` }));
        });
        middleware = new middleware_1.default(['1234567890'], {
            requestTimeout: 500,
            requestInterval: 100
        });
        app.get('*', middleware.schedule.bind(middleware));
    }));
    (0, globals_1.afterEach)(() => __awaiter(void 0, void 0, void 0, function* () {
        yield new Promise((resolve) => fakeAPIServer.close(resolve));
    }));
    (0, globals_1.test)('it should respond with Service Unavailable if no requests available', () => __awaiter(void 0, void 0, void 0, function* () {
        middleware.removeToken('1234567890');
        yield Promise.all((0, lodash_1.times)(25, () => (0, globals_1.expect)(axiosClient.get('/success')).rejects.toHaveProperty('response.status', 503)));
        middleware.addToken('1234567890');
        yield axiosClient.get('/drain-ratelimite');
        return Promise.all((0, lodash_1.times)(25, () => (0, globals_1.expect)(axiosClient.get('/success')).rejects.toHaveProperty('response.status', 503)));
    }));
    (0, globals_1.test)('it should restore rate limite on reset time', () => __awaiter(void 0, void 0, void 0, function* () {
        for (let round = 0; round < 25; round++) {
            yield axiosClient.get('/drain-ratelimite');
            yield (0, globals_1.expect)(axiosClient.get('/success')).rejects.toHaveProperty('response.status', 503);
            yield new Promise((resolve) => setTimeout(() => (0, globals_1.expect)(axiosClient.get('/success'))
                .resolves.toBeDefined()
                .finally(() => resolve(1)), 2000));
        }
    }));
    (0, globals_1.test)('it should respect the interval between the requests', () => __awaiter(void 0, void 0, void 0, function* () {
        const init = Date.now();
        yield Promise.all((0, lodash_1.times)(25, (num) => {
            const reqInit = Date.now();
            return (0, globals_1.expect)(axiosClient.get('/success'))
                .resolves.toBeDefined()
                .finally(() => (0, globals_1.expect)(Date.now() - reqInit).toBeGreaterThanOrEqual(num > 1 ? 100 : 0));
        }));
        (0, globals_1.expect)(Date.now() - init).toBeGreaterThan(25 * 100);
    }));
    (0, globals_1.test)('it should forward responses received from GitHub', () => __awaiter(void 0, void 0, void 0, function* () {
        yield Promise.all((0, lodash_1.times)(25, () => Promise.all([
            axiosClient.get('/success').then(({ status }) => (0, globals_1.expect)(status).toEqual(200)),
            axiosClient
                .get('/redirect', { maxRedirects: 0 })
                .catch(({ response }) => (0, globals_1.expect)(response.status).toEqual(300)),
            axiosClient
                .get('/client-error')
                .catch(({ response }) => (0, globals_1.expect)(response.status).toEqual(400)),
            axiosClient
                .get('/server-error')
                .catch(({ response }) => (0, globals_1.expect)(response.status).toEqual(500))
        ])));
    }));
    (0, globals_1.test)('it should interrupt long requests', () => {
        return Promise.all((0, lodash_1.times)(25, () => (0, globals_1.expect)(axiosClient.get('/too-long-request')).rejects.toHaveProperty('response.status', 600)));
    });
    (0, globals_1.test)('it should respond to broken connections', () => {
        return Promise.all((0, lodash_1.times)(25, () => (0, globals_1.expect)(axiosClient.get('/broken-request')).rejects.toHaveProperty('response.status', 600)));
    });
    (0, globals_1.test)('it should not break when client disconnect', () => {
        return Promise.all((0, lodash_1.times)(25, () => {
            const source = axios_1.default.CancelToken.source();
            setTimeout(() => source.cancel('Operation canceled by the user.'), 250);
            return (0, globals_1.expect)(axiosClient.get('/too-long-request', { cancelToken: source.token })).rejects.not.toBeNull();
        }));
    });
});
