/**
 * ANAROSA — interações da home.
 * Sem framework: DOM puro. Todo produto/categoria/post do Instagram é
 * renderizado a partir de js/products.js (nada de dado solto no HTML).
 */
(function () {
  const {
    CATEGORIES,
    HERO_SLIDES,
    HERO_CTA_PRIMARY,
    HERO_CTA_SECONDARY,
    HERO_PERKS,
    INSTAGRAM_POSTS,
    formatPrice,
  } = window.AnarosaData;

  /* -----------------------------------------------------------
     Catálogo — via CatalogService (mock hoje, Supabase/Bling depois).
     A origem dos produtos é decidida em js/config.js (catalogProvider).
     ----------------------------------------------------------- */
  const catalog = window.AnarosaCatalog.createCatalogService(window.ANAROSA_CONFIG);
  let PRODUCTS = [];

  const ICONS = {
    crown:
      '<svg class="icon" viewBox="0 0 24 24"><path d="M3 8l4 3 5-6 5 6 4-3-2 11H5L3 8z"/><path d="M5 19h14"/></svg>',
    plus: '<svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
    tag: '<svg class="icon" viewBox="0 0 24 24"><path d="M20 12l-8 8-9-9V4h7z"/><circle cx="8.5" cy="8.5" r="1.4"/></svg>',
    card: '<svg class="icon" viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/></svg>',
    truck:
      '<svg class="icon" viewBox="0 0 24 24"><path d="M2 7h12v9H2z"/><path d="M14 11h4l4 3v2h-8z"/><circle cx="6.5" cy="18" r="1.7"/><circle cx="18" cy="18" r="1.7"/></svg>',
    phone:
      '<svg class="icon" viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.3 1.2.4 2.5.6 3.8.6.6 0 1.1.5 1.1 1.1v3.6c0 .6-.5 1.1-1.1 1.1C10.6 21.3 2.7 13.4 2.7 3.7c0-.6.5-1.1 1.1-1.1H7.4c.6 0 1.1.5 1.1 1.1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.3 1.1L6.6 10.8z"/></svg>',
  };

  const BADGE_LABELS = {
    novo: 'Novo',
    'mais-vendido': 'Mais vendido',
    oferta: 'Oferta',
  };

  /* -----------------------------------------------------------
     WhatsApp
     ----------------------------------------------------------- */
  const WHATSAPP_NUMBER = '554730911041';
  const WHATSAPP_TEXT = encodeURIComponent(
    'Olá! Vim do site da Anarosa e gostaria de mais informações.'
  );
  const WHATSAPP_LINK = `https://wa.me/${WHATSAPP_NUMBER}?text=${WHATSAPP_TEXT}`;

  document.querySelectorAll('[data-whatsapp-link]').forEach((el) => {
    el.setAttribute('href', WHATSAPP_LINK);
  });

  /* -----------------------------------------------------------
     Toast
     ----------------------------------------------------------- */
  const toastEl = document.querySelector('[data-toast]');
  let toastTimer = null;

  function showToast(message) {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-visible'), 2600);
  }

  /* -----------------------------------------------------------
     Carrinho — CartService real (linhas com produto/variação/
     quantidade, persistido em localStorage). O preço aqui é só para
     exibição: o checkout revalida preço/estoque no backend antes de
     confirmar qualquer pedido.
     ----------------------------------------------------------- */
  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  const placeholderImage = (window.ANAROSA_CONFIG && window.ANAROSA_CONFIG.placeholderImage) || '';
  const cart = window.AnarosaCart.createCartService();
  const cartBadge = document.querySelector('[data-cart-badge]');
  const cartOverlay = document.querySelector('[data-cart-overlay]');
  const cartDrawer = document.querySelector('[data-cart-drawer]');
  const cartItemsEl = document.querySelector('[data-cart-items]');
  const cartSubtotalEl = document.querySelector('[data-cart-subtotal]');
  const variantModalOverlay = document.querySelector('[data-variant-modal-overlay]');

  function updateCartBadge() {
    if (cartBadge) cartBadge.textContent = String(cart.getCount());
  }

  function cartItemHTML(item) {
    const attrs = [item.size, item.color].filter(Boolean).join(' · ');
    return `
      <div class="cart-item" data-cart-item="${item.key}">
        <img src="${escapeHtml(item.image || placeholderImage)}" alt="${escapeHtml(item.name)}" loading="lazy" onerror="this.onerror=null;this.src='${escapeHtml(placeholderImage)}';">
        <div>
          <p class="cart-item-name">${escapeHtml(item.name)}</p>
          ${attrs ? `<p class="cart-item-attrs">${escapeHtml(attrs)}</p>` : ''}
          <div class="cart-qty">
            <button type="button" data-cart-decrement="${item.key}" aria-label="Diminuir quantidade">−</button>
            <span>${item.quantity}</span>
            <button type="button" data-cart-increment="${item.key}" aria-label="Aumentar quantidade">+</button>
          </div>
          <button type="button" class="cart-item-remove" data-cart-remove="${item.key}">Remover</button>
        </div>
        <p class="cart-item-price">${formatPrice(item.unitPrice * item.quantity)}</p>
      </div>`;
  }

  function bindCartItemActions() {
    if (!cartItemsEl) return;
    cartItemsEl.querySelectorAll('[data-cart-increment]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = cart.getItems().find((i) => i.key === btn.dataset.cartIncrement);
        if (!item) return;
        const result = cart.updateQuantity(item.key, item.quantity + 1);
        if (result.clamped) showToast(`Estoque disponível: ${result.maxQuantity} unidade(s).`);
      });
    });
    cartItemsEl.querySelectorAll('[data-cart-decrement]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = cart.getItems().find((i) => i.key === btn.dataset.cartDecrement);
        if (item) cart.updateQuantity(item.key, item.quantity - 1);
      });
    });
    cartItemsEl.querySelectorAll('[data-cart-remove]').forEach((btn) => {
      btn.addEventListener('click', () => cart.removeItem(btn.dataset.cartRemove));
    });
  }

  function renderCartDrawer() {
    const items = cart.getItems();
    if (cartItemsEl) {
      cartItemsEl.innerHTML = items.length
        ? items.map(cartItemHTML).join('')
        : '<p class="cart-empty">Seu carrinho está vazio.</p>';
      bindCartItemActions();
    }
    if (cartSubtotalEl) cartSubtotalEl.textContent = formatPrice(cart.getSubtotal());
    updateCartBadge();
  }

  cart.onChange(renderCartDrawer);
  renderCartDrawer();

  function pulseCartBadge() {
    const wrapper = cartBadge ? cartBadge.closest('.icon-btn') : null;
    if (!wrapper) return;
    wrapper.classList.remove('pulse');
    void wrapper.offsetWidth; // reinicia a animação
    wrapper.classList.add('pulse');
  }

  function addProductToCart(product, variant, quantity) {
    const result = cart.addItem(product, variant, quantity || 1);
    const name = variant && variant.name ? `${product.name} — ${variant.name}` : product.name;
    showToast(result.clamped
      ? `"${name}" adicionado — estoque disponível: ${result.maxQuantity} unidade(s).`
      : `"${name}" adicionado ao carrinho`);
    pulseCartBadge();
  }

  function openCartDrawer() {
    renderCartDrawer();
    cartDrawer?.classList.add('is-open');
    cartOverlay?.classList.add('is-open');
    document.body.classList.add('no-scroll');
  }

  function closeCartDrawer() {
    cartDrawer?.classList.remove('is-open');
    cartOverlay?.classList.remove('is-open');
    document.body.classList.remove('no-scroll');
  }

  document.querySelector('[data-cart-toggle]')?.addEventListener('click', openCartDrawer);
  document.querySelector('[data-cart-close]')?.addEventListener('click', closeCartDrawer);
  cartOverlay?.addEventListener('click', closeCartDrawer);

  document.querySelector('[data-account-toggle]')?.addEventListener('click', () => {
    showToast('Área da conta em breve.');
  });

  /* -----------------------------------------------------------
     Seletor de variação — abre quando o produto tem variantes
     reais (cor/tamanho) vindas do catálogo; nunca inventa opção.
     ----------------------------------------------------------- */
  function variantOptionHTML(variant) {
    const soldOut = variant.available === false || (variant.stock != null && variant.stock <= 0);
    const label = [variant.size, variant.color].filter(Boolean).join(' / ') || variant.name || 'Opção';
    const price = variant.promotionalPrice != null ? variant.promotionalPrice : variant.price;
    return `
      <button type="button" class="variant-option" data-variant-option="${variant.id}" ${soldOut ? 'disabled' : ''}>
        <span>${escapeHtml(label)}</span>
        <span class="variant-option-stock">${soldOut ? 'Esgotado' : (price != null ? formatPrice(price) : '')}</span>
      </button>`;
  }

  function closeVariantModal() {
    if (!variantModalOverlay) return;
    variantModalOverlay.hidden = true;
    variantModalOverlay.innerHTML = '';
  }

  function openVariantModal(product) {
    if (!variantModalOverlay) return;
    const variants = (product.variants && product.variants.items) || [];
    variantModalOverlay.innerHTML = `
      <div class="variant-modal" role="dialog" aria-modal="true" aria-label="Escolher variação de ${escapeHtml(product.name)}">
        <h3>${escapeHtml(product.name)}</h3>
        <p class="variant-modal-sub">Escolha a variação:</p>
        <div class="variant-option-list">${variants.map(variantOptionHTML).join('')}</div>
        <button type="button" class="btn btn-outline variant-modal-close" data-variant-modal-close>Cancelar</button>
      </div>`;
    variantModalOverlay.hidden = false;
    variantModalOverlay.querySelectorAll('[data-variant-option]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const variant = variants.find((v) => String(v.id) === btn.dataset.variantOption);
        if (variant) {
          addProductToCart(product, variant, 1);
          closeVariantModal();
        }
      });
    });
    variantModalOverlay.querySelector('[data-variant-modal-close]')?.addEventListener('click', closeVariantModal);
  }

  variantModalOverlay?.addEventListener('click', (event) => {
    if (event.target === variantModalOverlay) closeVariantModal();
  });

  /* -----------------------------------------------------------
     Produtos — cards
     ----------------------------------------------------------- */
  function productCardHTML(product) {
    const badgeLabel = BADGE_LABELS[product.badge];
    const onSale = product.promotionalPrice != null;
    const priceHTML = onSale
      ? `<span class="price-old">${formatPrice(product.price)}</span><span class="price-now">${formatPrice(product.promotionalPrice)}</span><span class="price-off">-${Math.round((1 - product.promotionalPrice / product.price) * 100)}%</span>`
      : `<span class="price-now">${formatPrice(product.price)}</span>`;

    // Em modo real, `available === false` vem do estoque do Bling.
    // No mock, `available` é undefined → produto tratado como disponível.
    const soldOut = product.available === false;

    const safeName = escapeHtml(product.name);
    const safeImage = escapeHtml(product.image || placeholderImage);

    return `
      <div class="product-card${soldOut ? ' is-soldout' : ''}" data-product-id="${escapeHtml(product.id)}">
        <figure>
          ${badgeLabel ? `<span class="product-badge badge-${product.badge}">${badgeLabel}</span>` : ''}
          ${soldOut ? '<span class="product-badge badge-esgotado">Esgotado</span>' : ''}
          <img src="${safeImage}" alt="${safeName}" loading="lazy" width="600" height="750" onerror="this.onerror=null;this.src='${escapeHtml(placeholderImage)}';">
          ${soldOut ? '' : `<button type="button" class="quick-add" data-add-to-cart="${escapeHtml(product.id)}" aria-label="Adicionar ${safeName} ao carrinho">
            ${ICONS.plus}
          </button>`}
        </figure>
        <div class="product-info">
          <p class="product-name">${safeName}</p>
          <p class="product-price">${priceHTML}</p>
          <p class="product-installment">${escapeHtml(product.installment)}</p>
          <p class="product-pix">5% OFF no Pix: <strong>${formatPrice(product.pixPrice)}</strong></p>
        </div>
      </div>`;
  }

  function bindQuickAdd(container) {
    if (!container) return;
    container.querySelectorAll('[data-add-to-cart]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        // ids são numéricos no mock e UUID no modo real → comparar como string
        const id = String(btn.dataset.addToCart);
        const product = PRODUCTS.find((p) => String(p.id) === id);
        if (!product || product.available === false) return;
        const variantItems = (product.variants && product.variants.items) || [];
        if (variantItems.length > 0) {
          openVariantModal(product);
        } else {
          addProductToCart(product, null, 1);
        }
      });
    });
  }

  function renderProducts(products, scrollerEl, gridEl, emptyMessage) {
    const html = products.length
      ? products.map(productCardHTML).join('')
      : `<p class="empty-state">${emptyMessage || 'Nenhum produto encontrado.'}</p>`;
    if (scrollerEl) {
      scrollerEl.innerHTML = html;
      bindQuickAdd(scrollerEl);
    }
    if (gridEl) {
      gridEl.innerHTML = html;
      bindQuickAdd(gridEl);
    }
  }

  let featuredProducts = [];
  let bestSellerProducts = [];
  let weeklyPickProducts = [];

  const novidadesScroller = document.querySelector('[data-novidades-scroller]');
  const novidadesGrid = document.querySelector('[data-novidades-grid]');
  const novidadesTitle = document.querySelector('[data-novidades-title]');
  const novidadesLink = document.querySelector('[data-novidades-link]');
  const defaultNovidadesTitle = novidadesTitle ? novidadesTitle.textContent : 'Novidades';
  const defaultNovidadesLinkHTML = novidadesLink ? novidadesLink.innerHTML : '';

  const bestScroller = document.querySelector('[data-best-scroller]');
  const bestGrid = document.querySelector('[data-best-grid]');

  const weeklyScroller = document.querySelector('[data-weekly-scroller]');
  const weeklyGrid = document.querySelector('[data-weekly-grid]');

  const CATALOG_ERROR_MESSAGE =
    'Não conseguimos carregar os produtos agora. Tente novamente em instantes ou fale conosco no WhatsApp.';
  const CATALOG_LOADING_MESSAGE = 'Carregando produtos…';

  function renderCatalogLoading() {
    renderProducts([], novidadesScroller, novidadesGrid, CATALOG_LOADING_MESSAGE);
    renderProducts([], bestScroller, bestGrid, CATALOG_LOADING_MESSAGE);
    renderProducts([], weeklyScroller, weeklyGrid, CATALOG_LOADING_MESSAGE);
  }

  function renderCatalogError() {
    // Modo real indisponível: mostra estado amigável. NUNCA cai no mock
    // (um produto fictício jamais aparece como se fosse real).
    renderProducts([], novidadesScroller, novidadesGrid, CATALOG_ERROR_MESSAGE);
    renderProducts([], bestScroller, bestGrid, CATALOG_ERROR_MESSAGE);
    renderProducts([], weeklyScroller, weeklyGrid, CATALOG_ERROR_MESSAGE);
  }

  function renderHomeSections() {
    renderProducts(featuredProducts, novidadesScroller, novidadesGrid);
    renderProducts(bestSellerProducts, bestScroller, bestGrid);
    renderProducts(weeklyPickProducts, weeklyScroller, weeklyGrid);
  }

  async function initCatalog() {
    renderCatalogLoading();
    try {
      PRODUCTS = await catalog.getProducts();
      const sections = catalog.getHomeSections(PRODUCTS);
      featuredProducts = sections.featured;
      bestSellerProducts = sections.bestSellers;
      weeklyPickProducts = sections.weeklyPicks;
      renderHomeSections();
    } catch (err) {
      console.error('[Anarosa] catálogo indisponível:', err);
      renderCatalogError();
    }
  }

  initCatalog();

  function resetNovidades() {
    renderProducts(featuredProducts, novidadesScroller, novidadesGrid);
    if (novidadesTitle) novidadesTitle.textContent = defaultNovidadesTitle;
    if (novidadesLink) {
      novidadesLink.innerHTML = defaultNovidadesLinkHTML;
      novidadesLink.setAttribute('href', '#novidades');
      novidadesLink.onclick = null;
    }
  }

  async function runSearch(rawQuery) {
    const query = rawQuery.trim();
    if (!query) return;

    let results = [];
    try {
      results = await catalog.searchProducts(query);
    } catch (err) {
      console.error('[Anarosa] busca indisponível:', err);
      renderProducts([], novidadesScroller, novidadesGrid, CATALOG_ERROR_MESSAGE);
      closeSearch();
      return;
    }

    // garante que o carrinho encontre os itens retornados pela busca
    for (const p of results) {
      if (!PRODUCTS.some((existing) => String(existing.id) === String(p.id))) PRODUCTS.push(p);
    }

    renderProducts(
      results,
      novidadesScroller,
      novidadesGrid,
      `Nenhum produto encontrado para "${query}".`
    );

    if (novidadesTitle) novidadesTitle.textContent = `Resultados para "${query}"`;
    if (novidadesLink) {
      novidadesLink.textContent = 'Limpar busca ×';
      novidadesLink.setAttribute('href', '#novidades');
      novidadesLink.onclick = (event) => {
        event.preventDefault();
        resetNovidades();
      };
    }

    document.getElementById('novidades')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    closeSearch();
  }

  /* -----------------------------------------------------------
     Categorias
     ----------------------------------------------------------- */
  function categoryCardHTML(cat) {
    return `
      <a class="category-card" href="#novidades" data-category="${cat.slug}">
        <figure><img src="${cat.image}" alt="Categoria ${cat.name}" loading="lazy" width="480" height="600"></figure>
        <div class="category-label">${ICONS.crown}<span>${cat.name}</span><span class="category-arrow" aria-hidden="true">→</span></div>
      </a>`;
  }

  function categoryCircleHTML(cat) {
    return `
      <a class="category-circle" href="#novidades" data-category="${cat.slug}">
        <span class="avatar"><img src="${cat.image}" alt="Categoria ${cat.name}" loading="lazy" width="120" height="120"></span>
        <span>${cat.name}</span>
      </a>`;
  }

  const categoriesDesktopEl = document.querySelector('[data-categories-desktop]');
  const categoriesMobileEl = document.querySelector('[data-categories-mobile]');
  if (categoriesDesktopEl) categoriesDesktopEl.innerHTML = CATEGORIES.map(categoryCardHTML).join('');
  if (categoriesMobileEl) categoriesMobileEl.innerHTML = CATEGORIES.map(categoryCircleHTML).join('');

  /* -----------------------------------------------------------
     Instagram
     ----------------------------------------------------------- */
  function instagramItemHTML(post) {
    return `
      <a class="instagram-item" href="${post.href}" target="_blank" rel="noopener noreferrer">
        <img src="${post.image}" alt="Publicação do Instagram @anarosatextil" loading="lazy" width="500" height="500">
      </a>`;
  }

  const instagramGridEl = document.querySelector('[data-instagram-grid]');
  const instagramScrollerEl = document.querySelector('[data-instagram-scroller]');
  if (instagramGridEl) instagramGridEl.innerHTML = INSTAGRAM_POSTS.map(instagramItemHTML).join('');
  if (instagramScrollerEl) instagramScrollerEl.innerHTML = INSTAGRAM_POSTS.map(instagramItemHTML).join('');

  /* -----------------------------------------------------------
     Hero slider
     ----------------------------------------------------------- */
  const heroTrack = document.querySelector('[data-hero-track]');
  const heroDots = document.querySelector('[data-hero-dots]');
  const heroSlider = document.querySelector('[data-hero-slider]');
  let heroIndex = 0;
  let heroTimer = null;

  function heroSlideHTML(slide, index) {
    const titleHTML = slide.title.split('\n').join('<br>');
    const perksHTML = HERO_PERKS.map(
      (perk) => `<span class="hero-perk">${ICONS[perk.icon]}${perk.label}</span>`
    ).join('');

    return `
      <div class="hero-slide" role="group" aria-roledescription="slide" aria-label="${index + 1} de ${HERO_SLIDES.length}">
        <div class="hero-media">
          <img src="${slide.image}" alt="" loading="${index === 0 ? 'eager' : 'lazy'}" width="1000" height="1250">
        </div>
        <div class="hero-content">
          <h1 class="hero-title">${titleHTML}</h1>
          <p class="hero-desc">${slide.description}</p>
          <div class="hero-actions">
            <a href="${HERO_CTA_PRIMARY.href}" class="btn btn-primary">${HERO_CTA_PRIMARY.label}</a>
            <a href="${HERO_CTA_SECONDARY.href}" class="btn btn-outline">${HERO_CTA_SECONDARY.label}</a>
          </div>
          <div class="hero-perks">${perksHTML}</div>
        </div>
      </div>`;
  }

  function renderHero() {
    if (!heroTrack || !heroDots) return;
    heroTrack.innerHTML = HERO_SLIDES.map(heroSlideHTML).join('');
    heroDots.innerHTML = HERO_SLIDES.map(
      (_, i) =>
        `<button type="button" data-hero-dot="${i}" class="${i === 0 ? 'is-active' : ''}" aria-label="Ir para o slide ${i + 1}"></button>`
    ).join('');
    heroDots.querySelectorAll('[data-hero-dot]').forEach((btn) => {
      btn.addEventListener('click', () => goToSlide(Number(btn.dataset.heroDot)));
    });
  }

  function goToSlide(index) {
    if (!heroTrack || !heroDots) return;
    heroIndex = (index + HERO_SLIDES.length) % HERO_SLIDES.length;
    heroTrack.style.transform = `translateX(-${heroIndex * 100}%)`;
    heroDots.querySelectorAll('[data-hero-dot]').forEach((btn, i) => {
      btn.classList.toggle('is-active', i === heroIndex);
    });
  }

  function startHeroAutoplay() {
    stopHeroAutoplay();
    heroTimer = setInterval(() => goToSlide(heroIndex + 1), 6000);
  }

  function stopHeroAutoplay() {
    if (heroTimer) clearInterval(heroTimer);
  }

  renderHero();
  if (HERO_SLIDES.length > 1) {
    startHeroAutoplay();
    heroSlider?.addEventListener('mouseenter', stopHeroAutoplay);
    heroSlider?.addEventListener('mouseleave', startHeroAutoplay);
    heroSlider?.addEventListener('focusin', stopHeroAutoplay);
    heroSlider?.addEventListener('focusout', startHeroAutoplay);
  }

  /* -----------------------------------------------------------
     Menu mobile (drawer)
     ----------------------------------------------------------- */
  const hamburgerBtn = document.querySelector('[data-hamburger]');
  const drawer = document.querySelector('[data-drawer]');
  const drawerOverlay = document.querySelector('[data-drawer-overlay]');
  const drawerCloseBtn = document.querySelector('[data-drawer-close]');

  function openDrawer() {
    drawer?.classList.add('is-open');
    drawerOverlay?.classList.add('is-open');
    document.body.classList.add('no-scroll');
    hamburgerBtn?.setAttribute('aria-expanded', 'true');
  }

  function closeDrawer() {
    drawer?.classList.remove('is-open');
    drawerOverlay?.classList.remove('is-open');
    document.body.classList.remove('no-scroll');
    hamburgerBtn?.setAttribute('aria-expanded', 'false');
  }

  hamburgerBtn?.addEventListener('click', openDrawer);
  drawerCloseBtn?.addEventListener('click', closeDrawer);
  drawerOverlay?.addEventListener('click', closeDrawer);
  document.querySelectorAll('[data-drawer] a').forEach((a) => a.addEventListener('click', closeDrawer));

  /* -----------------------------------------------------------
     Busca
     ----------------------------------------------------------- */
  const searchBarEl = document.querySelector('[data-search-bar]');
  const searchInput = document.querySelector('[data-search-input]');
  const searchForm = document.querySelector('[data-search-form]');

  function openSearch() {
    searchBarEl?.classList.add('is-open');
    window.setTimeout(() => searchInput?.focus(), 60);
  }

  function closeSearch() {
    searchBarEl?.classList.remove('is-open');
  }

  function toggleSearch() {
    if (searchBarEl?.classList.contains('is-open')) {
      closeSearch();
    } else {
      openSearch();
    }
  }

  document.querySelectorAll('[data-search-toggle]').forEach((btn) => {
    btn.addEventListener('click', toggleSearch);
  });
  document.querySelector('[data-search-close]')?.addEventListener('click', closeSearch);

  searchForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (searchInput && searchInput.value.trim()) {
      runSearch(searchInput.value);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeDrawer();
      closeSearch();
    }
  });

  /* -----------------------------------------------------------
     Newsletter (mock local — sem backend)
     ----------------------------------------------------------- */
  const newsletterForm = document.querySelector('[data-newsletter-form]');
  const newsletterMsg = document.querySelector('[data-newsletter-msg]');

  newsletterForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const emailInput = newsletterForm.querySelector('input[type="email"]');
    if (!emailInput || !emailInput.value) return;
    if (newsletterMsg) newsletterMsg.textContent = 'Cadastro recebido! Em breve novidades no seu e-mail.';
    newsletterForm.reset();
  });

  /* -----------------------------------------------------------
     Ano do rodapé
     ----------------------------------------------------------- */
  const yearEl = document.querySelector('[data-current-year]');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());
})();
