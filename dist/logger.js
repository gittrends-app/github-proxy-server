"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/* Author: Hudson S. Borges */
const chalk_1 = __importDefault(require("chalk"));
const dayjs_1 = __importDefault(require("dayjs"));
const relativeTime_1 = __importDefault(require("dayjs/plugin/relativeTime"));
const stream_1 = require("stream");
const table_1 = require("table");
dayjs_1.default.extend(relativeTime_1.default);
class ProxyLogger extends stream_1.Writable {
    constructor() {
        super({ objectMode: true });
        this.started = false;
        this.stream = (0, table_1.createStream)({
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
            border: (0, table_1.getBorderCharacters)('void')
        });
    }
    /* eslint-disable-next-line */
    _write(chunk, encoding, done) {
        if (!this.started) {
            this.started = true;
            process.stdout.write('\n' + chalk_1.default.bold('Columns: '));
            process.stdout.write(['token', 'queue', 'remaining', 'reset', 'status', 'duration']
                .map((v) => chalk_1.default.underline(v))
                .join(', ') + '\n');
        }
        this.stream.write([
            chunk.token,
            `${chunk.queued}`,
            `${chunk.remaining}`,
            dayjs_1.default.unix(chunk.reset).fromNow(),
            chalk_1.default[/[45]\d{2}/i.test(`${chunk.status}`) ? 'redBright' : 'green'](chunk.status),
            `${chunk.duration / 1000}s`
        ]);
        done();
    }
}
exports.default = ProxyLogger;
