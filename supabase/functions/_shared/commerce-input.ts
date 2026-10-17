import { ValidationError } from './errors.ts';
import { sha256Hex } from './crypto.ts';

export function validDocument(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (!/^(\d{11}|\d{14})$/.test(digits) || /^(\d)\1+$/.test(digits)) return false;
  const check = (base: string, weights: number[]) => {
    const mod = [...base].reduce((sum, n, i) => sum + Number(n) * weights[i], 0) % 11;
    return mod < 2 ? 0 : 11 - mod;
  };
  const weights = digits.length === 11 ? [10, 9, 8, 7, 6, 5, 4, 3, 2] : [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const base = digits.slice(0, -2);
  const a = check(base, weights);
  const b = check(base + a, digits.length === 11 ? [11, ...weights] : [6, ...weights]);
  return digits.endsWith(`${a}${b}`);
}
function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
export async function validateCheckout(raw: unknown) {
  // deno-lint-ignore no-explicit-any
  const b = (raw ?? {}) as Record<string, any>;
  if (!/^[a-zA-Z0-9_-]{32,128}$/.test(b.idempotencyKey ?? '')) {
    throw new ValidationError('Reabra a revisão do pedido para gerar uma referência segura.');
  }
  const c = b.customer ?? {};
  const s = b.shipping ?? {};
  const p = b.payment ?? {};
  const phone = text(c.phone, 30).replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
  const customer = {
    name: text(c.name, 120),
    phone,
    email: text(c.email, 160) || null,
    document: text(c.document, 30).replace(/\D/g, '') || null,
  };
  if (customer.name.length < 2 || !/^[1-9]{2}\d{8,9}$/.test(phone)) {
    throw new ValidationError('Informe nome e telefone brasileiro com DDD.');
  }
  if (customer.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer.email)) {
    throw new ValidationError('E-mail inválido.');
  }
  if (customer.document && !validDocument(customer.document)) throw new ValidationError('CPF/CNPJ inválido.');
  if (
    Deno.env.get('BLING_ORDER_SYNC_ENABLED') === 'true' &&
    Deno.env.get('BLING_ORDER_OPERATION_VALIDATED') === 'true' && !customer.document
  ) throw new ValidationError('Informe CPF/CNPJ para registrar o pedido no Bling.');
  if (
    !['pickup', 'delivery'].includes(s.method) || !['pix', 'card_on_pickup', 'whatsapp'].includes(p.method)
  ) throw new ValidationError('Entrega ou pagamento inválido.');
  const address: Record<string, string> = {};
  if (s.method === 'delivery') {
    for (const k of ['zip', 'street', 'number', 'complement', 'district', 'city', 'state']) {
      address[k] = text(s.address?.[k], k === 'number' ? 20 : 160);
    }
    address.zip = address.zip.replace(/\D/g, '');
    address.state = address.state.toUpperCase();
    if (
      !/^\d{8}$/.test(address.zip) ||
      !/^(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/.test(
        address.state,
      ) || ['street', 'number', 'district', 'city'].some((k) => !address[k])
    ) throw new ValidationError('Informe CEP e endereço completos.');
  }
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 50) {
    throw new ValidationError('Carrinho inválido.');
  }
  // deno-lint-ignore no-explicit-any
  const items = b.items.map((it: any) => {
    const slug = text(it?.slug, 200);
    const variantBlingId = it?.variantBlingId ? text(it.variantBlingId, 20) : null;
    if (
      !slug || !Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 20 ||
      (variantBlingId && !/^[1-9]\d*$/.test(variantBlingId))
    ) throw new ValidationError('Produto ou quantidade inválida.');
    return { slug, variantBlingId, quantity: it.quantity };
  }).sort((a, b) => (a.slug + (a.variantBlingId || '')).localeCompare(b.slug + (b.variantBlingId || '')));
  const request = {
    customer,
    shipping: { method: s.method, address: s.method === 'delivery' ? address : null },
    payment: { method: p.method },
    items,
  };
  return {
    ...request,
    idempotencyKey: b.idempotencyKey,
    fingerprint: await sha256Hex(JSON.stringify(request)),
  };
}

export function validateSettings(raw: unknown) {
  // deno-lint-ignore no-explicit-any
  const b = (raw ?? {}) as Record<string, any>;
  const name = text(b.name, 100), whatsapp = text(b.whatsapp, 20).replace(/\D/g, '');
  if (!name || !/^55[1-9]{2}\d{8,9}$/.test(whatsapp)) {
    throw new ValidationError('Informe nome e WhatsApp com código 55 e DDD.');
  }
  const instagram = text(b.instagram, 250);
  if (instagram && !/^https:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.\/]+$/.test(instagram)) {
    throw new ValidationError('Link do Instagram inválido.');
  }
  const methods = (key: string, allowed: string[]) => {
    if (
      !Array.isArray(b[key]) || !b[key].length || b[key].some((v: unknown) => !allowed.includes(String(v)))
    ) throw new ValidationError('Habilite pelo menos uma modalidade válida.');
    return [...new Set(b[key])];
  };
  if (!['fixed', 'quote'].includes(b.deliveryPricing)) throw new ValidationError('Regra de frete inválida.');
  const deliveryPrice = Number(b.deliveryPrice);
  if (!Number.isFinite(deliveryPrice) || deliveryPrice < 0 || deliveryPrice > 10000) {
    throw new ValidationError('Valor de frete inválido.');
  }
  if (Number(b.pixDiscountPercent) !== 0) {
    throw new ValidationError(
      'Desconto exclusivo Pix depende de suporte confirmado do provedor; o link atual permite também cartão.',
    );
  }
  return {
    name,
    whatsapp,
    instagram,
    pickupAddress: text(b.pickupAddress, 300),
    serviceMessage: text(b.serviceMessage, 500),
    deliveryMethods: methods('deliveryMethods', ['pickup', 'delivery']),
    paymentMethods: methods('paymentMethods', ['pix', 'card_on_pickup', 'whatsapp']),
    deliveryPricing: b.deliveryPricing,
    deliveryPrice: Math.round(deliveryPrice * 100) / 100,
    pixDiscountPercent: 0,
  };
}
