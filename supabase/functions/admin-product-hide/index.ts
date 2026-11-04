/** Remoção apenas local desabilitada: o usuário exige exclusão confirmada no Bling. */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { serve } from '../_shared/context.ts';
import { ValidationError } from '../_shared/errors.ts';
import { methodNotAllowed } from '../_shared/responses.ts';

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  await requireAdminUser(req, ctx.db);
  throw new ValidationError(
    'Remoção somente da ANAROSA está desativada. Exclua pelo botão Produtos, que exige confirmação de exclusão no Bling.',
    { reason: 'local_product_delete_disabled' },
  );
});
