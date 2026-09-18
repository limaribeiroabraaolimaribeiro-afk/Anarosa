/**
 * ANAROSA — carrinho (CartService).
 *
 * Guarda linhas de carrinho (produto + variação opcional + quantidade)
 * em localStorage, sobrevive a reload/fechar aba. Os valores de preço
 * aqui são SÓ PARA EXIBIÇÃO — o checkout final sempre revalida preço e
 * estoque no backend (storefront-checkout → CatalogRepository.
 * resolveOrderItems), nunca confia no que está no carrinho do navegador.
 *
 * Não depende de framework: pub/sub simples via onChange().
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'anarosa_cart_v2';
  const OLD_COUNTER_KEY = 'anarosa_cart_count'; // versão anterior (só um número) — descontinuada

  function readStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeStorage(items) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {
      /* localStorage indisponível (modo privado etc.) — carrinho fica só em memória */
    }
  }

  function lineKey(productId, variantId) {
    return `${productId}::${variantId || '-'}`;
  }

  class CartService {
    constructor() {
      // migra da versão antiga (só contador): nada a preservar, apenas remove.
      try { localStorage.removeItem(OLD_COUNTER_KEY); } catch { /* ignore */ }
      this._items = readStorage();
      this._listeners = [];
    }

    onChange(fn) {
      this._listeners.push(fn);
      return () => { this._listeners = this._listeners.filter((f) => f !== fn); };
    }

    _emit() {
      writeStorage(this._items);
      for (const fn of this._listeners) {
        try { fn(this.getItems()); } catch (err) { console.error('[AnarosaCart] listener falhou:', err); }
      }
    }

    getItems() {
      return this._items.map((i) => ({ ...i }));
    }

    getCount() {
      return this._items.reduce((sum, i) => sum + i.quantity, 0);
    }

    /** Estimativa client-side (exibição). O backend recalcula tudo no checkout. */
    getSubtotal() {
      return this._items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
    }

    /**
     * Adiciona um produto (ou variação) ao carrinho.
     * `variant` é opcional — quando o produto tem variantes, o chamador
     * deve resolver qual variação antes de chamar isto (ver seletor de
     * variação em js/app.js).
     *
     * Nunca deixa a quantidade no carrinho passar do saldo CONHECIDO no
     * momento (variant.stock ?? product.stock) — só uma conveniência de
     * UX (evita o cliente montar um carrinho já sabidamente maior que o
     * estoque); a fonte de verdade continua sendo o backend no
     * checkout, que sempre revalida contra o saldo atual. Quando o
     * saldo não é conhecido (null/undefined), mantém o teto de 20.
     * `clamped` no retorno indica se a quantidade pedida foi reduzida.
     */
    addItem(product, variant, quantity) {
      const requested = Math.max(1, Math.round(Number(quantity) || 1));
      const knownStock = variant && variant.stock != null ? Number(variant.stock) : (product.stock != null ? Number(product.stock) : null);
      const ceiling = knownStock != null && Number.isFinite(knownStock) ? Math.max(0, Math.floor(knownStock)) : 20;
      const cap = Math.min(20, ceiling);
      const variantId = variant ? variant.id : null;
      const variantBlingId = variant ? variant.blingId : null;
      const unitPrice = variant && variant.promotionalPrice != null
        ? Number(variant.promotionalPrice)
        : variant && variant.price != null
          ? Number(variant.price)
          : product.promotionalPrice != null
            ? Number(product.promotionalPrice)
            : Number(product.price || 0);

      const key = lineKey(product.id, variantId);
      const existing = this._items.find((i) => i.key === key);
      let finalQuantity;
      if (existing) {
        finalQuantity = Math.min(cap, existing.quantity + requested);
        existing.quantity = finalQuantity;
        existing.unitPrice = unitPrice; // reflete preço mais recente visto
        existing.stock = knownStock;
      } else {
        finalQuantity = Math.min(cap, requested);
        this._items.push({
          key,
          productId: product.id,
          slug: product.slug,
          blingId: product.blingId ?? null,
          variantId,
          variantBlingId,
          sku: (variant && variant.sku) || product.sku || null,
          name: variant && variant.name ? `${product.name} — ${variant.name}` : product.name,
          image: product.image,
          unitPrice,
          quantity: finalQuantity,
          size: (variant && variant.size) || null,
          color: (variant && variant.color) || null,
          stock: knownStock,
        });
      }
      this._emit();
      return { items: this.getItems(), clamped: finalQuantity < requested, maxQuantity: cap };
    }

    updateQuantity(key, quantity) {
      const item = this._items.find((i) => i.key === key);
      if (!item) return { items: this.getItems(), clamped: false, maxQuantity: null };
      const q = Math.round(Number(quantity));
      let clamped = false;
      let cap = null;
      if (!Number.isFinite(q) || q < 1) {
        this._items = this._items.filter((i) => i.key !== key);
      } else {
        const ceiling = item.stock != null && Number.isFinite(item.stock) ? Math.max(0, Math.floor(item.stock)) : 20;
        cap = Math.min(20, ceiling);
        item.quantity = Math.min(cap, q);
        clamped = item.quantity < q;
      }
      this._emit();
      return { items: this.getItems(), clamped, maxQuantity: cap };
    }

    removeItem(key) {
      this._items = this._items.filter((i) => i.key !== key);
      this._emit();
      return this.getItems();
    }

    clear() {
      this._items = [];
      this._emit();
    }
  }

  window.AnarosaCart = {
    CartService,
    createCartService: () => new CartService(),
  };
})();
