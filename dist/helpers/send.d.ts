/// <reference types="node" />
import { ServerResponse } from 'http';
interface SendDTO {
    res: ServerResponse;
    statusCode: number;
    data: object;
    opts?: {
        headers: object;
        compress: boolean;
    };
}
export default function send(this: SendDTO): Promise<void>;
export {};
