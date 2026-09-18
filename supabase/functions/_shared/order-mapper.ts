/**
 * Pedidos: validação, totais, chave de idempotência e mapeamento
 * store_orders → payload de POST /pedidos/vendas (Bling API v3).
 *
 * Funções PURAS. Nenhuma escrita acontece aqui.
 * A criação real no Bling só ocorre em bling-create-order e SOMENTE
 * quando BLING_ORDER_SYNC_ENABLED=true.
 */
import { sha256Hex } from './crypto.ts';
import { ValidationError } from './errors.ts';

export interface OrderItemInput {
  blingProductId: string;
  variantBlingId?: string | null;
  sku?: string | null;
  name: string;
  quantity: number;
  unitPrice: number;
}

export interface OrderCustomerInput {
  name: string;
  email?: string | null;
  phone?: string | null;
  /** CPF/CNPJ somente dígitos. */
  document?: string | null;
}

export interface OrderShippingInput {
  method?: string | null;
  cost?: number | null;
  address?: {
    street?: string;
    number?: string;
    complement?: string;
    district?: string;
    city?: string;
    state?: string;
    zip?: string;
  } | null;
}

export interface OrderInput {
  idempotencyKey?: string | null;
  customer: OrderCustomerInput;
  items: OrderItemInput[];
  shipping?: OrderShippingInput | null;
  payment?: { method?: string | null; installments?: number | null } | null;
  discount?: number | null;
  notes?: string | null;
}

export interface NormalizedOrder {
  idempotencyKey: string;
  customer: OrderCustomerInput;
  items: Array<OrderItemInput & { total: number }>;
  shipping: OrderShippingInput;
  payment: { method: string | null; installments: number | null };
  discount: number;
  shippingCost: number;
  subtotal: number;
  total: number;
  notes: string | null;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function isPositiveNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

export function computeOrderTotals(
  items: Array<{ quantity: number; unitPrice: number }>,
  discount = 0,
  shippingCost = 0,
): { subtotal: number; discount: number; shipping: number; total: number } {
  const subtotal = round2(items.reduce((acc, i) => acc + i.quantity * i.unitPrice, 0));
  const d = round2(Math.max(discount ?? 0, 0));
  const s = round2(Math.max(shippingCost ?? 0, 0));
  return { subtotal, discount: d, shipping: s, total: round2(Math.max(subtotal - d + s, 0)) };
}

/** Chave determinística: mesmo conteúdo → mesma chave → mesmo pedido. */
export async function buildIdempotencyKey(input: OrderInput): Promise<string> {
  const provided = (input.idempotencyKey ?? '').trim();
  if (provided) {
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(provided)) {
      throw new ValidationError('idempotencyKey inválida (8–128 caracteres, [A-Za-z0-9_.:-]).');
    }
    return provided;
  }
  const canonical = JSON.stringify({
    c: [input.customer?.name ?? '', input.customer?.email ?? '', input.customer?.document ?? ''],
    i: (input.items ?? [])
      .map((it) => [it.blingProductId, it.variantBlingId ?? '', it.quantity, it.unitPrice])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    d: input.discount ?? 0,
    s: input.shipping?.cost ?? 0,
  });
  return `auto-${(await sha256Hex(canonical)).slice(0, 40)}`;
}

