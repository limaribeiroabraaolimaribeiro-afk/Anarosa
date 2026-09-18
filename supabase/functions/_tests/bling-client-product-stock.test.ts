import assert from 'node:assert/strict';
import { BlingClient } from '../_shared/bling-client.ts';
import { BlingApiError, BlingAuthError, BlingRateLimitError, BlingTimeoutError } from '../_shared/errors.ts';
import { MemoryTokenStore } from '../_shared/token-store.ts';
import { jsonResponse, mockFetch, noSleep, silentLogger, TEST_BLING_CONFIG, tokenBody } from './helpers-bling.ts';

const NOW = new Date('2026-09-18T12:00:00Z');

function connectedStore(overrides: Record<string, unknown> = {}) {
  return new MemoryTokenStore({
    accessToken: 'eyJold.access.token',
    refreshToken: 'rt-old',
    status: 'connected',
    expiresAt: new Date(NOW.getTime() + 6 * 3600 * 1000).toISOString(),
    ...overrides,
  });
}

function buildClient(routes: Parameters<typeof mockFetch>[0]) {
  const { fetchImpl, calls } = mockFetch(routes);
  const client = new BlingClient({
    config: TEST_BLING_CONFIG,
    tokenStore: connectedStore(),
    logger: silentLogger().logger,
    fetchImpl,
    sleep: noSleep,
    now: () => NOW,
  });
  return { client, calls };
}

// ---------------------------------------------------------------------
// createProduct — POST /produtos
// ---------------------------------------------------------------------
Deno.test('createProduct: POST /produtos com o payload exato, devolve o id criado', async () => {
  const { client, calls } = buildClient([['/produtos', (call) => call.method === 'POST' ? jsonResponse({ data: { id: 555 } }, 200) : jsonResponse({ data: [] })]]);
  const res = await client.createProduct({ nome: 'Produto Teste', preco: 10, tipo: 'P', situacao: 'A', formato: 'S' });
  assert.equal(res.data.id, 555);
  assert.equal(calls[0].method, 'POST');
  assert.ok(calls[0].url.endsWith('/produtos'));
  const body = JSON.parse(calls[0].body ?? '{}');
  assert.equal(body.nome, 'Produto Teste');
  assert.equal(body.formato, 'S');
});

Deno.test('createProduct: Bling 400 vira BlingApiError sanitizado', async () => {
  const { client } = buildClient([['/produtos', () => jsonResponse({ error: { type: 'validation', message: 'nome obrigatório' } }, 400)]]);
  await assert.rejects(
    () => client.createProduct({ nome: '', preco: 10, tipo: 'P', situacao: 'A', formato: 'S' }),
    (err: unknown) => err instanceof BlingApiError && err.status === 400,
  );
});

Deno.test('createProduct: 401 → renova token automaticamente → repete UMA vez → sucesso', async () => {
  let call401Count = 0;
  const { client, calls } = buildClient([
    ['/oauth/token', () => jsonResponse(tokenBody({ access_token: 'eyJnew.token', refresh_token: 'rt-new' }))],
    ['/produtos', (call) => {
      if (call.headers['authorization'] === 'Bearer eyJold.access.token') { call401Count++; return jsonResponse({ error: { type: 'unauthorized' } }, 401); }
      return jsonResponse({ data: { id: 1 } }, 200);
    }],
  ]);
  const res = await client.createProduct({ nome: 'X', preco: 1, tipo: 'P', situacao: 'A', formato: 'S' });
  assert.equal(res.data.id, 1);
  assert.equal(call401Count, 1);
  assert.equal(calls.filter((c) => c.url.includes('/produtos')).length, 2, 'uma tentativa original + uma repetição após refresh');
});

Deno.test('createProduct: 429 NUNCA repete automaticamente (evita criar produto duplicado)', async () => {
  let attempts = 0;
  const { client } = buildClient([['/produtos', () => { attempts++; return jsonResponse({}, 429, { 'Retry-After': '1' }); }]]);
  await assert.rejects(
    () => client.createProduct({ nome: 'X', preco: 1, tipo: 'P', situacao: 'A', formato: 'S' }),
    (err: unknown) => err instanceof BlingRateLimitError,
  );
  assert.equal(attempts, 1, 'POST nunca é repetido automaticamente em 429');
});

