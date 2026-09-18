/**
 * Conversão de um pedido (store_orders + store_order_items) para o
 * formato de itens do Checkout Integrado InfinitePay (POST /links).
 *
 * Regra oficial (checkout-documentacao, consultada em 2026-09-14):
 * preços SEMPRE em centavos (R$ 10,00 = 1000). Função PURA — nenhuma
 * escrita, nenhuma chamada de rede.
 *
 * `orderTotal` (em reais) é a fonte de verdade do valor a cobrar — já
 * calculado por order-mapper.ts:computeOrderTotals no momento do
 * checkout. Os itens individuais aqui servem só para o detalhamento
 * exibido na tela de pagamento da InfinitePay; a soma final é sempre
 * ajustada para bater exatamente com `orderTotal` (nunca deixamos 1-2
 * centavos de diferença por arredondamento, o que quebraria a
 * reconciliação em payment_check).
 */
import type { InfinitePayItem } from './infinitepay-client.ts';

export interface PaymentOrderItemInput {
  name: string;
  sku?: string | null;
  quantity: number;
  unitPrice: number;
}

export interface BuildCheckoutItemsInput {
  items: PaymentOrderItemInput[];
  shippingCost: number;
  discount: number;
  /** Total autoritativo do pedido (reais) — já validado no backend. */
  orderTotal: number;
}

export interface CheckoutItemsResult {
  items: InfinitePayItem[];
  totalCents: number;
}

export function toCents(reais: number): number {
  return Math.round((Number(reais) || 0) * 100 + Number.EPSILON);
}

function sanitizeDescription(name: string, sku?: string | null): string {
  const base = sku ? `${name} (${sku})` : name;
  return base.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 250) || 'Item';
}

/**
 * Monta os itens para a InfinitePay a partir de um pedido já validado.
 * Desconto é aplicado proporcionalmente ao preço de cada item (nunca
 * como item de preço negativo — a documentação oficial não confirma
 * suporte a valores negativos). O resíduo de arredondamento (sempre
 * >= 0, por construção) é somado ao último item para que a soma final
 * bata EXATAMENTE com `orderTotal`.
 */
export function buildCheckoutItems(input: BuildCheckoutItemsInput): CheckoutItemsResult {
  const rawItems = input.items ?? [];
  const subtotal = rawItems.reduce((s, it) => s + it.quantity * it.unitPrice, 0);
  const discount = Math.max(0, Math.min(input.discount ?? 0, subtotal));
  const discountRatio = subtotal > 0 ? discount / subtotal : 0;

  const lines: InfinitePayItem[] = rawItems.map((it) => {
    const effectiveUnit = it.unitPrice * (1 - discountRatio);
    const priceCents = Math.max(Math.floor(effectiveUnit * 100 + 1e-9), 0);
    return {
      quantity: Math.max(1, Math.round(it.quantity)),
      price: priceCents,
      description: sanitizeDescription(it.name, it.sku),
    };
  });

  const shippingCents = toCents(Math.max(input.shippingCost ?? 0, 0));
  if (shippingCents > 0) {
    lines.push({ quantity: 1, price: shippingCents, description: 'Frete' });
  }

  if (lines.length === 0) {
    return { items: [], totalCents: 0 };
  }

  const targetTotalCents = Math.max(toCents(input.orderTotal), 0);
  const sumBefore = lines.reduce((s, l) => s + l.quantity * l.price, 0);
  const drift = targetTotalCents - sumBefore; // >= 0 por construção (arredondamos sempre para baixo)

  if (drift > 0) {
    const idx = lines.length - 1;
    const last = lines[idx];
    if (last.quantity > 1) {
      lines[idx] = { ...last, quantity: last.quantity - 1 };
      lines.push({ quantity: 1, price: last.price + drift, description: last.description });
    } else {
      lines[idx] = { ...last, price: last.price + drift };
    }
  }

  const totalCents = lines.reduce((s, l) => s + l.quantity * l.price, 0);
  return { items: lines, totalCents };
}
