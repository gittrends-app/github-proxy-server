/// <reference types="node" />
import { Writable } from 'stream';
import { WritableStream } from 'table';
export interface ProxyLoggerDTO {
    token: string;
    queued: number;
    remaining: number;
    reset: number;
    status: number;
    duration: number;
}
export default class ProxyLogger extends Writable {
    started: boolean;
    readonly stream: WritableStream;
    constructor();
    _write(chunk: ProxyLoggerDTO, encoding: string, done: Function): void;
}
