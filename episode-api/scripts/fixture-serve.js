'use strict';

/**
 * Hostea LOCALMENTE el MP3 descargado para que las pruebas no dependan de
 * SoundCloud. Soporta GET, HEAD y Range (igual que un CDN real).
 *
 *   npm run fixture:serve            # http://127.0.0.1:8787
 *   PORT=8787 node scripts/fixture-serve.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURES = path.join(__dirname, '../fixtures');

function contentType(name) {
  if (name.endsWith('.mp3')) return 'audio/mpeg';
  if (name.endsWith('.json')) return 'application/json; charset=utf-8';
  if (name.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function createFixtureServer({ dir = FIXTURES, port = Number(process.env.FIXTURE_PORT || 8787) } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const name = decodeURIComponent(url.pathname).replace(/^\/+/, '');

    if (!name || name === '/') {
      const files = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile()).map(f => ({
          name: f,
          bytes: fs.statSync(path.join(dir, f)).size,
          url: `/${encodeURIComponent(f)}`
        }))
        : [];
      const body = JSON.stringify({ files }, null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(body);
    }

    const filePath = path.resolve(dir, name);
    if (!filePath.startsWith(path.resolve(dir)) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      return res.end('not found');
    }

    const stat = fs.statSync(filePath);
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (match) {
        start = match[1] ? Number(match[1]) : 0;
        end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (start > end || start >= stat.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          return res.end();
        }
        status = 206;
      }
    }

    res.writeHead(status, {
      'Content-Type': contentType(name),
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {})
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath, { start, end }).pipe(res);
  });

  server.fixturesDir = dir;
  server.defaultPort = port;
  return server;
}

if (require.main === module) {
  const server = createFixtureServer();
  server.listen(server.defaultPort, '127.0.0.1', () => {
    console.log(`Fixture local: http://127.0.0.1:${server.defaultPort}/`);
    console.log(`Directorio   : ${FIXTURES}`);
  });
}

module.exports = { createFixtureServer, FIXTURES };
