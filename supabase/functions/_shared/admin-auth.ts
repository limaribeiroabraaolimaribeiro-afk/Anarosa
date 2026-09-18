/**
 * Proteção das ações administrativas (conectar Bling, sincronizar, processar fila).
 *
 * O chamador envia `x-integration-admin-secret: <INTEGRATION_ADMIN_SECRET>`.
 * Sem o secret configurado no backend a função FALHA FECHADA (401).
 * O segredo nunca vai para o JS publicado: a página de diagnóstico pede
 * o valor ao operador e o mantém apenas na sessão do navegador.
 */
import { getAppConfig } from './config.ts';
import { UnauthorizedError } from './errors.ts';
import { timingSafeEqual } from './crypto.ts';

export const ADMIN_SECRET_HEADER = 'x-integration-admin-secret';

export function isAdminRequest(req: Request, configuredSecret = getAppConfig().integrationAdminSecret): boolean {
  if (!configuredSecret || configuredSecret.length < 16) return false;
  const provided = req.headers.get(ADMIN_SECRET_HEADER) ?? '';
  if (!provided) return false;
  return timingSafeEqual(provided, configuredSecret);
}

export function requireAdmin(req: Request): void {
  const secret = getAppConfig().integrationAdminSecret;
  if (!secret || secret.length < 16) {
    throw new UnauthorizedError(
      'INTEGRATION_ADMIN_SECRET não configurado (mínimo 16 caracteres). Ação administrativa bloqueada.',
    );
  }
  if (!isAdminRequest(req, secret)) {
    throw new UnauthorizedError('Segredo administrativo inválido.');
  }
}

/**
 * Para endpoints com uma visão pública E uma visão administrativa (ex.:
 * bling-status): falha com 401 somente quando o header administrativo
 * FOR enviado e for inválido. Sem header nenhum, não faz nada — o
 * chamador segue como requisição pública normal.
 *
 * Isso evita que uma tentativa de autenticação com segredo errado seja
 * silenciosamente tratada como "requisição anônima" (o que permitiria
 * tentar segredos à vontade sem nunca receber um sinal de falha).
 */
export function assertAdminHeaderIfPresent(req: Request): void {
  const provided = req.headers.get(ADMIN_SECRET_HEADER);
  if (provided == null || provided === '') return;
  const secret = getAppConfig().integrationAdminSecret;
  if (!secret || secret.length < 16 || !timingSafeEqual(provided, secret)) {
    throw new UnauthorizedError('Segredo administrativo inválido.');
  }
}
