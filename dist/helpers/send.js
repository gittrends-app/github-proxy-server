"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g;
    return g = { next: verb(0), "throw": verb(1), "return": verb(2) }, typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (_) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
/* Author: Hudson S. Borges */
var zlib_1 = __importDefault(require("zlib"));
function compressBody(body) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, new Promise(function (resolve, reject) {
                    zlib_1.default.gzip(body, function (err, buffer) {
                        if (err)
                            return reject(err);
                        return resolve(buffer);
                    });
                })];
        });
    });
}
function send() {
    var _a, _b, _c;
    return __awaiter(this, void 0, void 0, function () {
        var responseBody, _d;
        var _this = this;
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    if (this.res.writableEnded)
                        throw new Error('Response has already been sent.');
                    if (!/^[1-5]\d{2}$/gi.test("" + this.statusCode)) {
                        throw new Error("Invalid status code (status: " + this.statusCode + ")!");
                    }
                    this.res.statusCode = this.statusCode;
                    this.res.setHeader('content-type', 'application/json');
                    if (!((_a = this.opts) === null || _a === void 0 ? void 0 : _a.compress)) return [3 /*break*/, 2];
                    return [4 /*yield*/, compressBody(JSON.stringify(this.data))];
                case 1:
                    _d = _e.sent();
                    return [3 /*break*/, 3];
                case 2:
                    _d = Buffer.from(JSON.stringify(this.data), 'utf8');
                    _e.label = 3;
                case 3:
                    responseBody = _d;
                    if ((_b = this.opts) === null || _b === void 0 ? void 0 : _b.headers) {
                        Object.entries(this.opts.headers).forEach(function (tuple) {
                            _this.res.setHeader(tuple[0], tuple[1]);
                        });
                    }
                    if ((_c = this.opts) === null || _c === void 0 ? void 0 : _c.compress) {
                        this.res.setHeader('content-encoding', 'gzip');
                        this.res.setHeader('transfer-encoding', 'gzip');
                    }
                    else {
                        this.res.setHeader('content-length', Buffer.byteLength(responseBody));
                    }
                    return [2 /*return*/, new Promise(function (resolve, reject) {
                            _this.res.write(responseBody, function (err) {
                                if (err)
                                    return reject(err);
                                _this.res.end(function (err) { return (err ? reject(err) : resolve()); });
                            });
                        })];
            }
        });
    });
}
exports.default = send;
