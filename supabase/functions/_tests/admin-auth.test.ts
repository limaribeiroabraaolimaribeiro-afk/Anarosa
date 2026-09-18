import assert from 'node:assert/strict';
import { ADMIN_SECRET_HEADER, assertAdminHeaderIfPresent, isAdminRequest, requireAdmin } from '../_shared/admin-auth.ts';
import { UnauthorizedError } from '../_shared/errors.ts';
import { getBlingConfig, isBlingConfigured } from '../_shared/config.ts';

const SECRET = 'a-very-long-admin-secret-value-123';

function req(secret?: string) {
  return new Request('https://x.test/fn', { headers: secret ? { [ADMIN_SECRET_HEADER]: secret } : {} });
}

Deno.test('admin: sem secret configurado → falha fechada', () => {
  Deno.env.delete('INTEGRATION_ADMIN_SECRET');
  assert.equal(isAdminRequest(req(SECRET), ''), false);
  assert.throws(() => requireAdmin(req(SECRET)), UnauthorizedError);
});

Deno.test('admin: secret curto é rejeitado', () => {
  assert.equal(isAdminRequest(req('short'), 'short'), false);
});

Deno.test('admin: secret correto aceito; incorreto/ausente rejeitado', () => {
  Deno.env.set('INTEGRATION_ADMIN_SECRET', SECRET);
  try {
    assert.doesNotThrow(() => requireAdmin(req(SECRET)));
    assert.throws(() => requireAdmin(req('wrong-secret-value-1234567890')), UnauthorizedError);
    assert.throws(() => requireAdmin(req()), UnauthorizedError);
  } finally {
    Deno.env.delete('INTEGRATION_ADMIN_SECRET');
  }
});

Deno.test('admin: assertAdminHeaderIfPresent não interfere em requisição pública (sem header)', () => {
  Deno.env.delete('INTEGRATION_ADMIN_SECRET');
  assert.doesNotThrow(() => assertAdminHeaderIfPresent(req()));
  Deno.env.set('INTEGRATION_ADMIN_SECRET', SECRET);
  try {
    assert.doesNotThrow(() => assertAdminHeaderIfPresent(req()));
  } finally {
    Deno.env.delete('INTEGRATION_ADMIN_SECRET');
  }
});

Deno.test('admin: assertAdminHeaderIfPresent falha (401) quando o header é enviado e é inválido', () => {
  Deno.env.set('INTEGRATION_ADMIN_SECRET', SECRET);
  try {
    assert.throws(() => assertAdminHeaderIfPresent(req('wrong-secret-value-1234567890')), UnauthorizedError);
    assert.doesNotThrow(() => assertAdminHeaderIfPresent(req(SECRET)));
  } finally {
    Deno.env.delete('INTEGRATION_ADMIN_SECRET');
  }
});

Deno.test('admin: assertAdminHeaderIfPresent falha se o header for enviado mas não houver secret configurado', () => {
  Deno.env.delete('INTEGRATION_ADMIN_SECRET');
  assert.throws(() => assertAdminHeaderIfPresent(req(SECRET)), UnauthorizedError);
});

Deno.test('config: URLs padrão do Bling centralizadas e flag de pedidos desligada por padrão', () => {
  Deno.env.delete('BLING_ORDER_SYNC_ENABLED');
  Deno.env.delete('BLING_CLIENT_ID');
  const cfg = getBlingConfig();
  assert.equal(cfg.apiBaseUrl, 'https://api.bling.com.br/Api/v3');
  assert.equal(cfg.authUrl, 'https://www.bling.com.br/Api/v3/oauth/authorize');
  assert.equal(cfg.tokenUrl, 'https://api.bling.com.br/Api/v3/oauth/token');
  assert.equal(cfg.orderSyncEnabled, false);
  assert.equal(isBlingConfigured(cfg), false);
});

Deno.test('config: BLING_ORDER_SYNC_ENABLED só liga com valor explícito', () => {
  Deno.env.set('BLING_ORDER_SYNC_ENABLED', 'false');
  assert.equal(getBlingConfig().orderSyncEnabled, false);
  Deno.env.set('BLING_ORDER_SYNC_ENABLED', 'true');
  assert.equal(getBlingConfig().orderSyncEnabled, true);
  Deno.env.delete('BLING_ORDER_SYNC_ENABLED');
});
