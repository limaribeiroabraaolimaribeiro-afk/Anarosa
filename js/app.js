/** Anarosa storefront. Editorial content is separate from the real catalog. */
(function () {
  'use strict';
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const { CATEGORIES, INSTAGRAM_POSTS, formatPrice } = window.AnarosaData;
  const catalog = window.AnarosaCatalog.createCatalogService(window.ANAROSA_CONFIG);
  const cart = window.AnarosaCart.createCartService();
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[-_]/g, ' ');
  function descriptionText(value) {
    // A detached template is inert: never insert supplier HTML into the page.
    let text = String(value || '');
    for (let pass = 0; pass < 2; pass++) {
      const template = document.createElement('template');
      template.innerHTML = text;
      template.content.querySelectorAll('script,style,iframe,object,template').forEach((node) => node.remove());
      template.content.querySelectorAll('br,p,div,li,h1,h2,h3,h4').forEach((node) => node.append(document.createTextNode('\n')));
      const next = template.content.textContent || '';
      if (next === text) break;
      text = next;
    }
    return text.replace(/\n[\t ]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const placeholder = window.ANAROSA_CONFIG.placeholderImage || 'assets/products/placeholder.svg';
  const grid = $('[data-novidades-grid]');
  const modal = $('[data-variant-modal-overlay]');
  const searchInput = $('[data-search-input]');
  const suggestions = $('[data-search-suggestions]');
  const favoriteKey = 'anarosa_favorites_v1';
  let products = [], loaded = false, loadFailed = false, toastTimer, suggestionIndex = -1, suggestionProducts = [];
  let favorites = readFavorites();
  const selectedVariants = new Map();
  const state = { category: '', collection: 'new', query: '', available: false, sort: 'new', favorites: false, limit: 6 };
  const priceOf = (p, v) => Number(v?.promotionalPrice ?? v?.price ?? p.promotionalPrice ?? p.price);
  const variantsOf = (p) => p.variants?.items || [];
  const unavailable = (p) => p.available === false || (p.stock != null && Number(p.stock) <= 0 && !variantsOf(p).some((v) => !unavailable(v)));
  const variantLabel = (v) => [v.size, v.color].filter(Boolean).join(' / ') || v.name || 'Opção';
  function imageUrl(value) {
    try { const u = new URL(value || placeholder, location.href); return u.protocol === 'https:' || u.origin === location.origin ? u.href : placeholder; }
    catch { return placeholder; }
  }
  function readFavorites() {
    try { const value = JSON.parse(localStorage.getItem(favoriteKey) || '[]'); return new Set(Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.length < 128).slice(0, 500) : []); }
    catch { return new Set(); }
  }
  function toast(message, showCart = false) {
    const el = $('[data-toast]');
    el.innerHTML = `${escape(message)}${showCart ? '<button type="button" data-toast-cart>Ver carrinho →</button>' : ''}`;
    el.classList.add('is-visible'); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), 4200);
  }
  function scrollCatalog() { $('#novidades').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' }); }
  function syncScrollLock() { document.body.classList.toggle('no-scroll', !!$('[role="dialog"]:not([hidden])')); }
  function closeMenu() { $('[data-drawer]').hidden = true; $('[data-drawer-overlay]').hidden = true; $('[data-hamburger]').setAttribute('aria-expanded', 'false'); syncScrollLock(); }
  function closeCart() { $('[data-cart-drawer]').hidden = true; $('[data-cart-overlay]').hidden = true; $('[data-cart-toggle]').setAttribute('aria-expanded', 'false'); syncScrollLock(); }
  function openCart() { closeMenu(); closeProduct(); clearTimeout(toastTimer); $('[data-toast]').classList.remove('is-visible'); renderCart(); $('[data-cart-drawer]').hidden = false; $('[data-cart-overlay]').hidden = false; $('[data-cart-toggle]').setAttribute('aria-expanded', 'true'); syncScrollLock(); }
  function closeProduct(keepUrl = false) {
    if (modal.hidden) return;
    modal.hidden = true; modal.innerHTML = ''; syncScrollLock();
    if (!keepUrl) { const u = new URL(location.href); u.searchParams.delete('produto'); history.replaceState(null, '', u); }
  }
  function renderCart() {
    const items = cart.getItems();
    $('[data-cart-badge]').textContent = cart.getCount();
    $('[data-cart-heading-count]').textContent = `(${cart.getCount()})`;
    $('[data-cart-subtotal]').textContent = formatPrice(cart.getSubtotal());
    $('[data-cart-checkout-link]').hidden = !items.length;
    $('[data-cart-items]').innerHTML = items.length ? items.map((item) => `<div class="cart-item" data-cart-item="${escape(item.key)}"><img src="${escape(imageUrl(item.image))}" alt="${escape(item.name)}" width="80" height="100" data-product-image><div><p class="cart-item-name">${escape(item.name)}</p><p class="cart-item-attrs">${escape([item.size, item.color].filter(Boolean).join(' · '))}</p><div class="cart-qty"><button type="button" data-cart-decrement="${escape(item.key)}" aria-label="Diminuir quantidade de ${escape(item.name)}">−</button><span aria-label="Quantidade">${item.quantity}</span><button type="button" data-cart-increment="${escape(item.key)}" aria-label="Aumentar quantidade de ${escape(item.name)}">+</button></div><button type="button" class="cart-item-remove" data-cart-remove="${escape(item.key)}">Remover</button></div><p class="cart-item-price">${formatPrice(item.unitPrice * item.quantity)}</p></div>`).join('') : `<div class="empty-state cart-empty">${icon('bag')}<h3>Espaço para se apaixonar.</h3><p>Suas próximas peças favoritas estão esperando por você.</p><button type="button" class="btn btn-outline" data-cart-empty-close>Explorar a coleção ${icon('arrow')}</button></div>`;
  }
  function addToCart(p, v, quantity = 1) {
    const before = cart.getCount(); const result = cart.addItem(p, v, quantity);
    if (cart.getCount() <= before) { toast('Você já adicionou o saldo disponível desta peça.'); return; }
    toast(result.clamped ? 'Peça adicionada até o limite disponível.' : 'Uma boa escolha! Peça adicionada ao carrinho.', true);
    $('[data-cart-badge]').animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.3)' }, { transform: 'scale(1)' }], { duration: reducedMotion.matches ? 0 : 280 });
  }
  cart.onChange(renderCart); renderCart();

  function priceMarkup(p, v) {
    const current = priceOf(p, v), original = Number(v?.price ?? p.price);
    return `${current < original ? `<span class="price-old">${formatPrice(original)}</span>` : ''}<span class="price-now">${formatPrice(current)}</span>`;
  }
  function card(p) {
    const variants = variantsOf(p), chosen = variants.find((v) => String(v.id) === selectedVariants.get(String(p.id)));
    const id = escape(p.id), name = escape(p.name), sold = unavailable(p), liked = favorites.has(String(p.id));
    const images = p.images?.length ? p.images : [p.image];
    const sale = p.promotionalPrice != null && p.promotionalPrice < p.price;
    return `<article class="product-card${sold ? ' is-soldout' : ''}" data-product-id="${id}"><figure><button type="button" class="product-photo" data-product-detail="${id}" aria-label="Ver detalhes de ${name}"><img class="product-image" src="${escape(imageUrl(images[0]))}" alt="${name}" width="600" height="750" loading="lazy" decoding="async" data-product-image>${images[1] ? `<img class="product-image-alt" src="${escape(imageUrl(images[1]))}" alt="" width="600" height="750" loading="lazy" data-product-image>` : ''}<span class="quick-view-label">Ver de perto</span></button>${sold || sale ? `<span class="product-badge">${sold ? 'Indisponível' : 'Condição especial'}</span>` : ''}<button type="button" class="favorite-btn" data-favorite="${id}" aria-label="${liked ? 'Remover' : 'Salvar'} ${name} ${liked ? 'dos' : 'nos'} favoritos" aria-pressed="${liked}">${icon('heart')}</button>${sold ? '' : `<button type="button" class="quick-add" data-add-to-cart="${id}" aria-label="Adicionar ${name} ao carrinho">${icon('bag')}</button>`}</figure><div class="product-info"><button type="button" class="product-name" data-product-detail="${id}">${name}</button><div class="product-variants" role="group" aria-label="Opções de ${name}">${variants.slice(0, 6).map((v) => `<button type="button" class="size-chip" data-card-variant="${escape(v.id)}" data-for-product="${id}" aria-pressed="${chosen?.id === v.id}" ${unavailable(v) ? 'disabled' : ''} aria-label="${escape(variantLabel(v))}${unavailable(v) ? ', indisponível' : ''}">${escape(variantLabel(v))}</button>`).join('')}${variants.length > 6 ? `<button type="button" class="size-chip" data-product-detail="${id}" aria-label="Ver todas as opções">+${variants.length - 6}</button>` : ''}</div><p class="product-price">${priceMarkup(p, chosen)}</p><p class="product-meta">${sold ? 'Volte para conferir novidades' : variants.length ? 'Escolha a sua opção' : 'Veja os detalhes da peça'}</p></div></article>`;
  }
  function matchesUniverse(p, slug) {
    const source = normalize([p.category, p.categoryName, p.name, descriptionText(p.description), ...(p.tags || [])].join(' '));
    const rules = { feminino: /\b(feminin[oa]s?|mulher|mulheres)\b/, masculino: /\b(masculin[oa]s?|homem|homens)\b/, infantil: /\b(infantil|infantis|juvenil|bebe|bebes|kids)\b/, 'plus-size': /\bplus\s*size\b/ };
    return rules[slug]?.test(source) || false;
  }
  function filteredProducts() {
    const q = normalize(state.query);
    let list = products.filter((p) => (!state.category || (state.category.startsWith('universe:') ? matchesUniverse(p, state.category.slice(9)) : p.category === state.category)) && (!q || normalize([p.name, p.categoryName, p.sku, ...variantsOf(p).flatMap((v) => [v.sku, v.name, v.size, v.color]), ...(p.tags || [])].join(' ')).includes(q)) && (!state.available || !unavailable(p)) && (!state.favorites || favorites.has(String(p.id))) && (state.collection !== 'sale' || (p.promotionalPrice != null && p.promotionalPrice < p.price)));
    list = list.slice().sort((a, b) => state.sort.startsWith('price') ? (priceOf(a) - priceOf(b)) * (state.sort === 'price-desc' ? -1 : 1) : state.sort === 'name' ? a.name.localeCompare(b.name, 'pt-BR') : (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
    return list;
  }
  function updateFavorites() {
    $$('[data-favorite]').forEach((b) => { const active = favorites.has(b.dataset.favorite); const p = products.find((p) => String(p.id) === b.dataset.favorite); b.setAttribute('aria-pressed', String(active)); if (b.classList.contains('detail-favorite')) b.innerHTML = icon('heart') + (active ? ' Remover dos favoritos' : ' Guardar nos favoritos'); b.setAttribute('aria-label', `${active ? 'Remover' : 'Salvar'} ${p?.name || 'peça'} ${active ? 'dos' : 'nos'} favoritos`); });
    const count = $('[data-favorites-count]'); count.textContent = favorites.size; count.hidden = !favorites.size;
    $('[data-favorites-toggle]').setAttribute('aria-pressed', String(state.favorites));
  }
  function renderCatalog() {
    if (!loaded) return;
    const list = filteredProducts();
    grid.setAttribute('aria-busy', 'false');
    grid.innerHTML = list.length ? list.slice(0, state.limit).map(card).join('') : `<div class="empty-state">${icon(state.favorites ? 'heart' : 'search')}<h3>${state.favorites ? 'Suas favoritas moram aqui.' : 'Vamos encontrar o seu próximo look?'}</h3><p>${state.favorites ? 'Toque no coração de uma peça para guardá-la neste navegador.' : 'Não encontramos peças com essa seleção. Experimente outra busca ou explore a coleção completa.'}</p><button type="button" class="btn btn-outline" data-clear-filters>Ver toda a coleção ${icon('arrow')}</button></div>`;
    $('[data-filter-count]').textContent = `${list.length} ${list.length === 1 ? 'peça' : 'peças'}`;
    $('[data-load-more]').hidden = list.length <= state.limit;
    $('[data-filter-category]').value = state.category;
    $('[data-filter-sort]').value = state.sort;
    $('[data-filter-available]').checked = state.available;
    const labels = [state.favorites && 'Favoritos', state.query && `Busca: “${state.query}”`, state.category && $('[data-filter-category]').selectedOptions[0]?.textContent, state.collection === 'sale' && 'Promoções', state.available && 'Disponíveis'].filter(Boolean);
    $('[data-active-filters]').hidden = !labels.length;
    $('[data-active-filter-label]').textContent = labels.join(' · ');
    $$('.collection-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.universe ? state.category === 'universe:' + b.dataset.universe : !state.category && state.collection === b.dataset.collection && !state.favorites)));
    updateFavorites();
  }
  function clearFilters() { Object.assign(state, { category: '', collection: 'new', query: '', available: false, sort: 'new', favorites: false, limit: 6 }); searchInput.value = ''; closeSuggestions(); renderCatalog(); }
  function renderLoading() {
    grid.setAttribute('aria-busy', 'true');
    grid.innerHTML = `<p class="sr-only" role="status">Carregando produtos…</p>${Array.from({ length: 6 }, () => '<div class="product-skeleton" aria-hidden="true"><span></span><i></i><i></i></div>').join('')}`;
  }
  async function loadCatalog() {
    loadFailed = false; renderLoading();
    try {
      const received = await catalog.getProducts();
      // Some older catalog bundles also return a parent's variants as cards.
      // Group only relationships explicitly supplied by that same catalog.
      const childIds = new Set(received.flatMap((p) => variantsOf(p).filter((v) => v.blingId != null && String(v.blingId).trim()).map((v) => String(v.blingId))));
      products = received.filter((p) => variantsOf(p).length || !childIds.has(String(p.blingId)));
      loaded = true;
      const categories = [...new Map(products.filter((p) => p.category).map((p) => [p.category, p.categoryName || p.category])).entries()];
      $('[data-filter-category]').innerHTML = '<option value="">Todas as peças</option>' + CATEGORIES.map((c) => `<option value="universe:${c.slug}">${c.name}</option>`).join('') + (categories.length ? `<optgroup label="Categorias do catálogo">${categories.map(([slug, name]) => `<option value="${escape(slug)}">${escape(name)}</option>`).join('')}</optgroup>` : '');
      renderCatalog();
      if (new URL(location.href).searchParams.has('produto')) await openLinkedProduct();
    } catch {
      loaded = false; loadFailed = true; grid.setAttribute('aria-busy', 'false');
      grid.innerHTML = `<div class="empty-state catalog-error">${icon('sun')}<h3>Voltamos já com suas próximas escolhas.</h3><p>Não conseguimos carregar os produtos agora. Tente novamente em instantes ou fale conosco no WhatsApp.</p><div class="empty-actions"><button type="button" class="btn btn-primary" data-retry-catalog>Tentar novamente ${icon('arrow')}</button><a class="btn btn-outline" href="https://wa.me/554730911041" data-whatsapp-link target="_blank" rel="noopener noreferrer">Falar com a equipe</a></div></div>`;
      $('[data-filter-count]').textContent = 'Catálogo indisponível';
    }
  }

  function openProduct(p, preselect, keepUrl = false) {
    closeMenu(); closeCart(); closeSuggestions();
    const variants = variantsOf(p), images = p.images?.length ? p.images : [p.image];
    let selected = null;
    modal.innerHTML = `<section class="product-detail-modal" role="dialog" aria-modal="true" aria-label="${escape(p.name)}"><button type="button" class="icon-btn product-detail-close" data-variant-modal-close aria-label="Fechar detalhes">${icon('close')}</button><div class="product-detail-grid"><div class="product-gallery" data-gallery><div class="product-main-photo"><img data-detail-image data-product-image src="${escape(imageUrl(images[0]))}" alt="${escape(p.name)}" width="600" height="750"></div><div class="product-thumbnails" role="group" aria-label="Fotografias da peça">${images.map((url, i) => `<button type="button" data-image-index="${i}" aria-label="Foto ${i + 1}" aria-pressed="${i === 0}"><img src="${escape(imageUrl(url))}" alt="" width="64" height="80" loading="lazy" data-product-image></button>`).join('')}</div></div><div class="product-detail-copy"><p class="eyebrow">Um novo momento Anarosa</p><h2>${escape(p.name)}</h2><p class="product-detail-price" data-detail-price>${formatPrice(priceOf(p))}</p><p class="detail-selection-label">${variants.length ? 'Qual é a sua opção?' : 'Peça sem variações'}</p><div class="variant-option-list">${variants.map((v) => `<button type="button" class="variant-option" data-variant-option="${escape(v.id)}" aria-pressed="false" ${unavailable(v) ? 'disabled' : ''}><span>${escape(variantLabel(v))}</span><small>${unavailable(v) ? 'Esgotado' : formatPrice(priceOf(p, v))}</small></button>`).join('')}</div><p class="detail-stock" data-detail-stock role="status">${unavailable(p) ? 'Indisponível no momento' : variants.length ? 'Selecione uma opção para conferir o saldo.' : p.stock != null ? `${Number(p.stock)} unidade(s) disponíveis` : 'Disponibilidade confirmada na revisão do pedido.'}</p><div class="detail-buy"><label class="quantity-field">Quantidade<input type="number" min="1" max="20" value="1" inputmode="numeric" data-detail-quantity aria-label="Quantidade da peça"></label><button type="button" class="btn btn-primary" data-detail-add ${variants.length || unavailable(p) ? 'disabled' : ''}>${icon('bag')} Adicionar ao carrinho</button></div><button type="button" class="detail-favorite text-link" data-favorite="${escape(p.id)}" aria-pressed="${favorites.has(String(p.id))}">${icon('heart')} Guardar nos favoritos</button><details class="product-description" open><summary>Sobre a peça</summary><p>${escape(descriptionText(p.description) || 'Quer saber mais sobre composição, caimento ou medidas? Fale com a nossa equipe antes de escolher.')}</p></details><a class="detail-help text-link" href="https://wa.me/554730911041?text=${encodeURIComponent('Olá! Gostaria de saber mais sobre ' + p.name)}" target="_blank" rel="noopener noreferrer">${icon('chat')} Uma ajuda para escolher?</a></div></div></section>`;
    const whatsapp = window.AnarosaSettings?.value?.whatsapp;
    if (/^\d{10,15}$/.test(whatsapp || '')) $('[data-variant-modal-overlay] .detail-help').href = 'https://wa.me/' + whatsapp + '?text=' + encodeURIComponent('Olá! Gostaria de saber mais sobre ' + p.name);
    updateFavorites(); modal.hidden = false; syncScrollLock();
    const pick = (v) => {
      selected = v;
      $$('[data-variant-option]', modal).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.variantOption === String(v.id))));
      $('[data-detail-price]', modal).textContent = formatPrice(priceOf(p, v));
      $('[data-detail-stock]', modal).textContent = v.stock != null ? `${Number(v.stock)} unidade(s) disponíveis` : 'Disponibilidade confirmada na revisão do pedido.';
      $('[data-detail-add]', modal).disabled = unavailable(v);
      $('[data-detail-quantity]', modal).max = v.stock != null ? Math.min(20, Math.max(1, Number(v.stock))) : 20;
    };
    $$('[data-variant-option]', modal).forEach((b) => b.addEventListener('click', () => pick(variants.find((v) => String(v.id) === b.dataset.variantOption))));
    $$('[data-image-index]', modal).forEach((b) => b.addEventListener('click', () => { $('[data-detail-image]', modal).src = imageUrl(images[Number(b.dataset.imageIndex)]); $$('[data-image-index]', modal).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); }));
    $('[data-detail-add]', modal).addEventListener('click', () => { const qty = Math.max(1, Math.min(20, Math.trunc(Number($('[data-detail-quantity]', modal).value) || 1))); addToCart(p, selected, qty); closeProduct(); });
    if (preselect) { const v = variants.find((v) => String(v.id) === String(preselect)); if (v && !unavailable(v)) pick(v); }
    if (!keepUrl) { const u = new URL(location.href); u.searchParams.set('produto', p.slug); history.pushState({ product: p.slug }, '', u); }
  }
  async function openLinkedProduct() {
    const slug = new URL(location.href).searchParams.get('produto');
    if (!slug) { closeProduct(true); return; }
    try { const p = products.find((p) => p.slug === slug) || await catalog.getProductBySlug(slug); if (!p) { toast('Essa peça não está disponível no catálogo.'); return; } if (!products.some((x) => String(x.id) === String(p.id))) products.push(p); openProduct(p, null, true); }
    catch { toast('Não foi possível abrir essa peça. Tente novamente.'); }
  }
  window.addEventListener('popstate', openLinkedProduct);

  function closeSuggestions() { suggestions.hidden = true; suggestionIndex = -1; searchInput.setAttribute('aria-expanded', 'false'); searchInput.removeAttribute('aria-activedescendant'); }
  function renderSuggestions() {
    const q = normalize(searchInput.value.trim()); suggestionIndex = -1;
    if (q.length < 2) { closeSuggestions(); return; }
    suggestionProducts = products.filter((p) => normalize([p.name, p.sku, ...variantsOf(p).flatMap((v) => [v.sku, v.name, v.size, v.color])].join(' ')).includes(q)).slice(0, 5);
    suggestions.innerHTML = suggestionProducts.length ? suggestionProducts.map((p, i) => `<button type="button" id="suggestion-${i}" role="option" aria-selected="false" data-suggestion="${escape(p.id)}"><img src="${escape(imageUrl(p.image))}" alt="" width="40" height="50" data-product-image><span>${escape(p.name)}<small>${formatPrice(priceOf(p))}</small></span>${icon('arrow')}</button>`).join('') : `<p class="suggestion-empty">${!loaded && !loadFailed ? 'Carregando a coleção…' : loadFailed ? 'Catálogo indisponível. Tente novamente abaixo.' : 'Nenhuma peça com esse nome. Experimente outra busca.'}</p>`;
    suggestions.hidden = false; searchInput.setAttribute('aria-expanded', 'true');
  }
  searchInput.addEventListener('input', renderSuggestions);
  searchInput.addEventListener('focus', renderSuggestions);
  searchInput.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !suggestions.hidden && suggestionProducts.length) {
      e.preventDefault(); suggestionIndex = (suggestionIndex + (e.key === 'ArrowDown' ? 1 : -1) + suggestionProducts.length) % suggestionProducts.length;
      $$('[role="option"]', suggestions).forEach((b, i) => b.setAttribute('aria-selected', String(i === suggestionIndex)));
      searchInput.setAttribute('aria-activedescendant', `suggestion-${suggestionIndex}`);
    } else if (e.key === 'Enter' && suggestionIndex >= 0 && !suggestions.hidden) { e.preventDefault(); openProduct(suggestionProducts[suggestionIndex]); }
    else if (e.key === 'Escape') closeSuggestions();
  });
  $('[data-search-form]').addEventListener('submit', (e) => { e.preventDefault(); state.query = searchInput.value.trim(); state.limit = 6; closeSuggestions(); renderCatalog(); scrollCatalog(); });
  $('[data-filter-category]').addEventListener('change', (e) => { state.category = e.target.value; state.limit = 6; renderCatalog(); });
  $('[data-filter-sort]').addEventListener('change', (e) => { state.sort = e.target.value; renderCatalog(); });
  $('[data-filter-available]').addEventListener('change', (e) => { state.available = e.target.checked; state.limit = 6; renderCatalog(); });
  document.addEventListener('click', (event) => {
    const b = event.target.closest('button,a'); if (!b) { if (!event.target.closest('[data-search-bar]')) closeSuggestions(); return; }
    if (!b.closest('[data-search-bar]')) closeSuggestions();
    const p = products.find((p) => String(p.id) === (b.dataset.productDetail || b.dataset.addToCart || b.dataset.favorite || b.dataset.forProduct || b.dataset.suggestion));
    if (b.hasAttribute('data-product-detail') && p) openProduct(p);
    else if (b.hasAttribute('data-add-to-cart') && p) { const v = variantsOf(p).find((v) => String(v.id) === selectedVariants.get(String(p.id))); if (variantsOf(p).length && !v) openProduct(p); else addToCart(p, v); }
    else if (b.hasAttribute('data-card-variant') && p) { selectedVariants.set(String(p.id), b.dataset.cardVariant); const article = b.closest('[data-product-id]'); article.outerHTML = card(p); const replacement = $$('[data-card-variant]').find((x) => x.dataset.forProduct === String(p.id) && x.dataset.cardVariant === b.dataset.cardVariant); replacement?.focus({ preventScroll: true }); }
    else if (b.hasAttribute('data-favorite')) { const id = b.dataset.favorite; if (favorites.has(id)) favorites.delete(id); else favorites.add(id); try { localStorage.setItem(favoriteKey, JSON.stringify([...favorites])); } catch { toast('Favorito guardado nesta visita. O navegador não permitiu salvar para depois.'); } updateFavorites(); if (state.favorites) renderCatalog(); }
    else if (b.hasAttribute('data-favorites-toggle')) { const next = !state.favorites; clearFilters(); state.favorites = next; renderCatalog(); scrollCatalog(); }
    else if (b.hasAttribute('data-universe') || b.hasAttribute('data-collection')) { event.preventDefault(); state.category = b.dataset.universe ? 'universe:' + b.dataset.universe : ''; state.collection = b.dataset.collection || 'new'; state.limit = 6; state.favorites = false; state.query = ''; searchInput.value = ''; closeMenu(); renderCatalog(); scrollCatalog(); }
    else if (b.hasAttribute('data-view-all') || b.hasAttribute('data-clear-filters')) { event.preventDefault(); clearFilters(); scrollCatalog(); }
    else if (b.hasAttribute('data-load-more')) { state.limit += 6; renderCatalog(); }
    else if (b.hasAttribute('data-retry-catalog')) loadCatalog();
    else if (b.hasAttribute('data-hamburger')) { closeCart(); closeProduct(); $('[data-drawer]').hidden = false; $('[data-drawer-overlay]').hidden = false; b.setAttribute('aria-expanded', 'true'); syncScrollLock(); }
    else if (b.hasAttribute('data-drawer-close')) closeMenu();
    else if (b.hasAttribute('data-cart-toggle') || b.hasAttribute('data-toast-cart')) openCart();
    else if (b.hasAttribute('data-cart-close') || b.hasAttribute('data-cart-continue')) closeCart();
    else if (b.hasAttribute('data-cart-empty-close')) { closeCart(); scrollCatalog(); }
    else if (b.hasAttribute('data-variant-modal-close')) closeProduct();
    else if (b.hasAttribute('data-cart-remove')) { cart.removeItem(b.dataset.cartRemove); toast('Peça removida do carrinho.'); }
    else if (b.hasAttribute('data-cart-increment') || b.hasAttribute('data-cart-decrement')) { const key = b.dataset.cartIncrement || b.dataset.cartDecrement; const item = cart.getItems().find((x) => x.key === key); if (item) { const result = cart.updateQuantity(key, item.quantity + (b.hasAttribute('data-cart-increment') ? 1 : -1)); if (result.clamped) toast('Você chegou ao saldo disponível desta peça.'); const next = $$(b.hasAttribute('data-cart-increment') ? '[data-cart-increment]' : '[data-cart-decrement]').find((x) => (x.dataset.cartIncrement || x.dataset.cartDecrement) === key); next?.focus(); } }
    else if (b.hasAttribute('data-suggestion') && p) openProduct(p);
  });
  $('[data-drawer-overlay]').addEventListener('click', closeMenu);
  $('[data-cart-overlay]').addEventListener('click', closeCart);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeProduct(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!modal.hidden) closeProduct(); else if (!$('[data-cart-drawer]').hidden) closeCart(); else if (!$('[data-drawer]').hidden) closeMenu(); else closeSuggestions(); } });
  window.addEventListener('storage', (e) => { if (e.key === favoriteKey) { favorites = readFavorites(); updateFavorites(); if (state.favorites) renderCatalog(); } });
  document.addEventListener('error', (e) => { if (e.target.matches?.('img[data-product-image]') && !e.target.dataset.fallback) { e.target.dataset.fallback = 'true'; e.target.src = placeholder; } }, true);
  $('[data-universes]').innerHTML = CATEGORIES.map((c, i) => `<a href="#novidades" class="universe-card" data-universe="${c.slug}"><img src="assets/img/optimized/${c.image}-480.webp" srcset="assets/img/optimized/${c.image}-480.webp 480w, assets/img/optimized/${c.image}-960.webp 960w" sizes="(max-width: 767px) 46vw, 24vw" width="480" height="600" alt="${c.alt}" loading="lazy" decoding="async"><span class="universe-number">0${i + 1}</span><span class="universe-copy"><strong>${c.name}</strong><span>${c.line}</span><small>Ver coleção ${icon('arrow')}</small></span></a>`).join('');
  $('[data-instagram-grid]').innerHTML = INSTAGRAM_POSTS.map((p) => `<a href="https://www.instagram.com/anarosatextil/" target="_blank" rel="noopener noreferrer" aria-label="Conhecer o Instagram da Anarosa"><img src="${p.image}" alt="${p.alt}" width="480" height="600" loading="lazy" decoding="async">${icon('instagram')}</a>`).join('');
  $('[data-current-year]').textContent = new Date().getFullYear();
  const header = $('[data-header]');
  new IntersectionObserver(([entry]) => header.classList.toggle('is-scrolled', !entry.isIntersecting)).observe($('.topbar'));
  updateFavorites(); loadCatalog();
})();
