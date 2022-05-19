import { MongoClient } from 'mongodb';

export function createConnection(opts?: {
  host: string;
  port: number;
  db: string;
  username?: string;
  password?: string;
}) {
  const config = Object.assign({ host: 'localhost', port: 27017, db: 'benchmark-test' }, opts);
  const prefix = config.username
    ? `${config.username}${config.password ? `:${config.password}` : ''}@`
    : '';

  const conn = new MongoClient(
    `mongodb://${prefix}${config.host}:${config.port}?authSource=admin`,
    { maxPoolSize: 5 }
  );

  const source = conn.db.bind(conn);
  conn.db = (dbName, options) => source(dbName ?? config.db, options);

  return conn;
}
