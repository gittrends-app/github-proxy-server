/* eslint-disable @typescript-eslint/no-explicit-any */
import { format } from '@fast-csv/format';
import { queue } from 'async';
import chalk from 'chalk';
import { Argument, Option, program } from 'commander';
import consola from 'consola';
import { createWriteStream } from 'fs';
import { Db } from 'mongodb';
import path from 'path';

import GitHubApp from './github-app';
import { createConnection } from './mongo';
import * as upsert from './upsert';

async function searchAndStore(opts: { appClient: GitHubApp; db: Db }) {
  console.profile('search');
  const startedAt = Date.now();
  const query = 'stars:1..* language:Java';
  consola.info(`Searching repositories using query: "${query}"`);

  for await (const { data } of opts.appClient.search(query)) {
    for (const item of data) await upsert.repository(item, { db: opts.db });
    break;
  }

  consola.success(`Searching finished in ${chalk.bold(Date.now() - startedAt)}ms`);
  console.profileEnd('search');
}

type Resource = 'issues' | 'releases' | 'stargazers' | 'tags' | 'watchers';

async function genericProcessor(
  repo: Record<string, any>,
  resource: Resource,
  opts: { appClient: GitHubApp; db: Db }
) {
  const [owner, name] = repo.full_name.split('/');

  console.profile(resource);
  const startedAt = Date.now();
  consola.info(
    `[${chalk.bold(repo.full_name.toLowerCase())}] getting ${resource} from "${owner}/${name}"`
  );

  for await (const { data } of opts.appClient[resource](owner, name)) {
    const mappedData =
      resource === 'watchers'
        ? data.map((d) => ({ user: d, repository: repo.id }))
        : data.map((d) => ({ ...d, repository: repo.id }));
    await upsert[resource](mappedData as any, { db: opts.db });
  }

  consola.success(
    `[${chalk.bold(repo.full_name.toLowerCase())}] ${resource} finished in ${
      Date.now() - startedAt
    }ms`
  );
  console.profileEnd(resource);
}

async function processResouces(
  repo: Record<string, any>,
  resources: Resource[],
  type: 'sequential' | 'concurrent',
  opts: {
    appClient: GitHubApp;
    db: Db;
    onResourceUpdate: (data: {
      repository: string;
      resource?: Resource;
      status?: string;
      started_at: number;
      finished_at: number;
      duration: number;
    }) => any;
  }
) {
  const startedAt = Date.now();

  const processor = async (resource: Resource) => {
    const pStartedAt = Date.now();

    const status = await genericProcessor(repo, resource, {
      appClient: opts.appClient,
      db: opts.db
    })
      .then(() => 'ok')
      .catch((error) => error.message || JSON.stringify(error));

    opts.onResourceUpdate({
      repository: repo.full_name,
      resource,
      status,
      started_at: pStartedAt,
      finished_at: Date.now(),
      duration: Date.now() - pStartedAt
    });
  };

  if (type === 'sequential') for (const resource of resources) await processor(resource);
  if (type === 'concurrent') await Promise.all(resources.map((resource) => processor(resource)));

  opts.onResourceUpdate({
    repository: repo.full_name,
    started_at: startedAt,
    finished_at: Date.now(),
    duration: Date.now() - startedAt
  });
}

program
  .addArgument(new Argument('[type]', '').choices(['github', 'proxy']).default('github'))
  .addOption(new Option('--workers [number]', 'Number of concurrent workers').default(1))
  .action(async (type: 'github' | 'proxy', opts: { workers: number }) => {
    const tokens = Array.from(Array(10).keys())
      .map((index) => process.env[`GH_TOKEN${index}`])
      .filter((value) => !!value);

    const suffix = Date.now();
    const useGithub = type === 'github';
    const workers = useGithub ? tokens.length : opts.workers;
    const prefix = workers + type.slice(0, 1);

    consola.info(
      'Starting benchmark of %s (tokens: %s workers: %s)',
      chalk.green(chalk.bold(type)),
      chalk.green(chalk.bold(tokens.length)),
      chalk.green(chalk.bold(workers))
    );

    const requestsStream = format({ headers: true, quote: true });
    requestsStream.pipe(
      createWriteStream(path.resolve(process.cwd(), 'logs', `requests_${prefix}-${suffix}.csv`))
    );

    const benchmarkStream = format({ headers: true, quote: true });
    benchmarkStream.pipe(
      createWriteStream(path.resolve(process.cwd(), 'logs', `benchmark-${prefix}-${suffix}.csv`))
    );

    const status = new Array(tokens.length).fill(true);
    const clients = tokens.map((token) => {
      const client = new GitHubApp(
        token || '',
        useGithub ? process.env.GH_GITHUB_URL : process.env.GH_PROXY_URL
      );

      client.on('response', (data) => requestsStream.write(data));

      return client;
    });

    const connectionOpts = {
      host: process.env.GH_MONGO_HOST ?? 'localhost',
      port: parseInt(process.env.GH_MONGO_PORT ?? '27017', 10),
      db: `benchmark-${suffix}`,
      username: process.env.GH_MONGO_USERNAME,
      password: process.env.GH_MONGO_PASSWORD
    };

    consola.info('Connecting to mongo database ...');
    const connection = await createConnection(connectionOpts).connect();
    const db = connection.db();

    await searchAndStore({ appClient: clients[0], db });

    const repos = await db
      .collection('repositories')
      .find()
      .sort({ stargazers_count: -1 })
      .toArray();

    const processor = queue(async (repo: Record<string, any>) => {
      consola.info(`[${repo.full_name}] starting processors ...`);
      const availableIndex = useGithub ? status.findIndex((s) => s === true) : 0;
      if (availableIndex < 0) {
        await processor.push(repo);
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 5000));
      }

      status[availableIndex] = false;
      await processResouces(
        repo,
        ['tags', 'releases', 'watchers', 'stargazers', 'issues'],
        useGithub ? 'sequential' : 'concurrent',
        {
          appClient: clients[availableIndex],
          db: db,
          onResourceUpdate: (data) => benchmarkStream.write(data)
        }
      );
      status[availableIndex] = true;
    }, workers);

    processor.error((err) => consola.error(err));

    await processor.push(repos);
    await processor.drain();

    consola.success('Process finished!');
  })
  .parse(process.argv);
