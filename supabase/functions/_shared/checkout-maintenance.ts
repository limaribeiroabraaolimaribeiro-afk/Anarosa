import { json } from './responses.ts';

/** Controlled publication pause. Existing payment reconciliation keeps running. */
export function checkoutMaintenance(req: Request): Response | null {
  if (Deno.env.get('COMMERCE_CHECKOUT_PAUSED') !== 'true') return null;
  return json(
    req,
    {
      ok: false,
      error: 'checkout_maintenance',
      message:
        'Estamos atualizando a loja. Aguarde alguns minutos e tente novamente. Seu carrinho foi preservado.',
    },
    503,
    { 'Retry-After': '300' },
  );
}
