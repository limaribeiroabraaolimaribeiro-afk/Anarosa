/**
 * Helpers de resposta HTTP. Erros nunca vazam stack trace nem segredos.
 */
import { corsHeaders } from './cors.ts';
import { describeError } from './errors.ts';
import { sanitize } from './logger.ts';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function json(
  req: Request,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...NO_STORE,
      ...corsHeaders(req),
      ...headers,
    },
  });
}

export function noContent(req: Request): Response {
  return new Response(null, { status: 204, headers: { ...NO_STORE, ...corsHeaders(req) } });
}

export function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: location, ...NO_STORE } });
}

/**
 * Códigos de erro cuja mensagem/detalhes NUNCA devem ir para a resposta
 * HTTP pública — só para o log do servidor (ver context.ts:serve()).
 * `internal_error` cobre qualquer erro não tipado; `database_error`
 * cobre falhas de consulta ao Postgres/PostgREST (podem conter nomes de
 * tabela/coluna/constraint em `pg*`) — ver _shared/errors.ts:DatabaseError.
 */
const MASKED_ERROR_CODES = new Set(['internal_error', 'database_error']);

export function errorResponse(req: Request, err: unknown, fallbackStatus = 500): Response {
  const described = describeError(err);
  const status = described.httpStatus || fallbackStatus;
  const masked = status >= 500 && MASKED_ERROR_CODES.has(described.code);
  const body: Record<string, unknown> = {
    ok: false,
    error: described.code,
    message: masked ? 'Erro interno na integração.' : described.message,
  };
  if (described.details && !masked) body.details = sanitize(described.details);
  return json(req, body, status);
}

export function methodNotAllowed(req: Request, allowed: string[]): Response {
  return json(req, { ok: false, error: 'method_not_allowed', allowed }, 405, {
    Allow: allowed.join(', '),
  });
}

/** Página HTML mínima (usada no callback OAuth quando não há redirect). */
export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE },
  });
}