Deno.test('createProduct: 500 propaga BlingApiError, sem repetir', async () => {
  let attempts = 0;
  const { client } = buildClient([['/produtos', () => { attempts++; return jsonResponse({ error: { message: 'internal' } }, 500); }]]);
  await assert.rejects(() => client.createProduct({ nome: 'X', preco: 1, tipo: 'P', situacao: 'A', formato: 'S' }), BlingApiError);
  assert.equal(attempts, 1);
});

Deno.test('createProduct: timeout de rede → BlingTimeoutError', async () => {
  const fetchImpl = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })) as typeof fetch;
  const client = new BlingClient({
    config: { ...TEST_BLING_CONFIG, requestTimeoutMs: 20 },
    tokenStore: connectedStore(),
    logger: silentLogger().logger,
    fetchImpl,
    sleep: noSleep,
    now: () => NOW,
  });
  await assert.rejects(() => client.createProduct({ nome: 'X', preco: 1, tipo: 'P', situacao: 'A', formato: 'S' }), BlingTimeoutError);
});

// ---------------------------------------------------------------------
// updateProduct — PUT /produtos/{id}
// ---------------------------------------------------------------------
Deno.test('updateProduct: PUT /produtos/{id} com o payload correto', async () => {
  const { client, calls } = buildClient([[/\/produtos\/1001$/, () => jsonResponse({ data: { id: 1001 } })]]);
  await client.updateProduct('1001', { nome: 'Novo nome', preco: 20, tipo: 'P', situacao: 'A', formato: 'S' });
  assert.equal(calls[0].method, 'PUT');
  assert.ok(calls[0].url.endsWith('/produtos/1001'));
});

// ---------------------------------------------------------------------
// changeProductSituation — PATCH /produtos/{id}/situacoes
// ---------------------------------------------------------------------
// Status 204 é "null body status" no spec do Fetch — Response lança
// TypeError se receber um corpo não-vazio. jsonResponse() sempre
// serializa um corpo, então para simular 204 usamos Response direto.
const noContent = () => new Response(null, { status: 204 });

Deno.test('changeProductSituation: PATCH /produtos/{id}/situacoes com {situacao}', async () => {
  const { client, calls } = buildClient([[/\/produtos\/1001\/situacoes$/, noContent]]);
  await client.changeProductSituation('1001', 'I');
  assert.equal(calls[0].method, 'PATCH');
  assert.ok(calls[0].url.endsWith('/produtos/1001/situacoes'));
  assert.deepEqual(JSON.parse(calls[0].body ?? '{}'), { situacao: 'I' });
});

Deno.test('changeProductSituation: 401 → refresh → repete → sucesso', async () => {
  const { client, calls } = buildClient([
    ['/oauth/token', () => jsonResponse(tokenBody({ access_token: 'eyJnew.token', refresh_token: 'rt-new' }))],
    [/\/situacoes$/, (call) => call.headers['authorization'] === 'Bearer eyJold.access.token' ? jsonResponse({}, 401) : noContent()],
  ]);
  await client.changeProductSituation('1001', 'A');
  assert.equal(calls.filter((c) => c.url.includes('situacoes')).length, 2);
});

// ---------------------------------------------------------------------
// createStockEntry — POST /estoques
// ---------------------------------------------------------------------
Deno.test('createStockEntry: POST /estoques com produto/deposito/operacao/quantidade', async () => {
  const { client, calls } = buildClient([['/estoques', () => jsonResponse({ data: { id: 42 } }, 200)]]);
  const res = await client.createStockEntry({ produto: { id: 1001 }, deposito: { id: 1 }, operacao: 'E', quantidade: 5 });
  assert.equal(res.data.id, 42);
  const body = JSON.parse(calls[0].body ?? '{}');
  assert.deepEqual(body, { produto: { id: 1001 }, deposito: { id: 1 }, operacao: 'E', quantidade: 5 });
});

Deno.test('createStockEntry: 500 propaga erro tipado, sem repetir (nunca duplica lançamento de estoque)', async () => {
  let attempts = 0;
  const { client } = buildClient([['/estoques', () => { attempts++; return jsonResponse({}, 500); }]]);
  await assert.rejects(() => client.createStockEntry({ produto: { id: 1 }, deposito: { id: 1 }, operacao: 'B', quantidade: 10 }), BlingApiError);
  assert.equal(attempts, 1);
});

