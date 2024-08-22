import { Request, Response } from 'express';
import EventEmitter from 'node:events';
export type ProxyRouterOpts = {
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
export declare enum ProxyRouterResponse {
    PROXY_ERROR = 600
}
export default class ProxyRouter extends EventEmitter {
    private readonly options;
    private readonly limiter;
    private readonly clients;
    constructor(tokens: string[], opts?: Partial<ProxyRouterOpts>);
    schedule(req: Request, res: Response): Promise<void>;
    addToken(token: string): void;
    removeToken(token: string): void;
    refreshRateLimits(): Promise<void>;
    get tokens(): string[];
    destroy(): this;
}
export {};
