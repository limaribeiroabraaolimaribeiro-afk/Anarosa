/**
 * GET /admin-deposits  (painel /gestao/ — sessão Supabase Auth)
 *
 * Lista depósitos REAIS e ATIVOS da conta Bling — GET /depositos
 * (developer.bling.com.br/referencia#/Dep%C3%B3sitos/get_depositos).
 * Usado para popular o seletor de depósito da tela "Ajustar estoque" —
 * nunca assumimos um depósito default.
 *
 * Mapeamento em _shared/deposit-mapper.ts (função pura, testada em
 * _tests/deposit-mapper.test.ts) — ver ali o porquê de comparar
 * situacao com o INTEIRO 1, nunca com a string 'A'.
 */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { serve } from '../_shared/context.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { mapBlingDeposits } from '../_shared/deposit-mapper.ts';

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);
  await requireAdminUser(req, ctx.db);

  const deposits = await ctx.client().getDeposits();
  const items = mapBlingDeposits(deposits);

  return json(req, { ok: true, items }, 200);
});
