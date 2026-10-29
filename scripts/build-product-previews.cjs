'use strict';

/**
 * Gera prévias Open Graph por produto no artefato do GitHub Pages.
 * Bots do WhatsApp não executam o JavaScript da página produto.html.
 * Fonte exclusiva: API pública do catálogo ANAROSA (sem credenciais privadas).
 */
const fs = require('node:fs');
const path = require('node:path');

const OUTPUT = path.resolve(__dirname, '..', '_site', 'p');
const STORE = 'https://www.lojaanarosa.com.br';
const SUPABASE = 'https://gpmbkptimjipqsayrvce.supabase.co';
const API = SUPABASE + '/functions/v1/storefront-products';
const IMAGE_PREFIX = SUPABASE + '/storage/v1/object/public/anarosa-product-images/';
const BRAND_IMAGE = STORE + '/assets/logo/logo-anarosa.jpg';
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,138}[a-z0-9])?$/;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function plain(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}
function isStableImage(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    const expires = Number(url.searchParams.get('Expires'));
    if (expires && expires <= Date.now() / 1000 + 3600) return false;
    if (url.hostname === 'orgbling.s3.amazonaws.com') return false;
    return true;
  } catch { return false; }
}
function stableStorageUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === SUPABASE && url.href.startsWith(IMAGE_PREFIX) && isStableImage(url.href)
      ? url.href : null;
  } catch { return null; }
}
async function imageUrl(product) {
  const candidates = Array.isArray(product.images) ? product.images.slice(0, 3) : [];
  for (const picture of candidates) {
    const source = typeof picture === 'string' ? picture : picture?.url;
    if (!source) continue;
    let url;
    try { url = new URL(source); } catch { continue; }
    if (url.origin === SUPABASE && url.pathname === '/functions/v1/storefront-image') {
      // Este endpoint transforma a foto temporária do Bling em um arquivo público
      // permanente no Storage; nunca expor a URL S3 assinada na prévia.
      try {
        const res = await fetch(url.href, {
          redirect: 'manual',
          signal: AbortSignal.timeout(16000),
          headers: { Accept: 'image/jpeg,image/png,image/webp' },
        });
        const target = res.headers.get('location');
        const permanent = target ? stableStorageUrl(new URL(target, url).href) : null;
        if ((res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) && permanent) {
          return permanent;
        }
        console.warn('Imagem ainda indisponível para ' + product.slug + ' (HTTP ' + res.status + ')');
      } catch (error) {
        console.warn('Falha ao preparar imagem de ' + product.slug + ': ' + error.message);
      }
      continue;
    }
    if (isStableImage(source)) return url.href;
  }
  console.warn('Sem foto pública válida para: ' + product.slug + '; usando logo ANAROSA');
  return BRAND_IMAGE;
}
async function listProducts() {
  const products = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total && products.length < 5000) {
    const url = new URL(API);
    url.searchParams.set('limit', '200');
    url.searchParams.set('offset', String(offset));
    const res = await fetch(url.href, {
      signal: AbortSignal.timeout(20000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error('Catálogo público respondeu HTTP ' + res.status);
    const data = await res.json();
    if (data?.ok !== true || !Array.isArray(data.items) || !Number.isSafeInteger(data.total)) {
      throw new Error('Contrato inesperado da API pública de produtos');
    }
    if (data.items.length === 0 && offset < data.total) throw new Error('Paginação interrompida inesperadamente');
    total = data.total;
    products.push(...data.items);
    offset += data.items.length;
  }
  if (!products.length || offset < total) throw new Error('Catálogo vazio ou incompleto; publicação abortada');
  return products.filter((p) => SLUG.test(p.slug || '') && p.name);
}
function makeHtml(product, image) {
  const title = plain(product.name).slice(0, 150);
  const desc = plain(product.shortDescription || product.description).slice(0, 185) ||
    ('Confira fotos, tamanhos e disponibilidade de ' + title + ' na loja ANAROSA.');
  const productLink = STORE + '/produto.html?slug=' + encodeURIComponent(product.slug);
  const previewLink = STORE + '/p/' + encodeURIComponent(product.slug) + '.html';
  const redirectScript = 'window.location.replace(' + JSON.stringify(productLink) + ');';
  return [
    '<!doctype html>',
    '<html lang="pt-BR"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>' + esc(title) + ' | ANAROSA</title>',
    '<meta name="description" content="' + esc(desc) + '">',
    '<meta name="robots" content="noindex,follow">',
    '<link rel="canonical" href="' + esc(productLink) + '">',
    '<meta property="og:type" content="product">',
    '<meta property="og:locale" content="pt_BR">',
    '<meta property="og:site_name" content="ANAROSA">',
    '<meta property="og:title" content="' + esc(title) + ' | ANAROSA">',
    '<meta property="og:description" content="' + esc(desc) + '">',
    '<meta property="og:url" content="' + esc(previewLink) + '">',
    '<meta property="og:image" content="' + esc(image) + '">',
    '<meta property="og:image:secure_url" content="' + esc(image) + '">',
    '<meta property="og:image:alt" content="' + esc(title) + '">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:title" content="' + esc(title) + ' | ANAROSA">',
    '<meta name="twitter:description" content="' + esc(desc) + '">',
    '<meta name="twitter:image" content="' + esc(image) + '">',
    '</head><body>',
    '<main><h1>' + esc(title) + '</h1>',
    '<p>' + esc(desc) + '</p>',
    '<p><a href="' + esc(productLink) + '">Ver fotos, tamanhos e comprar na ANAROSA</a></p></main>',
    '<script>' + redirectScript + '</script>',
    '</body></html>\n',
  ].join('\n');
}
async function build() {
  const products = await listProducts();
  fs.mkdirSync(OUTPUT, { recursive: true });
  for (let index = 0; index < products.length; index += 4) {
    const batch = products.slice(index, index + 4);
    const images = await Promise.all(batch.map(imageUrl));
    batch.forEach((product, i) => {
      fs.writeFileSync(path.join(OUTPUT, product.slug + '.html'), makeHtml(product, images[i]));
    });
  }
  console.log('Prévias Open Graph individuais geradas: ' + products.length);
}
if (require.main === module) build().catch((error) => {
  console.error('Falha ao preparar prévias: ' + error.message);
  process.exitCode = 1;
});
module.exports = { esc, plain, isStableImage, stableStorageUrl, makeHtml, imageUrl, listProducts, build };
