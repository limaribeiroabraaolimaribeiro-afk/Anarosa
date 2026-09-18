/**
 * ANAROSA — pedido-confirmado.html
 *
 * Recebe o `token` público do pedido (nunca o id interno) e, quando a
 * InfinitePay redireciona o cliente de volta, também recebe (como
 * query string, anexada por ELA ao redirect_url que enviamos)
 * transaction_nsu/slug/receipt_url/order_nsu/capture_method.
 *
 * IMPORTANTE: nenhum desses parâmetros de retorno é usado para exibir
 * "pagamento confirmado" diretamente — eles só são reenviados como
 * DICA para storefront-order-status, que faz a reconciliação real
 * (POST /payment_check) antes de responder. O estado mostrado na tela
 * é sempre o que o backend devolveu, nunca uma leitura da própria URL.
 */
(function () {
  'use strict';

  const cfg = window.ANAROSA_CONFIG || {};
  const baseUrl = cfg.functionsBaseUrl || (cfg.supabaseUrl ? `${cfg.supabaseUrl.replace(/\/+$/, '')}/functions/v1` : '');

  const els = {
    card: document.querySelector('[data-order-status] > .order-status-card'),
    icon: document.querySelector('[data-order-icon]'),
    title: document.querySelector('[data-order-title]'),
    message: document.querySelector('[data-order-message]'),
    details: document.querySelector('[data-order-details]'),
    total: document.querySelector('[data-order-total]'),
    delivery: document.querySelector('[data-order-delivery]'),
    paymentRow: document.querySelector('[data-order-payment-row]'),
    payment: document.querySelector('[data-order-payment]'),
    receipt: document.querySelector('[data-order-receipt]'),
    retry: document.querySelector('[data-order-retry]'),
  };

  const STATE_UI = {
    confirmado: { icon: '✓', title: 'Pagamento confirmado!', message: 'Recebemos seu pagamento. Já vamos preparar seu pedido.' },
    em_processamento: { icon: '⏳', title: 'Pagamento em processamento', message: 'Ainda estamos confirmando seu pagamento. Isso pode levar alguns minutos — atualize esta página em instantes.' },
    ainda_nao_confirmado: { icon: '⏳', title: 'Pagamento ainda não confirmado', message: 'Não identificamos a confirmação do pagamento ainda. Se você já pagou, aguarde alguns instantes e consulte novamente.' },
    necessita_atencao: { icon: '⚠️', title: 'Precisamos verificar seu pagamento', message: 'Encontramos uma pendência neste pagamento. Fale com a gente pelo WhatsApp para resolver rapidinho.' },
    cancelado: { icon: '✕', title: 'Pedido cancelado', message: 'Este pedido foi cancelado.' },
    nao_foi_possivel_consultar: { icon: '⚠️', title: 'Não foi possível consultar agora', message: 'Estamos com instabilidade para consultar o status do pagamento. Tente novamente em alguns instantes.' },
    erro: { icon: '⚠️', title: 'Não foi possível consultar seu pedido', message: 'Verifique o link recebido ou tente novamente em alguns instantes.' },
  };

  const DELIVERY_LABELS = { pickup: 'Retirar na loja', delivery: 'Entrega' };
  const CAPTURE_LABELS = { pix: 'Pix', credit_card: 'Cartão de crédito' };

  function formatPrice(value) {
    return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function render(stateKey, data) {
    const ui = STATE_UI[stateKey] || STATE_UI.erro;
    if (els.card) els.card.dataset.state = stateKey;
    if (els.icon) els.icon.textContent = ui.icon;
    if (els.title) els.title.textContent = ui.title;
    if (els.message) els.message.textContent = ui.message;

    if (data) {
      if (els.details) els.details.hidden = false;
      if (els.total) els.total.textContent = formatPrice(data.total);
      if (els.delivery) els.delivery.textContent = DELIVERY_LABELS[data.deliveryMethod] || '—';
      const hasPayment = data.payment && (data.payment.captureMethod || data.payment.installments);
      if (els.paymentRow) els.paymentRow.hidden = !hasPayment;
      if (hasPayment && els.payment) {
        const methodLabel = CAPTURE_LABELS[data.payment.captureMethod] || data.payment.captureMethod || '—';
        const installments = data.payment.installments && data.payment.installments > 1 ? ` em ${data.payment.installments}x` : '';
        els.payment.textContent = `${methodLabel}${installments}`;
      }
      if (els.receipt) {
        if (data.payment && data.payment.receiptUrl) {
          els.receipt.href = data.payment.receiptUrl;
          els.receipt.hidden = false;
        } else {
          els.receipt.hidden = true;
        }
      }
    }

    const needsRetry = stateKey === 'em_processamento' || stateKey === 'ainda_nao_confirmado' || stateKey === 'nao_foi_possivel_consultar' || stateKey === 'erro';
    if (els.retry) els.retry.hidden = !needsRetry;
    return stateKey;
  }

  // Estados finais — parar de consultar sozinho ao chegar em qualquer um deles.
  const TERMINAL_STATES = new Set(['confirmado', 'necessita_atencao', 'cancelado']);

  // Consulta moderada e automática (B5): só LÊ o status via
  // storefront-order-status — nunca cria pedido nem pagamento novo.
  // Some sozinha depois de POLL_MAX_ATTEMPTS tentativas; a partir daí só
  // o botão "Consultar novamente" (manual) continua disponível.
  const POLL_INTERVAL_MS = 5000;
  const POLL_MAX_ATTEMPTS = 12; // ~1 minuto de espera automática
  let pollAttempts = 0;
  let pollTimer = null;

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedulePoll() {
    stopPolling();
    if (pollAttempts >= POLL_MAX_ATTEMPTS) return;
    pollTimer = setTimeout(async () => {
      pollAttempts += 1;
      const stateKey = await consultar();
      if (!TERMINAL_STATES.has(stateKey)) schedulePoll();
    }, POLL_INTERVAL_MS);
  }

  async function consultar() {
    const url = new URL(window.location.href);
    const token = url.searchParams.get('token');
    if (!token || !baseUrl) {
      return render('erro');
    }

    const statusUrl = new URL(`${baseUrl}/storefront-order-status`);
    statusUrl.searchParams.set('token', token);
    // Dicas do retorno da InfinitePay (opcionais) — usadas só como
    // gatilho de reconciliação real no backend, nunca como veredito.
    const transactionNsu = url.searchParams.get('transaction_nsu');
    const slug = url.searchParams.get('slug');
    const receiptUrl = url.searchParams.get('receipt_url');
    if (transactionNsu) statusUrl.searchParams.set('transactionNsu', transactionNsu);
    if (slug) statusUrl.searchParams.set('slug', slug);
    if (receiptUrl) statusUrl.searchParams.set('receiptUrl', receiptUrl);

    try {
      const res = await fetch(statusUrl.toString(), { headers: { Accept: 'application/json' } });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) {
        return render('erro');
      }
      return render(json.uiStatus, json);
    } catch (err) {
      console.error('[Anarosa pedido-confirmado] falha ao consultar status:', err);
      return render('nao_foi_possivel_consultar');
    }
  }

  els.retry?.addEventListener('click', async () => {
    stopPolling();
    render('loading');
    if (els.icon) els.icon.textContent = '⏳';
    pollAttempts = 0;
    const stateKey = await consultar();
    if (!TERMINAL_STATES.has(stateKey)) schedulePoll();
  });

  (async () => {
    const stateKey = await consultar();
    if (!TERMINAL_STATES.has(stateKey)) schedulePoll();
  })();
})();
