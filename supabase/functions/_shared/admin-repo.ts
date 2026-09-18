/**
 * Dados administrativos do painel /gestao/ — pedidos, dashboard,
 * clientes. Sempre via service_role (mesmo padrão de catalog-repo.ts).
 * Nada aqui é lido pelo navegador diretamente: só pelas Edge Functions
 * admin-* após requireAdminUser().
 */
import { DatabaseError } from './errors.ts';

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

interface PostgrestErrorLike {
  message?: string | null;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
}

function fail(op: string, error: PostgrestErrorLike | null): never {
  throw new DatabaseError(op, error);
}

export interface DashboardSummary {
  newOrders: number;
  ordersToday: number;
  revenueToday: number;
  revenueMonth: number;
  activeProducts: number;
  lowStockProducts: number;
  outOfStockProducts: number;
  customers: number;
  lastWebhookAt: string | null;
  lastSyncAt: string | null;
  blingStatus: string;
  blingConnected: boolean;
  pendingPayments: number;
  paidToday: number;
  blingSyncFailed: number;
}

export interface AdminOrderListItem {
  id: string;
  orderNumber: string | null;
  createdAt: string;
  customerName: string | null;
  customerPhone: string | null;
  itemCount: number;
  total: number;
  shippingMethod: string | null;
  paymentMethod: string | null;
  status: string;
  origin: string;
  paymentStatus: string;
  paymentProvider: string | null;
  paymentCaptureMethod: string | null;
  blingSyncStatus: string;
}

export interface AdminOrderDetail extends AdminOrderListItem {
  customerEmail: string | null;
  customerDocument: string | null;
  shipping: Record<string, unknown>;
  payment: Record<string, unknown>;
  subtotal: number;
  discount: number;
  shippingCost: number;
  notes: string | null;
  items: Array<{ name: string; sku: string | null; quantity: number; unitPrice: number; total: number }>;
  externalOrderId: string | null;
  blingId: string | null;
  blingSyncError: string | null;
  blingSyncAttempts: number;
  paymentTransactionNsu: string | null;
  paymentInstallments: number | null;
  paymentPaidAt: string | null;
  paymentReceiptUrl: string | null;
  paymentFailureReason: string | null;
}

export interface ListOrdersOptions {
  status?: string | null;
  from?: string | null;
  to?: string | null;
  search?: string | null;
  limit?: number;
  offset?: number;
}

const STATUS_GROUPS: Record<string, string[]> = {
  novos: ['pending'],
  processando: ['confirmed', 'paid', 'shipped'],
  concluidos: ['delivered'],
  cancelados: ['cancelled'],
};

function toItem(row: Row): AdminOrderListItem {
  const customer = (row.customer_data ?? {}) as Row;
  const shipping = (row.shipping_data ?? {}) as Row;
  const payment = (row.payment_data ?? {}) as Row;
  return {
    id: row.id,
    orderNumber: row.order_number ?? null,
    createdAt: row.created_at,
    customerName: customer.name ?? null,
    customerPhone: customer.phone ?? null,
    itemCount: Array.isArray(row.store_order_items) ? row.store_order_items.length : (row.item_count ?? 0),
    total: Number(row.total ?? 0),
    shippingMethod: shipping.method ?? null,
    paymentMethod: payment.method ?? null,
    status: row.status,
    origin: row.origin ?? 'site',
    paymentStatus: row.payment_status ?? 'pending',
    paymentProvider: row.payment_provider ?? null,
    paymentCaptureMethod: row.payment_capture_method ?? null,
    blingSyncStatus: row.bling_sync_status,
  };
}

const ORDER_LIST_COLUMNS = [
  'id', 'order_number', 'created_at', 'customer_data', 'shipping_data', 'payment_data', 'total', 'status',
  'origin', 'payment_status', 'payment_provider', 'payment_capture_method', 'bling_sync_status',
  'store_order_items(count)',
].join(', ');

export class AdminRepository {
  constructor(private readonly db: Db) {}

