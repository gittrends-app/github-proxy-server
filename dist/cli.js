#!/usr/bin/env node

// src/cli.ts
import chalk2 from "chalk";
import { Command, Option } from "commander";
import consola from "consola";
import EventEmitter2 from "events";
import ip from "ip";
import isNil from "lodash/isNil.js";
import isObjectLike from "lodash/isObjectLike.js";
import omit from "lodash/omit.js";
import omitBy from "lodash/omitBy.js";
import { pathToFileURL } from "url";

// package.json
var package_default = {
  name: "@gittrends-app/github-proxy-server",
  version: "10.3.2",
  exports: "./dist/cli.js",
  engines: {
    node: ">=20"
  },
  type: "module",
  repository: "git@github.com:gittrends-app/github-proxy-server.git",
  author: "Hudson Silva Borges <hudsonsilbor@gmail.com>",
  license: "MIT",
  scripts: {
    start: "node dist/cli.js",
    dev: "tsx watch src/cli.ts",
    "dev-no-reload": "tsx src/cli.ts",
    jest: 'NODE_NO_WARNINGS=1 NODE_OPTIONS="$NODE_OPTIONS --experimental-vm-modules" jest',
    test: 'NODE_NO_WARNINGS=1 NODE_OPTIONS="$NODE_OPTIONS --experimental-vm-modules" jest --no-cache --coverage',
    commit: "git-cz",
    lint: "eslint src",
    build: "shx rm -rf dist && tsup-node src/cli.ts --format esm --sourcemap --splitting",
    prepare: "husky",
    prettier: "prettier --write --config .prettierrc.yml --ignore-path .prettierignore  '**/*.ts'",
    release: "standard-version",
    np: "np --no-publish --yarn --contents dist"
  },
  bin: {
    "github-proxy-server": "./dist/cli.js"
  },
  publishConfig: {
    access: "public"
  },
  files: [
    "dist",
    "architecture.png"
  ],
  dependencies: {
    bottleneck: "^2.19.5",
    chalk: "4",
    commander: "^12.1.0",
    consola: "^3.2.3",
    dayjs: "^1.11.12",
    "dotenv-override-true": "^6.2.2",
    express: "^4.19.2",
    "http-proxy": "^1.18.1",
    "http-status-codes": "^2.3.0",
    "https-proxy-agent": "^7.0.5",
    ioredis: "^5.4.1",
    ip: "^2.0.1",
    lodash: "^4.17.21",
    "node-fetch": "^3.3.2",
    "p-limit": "^6.1.0",
    pino: "^9.3.2",
    "pino-http": "^10.2.0",
    "pino-pretty": "^11.2.2",
    "swagger-stats": "^0.99.7",
    table: "^6.8.2"
  },
  devDependencies: {
    "@commitlint/cli": "^19.3.0",
    "@commitlint/config-conventional": "^19.2.2",
    "@eslint/eslintrc": "^3.1.0",
    "@eslint/js": "^9.8.0",
    "@jest/globals": "^29.7.0",
    "@trivago/prettier-plugin-sort-imports": "^4.3.0",
    "@tsconfig/node20": "^20.1.4",
    "@types/async": "^3.2.24",
    "@types/http-proxy": "^1.17.14",
    "@types/ip": "^1.1.3",
    "@types/jest": "^29.5.12",
    "@types/lodash": "^4.17.7",
    "@types/node": "^22.1.0",
    "@types/supertest": "^6.0.2",
    "@types/swagger-stats": "^0.95.11",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    commitizen: "^4.3.0",
    "cz-conventional-changelog": "3.3.0",
    eslint: "^9.8.0",
    "eslint-config-prettier": "^9.1.0",
    "eslint-plugin-import": "^2.29.1",
    "eslint-plugin-prettier": "^5.2.1",
    globals: "^15.9.0",
    husky: "^9.1.4",
    jest: "^29.7.0",
    nock: "^13.5.5",
    np: "^10.0.7",
    prettier: "^3.3.3",
    shx: "^0.3.4",
    "standard-version": "^9.5.0",
    supertest: "^7.0.0",
    "tmp-promise": "^3.0.3",
    "ts-jest": "^29.2.4",
    tsup: "^8.2.4",
    tsx: "^4.19.0",
    typescript: "^5.5.4"
  },
  config: {
    commitizen: {
      path: "./node_modules/cz-conventional-changelog"
    }
  },
  peerDependencies: {
    "prom-client": "14"
  }
};

