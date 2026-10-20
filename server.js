'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, 'public');
function backendConnectSources(root) {
  const sources = ["'self'"];
  try {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'pair-config.json'), 'utf8'));
    const parsed = new URL(String(config.backendUrl || ''));
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      sources.push(parsed.origin);
      const socketScheme = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
      sources.push(socketScheme + '//' + parsed.host);
    }
  } catch {}
  return sources.join(' ');
}

const PORT = 4177;
const CONNECT_SOURCES = backendConnectSources(ROOT);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(ROOT, '.' + pathname);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(file, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404, { 'Cache-Control': 'no-store' }).end('Not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src " + CONNECT_SOURCES + "; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      'Cache-Control': path.basename(file) === 'pair-config.json' ? 'no-store' : 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Only Us local app ready at http://127.0.0.1:' + PORT);
  console.log('Local-only HTTP listener: 127.0.0.1 (not exposed as a LAN server).');
});
server.on('error', (err) => {
  console.error('Only Us local server error:', err.message);
  process.exitCode = 1;
});