  async getDashboardSummary(lowStockThreshold = 5): Promise<DashboardSummary> {
    const { data, error } = await this.db.rpc('admin_dashboard_summary', {
      p_low_stock_threshold: lowStockThreshold,
    });
    if (error) fail('admin_dashboard_summary_failed', error);
    const d = (data ?? {}) as Row;
    return {
      newOrders: Number(d.newOrders ?? 0),
      ordersToday: Number(d.ordersToday ?? 0),
      revenueToday: Number(d.revenueToday ?? 0),
      revenueMonth: Number(d.revenueMonth ?? 0),
      activeProducts: Number(d.activeProducts ?? 0),
      lowStockProducts: Number(d.lowStockProducts ?? 0),
      outOfStockProducts: Number(d.outOfStockProducts ?? 0),
      customers: Number(d.customers ?? 0),
      lastWebhookAt: d.lastWebhookAt ?? null,
      lastSyncAt: d.lastSyncAt ?? null,
      blingStatus: d.blingStatus ?? 'disconnected',
      blingConnected: d.blingConnected === true,
      pendingPayments: Number(d.pendingPayments ?? 0),
      paidToday: Number(d.paidToday ?? 0),
      blingSyncFailed: Number(d.blingSyncFailed ?? 0),
    };
  }

  async listOrders(opts: ListOrdersOptions = {}): Promise<{ items: AdminOrderListItem[]; total: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);

    let query = this.db
      .from('store_orders')
      .select(ORDER_LIST_COLUMNS, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (opts.status && STATUS_GROUPS[opts.status]) {
      query = query.in('status', STATUS_GROUPS[opts.status]);
    }
    if (opts.from) query = query.gte('created_at', opts.from);
    if (opts.to) query = query.lte('created_at', opts.to);
    if (opts.search) {
      const term = opts.search.replace(/[%_,]/g, ' ').trim().slice(0, 80);
      if (term) {
        query = query.or(`customer_data->>name.ilike.%${term}%,customer_data->>phone.ilike.%${term}%`);
      }
    }

    const { data, error, count } = await query;
    if (error) fail('admin_orders_list_failed', error);

    const items = (data ?? []).map((row: Row) => {
      const item = toItem(row);
      item.itemCount = Array.isArray(row.store_order_items) && row.store_order_items[0]
        ? Number(row.store_order_items[0].count ?? 0)
        : 0;
      return item;
    });
    return { items, total: count ?? items.length };
  }

  async getOrderDetail(id: string): Promise<AdminOrderDetail | null> {
    const { data: order, error } = await this.db
      .from('store_orders')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (error) fail('admin_order_detail_failed', error);
    if (!order) return null;

    const { data: items, error: itemsError } = await this.db
      .from('store_order_items')
      .select('name, sku, quantity, unit_price, total')
      .eq('order_id', id);
    if (itemsError) fail('admin_order_items_failed', itemsError);

    const base = toItem({ ...order, store_order_items: items ?? [] });
    base.itemCount = (items ?? []).length;
    const customer = (order.customer_data ?? {}) as Row;

    return {
      ...base,
      customerEmail: customer.email ?? null,
      customerDocument: customer.document ?? null,
      shipping: order.shipping_data ?? {},
      payment: order.payment_data ?? {},
      subtotal: Number(order.subtotal ?? 0),
      discount: Number(order.discount ?? 0),
      shippingCost: Number(order.shipping ?? 0),
      notes: (order.metadata ?? {}).notes ?? null,
      items: (items ?? []).map((it: Row) => ({
        name: it.name,
        sku: it.sku ?? null,
        quantity: Number(it.quantity),
        unitPrice: Number(it.unit_price),
        total: Number(it.total),
      })),
      externalOrderId: order.external_order_id ?? null,
      blingId: order.bling_id ?? null,
      blingSyncError: order.bling_sync_error ?? null,
      blingSyncAttempts: Number(order.bling_sync_attempts ?? 0),
      paymentTransactionNsu: order.payment_transaction_nsu ?? null,
      paymentInstallments: order.payment_installments != null ? Number(order.payment_installments) : null,
      paymentPaidAt: order.payment_paid_at ?? null,
      paymentReceiptUrl: order.payment_status === 'paid' ? (order.payment_receipt_url ?? null) : null,
      paymentFailureReason: order.payment_status === 'failed'
        ? ((order.payment_raw_status ?? {}).failure_reason ?? 'motivo não especificado')
        : null,
    };
  }

  async getCustomersSummary(opts: { search?: string | null; limit?: number; offset?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const { data, error } = await this.db.rpc('admin_customers_summary', {
      p_search: opts.search ?? null,
      p_limit: limit,
      p_offset: offset,
    });
    if (error) fail('admin_customers_summary_failed', error);
    return (data ?? []).map((row: Row) => ({
      phone: row.phone,
      name: row.name,
      email: row.email,
      orderCount: Number(row.order_count),
      totalSpent: Number(row.total_spent),
      lastOrderAt: row.last_order_at,
    }));
  }
}
