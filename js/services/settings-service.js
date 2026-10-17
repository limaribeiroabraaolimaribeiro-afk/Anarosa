(function () {
  'use strict';
  const cfg = window.ANAROSA_CONFIG || {};
  const base = cfg.functionsBaseUrl || `${(cfg.supabaseUrl || '').replace(/\/+$/, '')}/functions/v1`;
  window.AnarosaSettings = {
    value: null,
    ready: fetch(`${base}/storefront-settings`, { signal: AbortSignal.timeout(12000) }).then(async (r) => {
      if (!r.ok) throw new Error('Configurações indisponíveis');
      const { settings } = await r.json();
      if (!settings?.name) throw new Error('Configurações inválidas');
      window.AnarosaSettings.value = settings;
      document.querySelectorAll('[data-store-name]').forEach((el) => el.textContent = settings.name);
      document.querySelectorAll('[data-pickup-address]').forEach((el) =>
        el.textContent = settings.pickupAddress || 'Consulte o endereço de retirada com a equipe.'
      );
      document.querySelectorAll('a[href*="wa.me/"],a[data-whatsapp-link]').forEach((el) => {
        el.href = `https://wa.me/${settings.whatsapp}?text=${
          encodeURIComponent(settings.serviceMessage || '')
        }`;
      });
      document.querySelectorAll('a[href*="instagram.com/"]').forEach((el) => {
        if (settings.instagram) el.href = settings.instagram;
      });
      document.dispatchEvent(new CustomEvent('anarosa:settings', { detail: settings }));
      return settings;
    }).catch(() => null),
  };
})();
