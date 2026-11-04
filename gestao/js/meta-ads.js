/**
 * ANAROSA — Meta Ads Studio. Prévia local, aprovação explícita e
 * publicação exclusivamente PAUSADA na conta Meta autorizada.
 * Nenhum token, orçamento ou acesso à Graph API no navegador.
 */
(function () {
  'use strict';
  const root = document.querySelector('[data-meta-ads-root]');
  if (!root) return;
  const $ = (sel) => root.querySelector(sel);
  const form = $('[data-meta-ad-form]');
  const field = (name) => form.elements.namedItem(name);
  const escapeHtml = (v) => String(v == null ? '' : v).replace(/[&<>"']/g,
    (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  const state = { products:[], adsets:[], drafts:[], connected:false, busy:false };
  const notice = (message) => { $('[data-meta-ads-message]').textContent = message; };
  const format = (x) => Number(x || 0).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
  function setBusy(v) {
    state.busy = v;
    $$('button').forEach((button) => { button.disabled = v; });
  }
  function $$(selector) { return [...root.querySelectorAll(selector)]; }
  const product = () => state.products.find(p => String(p.blingId) === String(field('blingId').value));
  function defaultText(p) {
    return 'Conheça ' + p.name + ' na ANAROSA. Confira fotos, tamanhos, cores e disponibilidade antes de escolher a sua peça.';
  }
  function drawOptions(select, entries, placeholder) {
    const previous = select.value;
    select.replaceChildren();
    const first = document.createElement('option');
    first.value = ''; first.textContent = placeholder; select.append(first);
    for (const item of entries) {
      const opt = document.createElement('option');
      opt.value = String(item.id);
      opt.textContent = item.label;
      select.append(opt);
    }
    if (entries.some(e => String(e.id) === previous)) select.value = previous;
  }
  function drawPreview() {
    const p = product();
    const target = $('[data-meta-ad-preview]');
    if (!p) {
      target.innerHTML = '<p class="gestao-note">Escolha um produto da loja para gerar a prévia comercial.</p>';
      return;
    }
    const image = typeof p.image === 'string' && p.image.startsWith('https://') ? p.image : '';
    const headline = field('title').value.trim() || p.name;
    const body = field('primaryText').value.trim() || defaultText(p);
    const url = 'https://www.lojaanarosa.com.br/p/' + encodeURIComponent(p.slug) + '.html';
    target.innerHTML =
      (image ? '<img loading="lazy" src="' + escapeHtml(image) + '" alt="Foto real do produto" />'
        : '<div class="meta-ads-empty">Produto sem foto. Corrija o cadastro antes de criar o anúncio.</div>') +
      '<div class="meta-ads-copy"><strong>' + escapeHtml(headline) + '</strong>' +
      '<p>' + escapeHtml(body) + '</p><small>' + escapeHtml(format(p.promotionalPrice ?? p.price)) +
      ' · ' + escapeHtml(p.sku || 'Sem SKU') + '</small>' +
      '<small class="meta-ads-link">' + escapeHtml(url) + '</small>' +
      '<span class="meta-ads-cta">Comprar na ANAROSA</span></div>';
  }
  function emptyForm() {
    field('draftId').value = '';
    form.reset();
    field('title').value = '';
    field('primaryText').value = '';
    field('description').value = '';
    $('[data-meta-ad-save]').textContent = 'Salvar rascunho';
    drawPreview();
  }
  function renderDrafts() {
    const el = $('[data-meta-ad-list]');
    if (!state.drafts.length) {
      el.innerHTML = '<p class="gestao-note">Nenhum rascunho Meta cadastrado. Crie um pelo formulário ou diretamente pelo ChatGPT com o MCP ANAROSA.</p>';
      return;
    }
    const status = {
      draft:'Rascunho', approved:'Aprovado · não publicado', publishing:'Enviando à Meta',
      paused_on_meta:'Criado na Meta · PAUSADO', needs_reconciliation:'Verificar na Meta',
      error:'Revisar erro',
    };
    el.innerHTML = state.drafts.map(d => {
      const canApprove = d.status === 'draft' || d.status === 'error';
      const canPublish = d.status === 'approved' && state.connected && !!d.adset_id;
      return '<article class="meta-ad-card">' +
        '<div class="meta-ad-media">' +
        (String(d.image_url || '').startsWith('https://') ?
          '<img loading="lazy" alt="" src="' + escapeHtml(d.image_url) + '">':'') +
        '</div><div class="meta-ad-details"><div class="meta-ad-top"><strong>' +
        escapeHtml(d.title || d.product_name) + '</strong><span>' +
        escapeHtml(status[d.status] || d.status) + '</span></div>' +
        '<p>' + escapeHtml(d.primary_text || '') + '</p>' +
        '<small>SKU ' + escapeHtml(d.product_sku || d.bling_product_id) +
        ' · Revisão ' + escapeHtml(d.revision) +
        (d.adset_id ? ' · Conjunto ' + escapeHtml(d.adset_id) : ' · Sem conjunto Meta') +
        '</small>' +
        (d.meta_ad_id ? '<small>Anúncio Meta: ' + escapeHtml(d.meta_ad_id) + '</small>' : '') +
        (d.last_error ? '<p class="gestao-note">' + escapeHtml(d.last_error) + '</p>' : '') +
        '<div class="gestao-actions">' +
        ((d.status === 'draft' || d.status === 'error' || d.status === 'approved')
          ? '<button type="button" class="btn btn-outline" data-meta-edit="' + escapeHtml(d.id) + '">Editar</button>' : '') +
        (canApprove ? '<button type="button" class="btn btn-outline" data-meta-approve="' + escapeHtml(d.id) +
          '">Aprovar prévia</button>' : '') +
        (canPublish ? '<button type="button" class="btn btn-primary" data-meta-publish="' +
          escapeHtml(d.id) + '">Criar na Meta (PAUSADO)</button>' : '') +
        '</div></div></article>';
    }).join('');
  }
  function setAdsets() {
    drawOptions(field('adsetId'), state.adsets.map(a => ({
      id:a.id, label:String(a.name || a.id) + ' · ' + String(a.effective_status || a.status || 'status não informado'),
    })), state.connected ? 'Selecione um conjunto de anúncios' : 'Vincular após conectar a Meta');
  }
  async function load() {
    if (state.busy) return;
    notice('Carregando produtos, anúncios e autorização Meta…');
    try {
      const [p, s, d] = await Promise.all([
        window.GestaoApi.listProducts({ limit:100, offset:0 }),
        window.GestaoApi.metaAdsStatus(),
        window.GestaoApi.metaAdsList(),
      ]);
      state.products = (p.items || []).filter(i => !i.parentBlingId && i.active !== false);
      state.drafts = d.items || [];
      state.connected = !!s.connected;
      drawOptions(field('blingId'), state.products.map(p => ({
        id:p.blingId, label:p.name + ' · SKU ' + (p.sku || '—'),
      })), 'Escolha um produto');
      const label = state.connected ?
        'Meta: credenciais configuradas. Confirme os conjuntos e a autorização antes de publicar.' :
        'Meta: conta de anúncios ainda não autorizada na integração ANAROSA. Você já pode criar e aprovar rascunhos.';
      $('[data-meta-ads-status]').textContent = label;
      state.adsets = [];
      if (state.connected) {
        try {
          const sets = await window.GestaoApi.metaAdsAdsets();
          state.adsets = (sets.items || []).filter(i => i.id);
        } catch (e) {
          notice('Não foi possível consultar os conjuntos de anúncios: ' + (e.message || 'verifique Meta'));
        }
      }
      setAdsets();
      renderDrafts();
      drawPreview();
      if (!state.connected) notice('Para criar anúncios PAUSADOS na Meta, autorize a conta no servidor. Nenhum gasto foi realizado.');
      else if (!state.adsets.length) notice('Sem conjuntos de anúncios disponíveis. Configure o conjunto no Gerenciador de Anúncios.');
      else notice('Tudo pronto para elaborar as prévias, solicitar aprovação e publicar PAUSADO.');
    } catch (e) {
      notice('Não foi possível carregar Meta Ads Studio: ' + (e.message || 'erro na conexão'));
    }
  }
  form.addEventListener('input', (event) => {
    if (event.target.name === 'blingId') {
      const p = product();
      if (p && !field('draftId').value) {
        field('title').value = p.name.slice(0, 160);
        field('primaryText').value = defaultText(p).slice(0, 2200);
      }
    }
    if (['blingId','title','primaryText'].includes(event.target.name)) drawPreview();
  });
  form.addEventListener('change', (event) => {
    if (event.target.name === 'blingId') drawPreview();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.busy) return;
    const p = product();
    if (!p) return notice('Selecione um produto real da ANAROSA.');
    setBusy(true);
    try {
      const draft = await window.GestaoApi.metaAdsAction({
        action:'save',blingId:String(p.blingId),id:field('draftId').value || undefined,
        title:field('title').value, primaryText:field('primaryText').value,
        description:field('description').value, adsetId:field('adsetId').value,
      });
      notice(draft.message || 'Prévia salva; anúncio ainda não publicado.');
      emptyForm();
    } catch (e) {
      notice(e.message || 'Não foi possível salvar a prévia.');
    } finally { setBusy(false); await load(); }
  });
  $('[data-meta-new]').addEventListener('click', () => emptyForm());
  $('[data-meta-refresh]').addEventListener('click', load);
  $('[data-meta-ad-list]').addEventListener('click', async event => {
    const btn = event.target.closest('button[data-meta-edit],button[data-meta-approve],button[data-meta-publish]');
    if (!btn || state.busy) return;
    const id = btn.dataset.metaEdit || btn.dataset.metaApprove || btn.dataset.metaPublish;
    const draft = state.drafts.find(x => x.id === id);
    if (!draft) return;
    if (btn.dataset.metaEdit) {
      field('draftId').value = draft.id;
      field('blingId').value = draft.bling_product_id;
      field('title').value = draft.title;
      field('primaryText').value = draft.primary_text;
      field('description').value = draft.description || '';
      field('adsetId').value = draft.adset_id || '';
      $('[data-meta-ad-save]').textContent = 'Salvar nova revisão';
      drawPreview();
      form.scrollIntoView({behavior:'smooth',block:'start'});
      notice('Revise o texto e o conjunto. Salvar nova revisão anula qualquer aprovação anterior.');
      return;
    }
    const action = btn.dataset.metaApprove ? 'approve' : 'publish_paused';
    const explanation = action === 'approve' ?
      'Aprovar esta prévia?\n\n' + draft.title + '\n\n' +
      draft.primary_text + '\n\nDestino: ' + draft.destination_url +
      '\n\nA aprovação NÃO cria nem ativa anúncio.' :
      'Criar ESTE anúncio na Meta com status PAUSADO?\n\n' + draft.title +
      '\nConjunto: ' + (draft.adset_id || 'não selecionado') +
      '\n\nA operação escreve na Meta, mas NÃO ativa anúncio nem altera orçamento. ' +
      'Confirme também a conta e verba existentes no Gerenciador de Anúncios.';
    if (!window.confirm(explanation)) return;
    setBusy(true);
    try {
      const response = await window.GestaoApi.metaAdsAction({
        action,id:draft.id,revision:draft.revision,confirmar:true,
      });
      notice(response.message || 'Operação concluída.');
    } catch (e) {
      notice(e.message || 'Operação não confirmada. Verifique na Meta antes de repetir.');
    } finally { setBusy(false); await load(); }
  });
  window.AnarosaMetaAds = { load };
})();
