import assert from 'node:assert/strict';
import {buildProductEditorPayload, productRevision} from '../_shared/product-editor.ts';
import {runAdminMutation} from '../_shared/admin-mutation.ts';
import {BlingApiError} from '../_shared/errors.ts';
import type {AppContext} from '../_shared/context.ts';
import {validateStockAdjustmentInput} from '../_shared/product-admin-mapper.ts';
const basic = { nome: 'Bermuda', sku: 'BERM', preco: 100, ativo: true };
Deno.test('stock balance permits zero without accepting zero entry or exit', () => {
  const value = {blingProductId:'1', depositoId:'1', quantidade:0};
  assert.equal(validateStockAdjustmentInput({...value,operacao:'balanco'}).quantidade,0);
  for (const operacao of ['entrada','saida']) assert.throws(() => validateStockAdjustmentInput({...value,operacao}));
});
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
    assert.equal(calls.at(-1), `gestao_finish_operation:${state}`);
  }
});

Deno.test('editor: valida GTIN, unidade e preserva fotos internas em edições', () => {
  const valid = buildProductEditorPayload({ ...basic, gtin: '7891234567895', unidade: 'UN' });
  assert.equal(valid.unidade, 'UN');
  assert.equal(valid.gtin, '7891234567895');
  assert.throws(() => buildProductEditorPayload({ ...basic, gtin: '00456100100575E' }), /GTIN/);
  assert.throws(() => buildProductEditorPayload({ ...basic, gtin: '00031643' }), /GTIN/);
  const current = { midia: { imagens: { internas: [{ link: 'https://example.test/antiga.jpg' }] } } };
  assert.throws(
    () => buildProductEditorPayload({ ...basic, images: ['https://example.test/nova.jpg'] }, current, true),
    /imagens internas/
  );
});

Deno.test('editor: separa tags, coleção, segmento e promoção da loja do payload nativo Bling', () => {
  const { validateMerchandising } = awaitImportEditor();
});
