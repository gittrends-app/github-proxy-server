/* Author: Hudson S. Borges */
const zlib = require('zlib');

async function compressBody(body) {
  return new Promise((resolve, reject) => {
    zlib.gzip(body, (err, buffer) => {
      if (err) return reject(err);
      return resolve(buffer);
    });
  });
}

module.exports = async function send(
  res,
  statusCode,
  data,
  { headers, compress = false } = {}
) {
  if (res.writableEnded) throw new Error('Response has already been sent.');

  if (!/^[1-5]\d{2}$/gi.test(statusCode))
    throw new Error(
      `Invalid status code !(status: ${statusCode}, data: ${JSON.stringify(data)})`
    );

  res.statusCode = parseInt(statusCode, 10);

  res.setHeader('content-type', 'application/json');

  const responseBody = compress
    ? await compressBody(JSON.stringify(data))
    : Buffer.from(JSON.stringify(data), 'utf8');

  if (headers) Object.keys(headers).forEach((key) => res.setHeader(key, headers[key]));

  if (compress) {
    res.setHeader('content-encoding', 'gzip');
    res.setHeader('transfer-encoding', 'gzip');
  } else {
    res.setHeader('content-length', Buffer.byteLength(responseBody));
  }

  return new Promise((resolve, reject) =>
    res.end(responseBody, (err) => (err ? reject(err) : resolve()))
  );
};
