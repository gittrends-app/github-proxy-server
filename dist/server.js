#!/usr/bin/env node
/* Author: Hudson S. Borges */
import chalk from 'chalk';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime.js';
import express from 'express';
import compact from 'lodash/compact.js';
import uniq from 'lodash/uniq.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import pinoPretty from 'pino-pretty';
import swaggerStats from 'swagger-stats';
import { getBorderCharacters, table } from 'table';
import ProxyRouter, { ProxyRouterResponse } from './router.js';
dayjs.extend(relativeTime);
export var APIVersion;
(function (APIVersion) {
    APIVersion["GraphQL"] = "graphql";
    APIVersion["REST"] = "rest";
})(APIVersion || (APIVersion = {}));
export class ProxyLogTransform extends Transform {
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
            border: getBorderCharacters('void'),
            singleLine: true
        };
    }
    _transform(chunk, encoding, done) {
        const data = {
            token: chunk.token,
            pending: chunk.pending,
            remaining: chunk.remaining,
            reset: dayjs.unix(chunk.reset).fromNow(),
            status: chalk[/(?![23])\d{3}/i.test(`${chunk.status}`) ? 'redBright' : 'green'](chunk.status),
            duration: `${chunk.duration / 1000}s`
        };
        if (!this.started) {
            this.started = true;
            this.push(chalk.bold('Columns: ') +
                ['api', ...Object.keys(data)].map((v) => chalk.underline(v)).join(', ') +
                '\n\n');
        }
        this.push(table([[this.api, ...Object.values(data)]], this.config).trimEnd() + '\n');
        done();
    }
}
// parse tokens from input
export function parseTokens(text) {
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
// concat tokens in commander
export function concatTokens(token, list) {
    if (token.length !== 40)
        throw new Error('Invalid access token detected (they have 40 characters)');
    return uniq([...list, token]);
}
// read tokens from a file
export function readTokensFile(filename) {
    const filepath = resolve(process.cwd(), filename);
    if (!existsSync(filepath))
        throw new Error(`File "${filename}" not found!`);
    return parseTokens(readFileSync(filepath, 'utf8'));
}
export function createProxyServer(options) {
    const tokens = compact(options.tokens).reduce((memo, token) => concatTokens(token, memo), []);
    const app = express();
    if (process.env.DEBUG === 'true') {
        app.use(pinoHttp({
            level: 'info',
            serializers: {
                req: (req) => ({ method: req.method, url: req.url }),
                res: ({ statusCode }) => ({ statusCode })
            },
            logger: pino(pinoPretty({ colorize: true }))
        }));
    }
    if (options.statusMonitor) {
        app.use(swaggerStats.getMiddleware({
            name: 'GitHub Proxy Server',
            version: process.env.npm_package_version,
            uriPath: '/status'
        }));
    }
    const proxyInstances = Object.values(APIVersion).reduce((memo, version) => {
        const proxy = new ProxyRouter(tokens, {
            overrideAuthorization: options.overrideAuthorization ?? true,
            ...options
        });
        if (!options.silent)
            proxy.pipe(new ProxyLogTransform(version).on('data', (data) => app.emit('log', data)));
        return { ...memo, [version]: proxy };
    }, {});
    function notSupported(req, res) {
        res.status(ProxyRouterResponse.PROXY_ERROR).send({ message: `Endpoint not supported` });
    }
    app
        .post('/graphql', (req, reply) => proxyInstances[APIVersion.GraphQL].schedule(req, reply))
        .get('/*', (req, reply) => proxyInstances[APIVersion.REST].schedule(req, reply));
    app.delete('/*', notSupported);
    app.patch('/*', notSupported);
    app.put('/*', notSupported);
    app.post('/*', notSupported);
    tokens.map((token) => fetch('https://api.github.com/user', {
        headers: {
            authorization: `token ${token}`,
            'user-agent': 'GitHub API Proxy Server (@hsborges/github-proxy-server)'
        }
    }).then((response) => {
        if (response.status !== 401)
            return response;
        Object.values(proxyInstances).forEach((proxy) => proxy.removeToken(token));
        app.emit('warn', `Invalid token detected (${token}).`);
    }));
    return app;
}
