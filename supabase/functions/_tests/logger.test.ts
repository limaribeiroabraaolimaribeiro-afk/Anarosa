import assert from 'node:assert/strict';
import { createLogger, REDACTED, sanitize, sanitizeString, type LogEntry } from '../_shared/logger.ts';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';

Deno.test('logger: sanitiza chaves sensíveis em objetos aninhados', () => {
  const out = sanitize({
    operation: 'x',
    access_token: 'abc',
    refresh_token: 'def',
    client_secret: 'ghi',
    Authorization: 'Bearer zzz',
    code: 'auth-code',
    nested: { apiKey: '1', ok: 'fine', list: [{ token: 't' }, 'plain'] },
  }) as Record<string, unknown>;
  assert.equal(out.access_token, REDACTED);
  assert.equal(out.refresh_token, REDACTED);
  assert.equal(out.client_secret, REDACTED);
  assert.equal(out.Authorization, REDACTED);
  assert.equal(out.code, REDACTED);
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested.apiKey, REDACTED);
  assert.equal(nested.ok, 'fine');
  assert.deepEqual(nested.list, [{ token: REDACTED }, 'plain']);
});

Deno.test('logger: sanitiza JWT, Bearer/Basic e query strings dentro de strings', () => {
  assert.equal(sanitizeString(`token=${JWT} fim`), `token=${REDACTED} fim`);
  assert.equal(sanitizeString('Authorization: Bearer abcdefghijklmnop'), `Authorization: Bearer ${REDACTED}`);
  assert.equal(sanitizeString('Basic dGVzdDpzZWNyZXQ='), `Basic ${REDACTED}`);
  assert.equal(
    sanitizeString('https://x/cb?code=abc123&state=st-1&other=1'),
    `https://x/cb?code=${REDACTED}&state=${REDACTED}&other=1`,
  );
});

Deno.test('logger: sanitiza Headers', () => {
  const h = new Headers({ Authorization: 'Bearer x', 'content-type': 'application/json' });
  const out = sanitize(h) as Record<string, unknown>;
  assert.equal(out.authorization, REDACTED);
  assert.equal(out['content-type'], 'application/json');
});

Deno.test('logger: entradas gravadas no sink não contêm segredos e têm campos obrigatórios', async () => {
  const entries: LogEntry[] = [];
  const lines: string[] = [];
  const logger = createLogger({
    sink: (e) => { entries.push(e); },
    console: { log: (s: string) => lines.push(s), warn: (s: string) => lines.push(s), error: (s: string) => lines.push(s) },
  });

  logger.error('bling.request', `falhou com token ${JWT}`, {
    entityType: 'product',
    entityId: 42,
    httpStatus: 401,
    refresh_token: 'rt-secret',
    headers: { Authorization: 'Bearer abc' },
  });
  await logger.flush();

  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.level, 'error');
  assert.equal(e.operation, 'bling.request');
  assert.equal(e.entityType, 'product');
  assert.equal(e.entityId, '42');
  assert.equal(e.details.httpStatus, 401);
  assert.ok(e.timestamp);
  const serialized = JSON.stringify(e) + lines.join('\n');
  assert.ok(!serialized.includes(JWT));
  assert.ok(!serialized.includes('rt-secret'));
  assert.ok(!serialized.includes('Bearer abc'));
});

Deno.test('logger: debug não é persistido por padrão; falha no sink não propaga', async () => {
  const entries: LogEntry[] = [];
  const logger = createLogger({
    sink: (e) => { entries.push(e); throw new Error('db down'); },
    console: { log: () => {}, warn: () => {}, error: () => {} },
  });
  logger.debug('x', 'debug');
  logger.info('x', 'info');
  await logger.flush();
  assert.equal(entries.length, 1);
});
