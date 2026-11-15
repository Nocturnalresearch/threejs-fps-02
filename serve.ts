// serve.ts — a tiny static server for playing EMBERLINE locally.
//
//   node serve.ts [--port N]     default port 8080 on 127.0.0.1
//
// Serves game/ only. Any path that escapes game/ (including `..` tricks)
// gets a 404, never a file. Written without TypeScript-only syntax so it
// also passes node --check.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { existsSync, statSync } from 'node:fs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

const gameDir = resolve(new URL('.', import.meta.url).pathname, 'game');

const args = process.argv.slice(2);
let port = 8080;
const portIdx = args.indexOf('--port');
if (portIdx >= 0 && args[portIdx + 1]) {
  const parsed = parseInt(args[portIdx + 1], 10);
  if (!Number.isNaN(parsed)) port = parsed;
}

function send(res, status, body, type = 'text/plain') {
  res.writeHead(status, { 'content-type': type });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    const raw = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
    const rel = normalize(raw).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    const target = resolve(gameDir, rel === '' ? 'index.html' : rel);
    // Refuse anything outside game/.
    if (target !== gameDir && !target.startsWith(gameDir + sep)) {
      send(res, 404, 'not found');
      return;
    }
    let file = target;
    if (existsSync(file) && statSync(file).isDirectory()) {
      file = join(file, 'index.html');
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      send(res, 404, 'not found');
      return;
    }
    const body = await readFile(file);
    send(res, 200, body, MIME[extname(file).toLowerCase()] || 'application/octet-stream');
  } catch {
    send(res, 404, 'not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`EMBERLINE serving game/ at http://127.0.0.1:${port}/`);
});
