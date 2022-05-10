#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
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
const express_1 = __importDefault(require("@fastify/express"));
const axios_1 = __importDefault(require("axios"));
const chalk_1 = __importDefault(require("chalk"));
const commander_1 = require("commander");
const consola_1 = __importDefault(require("consola"));
const dayjs_1 = __importDefault(require("dayjs"));
const relativeTime_1 = __importDefault(require("dayjs/plugin/relativeTime"));
const dotenv_override_true_1 = require("dotenv-override-true");
const events_1 = require("events");
const express_status_monitor_1 = __importDefault(require("express-status-monitor"));
const fastify_1 = __importDefault(require("fastify"));
const fs_1 = require("fs");
const ip_1 = require("ip");
const lodash_1 = require("lodash");
const path_1 = require("path");
const stream_1 = require("stream");
const table_1 = require("table");
const router_1 = __importStar(require("./router"));
(0, dotenv_override_true_1.config)({ path: (0, path_1.resolve)(__dirname, '.env.version') });
dayjs_1.default.extend(relativeTime_1.default);
var APIVersion;
(function (APIVersion) {
    APIVersion["GraphQL"] = "graphql";
    APIVersion["REST"] = "rest";
})(APIVersion = exports.APIVersion || (exports.APIVersion = {}));
class ProxyLogTransform extends stream_1.Transform {
    started = false;
    config;
    constructor() {
        super({ objectMode: true });
        this.config = {
            columnDefault: { alignment: 'right', width: 5 },
            columns: {
                0: { width: 5 },
                1: { width: 3 },
                2: { width: 5 },
                3: { width: 18 },
                4: { width: 4 },
                5: { width: 7 }
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
                Object.keys(data)
                    .map((v) => chalk_1.default.underline(v))
                    .join(', ') +
                '\n\n');
        }
        this.push((0, table_1.table)([Object.values(data)], this.config).trimEnd() + '\n');
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
    const fastify = (0, fastify_1.default)({ logger: process.env.DEBUG == 'true' });
    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser('*', {}, (req, payload, done) => done(null, req.body));
    fastify.register(express_1.default).after(() => {
        fastify.use((0, express_status_monitor_1.default)({
            healthChecks: [{ protocol: 'https', host: 'api.github.com', path: '/', port: 443 }]
        }));
    });
    const proxy = new router_1.default(tokens, options);
    const scheduler = (req, reply) => {
        proxy.schedule(req, reply);
    };
    const defaultHandler = (req, res) => {
        res
            .status(router_1.ProxyRouterResponse.PROXY_ERROR)
            .send({ message: `Endpoint not supported for "${options.api}" api.` });
    };
    fastify.route({
        method: ['DELETE', 'PATCH', 'PUT'],
        url: '/*',
        handler: defaultHandler
    });
    if (options.api === APIVersion.GraphQL) {
        fastify.post('/graphql', scheduler).get('/*', defaultHandler);
    }
    else {
        fastify.get('/*', scheduler).post('/*', defaultHandler);
    }
    if (!options.silent)
        proxy.pipe(new ProxyLogTransform().on('data', (data) => fastify.server.emit('log', data)));
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
        proxy.removeToken(token);
        fastify.server.emit('warn', `Invalid token detected (${token}).`);
    }));
    return fastify;
}
exports.createProxyServer = createProxyServer;
// parse arguments from command line
if (require.main === module) {
    commander_1.program
        .option('-p, --port <port>', 'Port to start the proxy server', Number, parseInt(process.env.PORT || '3000', 10))
        .option('-t, --token <token>', 'GitHub token to be used', concatTokens, [])
        .addOption(new commander_1.Option('--api <api>', 'API version to proxy requests')
        .choices(Object.values(APIVersion))
        .default(APIVersion.GraphQL)
        .argParser((value) => value.toLowerCase()))
        .addOption(new commander_1.Option('--tokens <file>', 'File containing a list of tokens')
        .argParser(readTokensFile)
        .default(process.env.GPS_TOKENS_FILE))
        .option('--request-interval <interval>', 'Interval between requests (ms)', Number, parseInt(process.env.GPS_REQUEST_INTERVAL || '250', 10))
        .option('--request-timeout <timeout>', 'Request timeout (ms)', Number, parseInt(process.env.GPS_REQUEST_TIMEOUT || '20000', 10))
        .option('--min-remaining <number>', 'Stop using token on', Number, parseInt(process.env.GPS_MIN_REMAINING || '100', 10))
        .option('--clustering', 'Enable clustering mode (require redis)', [undefined, 'false'].indexOf(process.env.GPS_CLUSTERING) < 0)
        .option('--clustering-redis-host <host>', '(clustering) redis host', process.env.GPS_CLUSTERING_REDIS_HOST || 'localhost')
        .option('--clustering-redis-port <port>', '(clustering) redis port', Number, parseInt(process.env.GPS_CLUSTERING_REDIS_PORT || '6379', 10))
        .option('--clustering-redis-db <db>', '(clustering) redis db', Number, parseInt(process.env.GPS_CLUSTERING_REDIS_PORT || '0', 10))
        .option('--silent', 'Dont show requests outputs', [undefined, 'false'].indexOf(process.env.GPS_SILENT) < 0)
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
            api: options.api,
            requestInterval: options.requestInterval,
            requestTimeout: options.requestTimeout,
            silent: options.silent,
            tokens: tokens,
            clustering: !options.clustering
                ? undefined
                : {
                    host: options.clusteringRedisHost,
                    port: options.clusteringRedisPort,
                    db: options.clusteringRedisDb
                },
            minRemaining: options.minRemaining
        };
        const app = createProxyServer(appOptions);
        app.server
            .on('warn', consola_1.default.warn)
            .on('log', (data) => process.stdout.write(data.toString()))
            .on('listening', () => {
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
        })
            .on('error', (error) => {
            consola_1.default.error(error);
            app.server.close();
            process.exit(1);
        });
        await app.listen(options.port, '0.0.0.0');
        process.on('SIGTERM', async () => {
            consola_1.default.info('SIGTERM signal received: closing HTTP server');
            app
                .close()
                .finally(() => consola_1.default.success('Server closed'))
                .then(() => process.exit(0))
                .catch(() => process.exit(1));
        });
    })();
}
