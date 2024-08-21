import { Request, Response } from 'express';
import EventEmitter from 'node:events';
type ProxyWorkerOpts = {
    requestTimeout: number;
    minRemaining: number;
    overrideAuthorization?: boolean;
    clustering?: {
        host: string;
        port: number;
        db: number;
    };
};
type APIResources = 'core' | 'search' | 'code_search' | 'graphql';
export interface WorkerLogger {
    resource: APIResources;
    token: string;
    pending: number;
    remaining: number;
    reset: number;
    status?: number | string;
    duration: number;
}
export type ProxyRouterOpts = ProxyWorkerOpts & {
    minRemaining: number;
};
export declare enum ProxyRouterResponse {
    PROXY_ERROR = 600
}
export default class ProxyRouter extends EventEmitter {
    readonly limiter: import("p-limit").LimitFunction;
    private readonly clients;
    private readonly options;
    constructor(tokens: string[], opts?: ProxyRouterOpts);
    schedule(req: Request, res: Response): Promise<void>;
    addToken(token: string): void;
    removeToken(token: string): void;
    get tokens(): string[];
    destroy(): this;
}
export {};
