/* Author: Hudson S. Borges */
const chalk = require('chalk');
const dayjs = require('dayjs');
const relativeTime = require('dayjs/plugin/relativeTime');
const { createStream, getBorderCharacters } = require('table');

dayjs.extend(relativeTime);

const stream = createStream({
  columnCount: 7,
  columnDefault: { alignment: 'right', width: 10 },
  columns: {
    0: { width: 8 },
    1: { width: 6 },
    2: { width: 6 },
    4: { width: 15 },
    5: { width: 6 }
  },
  drawHorizontalLine: (index) => index === 0,
  singleLine: true,
  border: getBorderCharacters('void')
});

let count = -1;

module.exports = ({ api, token, queued, remaining, reset, status, duration }) => {
  // eslint-disable-next-line no-cond-assign
  if (!(count = (count + 1) % 250)) {
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
};
