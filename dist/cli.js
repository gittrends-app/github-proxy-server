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
/* Author: Hudson S. Borges */
const chalk_1 = __importDefault(require("chalk"));
const commander_1 = require("commander");
const consola_1 = __importDefault(require("consola"));
const dotenv_1 = require("dotenv");
const events_1 = require("events");
const express_1 = __importDefault(require("express"));
const express_status_monitor_1 = __importDefault(require("express-status-monitor"));
const fs_1 = require("fs");
const https_1 = __importDefault(require("https"));
const ip_1 = require("ip");
const lodash_1 = require("lodash");
const path_1 = require("path");
const logger_1 = __importDefault(require("./logger"));
const middleware_1 = __importDefault(require("./middleware"));
(0, dotenv_1.config)({ path: (0, path_1.resolve)(__dirname, '.env.version') });
// parse tokens from input
function tokensParser(text) {
    return text
        .split(/\n/g)
        .map((v) => v.replace(/\s/g, ''))
        .reduce((acc, v) => {
        if (!v || /^(\/{2}|#).*/gi.test(v))
            return acc;
        return acc.concat([v.replace(/.*:(.+)/i, '$1')]);
    }, []);
}
// concat tokens in commander
function concatTokens(token, list) {
    if (token.length !== 40)
        throw new Error('Github access tokens have 40 characters');
    return (0, lodash_1.uniq)([...list, token]);
}
// read tokens from a file
function getTokens(filename) {
    const filepath = (0, path_1.resolve)(process.cwd(), filename);
    if (!(0, fs_1.existsSync)(filepath))
        throw new Error(`File "${filename}" not found!`);
    const tokens = tokensParser((0, fs_1.readFileSync)(filepath, 'utf8'));
    return tokens.reduce((acc, token) => concatTokens(token, acc), []);
}
var APIVersion;
(function (APIVersion) {
    APIVersion["GraphQL"] = "graphql";
    APIVersion["REST"] = "rest";
})(APIVersion || (APIVersion = {}));
// parse arguments from command line
commander_1.program
    .option('-p, --port <port>', 'Port to start the proxy server', Number, parseInt(process.env.PORT || '3000', 10))
    .option('-t, --token <token>', 'GitHub token to be used', concatTokens, [])
    .addOption(new commander_1.Option('--api <api>', 'API version to proxy requests')
    .choices([APIVersion.GraphQL, APIVersion.REST])
    .default(APIVersion.GraphQL)
    .argParser((value) => value.toLowerCase()))
    .option('--tokens <file>', 'File containing a list of tokens', getTokens)
    .option('--request-interval <interval>', 'Interval between requests (ms)', Number, 250)
    .option('--request-timeout <timeout>', 'Request timeout (ms)', Number, 20000)
    .option('--min-remaining <number>', 'Stop using token on', Number, 100)
    .option('--clustering', 'Enable clustering mode (require redis)')
    .option('--clustering-redis-host <host>', '(clustering) redis host', 'localhost')
    .option('--clustering-redis-port <port>', '(clustering) redis port', Number, 6379)
    .option('--clustering-redis-db <db>', '(clustering) redis db', Number, 0)
    .option('--silent', 'Dont show requests outputs')
    .version(process.env.npm_package_version || '?', '-v, --version', 'output the current version')
    .parse();
const options = commander_1.program.opts();
if (!options.token.length && !(options.tokens && options.tokens.length)) {
    consola_1.default.info(`${commander_1.program.helpInformation()}`);
    consola_1.default.error(`Arguments missing (see "--token" and "--tokens").\n\n`);
    process.exit(1);
}
// create the load balancer
(() => __awaiter(void 0, void 0, void 0, function* () {
    // increase number os listeners
    events_1.EventEmitter.defaultMaxListeners = Number.MAX_SAFE_INTEGER;
    const tokens = (0, lodash_1.compact)([...options.token, ...(options.tokens || [])]);
    const middlewareOpts = {
        requestInterval: options.requestInterval,
        requestTimeout: options.requestTimeout,
        minRemaining: options.minRemaining,
        clustering: options.clustering
            ? {
                host: options.clusteringRedisHost,
                port: options.clusteringRedisPort,
                db: options.clusteringRedisDb
            }
            : undefined
    };
    const app = (0, express_1.default)();
    app.use((0, express_status_monitor_1.default)({
        healthChecks: [{ protocol: 'https', host: 'api.github.com', path: '/', port: 443 }]
    }));
    const proxy = new middleware_1.default(tokens, middlewareOpts);
    tokens.map((token) => https_1.default.get('https://api.github.com/user', {
        headers: {
            authorization: `token ${token}`,
            'user-agent': 'GitHub API Proxy Server (@hsborges/github-proxy-server)'
        }
    }, ({ statusCode }) => {
        if (statusCode === 200)
            return;
        consola_1.default.warn(`Invalid token (${token}) detected!`);
        proxy.removeToken(token);
    }));
    if (!options.silent)
        proxy.pipe(new logger_1.default());
    if (options.api === APIVersion.GraphQL)
        app.post('/graphql', proxy.schedule.bind(proxy));
    else if (options.api === APIVersion.REST)
        app.get('/*', proxy.schedule.bind(proxy));
    app.all('/*', (req, res) => {
        res.status(401).json({ message: `Endpoint not supported for "${options.api}" api.` });
    });
    const server = app.listen(options.port);
    server.on('error', (error) => {
        consola_1.default.error(error);
        server.close();
        process.exit(1);
    });
    server.on('listening', () => {
        const host = `http://${(0, ip_1.address)()}:${options.port}`;
        consola_1.default.success(`Proxy server running on ${host} (tokens: ${chalk_1.default.greenBright(tokens.length)})`);
        consola_1.default.success(`${chalk_1.default.bold('Options')}: %s`, Object.entries(Object.assign(Object.assign(Object.assign({}, middlewareOpts), { clustering: !!middlewareOpts.clustering }), (0, lodash_1.pick)(options, ['api'])))
            .filter(([, vaue]) => (0, lodash_1.negate)(lodash_1.isNil)(vaue))
            .sort((a, b) => (a[0] > b[0] ? 1 : -1))
            .map(([k, v]) => `${k}: ${chalk_1.default.greenBright(v)}`)
            .join(', '));
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
