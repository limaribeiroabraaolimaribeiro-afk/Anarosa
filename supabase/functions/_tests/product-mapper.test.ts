import assert from 'node:assert/strict';
import {
  computeAvailableStock,
  extractStockFromWebhook,
  mapBlingCategory,
  mapBlingProduct,
  mapBlingStockBalances,
  parseVariationAttributes,
  slugify,
} from '../_shared/product-mapper.ts';
import { serializePublicProduct } from '../_shared/storefront-serializer.ts';

Deno.test('slugify: remove acentos e caracteres especiais', () => {
  assert.equal(slugify('Camiseta Ogochi Infantil'), 'camiseta-ogochi-infantil');
  assert.equal(slugify('Vestido Plus Size — Floral / Verão!'), 'vestido-plus-size-floral-verao');
  assert.equal(slugify(''), 'produto');
});

Deno.test('mapper: produto simples', () => {
  const { product, variants, categoryBlingId, isVariantOfParent } = mapBlingProduct({
    id: 1001,
    nome: 'CAMISETA OGOCHI INFANTIL',
    codigo: 'OG-001',
    preco: '59.90',
    situacao: 'A',
    formato: 'S',
    tipo: 'P',
    descricaoCurta: 'Camiseta infantil',
    marca: 'Ogochi',
    categoria: { id: 7 },
    midia: { imagens: { internas: [{ link: 'https://img/1.jpg' }], externas: [] } },
    estoque: { saldoFisicoTotal: 10, saldoVirtualTotal: 8 },
  });
  assert.equal(product.bling_id, '1001');
  assert.equal(product.sku, 'OG-001');
  assert.equal(product.price, 59.9);
  assert.equal(product.promotional_price, null, 'nunca inventa desconto');
  assert.equal(product.slug, 'camiseta-ogochi-infantil');
  assert.equal(product.active, true);
  assert.equal(product.brand, 'Ogochi');
  assert.deepEqual(product.images, [{ url: 'https://img/1.jpg', alt: null, source: 'internal' }]);
  assert.equal(categoryBlingId, '7');
  assert.equal(variants.length, 0);
  assert.equal(isVariantOfParent, false);
  assert.equal(product.metadata.hasVariations, false);
});

Deno.test('mapper: produto inativo/excluído vira active=false', () => {
  assert.equal(mapBlingProduct({ id: 1, nome: 'X', situacao: 'I' }).product.active, false);
  assert.equal(mapBlingProduct({ id: 1, nome: 'X', situacao: 'E' }).product.active, false);
});

Deno.test('mapper: produto pai com variações cor/tamanho', () => {
  const { product, variants } = mapBlingProduct({
    id: 2000,
    nome: 'Camiseta Roadster',
    preco: 89.9,
    situacao: 'A',
    formato: 'V',
    variacoes: [
      { id: 2001, nome: 'Camiseta Roadster Cor:Azul;Tamanho:M', codigo: 'RD-AZ-M', preco: 89.9, situacao: 'A', variacao: { nome: 'Cor:Azul;Tamanho:M', ordem: 1 } },
      { id: 2002, nome: 'Camiseta Roadster Cor:Preto;Tamanho:G', codigo: 'RD-PR-G', preco: 94.9, situacao: 'A', variacao: { nome: 'Cor:Preto;Tamanho:G', ordem: 2 } },
      { id: 2003, nome: 'Sem atributos', codigo: 'RD-X', situacao: 'I', variacao: { nome: '' } },
    ],
  });
  assert.equal(product.format, 'V');
  assert.equal(product.metadata.hasVariations, true);
  assert.equal(variants.length, 3, 'não inventa nem remove variações');
  assert.equal(variants[0].bling_id, '2001');
  assert.equal(variants[0].color, 'Azul');
  assert.equal(variants[0].size, 'M');
  assert.deepEqual(variants[0].attributes, { Cor: 'Azul', Tamanho: 'M' });
  assert.equal(variants[1].price, 94.9);
  assert.equal(variants[2].color, null);
  assert.equal(variants[2].size, null);
  assert.equal(variants[2].active, false);
});

Deno.test('mapper: variação isolada aponta para o pai', () => {
  const m = mapBlingProduct({ id: 2001, nome: 'Camiseta Cor:Azul;Tamanho:M', idProdutoPai: 2000, situacao: 'A' });
  assert.equal(m.isVariantOfParent, true);
  assert.equal(m.product.parent_bling_id, '2000');
});

Deno.test('mapper: parseVariationAttributes é tolerante', () => {
  assert.deepEqual(parseVariationAttributes('Tamanho:P'), { color: null, size: 'P', attributes: { Tamanho: 'P' } });
  assert.deepEqual(parseVariationAttributes('cor:Vermelho; Tam: 42'), { color: 'Vermelho', size: '42', attributes: { cor: 'Vermelho', Tam: '42' } });
  assert.deepEqual(parseVariationAttributes(null), { color: null, size: null, attributes: {} });
});

