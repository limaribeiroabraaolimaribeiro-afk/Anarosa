import assert from 'node:assert/strict';
import { computeExpiresAt, exchangeAuthorizationCode, parseTokenResponse, refreshAccessToken } from '../_shared/bling-auth.ts';
import { BlingClient } from '../_shared/bling-client.ts';
import { BlingAuthError, BlingRateLimitError, NotConnectedError, TokenRefreshError } from '../_shared/errors.ts';
import { isTokenExpiring, MemoryTokenStore, toPublicInfo } from '../_shared/token-store.ts';
import { jsonResponse, mockFetch, noSleep, silentLogger, TEST_BLING_CONFIG, tokenBody } from './helpers.ts';

const NOW = new Date('2026-09-04T12:00:00Z');

Deno.test('token: cálculo de expiração e "perto de expirar"', () => {
  const exp = computeExpiresAt(21600, NOW);
  assert.equal(exp.toISOString(), '2026-09-04T18:00:00.000Z');
  assert.equal(isTokenExpiring(exp, 120, NOW), false);
  assert.equal(isTokenExpiring(exp, 120, new Date('2026-09-04T17:58:30Z')), true, 'dentro da margem de 120s');
  assert.equal(isTokenExpiring(exp, 120, new Date('2026-09-04T19:00:00Z')), true, 'já expirado');
  assert.equal(isTokenExpiring(null, 120, NOW), true, 'sem data → tratar como expirado');
  assert.equal(isTokenExpiring('invalid-date', 120, NOW), true);
  assert.equal(computeExpiresAt(-5, NOW).getTime(), NOW.getTime());
});

Deno.test('token: parseTokenResponse aceita JWT grande e exige access_token', () => {
  const big = 'eyJ' + 'a'.repeat(3000);
  const t = parseTokenResponse(tokenBody({ access_token: big }), NOW);
  assert.equal(t.accessToken.length, 3003);
  assert.equal(t.expiresAt.toISOString(), '2026-09-04T18:00:00.000Z');
  assert.throws(() => parseTokenResponse({ token_type: 'Bearer' }), TokenRefreshError);
});

Deno.test('oauth: troca de code envia Basic Auth, form-urlencoded e enable-jwt: 1', async () => {
  const { fetchImpl, calls } = mockFetch([['/oauth/token', () => jsonResponse(tokenBody())]]);
  const tokens = await exchangeAuthorizationCode(TEST_BLING_CONFIG, 'auth-code-123', fetchImpl);

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.url, TEST_BLING_CONFIG.tokenUrl);
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(call.headers['enable-jwt'], '1');
  assert.equal(call.headers['authorization'], `Basic ${btoa('test-client-id:test-client-secret-not-real')}`);
  const body = new URLSearchParams(call.body ?? '');
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'auth-code-123');
  assert.ok(!body.has('client_secret'));
  assert.equal(tokens.refreshToken, 'refresh-token-test-value-0001');
});

Deno.test('oauth: refresh usa grant_type=refresh_token com enable-jwt: 1', async () => {
  const { fetchImpl, calls } = mockFetch([['/oauth/token', () => jsonResponse(tokenBody({ access_token: 'eyJnew.token.value', refresh_token: 'rt-2' }))]]);
  const tokens = await refreshAccessToken(TEST_BLING_CONFIG, 'rt-1', fetchImpl);
  const body = new URLSearchParams(calls[0].body ?? '');
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), 'rt-1');
  assert.equal(calls[0].headers['enable-jwt'], '1');
  assert.equal(tokens.accessToken, 'eyJnew.token.value');
  assert.equal(tokens.refreshToken, 'rt-2');
});

Deno.test('oauth: erro do Bling no token vira erro tipado sem vazar segredo', async () => {
  const { fetchImpl } = mockFetch([['/oauth/token', () => jsonResponse({ error: { type: 'invalid_grant', message: 'code expired' } }, 400)]]);
  await assert.rejects(() => exchangeAuthorizationCode(TEST_BLING_CONFIG, 'x', fetchImpl), (err: Error) => {
    assert.ok(!err.message.includes(TEST_BLING_CONFIG.clientSecret));
    return true;
  });
});

function connectedStore(overrides: Record<string, unknown> = {}) {
  return new MemoryTokenStore({
    accessToken: 'eyJold.access.token',
    refreshToken: 'rt-old',
    status: 'connected',
    expiresAt: new Date(NOW.getTime() + 6 * 3600 * 1000).toISOString(),
    ...overrides,
  });
}

