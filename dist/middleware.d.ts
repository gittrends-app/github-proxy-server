/// <reference types="node" />
import { PassThrough } from 'stream';
import { Response, Request, NextFunction } from 'express';
export default class Proxy extends PassThrough {
    private readonly clients;
    private readonly requestInterval;
    private readonly requestTimeout;
    private readonly minRemaining;
    constructor(tokens: string[], opts?: {
        requestInterval?: number;
        requestTimeout?: number;
        minRemaining?: number;
    });
    schedule(req: Request, res: Response, next: NextFunction): void;
    removeToken(token: string): void;
}
