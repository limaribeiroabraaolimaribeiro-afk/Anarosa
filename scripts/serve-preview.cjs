/** Offline storefront preview: replay public GETs, reject every order/payment write. */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const publicRoot = path.join(root, '_site');
const snapshotPath = path.join(root, 'tmp/redesign/public-catalog.json');
const photoManifestPath = path.join(root, 'tmp/redesign/catalog-photo-manifest.json');
const port = Number(process.env.ANAROSA_PREVIEW_PORT || 5517);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid local preview port');
const origin = `http://127.0.0.1:${port}`;
const photos = fs.existsSync(photoManifestPath) ? JSON.parse(fs.readFileSync(photoManifestPath)) : [];
const photoByUrl = new Map(photos.filter((p) => p.file).map((p) => [p.url, p]));
const photoByFile = new Map(photos.filter((p) => p.file && /^[a-f0-9]{64}\.bin$/.test(p.file)).map((p) => [p.file, p]));
const snapshot = fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath)) : null;
const catalog = snapshot ? structuredClone(snapshot) : null;
if (catalog) for (const product of catalog.items) {
  product.images = (product.images || []).map((image) => {
    const url = typeof image === 'string' ? image : image.url;
    const cached = photoByUrl.get(url);
    return { ...(typeof image === 'object' ? image : {}), url: cached ? `${origin}/__preview/images/${cached.file}` : `${origin}/assets/products/placeholder.svg` };
  });
}
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const url = new URL(req.url, origin);
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, message: 'Prévia local: envio de pedidos, pagamentos e alterações estão desativados.' });
  if (url.pathname.startsWith('/functions/v1/')) {
    const name = url.pathname.slice('/functions/v1/'.length);
    if (!catalog) return json(res, 503, { ok: false, message: 'Prévia sem snapshot de catálogo público. Nenhum dado demonstrativo foi criado.' });
    if (name === 'storefront-products') {
      const q = (url.searchParams.get('q') || '').toLocaleLowerCase('pt-BR');
      const category = url.searchParams.get('category');
      const items = catalog.items.filter((p) => (!q || p.name.toLocaleLowerCase('pt-BR').includes(q)) && (!category || p.category?.slug === category));
      const offset = Math.max(0, Math.trunc(Number(url.searchParams.get('offset')) || 0));
      const limit = Math.min(200, Math.max(1, Math.trunc(Number(url.searchParams.get('limit')) || 200)));
      return json(res, 200, { ok: true, items: items.slice(offset, offset + limit), total: items.length });
    }
    if (name === 'storefront-product') {
      const product = catalog.items.find((p) => p.slug === url.searchParams.get('slug'));
      return json(res, product ? 200 : 404, product ? { ok: true, product } : { ok: false });
    }
    return json(res, 503, { ok: false, message: 'Prévia local: este serviço operacional está desativado.' });
  }
  if (url.pathname.startsWith('/__preview/images/')) {
    const file = url.pathname.slice('/__preview/images/'.length), photo = photoByFile.get(file);
    if (!photo) return res.writeHead(404).end();
    res.setHeader('Content-Type', photo.type || 'image/jpeg');
    return fs.createReadStream(path.join(root, 'tmp/redesign/catalog-images', file)).pipe(res);
  }
  let file;
  try { file = path.resolve(publicRoot, '.' + decodeURIComponent(url.pathname)); }
  catch { return res.writeHead(400).end(); }
  if (file !== publicRoot && !file.startsWith(publicRoot + path.sep)) return res.writeHead(403).end();
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.statSync(file).isFile()) return res.writeHead(404).end();
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    if (file === path.join(publicRoot, 'js/config.js')) {
      return res.end(fs.readFileSync(file, 'utf8') + `\nwindow.ANAROSA_CONFIG.functionsBaseUrl=${JSON.stringify(origin + '/functions/v1')};`);
    }
    if (file.endsWith('.html') && process.env.ANAROSA_PREVIEW_BADGE !== '0') {
      const badge = '<div role="note" style="position:fixed;z-index:200;bottom:8px;left:8px;background:#5A3E2B;color:#fff;padding:7px 11px;border-radius:4px;font:10px sans-serif">Prévia local · pedidos e pagamentos desativados</div>';
      return res.end(fs.readFileSync(file, 'utf8').replace('</body>', badge + '</body>'));
    }
    fs.createReadStream(file).pipe(res);
  } catch { res.writeHead(404).end('Não encontrado'); }
}).listen(port, '127.0.0.1', () => { console.log(`Prévia isolada: ${origin}`); if (process.send) process.send('ready'); });
process.on('message', (message) => { if (message === 'shutdown') { server.closeAllConnections(); server.close(() => process.exit(0)); } });
