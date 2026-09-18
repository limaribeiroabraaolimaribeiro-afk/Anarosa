/**
 * Erros tipados da integração. Mensagens nunca incluem tokens/segredos.
 */

export class IntegrationError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    httpStatus = 500,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }

  toJSON() {
    return { error: this.code, message: this.message, ...(this.details ?? {}) };
  }
}

/** Configuração ausente (client_id, secret, redirect...). */
export class ConfigError extends IntegrationError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('config_error', message, 500, details);
  }
}

/** Integração ainda não autorizada (sem conexão Bling). */
export class NotConnectedError extends IntegrationError {
  constructor(message = 'Bling não conectado. Execute o fluxo "Conectar Bling".') {
    super('bling_not_connected', message, 409);
  }
}

/** Acesso administrativo negado. */
export class UnauthorizedError extends IntegrationError {
  constructor(message = 'Não autorizado.') {
    super('unauthorized', message, 401);
  }
}

/** Requisição inválida do chamador. */
export class ValidationError extends IntegrationError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('validation_error', message, 400, details);
  }
}

/** Recurso não encontrado. */
export class NotFoundError extends IntegrationError {
  constructor(message = 'Não encontrado.') {
    super('not_found', message, 404);
  }
}

/** Erro genérico da API Bling (4xx/5xx). */
export class BlingApiError extends IntegrationError {
  readonly status: number;
  readonly blingType?: string;
  readonly blingMessage?: string;

  constructor(
    status: number,
    message: string,
    extra: { blingType?: string; blingMessage?: string; operation?: string } = {},
  ) {
    super('bling_api_error', message, 502, {
      blingStatus: status,
      blingType: extra.blingType,
      operation: extra.operation,
    });
    this.status = status;
    this.blingType = extra.blingType;
    this.blingMessage = extra.blingMessage;
  }
}

/** 401 do Bling após tentativa de refresh. */
export class BlingAuthError extends BlingApiError {
  constructor(message = 'Token do Bling inválido ou expirado.', operation?: string) {
    super(401, message, { operation });
    // deno-lint-ignore no-explicit-any
    (this as any).code = 'bling_auth_error';
  }
}

/** 429 do Bling. */
export class BlingRateLimitError extends BlingApiError {
  readonly retryAfterSeconds?: number;

  constructor(retryAfterSeconds?: number, operation?: string) {
    super(429, 'Limite de requisições do Bling atingido.', { operation });
    // deno-lint-ignore no-explicit-any
    (this as any).code = 'bling_rate_limited';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Timeout de rede. */
export class BlingTimeoutError extends IntegrationError {
  constructor(operation?: string) {
    super('bling_timeout', 'Tempo limite ao chamar o Bling.', 504, { operation });
  }
}

/** Falha ao renovar token. */
export class TokenRefreshError extends IntegrationError {
  constructor(message = 'Falha ao renovar o token do Bling.', details?: Record<string, unknown>) {
    super('token_refresh_failed', message, 502, details);
  }
}

/**
 * Erro de consulta ao Postgres/PostgREST (via supabase-js). Preserva
 * code/details/hint originais do Postgres em `details` para diagnóstico
 * — nunca em texto livre solto, sempre em campos estruturados que o
 * logger sanitiza antes de gravar/expor. A mensagem NUNCA fica vazia:
 * quando o Postgrest não devolve `message` (ex.: erro em requisição
 * HEAD, que por definição do HTTP nunca carrega corpo — RFC 7231
 * §4.3.2), usamos um texto explícito em vez de deixar em branco.
 *
 * `code === 'database_error'` é tratado como 5xx "mascarável" em
 * responses.ts: o texto detalhado (que pode conter nomes de
 * tabela/coluna) só é logado no servidor, nunca devolvido ao chamador
 * de um endpoint público.
 */
export class DatabaseError extends IntegrationError {
  constructor(
    operation: string,
    pg: { message?: string | null; code?: string | null; details?: string | null; hint?: string | null } | null,
  ) {
    const pgMessage = pg?.message && pg.message.trim() !== '' ? pg.message.trim() : null;
    const message = pgMessage
      ? `${operation}: ${pgMessage}`
      : `${operation}: erro de banco sem mensagem (o Postgrest não retornou detalhes — ver pgCode/pgDetails/pgHint).`;
    super('database_error', message, 500, {
      operation,
      pgCode: pg?.code ?? null,
      pgDetails: pg?.details ?? null,
      pgHint: pg?.hint ?? null,
    });
  }
}

/** Erro genérico da API InfinitePay (Checkout Integrado). */
export class InfinitePayApiError extends IntegrationError {
  readonly status: number;

  constructor(status: number, message: string, operation?: string) {
    super('infinitepay_api_error', message, 502, { infinitePayStatus: status, operation });
    this.status = status;
  }
}

/** Timeout de rede ao chamar a InfinitePay. */
export class InfinitePayTimeoutError extends IntegrationError {
  constructor(operation?: string) {
    super('infinitepay_timeout', 'Tempo limite ao chamar a InfinitePay.', 504, { operation });
  }
}

export function isIntegrationError(err: unknown): err is IntegrationError {
  return err instanceof IntegrationError;
}

/** Converte qualquer erro em um objeto seguro para resposta/log. */
export function describeError(err: unknown): {
  code: string;
  message: string;
  httpStatus: number;
  details?: Record<string, unknown>;
} {
  if (isIntegrationError(err)) {
    return {
      code: err.code,
      message: err.message,
      httpStatus: err.httpStatus,
      details: err.details,
    };
  }
  if (err instanceof Error) {
    return { code: 'internal_error', message: err.message, httpStatus: 500 };
  }
  return { code: 'internal_error', message: String(err), httpStatus: 500 };
}
