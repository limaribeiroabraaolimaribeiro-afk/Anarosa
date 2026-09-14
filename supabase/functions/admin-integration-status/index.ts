/**
 * GET /admin-integration-status  (painel /gestao/ — sessão Supabase Auth)
 *
 * Versão amigável/não-técnica do status da integração para a tela
 * "Integração" do painel da cliente. Reaproveita os MESMOS dados de
 * bling-status, mas com autenticação de usuário (não o
 * INTEGRATION_ADMIN_SECRET) e sem nenhum campo técnico (sem stack
 * trace, sem código de erro do Postgres, sem token).
 */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { isBlingConfigured } from '../_shared/config.ts';
import { serve } from '../_shared/context.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { toPublicInfo } from '../_shared/token-store.ts';

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);
  await requireAdminUser(req, ctx.db);

  const [conn, products, lastWebhookAt, webhooks] = await Promise.all([
    ctx.tokenStore.getConnection(),
    ctx.repo.countProducts(),
    ctx.repo.lastWebhookAt(),
    ctx.repo.webhookStats(),
  ]);
  const info = toPublicInfo(conn);

  return json(req, {
    ok: true,
    connected: info.connected,
    lastSyncAt: info.lastSyncAt,
    lastWebhookAt,
    failedWebhookEvents: webhooks.failed ?? 0,
    cachedProducts: products.total,
    activeProducts: products.active,
    blingConfigured: isBlingConfigured(ctx.blingConfig),
    orderSyncEnabled: ctx.blingConfig.orderSyncEnabled,
  });
});