// src/server.ts
import chalk from "chalk";
import dayjs2 from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime.js";
import express from "express";
import compact from "lodash/compact.js";
import uniq from "lodash/uniq.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pino } from "pino";
import { pinoHttp } from "pino-http";
import pinoPretty from "pino-pretty";
import swaggerStats from "swagger-stats";
import { getBorderCharacters, table } from "table";

// src/router.ts
import Bottleneck from "bottleneck";
import dayjs from "dayjs";
import { default as proxy } from "http-proxy";
import { StatusCodes } from "http-status-codes";
import minBy from "lodash/minBy.js";
import fetch from "node-fetch";
import EventEmitter from "node:events";
import { Agent } from "node:https";
import { setTimeout } from "node:timers/promises";
import Limiter from "p-limit";
var ProxyWorker = class extends EventEmitter {
  queue;
  proxy;
  token;
  schedule;
  defaults;
  remaining = 0;
  reset = Date.now() / 1e3 + 1;
  constructor(token, opts) {
    super({});
    this.token = token;
    switch (opts.resource) {
      case "code_search":
        this.defaults = { resource: opts.resource, limit: 10, reset: 1e3 * 60 };
        break;
      case "search":
        this.defaults = { resource: opts.resource, limit: 30, reset: 1e3 * 60 };
        break;
      case "graphql":
      default:
        this.defaults = { resource: opts.resource, limit: 5e3, reset: 1e3 * 60 * 60 };
    }
    this.proxy = proxy.createProxyServer({
      target: "https://api.github.com",
      ws: false,
      xfwd: true,
      changeOrigin: true,
      autoRewrite: true,
      proxyTimeout: opts.requestTimeout,
      agent: new Agent({
        keepAlive: true,
        keepAliveMsecs: 15e3,
        timeout: opts.requestTimeout,
        scheduling: "fifo"
      })
    });
    this.proxy.on("proxyReq", (proxyReq, req) => {
      req.proxyRequest = proxyReq;
      req.startedAt = /* @__PURE__ */ new Date();
      req.hasAuthorization = opts.overrideAuthorization ? false : !!proxyReq.getHeader("authorization");
      if (!req.hasAuthorization) proxyReq.setHeader("authorization", `token ${token}`);
    });
    this.proxy.on("proxyRes", (proxyRes, req) => {
      const replaceURL = (url) => req.headers.host ? url.replaceAll("https://api.github.com", `http://${req.headers.host}`) : url;
      proxyRes.headers.link = proxyRes.headers.link && (Array.isArray(proxyRes.headers.link) ? proxyRes.headers.link.map(replaceURL) : replaceURL(proxyRes.headers.link));
      if (req.hasAuthorization) return;
      this.updateLimits({
        status: `${proxyRes.statusCode}`,
        ...proxyRes.headers
      });
      this.log(proxyRes.statusCode, req.startedAt);
      proxyRes.headers["access-control-expose-headers"] = (proxyRes.headers["access-control-expose-headers"] || "").split(", ").filter((header) => {
        if (/(ratelimit|scope)/i.test(header)) {
          delete proxyRes.headers[header.toLowerCase()];
          return false;
        }
        return true;
      }).join(", ");
    });
    let maxConcurrent = 1;
    if (opts.resource === "graphql") maxConcurrent = 2;
    else if (opts.resource === "core") maxConcurrent = 10;
    this.queue = new Bottleneck({
      maxConcurrent,
      id: `proxy_server:${opts.resource}:${this.token}`,
      ...opts?.clustering ? {
        datastore: "ioredis",
        clearDatastore: false,
        clientOptions: {
          host: opts.clustering.host,
          port: opts.clustering.port,
          options: { db: opts.clustering.db }
        },
        timeout: opts.requestTimeout
      } : { datastore: "local" }
    });
    this.schedule = this.queue.wrap(async (req, res) => {
      if (req.socket.destroyed) return this.log();
      if (this.remaining <= opts.minRemaining && this.reset > Date.now() / 1e3) {
        this.emit("retry", req, res);
        return;
      }
      const task = new Promise((resolve2, reject) => {
        this.remaining -= 1;
        req.socket.once("close", resolve2);
        req.socket.once("error", reject);
        res.once("close", resolve2);
        res.once("error", reject);
        this.proxy.web(req, res, void 0, (error) => reject(error));
      }).catch(async (error) => {
        this.log(error.code || 600 /* PROXY_ERROR */, req.startedAt);
        if (!req.socket.destroyed && !req.socket.writableFinished) {
          res.status(StatusCodes.BAD_GATEWAY).send();
        }
        req.proxyRequest?.destroy();
        res.destroy();
      });
      await Promise.all([
        task,
        setTimeout(["search", "code_search"].includes(opts.resource) ? 2e3 : 1e3)
      ]);
    });
  }
  async refreshRateLimits() {
    await fetch("https://api.github.com/rate_limit", {
      headers: {
        authorization: `token ${this.token}`,
        "user-agent": "GitHub API Proxy Server (@hsborges/github-proxy-server)"
      }
    }).then(async (response) => {
      if (response.status === 401) {
        this.remaining = 0;
        this.reset = Infinity;
        this.emit("error", `Invalid token detected (${this.token}).`, this.token);
      } else {
        const res = await response.json();
        this.remaining = res.resources[this.defaults.resource].remaining;
        this.reset = res.resources[this.defaults.resource].reset;
        this.log(void 0, /* @__PURE__ */ new Date());
      }
    });
  }
  updateLimits(headers) {
    if (!headers["x-ratelimit-remaining"]) return;
    if (/401/i.test(headers.status)) {
      if (parseInt(headers["x-ratelimit-limit"], 10) > 0) this.remaining = 0;
      else this.remaining -= 1;
    } else {
      this.remaining = parseInt(headers["x-ratelimit-remaining"], 10) - this.running;
      this.reset = parseInt(headers["x-ratelimit-reset"], 10);
    }
  }
  log(status, startedAt) {
    this.emit("log", {
      resource: this.defaults.resource,
      token: this.token.slice(-4),
      pending: this.queued,
      remaining: this.remaining,
      reset: this.reset,
      status,
      duration: startedAt ? Date.now() - startedAt.getTime() : 0
    });
  }
  get pending() {
    const { RECEIVED, QUEUED, RUNNING, EXECUTING } = this.queue.counts();
    return RECEIVED + QUEUED + RUNNING + EXECUTING;
  }
  get running() {
    const { RUNNING, EXECUTING } = this.queue.counts();
    return RUNNING + EXECUTING;
  }
  get queued() {
    const { RECEIVED, QUEUED } = this.queue.counts();
    return RECEIVED + QUEUED;
  }
  destroy() {
    this.proxy.close();
    return this;
  }
};
var ProxyRouter = class extends EventEmitter {
  options;
  limiter = Limiter(1);
  clients;
  constructor(tokens, opts) {
    super({});
    if (!tokens.length) throw new Error("At least one token is required!");
    this.clients = [];
    this.options = Object.assign({ requestTimeout: 2e4, minRemaining: 100 }, opts);
    tokens.forEach((token) => this.addToken(token));
  }
  // function to select the best client and queue request
  async schedule(req, res) {
    return this.limiter(async () => {
      const isGraphQL = req.path.startsWith("/graphql") && req.method === "POST";
      const isCodeSearch = req.path.startsWith("/search/code");
      const isSearch = req.path.startsWith("/search");
      let clients;
      if (isGraphQL) clients = this.clients.map((client) => client.graphql);
      else if (isCodeSearch) clients = this.clients.map((client) => client.code_search);
      else if (isSearch) clients = this.clients.map((client) => client.search);
      else clients = this.clients.map((client) => client.core);
      const available = clients.filter(
        (client) => client.remaining > (isSearch ? 1 : this.options.minRemaining) || client.reset * 1e3 < Date.now()
      );
      if (available.length === 0) {
        const resetAt = Math.min(...clients.map((c) => c.reset)) * 1e3;
        this.emit(
          "warn",
          `There is no client available. Retrying at ${dayjs(resetAt).format("HH:mm:ss")}.`
        );
        return setTimeout(Math.max(0, resetAt - Date.now()) + 1e3).then(() => {
          this.schedule(req, res);
        });
      } else {
        const client = minBy(
          available,
          (client2) => client2.pending + 1 / client2.remaining
        );
        client.schedule(req, res);
      }
    });
  }
  addToken(token) {
    if (this.clients.map((client) => client.token).includes(token)) return;
    const core = new ProxyWorker(token, { ...this.options, resource: "core" });
    const search = new ProxyWorker(token, { ...this.options, resource: "search" });
    const codeSearch = new ProxyWorker(token, { ...this.options, resource: "code_search" });
    const graphql = new ProxyWorker(token, { ...this.options, resource: "graphql" });
    for (const worker of [core, search, codeSearch, graphql]) {
      worker.on("error", (error) => this.emit("error", error));
      worker.on("retry", (req, res) => this.schedule(req, res));
      worker.on("log", (log) => this.emit("log", log));
      worker.on("warn", (message) => this.emit("warn", message));
      worker.refreshRateLimits().then(() => this.emit("ready"));
    }
    this.clients.push({ token, core, search, code_search: codeSearch, graphql });
  }
  removeToken(token) {
    this.clients.splice(this.clients.map((c) => c.token).indexOf(token), 1).forEach((client) => {
      for (const worker of [client.core, client.search, client.code_search, client.graphql]) {
        worker.proxy.close();
        worker.queue.stop({ dropWaitingJobs: false });
        worker.queue.disconnect();
        worker.destroy();
      }
    });
  }
  async refreshRateLimits() {
    await Promise.all(
      this.clients.map(
        (client) => Promise.all(
          [client.core, client.search, client.code_search, client.graphql].map(
            (w) => w.refreshRateLimits()
          )
        )
      )
    ).then(() => this.emit("ready"));
  }
  get tokens() {
    return this.clients.map((client) => client.token);
  }
  destroy() {
    this.clients.forEach((client) => this.removeToken(client.token));
    return this;
  }
};

