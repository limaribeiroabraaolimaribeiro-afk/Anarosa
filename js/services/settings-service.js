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
        if (/^\d{10,15}$/.test(settings.whatsapp || '')) {
          el.href = `https://wa.me/${settings.whatsapp}?text=${encodeURIComponent(settings.serviceMessage || '')}`;
        }
      });
      if (/^55\d{10,11}$/.test(settings.whatsapp || '')) {
        const number = settings.whatsapp.slice(2);
        const formatted = `(${number.slice(0, 2)}) ${number.slice(2, -4)}-${number.slice(-4)}`;
        document.querySelectorAll('[data-store-phone]').forEach((el) => el.textContent = formatted);
      }
      document.querySelectorAll('a[href*="instagram.com/"]').forEach((el) => {
        if (settings.instagram) el.href = settings.instagram;
      });
      const delivery = Array.isArray(settings.deliveryMethods) && settings.deliveryMethods.includes('delivery');
      const pickup = Array.isArray(settings.deliveryMethods) && settings.deliveryMethods.includes('pickup');
      const deliveryLabel = delivery && settings.deliveryPricing === 'fixed'
        ? 'Frete informado no checkout'
        : delivery ? 'Entrega a combinar com a equipe' : pickup ? 'Retirada na loja' : 'Condições com a equipe';
      document.querySelectorAll('[data-topbar-delivery],[data-delivery-benefit-note]').forEach((el) => el.textContent = deliveryLabel);
      document.querySelectorAll('[data-payment-benefit]').forEach((el) => {
        el.textContent = settings.paymentMethods?.includes('pix') ? 'Pix ou cartão no pagamento online' : 'Combine as condições com a equipe';
      });
      document.querySelectorAll('[data-delivery-info]').forEach((el) => {
        el.textContent = delivery ? `${deliveryLabel}. ${pickup ? 'Você também pode escolher a retirada na loja. ' : ''}Confira a opção e o valor na revisão do pedido.` : pickup ? 'A retirada na loja está habilitada. Combine os detalhes com a equipe antes de sair de casa.' : 'Consulte as opções de recebimento diretamente com a equipe.';
      });
      document.querySelectorAll('[data-payment-info]').forEach((el) => {
        el.textContent = settings.paymentMethods?.includes('pix') ? 'O pagamento online por Pix ou cartão está entre as opções da loja. Confira os métodos habilitados e as condições no checkout.' : 'Confira no checkout os métodos habilitados ou combine as condições com a equipe.';
      });
      document.dispatchEvent(new CustomEvent('anarosa:settings', { detail: settings }));
      return settings;
    }).catch(() => null),
  };
})();
