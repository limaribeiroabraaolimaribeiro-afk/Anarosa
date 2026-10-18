/**
 * ANAROSA — checkout.html
 *
 * Fluxo: carrinho → dados do cliente → entrega/retirada → pagamento →
 * revisão → confirmação. Preço/estoque exibidos aqui (inclusive na
 * revisão) são só para conveniência do cliente; a fonte de verdade é
 * SEMPRE o backend:
 *   - antes da revisão, revalida cada item via storefront-product
 *     (mesma API pública da vitrine) e avisa se preço/estoque mudaram;
 *   - ao confirmar, envia só slug + variação + quantidade para
 *     storefront-checkout — NUNCA envia preço. O backend recalcula
 *     tudo e rejeita item inativo/sem estoque/variação inexistente.
 *
 * Pagamento:
 *   - "pix" → paga de verdade, online, via Checkout Integrado da
 *     InfinitePay (infinitepay-create-payment cria o link; o cliente é
 *     redirecionado para o domínio da InfinitePay, que também oferece
 *     cartão dentro do checkout dela). Nenhum dado de cartão passa
 *     pelo nosso site — a InfinitePay é quem coleta isso.
 *   - "card_on_pickup" (cartão na retirada/entrega) e "whatsapp" → só
 *     uma PREFERÊNCIA registrada, sem cobrança online; vai direto para
 *     a tela de confirmação local, como antes.
 * A criação do pedido no Bling continua desativada
 * (BLING_ORDER_SYNC_ENABLED=false) — nenhum endpoint deste fluxo chama
 * o Bling.
 */
