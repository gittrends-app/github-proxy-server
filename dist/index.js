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
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArrays = (this && this.__spreadArrays) || function () {
    for (var s = 0, i = 0, il = arguments.length; i < il; i++) s += arguments[i].length;
    for (var r = Array(s), k = 0, i = 0; i < il; i++)
        for (var a = arguments[i], j = 0, jl = a.length; j < jl; j++, k++)
            r[k] = a[j];
    return r;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/* Author: Hudson S. Borges */
var https_1 = __importDefault(require("https"));
var consola_1 = __importDefault(require("consola"));
var express_1 = __importDefault(require("express"));
var cors_1 = __importDefault(require("cors"));
var helmet_1 = __importDefault(require("helmet"));
var body_parser_1 = __importDefault(require("body-parser"));
var compression_1 = __importDefault(require("compression"));
var connect_timeout_1 = __importDefault(require("connect-timeout"));
var response_time_1 = __importDefault(require("response-time"));
var path_1 = require("path");
var commander_1 = require("commander");
var lodash_1 = require("lodash");
var fs_1 = require("fs");
var package_json_1 = require("./package.json");
var middleware_1 = __importDefault(require("./middleware"));
var logger_1 = __importDefault(require("./logger"));
// parse tokens from input
function tokensParser(text) {
    return text
        .split(/\n/g)
        .map(function (v) { return v.replace(/\s/g, ''); })
        .reduce(function (acc, v) {
        if (!v || /^(\/{2}|#).*/gi.test(v))
            return acc;
        return acc.concat([v.replace(/.*:(.+)/i, '$1')]);
    }, []);
}
// concat tokens in commander
function concatTokens(token, list) {
    if (token.length !== 40)
        throw new Error('Github access tokens have 40 characters');
    return lodash_1.uniq(__spreadArrays(list, [token]));
}
// read tokens from a file
function getTokens(filename) {
    var filepath = path_1.resolve(process.cwd(), filename);
    if (!fs_1.existsSync(filepath))
        throw new Error("File \"" + filename + "\" not found!");
    var tokens = tokensParser(fs_1.readFileSync(filepath, 'utf8'));
    return tokens.reduce(function (acc, token) { return concatTokens(token, acc); }, []);
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
    .option('--api <api>', 'API version to proxy requests', APIVersion.GraphQL)
    .option('--tokens <file>', 'File containing a list of tokens', getTokens)
    .option('--request-interval <interval>', 'Interval between requests (ms)', Number, 100)
    .option('--request-timeout <timeout>', 'Request timeout (ms)', Number, 15000)
    .option('--connection-timeout <timeout>', 'Connection timeout (ms)', Number, 60000)
    .option('--min-remaining <number>', 'Stop using token on', Number, 100)
    .version(package_json_1.version, '-v, --version', 'output the current version')
    .parse();
if (!commander_1.program.token.length && !(commander_1.program.tokens && commander_1.program.tokens.length)) {
    consola_1.default.info("" + commander_1.program.helpInformation());
    consola_1.default.error("Arguments missing (see \"--token\" and \"--tokens\").\n\n");
    process.exit(1);
}
// create the load balancer
(function () { return __awaiter(void 0, void 0, void 0, function () {
    var tokens, options, app, proxy, server;
    return __generator(this, function (_a) {
        tokens = lodash_1.compact(__spreadArrays(commander_1.program.token, (commander_1.program.tokens || [])));
        options = lodash_1.pick(commander_1.program, ['requestInterval', 'requestTimeout', 'minRemaining']);
        app = express_1.default();
        app.use(cors_1.default());
        app.use(helmet_1.default());
        app.use(compression_1.default());
        app.use(response_time_1.default());
        app.use(body_parser_1.default.json({ limit: '500kb' }));
        app.use(connect_timeout_1.default(commander_1.program.connectionTimeout / 1000 + "s", { respond: false }));
        proxy = new middleware_1.default(tokens, options);
        tokens.map(function (token) {
            return https_1.default.get('https://api.github.com/user', {
                headers: {
                    authorization: "token " + token,
                    'user-agent': 'GitHub API Proxy Server (@hsborges/github-proxy-server)'
                }
            }, function (_a) {
                var statusCode = _a.statusCode;
                if (statusCode === 200)
                    return;
                consola_1.default.error("Invalid token (" + token + ") detected!");
                proxy.removeToken(token);
            });
        });
        proxy.pipe(logger_1.default);
        if (commander_1.program.api === APIVersion.GraphQL)
            app.post('/graphql', proxy.schedule.bind(proxy));
        else if (commander_1.program.api === APIVersion.REST)
            app.get('/*', proxy.schedule.bind(proxy));
        app.all('/*', function (req, res) {
            res.status(401).json({ message: "Endpoint not supported for \"" + commander_1.program.api + "\" api." });
        });
        server = app.listen(commander_1.program.port, function () {
            consola_1.default.success("Proxy server running on " + commander_1.program.port + " (tokens: " + tokens.length + ")");
            consola_1.default.success("Options: %s", Object.entries(options)
                .map(function (_a) {
                var k = _a[0], v = _a[1];
                return k + ": " + v;
            })
                .join(', '));
        });
        process.on('SIGTERM', function () { return __awaiter(void 0, void 0, void 0, function () {
            return __generator(this, function (_a) {
                consola_1.default.info('SIGTERM signal received: closing HTTP server');
                server.close(function () {
                    consola_1.default.success('Server closed');
                    process.exit(0);
                });
                setTimeout(function () { return process.exit(1); }, 10 * 1000);
                return [2 /*return*/];
            });
        }); });
        return [2 /*return*/];
    });
}); })();
