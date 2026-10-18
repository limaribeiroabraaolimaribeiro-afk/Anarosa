(function () {
  'use strict';
  let active = null, previous = null;
  const focusable = () =>
    active
      ? [
        ...active.querySelectorAll(
          'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
        ),
      ].filter((el) => el.getClientRects().length)
      : [];
  new MutationObserver(() => {
    const dialogs = [
      ...document.querySelectorAll(
        '[role="dialog"],[data-order-drawer],[data-product-drawer],[data-stock-drawer]',
      ),
    ];
    const next = dialogs.filter((el) => !el.hidden && el.getClientRects().length).pop() || null;
    if (next === active) return;
    if (next) {
      previous = document.activeElement;
      active = next;
      active.setAttribute('role', 'dialog');
      active.setAttribute('aria-modal', 'true');
      queueMicrotask(() => focusable()[0]?.focus());
    } else {
      active = null;
      previous?.focus();
      previous = null;
    }
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['hidden'],
  });
  document.addEventListener('keydown', (e) => {
    if (!active) return;
    if (e.key === 'Escape') {
      active.querySelector(
        '[data-variant-modal-close],[data-order-drawer-close],[data-product-drawer-close],[data-stock-drawer-close]',
      )?.click();
    }
    if (e.key === 'Tab') {
      const items = focusable();
      if (!items.length) return;
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
})();
