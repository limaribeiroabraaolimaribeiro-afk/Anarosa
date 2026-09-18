/**
 * Gestão Anarosa — app principal (/gestao/index.html).
 * Sem framework: DOM puro, roteamento por hash, mesmo espírito do
 * resto do site. Todo texto vindo de dados (nome/telefone de cliente,
 * nome de produto etc.) passa por escapeHtml() antes de ir para o DOM
 * — esses campos vêm do checkout público, então são entrada não
 * confiável.
 */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function fmtMoney(v) {
    return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR');
  }

  const toastEl = $('[data-toast]');
  function showToast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('is-visible');
    setTimeout(() => toastEl.classList.remove('is-visible'), 2600);
  }

  // ---------------------------------------------------------------
  // Estados (loading / vazio / erro) — reutilizado por toda tela
  // ---------------------------------------------------------------
  function renderState(page, kind, message) {
    const el = $(`[data-state="${page}"]`);
    if (!el) return;
    if (!kind) { el.innerHTML = ''; el.hidden = true; return; }
    el.hidden = false;
    const labels = {
      loading: `<div class="gestao-state-box is-loading">Carregando…</div>`,
      empty: `<div class="gestao-state-box is-empty">${escapeHtml(message || 'Nada encontrado.')}</div>`,
      error: `<div class="gestao-state-box is-error">${escapeHtml(message || 'Não foi possível carregar. Tente novamente.')}</div>`,
    };
    el.innerHTML = labels[kind] || '';
  }

  // ---------------------------------------------------------------
  // Sessão / login
  // ---------------------------------------------------------------
  const loginView = $('[data-view="login"]');
  const appView = $('[data-view="app"]');
  const loginForm = $('[data-login-form]');
  const loginError = $('[data-login-error]');
  const sessionBanner = $('[data-session-banner]');

  function showLogin(message) {
    appView.hidden = true;
    loginView.hidden = false;
    if (message) {
      loginError.textContent = message;
      loginError.hidden = false;
    } else {
      loginError.hidden = true;
      loginError.textContent = '';
    }
  }

  function showApp() {
    loginView.hidden = true;
    appView.hidden = false;
  }

  async function handleSessionExpired(context) {
    await window.GestaoAuth.signOut();
    showLogin('Sessão expirada. Faça login novamente.');
    console.warn(`[Gestao] sessão expirada em ${context}`);
  }

  loginForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitBtn = $('[data-login-submit]');
    loginError.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Entrando…';

    const email = loginForm.email.value.trim();
    const password = loginForm.password.value;

    try {
      await window.GestaoAuth.signIn(email, password);
      // login válido no Supabase Auth não basta: confirma no backend
      // que este usuário está na allowlist store_admins.
      await window.GestaoApi.getDashboardSummary();
      loginForm.reset();
      showApp();
      startApp();
    } catch (err) {
      await window.GestaoAuth.signOut();
      const message = (err && err.status === 401)
        ? 'Usuário não autorizado a acessar este painel.'
        : 'E-mail ou senha inválidos.';
      loginError.textContent = message;
      loginError.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Entrar';
    }
  });

  function wireLogout() {
    const doLogout = async () => {
      await window.GestaoAuth.signOut();
      showLogin();
    };
    $('[data-logout]')?.addEventListener('click', doLogout);
    $('[data-logout-settings]')?.addEventListener('click', doLogout);
  }
  wireLogout();

  // ---------------------------------------------------------------
  // Sidebar mobile
  // ---------------------------------------------------------------
  const sidebar = $('[data-sidebar]');
  const sidebarOverlay = $('[data-sidebar-overlay]');
  $('[data-hamburger]')?.addEventListener('click', () => {
    sidebar.classList.add('is-open');
    sidebarOverlay.classList.add('is-open');
  });
  sidebarOverlay?.addEventListener('click', () => {
    sidebar.classList.remove('is-open');
    sidebarOverlay.classList.remove('is-open');
  });

  // ---------------------------------------------------------------
  // Roteamento por hash
  // ---------------------------------------------------------------
  const PAGE_TITLES = {
    dashboard: 'Visão geral', pedidos: 'Pedidos', produtos: 'Produtos',
    clientes: 'Clientes', integracao: 'Integração', configuracoes: 'Configurações',
  };
  const LOADERS = {
    dashboard: loadDashboard, pedidos: loadOrders, produtos: loadProducts,
    clientes: loadCustomers, integracao: loadIntegration, configuracoes: loadSettings,
  };

  function currentPage() {
    const hash = window.location.hash.replace(/^#\/?/, '');
    return PAGE_TITLES[hash] ? hash : 'dashboard';
  }

  function renderRoute() {
    const page = currentPage();
    $$('[data-page]').forEach((el) => { el.hidden = el.dataset.page !== page; });
    $$('[data-nav]').forEach((el) => el.classList.toggle('is-active', el.dataset.nav === page));
    $('[data-page-title]').textContent = PAGE_TITLES[page];
    sidebar.classList.remove('is-open');
    sidebarOverlay.classList.remove('is-open');
    const loader = LOADERS[page];
    if (loader) loader();
  }
  window.addEventListener('hashchange', renderRoute);

  // ---------------------------------------------------------------
  // DASHBOARD
  // ---------------------------------------------------------------
  async function loadDashboard() {
    renderState('dashboard', 'loading');
    $('[data-dashboard-stats]').hidden = true;
    $('[data-dashboard-extra]').hidden = true;
    try {
      const { summary } = await window.GestaoApi.getDashboardSummary();
      renderState('dashboard', null);

      const cards = [
        ['Pedidos novos', summary.newOrders],
        ['Pedidos hoje', summary.ordersToday],
        ['Vendas hoje', fmtMoney(summary.revenueToday)],
        ['Vendas no mês', fmtMoney(summary.revenueMonth)],
        ['Clientes', summary.customers],
      ];
      $('[data-dashboard-stats]').innerHTML = cards.map(([label, value]) => `
        <div class="gestao-stat-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
      `).join('');
      $('[data-dashboard-stats]').hidden = false;

      $('[data-stat="lowStockProducts"]').textContent = summary.lowStockProducts;
      $('[data-stat="outOfStockProducts"]').textContent = summary.outOfStockProducts;
      $('[data-stat="activeProducts"]').textContent = summary.activeProducts;
      $('[data-stat="pendingPayments"]').textContent = summary.pendingPayments;
      $('[data-stat="paidToday"]').textContent = summary.paidToday;
      $('[data-stat="blingSyncFailed"]').textContent = summary.blingSyncFailed;
      $('[data-stat="blingConnectedLabel"]').textContent = summary.blingConnected ? 'Conectado' : 'Não conectado';
      $('[data-stat="lastSyncAtLabel"]').textContent = fmtDate(summary.lastSyncAt);
      $('[data-stat="lastWebhookAtLabel"]').textContent = fmtDate(summary.lastWebhookAt);
      $('[data-dashboard-extra]').hidden = false;
    } catch (err) {
      if (err.status === 401) return handleSessionExpired('dashboard');
      renderState('dashboard', 'error', 'Não foi possível carregar o resumo agora.');
    }
  }

  // ---------------------------------------------------------------
  // PEDIDOS
  // ---------------------------------------------------------------
  let ordersOffset = 0;
  const ORDERS_PAGE_SIZE = 20;
  const STATUS_LABELS = { draft: 'Rascunho', pending: 'Novo', confirmed: 'Confirmado', paid: 'Pago', shipped: 'Enviado', delivered: 'Concluído', cancelled: 'Cancelado' };
  const SHIPPING_LABELS = { pickup: 'Retirada', delivery: 'Entrega' };
  const PAYMENT_LABELS = { pix: 'Pix', card_on_pickup: 'Cartão na retirada', whatsapp: 'WhatsApp' };
  const ORIGIN_LABELS = { site: 'Site', shopee: 'Shopee', mercado_livre: 'Mercado Livre', manual: 'Manual', bling_import: 'Bling', other: 'Outro' };
  const PAYMENT_STATUS_LABELS = { pending: 'Pendente', paid: 'Pago', failed: 'Atenção', cancelled: 'Cancelado' };
  const CAPTURE_METHOD_LABELS = { pix: 'Pix', credit_card: 'Cartão' };

  function originBadgeHTML(origin) {
    return `<span class="gestao-badge gestao-badge--origin-${escapeHtml(origin)}">${escapeHtml(ORIGIN_LABELS[origin] || origin)}</span>`;
  }
  function paymentStatusBadgeHTML(paymentStatus) {
    return `<span class="gestao-badge gestao-badge--pay-${escapeHtml(paymentStatus)}">${escapeHtml(PAYMENT_STATUS_LABELS[paymentStatus] || paymentStatus)}</span>`;
  }

  function orderRowHTML(o) {
    return `
      <tr data-order-row="${escapeHtml(o.id)}" tabindex="0">
        <td>${escapeHtml(o.orderNumber || o.id.slice(0, 8))}</td>
        <td>${fmtDate(o.createdAt)}</td>
        <td>${originBadgeHTML(o.origin)}</td>
        <td>${escapeHtml(o.customerName || '—')}</td>
        <td>${escapeHtml(o.customerPhone || '—')}</td>
        <td>${escapeHtml(o.itemCount)}</td>
        <td>${fmtMoney(o.total)}</td>
        <td>${escapeHtml(SHIPPING_LABELS[o.shippingMethod] || o.shippingMethod || '—')}</td>
        <td>${paymentStatusBadgeHTML(o.paymentStatus)}${o.paymentCaptureMethod ? ` <small>${escapeHtml(CAPTURE_METHOD_LABELS[o.paymentCaptureMethod] || o.paymentCaptureMethod)}</small>` : ''}</td>
        <td><span class="gestao-badge gestao-badge--${escapeHtml(o.status)}">${escapeHtml(STATUS_LABELS[o.status] || o.status)}</span></td>
      </tr>`;
  }

  async function loadOrders(resetOffset) {
    if (resetOffset !== false) ordersOffset = 0;
    renderState('pedidos', 'loading');
    $('[data-orders-table-wrap]').hidden = true;
    $('[data-orders-pagination]').hidden = true;
    try {
      const params = {
        status: $('[data-orders-status]').value || undefined,
        from: $('[data-orders-from]').value || undefined,
        to: $('[data-orders-to]').value || undefined,
        search: $('[data-orders-search]').value.trim() || undefined,
        limit: ORDERS_PAGE_SIZE,
        offset: ordersOffset,
      };
      const { items, total } = await window.GestaoApi.listOrders(params);
      if (items.length === 0) {
        renderState('pedidos', 'empty', 'Nenhum pedido encontrado com esses filtros.');
        return;
      }
      renderState('pedidos', null);
      $('[data-orders-tbody]').innerHTML = items.map(orderRowHTML).join('');
      $('[data-orders-table-wrap]').hidden = false;
      $$('[data-order-row]').forEach((row) => {
        row.addEventListener('click', () => openOrderDrawer(row.dataset.orderRow));
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter') openOrderDrawer(row.dataset.orderRow); });
      });
      const pageEl = $('[data-orders-pagination]');
      pageEl.hidden = false;
      pageEl.innerHTML = `
        <button type="button" class="btn btn-outline" data-orders-prev ${ordersOffset === 0 ? 'disabled' : ''}>‹ Anterior</button>
        <span>${ordersOffset + 1}–${ordersOffset + items.length} de ${total}</span>
        <button type="button" class="btn btn-outline" data-orders-next ${ordersOffset + items.length >= total ? 'disabled' : ''}>Próxima ›</button>`;
      $('[data-orders-prev]')?.addEventListener('click', () => { ordersOffset = Math.max(0, ordersOffset - ORDERS_PAGE_SIZE); loadOrders(false); });
      $('[data-orders-next]')?.addEventListener('click', () => { ordersOffset += ORDERS_PAGE_SIZE; loadOrders(false); });
    } catch (err) {
      if (err.status === 401) return handleSessionExpired('pedidos');
      renderState('pedidos', 'error', 'Não foi possível carregar os pedidos agora.');
    }
  }
  $('[data-orders-filter]')?.addEventListener('click', () => loadOrders(true));

  // Drawer de detalhe do pedido
  const orderDrawer = $('[data-order-drawer]');
  const orderDrawerOverlay = $('[data-order-drawer-overlay]');
  function closeOrderDrawer() {
    orderDrawer.hidden = true;
    orderDrawerOverlay.hidden = true;
  }
  $('[data-order-drawer-close]')?.addEventListener('click', closeOrderDrawer);
  orderDrawerOverlay?.addEventListener('click', closeOrderDrawer);

  async function openOrderDrawer(id) {
    orderDrawer.hidden = false;
    orderDrawerOverlay.hidden = false;
    $('[data-order-drawer-body]').innerHTML = '<div class="gestao-state-box is-loading">Carregando…</div>';
    try {
      const { order } = await window.GestaoApi.getOrder(id);
      const itemsHTML = order.items.map((it) => `
        <tr><td>${escapeHtml(it.name)}</td><td>${escapeHtml(it.sku || '—')}</td><td>${escapeHtml(it.quantity)}</td><td>${fmtMoney(it.unitPrice)}</td><td>${fmtMoney(it.total)}</td></tr>
      `).join('');
      const addr = order.shipping && order.shipping.address;
      $('[data-order-drawer-body]').innerHTML = `
        <dl class="gestao-detail-grid">
          <div><dt>Pedido</dt><dd>${escapeHtml(order.orderNumber || order.id)}</dd></div>
          <div><dt>Data</dt><dd>${fmtDate(order.createdAt)}</dd></div>
          <div><dt>Status</dt><dd><span class="gestao-badge gestao-badge--${escapeHtml(order.status)}">${escapeHtml(STATUS_LABELS[order.status] || order.status)}</span></dd></div>
          <div><dt>Cliente</dt><dd>${escapeHtml(order.customerName || '—')}</dd></div>
          <div><dt>Telefone</dt><dd>${escapeHtml(order.customerPhone || '—')}</dd></div>
          <div><dt>E-mail</dt><dd>${escapeHtml(order.customerEmail || '—')}</dd></div>
          <div><dt>Origem</dt><dd>${originBadgeHTML(order.origin)}${order.externalOrderId ? ` <small>(${escapeHtml(order.externalOrderId)})</small>` : ''}</dd></div>
          <div><dt>Entrega</dt><dd>${escapeHtml(SHIPPING_LABELS[order.shippingMethod] || order.shippingMethod || '—')}${addr ? ` — ${escapeHtml(addr.street || '')}, ${escapeHtml(addr.number || '')} (${escapeHtml(addr.city || '')}/${escapeHtml(addr.state || '')})` : ''}</dd></div>
          <div><dt>Preferência de pagamento</dt><dd>${escapeHtml(PAYMENT_LABELS[order.paymentMethod] || order.paymentMethod || '—')}</dd></div>
          <div><dt>Status do pagamento</dt><dd>${paymentStatusBadgeHTML(order.paymentStatus)}${order.paymentCaptureMethod ? ` <small>${escapeHtml(CAPTURE_METHOD_LABELS[order.paymentCaptureMethod] || order.paymentCaptureMethod)}${order.paymentInstallments > 1 ? ` em ${order.paymentInstallments}x` : ''}</small>` : ''}</dd></div>
          ${order.paymentPaidAt ? `<div><dt>Pago em</dt><dd>${fmtDate(order.paymentPaidAt)}</dd></div>` : ''}
          ${order.paymentReceiptUrl ? `<div><dt>Comprovante</dt><dd><a href="${escapeHtml(order.paymentReceiptUrl)}" target="_blank" rel="noopener noreferrer">Ver comprovante</a></dd></div>` : ''}
          ${order.paymentStatus === 'failed' ? `<div><dt>Pendência de pagamento</dt><dd class="gestao-text-danger">${escapeHtml(order.paymentFailureReason || 'motivo não especificado')}</dd></div>` : ''}
          <div><dt>Sincronização Bling</dt><dd>${order.blingSyncStatus === 'disabled' ? 'Desativada (nenhum pedido é criado no Bling ainda)' : escapeHtml(order.blingSyncStatus)}${order.blingId ? ` <small>(Bling #${escapeHtml(order.blingId)})</small>` : ''}</dd></div>
          ${order.blingSyncStatus === 'failed' ? `<div><dt>Erro de sincronização</dt><dd class="gestao-text-danger">${escapeHtml(order.blingSyncError || 'erro não especificado')} (${escapeHtml(order.blingSyncAttempts)} tentativa(s))</dd></div>` : ''}
        </dl>
        <h3>Itens</h3>
        <table class="gestao-table gestao-table--compact">
          <thead><tr><th>Produto</th><th>SKU</th><th>Qtd</th><th>Unitário</th><th>Total</th></tr></thead>
          <tbody>${itemsHTML}</tbody>
        </table>
        <dl class="gestao-detail-grid">
          <div><dt>Subtotal</dt><dd>${fmtMoney(order.subtotal)}</dd></div>
          <div><dt>Desconto</dt><dd>${fmtMoney(order.discount)}</dd></div>
          <div><dt>Frete</dt><dd>${fmtMoney(order.shippingCost)}</dd></div>
          <div><dt>Total</dt><dd><strong>${fmtMoney(order.total)}</strong></dd></div>
        </dl>
        ${order.notes ? `<p class="gestao-note"><strong>Observações:</strong> ${escapeHtml(order.notes)}</p>` : ''}
      `;
    } catch (err) {
      if (err.status === 401) { closeOrderDrawer(); return handleSessionExpired('detalhe do pedido'); }
      $('[data-order-drawer-body]').innerHTML = '<div class="gestao-state-box is-error">Não foi possível carregar este pedido.</div>';
    }
  }

  // ---------------------------------------------------------------
  // PRODUTOS
  // ---------------------------------------------------------------
  let productsOffset = 0;
  const PRODUCTS_PAGE_SIZE = 24;

  function productCardHTML(p) {
    const stockLabel = p.availableStock == null ? 'Sem info. de estoque'
      : p.availableStock <= 0 ? 'Esgotado'
      : `${p.availableStock} em estoque`;
    const stockClass = p.availableStock == null ? '' : p.availableStock <= 0 ? 'is-out' : p.availableStock <= 5 ? 'is-low' : '';
    const hasVariants = p.variants.length > 0;
    return `
      <div class="gestao-product-card" data-product-bling-id="${escapeHtml(p.blingId)}" data-product-has-variants="${hasVariants ? '1' : '0'}">
        <figure><img src="${escapeHtml(p.image || '../assets/products/placeholder.svg')}" alt="${escapeHtml(p.name)}" loading="lazy" onerror="this.onerror=null;this.src='../assets/products/placeholder.svg';"></figure>
        <div class="gestao-product-info">
          <p class="gestao-product-name">${escapeHtml(p.name)}</p>
          <p class="gestao-product-meta">SKU ${escapeHtml(p.sku || '—')} · ${escapeHtml(p.category || 'Sem categoria')}</p>
          <p class="gestao-product-price">${fmtMoney(p.promotionalPrice ?? p.price)}${p.promotionalPrice != null ? ` <s>${fmtMoney(p.price)}</s>` : ''}</p>
          <p class="gestao-stock-pill ${stockClass}">${escapeHtml(stockLabel)}</p>
          ${hasVariants ? `<p class="gestao-product-meta">${escapeHtml(p.variants.length)} variação(ões)</p>` : ''}
          <p class="gestao-product-meta">${p.active ? 'Ativo' : 'Inativo'} · atualizado ${fmtDate(p.updatedAt)}</p>
          <div class="gestao-product-actions">
            <button type="button" class="btn btn-outline" data-product-edit ${hasVariants ? 'disabled title="Produto com variação — edite direto no Bling"' : ''}>Editar</button>
            <button type="button" class="btn btn-outline" data-product-stock>Ajustar estoque</button>
            <button type="button" class="btn btn-outline" data-product-toggle-active>${p.active ? 'Desativar' : 'Ativar'}</button>
          </div>
        </div>
      </div>`;
  }

  function productDataset(card) {
    return { blingId: card.dataset.productBlingId, hasVariants: card.dataset.productHasVariants === '1' };
  }

  let productsByBlingId = new Map();

  async function loadProducts(resetOffset) {
    if (resetOffset !== false) productsOffset = 0;
    renderState('produtos', 'loading');
    $('[data-products-grid]').hidden = true;
    $('[data-products-pagination]').hidden = true;
    try {
      const params = {
        active: $('[data-products-active]').value || undefined,
        stock: $('[data-products-stock]').value || undefined,
        search: $('[data-products-search]').value.trim() || undefined,
        limit: PRODUCTS_PAGE_SIZE,
        offset: productsOffset,
      };
      const { items, total } = await window.GestaoApi.listProducts(params);
      productsByBlingId = new Map(items.map((p) => [p.blingId, p]));
      if (items.length === 0) {
        renderState('produtos', 'empty', 'Nenhum produto encontrado com esses filtros.');
        return;
      }
      renderState('produtos', null);
      $('[data-products-grid]').innerHTML = items.map(productCardHTML).join('');
      $('[data-products-grid]').hidden = false;
      $$('[data-product-edit]').forEach((btn) => btn.addEventListener('click', (e) => {
        const { blingId } = productDataset(e.target.closest('[data-product-bling-id]'));
        openProductDrawer('edit', productsByBlingId.get(blingId));
      }));
      $$('[data-product-stock]').forEach((btn) => btn.addEventListener('click', (e) => {
        const { blingId } = productDataset(e.target.closest('[data-product-bling-id]'));
        openStockDrawer(productsByBlingId.get(blingId));
      }));
      $$('[data-product-toggle-active]').forEach((btn) => btn.addEventListener('click', (e) => {
        const card = e.target.closest('[data-product-bling-id]');
        const { blingId } = productDataset(card);
        toggleProductActive(productsByBlingId.get(blingId), btn);
      }));
      const pageEl = $('[data-products-pagination]');
      pageEl.hidden = false;
      pageEl.innerHTML = `
        <button type="button" class="btn btn-outline" data-products-prev ${productsOffset === 0 ? 'disabled' : ''}>‹ Anterior</button>
        <span>${productsOffset + 1}–${productsOffset + items.length} de ${total}</span>
        <button type="button" class="btn btn-outline" data-products-next ${productsOffset + items.length >= total ? 'disabled' : ''}>Próxima ›</button>`;
      $('[data-products-prev]')?.addEventListener('click', () => { productsOffset = Math.max(0, productsOffset - PRODUCTS_PAGE_SIZE); loadProducts(false); });
      $('[data-products-next]')?.addEventListener('click', () => { productsOffset += PRODUCTS_PAGE_SIZE; loadProducts(false); });
    } catch (err) {
      if (err.status === 401) return handleSessionExpired('produtos');
      renderState('produtos', 'error', 'Não foi possível carregar os produtos agora.');
    }
  }
  $('[data-products-filter]')?.addEventListener('click', () => loadProducts(true));

  // ---------------------------------------------------------------
  // Drawer: criar/editar produto (Bling é a fonte de verdade — grava
  // no Bling primeiro, cache só reflete depois de o Bling confirmar)
  // ---------------------------------------------------------------
  const productDrawer = $('[data-product-drawer]');
  const productDrawerOverlay = $('[data-product-drawer-overlay]');
  const productForm = $('[data-product-form]');
  let editingBlingId = null;

  function closeProductDrawer() {
    productDrawer.hidden = true;
    productDrawerOverlay.hidden = true;
  }
  $$('[data-product-drawer-close]').forEach((el) => el.addEventListener('click', closeProductDrawer));
  productDrawerOverlay?.addEventListener('click', closeProductDrawer);

  function openProductDrawer(mode, product) {
    editingBlingId = mode === 'edit' ? product.blingId : null;
    $('[data-product-drawer-title]').textContent = mode === 'edit' ? 'Editar produto' : 'Novo produto';
    $('[data-product-form-error]').hidden = true;
    $('[data-product-form-variant-note]').hidden = !(mode === 'edit' && product.variants.length > 0);
    productForm.reset();
    if (mode === 'edit' && product) {
      productForm.nome.value = product.name || '';
      productForm.sku.value = product.sku || '';
      productForm.preco.value = product.promotionalPrice ?? product.price ?? 0;
      productForm.ativo.checked = product.active !== false;
      // categoriaId/marca/descricaoCurta não vêm da listagem administrativa
      // (só a categoria já RESOLVIDA por nome) — ficam em branco; o backend
      // preserva o valor atual no Bling quando o campo não é preenchido
      // (ver buildBlingProductUpdatePayload).
    }
    const submitBtn = $('[data-product-form-submit]');
    submitBtn.disabled = mode === 'edit' && product.variants.length > 0;
    productDrawer.hidden = false;
    productDrawerOverlay.hidden = false;
  }
  $('[data-product-new]')?.addEventListener('click', () => openProductDrawer('create', null));

  productForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('[data-product-form-error]');
    const submitBtn = $('[data-product-form-submit]');
    errEl.hidden = true;
    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = 'Salvando no Bling...';
    try {
      const fd = new FormData(productForm);
      const body = {
        nome: String(fd.get('nome') || '').trim(),
        sku: String(fd.get('sku') || '').trim() || undefined,
        preco: Number(fd.get('preco')),
        categoriaId: String(fd.get('categoriaId') || '').trim() || undefined,
        marca: String(fd.get('marca') || '').trim() || undefined,
        descricaoCurta: String(fd.get('descricaoCurta') || '').trim() || undefined,
        ativo: fd.get('ativo') === 'on',
      };
      if (editingBlingId) {
        await window.GestaoApi.updateProduct({ ...body, blingId: editingBlingId });
        showToast('Produto atualizado no Bling.');
      } else {
        await window.GestaoApi.createProduct(body);
        showToast('Produto criado no Bling.');
      }
      closeProductDrawer();
      loadProducts(false);
    } catch (err) {
      if (err.status === 401) { closeProductDrawer(); return handleSessionExpired('produtos'); }
      errEl.textContent = (err.payload && err.payload.errors && err.payload.errors.join(' ')) || err.message || 'Não foi possível salvar no Bling.';
      errEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });

  // ---------------------------------------------------------------
  // Drawer: ajustar estoque (lança movimento no Bling)
  // ---------------------------------------------------------------
  const stockDrawer = $('[data-stock-drawer]');
  const stockDrawerOverlay = $('[data-stock-drawer-overlay]');
  const stockForm = $('[data-stock-form]');
  let stockAdjustBlingId = null;
  let depositsCache = null;

  function closeStockDrawer() {
    stockDrawer.hidden = true;
    stockDrawerOverlay.hidden = true;
  }
  $$('[data-stock-drawer-close]').forEach((el) => el.addEventListener('click', closeStockDrawer));
  stockDrawerOverlay?.addEventListener('click', closeStockDrawer);

  async function openStockDrawer(product) {
    stockAdjustBlingId = product.blingId;
    $('[data-stock-drawer-product-name]').textContent = product.name;
    $('[data-stock-form-error]').hidden = true;
    stockForm.reset();
    stockDrawer.hidden = false;
    stockDrawerOverlay.hidden = false;

    const select = $('[data-stock-deposit-select]');
    select.innerHTML = '<option value="">Carregando depósitos…</option>';
    try {
      if (!depositsCache) {
        const { items } = await window.GestaoApi.listDeposits();
        depositsCache = items;
      }
      const ativos = depositsCache.filter((d) => d.ativo);
      if (ativos.length === 0) {
        select.innerHTML = '<option value="">Nenhum depósito ativo encontrado no Bling</option>';
        return;
      }
      select.innerHTML = ativos.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.descricao)}${d.padrao ? ' (padrão)' : ''}</option>`).join('');
    } catch (err) {
      if (err.status === 401) { closeStockDrawer(); return handleSessionExpired('produtos'); }
      select.innerHTML = '<option value="">Falha ao carregar depósitos</option>';
    }
  }

  stockForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('[data-stock-form-error]');
    const submitBtn = $('[data-stock-form-submit]');
    errEl.hidden = true;
    submitBtn.disabled = true;
    const originalLabel = submitBtn.textContent;
    submitBtn.textContent = 'Enviando ao Bling...';
    try {
      const fd = new FormData(stockForm);
      await window.GestaoApi.adjustStock({
        blingProductId: stockAdjustBlingId,
        depositoId: String(fd.get('depositoId') || ''),
        operacao: String(fd.get('operacao') || ''),
        quantidade: Number(fd.get('quantidade')),
        observacoes: String(fd.get('observacoes') || '').trim() || undefined,
      });
      showToast('Estoque ajustado no Bling.');
      closeStockDrawer();
      loadProducts(false);
    } catch (err) {
      if (err.status === 401) { closeStockDrawer(); return handleSessionExpired('produtos'); }
      errEl.textContent = (err.payload && err.payload.errors && err.payload.errors.join(' ')) || err.message || 'Não foi possível ajustar o estoque no Bling.';
      errEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalLabel;
    }
  });

  // ---------------------------------------------------------------
  // Ativar / desativar (PATCH /produtos/{id}/situacoes — seguro para
  // qualquer produto, mesmo com variação)
  // ---------------------------------------------------------------
  async function toggleProductActive(product, btn) {
    const next = !product.active;
    const label = next ? 'ativar' : 'desativar';
    if (!window.confirm(`Confirma ${label} "${product.name}" no Bling?`)) return;
    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = 'Enviando...';
    try {
      await window.GestaoApi.changeProductSituation({ blingId: product.blingId, ativo: next });
      showToast(`Produto ${next ? 'ativado' : 'desativado'} no Bling.`);
      loadProducts(false);
    } catch (err) {
      if (err.status === 401) return handleSessionExpired('produtos');
      showToast(err.message || 'Não foi possível alterar a situação no Bling.');
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  // ---------------------------------------------------------------
  // CLIENTES
  // ---------------------------------------------------------------
  function customerRowHTML(c) {
    return `
      <tr>
        <td>${escapeHtml(c.name || '—')}</td>
        <td>${escapeHtml(c.phone || '—')}</td>
        <td>${escapeHtml(c.email || '—')}</td>
        <td>${escapeHtml(c.orderCount)}</td>
        <td>${fmtMoney(c.totalSpent)}</td>
        <td>${fmtDate(c.lastOrderAt)}</td>
      </tr>`;
  }

  async function loadCustomers() {
    renderState('clientes', 'loading');
    $('[data-customers-table-wrap]').hidden = true;
    try {
      const search = $('[data-customers-search]').value.trim() || undefined;
      const { items } = await window.GestaoApi.listCustomers({ search, limit: 100 });
      if (items.length === 0) {
        renderState('clientes', 'empty', 'Nenhum cliente encontrado ainda — clientes aparecem aqui a partir dos pedidos.');
        return;
      }
      renderState('clientes', null);
      $('[data-customers-tbody]').innerHTML = items.map(customerRowHTML).join('');
      $('[data-customers-table-wrap]').hidden = false;
    } catch (err) {
      if (err.status === 401) return handleSessionExpired('clientes');
      renderState('clientes', 'error', 'Não foi possível carregar os clientes agora.');
    }
  }
  $('[data-customers-filter]')?.addEventListener('click', loadCustomers);

  // ---------------------------------------------------------------
  // INTEGRAÇÃO
  // ---------------------------------------------------------------
  async function loadIntegration() {
    renderState('integracao', 'loading');
    $('[data-integration-card]').hidden = true;
    try {
      const status = await window.GestaoApi.getIntegrationStatus();
      renderState('integracao', null);
      $('[data-int="connected"]').innerHTML = status.connected
        ? '<span class="gestao-badge gestao-badge--delivered">Conectado</span>'
        : '<span class="gestao-badge gestao-badge--cancelled">Desconectado</span>';
      $('[data-int="lastSyncAt"]').textContent = fmtDate(status.lastSyncAt);
      $('[data-int="lastWebhookAt"]').textContent = fmtDate(status.lastWebhookAt);
      $('[data-int="failedWebhookEvents"]').textContent = status.failedWebhookEvents;
      $('[data-int="cachedProducts"]').textContent = `${status.activeProducts} ativos / ${status.cachedProducts} no total`;
      $('[data-int="orderSyncEnabled"]').textContent = status.orderSyncEnabled ? 'Ativada' : 'Desativada (padrão de segurança)';
      $('[data-integration-card]').hidden = false;
    } catch (err) {
      if (err.status === 401) return handleSessionExpired('integração');
      renderState('integracao', 'error', 'Não foi possível carregar o status da integração agora.');
    }
  }

  // ---------------------------------------------------------------
  // CONFIGURAÇÕES
  // ---------------------------------------------------------------
  async function loadSettings() {
    const session = await window.GestaoAuth.getSession();
    const email = session?.user?.email || '—';
    $('[data-settings-email]').textContent = email;
  }

  // ---------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------
  async function updateUserBadge() {
    const session = await window.GestaoAuth.getSession();
    $('[data-current-user-email]').textContent = session?.user?.email || '—';
  }

  function startApp() {
    updateUserBadge();
    if (!window.location.hash) window.location.hash = '#/dashboard';
    renderRoute();
  }

  async function boot() {
    if (!window.GestaoAuth.isConfigured()) {
      showLogin('Painel não configurado neste ambiente (js/config.js).');
      $('[data-login-submit]').disabled = true;
      return;
    }

    window.GestaoAuth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') showLogin();
    });

    const session = await window.GestaoAuth.getSession();
    if (!session) {
      showLogin();
      return;
    }
    // sessão existente (reload) — confirma de novo contra store_admins
    try {
      await window.GestaoApi.getDashboardSummary();
      showApp();
      startApp();
    } catch (err) {
      await window.GestaoAuth.signOut();
      showLogin(err && err.status === 401 ? 'Sessão expirada. Faça login novamente.' : 'Não foi possível validar sua sessão.');
    }
  }

  boot();
})();
