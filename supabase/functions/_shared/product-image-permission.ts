/**
 * Os dois novos escopos foram concedidos juntos pelo Bling na autorização
 * de 24/10/2026: "Salvar imagens dos Produtos" e "Salvar variações de Produtos".
 * Somente habilita o editor de mídia quando AMBOS estiverem presentes.
 * Não revela tokens OAuth ao navegador.
 */
import type { TokenStore } from './token-store.ts';

const PHOTO_SCOPE_GRANTS = ['106168710', '199272829'] as const;

export async function canWriteProductImages(tokenStore: Pick<TokenStore, 'getConnection'>): Promise<boolean> {
  const conn = await tokenStore.getConnection();
  if (!conn || conn.status !== 'connected') return false;
  const scopes = new Set((conn.scope ?? '').split(/\s+/).filter(Boolean));
  return PHOTO_SCOPE_GRANTS.every((scope) => scopes.has(scope));
}
