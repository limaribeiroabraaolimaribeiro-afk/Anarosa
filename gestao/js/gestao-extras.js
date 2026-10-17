(function () {
  'use strict';
  const esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );
  const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const settingsBox = document.createElement('div');
  settingsBox.className = 'gestao-card';
  document.querySelector('[data-page="configuracoes"]').append(settingsBox);
  let revision;
  async function loadSettings() {
    settingsBox.textContent = 'Carregando configurações…';
    try {
      const result = await window.GestaoApi.getSettings();
      revision = result.revision;
      const s = result.settings;
      settingsBox.innerHTML =
        `<h2>Loja e atendimento</h2><form class="settings-form"><div class="editor-grid">${
          [['name', 'Nome da loja'], ['whatsapp', 'WhatsApp (55 + DDD + número)'], [
            'pickupAddress',
            'Endereço de retirada',
          ], ['instagram', 'Instagram']].map(([k, label]) =>
            `<label>${label}<input name="${k}" value="${esc(s[k])}" ${
              ['name', 'whatsapp'].includes(k) ? 'required' : ''
            }></label>`
          ).join('')
        }</div><label>Mensagem de atendimento<textarea name="serviceMessage">${
          esc(s.serviceMessage)
        }</textarea></label><fieldset><legend>Entrega</legend>${
          [['pickup', 'Retirada'], ['delivery', 'Entrega']].map(([v, l]) =>
            `<label><input type="checkbox" name="deliveryMethods" value="${v}" ${
              s.deliveryMethods.includes(v) ? 'checked' : ''
            }> ${l}</label>`
          ).join('')
        }<label>Regra de frete<select name="deliveryPricing"><option value="quote" ${
          s.deliveryPricing === 'quote' ? 'selected' : ''
        }>Combinar antes do pagamento</option><option value="fixed" ${
          s.deliveryPricing === 'fixed' ? 'selected' : ''
        }>Valor fixo definido pela loja</option></select></label><label>Frete fixo (R$)<input name="deliveryPrice" type="number" min="0" step="0.01" value="${
          esc(s.deliveryPrice)
        }"></label></fieldset><fieldset><legend>Pagamento</legend>${
          [['pix', 'Online: Pix ou cartão via InfinitePay'], [
            'card_on_pickup',
            'Cartão na retirada / entrega',
          ], ['whatsapp', 'Combinar no WhatsApp']].map(([v, l]) =>
            `<label><input type="checkbox" name="paymentMethods" value="${v}" ${
              s.paymentMethods.includes(v) ? 'checked' : ''
            }> ${l}</label>`
          ).join('')
        }<p class="gestao-note">Desconto exclusivo Pix indisponível: o mesmo link aceita cartão. Nenhum desconto será anunciado sem aplicação no pagamento.</p></fieldset><p role="status" data-settings-result></p><button class="btn btn-primary" type="submit">Salvar configurações</button></form>`;
      settingsBox.querySelector('form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const button = e.target.querySelector('button[type="submit"]');
        button.disabled = true;
        const fd = new FormData(e.target);
        const value = {
          ...Object.fromEntries(fd),
          deliveryMethods: fd.getAll('deliveryMethods'),
          paymentMethods: fd.getAll('paymentMethods'),
          deliveryPrice: Number(fd.get('deliveryPrice')),
          pixDiscountPercent: 0,
        };
        try {
          const saved = await window.GestaoApi.saveSettings({ settings: value, revision });
          revision = saved.revision;
          settingsBox.querySelector('[data-settings-result]').textContent = 'Configurações salvas.';
        } catch (err) {
          settingsBox.querySelector('[data-settings-result]').textContent = err.message;
        } finally {
          button.disabled = false;
        }
      });
    } catch (err) {
      settingsBox.textContent = err.message;
    }
  }
  function dashboard(summary) {
    let box = document.querySelector('[data-dashboard-charts]');
    if (!box) {
      box = document.createElement('div');
      box.dataset.dashboardCharts = '';
      box.className = 'gestao-card';
      document.querySelector('[data-dashboard-extra]').after(box);
    }
    const days = summary.dailyRevenue || [], max = Math.max(1, ...days.map((d) => Number(d.total)));
    box.innerHTML = `<h2>Recebimentos nos últimos 7 dias</h2><div class="revenue-chart">${
      days.map((d) =>
        `<div class="revenue-column"><span>${money(d.total)}</span><div class="revenue-bar" style="height:${
          Math.round(Number(d.total) / max * 100)
        }px"></div><time>${esc(String(d.day).slice(5, 10).split('-').reverse().join('/'))}</time></div>`
      ).join('')
    }</div><p>Recebido na semana: <strong>${money(summary.revenueWeek)}</strong> · Em processamento: ${
      Number(summary.processingOrders || 0)
    } · Pagamentos com atenção: ${Number(summary.failedPayments || 0)}</p><h3>Pedidos por origem</h3><ul>${
      (summary.origins || []).map((o) => `<li>${esc(o.origin)}: ${Number(o.count)}</li>`).join('')
    }</ul><h3>Últimos pedidos</h3><div data-latest-orders>Carregando…</div>`;
    window.GestaoApi.listOrders({ limit: 5 }).then(({ items }) => {
      box.querySelector('[data-latest-orders]').innerHTML = items.length
        ? items.map((o) =>
          `<p>${esc(o.customerName || 'Cliente')} · ${money(o.total)} · ${
            esc(o.paymentStatus === 'paid' ? 'Pago' : 'Pagamento não confirmado')
          }</p>`
        ).join('')
        : 'Nenhum pedido registrado.';
    }).catch(() =>
      box.querySelector('[data-latest-orders]').textContent = 'Não foi possível carregar os pedidos.'
    );
  }
  function orderActions(order, reload) {
    const body = document.querySelector('[data-order-drawer-body]');
    const block = document.createElement('div');
    block.className = 'gestao-card';
    const phone = String(order.customerPhone || '').replace(/\D/g, '');
    block.innerHTML =
      `<div class="gestao-actions"><button type="button" class="btn btn-outline" data-copy>Copiar referência</button>${
        phone
          ? `<a class="btn btn-outline" href="https://wa.me/${
            phone.startsWith('55') ? phone : '55' + phone
          }" target="_blank" rel="noopener noreferrer">WhatsApp</a>`
          : ''
      }${
        order.paymentStatus === 'paid' && !order.blingId
          ? '<button type="button" class="btn btn-outline" data-action="sync">Sincronizar com Bling</button>'
          : ''
      }${
        ['failed', 'review'].includes(order.blingSyncStatus)
          ? '<button type="button" class="btn btn-outline" data-action="retry">Reprocessar</button>'
          : ''
      }${
        order.paymentStatus === 'pending' && !order.blingId
          ? '<button type="button" class="btn btn-outline" data-action="cancel">Cancelar pedido</button>'
          : ''
      }${
        order.blingId
          ? '<button type="button" class="btn btn-outline" data-action="release_reservation">Confirmar baixa no Bling</button>'
          : ''
      }</div><label>Motivo / evidência para a ação<input data-action-reason maxlength="500" placeholder="Obrigatório para cancelamento, reprocessamento ou baixa"></label><p class="gestao-note">Pagamentos não são confirmados manualmente aqui. Cancelamento com cobrança aberta precisa ser resolvido no provedor. Confirme a baixa somente após conferir o saldo do SKU no Bling.</p><p data-action-result role="status"></p><h3>Histórico</h3><ol>${
        (order.events || []).map((e) =>
          `<li>${esc(new Date(e.created_at).toLocaleString('pt-BR'))} · ${esc(e.kind)}${
            e.details?.reason ? ` — ${esc(e.details.reason)}` : ''
          }</li>`
        ).join('') || '<li>Nenhum evento registrado.</li>'
      }</ol>`;
    body.append(block);
    block.querySelector('[data-copy]').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(order.orderNumber || order.id);
        block.querySelector('[data-action-result]').textContent = 'Referência copiada.';
      } catch {
        block.querySelector('[data-action-result]').textContent = order.orderNumber || order.id;
      }
    });
    block.querySelectorAll('[data-action]').forEach((button) =>
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = await window.GestaoApi.orderAction({
            id: order.id,
            action: button.dataset.action,
            reason: block.querySelector('[data-action-reason]').value,
          });
          if (result.result === 'disabled') {
            block.querySelector('[data-action-result]').textContent =
              'Envio ao Bling ainda depende da validação operacional.';
          } else await reload(order.id);
        } catch (err) {
          block.querySelector('[data-action-result]').textContent = err.message;
        } finally {
          button.disabled = false;
        }
      })
    );
  }
  function customers(openOrder) {
    document.querySelectorAll('[data-customer-history]').forEach((button) =>
      button.addEventListener('click', async () => {
        const drawer = document.querySelector('[data-order-drawer]'),
          body = document.querySelector('[data-order-drawer-body]');
        drawer.hidden = false;
        document.querySelector('[data-order-drawer-overlay]').hidden = false;
        body.textContent = 'Carregando histórico…';
        try {
          const { items, total } = await window.GestaoApi.listOrders({
            phone: button.dataset.customerHistory,
            limit: 200,
          });
          body.innerHTML = `<h3>Histórico do cliente</h3><p>${total} pedidos · total pago nesta página: ${
            money(items.filter((o) => o.paymentStatus === 'paid').reduce((sum, o) => sum + o.total, 0))
          }</p>${
            items.map((o) =>
              `<p><button class="btn btn-outline" data-history-order="${esc(o.id)}">${
                esc(o.orderNumber || o.id.slice(0, 8))
              } · ${money(o.total)} · ${esc(o.paymentStatus)}</button></p>`
            ).join('')
          }`;
          body.querySelectorAll('[data-history-order]').forEach((b) =>
            b.addEventListener('click', () => openOrder(b.dataset.historyOrder))
          );
        } catch (err) {
          body.textContent = err.message;
        }
      })
    );
  }
  window.GestaoExtras = { loadSettings, dashboard, orderActions, customers };
})();
