import assert from 'node:assert/strict';
import { DatabaseError, ValidationError, describeError } from '../_shared/errors.ts';
import { errorResponse } from '../_shared/responses.ts';
import { sanitize } from '../_shared/logger.ts';
import { CatalogRepository } from '../_shared/catalog-repo.ts';

const SECRET_LIKE_HINT = 'client_secret=abc123 nunca deveria aparecer aqui';

Deno.test('DatabaseError: nunca produz mensagem vazia, mesmo sem message do Postgrest', () => {
  const withNothing = new DatabaseError('products_count_total_failed', null);
  assert.match(withNothing.message, /products_count_total_failed:/);
  assert.notEqual(withNothing.message.trim(), 'products_count_total_failed:');
  assert.match(withNothing.message, /erro de banco sem mensagem/i);

  const withEmptyString = new DatabaseError('op', { message: '' });
  assert.match(withEmptyString.message, /erro de banco sem mensagem/i);

  const withBlankSpaces = new DatabaseError('op', { message: '   ' });
  assert.match(withBlankSpaces.message, /erro de banco sem mensagem/i);
});

Deno.test('DatabaseError: preserva code/details/hint do Postgrest em .details', () => {
  const err = new DatabaseError('products_count_total_failed', {
    message: 'permission denied for table store_products',
    code: '42501',
    details: 'Failing row contains (...)',
    hint: SECRET_LIKE_HINT,
  });
  assert.equal(err.code, 'database_error');
  assert.equal(err.httpStatus, 500);
  assert.equal(err.details?.pgCode, '42501');
  assert.equal(err.details?.pgDetails, 'Failing row contains (...)');
  assert.equal(err.details?.pgHint, SECRET_LIKE_HINT);
  assert.equal(err.details?.operation, 'products_count_total_failed');
  assert.match(err.message, /permission denied for table store_products/);
});

Deno.test('describeError: database_error carrega os campos pg* para o log', () => {
  const err = new DatabaseError('webhook_stats_failed[pending]', {
    message: 'relation does not exist',
    code: '42P01',
  });
  const described = describeError(err);
  assert.equal(described.code, 'database_error');
  assert.equal(described.httpStatus, 500);
  assert.equal(described.details?.pgCode, '42P01');
});

Deno.test('errorResponse: database_error (5xx) é mascarado na resposta pública, mas o código aparece', async () => {
  const err = new DatabaseError('products_count_total_failed', {
    message: 'permission denied for table store_products',
    code: '42501',
    hint: SECRET_LIKE_HINT,
  });
  const req = new Request('https://x.test/bling-status');
  const res = errorResponse(req, err);
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error, 'database_error');
  assert.equal(body.message, 'Erro interno na integração.');
  assert.ok(!('details' in body), 'detalhes do Postgres não vão para a resposta pública');
  assert.ok(!JSON.stringify(body).includes('permission denied'));
  assert.ok(!JSON.stringify(body).includes(SECRET_LIKE_HINT));
});

Deno.test('errorResponse: erros 4xx (ex.: ValidationError) continuam com mensagem específica', async () => {
  const err = new ValidationError('slug inválido.', { errors: ['slug'] });
  const req = new Request('https://x.test/storefront-product');
  const res = errorResponse(req, err);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.message, 'slug inválido.');
  assert.deepEqual(body.details, { errors: ['slug'] });
});

Deno.test('logger: sanitize() de um erro tipado preserva code (como errorCode)/details/httpStatus sem vazar hint sensível fora do necessário', () => {
  const err = new DatabaseError('products_count_total_failed', {
    message: 'permission denied for table store_products',
    code: '42501',
    details: 'Key (id)=(1) already exists.',
    hint: SECRET_LIKE_HINT,
  });
  const out = sanitize(err) as Record<string, unknown>;
  assert.equal(out.name, 'DatabaseError');
  assert.match(out.message as string, /permission denied for table store_products/);
  assert.equal(out.errorCode, 'database_error', 'code vira errorCode para não colidir com a redação de authorization_code');
  assert.equal(out.code, undefined, 'chave "code" crua não deve sobreviver (colidiria com o padrão de redação)');
  assert.equal(out.httpStatus, 500);
  const details = out.details as Record<string, unknown>;
  assert.equal(details.pgCode, '42501');
  assert.equal(details.pgDetails, 'Key (id)=(1) already exists.');
  // O hint é preservado (não é um segredo por si só); o teste documenta que
  // o valor passa por sanitizeString() — não há mascaramento de texto livre
  // hoje além de padrões de token/JWT/Bearer/query-string.
  assert.equal(details.pgHint, SECRET_LIKE_HINT);
  assert.equal(out.stack, undefined, 'stack trace não é logado');
});

