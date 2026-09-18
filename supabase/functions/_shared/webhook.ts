/**
 * Webhooks do Bling: validação de assinatura, parse e registro idempotente.
 *
 * Assinatura: header X-Bling-Signature-256 = "sha256=<hex>" onde
 * <hex> = HMAC-SHA256(client_secret, RAW BODY). A comparação é em
 * tempo constante. O corpo precisa ser lido CRU (não re-serializar JSON).
 */
import { hmacSha256Hex, timingSafeEqual } from './crypto.ts';
import { SUPPORTED_WEBHOOK_EVENTS, type SupportedWebhookEvent } from './config.ts';

export interface ParsedWebhookEvent {
  eventId: string;
  event: string;
  companyId: string | null;
  date: string | null;
  version: string | null;
  // deno-lint-ignore no-explicit-any
  data: Record<string, any>;
  raw: Record<string, unknown>;
}

export function parseSignatureHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^\s*sha256=([a-fA-F0-9]{64})\s*$/.exec(header);
  return m ? m[1].toLowerCase() : null;
}

export async function computeWebhookSignature(secret: string, rawBody: string | Uint8Array): Promise<string> {
  return await hmacSha256Hex(secret, rawBody);
}

/** true somente se o header estiver bem formado e bater com o HMAC do corpo. */
export async function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
): Promise<boolean> {
  if (!secret) return false;
  const provided = parseSignatureHeader(signatureHeader);
  if (!provided) return false;
  const expected = await computeWebhookSignature(secret, rawBody);
  return timingSafeEqual(provided, expected);
}

export class WebhookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookParseError';
  }
}

export function parseWebhookEvent(rawBody: string): ParsedWebhookEvent {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new WebhookParseError('Corpo do webhook não é JSON válido.');
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new WebhookParseError('Corpo do webhook não é um objeto.');
  }
  const obj = json as Record<string, unknown>;
  const eventId = obj.eventId != null ? String(obj.eventId) : '';
  const event = typeof obj.event === 'string' ? obj.event : '';
  if (!eventId) throw new WebhookParseError('eventId ausente.');
  if (!event) throw new WebhookParseError('event ausente.');

  return {
    eventId,
    event,
    companyId: obj.companyId != null ? String(obj.companyId) : null,
    date: typeof obj.date === 'string' ? obj.date : null,
    version: obj.version != null ? String(obj.version) : null,
    data: (obj.data && typeof obj.data === 'object' ? obj.data : {}) as Record<string, unknown>,
    raw: obj,
  };
}

export function isSupportedEvent(event: string): event is SupportedWebhookEvent {
  return (SUPPORTED_WEBHOOK_EVENTS as readonly string[]).includes(event);
}

// ---------------------------------------------------------------------
// Registro idempotente
// ---------------------------------------------------------------------
export interface WebhookEventStore {
  /** true se o evento é novo; false se já existia (duplicado). */
  register(evt: ParsedWebhookEvent): Promise<boolean>;
  claim(eventId: string): Promise<boolean>;
  markProcessed(eventId: string): Promise<void>;
  markFailed(eventId: string, error: string, retryInSeconds: number): Promise<void>;
  markIgnored(eventId: string, reason: string): Promise<void>;
  listPending(limit: number): Promise<ParsedWebhookEvent[]>;
}

export class MemoryWebhookEventStore implements WebhookEventStore {
  readonly rows = new Map<string, { evt: ParsedWebhookEvent; status: string; error?: string; retries: number }>();

