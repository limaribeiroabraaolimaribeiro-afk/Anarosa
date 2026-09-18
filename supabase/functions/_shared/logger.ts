/**
 * Logger com sanitização.
 *
 * Nunca registra: Authorization, access_token, refresh_token,
 * client_secret, authorization code, Basic Auth, chaves service role.
 * Escreve no console (logs do Supabase) e, opcionalmente, em
 * integration_logs através de um "sink" injetado (evita acoplar o
 * logger ao cliente Supabase — facilita testes).
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  operation: string;
  message: string;
  integration: string;
  entityType?: string;
  entityId?: string;
  details: Record<string, unknown>;
  timestamp: string;
}

export type LogSink = (entry: LogEntry) => Promise<void> | void;

const SENSITIVE_KEY_PATTERN =
  /(authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|api[_-]?key|service[_-]?role|^code$|auth(orization)?[_-]?code|cookie|set-cookie|token)/i;

const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const BEARER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const QUERY_SECRET_PATTERN =
  /([?&](code|state|access_token|refresh_token|client_secret|token)=)[^&#\s]+/gi;

export const REDACTED = '[REDACTED]';

/** Remove segredos de uma string (JWTs, Bearer/Basic, query strings). */
export function sanitizeString(value: string): string {
  return value
    .replace(JWT_PATTERN, REDACTED)
    .replace(BEARER_PATTERN, `$1 ${REDACTED}`)
    .replace(QUERY_SECRET_PATTERN, `$1${REDACTED}`);
}

/** Sanitiza recursivamente objetos/arrays (chaves sensíveis viram [REDACTED]). */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (value == null) return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value !== 'object') return value;
  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: sanitizeString(value.message) };
    // Propriedades adicionais (ex.: IntegrationError.code/details/httpStatus,
    // ou DatabaseError.details.{pgCode,pgDetails,pgHint}) — sempre
    // sanitizadas recursivamente, nunca cruas.
    for (const key of Object.keys(value)) {
      if (key === 'name' || key === 'message' || key === 'stack') continue;
      // "code" colide com o padrão de redação de authorization_code (regra
      // ^code$ abaixo). O `code` de um IntegrationError é uma classificação
      // interna (ex.: "database_error"), não um segredo — expõe como
      // errorCode para não ser mascarado à toa.
      const outKey = key === 'code' ? 'errorCode' : key;
      out[outKey] = sanitize((value as unknown as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, depth + 1));
  if (value instanceof Headers) {
    const out: Record<string, unknown> = {};
    value.forEach((v, k) => {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) ? REDACTED : sanitizeString(v);
    });
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_PATTERN.test(k) ? REDACTED : sanitize(v, depth + 1);
  }
  return out;
}

export interface LoggerOptions {
  integration?: string;
  sink?: LogSink;
  /** Nível mínimo persistido no sink (console recebe tudo). */
  persistMinLevel?: LogLevel;
  console?: Pick<Console, 'log' | 'warn' | 'error'>;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export class Logger {
  private readonly integration: string;
  private readonly sink?: LogSink;
  private readonly persistMinLevel: LogLevel;
  private readonly con: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly pending: Promise<void>[] = [];

  constructor(opts: LoggerOptions = {}) {
    this.integration = opts.integration ?? 'bling';
    this.sink = opts.sink;
    this.persistMinLevel = opts.persistMinLevel ?? 'info';
    this.con = opts.console ?? console;
  }

  private emit(
    level: LogLevel,
    operation: string,
    message: string,
    details: Record<string, unknown> = {},
  ): LogEntry {
    const { entityType, entityId, ...rest } = details;
    const entry: LogEntry = {
      level,
      operation,
      message: sanitizeString(message),
      integration: this.integration,
      entityType: entityType != null ? String(entityType) : undefined,
      entityId: entityId != null ? String(entityId) : undefined,
      details: sanitize(rest) as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    };

    const line = JSON.stringify(entry);
    if (level === 'error') this.con.error(line);
    else if (level === 'warn') this.con.warn(line);
    else this.con.log(line);

    if (this.sink && LEVEL_ORDER[level] >= LEVEL_ORDER[this.persistMinLevel]) {
      try {
        const p = Promise.resolve(this.sink(entry)).catch((err) => {
          this.con.warn(`[logger] sink failed: ${sanitizeString(String(err))}`);
        });
        this.pending.push(p);
      } catch {
        // nunca deixar o logger derrubar a função
      }
    }
    return entry;
  }

  debug(operation: string, message: string, details?: Record<string, unknown>) {
    return this.emit('debug', operation, message, details);
  }
  info(operation: string, message: string, details?: Record<string, unknown>) {
    return this.emit('info', operation, message, details);
  }
  warn(operation: string, message: string, details?: Record<string, unknown>) {
    return this.emit('warn', operation, message, details);
  }
  error(operation: string, message: string, details?: Record<string, unknown>) {
    return this.emit('error', operation, message, details);
  }

  /** Aguarda gravações pendentes no sink (chamar antes de encerrar a função). */
  async flush(): Promise<void> {
    await Promise.allSettled(this.pending.splice(0));
  }
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  return new Logger(opts);
}
