/* Author: Hudson S. Borges */
const chalk = require('chalk');
const dayjs = require('dayjs');
const relativeTime = require('dayjs/plugin/relativeTime');

const { Writable } = require('stream');
const { createStream, getBorderCharacters } = require('table');

dayjs.extend(relativeTime);

const stream = createStream({
  columnCount: 7,
  columnDefault: { alignment: 'right', width: 10 },
  columns: {
    0: { width: 8 },
    1: { width: 6 },
    2: { width: 6 },
    4: { width: 16 },
    5: { width: 6 }
  },
  drawHorizontalLine: (index) => index === 0,
  singleLine: true,
  border: getBorderCharacters('void')
});

let started = false;

module.exports = new Writable({
  objectMode: true,
  write({ api, token, queued, remaining, reset, status, duration }, encoding, done) {
    if (!started) {
      started = true;
      stream.write(
        ['api', 'token', 'queued', 'remaining', 'reset', 'status', 'duration'].map((v) =>
          chalk.bold(v)
        )
      );
    }

    stream.write([
      api,
      token,
      queued,
      remaining,
      dayjs.unix(reset).fromNow(),
      chalk[/[45]\d{2}/i.test(status) ? 'redBright' : 'green'](status),
      `${duration / 1000}s`
    ]);

    done();
  }
});
