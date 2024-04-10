#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createProxyServer = exports.readTokensFile = exports.parseTokens = exports.ProxyLogTransform = exports.APIVersion = void 0;
/* Author: Hudson S. Borges */
const axios_1 = __importDefault(require("axios"));
const chalk_1 = __importDefault(require("chalk"));
const commander_1 = require("commander");
const consola_1 = __importDefault(require("consola"));
const dayjs_1 = __importDefault(require("dayjs"));
const relativeTime_1 = __importDefault(require("dayjs/plugin/relativeTime"));
const dotenv_override_true_1 = require("dotenv-override-true");
const events_1 = require("events");
const express_1 = __importDefault(require("express"));
const fs_1 = require("fs");
const ip_1 = require("ip");
const lodash_1 = require("lodash");
const path_1 = require("path");
const pino_1 = __importDefault(require("pino"));
const pino_http_1 = __importDefault(require("pino-http"));
const pino_pretty_1 = __importDefault(require("pino-pretty"));
const stream_1 = require("stream");
const swagger_stats_1 = __importDefault(require("swagger-stats"));
const table_1 = require("table");
const router_1 = __importStar(require("./router"));
(0, dotenv_override_true_1.config)({ path: (0, path_1.resolve)(__dirname, '.env.version') });
dayjs_1.default.extend(relativeTime_1.default);
var APIVersion;
(function (APIVersion) {
    APIVersion["GraphQL"] = "graphql";
    APIVersion["REST"] = "rest";
})(APIVersion || (exports.APIVersion = APIVersion = {}));
class ProxyLogTransform extends stream_1.Transform {
    api;
    started = false;
    config;
    constructor(api) {
        super({ objectMode: true });
        this.api = api;
        this.config = {
            columnDefault: { alignment: 'right', width: 5 },
            columns: {
                0: { width: 7 },
                1: { width: 5 },
                2: { width: 3 },
                3: { width: 5 },
                4: { width: 18 },
                5: { width: 4 },
                6: { width: 7 }
            },
            border: (0, table_1.getBorderCharacters)('void'),
            singleLine: true
        };
    }
    _transform(chunk, encoding, done) {
        const data = {
            token: chunk.token,
            pending: chunk.pending,
            remaining: chunk.remaining,
            reset: dayjs_1.default.unix(chunk.reset).fromNow(),
            status: chalk_1.default[/(?![23])\d{3}/i.test(`${chunk.status}`) ? 'redBright' : 'green'](chunk.status),
            duration: `${chunk.duration / 1000}s`
        };
        if (!this.started) {
            this.started = true;
            this.push(chalk_1.default.bold('Columns: ') +
                ['api', ...Object.keys(data)].map((v) => chalk_1.default.underline(v)).join(', ') +
                '\n\n');
        }
        this.push((0, table_1.table)([[this.api, ...Object.values(data)]], this.config).trimEnd() + '\n');
        done();
    }
}
exports.ProxyLogTransform = ProxyLogTransform;
// parse tokens from input
function parseTokens(text) {
    return text
        .split(/\n/g)
        .map((v) => v.replace(/\s/g, ''))
        .reduce((acc, v) => {
        if (!v || /^(\/{2}|#).*/gi.test(v))
            return acc;
        return acc.concat([v.replace(/.*:(.+)/i, '$1')]);
    }, [])
        .reduce((acc, token) => concatTokens(token, acc), []);
}
exports.parseTokens = parseTokens;
// concat tokens in commander
function concatTokens(token, list) {
    if (token.length !== 40)
        throw new Error('Invalid access token detected (they have 40 characters)');
    return (0, lodash_1.uniq)([...list, token]);
}
// read tokens from a file
function readTokensFile(filename) {
    const filepath = (0, path_1.resolve)(process.cwd(), filename);
    if (!(0, fs_1.existsSync)(filepath))
        throw new Error(`File "${filename}" not found!`);
    return parseTokens((0, fs_1.readFileSync)(filepath, 'utf8'));
}
exports.readTokensFile = readTokensFile;
function createProxyServer(options) {
    const tokens = (0, lodash_1.compact)(options.tokens).reduce((memo, token) => concatTokens(token, memo), []);
    const app = (0, express_1.default)();
    if (process.env.DEBUG === 'true') {
        app.use((0, pino_http_1.default)({
            level: 'info',
            serializers: {
                req: (req) => ({ method: req.method, url: req.url }),
                res: ({ statusCode }) => ({ statusCode })
            },
            logger: (0, pino_1.default)((0, pino_pretty_1.default)({ colorize: true }))
        }));
    }
    if (options.statusMonitor) {
        app.use(swagger_stats_1.default.getMiddleware({
            name: 'GitHub Proxy Server',
            version: process.env.npm_package_version,
            uriPath: '/status'
        }));
    }
    const proxyInstances = Object.values(APIVersion).reduce((memo, version) => {
        const proxy = new router_1.default(tokens, {
            overrideAuthorization: options.overrideAuthorization ?? true,
            ...options
        });
        if (!options.silent)
            proxy.pipe(new ProxyLogTransform(version).on('data', (data) => app.emit('log', data)));
        return { ...memo, [version]: proxy };
    }, {});
    function notSupported(req, res) {
        res.status(router_1.ProxyRouterResponse.PROXY_ERROR).send({ message: `Endpoint not supported` });
    }
    app
        .post('/graphql', (req, reply) => proxyInstances[APIVersion.GraphQL].schedule(req, reply))
        .get('/*', (req, reply) => proxyInstances[APIVersion.REST].schedule(req, reply));
    app.delete('/*', notSupported);
    app.patch('/*', notSupported);
    app.put('/*', notSupported);
    app.post('/*', notSupported);
    tokens.map((token) => axios_1.default
        .get('https://api.github.com/user', {
        headers: {
            authorization: `token ${token}`,
            'user-agent': 'GitHub API Proxy Server (@hsborges/github-proxy-server)'
        }
    })
        .catch((error) => {
        if (error.response?.status !== 401)
            return;
        Object.values(proxyInstances).forEach((proxy) => proxy.removeToken(token));
        app.emit('warn', `Invalid token detected (${token}).`);
    }));
    return app;
}
exports.createProxyServer = createProxyServer;
// parse arguments from command line
if (require.main === module) {
    commander_1.program
        .addOption(new commander_1.Option('-p, --port [port]', 'Port to start the proxy server')
        .argParser(Number)
        .default(3000)
        .env('PORT'))
        .addOption(new commander_1.Option('-t, --token [token]', 'GitHub token to be used')
        .argParser(concatTokens)
        .default([]))
        .addOption(new commander_1.Option('--tokens [file]', 'File containing a list of tokens')
        .argParser(readTokensFile)
        .env('GPS_TOKENS_FILE'))
        .addOption(new commander_1.Option('--request-interval [interval]', 'Interval between requests (ms)')
        .argParser(Number)
        .default(250)
        .env('GPS_REQUEST_INTERVAL'))
        .addOption(new commander_1.Option('--request-timeout [timeout]', 'Request timeout (ms)')
        .argParser(Number)
        .default(30000)
        .env('GPS_REQUEST_TIMEOUT'))
        .addOption(new commander_1.Option('--min-remaining <number>', 'Stop using token on a minimum of')
        .argParser(Number)
        .default(100)
        .env('GPS_MIN_REMAINING'))
        .addOption(new commander_1.Option('--clustering', '(clustering) enable clustering (requires redis)')
        .default(false)
        .env('GPS_CLUSTERING_HOST'))
        .addOption(new commander_1.Option('--clustering-host [host]', '(clustering) redis host')
        .implies({ clustering: true })
        .default('localhost')
        .env('GPS_CLUSTERING_HOST'))
        .addOption(new commander_1.Option('--clustering-port [port]', '(clustering) redis port')
        .argParser(Number)
        .implies({ clustering: true })
        .default(6379)
        .env('GPS_CLUSTERING_PORT'))
        .addOption(new commander_1.Option('--clustering-db [db]', '(clustering) redis db')
        .argParser(Number)
        .implies({ clustering: true })
        .default(0)
        .env('GPS_CLUSTERING_DB'))
        .addOption(new commander_1.Option('--silent', 'Dont show requests outputs'))
        .addOption(new commander_1.Option('--no-override-authorization', 'By default, the authorization header is overrided with a configured token'))
        .addOption(new commander_1.Option('--no-status-monitor', 'Disable requests monitoring on /status'))
        .version(process.env.npm_package_version || '?', '-v, --version', 'output the current version')
        .parse();
    const options = commander_1.program.opts();
    if (!options.token.length && !(options.tokens && options.tokens.length)) {
        consola_1.default.info(`${commander_1.program.helpInformation()}`);
        consola_1.default.error(`Arguments missing ("--token" or "--tokens" is mandatory).\n\n`);
        process.exit(1);
    }
    events_1.EventEmitter.defaultMaxListeners = Number.MAX_SAFE_INTEGER;
    (async () => {
        const tokens = [...options.token, ...(options.tokens || [])].reduce((memo, token) => concatTokens(token, memo), []);
        const appOptions = {
            requestInterval: options.requestInterval,
            requestTimeout: options.requestTimeout,
            silent: options.silent,
            overrideAuthorization: options.overrideAuthorization,
            tokens: tokens,
            clustering: options.clustering
                ? {
                    host: options.clusteringHost,
                    port: options.clusteringPort,
                    db: options.clusteringDb
                }
                : undefined,
            minRemaining: options.minRemaining,
            statusMonitor: options.statusMonitor
        };
        const app = createProxyServer(appOptions);
        app.on('warn', consola_1.default.warn).on('log', (data) => process.stdout.write(data.toString()));
        const server = app.listen({ host: '0.0.0.0', port: options.port }, (error) => {
            if (error) {
                consola_1.default.error(error);
                process.exit(1);
            }
            const host = `http://${(0, ip_1.address)()}:${options.port}`;
            consola_1.default.success(`Proxy server running on ${host} (tokens: ${chalk_1.default.greenBright(tokens.length)})`);
            function formatObject(object) {
                return Object.entries((0, lodash_1.omitBy)(object, (value) => (0, lodash_1.isNil)(value)))
                    .sort((a, b) => (a[0] > b[0] ? 1 : -1))
                    .map(([k, v]) => `${k}: ${(0, lodash_1.isObjectLike)(v)
                    ? `{ ${formatObject(v)} }`
                    : chalk_1.default.greenBright(v)}`)
                    .join(', ');
            }
            consola_1.default.success(`${chalk_1.default.bold('Options')}: %s`, formatObject((0, lodash_1.omit)(appOptions, ['token', 'tokens'])));
        });
        process.on('SIGTERM', async () => {
            consola_1.default.info('SIGTERM signal received: closing HTTP server');
            server.close((err) => {
                if (err) {
                    consola_1.default.error(err);
                    process.exit(1);
                }
                consola_1.default.success('Server closed');
                process.exit(0);
            });
        });
    })();
}
