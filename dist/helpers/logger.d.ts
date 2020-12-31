/// <reference types="node" />
import { Writable } from 'stream';
import { TableStream } from 'table';
interface LoggerDTO {
    api: string;
    token: string;
    queued: number;
    remaining: number;
    reset: number;
    status: number;
    duration: number;
}
declare class Logger extends Writable {
    started: boolean;
    readonly stream: TableStream;
    constructor();
    _write(chunk: LoggerDTO, encoding: string, done: Function): void;
}
declare const _default: Logger;
export default _default;
