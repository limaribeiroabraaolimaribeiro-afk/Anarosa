import assert from 'node:assert/strict';
import { validateCheckout, validateSettings, validDocument } from '../_shared/commerce-input.ts';
import { buildProductEditorPayload, productRevision } from '../_shared/product-editor.ts';
import { mapMarketplaceOrder } from '../_shared/marketplace-order.ts';
import { runAdminMutation } from '../_shared/admin-mutation.ts';
import { BlingApiError } from '../_shared/errors.ts';
import type { AppContext } from '../_shared/context.ts';

const checkout = () => ({
  idempotencyKey: 'a'.repeat(32),
  customer: { name: 'Teste', phone: '47999990000' },
  shipping: { method: 'pickup' },
  payment: { method: 'pix' },
  items: [{ slug: 'teste', quantity: 1 }],
});
Deno.test('checkout: rejects invalid document, phone, address and fractional quantity', async () => {
  const b = checkout();
  for (
    const raw of [
      { ...b, customer: { ...b.customer, document: '11111111111' } },
      { ...b, customer: { name: 'Teste', phone: '123' } },
      { ...b, shipping: { method: 'delivery', address: { zip: '123' } } },
      { ...b, items: [{ slug: 'teste', quantity: 1.5 }] },
    ]
  ) await assert.rejects(validateCheckout(raw));
  assert.equal(validDocument('11111111111'), false);
  assert.equal(validDocument('52998224725'), true);
});
Deno.test('checkout: fingerprint ignores client price but changes when quantity changes', async () => {
  const a = await validateCheckout(checkout());
  const b = await validateCheckout({
    ...checkout(),
    total: 0,
    items: [{ slug: 'teste', quantity: 1, unitPrice: 0 }],
  });
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(
    a.fingerprint,
    (await validateCheckout({ ...checkout(), items: [{ slug: 'teste', quantity: 2 }] })).fingerprint,
  );
});
Deno.test('settings: rejects exclusive Pix discount unsupported by provider', () => {
  assert.throws(() =>
    validateSettings({
      name: 'Anarosa',
      whatsapp: '5547999990000',
      instagram: '',
      deliveryMethods: ['pickup'],
      paymentMethods: ['pix'],
      deliveryPricing: 'quote',
      deliveryPrice: 0,
      pixDiscountPercent: 5,
    })
  );
});
const basic = { nome: 'Bermuda', sku: 'BERM', preco: 100, ativo: true };
Deno.test('product editor: creates P to XG without stock payload; rejects duplicate SKU', () => {
  const variants = ['P', 'M', 'G', 'GG', 'XG'].map((size) => ({
    nome: `Tamanho:${size}`,
    sku: `BERM-${size}`,
    preco: 100,
    ativo: true,
  }));
  const result = buildProductEditorPayload({ ...basic, variacoes: variants });
  assert.equal(result.formato, 'V');
  assert.equal(result.variacoes.length, 5);
  assert.equal(result.estoque, undefined);
  assert.equal(result.variacoes[0].estoque, undefined);
  assert.throws(() => buildProductEditorPayload({ ...basic, variacoes: [variants[0], variants[0]] }), /SKU/);
});
Deno.test('product editor: preserves fiscal fields and IDs, rejects deletion and conversion', () => {
  const current = {
    nome: 'Bermuda',
    codigo: 'BERM',
    preco: 100,
    formato: 'V',
    tributacao: { cest: '', ncm: '12345678', percentualTotalTributos: 10 },
    variacoes: [{ id: 12, nome: 'Tamanho:M' }],
  };
  const result = buildProductEditorPayload({
    ...basic,
    tributacao: { ncm: '87654321' },
    variacoes: [{ id: '12', nome: 'Tamanho:M', sku: 'BERM-M', preco: 120, ativo: false }],
  }, current);
  assert.equal(result.tributacao.percentualTotalTributos, 10);
  assert.equal(result.variacoes[0].id, 12);
  assert.equal(result.variacoes[0].situacao, 'I');
  assert.throws(() => buildProductEditorPayload({ ...basic, variacoes: [] }, current), /remova/);
  assert.throws(
    () =>
      buildProductEditorPayload({ ...basic, variacoes: [{ nome: 'Tamanho:M', sku: 'M', preco: 1 }] }, {
        formato: 'S',
      }),
    /Converter/,
  );
});
Deno.test('product editor: image writes require capability and use official imagensURL field', async () => {
  assert.throws(
    () => buildProductEditorPayload({ ...basic, images: ['https://example.invalid/a.png'] }),
    /Permissão/,
  );
  const payload = buildProductEditorPayload(
    { ...basic, images: ['https://example.invalid/a.png'] },
    null,
    true,
  );
  assert.deepEqual(payload.midia.imagens, { imagensURL: [{ link: 'https://example.invalid/a.png' }] });
  assert.notEqual(
    await productRevision({ nome: 'A', preco: 1 }),
    await productRevision({ nome: 'A', preco: 2 }),
  );
});
Deno.test('marketplace: configured channel only; no inferred payment proof', () => {
  const raw = {
    id: 1,
    numeroLoja: 'ML-123',
    loja: { id: 9 },
    situacao: { id: 6 },
    contato: { nome: 'Teste' },
    total: 20,
    totalProdutos: 20,
    itens: [{ produto: { id: 101 }, descricao: 'Bermuda', quantidade: 2, valor: 10 }],
  };
  assert.equal(mapMarketplaceOrder(raw).origin, 'bling_import');
  const order = mapMarketplaceOrder(raw, { '9': 'mercado_livre' });
  assert.equal(order.origin, 'mercado_livre');
  assert.equal(order.items[0].total, 20);
  assert.equal('paymentStatus' in order, false);
  assert.throws(() => mapMarketplaceOrder({ ...raw, itens: [{ quantidade: -1, valor: 10 }] }));
});
function mutationContext(state = 'claimed') {
  const calls: string[] = [];
  const chain = {
    update: () => chain,
    eq: () => chain,
    then: (resolve: CallableFunction) => resolve({ error: null }),
  };
  const ctx = {
    db: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push(`${name}:${args.p_status || ''}`);
        return { data: { state, result: { ok: true } }, error: null };
      },
      from: () => chain,
    },
  } as unknown as AppContext;
  return { ctx, calls };
}
const operation = {
  key: '00000000-0000-4000-8000-000000000001',
  resource: 'stock:1:1',
  actor: '00000000-0000-4000-8000-000000000002',
  payload: { quantity: 1 },
};
Deno.test('administration: completed command replays result without remote write', async () => {
  const { ctx } = mutationContext('completed');
  assert.deepEqual(
    await runAdminMutation(ctx, operation, async () => {
      throw Error('must not execute');
    }),
    { ok: true },
  );
});
Deno.test('administration: lost remote response enters review, explicit rejection is retryable', async () => {
  for (
    const [error, state] of [
      [new Error('offline'), 'review'],
      [new BlingApiError(422, 'Rejected'), 'failed'],
      [new BlingApiError(408, 'Timeout'), 'review'],
    ] as const
  ) {
    const { ctx, calls } = mutationContext();
    await assert.rejects(runAdminMutation(ctx, operation, async (submitted) => {
      await submitted();
      throw error;
    }));
    assert.equal(calls.at(-1), `finish_admin_operation:${state}`);
  }
});
