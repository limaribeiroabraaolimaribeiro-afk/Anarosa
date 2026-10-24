import assert from 'node:assert/strict';
import { canWriteProductImages } from '../_shared/product-image-permission.ts';
import { MemoryTokenStore } from '../_shared/token-store.ts';

Deno.test('libera fotos apenas após nova autorização OAuth do Bling', async () => {
  const store = new MemoryTokenStore({ status: 'connected', scope: '98309 98310 106168710 199272829' });
  assert.equal(await canWriteProductImages(store), true);
  store.conn!.scope = '98309 98310 106168710';
  assert.equal(await canWriteProductImages(store), false);
  store.conn!.scope = '98309 98310 106168710 199272829';
  store.conn!.status = 'revoked';
  assert.equal(await canWriteProductImages(store), false);
  store.conn = null;
  assert.equal(await canWriteProductImages(store), false);
});
