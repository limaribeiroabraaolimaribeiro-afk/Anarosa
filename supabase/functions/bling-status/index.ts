/**
 * GET /bling-status
 * Informações NÃO sensíveis da integração. Nunca retorna tokens/segredos.
 * Erros recentes só são incluídos quando o header admin é válido.
 *
 * Sem o header administrativo: resposta pública normal (comportamento
 * inalterado). Com o header presente porém INVÁLIDO: 401 — uma tentativa
 * de autenticação com segredo errado nunca é rebaixada silenciosamente
 * para a visão pública (evita usar este endpoint para "tatear" segredos
 * sem nunca receber um sinal de falha).
 */
import { assertAdminHeaderIfPresent, isAdminRequest } from '../_shared/admin-auth.ts';
import { isBlingConfigured } from '../_shared/config.ts';
import { serve } from '../_shared/context.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { toPublicInfo } from '../_shared/token-store.ts';

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);
  assertAdminHeaderIfPresent(req);

  const [conn, products, lastWebhookAt, webhooks] = await Promise.all([
    ctx.tokenStore.getConnection(),
    ctx.repo.countProducts(),
    ctx.repo.lastWebhookAt(),
    ctx.repo.webhookStats(),
  ]);
  const info = toPublicInfo(conn);
  const admin = isAdminRequest(req);

  return json(req, {
    ok: true,
    connected: info.connected,
    status: info.status,
    companyId: info.companyId,
    expiresAt: info.expiresAt,
    connectedAt: info.connectedAt,
    lastRefreshAt: info.lastRefreshAt,
    lastSyncAt: info.lastSyncAt,
    lastWebhookAt,
    blingConfigured: isBlingConfigured(ctx.blingConfig),
    orderSyncEnabled: ctx.blingConfig.orderSyncEnabled,
    cachedProducts: products,
    webhooks,
    lastError: admin ? info.lastError : null,
    recentErrors: admin ? await ctx.repo.recentErrors(10) : undefined,
    adminAuthenticated: admin,
  });
});
