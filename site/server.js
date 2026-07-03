#!/usr/bin/env node
// Static server for codex-rpc.ssh.codes (zero-dep).
'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = Number(process.env.PORT || 8243);
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p === '/install.sh' || p === '/install') p = '/install.sh';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || p.includes('..')) {
    res.writeHead(400); return res.end('bad request');
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('404'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' || ext === '.sh' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(data);
  });
}).listen(PORT, process.env.HOST || '127.0.0.1',
  () => console.log(`codex-rpc site on :${PORT}`));
