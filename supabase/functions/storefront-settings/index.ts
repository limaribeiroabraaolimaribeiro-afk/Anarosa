import { serve } from '../_shared/context.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);
  const { data, error } = await ctx.db.from('store_settings').select('value,revision').eq('id', true)
    .single();
  if (error) throw new Error('settings_unavailable');
  return json(req, { ok: true, settings: data.value, revision: data.revision });
});