Deno.test('createStockEntry: 401 persistente após refresh → BlingAuthError (sem loop)', async () => {
  const { client } = buildClient([
    ['/oauth/token', () => jsonResponse(tokenBody({ access_token: 'eyJnew.token', refresh_token: 'rt-new' }))],
    ['/estoques', () => jsonResponse({}, 401)],
  ]);
  await assert.rejects(() => client.createStockEntry({ produto: { id: 1 }, deposito: { id: 1 }, operacao: 'E', quantidade: 1 }), BlingAuthError);
});

// ---------------------------------------------------------------------
// getDeposits — GET /depositos
// ---------------------------------------------------------------------
Deno.test('getDeposits: GET /depositos?pagina=1&limite=100&situacao=1 devolve a lista real (nunca inventa depósito)', async () => {
  // situacao de DEPÓSITO é inteiro (1=ativo/0=inativo) no contrato oficial —
  // diferente do situacao de produto ('A'/'I', string). Ver deposit-mapper.ts.
  const { client, calls } = buildClient([['/depositos', () => jsonResponse({ data: [{ id: 123, descricao: 'Geral', situacao: 1, padrao: true, desconsiderarSaldo: false }] })]]);
  const deposits = await client.getDeposits();
  assert.equal(calls[0].method, 'GET');
  assert.ok(calls[0].url.includes('pagina=1'));
  assert.ok(calls[0].url.includes('limite=100'));
  assert.ok(calls[0].url.includes('situacao=1'));
  assert.deepEqual(deposits, [{ id: 123, descricao: 'Geral', situacao: 1, padrao: true, desconsiderarSaldo: false }]);
});

Deno.test('getDeposits: resposta vazia → lista vazia (não lança)', async () => {
  const { client } = buildClient([['/depositos', () => jsonResponse({ data: [] })]]);
  assert.deepEqual(await client.getDeposits(), []);
});

Deno.test('getDeposits: resposta malformada (data ausente/não-array) → lista vazia, não lança', async () => {
  const { client } = buildClient([['/depositos', () => jsonResponse({ foo: 'bar' })]]);
  assert.deepEqual(await client.getDeposits(), []);
});

Deno.test('getDeposits: 401 → renova token → repete UMA vez → sucesso', async () => {
  let unauthorizedCount = 0;
  const { client, calls } = buildClient([
    ['/oauth/token', () => jsonResponse(tokenBody({ access_token: 'eyJnew.token', refresh_token: 'rt-new' }))],
    ['/depositos', (call) => {
      if (call.headers['authorization'] === 'Bearer eyJold.access.token') { unauthorizedCount++; return jsonResponse({}, 401); }
      return jsonResponse({ data: [{ id: 123, descricao: 'Geral', situacao: 1, padrao: true, desconsiderarSaldo: false }] });
    }],
  ]);
  const deposits = await client.getDeposits();
  assert.equal(deposits.length, 1);
  assert.equal(unauthorizedCount, 1);
  assert.equal(calls.filter((c) => c.url.includes('/depositos')).length, 2);
});

Deno.test('getDeposits: 403 (app sem escopo) vira BlingApiError sanitizado', async () => {
  const { client } = buildClient([['/depositos', () => jsonResponse({ error: { type: 'forbidden', message: 'sem permissão' } }, 403)]]);
  await assert.rejects(
    () => client.getDeposits(),
    (err: unknown) => err instanceof BlingApiError && err.status === 403,
  );
});

Deno.test('getDeposits: 429 respeita Retry-After e repete (GET é idempotente)', async () => {
  let attempts = 0;
  const { client } = buildClient([
    ['/depositos', () => {
      attempts++;
      if (attempts === 1) return jsonResponse({}, 429, { 'Retry-After': '0' });
      return jsonResponse({ data: [{ id: 123, descricao: 'Geral', situacao: 1, padrao: true, desconsiderarSaldo: false }] });
    }],
  ]);
  const deposits = await client.getDeposits();
  assert.equal(deposits.length, 1);
  assert.equal(attempts, 2, 'GET pode repetir uma vez após 429 (nunca duplica efeito — é leitura)');
});
