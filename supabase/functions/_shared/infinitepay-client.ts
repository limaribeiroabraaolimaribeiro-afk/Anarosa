/**
 * InfinitePayClient — único ponto de acesso à API do Checkout Integrado
 * InfinitePay (https://www.infinitepay.io/checkout-documentacao).
 *
 * Diferenças importantes em relação ao BlingClient:
 *   - não há OAuth: a "credencial" é o `handle` (Infinite Tag da conta,
 *     SEM o "$") indo no corpo de cada chamada — não é um bearer token;
 *   - a documentação oficial consultada em 2026-09-14 NÃO menciona
 *     assinatura/HMAC de webhook nem um endpoint de sandbox; por isso
 *     este client expõe `checkPayment` (POST /payment_check) como a
 *     ÚNICA fonte de verdade sobre pagamento — quem chama este módulo
 *     NUNCA deve marcar um pedido como pago só por ter recebido um
 *     webhook ou um redirect;
 *   - POST nunca é repetido automaticamente (evita criar dois links de
 *     cobrança ou reprocessar uma consulta de forma ambígua).
 */
import type { FetchLike } from './bling-auth.ts';
import type { InfinitePayConfig } from './config.ts';
import { InfinitePayApiError, InfinitePayTimeoutError } from './errors.ts';
import type { Logger } from './logger.ts';

export type { FetchLike };

export interface InfinitePayItem {
  quantity: number;
  /** Em CENTAVOS — ver checkout-documentacao ("R$ 10,00 = 1000"). */
  price: number;
  description: string;
}

export interface InfinitePayCustomer {
  name?: string;
  email?: string;
  phone_number?: string;
}

export interface InfinitePayAddress {
  cep?: string;
  street?: string;
  neighborhood?: string;
  number?: string;
  complement?: string;
}

export interface CreateCheckoutLinkInput {
  orderNsu: string;
  items: InfinitePayItem[];
  redirectUrl: string;
  webhookUrl: string;
  customer?: InfinitePayCustomer;
  address?: InfinitePayAddress;
}

export interface CreateCheckoutLinkResult {
  url: string;
  raw: Record<string, unknown>;
}

export interface PaymentCheckInput {
  orderNsu: string;
  transactionNsu: string;
  slug: string;
}

export interface PaymentCheckResult {
  success: boolean;
  paid: boolean;
  amount: number | null;
  paidAmount: number | null;
  installments: number | null;
  captureMethod: string | null;
  raw: Record<string, unknown>;
}

export interface InfinitePayClientOptions {
  config: InfinitePayConfig;
  logger: Logger;
  fetchImpl?: FetchLike;
}

function toNumberOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class InfinitePayClient {
  private readonly cfg: InfinitePayConfig;
  private readonly log: Logger;
  private readonly fetchImpl: FetchLike;

  constructor(opts: InfinitePayClientOptions) {
    this.cfg = opts.config;
    this.log = opts.logger;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async post(path: string, body: Record<string, unknown>, operation: string): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.apiBaseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new InfinitePayTimeoutError(operation);
      }
      throw new InfinitePayApiError(0, `Falha de rede ao chamar InfinitePay (${operation}).`, operation);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // resposta não-JSON — trata como erro abaixo, sem vazar o corpo cru no log
    }

    if (!res.ok) {
      this.log.warn('infinitepay.http_error', `InfinitePay respondeu ${res.status} (${operation})`, {
        httpStatus: res.status,
        operation,
      });
      throw new InfinitePayApiError(res.status, `InfinitePay retornou HTTP ${res.status} em ${operation}.`, operation);
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      throw new InfinitePayApiError(res.status, `Resposta inesperada da InfinitePay em ${operation} (corpo não é um objeto JSON).`, operation);
    }
    return json as Record<string, unknown>;
  }

  /** POST /links — cria o link de pagamento. NUNCA repete automaticamente. */
  async createCheckoutLink(input: CreateCheckoutLinkInput): Promise<CreateCheckoutLinkResult> {
    const payload: Record<string, unknown> = {
      handle: this.cfg.handle,
      order_nsu: input.orderNsu,
      items: input.items,
      redirect_url: input.redirectUrl,
      webhook_url: input.webhookUrl,
    };
    if (input.customer) payload.customer = input.customer;
    if (input.address) payload.address = input.address;

    const json = await this.post('/links', payload, 'createCheckoutLink');
    const url = typeof json.url === 'string' ? json.url : '';
    if (!url) {
      throw new InfinitePayApiError(200, 'InfinitePay não retornou "url" ao criar o link de pagamento.', 'createCheckoutLink');
    }
    return { url, raw: json };
  }

  /**
   * POST /payment_check — ÚNICA fonte de verdade sobre pagamento.
   * Nunca lança para "ainda não pago" (success:true, paid:false é uma
   * resposta válida) — só lança em erro de transporte/HTTP/formato.
   */
  async checkPayment(input: PaymentCheckInput): Promise<PaymentCheckResult> {
    const json = await this.post('/payment_check', {
      handle: this.cfg.handle,
      order_nsu: input.orderNsu,
      transaction_nsu: input.transactionNsu,
      slug: input.slug,
    }, 'checkPayment');

    return {
      success: json.success === true,
      paid: json.paid === true,
      amount: toNumberOrNull(json.amount),
      paidAmount: toNumberOrNull(json.paid_amount),
      installments: toNumberOrNull(json.installments),
      captureMethod: typeof json.capture_method === 'string' ? json.capture_method : null,
      raw: json,
    };
  }
}
