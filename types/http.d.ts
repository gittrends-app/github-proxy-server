import { ClientRequest } from 'http';

declare module 'http' {
  export interface IncomingMessage {
    proxyRequest?: ClientRequest;
    startedAt?: Date;
  }
}
