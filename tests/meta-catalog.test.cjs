const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderMetaCatalog } = require('../supabase/functions/_shared/meta-catalog-feed.ts');

function product(overrides = {}) {
  return {
    id: '28f4ea02-5383-4f75-8cec-d7a13ce6f8a9',
    blingId: '12345',
    sku: 'AN-123',
    name: 'Vestido "Flor"',
    slug: 'vestido-flor',
    shortDescription: 'Vestido leve e confortável',
    description: 'Tecido floral',
    brand: 'Anarosa',
    price: 99.90,
    promotionalPrice: 79.90,
    images: [{ url: 'https://example.com/produto.jpg', alt: null }],
    videos: [],
    variants: [],
    stock: 3,
    available: true,
    category: null,
    collection: null,
    segment: null,
    tags: [],
    updatedAt: null,
    ...overrides,
  };
}

test('Meta CSV uses stable ids, product landing pages, BRL and escaped quotes', () => {
  const feed = renderMetaCatalog([product()]);
  assert.equal(feed.items, 1);
  assert.equal(feed.excludedProducts, 0);
  assert.match(feed.csv, /^id,title,description,availability,condition,price,link,image_link,brand,/);
  assert.match(feed.csv, /"anarosa-12345"/);
  assert.match(feed.csv, /"Vestido ""Flor"""/);
  assert.match(feed.csv, /"99.90 BRL"/);
  assert.match(feed.csv, /"79.90 BRL"/);
  assert.match(feed.csv, /"in stock"/);
  assert.match(feed.csv, /https:\/\/www\.lojaanarosa\.com\.br\/p\/vestido-flor\.html/);
});

test('Meta CSV excludes unbranded items, missing photos and unsafe images', () => {
  const feed = renderMetaCatalog([
    product({ id: 'a', blingId: '10', brand: '' }),
    product({ id: 'b', blingId: '11', images: [] }),
    product({ id: 'c', blingId: '12', images: [{url:'http://invalid.test/image.jpg'}] }),
  ]);
  assert.equal(feed.items, 0);
  assert.equal(feed.excludedProducts, 3);
});

test('Unknown stock is not offered in Meta catalog', () => {
  const feed = renderMetaCatalog([product({ stock: null, available: true, promotionalPrice: null })]);
  assert.match(feed.csv, /"out of stock"/);
  assert.doesNotMatch(feed.csv, /"79.90 BRL"/);
});

test('Variants have distinct IDs and shared parent group, with own sizes', () => {
  const feed = renderMetaCatalog([product({
    variants: [
      { id:'v1', blingId:'891', sku:'AN-P', name:'P', color:'Verde', size:'P', price:90, promotionalPrice:null, stock:2, available:true, attributes:{} },
      { id:'v2', blingId:'892', sku:'AN-G', name:'G', color:'Verde', size:'G', price:90, promotionalPrice:null, stock:0, available:false, attributes:{} },
    ],
  })]);
  assert.equal(feed.items, 2);
  assert.match(feed.csv, /"anarosa-891"/);
  assert.match(feed.csv, /"anarosa-892"/);
  assert.equal(feed.csv.split('"anarosa-12345"').length - 1, 2);
  assert.match(feed.csv, /"out of stock"/);
});
