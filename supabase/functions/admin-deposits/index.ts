/**
 * GET /admin-deposits  (painel /gestao/ — sessão Supabase Auth)
 *
 * Lista depósitos REAIS e ATIVOS da conta Bling — GET /depositos
 * (developer.bling.com.br/referencia#/Dep%C3%B3sitos/get_depositos).
 * Usado para popular o seletor de depósito da tela "Definir estoque
 * atual" — nunca assumimos um depósito default arbitrário.
 *
 * Mapeamento em _shared/deposit-mapper.ts (função pura, testada em
 * _tests/deposit-mapper.test.ts) — ver ali o porquê de comparar
 * situacao com o INTEIRO 1, nunca com a string 'A'.
 *
 * `defaultDepositId` (FASE A / A2): quando há exatamente 1 depósito
 * ativo, ou um deles tem padrao=true, a Gestão pré-seleciona sozinha —
 * a cliente não precisa escolher "Geral" toda vez. Com vários
 * depósitos e nenhum marcado como padrão, fica null (o front pede
 * escolha manual — nunca adivinhamos entre iguais).
 */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { serve } from '../_shared/context.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { mapBlingDeposits, pickDefaultDepositId } from '../_shared/deposit-mapper.ts';

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);
  await requireAdminUser(req, ctx.db);

  const deposits = await ctx.client().getDeposits();
  const items = mapBlingDeposits(deposits);
  const defaultDepositId = pickDefaultDepositId(items);

  return json(req, { ok: true, items, defaultDepositId }, 200);
});
