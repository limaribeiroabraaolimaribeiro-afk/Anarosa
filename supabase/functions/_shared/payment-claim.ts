/**
 * Claim atômico com TTL para a criação do link InfinitePay
 * (infinitepay-create-payment). Extraído para módulo próprio para ser
 * testável sem precisar de um banco real (ver _tests/payment-claim.test.ts).
 *
 * O prazo identifica uma tentativa interrompida; não autoriza uma nova
 * cobrança. Sem idempotência garantida pelo provedor, timeout ou perda
 * da resposta exige reconciliação antes de liberar outra tentativa.
 */
// deno-lint-ignore no-explicit-any
type Db = any;

/**
 * Tenta reivindicar a criação do link para este pedido. Só succeeds
 * quando: payment_status='pending' AND payment_url IS NULL AND
 * payment_provider IS NULL. Um claim expirado com provedor permanece bloqueado.
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
    // An expired network attempt may have created a remote link. Expiry is
    // diagnostic, not permission to issue a second financial request.
    .is('payment_provider', null)
    .or(`payment_claim_expires_at.is.null,payment_claim_expires_at.lt.${nowIso}`)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`create_payment_claim_failed: ${error.message}`);
  return Boolean(data);
}

/**
 * Libera o claim apenas quando a rejeição remota foi definitiva (4xx).
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
