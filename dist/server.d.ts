#!/usr/bin/env node
import { Express } from 'express';
import { Transform } from 'node:stream';
import { ProxyRouterOpts, WorkerLogger } from './router.js';
export declare class ProxyLogTransform extends Transform {
    private started;
    private config?;
    constructor();
    _transform(chunk: WorkerLogger, encoding: string, done: (error?: Error) => void): void;
}
export declare function parseTokens(text: string): string[];
export declare function concatTokens(token: string, list: string[]): string[];
export declare function readTokensFile(filename: string): string[];
export type CliOpts = ProxyRouterOpts & {
    tokens: string[];
    silent?: boolean;
    statusMonitor?: boolean;
};
export declare function createProxyServer(options: CliOpts): Express;