/** Valida e normaliza a entrada. Lança ValidationError com detalhes. */
export async function validateOrderInput(raw: unknown): Promise<NormalizedOrder> {
  const input = (raw ?? {}) as OrderInput;
  const errors: string[] = [];

  const customer = input.customer ?? ({} as OrderCustomerInput);
  if (!customer.name || String(customer.name).trim().length < 2) errors.push('customer.name obrigatório');
  if (customer.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer.email)) errors.push('customer.email inválido');
  const document = customer.document ? String(customer.document).replace(/\D/g, '') : null;
  if (document && document.length !== 11 && document.length !== 14) errors.push('customer.document deve ser CPF (11) ou CNPJ (14)');

  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (rawItems.length === 0) errors.push('items vazio');
  const items = rawItems.map((it, idx) => {
    if (!it || !it.blingProductId) errors.push(`items[${idx}].blingProductId obrigatório`);
    if (!it?.name) errors.push(`items[${idx}].name obrigatório`);
    if (!isPositiveNumber(it?.quantity)) errors.push(`items[${idx}].quantity deve ser > 0`);
    if (!(typeof it?.unitPrice === 'number' && Number.isFinite(it.unitPrice) && it.unitPrice >= 0)) {
      errors.push(`items[${idx}].unitPrice inválido`);
    }
    const quantity = Number(it?.quantity) || 0;
    const unitPrice = Number(it?.unitPrice) || 0;
    return {
      blingProductId: String(it?.blingProductId ?? ''),
      variantBlingId: it?.variantBlingId ?? null,
      sku: it?.sku ?? null,
      name: String(it?.name ?? ''),
      quantity,
      unitPrice,
      total: round2(quantity * unitPrice),
    };
  });

  if (errors.length) throw new ValidationError('Pedido inválido.', { errors });

  const shipping: OrderShippingInput = input.shipping ?? {};
  const totals = computeOrderTotals(items, input.discount ?? 0, shipping.cost ?? 0);

  return {
    idempotencyKey: await buildIdempotencyKey(input),
    customer: {
      name: String(customer.name).trim(),
      email: customer.email ?? null,
      phone: customer.phone ?? null,
      document,
    },
    items,
    shipping,
    payment: {
      method: input.payment?.method ?? null,
      installments: input.payment?.installments ?? null,
    },
    discount: totals.discount,
    shippingCost: totals.shipping,
    subtotal: totals.subtotal,
    total: totals.total,
    notes: input.notes ?? null,
  };
}

/**
 * Payload para POST /pedidos/vendas.
 * Campos baseados na API v3; será revisado contra a doc oficial quando
 * a criação de pedidos for ativada (BLING_ORDER_SYNC_ENABLED).
 */
export function mapOrderToBling(order: NormalizedOrder, opts: { orderNumber?: string | null; date?: Date } = {}) {
  const date = (opts.date ?? new Date()).toISOString().slice(0, 10);
  const doc = order.customer.document ?? '';
  const addr = order.shipping.address ?? null;

  return {
    ...(opts.orderNumber ? { numero: opts.orderNumber } : {}),
    data: date,
    contato: {
      nome: order.customer.name,
      tipoPessoa: doc.length === 14 ? 'J' : 'F',
      ...(doc ? { numeroDocumento: doc } : {}),
      ...(order.customer.email ? { email: order.customer.email } : {}),
      ...(order.customer.phone ? { telefone: order.customer.phone } : {}),
    },
    itens: order.items.map((it) => ({
      ...(it.sku ? { codigo: it.sku } : {}),
      descricao: it.name,
      quantidade: it.quantity,
      valor: it.unitPrice,
      produto: { id: Number(it.variantBlingId ?? it.blingProductId) },
    })),
    desconto: order.discount > 0 ? { valor: order.discount, unidade: 'REAL' } : undefined,
    transporte: {
      frete: order.shippingCost,
      ...(addr
        ? {
          etiqueta: {
            nome: order.customer.name,
            endereco: addr.street ?? '',
            numero: addr.number ?? '',
            complemento: addr.complement ?? '',
            bairro: addr.district ?? '',
            municipio: addr.city ?? '',
            uf: addr.state ?? '',
            cep: addr.zip ?? '',
          },
        }
        : {}),
    },
    ...(order.notes ? { observacoes: order.notes } : {}),
    observacoesInternas: `Loja Anarosa • idempotency:${order.idempotencyKey}`,
  };
}

/** Status do Bling (id da situação) → status interno. Extensível. */
export function mapBlingOrderStatus(raw: { situacao?: { id?: number | string; valor?: number | string } | null }): string {
  const id = raw?.situacao?.id != null ? String(raw.situacao.id) : null;
  // IDs padrão do Bling variam por conta; mantemos um mapa conservador
  // e deixamos o restante como "pending" para revisão manual.
  const MAP: Record<string, string> = {
    '6': 'draft', // Em aberto
    '9': 'confirmed', // Atendido
    '12': 'cancelled', // Cancelado
    '15': 'shipped', // Em andamento / enviado (varia por conta)
  };
  return (id && MAP[id]) || 'pending';
}
