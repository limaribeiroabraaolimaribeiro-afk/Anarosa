const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const out = path.join(root, '_site');
// Explicit allowlist: new internal files never become public automatically.
const files = [
  'index.html',
  'checkout.html',
  'pedido-confirmado.html',
  'informacoes.html',
  'css/fonts.css',
  'assets/fonts/LICENSE.txt',
  'css/reset.css',
  'css/variables.css',
  'css/styles.css',
  'css/responsive.css',
  'css/checkout.css',
  'css/pedido-confirmado.css',
  'js/config.js',
  'js/products.js',
  'js/app.js',
  'js/checkout.js',
  'js/pedido-confirmado.js',
  'js/informacoes.js',
  'js/services/catalog-service.js',
  'js/services/cart-service.js',
  'js/services/settings-service.js',
  'js/services/ui-service.js',
  'gestao/index.html',
  'gestao/css/gestao.css',
  'gestao/js/gestao-auth.js',
  'gestao/js/gestao-api.js',
  'gestao/js/gestao.js',
  'gestao/js/product-editor.js',
  'gestao/js/gestao-extras.js',
];
if (path.dirname(out) !== root || path.basename(out) !== '_site') throw Error('Unsafe build destination');
fs.rmSync(out, { recursive: true, force: true });
for (const file of files) {
  const dest = path.join(out, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, file), dest);
}
function assets(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    // Keep source PNGs and their manifest in the repository, outside the public
    // artifact. Only the optimized campaign derivatives are needed by the shop.
    const publicPath = file.split(path.sep).join('/');
    if (publicPath.startsWith('assets/img/') && !publicPath.startsWith('assets/img/optimized/') && publicPath !== 'assets/img/optimized') continue;
    if (entry.isDirectory()) assets(file);
    else if (/\.(svg|webp|avif|png|jpe?g|gif|ico|woff2?)$/i.test(entry.name)) {
      if (entry.isSymbolicLink()) throw Error('Asset symlink forbidden');
      fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(out, file));
    }
  }
}
assets('assets');
fs.writeFileSync(path.join(out, 'CNAME'), 'www.lojaanarosa.com.br\n');
fs.writeFileSync(path.join(out, '.nojekyll'), '');
for (const file of files.filter((f) => f.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(out, file), 'utf8');
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))(?:\?[^"']*)?["']/g)) {
    if (/^https?:/.test(match[1])) continue;
    const resolved = path.resolve(path.dirname(path.join(out, file)), match[1]);
    if (!resolved.startsWith(out + path.sep) || !fs.existsSync(resolved)) {
      throw Error(`Missing public dependency: ${file} -> ${match[1]}`);
    }
  }
}
console.log(`Artefato público verificado: ${files.length} arquivos de aplicação + imagens/fontes.`);