Deno.test('mapper: saldos de estoque com múltiplos depósitos', () => {
  const rows = mapBlingStockBalances([
    { produto: { id: 1001 }, saldoFisicoTotal: 10, saldoVirtualTotal: 8, depositos: [{ id: 1, saldoFisico: 6, saldoVirtual: 5 }, { id: 2, saldoFisico: 4, saldoVirtual: 3 }] },
    { produto: { id: 1002 }, saldoFisicoTotal: 0, saldoVirtualTotal: -2, depositos: [] },
    { semProduto: true },
  ]);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], { bling_product_id: '1001', deposit_id: '__total__', physical_stock: 10, virtual_stock: 8 });
  assert.deepEqual(rows[1], { bling_product_id: '1001', deposit_id: '1', physical_stock: 6, virtual_stock: 5 });
  assert.deepEqual(rows[3], { bling_product_id: '1002', deposit_id: '__total__', physical_stock: 0, virtual_stock: -2 });
});

Deno.test('estoque: regra central de disponível (virtual > físico; nunca negativo)', () => {
  assert.equal(computeAvailableStock(10, 8), 8);
  assert.equal(computeAvailableStock(10, null), 10);
  assert.equal(computeAvailableStock(null, null), 0);
  assert.equal(computeAvailableStock(3, -2), 0);
});

Deno.test('webhook estoque: extrai produto/depósito de formatos diferentes', () => {
  assert.deepEqual(extractStockFromWebhook({ produto: { id: 5 }, deposito: { id: 2 }, saldoFisico: 1, saldoVirtual: 0 }), { productId: '5', depositId: '2', physical: 1, virtual: 0 });
  assert.deepEqual(extractStockFromWebhook({ idProduto: 6 }), { productId: '6', depositId: null, physical: null, virtual: null });
  assert.equal(extractStockFromWebhook({}).productId, null);
});

Deno.test('mapper: categoria', () => {
  assert.deepEqual(mapBlingCategory({ id: 3, descricao: 'Moda Bebê', categoriaPai: { id: 1 } }), {
    bling_id: '3',
    name: 'Moda Bebê',
    slug: 'moda-bebe',
    parent_bling_id: '1',
  });
  assert.equal(mapBlingCategory({}), null);
});

Deno.test('storefront: serialização pública não vaza campos internos e calcula disponibilidade', () => {
  const product = {
    id: 'uuid-p', bling_id: '2000', sku: 'RD', name: 'Camiseta', slug: 'camiseta', price: '89.90',
    promotional_price: null, active: true, images: [{ url: 'https://img/a.jpg', alt: null, source: 'internal' }],
    metadata: { tags: ['novo'], internalCost: 12 }, updated_at: '2026-09-04T00:00:00Z',
  };
  const variants = [
    { id: 'uuid-v1', bling_id: '2001', name: 'Azul M', color: 'Azul', size: 'M', price: 89.9, active: true, attributes: { Cor: 'Azul' }, product_id: 'uuid-p' },
    { id: 'uuid-v2', bling_id: '2002', name: 'Preto G', color: 'Preto', size: 'G', price: 94.9, active: true, attributes: {}, product_id: 'uuid-p' },
  ];
  const byDeposits = [
    { bling_product_id: '2001', physical_stock: 2, virtual_stock: 1, available_stock: 1 },
    { bling_product_id: '2002', physical_stock: 0, virtual_stock: 0, available_stock: 0 },
  ];
  const pub = serializePublicProduct(product, variants, byDeposits, [], { name: 'Masculino', slug: 'masculino' });
  assert.equal(pub.price, 89.9);
  assert.equal(pub.stock, 1);
  assert.equal(pub.available, true);
  assert.equal(pub.variants[0].available, true);
  assert.equal(pub.variants[1].available, false);
  assert.deepEqual(pub.tags, ['novo']);
  assert.deepEqual(pub.category, { name: 'Masculino', slug: 'masculino' });
  assert.ok(!('metadata' in pub), 'metadata interna não é exposta');
  assert.ok(!JSON.stringify(pub).includes('internalCost'));

  const soldOut = serializePublicProduct({ ...product, bling_id: '3000' }, [], [{ bling_product_id: '3000', physical_stock: 0, virtual_stock: 0, available_stock: 0 }], [], null);
  assert.equal(soldOut.available, false);

  const unknownStock = serializePublicProduct({ ...product, bling_id: '4000' }, [], [], [], null);
  assert.equal(unknownStock.stock, null);
  assert.equal(unknownStock.available, true, 'sem informação de estoque → não bloqueia');

  const inactive = serializePublicProduct({ ...product, active: false }, [], [], [], null);
  assert.equal(inactive.available, false);
});
