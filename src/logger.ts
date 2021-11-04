/* Author: Hudson S. Borges */
import chalk from 'chalk';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { Writable } from 'stream';
import { WritableStream, createStream, getBorderCharacters } from 'table';

dayjs.extend(relativeTime);

export interface ProxyLoggerDTO {
  token: string;
  queued: number;
  remaining: number;
  reset: number;
  status: number;
  duration: number;
}

export default class ProxyLogger extends Writable {
  started = false;
  readonly stream: WritableStream;

  constructor() {
    super({ objectMode: true });

    this.stream = createStream({
      columnCount: 6,
      columnDefault: { alignment: 'right', width: 5 },
      columns: {
        0: { width: 5 },
        1: { width: 3 },
        2: { width: 5 },
        3: { width: 18 },
        4: { width: 4 },
        5: { width: 7 }
      },
      border: getBorderCharacters('void')
    });
  }

  /* eslint-disable-next-line */
  _write(chunk: ProxyLoggerDTO, encoding: string, done: Function) {
    if (!this.started) {
      this.started = true;
      process.stdout.write('\n' + chalk.bold('Columns: '));
      process.stdout.write(
        ['token', 'queue', 'remaining', 'reset', 'status', 'duration']
          .map((v) => chalk.underline(v))
          .join(', ') + '\n'
      );
    }

    this.stream.write([
      chunk.token,
      `${chunk.queued}`,
      `${chunk.remaining}`,
      dayjs.unix(chunk.reset).fromNow(),
      chalk[/[45]\d{2}/i.test(`${chunk.status}`) ? 'redBright' : 'green'](chunk.status),
      `${chunk.duration / 1000}s`
    ]);

    done();
  }
}
