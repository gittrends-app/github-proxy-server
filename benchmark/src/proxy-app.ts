import chalk from 'chalk';
import consola from 'consola';
import { address } from 'ip';

import { APIVersion, createProxyServer } from './cli';

const PORT = parseInt(process.env.PORT || '3000', 10);

const tokens = [...Array(10)]
  .map((_, index) => process.env[`GH_TOKEN${index}`])
  .filter((t) => t !== undefined);

const app = createProxyServer({
  api: APIVersion.REST,
  minRemaining: 0,
  requestInterval: 50,
  requestTimeout: 15000,
  tokens: tokens as string[]
});

app.server
  .on('warn', consola.warn)
  .on('log', (data) => process.stdout.write(data.toString()))
  .on('listening', () => {
    const host = `http://${address()}:${PORT}`;
    consola.success(
      `Proxy server running on ${host} (tokens: ${chalk.greenBright(tokens.length)})`
    );
  });

app.listen(PORT, '0.0.0.0', (error) => {
  if (error) {
    consola.error(error);
    app.close();
  }

  process.on('SIGTERM', async () => {
    consola.info('SIGTERM signal received: closing HTTP server');

    app
      .close()
      .finally(() => consola.success('Server closed'))
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
});
