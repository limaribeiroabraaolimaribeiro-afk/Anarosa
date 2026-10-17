import { serve } from '../_shared/context.ts';
import { requireAdmin } from '../_shared/admin-auth.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { processOrderJob, workerDeps } from '../_shared/bling-order-worker.ts';
serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  requireAdmin(req);
  const results = [];
  for (let i = 0; i < 5; i++) {
    const result = await processOrderJob(workerDeps(ctx));
    results.push(result);
    if (['empty', 'disabled'].includes(result)) break;
  }
  return json(req, { ok: true, results });
});
