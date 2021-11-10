#!/usr/bin/env node
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
const express_status_monitor_1 = __importDefault(require("express-status-monitor"));
const fs_1 = require("fs");
const ip_1 = require("ip");
const lodash_1 = require("lodash");
const path_1 = require("path");
const stream_1 = require("stream");
const table_1 = require("table");
const middleware_1 = __importDefault(require("./middleware"));
(0, dotenv_override_true_1.config)({ path: (0, path_1.resolve)(__dirname, '.env.version') });
dayjs_1.default.extend(relativeTime_1.default);
var APIVersion;
(function (APIVersion) {
    APIVersion["GraphQL"] = "graphql";
    APIVersion["REST"] = "rest";
})(APIVersion = exports.APIVersion || (exports.APIVersion = {}));
class ProxyLogTransform extends stream_1.Transform {
    constructor() {
        super({ objectMode: true });
        this.started = false;
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
            status: chalk_1.default[/[45]\d{2}/i.test(`${chunk.status}`) ? 'redBright' : 'green'](chunk.status),
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
    const app = (0, express_1.default)();
    app.use((0, express_status_monitor_1.default)({
        healthChecks: [{ protocol: 'https', host: 'api.github.com', path: '/', port: 443 }]
    }));
    const proxy = new middleware_1.default(tokens, options);
    if (options.api === APIVersion.GraphQL)
        app.post('/graphql', proxy.schedule.bind(proxy));
    else
        app.get('/*', proxy.schedule.bind(proxy));
    app.all('/*', (req, res) => {
        res.status(401).json({ message: `Endpoint not supported for "${options.api}" api.` });
    });
    if (!options.silent)
        proxy.pipe(new ProxyLogTransform().on('data', (data) => app.emit('log', data)));
    tokens.map((token) => axios_1.default
        .get('https://api.github.com/user', {
        headers: {
            authorization: `token ${token}`,
            'user-agent': 'GitHub API Proxy Server (@hsborges/github-proxy-server)'
        }
    })
        .catch((error) => {
        var _a;
        if (((_a = error.response) === null || _a === void 0 ? void 0 : _a.status) !== 401)
            return;
        proxy.removeToken(token);
        app.emit('warn', `Invalid token detected (${token}).`);
    }));
    return app;
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
        .option('--tokens <file>', 'File containing a list of tokens', readTokensFile)
        .option('--request-interval <interval>', 'Interval between requests (ms)', Number, 250)
        .option('--request-timeout <timeout>', 'Request timeout (ms)', Number, 20000)
        .option('--min-remaining <number>', 'Stop using token on', Number, 100)
        .option('--clustering', 'Enable clustering mode (require redis)', false)
        .option('--clustering-redis-host <host>', '(clustering) redis host', 'localhost')
        .option('--clustering-redis-port <port>', '(clustering) redis port', Number, 6379)
        .option('--clustering-redis-db <db>', '(clustering) redis db', Number, 0)
        .option('--silent', 'Dont show requests outputs')
        .version(process.env.npm_package_version || '?', '-v, --version', 'output the current version')
        .parse();
    const options = commander_1.program.opts();
    if (!options.token.length && !(options.tokens && options.tokens.length)) {
        consola_1.default.info(`${commander_1.program.helpInformation()}`);
        consola_1.default.error(`Arguments missing ("--token" or "--tokens" is mandatory).\n\n`);
        process.exit(1);
    }
    events_1.EventEmitter.defaultMaxListeners = Number.MAX_SAFE_INTEGER;
    (() => __awaiter(void 0, void 0, void 0, function* () {
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
        const app = createProxyServer(appOptions)
            .on('warn', consola_1.default.warn)
            .on('log', (data) => process.stdout.write(data.toString()));
        const server = app
            .listen(options.port)
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
            server.close();
            process.exit(1);
        });
        process.on('SIGTERM', () => __awaiter(void 0, void 0, void 0, function* () {
            consola_1.default.info('SIGTERM signal received: closing HTTP server');
            server.close(() => {
                consola_1.default.success('Server closed');
                process.exit(0);
            });
            setTimeout(() => process.exit(1), 10 * 1000);
        }));
    }))();
}
