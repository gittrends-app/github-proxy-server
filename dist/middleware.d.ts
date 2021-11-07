/// <reference types="node" />
import { Request, Response } from 'express';
import { PassThrough } from 'stream';
export declare class ProxyError extends Error {
    constructor(m: string);
}
declare type ClientOpts = {
    requestTimeout?: number;
    requestInterval?: number;
    clustering?: {
        host: string;
        port: number;
        db: number;
    };
};
export declare type ProxyMiddlewareOpts = ClientOpts & {
    minRemaining?: number;
};
export default class ProxyMiddleware extends PassThrough {
    private readonly clients;
    private readonly options;
    constructor(tokens: string[], opts?: ProxyMiddlewareOpts);
    schedule(req: Request, res: Response): void;
    removeToken(token: string): void;
    addToken(token: string): void;
    get tokens(): string[];
}
export {};
