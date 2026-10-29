const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = join(__dirname, '..');
const file = (path) => readFileSync(join(root, path), 'utf8');

test('a listagem canônica omite filhos duplicados sem removê-los', () => {
  const sql = file('supabase/migrations/20261029100000_canonical_product_cards.sql');
  assert.match(sql, /CREATE OR REPLACE VIEW public\.store_catalog_products/i);
  assert.match(sql, /NOT EXISTS\s*\([\s\S]*store_product_variants/i);
  assert.match(sql, /v\.bling_id\s*=\s*p\.bling_id/);
  assert.match(sql, /security_invoker\s*=\s*true/);
  assert.doesNotMatch(sql, /DELETE\s+FROM\s+public\.store_products/i);
});

test('Gestão e loja paginam os produtos principais e preservam variante selecionada', () => {
  const repo = file('supabase/functions/_shared/catalog-repo.ts');
  const app = file('gestao/js/gestao.js');
  assert.ok((repo.match(/from\('store_catalog_products'\)/g) || []).length >= 5);
  assert.match(app, /data-product-variant/);
  assert.match(app, /updateCardVariantPreview/);
  assert.match(app, /openStockDrawer\(productsByBlingId\.get\(blingId\), card\.querySelector/);
  assert.match(app, /skuSelect\.value\s*=\s*String\(chosen\.blingId\)/);
});
