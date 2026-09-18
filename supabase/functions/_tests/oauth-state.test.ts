import assert from 'node:assert/strict';
import { createOAuthState, MemoryOAuthStateStore, validateOAuthState } from '../_shared/oauth-state.ts';
import { buildAuthorizeUrl } from '../_shared/bling-auth.ts';
import { sha256Hex } from '../_shared/crypto.ts';
import { TEST_BLING_CONFIG } from './helpers.ts';

Deno.test('oauth state: gera valor aleatório, salva apenas o hash e valida uma vez', async () => {
  const store = new MemoryOAuthStateStore();
  const { state, expiresAt } = await createOAuthState(store, 600, new Date('2026-01-01T00:00:00Z'));

  assert.match(state, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(expiresAt.toISOString(), '2026-01-01T00:10:00.000Z');
  assert.equal(store.rows.size, 1);
  assert.ok(!store.rows.has(state), 'o state em claro não pode estar no banco');
  assert.ok(store.rows.has(await sha256Hex(state)), 'somente o SHA-256 é armazenado');

  const ok = await validateOAuthState(store, state, new Date('2026-01-01T00:05:00Z'));
  assert.equal(ok, true);
});

Deno.test('oauth state: dois states gerados são diferentes', async () => {
  const store = new MemoryOAuthStateStore();
  const a = await createOAuthState(store, 600);
  const b = await createOAuthState(store, 600);
  assert.notEqual(a.state, b.state);
});

Deno.test('oauth state: expirado é rejeitado', async () => {
  const store = new MemoryOAuthStateStore();
  const { state } = await createOAuthState(store, 60, new Date('2026-01-01T00:00:00Z'));
  const ok = await validateOAuthState(store, state, new Date('2026-01-01T00:01:01Z'));
  assert.equal(ok, false);
});

Deno.test('oauth state: reutilização é rejeitada (uso único)', async () => {
  const store = new MemoryOAuthStateStore();
  const now = new Date('2026-01-01T00:00:00Z');
  const { state } = await createOAuthState(store, 600, now);
  assert.equal(await validateOAuthState(store, state, now), true);
  assert.equal(await validateOAuthState(store, state, now), false);
});

Deno.test('oauth state: desconhecido / malformado é rejeitado', async () => {
  const store = new MemoryOAuthStateStore();
  assert.equal(await validateOAuthState(store, 'abc'), false);
  assert.equal(await validateOAuthState(store, null), false);
  assert.equal(await validateOAuthState(store, 'A'.repeat(64)), false);
});

Deno.test('authorize url: contém response_type/client_id/state e nunca o secret', () => {
  const url = new URL(buildAuthorizeUrl(TEST_BLING_CONFIG, 'state-xyz'));
  assert.equal(url.origin + url.pathname, TEST_BLING_CONFIG.authUrl);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), TEST_BLING_CONFIG.clientId);
  assert.equal(url.searchParams.get('state'), 'state-xyz');
  assert.ok(!url.toString().includes(TEST_BLING_CONFIG.clientSecret));
});