  register(evt: ParsedWebhookEvent): Promise<boolean> {
    if (this.rows.has(evt.eventId)) return Promise.resolve(false);
    this.rows.set(evt.eventId, { evt, status: 'pending', retries: 0 });
    return Promise.resolve(true);
  }
  claim(eventId: string): Promise<boolean> {
    const r = this.rows.get(eventId);
    if (!r || !['pending', 'failed'].includes(r.status)) return Promise.resolve(false);
    r.status = 'processing';
    return Promise.resolve(true);
  }
  markProcessed(eventId: string): Promise<void> {
    const r = this.rows.get(eventId);
    if (r) r.status = 'processed';
    return Promise.resolve();
  }
  markFailed(eventId: string, error: string): Promise<void> {
    const r = this.rows.get(eventId);
    if (r) {
      r.status = 'failed';
      r.error = error;
      r.retries++;
    }
    return Promise.resolve();
  }
  markIgnored(eventId: string, reason: string): Promise<void> {
    const r = this.rows.get(eventId);
    if (r) {
      r.status = 'ignored';
      r.error = reason;
    }
    return Promise.resolve();
  }
  listPending(limit: number): Promise<ParsedWebhookEvent[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((r) => r.status === 'pending' || r.status === 'failed').slice(0, limit).map((r) => r.evt),
    );
  }
}

export class SupabaseWebhookEventStore implements WebhookEventStore {
  // deno-lint-ignore no-explicit-any
  constructor(private readonly db: any) {}

  async register(evt: ParsedWebhookEvent): Promise<boolean> {
    const { data, error } = await this.db.rpc('bling_register_webhook_event', {
      p_event_id: evt.eventId,
      p_event_type: evt.event,
      p_company_id: evt.companyId,
      p_event_date: evt.date,
      p_payload: evt.raw,
    });
    if (error) throw new Error(`webhook_register_failed: ${error.message}`);
    return data === true;
  }

  async claim(eventId: string): Promise<boolean> {
    const { data, error } = await this.db.rpc('bling_claim_webhook_event', { p_event_id: eventId });
    if (error) throw new Error(`webhook_claim_failed: ${error.message}`);
    return data === true;
  }

  async markProcessed(eventId: string): Promise<void> {
    const { error } = await this.db
      .from('bling_webhook_events')
      .update({ status: 'processed', processed_at: new Date().toISOString(), error_message: null, next_retry_at: null })
      .eq('event_id', eventId);
    if (error) throw new Error(`webhook_mark_processed_failed: ${error.message}`);
  }

  async markFailed(eventId: string, errorMessage: string, retryInSeconds: number): Promise<void> {
    const { data: row } = await this.db
      .from('bling_webhook_events')
      .select('retry_count')
      .eq('event_id', eventId)
      .maybeSingle();
    const retries = (row?.retry_count ?? 0) + 1;
    const { error } = await this.db
      .from('bling_webhook_events')
      .update({
        status: 'failed',
        error_message: errorMessage.slice(0, 500),
        retry_count: retries,
        next_retry_at: new Date(Date.now() + retryInSeconds * 1000).toISOString(),
      })
      .eq('event_id', eventId);
    if (error) throw new Error(`webhook_mark_failed_failed: ${error.message}`);
  }

  async markIgnored(eventId: string, reason: string): Promise<void> {
    const { error } = await this.db
      .from('bling_webhook_events')
      .update({ status: 'ignored', processed_at: new Date().toISOString(), error_message: reason.slice(0, 500) })
      .eq('event_id', eventId);
    if (error) throw new Error(`webhook_mark_ignored_failed: ${error.message}`);
  }

  async listPending(limit: number): Promise<ParsedWebhookEvent[]> {
    const { data, error } = await this.db
      .from('bling_webhook_events')
      .select('event_id, event_type, company_id, event_date, payload, retry_count')
      .in('status', ['pending', 'failed'])
      .lt('retry_count', 10)
      .or(`next_retry_at.is.null,next_retry_at.lte.${new Date().toISOString()}`)
      .order('received_at', { ascending: true })
      .limit(limit);
    if (error) throw new Error(`webhook_list_pending_failed: ${error.message}`);
    // deno-lint-ignore no-explicit-any
    return (data ?? []).map((r: any) => ({
      eventId: r.event_id,
      event: r.event_type,
      companyId: r.company_id,
      date: r.event_date,
      version: r.payload?.version != null ? String(r.payload.version) : null,
      data: r.payload?.data ?? {},
      raw: r.payload ?? {},
    }));
  }
}

/** Backoff exponencial limitado (segundos) para reprocessamento. */
export function retryDelaySeconds(retryCount: number): number {
  return Math.min(60 * 2 ** Math.max(retryCount, 0), 6 * 60 * 60);
}