Deno.test('logger: sanitize() nunca esconde um code que não seja a chave literal "code"', () => {
  // Garante que o rename code->errorCode não afeta chaves parecidas (ex.: "pgCode").
  const out = sanitize({ pgCode: '42501', code: 'validation_error' }) as Record<string, unknown>;
  assert.equal(out.pgCode, '42501');
  assert.equal(out.code, '[REDACTED]', 'fora de um Error, a chave "code" (ex.: authorization code) continua redigida por padrão');
});

// ---------------------------------------------------------------------
// countProducts(): confirma que passou a usar count:'exact' + limit(1)
// (sem head:true) e que erros do lado "total" e "active" são
// identificados separadamente.
// ---------------------------------------------------------------------
function fakeCountBuilder(result: { count: number | null; error: unknown }) {
  // deno-lint-ignore no-explicit-any
  const builder: any = {
    select: (_cols: string, _opts?: unknown) => builder,
    eq: (_col: string, _val: unknown) => builder,
    limit: (_n: number) => Promise.resolve(result),
  };
  return builder;
}

Deno.test('countProducts: caminho de sucesso devolve total/active a partir de count', async () => {
  let call = 0;
  const results = [{ count: 12, error: null }, { count: 7, error: null }];
  // deno-lint-ignore no-explicit-any
  const db: any = { from: (_table: string) => fakeCountBuilder(results[call++]) };
  const repo = new CatalogRepository(db);
  const out = await repo.countProducts();
  assert.deepEqual(out, { total: 12, active: 7 });
});

Deno.test('countProducts: falha no total → products_count_total_failed com DatabaseError sem mensagem vazia', async () => {
  let call = 0;
  const results = [
    { count: null, error: { message: '', code: '42501' } }, // HEAD-like: message vazia
    { count: 7, error: null },
  ];
  // deno-lint-ignore no-explicit-any
  const db: any = { from: (_table: string) => fakeCountBuilder(results[call++]) };
  const repo = new CatalogRepository(db);
  await assert.rejects(() => repo.countProducts(), (err: DatabaseError) => {
    assert.ok(err instanceof DatabaseError);
    assert.match(err.message, /products_count_total_failed/);
    assert.doesNotMatch(err.message, /products_count_total_failed:\s*$/, 'mensagem não pode terminar vazia');
    assert.equal(err.details?.pgCode, '42501');
    return true;
  });
});

Deno.test('countProducts: falha no active (não no total) → products_count_active_failed', async () => {
  let call = 0;
  const results = [
    { count: 12, error: null },
    { count: null, error: { message: 'permission denied for table store_products', code: '42501' } },
  ];
  // deno-lint-ignore no-explicit-any
  const db: any = { from: (_table: string) => fakeCountBuilder(results[call++]) };
  const repo = new CatalogRepository(db);
  await assert.rejects(() => repo.countProducts(), (err: DatabaseError) => {
    assert.match(err.message, /products_count_active_failed/);
    assert.match(err.message, /permission denied for table store_products/);
    return true;
  });
});

Deno.test('webhookStats: erro identifica o status da iteração que falhou', async () => {
  let call = 0;
  const statuses = ['pending', 'processing', 'processed', 'failed', 'ignored'];
  const results = statuses.map((s) => (s === 'failed' ? { count: null, error: { message: '', code: '42501' } } : { count: 1, error: null }));
  // deno-lint-ignore no-explicit-any
  const db: any = { from: (_table: string) => fakeCountBuilder(results[call++]) };
  const repo = new CatalogRepository(db);
  await assert.rejects(() => repo.webhookStats(), (err: DatabaseError) => {
    assert.match(err.message, /webhook_stats_failed\[failed\]/);
    return true;
  });
});
