import assert from 'node:assert/strict';
import { displayCatalogImage, isBlingInternalImage, imageSourcePath } from '../_shared/catalog-image-url.ts';

const signed = {
  source: 'internal',
  url: 'https://orgbling.s3.amazonaws.com/folder/photoA?AWSAccessKeyId=EXAMPLE&Expires=1&Signature=expired',
};
const permanent = 'https://example.supabase.co/storage/v1/object/public/anarosa-product-images/bling-permanent/123/photoA.jpg';
const base = 'https://example.supabase.co';

Deno.test('somente fotos internas Bling usam proxy, sem expor assinatura expirada', () => {
  assert.equal(isBlingInternalImage(signed), true);
  assert.equal(imageSourcePath(signed.url), '/folder/photoA');
  assert.equal(displayCatalogImage(signed, '123', 0, {}, base),
    'https://example.supabase.co/functions/v1/storefront-image?blingId=123&slot=0');
  assert.equal(displayCatalogImage({ url: 'https://example.com/photo.jpg', source: 'external' }, '123', 0, {}, base),
    'https://example.com/photo.jpg');
});

Deno.test('mídia já migrada usa URL permanente e ignora assinatura alterada', () => {
  assert.equal(displayCatalogImage(signed, '123', 0, {
    imageCache: { '0': { sourcePath: '/folder/photoA', publicUrl: permanent } },
  }, base), permanent);
  assert.notEqual(displayCatalogImage(signed, '123', 0, {
    imageCache: { '0': { sourcePath: '/folder/outra', publicUrl: permanent } },
  }, base), permanent);
});

Deno.test('URL maliciosa e mídia não registrada não recebem tratamento privilegiado', () => {
  assert.equal(isBlingInternalImage({ url: 'https://orgbling.s3.amazonaws.com.evil.com/photo', source: 'internal' }), false);
  assert.equal(displayCatalogImage(null, '123', 0, {}, base), null);
  assert.equal(displayCatalogImage({ url: 'https://test.invalid/foto.jpg', source: 'internal' }, '123', 0, {}, base), 'https://test.invalid/foto.jpg');
});
