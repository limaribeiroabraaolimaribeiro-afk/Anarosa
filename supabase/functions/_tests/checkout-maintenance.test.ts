import assert from 'node:assert/strict';
import { checkoutMaintenance } from '../_shared/checkout-maintenance.ts';
Deno.test('publication: pause returns retryable 503 without initializing an order or payment', async () => {
  const old = Deno.env.get('COMMERCE_CHECKOUT_PAUSED');
  try {
    Deno.env.set('COMMERCE_CHECKOUT_PAUSED', 'true');
    const response = checkoutMaintenance(new Request('https://test.invalid'));
    assert.equal(response?.status, 503);
    assert.equal(response.headers.get('Retry-After'), '300');
    assert.equal((await response.json()).error, 'checkout_maintenance');
  } finally {
    if (old === undefined) Deno.env.delete('COMMERCE_CHECKOUT_PAUSED');
    else Deno.env.set('COMMERCE_CHECKOUT_PAUSED', old);
  }
});
Deno.test('publication: absent pause preserves the existing enabled behavior', () => {
  const old = Deno.env.get('COMMERCE_CHECKOUT_PAUSED');
  try {
    Deno.env.delete('COMMERCE_CHECKOUT_PAUSED');
    assert.equal(checkoutMaintenance(new Request('https://test.invalid')), null);
  } finally {
    if (old !== undefined) Deno.env.set('COMMERCE_CHECKOUT_PAUSED', old);
  }
});
