import { ValidationError } from './errors.ts';

// No guesses based on a product name. Channel IDs come from the operator's
// actual Bling account; unmapped channels are explicitly shown as Bling.
export function mapMarketplaceOrder(
  raw: Record<string, any>,
  channels: Record<string, string> = {},
  statuses: Record<string, string> = {},
) {
  if (!raw.id) throw new ValidationError('Pedido Bling sem identificador.');
  const origin = channels[String(raw.loja?.id)] || 'bling_import';
  const configuredStatus = statuses[String(raw.situacao?.id)];
  if (
    configuredStatus &&
    !['draft', 'pending', 'confirmed', 'shipped', 'delivered', 'cancelled'].includes(configuredStatus)
  ) throw new ValidationError('Mapa de situações Bling inválido.');
  const items = (raw.itens ?? []).map((i: Record<string, any>) => ({
    blingProductId: i.produto?.id != null ? String(i.produto.id) : null,
    sku: i.codigo ?? null,
    name: String(i.descricao ?? 'Item'),
    quantity: Number(i.quantidade),
    unitPrice: Number(i.valor),
    total: Math.round(Number(i.quantidade) * Number(i.valor) * 100) / 100,
  }));
  if (
    items.some((i: { quantity: number; unitPrice: number }) =>
      !Number.isFinite(i.quantity) || i.quantity <= 0 || !Number.isFinite(i.unitPrice) || i.unitPrice < 0
    )
  ) throw new ValidationError('Itens inválidos no pedido Bling.');
  return {
    blingId: String(raw.id),
    reference: raw.numeroLoja ? String(raw.numeroLoja) : null,
    origin: ['mercado_livre', 'shopee', 'manual', 'other'].includes(origin) ? origin : 'bling_import',
    status: configuredStatus || (String(raw.situacao?.id) === '12' ? 'cancelled' : 'pending'),
    customer: { name: raw.contato?.nome ?? null, document: raw.contato?.numeroDocumento ?? null },
    shipping: {
      method: 'external',
      tracking:
        raw.transporte?.volumes?.map((v: Record<string, unknown>) => v.codigoRastreamento).filter(Boolean) ??
          [],
      externalStatus: raw.situacao ?? null,
    },
    subtotal: Number(raw.totalProdutos) || 0,
    total: Number(raw.total) || 0,
    items,
  };
}
