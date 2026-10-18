const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.ANAROSA_PUBLIC_ROOT || path.resolve(__dirname, '..');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
};
const server = http.createServer((req, res) => {
  let file;
  try {
    file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(5500, '127.0.0.1', () => {
  console.log('Local: http://127.0.0.1:5500');
  if (process.send) process.send('ready');
});
process.on('message', (message) => {
  if (message === 'shutdown') {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  }
});