(function () {
  'use strict';

  const cfg = window.ANAROSA_CONFIG || {};
  const baseUrl = cfg.functionsBaseUrl || (cfg.supabaseUrl ? `${cfg.supabaseUrl.replace(/\/+$/, '')}/functions/v1` : '');
  const placeholderImage = cfg.placeholderImage || '';
  const cart = window.AnarosaCart.createCartService();

  const STEPS = ['cart', 'customer', 'delivery', 'payment', 'review', 'confirmation'];
  const DRAFT_KEY = 'anarosa_checkout_draft_v2';
  try{localStorage.removeItem('anarosa_checkout_draft_v1');}catch{}
  let businessSettings=null;
  window.AnarosaSettings.ready.then(value=>{businessSettings=value;if(!value)showBanner('Não foi possível carregar as opções da loja. Atualize a página antes de concluir.');else{
    for(const [name,enabled] of [['shippingMethod',value.deliveryMethods],['paymentMethod',value.paymentMethods]]){
      const options=[...document.querySelectorAll(`input[name="${name}"]`)];
      options.forEach(el=>{el.disabled=!enabled.includes(el.value);el.closest('label').hidden=el.disabled;});
      if(!options.some(el=>el.checked&&!el.disabled)){const first=options.find(el=>!el.disabled);if(first){first.checked=true;first.dispatchEvent(new Event('change',{bubbles:true}));}}
    }
  }});

  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function formatPrice(value) {
    return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function loadDraft() {
    try {
      return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '{}');
    } catch {
      return {};
    }
  }
  function saveDraft() {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* ignore */ }
  }

  const draft = Object.assign(
    { customer: {}, shipping: { method: 'pickup', address: null }, payment: { method: 'pix' } },
    loadDraft(),
  );

  const panels = {};
  document.querySelectorAll('[data-panel]').forEach((el) => { panels[el.dataset.panel] = el; });
  const stepIndicators = {};
  document.querySelectorAll('[data-step-indicator]').forEach((el) => { stepIndicators[el.dataset.stepIndicator] = el; });
  const bannerEl = document.querySelector('[data-checkout-banner]');
  const toastEl = document.querySelector('[data-toast]');

  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('is-visible');
    setTimeout(() => toastEl.classList.remove('is-visible'), 2600);
  }

  function showBanner(msg) {
    if (!bannerEl) return;
    bannerEl.hidden = !msg;
    bannerEl.textContent = msg || '';
  }

  function showStep(step) {
    Object.entries(panels).forEach(([key, el]) => { if (el) el.hidden = key !== step; });
    const idx = STEPS.indexOf(step);
    Object.entries(stepIndicators).forEach(([key, el]) => {
      const i = STEPS.indexOf(key);
      el.classList.toggle('is-active', key === step);
      el.classList.toggle('is-done', i >= 0 && idx >= 0 && i < idx);
    });
    window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    if (step === 'review') runReview();
  }

  /* -----------------------------------------------------------
     Etapa 1 — Carrinho
     ----------------------------------------------------------- */
  function renderCartStep() {
    const items = cart.getItems();
    const el = document.querySelector('[data-checkout-cart-items]');
    if (!el) return;
    if (!items.length) {
      el.innerHTML = '<p class="cart-empty">Seu carrinho está vazio. <a href="index.html#novidades">Voltar para a loja</a>.</p>';
      return;
    }
    el.innerHTML = items.map((item) => `
      <div class="cart-item" data-cart-item="${item.key}">
        <img src="${escapeHtml(item.image || placeholderImage)}" alt="${escapeHtml(item.name)}" loading="lazy" onerror="this.onerror=null;this.src='${escapeHtml(placeholderImage)}';">
        <div>
          <p class="cart-item-name">${escapeHtml(item.name)}</p>
          ${[item.size, item.color].filter(Boolean).length ? `<p class="cart-item-attrs">${escapeHtml([item.size, item.color].filter(Boolean).join(' · '))}</p>` : ''}
          <div class="cart-qty">
            <button type="button" data-qty-dec="${item.key}" aria-label="Diminuir quantidade">−</button>
            <span>${item.quantity}</span>
            <button type="button" data-qty-inc="${item.key}" aria-label="Aumentar quantidade">+</button>
          </div>
          <button type="button" class="cart-item-remove" data-qty-remove="${item.key}">Remover</button>
        </div>
        <p class="cart-item-price">${formatPrice(item.unitPrice * item.quantity)}</p>
      </div>`).join('');
    el.querySelectorAll('[data-qty-inc]').forEach((b) => b.addEventListener('click', () => {
      const it = cart.getItems().find((i) => i.key === b.dataset.qtyInc);
      if (!it) return;
      const result = cart.updateQuantity(it.key, it.quantity + 1);
      if (result.clamped) showToast(`Estoque disponível: ${result.maxQuantity} unidade(s).`);
    }));
    el.querySelectorAll('[data-qty-dec]').forEach((b) => b.addEventListener('click', () => {
      const it = cart.getItems().find((i) => i.key === b.dataset.qtyDec);
      if (it) cart.updateQuantity(it.key, it.quantity - 1);
    }));
    el.querySelectorAll('[data-qty-remove]').forEach((b) => b.addEventListener('click', () => cart.removeItem(b.dataset.qtyRemove)));
  }
  cart.onChange(renderCartStep);
  renderCartStep();

  /* -----------------------------------------------------------
     Etapa 2 — Dados do cliente
     ----------------------------------------------------------- */
  const customerForm = document.querySelector('[data-form-customer]');
  if (customerForm) {
    customerForm.name.value = draft.customer.name || '';
    customerForm.phone.value = draft.customer.phone || '';
    customerForm.email.value = draft.customer.email || '';
    customerForm.document.value = draft.customer.document || '';
  }

  function validateCustomer() {
    const errEl = document.querySelector('[data-form-error="customer"]');
    const name = customerForm.name.value.trim();
    const phone = customerForm.phone.value.trim();
    if (name.length<2 || !/^(?:55)?[1-9]{2}\d{8,9}$/.test(phone.replace(/\D/g,'')) || !customerForm.checkValidity()) {
      errEl.textContent = 'Nome e WhatsApp/telefone são obrigatórios.';
      errEl.hidden = false;
      return false;
    }
    errEl.hidden = true;
    draft.customer = {
      name,
      phone,
      email: customerForm.email.value.trim() || null,
      document: customerForm.document.value.trim() || null,
    };
    saveDraft();
    return true;
  }

  /* -----------------------------------------------------------
     Etapa 3 — Entrega / retirada
     ----------------------------------------------------------- */
  const addressForm = document.querySelector('[data-form-address]');
  const shippingRadios = document.querySelectorAll('input[name="shippingMethod"]');
  shippingRadios.forEach((r) => {
    if (draft.shipping.method === r.value) r.checked = true;
    r.addEventListener('change', () => { if (addressForm) addressForm.hidden = r.value !== 'delivery'; });
  });
  if (addressForm) {
    addressForm.hidden = draft.shipping.method !== 'delivery';
    if (draft.shipping.address) {
      Object.entries(draft.shipping.address).forEach(([k, v]) => { if (addressForm[k]) addressForm[k].value = v || ''; });
    }
  }

  let cepRequest=0;
  addressForm?.zip.addEventListener('blur',async()=>{const cep=addressForm.zip.value.replace(/\D/g,'');if(!/^\d{8}$/.test(cep))return;const n=++cepRequest;const errEl=document.querySelector('[data-form-error="delivery"]');try{const res=await fetch(`https://viacep.com.br/ws/${cep}/json/`,{signal:AbortSignal.timeout(8000)});if(!res.ok)throw new Error();const data=await res.json();if(data.erro)throw new Error();if(n!==cepRequest||addressForm.zip.value.replace(/\D/g,'')!==cep)return;for(const [key,value] of Object.entries({street:data.logradouro,district:data.bairro,city:data.localidade,state:data.uf}))if(value)addressForm[key].value=value;errEl.hidden=true;}catch{errEl.textContent='Não foi possível consultar o CEP. Preencha o endereço manualmente.';errEl.hidden=false;}});

  function validateDelivery() {
    const errEl = document.querySelector('[data-form-error="delivery"]');
    const method = document.querySelector('input[name="shippingMethod"]:checked').value;
    if (method === 'delivery') {
      const required = ['zip', 'street', 'number', 'district', 'city', 'state'];
      const missing = required.filter((f) => !addressForm[f].value.trim());
      if(!/^\d{8}$/.test(addressForm.zip.value.replace(/\D/g,'')))missing.push('zip');
      if (missing.length) {
        errEl.textContent = 'Preencha o endereço completo para entrega.';
        errEl.hidden = false;
        return false;
      }
    }
    errEl.hidden = true;
    draft.shipping = {
      method,
      address: method === 'delivery' ? {
        zip: addressForm.zip.value.trim(),
        street: addressForm.street.value.trim(),
        number: addressForm.number.value.trim(),
        complement: addressForm.complement.value.trim(),
        district: addressForm.district.value.trim(),
        city: addressForm.city.value.trim(),
        state: addressForm.state.value.trim().toUpperCase(),
      } : null,
    };
    saveDraft();
    return true;
  }

  /* -----------------------------------------------------------
     Etapa 4 — Pagamento (preferência; nenhuma cobrança real aqui)
     ----------------------------------------------------------- */
  document.querySelectorAll('input[name="paymentMethod"]').forEach((r) => {
    if (draft.payment.method === r.value) r.checked = true;
  });
  function validatePayment() {
    const selected=document.querySelector('input[name="paymentMethod"]:checked');
    const paymentError=document.querySelector('[data-payment-error]');
    if(!businessSettings||!selected||selected.disabled||(selected.value==='pix'&&draft.shipping.method==='delivery'&&businessSettings.deliveryPricing==='quote')){if(paymentError){paymentError.hidden=false;paymentError.textContent='O frete precisa ser definido antes do pagamento online. Escolha combinar pelo WhatsApp.';}return false;}
    if(paymentError)paymentError.hidden=true;
    draft.payment = { method:selected.value };
    saveDraft();
    return true;
  }

  /* -----------------------------------------------------------
     Navegação entre etapas
     ----------------------------------------------------------- */
  document.querySelectorAll('[data-next]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const step = btn.dataset.next;
      if (step === 'cart' && cart.getItems().length === 0) { showToast('Seu carrinho está vazio.'); return; }
      if (step === 'customer' && !validateCustomer()) return;
      if (step === 'delivery' && !validateDelivery()) return;
      if (step === 'payment' && !validatePayment()) return;
      showStep(STEPS[STEPS.indexOf(step) + 1]);
    });
  });
  document.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => {
      showStep(STEPS[Math.max(STEPS.indexOf(btn.dataset.back) - 1, 0)]);
    });
  });

  /* -----------------------------------------------------------
     Etapa 5 — Revisão (revalida contra o catálogo público real)
     ----------------------------------------------------------- */
  async function fetchLatest(slug) {
    const url = new URL(`${baseUrl}/storefront-product`);
    url.searchParams.set('slug', slug);
    const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`storefront-product HTTP ${res.status}`);
    const json = await res.json().catch(() => null);
    return json && json.product ? json.product : null;
  }

  const PAYMENT_LABELS = { pix: 'Pix', card_on_pickup: 'Cartão na retirada/entrega', whatsapp: 'Combinar pelo WhatsApp' };

  async function runReview() {
    const items = cart.getItems();
    const loadingEl = document.querySelector('[data-review-loading]');
    const warningsEl = document.querySelector('[data-review-warnings]');
    const itemsEl = document.querySelector('[data-review-items]');
    const totalEl = document.querySelector('[data-review-total]');
    const confirmBtn = document.querySelector('[data-confirm-order]');
    const errEl = document.querySelector('[data-form-error="review"]');

    errEl.hidden = true;
    confirmBtn.disabled = true;
    if (loadingEl) loadingEl.hidden = false;
    if (warningsEl) { warningsEl.hidden = true; warningsEl.innerHTML = ''; }

    if (!baseUrl) {
      if (loadingEl) loadingEl.hidden = true;
      errEl.textContent = 'Catálogo não configurado. Não é possível confirmar o pedido neste ambiente.';
      errEl.hidden = false;
      return;
    }
    if (!items.length) {
      if (loadingEl) loadingEl.hidden = true;
      showStep('cart');
      return;
    }

    const uniqueSlugs = [...new Set(items.map((i) => i.slug))];
    const latestBySlug = {};
    try {
      const results = await Promise.all(uniqueSlugs.map((slug) => fetchLatest(slug)));
      uniqueSlugs.forEach((slug, i) => { latestBySlug[slug] = results[i]; });
    } catch (err) {
      if (loadingEl) loadingEl.hidden = true;
      errEl.textContent = 'Não foi possível confirmar o catálogo agora. Tente novamente em instantes.';
      errEl.hidden = false;
      console.error('[Anarosa checkout] falha ao revalidar catálogo:', err);
      return;
    }

    const warnings = [];
    const reviewItems = items.map((item) => {
      const latest = latestBySlug[item.slug];
      let currentUnitPrice = item.unitPrice;
      let currentStock = null;
      let unavailable = false;

      if (!latest) {
        unavailable = true;
        warnings.push(`"${item.name}" não está mais disponível.`);
      } else {
        const variant = item.variantBlingId ? (latest.variants || []).find((v) => v.blingId === item.variantBlingId) : null;
        if ((item.variantBlingId && !variant) || ((latest.variants||[]).length&&!item.variantBlingId)) {
          unavailable = true;
          warnings.push(`A variação escolhida de "${item.name}" não está mais disponível.`);
        } else {
          const source = variant || latest;
          currentUnitPrice = source.promotionalPrice != null ? source.promotionalPrice : source.price;
          currentStock = source.stock;
          if (source.available === false || currentStock == null) {
            unavailable = true;
            warnings.push(`"${item.name}" está esgotado.`);
          } else if (currentStock != null && currentStock < item.quantity) {
            unavailable = true;
            warnings.push(`Estoque de "${item.name}" mudou (disponível: ${currentStock}).`);
          }
          if (currentUnitPrice != null && Math.abs(currentUnitPrice - item.unitPrice) > 0.001) {
            warnings.push(`O preço de "${item.name}" foi atualizado para ${formatPrice(currentUnitPrice)}.`);
          }
        }
      }
      return { ...item, currentUnitPrice: currentUnitPrice != null ? currentUnitPrice : item.unitPrice, currentStock, unavailable };
    });

    if (loadingEl) loadingEl.hidden = true;

    if (itemsEl) {
      itemsEl.innerHTML = reviewItems.map((it) => `
        <div class="checkout-review-item">
          <span>${escapeHtml(it.name)} × ${it.quantity}${it.unavailable ? ' <strong>(indisponível)</strong>' : ''}
            ${[it.size, it.color].filter(Boolean).length ? `<small>${escapeHtml([it.size, it.color].filter(Boolean).join(' · '))}</small>` : ''}
          </span>
          <span>${formatPrice(it.currentUnitPrice * it.quantity)}</span>
        </div>`).join('');
    }

    const total = reviewItems.filter((i) => !i.unavailable).reduce((sum, i) => sum + i.currentUnitPrice * i.quantity, 0);
    if (totalEl) totalEl.textContent = formatPrice(total+(draft.shipping.method==='delivery'&&businessSettings?.deliveryPricing==='fixed'?Number(businessSettings.deliveryPrice):0))+(draft.shipping.method==='delivery'&&businessSettings?.deliveryPricing!=='fixed'?' + frete a combinar':'');

    const custEl = document.querySelector('[data-review-customer]');
    if (custEl) custEl.textContent = `${draft.customer.name} — ${draft.customer.phone}${draft.customer.email ? ' — ' + draft.customer.email : ''}`;

    const delEl = document.querySelector('[data-review-delivery]');
    if (delEl) {
      delEl.textContent = draft.shipping.method === 'pickup'
        ? 'Retirar na loja — Anarosa Textil, Luiz Alves - SC'
        : `Entrega: ${draft.shipping.address.street}, ${draft.shipping.address.number} — ${draft.shipping.address.city}/${draft.shipping.address.state} (frete a combinar)`;
    }

    const payEl = document.querySelector('[data-review-payment]');
    if (payEl) payEl.textContent = PAYMENT_LABELS[draft.payment.method] || draft.payment.method;

    if (warnings.length && warningsEl) {
      warningsEl.hidden = false;
      warningsEl.innerHTML = `<strong>Atenção:</strong><ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`;
    }

    confirmBtn.disabled = !businessSettings || reviewItems.some((i) => i.unavailable) || reviewItems.length === 0;
  }

  /* -----------------------------------------------------------
     Confirmar pedido — backend é a fonte final de verdade
     ----------------------------------------------------------- */
  let confirmInFlight = false;
  document.querySelector('[data-confirm-order]')?.addEventListener('click', async () => {
    if (confirmInFlight) return; // bloqueia duplo clique
    confirmInFlight = true;
    const confirmBtn = document.querySelector('[data-confirm-order]');
    const errEl = document.querySelector('[data-form-error="review"]');
    errEl.hidden = true;
    confirmBtn.disabled = true;
    const originalLabel = confirmBtn.textContent;
    confirmBtn.textContent = 'Enviando pedido...';

    const items = cart.getItems().map((i) => ({ slug: i.slug, variantBlingId: i.variantBlingId || null, quantity: i.quantity }));
    const payload = {
      customer: draft.customer,
      shipping: { method: draft.shipping.method, address: draft.shipping.address || null },
      payment: draft.payment,
      items,
    };

    const signature=JSON.stringify(payload);
    if(draft.intentSignature!==signature){draft.intentSignature=signature;draft.idempotencyKey=crypto.randomUUID().replaceAll('-','');draft.publicToken=null;saveDraft();}
    payload.idempotencyKey=draft.idempotencyKey;
    try {
      const res = await fetch(`${baseUrl}/storefront-checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        errEl.textContent = json.message || 'Não foi possível confirmar o pedido. Revise os itens e tente novamente.';
        errEl.hidden = false;
        confirmBtn.textContent = originalLabel;
        confirmBtn.disabled = false;
        confirmInFlight = false;
        await runReview(); // estoque/preço podem ter mudado entre a revisão e a confirmação
        return;
      }

      // Só "Pix" (pago online via InfinitePay) passa por pagamento real.
      // "Cartão na retirada/entrega" e "Combinar pelo WhatsApp" são só
      // preferência registrada — vão direto para a confirmação local.
      if (draft.payment.method !== 'pix') {
        cart.clear();
        try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
        const orderIdEl = document.querySelector('[data-confirmation-order-id]');
        if (orderIdEl) orderIdEl.textContent = json.orderId || '—';
        showStep('confirmation');
        return;
      }

      confirmBtn.textContent = 'Preparando pagamento...';
      const payRes = await fetch(`${baseUrl}/infinitepay-create-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ publicToken: json.publicToken }),
      });
      const payJson = await payRes.json().catch(() => ({}));
      if (payRes.ok && payJson.paymentUrl) {
        draft.publicToken=json.publicToken;saveDraft();
        if(!/^https:\/\/(?:[a-z0-9-]+\.)*infinitepay\.(?:io|com\.br)\//i.test(payJson.paymentUrl))throw new Error('URL de pagamento inválida');
        window.location.href = payJson.paymentUrl;
        return;
      }
      if (payRes.ok && payJson.alreadyPaid) {
        cart.clear();
        try { sessionStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
        window.location.href = `pedido-confirmado.html?token=${encodeURIComponent(payJson.publicToken)}`;
        return;
      }
      // Falha ao criar o link de pagamento — o pedido já existe (idempotente:
      // clicar em "tentar novamente" reaproveita o mesmo pedido/link, nunca
      // cria um pedido duplicado, pois storefront-checkout já é idempotente
      // e infinitepay-create-payment reaproveita payment_url se já existir).
      errEl.textContent = payJson.message || 'Não foi possível iniciar o pagamento agora. Tente novamente em alguns instantes.';
      errEl.hidden = false;
      confirmBtn.textContent = 'Tentar pagamento novamente';
      confirmBtn.disabled = false;
      confirmInFlight = false;
    } catch (err) {
      errEl.textContent = 'Falha de conexão. Verifique sua internet e tente novamente.';
      errEl.hidden = false;
      confirmBtn.textContent = originalLabel;
      confirmBtn.disabled = false;
      confirmInFlight = false;
      console.error('[Anarosa checkout] falha ao confirmar pedido:', err);
    }
  });

  /* -----------------------------------------------------------
     WhatsApp (confirmação)
     ----------------------------------------------------------- */
  // Atendimento e links comerciais vêm de AnarosaSettings.

  if (!baseUrl) showBanner('Catálogo não configurado (js/config.js). O checkout não pode ser concluído neste ambiente.');

  showStep('cart');
})();
