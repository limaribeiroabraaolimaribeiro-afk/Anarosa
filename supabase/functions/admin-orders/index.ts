/**
 * GET /admin-orders                        → lista com filtros
 * GET /admin-orders?id=<uuid>               → detalhe (itens completos)
 * (painel /gestao/ — sessão Supabase Auth via requireAdminUser)
 *
 * Somente leitura. Não cria, edita nem cancela pedido — e não chama o
 * Bling em nenhum caminho deste arquivo.
 */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { serve } from '../_shared/context.ts';
import { NotFoundError, ValidationError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

const VALID_STATUS_FILTERS = new Set(['novos', 'processando', 'concluidos', 'cancelados']);

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);
  await requireAdminUser(req, ctx.db);

  const url = new URL(req.url);
  const id = url.searchParams.get('id');

  if (id) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ValidationError('id inválido.');
    const order = await ctx.adminRepo.getOrderDetail(id);
    if (!order) throw new NotFoundError('Pedido não encontrado.');
    return json(req, { ok: true, order });
  }

  const status = url.searchParams.get('status');
  for(const key of ['from','to']){const value=url.searchParams.get(key);if(value&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value))throw new ValidationError('Data inválida.');}
  const origin=url.searchParams.get('origin'),paymentStatus=url.searchParams.get('paymentStatus');
  if(origin&&!['site','mercado_livre','shopee','manual','other','bling_import'].includes(origin))throw new ValidationError('Origem inválida.');
  if(paymentStatus&&!['pending','paid','failed','cancelled','refunded'].includes(paymentStatus))throw new ValidationError('Pagamento inválido.');
  if (status && !VALID_STATUS_FILTERS.has(status)) {
    throw new ValidationError('status inválido.', { allowed: [...VALID_STATUS_FILTERS] });
  }

  const { items, total } = await ctx.adminRepo.listOrders({
    origin,
    paymentStatus,
    phone:url.searchParams.get('phone'),
    status,
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    search: url.searchParams.get('search'),
    limit: Number(url.searchParams.get('limit')) || undefined,
    offset: Number(url.searchParams.get('offset')) || undefined,
  });

  return json(req, { ok: true, items, total });
});
