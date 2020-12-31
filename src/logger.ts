/* Author: Hudson S. Borges */
import chalk from 'chalk';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';

import { Writable } from 'stream';
import { createStream, getBorderCharacters, TableStream } from 'table';

dayjs.extend(relativeTime);

interface LoggerDTO {
  token: string;
  queued: number;
  remaining: number;
  reset: number;
  status: number;
  duration: number;
}

class Logger extends Writable {
  started = false;
  readonly stream: TableStream;

  constructor() {
    super({ objectMode: true });

    this.stream = createStream({
      columnCount: 6,
      columnDefault: { alignment: 'right', width: 10 },
      columns: {
        0: { width: 6 },
        1: { width: 6 },
        3: { width: 20 },
        4: { width: 6 }
      },
      drawHorizontalLine: (index) => index === 0,
      singleLine: true,
      border: getBorderCharacters('void')
    });
  }

  /* eslint-disable-next-line */
  _write(chunk: LoggerDTO, encoding: string, done: Function) {
    if (!this.started) {
      this.started = true;
      this.stream.write(
        ['token', 'queued', 'remaining', 'reset', 'status', 'duration'].map((v) => chalk.bold(v))
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

export default new Logger();
