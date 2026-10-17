import { serve } from '../_shared/context.ts';
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { validateSettings } from '../_shared/commerce-input.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
serve(async (req, ctx) => {
  if (!['GET', 'POST'].includes(req.method)) return methodNotAllowed(req, ['GET', 'POST']);
  const admin = await requireAdminUser(req, ctx.db);
  if (req.method === 'GET') {
    const { data, error } = await ctx.db.from('store_settings').select('value,revision').eq('id', true)
      .single();
    if (error) throw new Error('settings_unavailable');
    return json(req, { ok: true, settings: data.value, revision: data.revision });
  }
  const body = await req.json();
  const value = validateSettings(body.settings);
  const { data, error } = await ctx.db.rpc('settings_save', {
    p_value: value,
    p_revision: body.revision,
    p_actor: admin.id,
  });
  if (error?.message === 'settings_conflict') {
    return json(req, {
      ok: false,
      message: 'As configurações mudaram em outra sessão. Recarregue antes de salvar.',
    }, 409);
  }
  if (error) throw new Error('settings_save_failed');
  return json(req, { ok: true, ...data });
});
