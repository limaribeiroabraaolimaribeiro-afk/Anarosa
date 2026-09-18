/**
 * Claim atômico com TTL para a criação do link InfinitePay
 * (infinitepay-create-payment). Extraído para módulo próprio para ser
 * testável sem precisar de um banco real (ver _tests/payment-claim.test.ts).
 *
 * Por que TTL (achado da auditoria de 2026-09-17): sem prazo, um
 * processo que morresse ENTRE o claim e a gravação de payment_url (ou
 * antes do catch liberar o claim) deixaria o pedido com
 * payment_provider='infinitepay' para sempre, sem payment_url — nenhuma
 * tentativa futura conseguiria reivindicar de novo (bloqueio
 * permanente). Mesmo padrão de bling_connections.refresh_lock_until /
 * private.cron_locks.locked_until.
 */
// deno-lint-ignore no-explicit-any
type Db = any;

/**
 * Tenta reivindicar a criação do link para este pedido. Só succeeds
 * quando: payment_status='pending' AND payment_url IS NULL AND
 * (nunca reivindicado OU o prazo anterior já expirou).
 */
export async function tryClaimPaymentLinkCreation(db: Db, orderId: string, ttlMs: number): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from('store_orders')
    .update({
      payment_provider: 'infinitepay',
      payment_claim_expires_at: new Date(Date.now() + ttlMs).toISOString(),
    })
    .eq('id', orderId)
    .eq('payment_status', 'pending')
    .is('payment_url', null)
    .or(`payment_claim_expires_at.is.null,payment_claim_expires_at.lt.${nowIso}`)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`create_payment_claim_failed: ${error.message}`);
  return Boolean(data);
}

/**
 * Libera o claim (usado no catch de falha ao chamar a InfinitePay).
 * Só afeta a linha se payment_url ainda não tiver sido gravado — nunca
 * desfaz um claim que já resultou em sucesso.
 */
export async function releasePaymentLinkClaim(
  db: Db,
  orderId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db
    .from('store_orders')
    .update({ payment_provider: null, payment_claim_expires_at: null, ...extra })
    .eq('id', orderId)
    .is('payment_url', null);
  if (error) throw new Error(`create_payment_claim_release_failed: ${error.message}`);
}
