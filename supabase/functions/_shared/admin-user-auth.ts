/**
 * Autenticação do painel /gestao/ — Supabase Auth (sessão real de
 * usuário), NÃO o INTEGRATION_ADMIN_SECRET usado pelas ferramentas de
 * desenvolvimento (bling-status, bling-sync-products etc.).
 *
 * O navegador envia `Authorization: Bearer <access_token>` — o token de
 * sessão do Supabase Auth do usuário logado (obtido via
 * supabase.auth.signInWithPassword no cliente). Isso NÃO é um segredo:
 * é o mecanismo padrão e seguro do Supabase Auth, pensado para estar no
 * navegador. O que nunca vai para o navegador é a SERVICE_ROLE_KEY.
 *
 * Fluxo:
 *   1. valida o token contra o Supabase Auth (garante que é uma sessão
 *      real, não forjada) — usa o client service_role só para chamar
 *      `auth.getUser(token)`, que verifica a assinatura/expiração;
 *   2. verifica se esse user_id está em store_admins com active=true —
 *      ter uma conta no Supabase Auth NÃO basta; precisa estar na
 *      allowlist. Sem isso, cadastro público (se algum dia existir)
 *      não daria acesso ao painel por si só;
 *   3. falha fechado: sem header, token inválido/expirado, ou usuário
 *      fora da allowlist → 401/403, sem detalhe interno.
 */
import type { Db } from './supabase.ts';
import { UnauthorizedError } from './errors.ts';

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Resolve e autoriza o usuário administrativo da requisição.
 * Lança UnauthorizedError (401) em qualquer falha — nunca revela qual
 * etapa falhou (token ausente vs inválido vs fora da allowlist), para
 * não ajudar tentativas de descoberta.
 */
export async function requireAdminUser(req: Request, db: Db): Promise<AdminUser> {
  const token = bearerToken(req);
  if (!token) {
    throw new UnauthorizedError('Sessão administrativa ausente.');
  }

  const { data: userData, error: userError } = await db.auth.getUser(token);
  if (userError || !userData?.user) {
    throw new UnauthorizedError('Sessão administrativa inválida ou expirada.');
  }

  const { data: admin, error: adminError } = await db
    .from('store_admins')
    .select('user_id, email, name, active')
    .eq('user_id', userData.user.id)
    .maybeSingle();

  if (adminError) {
    throw new UnauthorizedError('Não foi possível verificar a permissão administrativa.');
  }
  if (!admin || admin.active !== true) {
    throw new UnauthorizedError('Usuário não autorizado a acessar o painel administrativo.');
  }

  return { id: admin.user_id, email: admin.email, name: admin.name ?? null };
}