// src/server.ts
dayjs2.extend(relativeTime);
function statusFormatter(status) {
  switch (true) {
    case /[23]\d{2}/.test(`${status}`):
      return chalk.green(status);
    case /[4]\d{2}/.test(`${status}`):
      return chalk.yellow(status);
    default:
      return chalk.red(status);
  }
}
function logTransform(chunk) {
  const data = {
    resource: chunk.resource,
    token: chunk.token,
    pending: chunk.pending,
    remaining: chunk.remaining,
    reset: dayjs2.unix(chunk.reset).fromNow(),
    duration: `${chunk.duration / 1e3}s`,
    status: statusFormatter(chunk.status || "-")
  };
  return table([Object.values(data)], {
    columnDefault: { alignment: "right", width: 5 },
    columns: {
      0: { width: 11 },
      1: { width: 5 },
      2: { width: 3 },
      3: { width: 5 },
      4: { width: 18 },
      5: { width: 7 },
      6: { width: `${chunk.status || "-"}`.length, alignment: "left" }
    },
    border: getBorderCharacters("void"),
    singleLine: true
  }).trimEnd() + "\n";
}
function parseTokens(text) {
  return text.split(/\n/g).map((v) => v.replace(/\s/g, "")).reduce((acc, v) => {
    if (!v || /^(\/{2}|#).*/gi.test(v)) return acc;
    return acc.concat([v.replace(/.*:(.+)/i, "$1")]);
  }, []).reduce((acc, token) => concatTokens(token, acc), []);
}
function concatTokens(token, list) {
  if (token.length !== 40)
    throw new Error("Invalid access token detected (they have 40 characters)");
  return uniq([...list, token]);
}
function readTokensFile(filename) {
  const filepath = resolve(process.cwd(), filename);
  if (!existsSync(filepath)) throw new Error(`File "${filename}" not found!`);
  return parseTokens(readFileSync(filepath, "utf8"));
}
function createProxyServer(options) {
  const tokens = compact(options.tokens).reduce(
    (memo, token) => concatTokens(token, memo),
    []
  );
  const app = express();
  if (process.env.DEBUG === "true") {
    app.use(
      pinoHttp({
        level: "info",
        serializers: {
          req: (req) => ({ method: req.method, url: req.url }),
          res: ({ statusCode }) => ({ statusCode })
        },
        logger: pino(pinoPretty({ colorize: true }))
      })
    );
  }
  if (options.statusMonitor) {
    app.use(
      swaggerStats.getMiddleware({
        name: "GitHub Proxy Server",
        version: process.env.npm_package_version,
        uriPath: "/status"
      })
    );
  }
  const proxy2 = new ProxyRouter(tokens, {
    overrideAuthorization: options.overrideAuthorization ?? true,
    ...options
  });
  proxy2.on("error", (message) => app.emit("error", message));
  if (!options.silent) {
    proxy2.on("log", (data) => app.emit("log", logTransform(data)));
    proxy2.on("warn", (message) => app.emit("warn", message));
  }
  function notSupported(req, res) {
    res.status(600 /* PROXY_ERROR */).send({ message: `Endpoint not supported` });
  }
  app.post("/graphql", (req, reply) => proxy2.schedule(req, reply)).get("/*", (req, reply) => proxy2.schedule(req, reply));
  app.delete("/*", notSupported);
  app.patch("/*", notSupported);
  app.put("/*", notSupported);
  app.post("/*", notSupported);
  return app;
}

// src/cli.ts
function createCli() {
  const program = new Command();
  return program.addOption(
    new Option("-p, --port [port]", "Port to start the proxy server").argParser(Number).default(3e3).env("PORT")
  ).addOption(
    new Option("-t, --token [token]", "GitHub token to be used").argParser(concatTokens).default([])
  ).addOption(
    new Option("--tokens [file]", "File containing a list of tokens").argParser(readTokensFile).env("GPS_TOKENS_FILE")
  ).addOption(
    new Option("--request-timeout [timeout]", "Request timeout (ms)").argParser(Number).default(3e4).env("GPS_REQUEST_TIMEOUT")
  ).addOption(
    new Option("--min-remaining <number>", "Stop using token on a minimum of").argParser(Number).default(100).env("GPS_MIN_REMAINING")
  ).addOption(
    new Option("--clustering", "(clustering) enable clustering (requires redis)").default(false).env("GPS_CLUSTERING_HOST")
  ).addOption(
    new Option("--clustering-host [host]", "(clustering) redis host").implies({ clustering: true }).default("localhost").env("GPS_CLUSTERING_HOST")
  ).addOption(
    new Option("--clustering-port [port]", "(clustering) redis port").argParser(Number).implies({ clustering: true }).default(6379).env("GPS_CLUSTERING_PORT")
  ).addOption(
    new Option("--clustering-db [db]", "(clustering) redis db").argParser(Number).implies({ clustering: true }).default(0).env("GPS_CLUSTERING_DB")
  ).addOption(new Option("--silent", "Dont show requests outputs")).addOption(
    new Option(
      "--no-override-authorization",
      "By default, the authorization header is overrided with a configured token"
    )
  ).addOption(new Option("--no-status-monitor", "Disable requests monitoring on /status")).version(package_default.version || "?", "-v, --version", "output the current version").action(async (options) => {
    if (!options.token.length && !(options.tokens && options.tokens.length)) {
      consola.info(`${program.helpInformation()}`);
      consola.error(`Arguments missing ("--token" or "--tokens" is mandatory).

`);
      process.exit(1);
    }
    EventEmitter2.defaultMaxListeners = Number.MAX_SAFE_INTEGER;
    const tokens = [...options.token, ...options.tokens || []].reduce(
      (memo, token) => concatTokens(token, memo),
      []
    );
    const appOptions = {
      requestTimeout: options.requestTimeout,
      silent: options.silent,
      overrideAuthorization: options.overrideAuthorization,
      tokens,
      clustering: options.clustering ? {
        host: options.clusteringHost,
        port: options.clusteringPort,
        db: options.clusteringDb
      } : void 0,
      minRemaining: options.minRemaining,
      statusMonitor: options.statusMonitor
    };
    const app = createProxyServer(appOptions);
    app.on("log", (data) => process.stdout.write(data.toString())).on("warn", consola.warn).on("error", consola.error);
    const server = app.listen({ host: "0.0.0.0", port: options.port }, (error) => {
      if (error) {
        consola.error(error);
        process.exit(1);
      }
      const host = `http://${ip.address()}:${options.port}`;
      consola.success(
        `Proxy server running on ${host} (tokens: ${chalk2.greenBright(tokens.length)})`
      );
      function formatObject(object) {
        return Object.entries(omitBy(object, (value) => isNil(value))).sort((a, b) => a[0] > b[0] ? 1 : -1).map(
          ([k, v]) => `${k}: ${isObjectLike(v) ? `{ ${formatObject(v)} }` : chalk2.greenBright(v)}`
        ).join(", ");
      }
      consola.success(
        `${chalk2.bold("Options")}: %s`,
        formatObject(omit(appOptions, ["token", "tokens"]))
      );
    });
    process.on("SIGTERM", async () => {
      consola.info("SIGTERM signal received: closing HTTP server");
      server.close((err) => {
        if (err) {
          consola.error(err);
          process.exit(1);
        }
        consola.success("Server closed");
        process.exit(0);
      });
    });
  });
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  createCli().parse(process.argv);
}
export {
  createCli
};
//# sourceMappingURL=cli.js.map