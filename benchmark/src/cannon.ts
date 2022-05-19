import { format } from '@fast-csv/format';
import { queue } from 'async';
import axios from 'axios';
import Chance from 'chance';
import { Argument, Option, program } from 'commander';
import { createWriteStream } from 'fs';
import path from 'path';

program
  .addArgument(
    new Argument('target', 'Service target').choices(['github', 'proxy']).default('github')
  )
  .addOption(
    new Option('--workers [number]', 'Number of request workers').default(1).argParser(Number)
  )
  .addOption(
    new Option('--number [number]', 'Number of requests to perform').default(500).argParser(Number)
  )
  .action(async (target, opts) => {
    let requestId = 0;
    const suffix = Date.now();
    const client = axios.create({
      baseURL: target === 'github' ? 'https://api.github.com' : 'http://localhost:3000',
      headers: {
        'user-agent': 'GitHub Proxy Server',
        authorization: `token ${process.env.GH_TOKEN0}`
      },
      validateStatus: () => true
    });

    const stream = format({ headers: true, quote: true });
    stream.pipe(createWriteStream(path.resolve(process.cwd(), 'logs', `cannon-${suffix}.csv`)));

    client.interceptors.request.use((request) => {
      request.headers = {
        ...(request.headers ? request.headers : {}),
        started_at: Date.now(),
        id: ++requestId
      };
      return request;
    });

    client.interceptors.response.use((response) => {
      stream.write({
        request_id: response.config.headers?.id,
        url: `${response.config.baseURL}${response.config.url}`,
        status: response.status,
        started_at: response.config.headers?.started_at,
        finished_at: Date.now(),
        duration: Date.now() - Number(response.config.headers?.started_at)
      });
      return response;
    });

    const chance = new Chance();
    const requestQueue = queue(
      async () => client(`/users/${chance.first().toLowerCase()}`),
      opts.workers
    );
    requestQueue.push([...Array(opts.number).keys()]);

    await requestQueue.drain();
  })
  .parse(process.argv);