Deno.test('client: token válido → chamada com Bearer + enable-jwt sem refresh', async () => {
  const store = connectedStore();
  const { fetchImpl, calls } = mockFetch([['/produtos', () => jsonResponse({ data: [{ id: 1 }] })]]);
  const client = new BlingClient({ config: TEST_BLING_CONFIG, tokenStore: store, logger: silentLogger().logger, fetchImpl, sleep: noSleep, now: () => NOW });

  const res = await client.getProducts({ page: 1 });
  assert.deepEqual(res.data, [{ id: 1 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['authorization'], 'Bearer eyJold.access.token');
  assert.equal(calls[0].headers['enable-jwt'], '1');
  assert.ok(calls[0].url.startsWith(`${TEST_BLING_CONFIG.apiBaseUrl}/produtos?`));
  assert.ok(calls[0].url.includes('pagina=1'));
});

Deno.test('client: token perto de expirar → refresh (mockado) antes da chamada', async () => {
  const store = connectedStore({ expiresAt: new Date(NOW.getTime() + 30 * 1000).toISOString() });
  const { fetchImpl, calls } = mockFetch([
    ['/oauth/token', () => jsonResponse(tokenBody({ access_token: 'eyJfresh.access.token', refresh_token: 'rt-new' }))],
    ['/produtos', () => jsonResponse({ data: [] })],
  ]);
  const client = new BlingClient({ config: TEST_BLING_CONFIG, tokenStore: store, logger: silentLogger().logger, fetchImpl, sleep: noSleep, now: () => NOW });

  await client.getProducts();
  assert.equal(calls[0].url, TEST_BLING_CONFIG.tokenUrl);
  assert.equal(calls[1].headers['authorization'], 'Bearer eyJfresh.access.token');
  const conn = await store.getConnection();
  assert.equal(conn?.refreshToken, 'rt-new', 'refresh_token rotacionado é persistido');
  assert.equal(conn?.refreshLockUntil, null, 'lock liberado');
  assert.equal(conn?.status, 'connected');
});

Deno.test('client: 401 → refresh → repete UMA vez → sucesso', async () => {
  const store = connectedStore();
  let productCalls = 0;
  const { fetchImpl, calls } = mockFetch([
    ['/oauth/token', () => jsonResponse(tokenBody({ access_token: 'eyJafter401.token' }))],
    ['/produtos/10', () => {
      productCalls++;
      return productCalls === 1 ? jsonResponse({ error: { type: 'unauthorized' } }, 401) : jsonResponse({ data: { id: 10 } });
    }],
  ]);
  const client = new BlingClient({ config: TEST_BLING_CONFIG, tokenStore: store, logger: silentLogger().logger, fetchImpl, sleep: noSleep, now: () => NOW });

  const res = await client.getProductById(10);
  assert.equal(res.data.id, 10);
  assert.equal(productCalls, 2);
  assert.equal(calls.filter((c) => c.url === TEST_BLING_CONFIG.tokenUrl).length, 1);
  assert.equal(calls[2].headers['authorization'], 'Bearer eyJafter401.token');
});

Deno.test('client: 401 persistente após refresh → BlingAuthError (sem loop)', async () => {
  const store = connectedStore();
  let productCalls = 0;
  const { fetchImpl } = mockFetch([
    ['/oauth/token', () => jsonResponse(tokenBody({ access_token: 'eyJx.y.z' }))],
    ['/produtos', () => { productCalls++; return jsonResponse({}, 401); }],
  ]);
  const client = new BlingClient({ config: TEST_BLING_CONFIG, tokenStore: store, logger: silentLogger().logger, fetchImpl, sleep: noSleep, now: () => NOW });
  await assert.rejects(() => client.getProducts(), BlingAuthError);
  assert.equal(productCalls, 2, 'exatamente uma repetição');
});

Deno.test('client: refresh falha → status refresh_failed e erro tipado', async () => {
  const store = connectedStore({ expiresAt: NOW.toISOString() });
  const { fetchImpl } = mockFetch([['/oauth/token', () => jsonResponse({ error: { type: 'invalid_grant' } }, 400)]]);
  const client = new BlingClient({ config: TEST_BLING_CONFIG, tokenStore: store, logger: silentLogger().logger, fetchImpl, sleep: noSleep, now: () => NOW });
  await assert.rejects(() => client.getProducts());
  const conn = await store.getConnection();
  assert.equal(conn?.status, 'refresh_failed');
  assert.equal(conn?.refreshLockUntil, null);
  assert.ok(!(conn?.lastError ?? '').includes('rt-old'), 'erro não contém o refresh_token');
});

Deno.test('client: concorrência — quem não obtém o lock aguarda e usa o token renovado', async () => {
  const store = connectedStore({ expiresAt: NOW.toISOString() });
  // simula outra função segurando o lock
  await store.tryAcquireRefreshLock('mem-1', 30);
  const { fetchImpl, calls } = mockFetch([
    ['/oauth/token', () => assert.fail('não deve renovar enquanto o lock está com outro worker')],
    ['/produtos', () => jsonResponse({ data: [] })],
  ]);
  let polls = 0;
  const sleep = async () => {
    polls++;
    if (polls === 2) {
      // o "outro worker" termina o refresh
      await store.completeRefresh('mem-1', parseTokenResponse(tokenBody({ access_token: 'eyJfrom.other.worker' }), NOW));
    }
  };
  const client = new BlingClient({ config: TEST_BLING_CONFIG, tokenStore: store, logger: silentLogger().logger, fetchImpl, sleep, now: () => NOW });
  await client.getProducts();
  assert.equal(calls[0].headers['authorization'], 'Bearer eyJfrom.other.worker');
});

Deno.test('client: lock ocupado sem renovação → TokenRefreshError após tentativas limitadas', async () => {
  const store = connectedStore({ expiresAt: NOW.toISOString() });
  await store.tryAcquireRefreshLock('mem-1', 30);
  const { fetchImpl } = mockFetch([]);
  const client = new BlingClient({ config: TEST_BLING_CONFIG, tokenStore: store, logger: silentLogger().logger, fetchImpl, sleep: noSleep, now: () => NOW });
  await assert.rejects(() => client.getProducts(), TokenRefreshError);
});

Deno.test('client: 429 em GET respeita Retry-After e repete uma vez', async () => {
  const store = connectedStore();
  let n = 0;
  const waits: number[] = [];
  const { fetchImpl } = mockFetch([['/produtos', () => {
    n++;
    return n === 1 ? jsonResponse({}, 429, { 'Retry-After': '2' }) : jsonResponse({ data: [] });
  }]]);
  const client = new BlingClient({ config: TEST_BLING_CONFIG, tokenStore: store, logger: silentLogger().logger, fetchImpl, sleep: (ms) => { waits.push(ms); return Promise.resolve(); }, now: () => NOW });
  await client.getProducts();
  assert.equal(n, 2);
  assert.deepEqual(waits, [2000]);
});

Deno.test('client: 429 em POST NÃO repete (nunca duplicar pedido)', async () => {
  const store = connectedStore();
  let n = 0;
  const { fetchImpl } = mockFetch([['/pedidos/vendas', () => { n++; return jsonResponse({}, 429, { 'Retry-After': '1' }); }]]);
  const client = new BlingClient({ config: TEST_BLING_CONFIG, tokenStore: store, logger: silentLogger().logger, fetchImpl, sleep: noSleep, now: () => NOW });
  await assert.rejects(() => client.createOrder({ itens: [] }), BlingRateLimitError);
  assert.equal(n, 1);
});

Deno.test('client: 5xx em POST não repete', async () => {
  const store = connectedStore();
  let n = 0;
  const { fetchImpl } = mockFetch([['/pedidos/vendas', () => { n++; return jsonResponse({ error: { type: 'server' } }, 500); }]]);
  const client = new BlingClient({ config: TEST_BLING_CONFIG, tokenStore: store, logger: silentLogger().logger, fetchImpl, sleep: noSleep, now: () => NOW });
  await assert.rejects(() => client.createOrder({}));
  assert.equal(n, 1);
});

Deno.test('client: sem conexão → NotConnectedError sem chamar a rede', async () => {
  const store = new MemoryTokenStore();
  const { fetchImpl, calls } = mockFetch([]);
  const client = new BlingClient({ config: TEST_BLING_CONFIG, tokenStore: store, logger: silentLogger().logger, fetchImpl, sleep: noSleep });
  await assert.rejects(() => client.getProducts(), NotConnectedError);
  assert.equal(calls.length, 0);
});

Deno.test('client: paginação percorre páginas até a última', async () => {
  const store = connectedStore();
  const cfg = { ...TEST_BLING_CONFIG, productsPageSize: 2 };
  const pages: Record<string, unknown[]> = { '1': [{ id: 1 }, { id: 2 }], '2': [{ id: 3 }, { id: 4 }], '3': [{ id: 5 }] };
  const { fetchImpl, calls } = mockFetch([['/produtos', (call) => {
    const page = new URL(call.url).searchParams.get('pagina') ?? '1';
    return jsonResponse({ data: pages[page] ?? [] });
  }]]);
  const client = new BlingClient({ config: cfg, tokenStore: store, logger: silentLogger().logger, fetchImpl, sleep: noSleep, now: () => NOW });
  const all = await client.listAllProducts();
  assert.equal(all.length, 5);
  assert.equal(calls.length, 3);
});

Deno.test('status público nunca inclui tokens', async () => {
  const store = connectedStore();
  const info = toPublicInfo(await store.getConnection());
  const text = JSON.stringify(info);
  assert.equal(info.connected, true);
  assert.ok(!text.includes('eyJold'));
  assert.ok(!text.includes('rt-old'));
});
