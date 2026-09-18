/**
 * GET /integration-health
 * { ok, database, blingConfigured, blingConnected, orderSyncEnabled, timestamp }
 * Sem segredos.
 */
import { isBlingConfigured } from '../_shared/config.ts';
import { serve } from '../_shared/context.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { toPublicInfo } from '../_shared/token-store.ts';

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);

  let database = false;
  let blingConnected = false;
  try {
    const conn = await ctx.tokenStore.getConnection();
    database = true;
    blingConnected = toPublicInfo(conn).connected;
  } catch (err) {
    ctx.logger.error('health', 'banco indisponível', { error: err });
  }

  const ok = database;
  return json(req, {
    ok,
    database,
    blingConfigured: isBlingConfigured(ctx.blingConfig),
    blingConnected,
    orderSyncEnabled: ctx.blingConfig.orderSyncEnabled,
    timestamp: new Date().toISOString(),
  }, ok ? 200 : 503);
});
