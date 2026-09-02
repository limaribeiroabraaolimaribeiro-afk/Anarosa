/**
 * ANAROSA — interações da home.
 * Sem framework: DOM puro. Todo produto/categoria/post do Instagram é
 * renderizado a partir de js/products.js (nada de dado solto no HTML).
 */
(function () {
  const { PRODUCTS, CATEGORIES, HERO_SLIDES, INSTAGRAM_POSTS, formatPrice } = window.AnarosaData;

  const ICONS = {
    crown:
      '<svg class="icon" viewBox="0 0 24 24"><path d="M3 8l4 3 5-6 5 6 4-3-2 11H5L3 8z"/><path d="M5 19h14"/></svg>',
    plus: '<svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
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
     Carrinho (contador local, sem checkout)
     ----------------------------------------------------------- */
  const CART_KEY = 'anarosa_cart_count';
  const cartBadge = document.querySelector('[data-cart-badge]');
  let cartCount = Number(localStorage.getItem(CART_KEY) || 0) || 0;

  function updateCartBadge() {
    if (cartBadge) cartBadge.textContent = String(cartCount);
  }
  updateCartBadge();

  function addToCart(product) {
    cartCount += 1;
    localStorage.setItem(CART_KEY, String(cartCount));
    updateCartBadge();
    showToast(`"${product.name}" adicionado ao carrinho`);

    const wrapper = cartBadge ? cartBadge.closest('.icon-btn') : null;
    if (wrapper) {
      wrapper.classList.remove('pulse');
      void wrapper.offsetWidth; // reinicia a animação
      wrapper.classList.add('pulse');
    }
  }

  document.querySelector('[data-cart-toggle]')?.addEventListener('click', () => {
    showToast(
      cartCount > 0
        ? `Você tem ${cartCount} ${cartCount === 1 ? 'item' : 'itens'} no carrinho.`
        : 'Seu carrinho está vazio.'
    );
  });

  document.querySelector('[data-account-toggle]')?.addEventListener('click', () => {
    showToast('Área da conta em breve.');
  });

  /* -----------------------------------------------------------
     Produtos — cards
     ----------------------------------------------------------- */
  function productCardHTML(product) {
    return `
      <div class="product-card" data-product-id="${product.id}">
        <figure>
          <img src="${product.image}" alt="${product.name}" loading="lazy" width="600" height="750">
          <button type="button" class="quick-add" data-add-to-cart="${product.id}" aria-label="Adicionar ${product.name} ao carrinho">
            ${ICONS.plus}
          </button>
        </figure>
        <div class="product-info">
          <p class="product-name">${product.name}</p>
          <p class="product-price">${formatPrice(product.price)}</p>
          <p class="product-installment">${product.installment}</p>
        </div>
      </div>`;
  }

  function bindQuickAdd(container) {
    if (!container) return;
    container.querySelectorAll('[data-add-to-cart]').forEach((btn) => {
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        const id = Number(btn.dataset.addToCart);
        const product = PRODUCTS.find((p) => p.id === id);
        if (product) addToCart(product);
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

  const featuredProducts = PRODUCTS.filter((p) => p.featured);
  const bestSellerProducts = PRODUCTS.filter((p) => p.bestSeller);

  const novidadesScroller = document.querySelector('[data-novidades-scroller]');
  const novidadesGrid = document.querySelector('[data-novidades-grid]');
  const novidadesTitle = document.querySelector('[data-novidades-title]');
  const novidadesLink = document.querySelector('[data-novidades-link]');
  const defaultNovidadesTitle = novidadesTitle ? novidadesTitle.textContent : 'Novidades';
  const defaultNovidadesLinkHTML = novidadesLink ? novidadesLink.innerHTML : '';

  const bestScroller = document.querySelector('[data-best-scroller]');
  const bestGrid = document.querySelector('[data-best-grid]');

  renderProducts(featuredProducts, novidadesScroller, novidadesGrid);
  renderProducts(bestSellerProducts, bestScroller, bestGrid);

  function resetNovidades() {
    renderProducts(featuredProducts, novidadesScroller, novidadesGrid);
    if (novidadesTitle) novidadesTitle.textContent = defaultNovidadesTitle;
    if (novidadesLink) {
      novidadesLink.innerHTML = defaultNovidadesLinkHTML;
      novidadesLink.setAttribute('href', '#novidades');
      novidadesLink.onclick = null;
    }
  }

  function runSearch(rawQuery) {
    const query = rawQuery.trim();
    if (!query) return;
    const q = query.toLowerCase();
    const results = PRODUCTS.filter((p) => p.name.toLowerCase().includes(q));

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
        <div class="category-label">${ICONS.crown}<span>${cat.name}</span></div>
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
    const titleHTML = slide.title
      .split('\n')
      .map((line) => line)
      .join('<br>');
    return `
      <div class="hero-slide" role="group" aria-roledescription="slide" aria-label="${index + 1} de ${HERO_SLIDES.length}">
        <div class="hero-media">
          <img src="${slide.image}" alt="" loading="${index === 0 ? 'eager' : 'lazy'}" width="1000" height="1250">
        </div>
        <div class="hero-content">
          <h1 class="hero-title">${titleHTML}</h1>
          <p class="hero-desc">${slide.description}</p>
          <a href="${slide.href}" class="btn btn-primary">${slide.cta}</a>
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
