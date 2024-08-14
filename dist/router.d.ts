import { Request, Response } from 'express';
import { PassThrough } from 'stream';
type ProxyWorkerOpts = {
    requestTimeout: number;
    requestInterval: number;
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
    status: number;
    duration: number;
}
export type ProxyRouterOpts = ProxyWorkerOpts & {
    minRemaining: number;
};
export declare enum ProxyRouterResponse {
    PROXY_ERROR = 600
}
export default class ProxyRouter extends PassThrough {
    private readonly clients;
    private readonly options;
    constructor(tokens: string[], opts?: ProxyRouterOpts);
    schedule(req: Request, res: Response): Promise<void>;
    removeToken(token: string): void;
    addToken(token: string): void;
    get tokens(): string[];
    destroy(error?: Error): this;
}
export {};
