"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/* Author: Hudson S. Borges */
var chalk_1 = __importDefault(require("chalk"));
var dayjs_1 = __importDefault(require("dayjs"));
var relativeTime_1 = __importDefault(require("dayjs/plugin/relativeTime"));
var stream_1 = require("stream");
var table_1 = require("table");
dayjs_1.default.extend(relativeTime_1.default);
var Logger = /** @class */ (function (_super) {
    __extends(Logger, _super);
    function Logger() {
        var _this = _super.call(this, { objectMode: true }) || this;
        _this.started = false;
        _this.stream = table_1.createStream({
            columnCount: 7,
            columnDefault: { alignment: 'right', width: 10 },
            columns: {
                0: { width: 8 },
                1: { width: 6 },
                2: { width: 6 },
                4: { width: 16 },
                5: { width: 6 }
            },
            drawHorizontalLine: function (index) { return index === 0; },
            singleLine: true,
            border: table_1.getBorderCharacters('void')
        });
        return _this;
    }
    Logger.prototype._write = function (chunk, encoding, done) {
        if (!this.started) {
            this.started = true;
            this.stream.write(['api', 'token', 'queued', 'remaining', 'reset', 'status', 'duration'].map(function (v) {
                return chalk_1.default.bold(v);
            }));
        }
        this.stream.write([
            chunk.api,
            chunk.token,
            "" + chunk.queued,
            "" + chunk.remaining,
            dayjs_1.default.unix(chunk.reset).fromNow(),
            chalk_1.default[/[45]\d{2}/i.test("" + chunk.status) ? 'redBright' : 'green'](status),
            chunk.duration / 1000 + "s"
        ]);
        done();
    };
    return Logger;
}(stream_1.Writable));
exports.default = new Logger();
