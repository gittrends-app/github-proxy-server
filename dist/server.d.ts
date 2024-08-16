#!/usr/bin/env node
import { Express } from 'express';
import { ProxyRouterOpts } from './router.js';
export declare function parseTokens(text: string): string[];
export declare function concatTokens(token: string, list: string[]): string[];
export declare function readTokensFile(filename: string): string[];
export type CliOpts = ProxyRouterOpts & {
    tokens: string[];
    silent?: boolean;
    statusMonitor?: boolean;
};
export declare function createProxyServer(options: CliOpts): Express;
