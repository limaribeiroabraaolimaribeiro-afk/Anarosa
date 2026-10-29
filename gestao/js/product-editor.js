(function () {
  'use strict';
  const form = document.querySelector('[data-product-form]');
  const page = document.querySelector('[data-product-drawer]');
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  class ProductEditorValidationError extends Error {
    constructor(message) { super(message); this.name = 'ProductEditorValidationError'; }
  }
  const field = (name, label, attrs = '') => `<label>${label}<input name="${name}" ${attrs}></label>`;
  let revision = null, imagePermission = false, binaryUpload = false, imageIndex = 0, generation = 0;
  let pendingFiles = [], pendingPreviewUrls = [];
  let savedProduct = null, ready = false, busy = false;
  page.className = 'product-workspace';
  // Keep the editor inside the authenticated app, including during session expiry.
  document.querySelector('.gestao-main').append(page);
  page.replaceChildren(form);
  form.id = 'product-form';
  form.innerHTML = `
    <div class="product-page-head">
      <div><div class="product-breadcrumb"><button type="button" data-product-drawer-close>Produtos</button><span>›</span><span data-editor-breadcrumb>Novo produto</span></div>
      <h1 data-product-drawer-title>Novo Produto</h1><p>Cadastre um novo produto na sua loja e gerencie todas as informações em um só lugar.</p></div>
      <div class="product-head-actions">
        <button type="submit" class="btn btn-outline" data-save-draft>Salvar rascunho</button>
        <button type="button" class="btn btn-outline" data-preview-open>◉ &nbsp; Visualizar</button>
        <button type="submit" class="btn btn-primary" data-product-form-submit>Publicar produto</button>
      </div>
    </div>
    <p class="gestao-form-error" role="alert" data-product-form-error hidden></p>
    <p class="editor-loading" role="status" data-editor-loading>Carregando informações do produto…</p>
    <div class="product-layout">
      <div class="product-fields">
        <section class="product-section" id="product-photos" aria-labelledby="photos-title">
          <div class="section-heading"><div><h2 id="photos-title"><b>1.</b> Fotos do produto</h2><p>A primeira imagem será a principal do produto.</p></div><span class="photo-tip">Imagens nítidas, em WebP ou JPG.<br>Recomendado: 1200 × 1200 px.</span></div>
          <div class="product-gallery" data-editor-gallery></div>
          <div class="catalog-file-upload">
            <label for="catalog-image-files">Adicionar fotos do celular ou computador</label>
            <input id="catalog-image-files" type="file" accept="image/jpeg,image/png,image/webp" multiple data-image-files disabled>
            <p class="field-note">Até 12 fotos no total, JPG/PNG/WebP e até 3 MB por arquivo. Arquivos são enviados pelo painel ao salvar.</p>
            <div class="catalog-pending-photos" data-pending-photos aria-live="polite"></div>
          </div>
          <p class="field-note" data-image-capability></p>
          <details class="image-url-editor"><summary>Adicionar ou editar links de imagens</summary><label>Links HTTPS, um por linha (até 12)<textarea name="images" rows="3" placeholder="https://…"></textarea></label></details>
          <p class="field-note">O envio de fotos exige autorização no Bling e armazenamento configurado no Supabase. Se estiver indisponível, confira a conexão antes de cadastrar.</p>
        </section>
        <section class="product-section" id="product-basics" aria-labelledby="basics-title">
          <h2 id="basics-title"><b>2.</b> Informações básicas</h2>
          <div class="product-basic-grid">
            <label class="field-name">Nome do produto <em>*</em><input name="nome" required minlength="2" maxlength="120" placeholder="Ex.: Conjunto feminino de linho"></label>
            ${field('sku', 'SKU <em>*</em>', 'required maxlength="60" pattern="[A-Za-z0-9._\\-]+" title="Use letras, números, ponto, hífen ou sublinhado" placeholder="Código único"')}
            ${field('marca', 'Marca', 'maxlength="100" placeholder="Informe a marca"')}
            ${field('unidade', 'Unidade de venda', 'maxlength="6" placeholder="UN"')}
            ${field('gtin', 'GTIN/EAN da etiqueta oficial', 'maxlength="14" placeholder="SEM GTIN ou código do fabricante"')}
            <label>Categoria do Bling<select name="categoriaId" data-product-category-select><option value="">Sem categoria</option></select><button type="button" class="category-refresh" data-refresh-categories>↻ Atualizar do Bling</button></label>
            <label>Coleção da loja<input name="colecao" maxlength="80" placeholder="Ex.: Verão 2027"></label>
            <label class="field-segment">Segmento / gênero da loja<input name="segmento" maxlength="80" placeholder="Ex.: Feminino, infantil, unissex"></label>
            <label class="field-full short-description">Descrição curta<textarea name="descricaoCurta" maxlength="500" rows="2" placeholder="Apresente os detalhes que tornam esta peça especial."></textarea><span data-description-count>0/500</span></label>
            <label class="field-description" id="product-description">Descrição completa e medidas<textarea name="descricaoComplementar" rows="5" maxlength="10000" placeholder="Descreva o tecido, a modelagem, a composição e as medidas reais."></textarea></label>
            <fieldset class="field-tags"><legend>Tags de destaque na loja</legend>
              <div class="merchandising-tag-list">
                ${[['novo','Novidade'],['mais-vendido','Mais vendido'],['oferta','Oferta'],['escolha-da-semana','Escolha da semana'],['destaque','Destaque']].map(([value,label]) =>
                  `<label class="merchandising-tag"><input type="checkbox" name="storeTag" value="${value}"><span>${label}</span></label>`).join('')}
              </div>
              <small>Marcadores da vitrine ANAROSA, vinculados ao produto do Bling. Não alteram as tags internas do ERP.</small>
            </fieldset>
          </div>
        </section>
        <section class="product-section" id="product-pricing" aria-labelledby="pricing-title">
          <h2 id="pricing-title"><b>3.</b> Preço e vendas</h2>
          <div class="product-price-grid">
            ${field('preco', 'Preço de venda (R$) <em>*</em>', 'type="number" required min="0" step="0.01" placeholder="0,00"')}
            <label>Preço promocional da loja (R$)<input type="number" name="precoPromocional" min="0.01" step="0.01" placeholder="Opcional, menor que o preço normal"></label>
            <div class="price-note"><strong>Pagamento na loja</strong><span>Condições e parcelamento são apresentados no checkout.</span></div>
          </div>
          <label class="product-switch"><input type="checkbox" name="ativo" checked><span></span>Produto ativo após salvar</label>
          <p class="field-note">Rascunho deixa o produto inativo no Bling. Preço promocional e destaques são usados na loja ANAROSA; a tabela de preços do Bling não será alterada.</p>
        </section>
        <section class="product-section" id="product-variants" aria-labelledby="variants-title">
          <div class="section-heading"><div><h2 id="variants-title"><b>4.</b> Variações (Tamanhos e Cores)</h2><p>SKU e preço próprios para cada combinação.</p></div><button type="button" class="btn btn-outline btn-small" data-size-grid>Criar grade P a XG</button></div>
          <p class="field-note" data-product-form-variant-note hidden>Desative variações existentes para preservar o histórico e o estoque.</p>
          <div class="variant-table-wrap"><div data-editor-variants></div></div>
          <p class="variant-empty" data-variant-empty>Produto sem variações. Adicione os tamanhos e cores disponíveis.</p>
          <button type="button" class="btn btn-soft" data-add-variant>＋ Adicionar variação</button>
          <p class="field-note">GTIN / código de barras é diferente do SKU. Sua edição deve ser feita no Bling; este formulário não altera o GTIN.</p>
        </section>
        <section class="product-section" id="product-logistics" aria-labelledby="logistics-title">
          <div class="section-heading"><div><h2 id="logistics-title"><b>5.</b> Estoque e logística</h2><p>Ajuste o saldo por SKU e depósito no controle de estoque.</p></div><button type="button" class="btn btn-outline btn-small" data-editor-stock disabled>Ajustar estoque</button></div>
          <p class="field-note" data-stock-availability>Salve o produto para cadastrar estoque no depósito existente.</p>
          <div class="product-logistics-grid">${[
            ['pesoLiquido', 'Peso líquido (kg)'], ['pesoBruto', 'Peso bruto (kg)'], ['volumes', 'Volumes'],
            ['largura', 'Largura (cm)'], ['altura', 'Altura (cm)'], ['profundidade', 'Profundidade (cm)'],
          ].map(([name, label]) => field(name, label, `type="number" min="0" step="${name === 'volumes' ? '1' : '0.001'}"`)).join('')}</div>
          <details class="product-fiscal"><summary>Informações fiscais</summary><div class="product-logistics-grid">
            <label>Origem<select name="origem"><option value="">Não informada</option>${Array.from({ length: 9 }, (_, i) => `<option value="${i}">${i}</option>`).join('')}</select></label>
            ${field('ncm', 'NCM', 'inputmode="numeric" maxlength="8"')}${field('cest', 'CEST', 'inputmode="numeric" maxlength="7"')}
          </div><p class="field-note">Use as classificações conferidas com sua contabilidade.</p></details>
        </section>
      </div>
      <aside class="product-summary" aria-label="Prévia e situação do produto">
        <section class="product-section preview-card" tabindex="-1" data-product-preview>
          <div class="section-heading"><h2>Prévia do produto</h2><span class="preview-label">Visualização</span></div>
          <div class="preview-image"><img data-preview-image src="../assets/products/placeholder.svg" alt="Produto sem foto"><button type="button" data-preview-prev aria-label="Foto anterior">‹</button><button type="button" data-preview-next aria-label="Próxima foto">›</button></div>
          <div class="preview-dots" data-preview-dots></div>
          <h3 data-preview-name>Nome do produto</h3><p class="preview-description" data-preview-description>Os detalhes da sua peça aparecem aqui.</p>
          <strong class="preview-price" data-preview-price>R$ 0,00</strong><p class="field-note">Prévia das alterações do formulário.</p>
        </section>
        <section class="product-section"><div class="section-heading"><h2>Status do cadastro</h2><span class="product-status" data-product-status>Não salvo</span></div><p class="field-note" data-product-status-note>Este produto ainda não foi cadastrado.</p></section>
        <section class="product-section"><div class="section-heading"><h2>Checklist do produto</h2><span class="field-note" data-checklist-count>0 de 5</span></div><progress max="5" value="0" data-checklist-progress aria-label="Informações preenchidas"></progress><div class="product-checklist" data-product-checklist></div><p class="field-note">Conferência de preenchimento. Estoque e canais são verificados separadamente.</p></section>
        <section class="product-section"><h2>Canais de venda</h2><div class="product-channel"><span class="channel-symbol">♔</span><span>Loja Anarosa<small data-store-channel>Cadastro ainda não salvo</small></span></div><div class="product-channel"><span class="channel-symbol">M</span><span>Mercado Livre<small>Vínculo não informado pela integração</small></span></div><div class="product-channel"><span class="channel-symbol">S</span><span>Shopee<small>Vínculo não informado pela integração</small></span></div><a class="channel-link" href="#/integracao">Consultar integração Bling ↗</a></section>
      </aside>
    </div>
    <div class="product-footer"><button type="button" class="btn btn-outline" data-product-drawer-close>Voltar aos produtos</button><span class="field-note">As alterações são confirmadas após a resposta do Bling.</span></div>`;
  const $ = (selector) => form.querySelector(selector);
  const values = () => form.images.value.split('\n').map((s) => s.trim()).filter(Boolean);
  const photos = () => values().filter((url) => { try { return new URL(url).protocol === 'https:'; } catch { return false; } });
  const filesInput = $('[data-image-files]');
  const pendingContainer = $('[data-pending-photos]');
  function releasePreviews() {
    pendingPreviewUrls.forEach((url) => URL.revokeObjectURL(url));
    pendingPreviewUrls = [];
  }
  function showPendingFiles() {
    releasePreviews();
    pendingContainer.replaceChildren();
    pendingFiles.forEach((file) => {
      const figure = document.createElement('figure');
      const image = document.createElement('img');
      const caption = document.createElement('figcaption');
      const objectUrl = URL.createObjectURL(file);
      pendingPreviewUrls.push(objectUrl);
      image.src = objectUrl;
      image.alt = 'Foto selecionada aguardando envio';
      caption.textContent = file.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remover';
      remove.dataset.pendingPhotoRemove = String(pendingContainer.childElementCount);
      remove.setAttribute('aria-label', `Remover foto ${file.name} da seleção`);
      figure.append(image, caption, remove);
      pendingContainer.append(figure);
    });
  }
  pendingContainer.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-pending-photo-remove]');
    if (!remove || busy) return;
    pendingFiles.splice(Number(remove.dataset.pendingPhotoRemove), 1);
    $('[data-image-capability]').textContent = pendingFiles.length
      ? `${pendingFiles.length} foto(s) pronta(s) para enviar. Clique em Salvar para publicar.`
      : 'Selecione fotos do aparelho ou use links HTTPS; o envio ocorrerá ao salvar.';
    showPendingFiles();
    refresh();
  });
  filesInput.addEventListener('change', () => {
    const files = [...filesInput.files];
    if (!binaryUpload || !imagePermission) {
      filesInput.value = '';
      return;
    }
    filesInput.value = ''; // permite selecionar a mesma foto novamente após removê-la
    if (!files.length) return;
    const unique = files.filter((file) => !pendingFiles.some((existing) =>
      existing.name === file.name && existing.size === file.size &&
      existing.lastModified === file.lastModified));
    const combined = values().length + pendingFiles.length + unique.length;
    if (combined > 12 || unique.some((file) => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
        || file.size < 1 || file.size > 3 * 1024 * 1024)) {
      const note = $('[data-image-capability]');
      note.textContent = 'Selecione até 12 imagens no total, JPG, PNG ou WebP, com no máximo 3 MB cada.';
      return;
    }
    pendingFiles.push(...unique);
    $('[data-image-capability]').textContent = pendingFiles.length
      ? `${pendingFiles.length} foto(s) pronta(s) para enviar. Clique em Salvar para publicar.`
      : 'Selecione fotos do aparelho ou use links HTTPS; o envio ocorrerá ao salvar.';
    showPendingFiles();
    refresh();
  });
  function refresh() {
    const urls = photos();
    imageIndex = Math.max(0, Math.min(imageIndex, urls.length - 1));
    $('[data-preview-image]').src = urls[imageIndex] || '../assets/products/placeholder.svg';
    $('[data-preview-image]').alt = form.nome.value || 'Produto sem foto';
    $('[data-preview-name]').textContent = form.nome.value || 'Nome do produto';
    $('[data-preview-description]').textContent = form.descricaoCurta.value || 'Os detalhes da sua peça aparecem aqui.';
    const price = Number(form.preco.value) || 0;
    const sale = Number(form.precoPromocional.value);
    $('[data-preview-price]').textContent = form.precoPromocional.value && sale > 0 && sale < price
      ? `${money(sale)} · de ${money(price)}`
      : money(price);
    $('[data-description-count]').textContent = `${form.descricaoCurta.value.length}/500`;
    $('[data-preview-prev]').disabled = $('[data-preview-next]').disabled = urls.length < 2;
    $('[data-preview-dots]').textContent = urls.map((_, i) => i === imageIndex ? '●' : '○').join(' ');
    const rows = [...form.querySelectorAll('.variant-edit-row')];
    $('[data-variant-empty]').hidden = rows.length > 0;
    const checks = [
      ['Informações básicas', form.nome.value.trim().length >= 2 && form.sku.validity.valid && !!form.sku.value, 'product-basics'],
      ['Fotos do produto', (urls.length + pendingFiles.length) > 0 && urls.length === values().length && (urls.length + pendingFiles.length) <= 12, 'product-photos'],
      ['Descrição completa', !!form.descricaoComplementar.value.trim(), 'product-description'],
      ['Preço de venda', !!form.preco.value && form.preco.validity.valid, 'product-pricing'],
      ['Variações ou produto simples', !rows.length || rows.every((r) => [...r.querySelectorAll('input')].every((i) => i.validity.valid) && (r.querySelector('[data-v-size]').value.trim() || r.querySelector('[data-v-color]').value.trim())), 'product-variants'],
    ];
    const complete = checks.filter((c) => c[1]).length;
    $('[data-checklist-count]').textContent = `${complete} de 5 completos`;
    $('[data-checklist-progress]').value = complete;
    $('[data-product-checklist]').innerHTML = checks.map(([label, done, target]) =>
      `<button type="button" data-check-target="${target}"><span class="check-box ${done ? 'is-complete' : ''}" aria-label="${done ? 'Preenchido' : 'Pendente'}">${done ? '✓' : ''}</span>${label}<span>›</span></button>`).join('');
  }
  $('[data-preview-image]').addEventListener('error', (e) => {
    if (!e.target.src.endsWith('/placeholder.svg')) e.target.src = '../assets/products/placeholder.svg';
  });
  function gallery() {
    $('[data-editor-gallery]').innerHTML = photos().map((url, i) => `
      <figure class="gallery-photo" draggable="${imagePermission && !busy}" data-photo-index="${i}">
        <button type="button" class="photo-open" data-photo-open="${i}" aria-label="Visualizar foto ${i + 1}"><img src="${esc(url)}" alt="Foto ${i + 1} do produto"></button>
        ${i === 0 ? '<span class="primary-photo">♔ &nbsp; Imagem principal</span>' : ''}
        <div class="photo-actions"><button type="button" data-photo-main="${i}" ${!imagePermission || busy || i === 0 ? 'disabled' : ''} aria-label="Tornar foto ${i + 1} principal">☆</button><button type="button" data-photo-left="${i}" ${!imagePermission || busy || i === 0 ? 'disabled' : ''} aria-label="Mover foto ${i + 1} para a esquerda">←</button><button type="button" data-photo-right="${i}" ${!imagePermission || busy || i === photos().length - 1 ? 'disabled' : ''} aria-label="Mover foto ${i + 1} para a direita">→</button><button type="button" data-photo-remove="${i}" ${!imagePermission || busy ? 'disabled' : ''} aria-label="Excluir foto ${i + 1}">×</button></div>
      </figure>`).join('') + `<button type="button" class="photo-add" data-photo-add ${!imagePermission || busy ? 'disabled' : ''}><span>＋</span><strong>Adicionar fotos</strong><small>${binaryUpload ? 'Selecionar da galeria ou computador' : 'Inserir links de imagens'}</small></button>`;
    refresh();
  }
  function changePhotos(list) { form.images.value = list.join('\n'); gallery(); }
  let dragging = null;
  $('[data-editor-gallery]').addEventListener('dragstart', (e) => {
    dragging = Number(e.target.closest('[data-photo-index]')?.dataset.photoIndex);
    if (!imagePermission || busy || !Number.isInteger(dragging)) return e.preventDefault();
    e.dataTransfer.setData('text/plain', String(dragging));
  });
  $('[data-editor-gallery]').addEventListener('dragover', (e) => { if (imagePermission && !busy) e.preventDefault(); });
  $('[data-editor-gallery]').addEventListener('drop', (e) => {
    e.preventDefault();
    const target = e.target.closest('[data-photo-index]');
    if (!imagePermission || busy || dragging === null || !target) return;
    const list = photos(), [moved] = list.splice(dragging, 1);
    if (moved) { list.splice(Number(target.dataset.photoIndex), 0, moved); changePhotos(list); }
    dragging = null;
  });
  $('[data-editor-gallery]').addEventListener('dragend', () => { dragging = null; });
  function row(v = {}) {
    const el = document.createElement('div');
    el.className = 'variant-edit-row';
    el.dataset.variantId = v.id || '';
    const size = /(?:^|;)Tamanho:([^;]+)/i.exec(v.nome || '')?.[1] || '';
    const color = /(?:^|;)Cor:([^;]+)/i.exec(v.nome || '')?.[1] || '';
    el.innerHTML = `<label>Tamanho<input data-v-size value="${esc(size)}" maxlength="20" placeholder="M"></label><label>Cor<input data-v-color value="${esc(color)}" maxlength="30" placeholder="Bege"></label><label>SKU <em>*</em><input data-v-sku required pattern="[A-Za-z0-9._\\-]+" value="${esc(v.sku)}" maxlength="60"></label><label>Preço (R$) <em>*</em><input data-v-price required type="number" min="0" step="0.01" value="${esc(v.preco ?? form.preco.value)}"></label><span class="variant-balance">Saldo<small>${Number.isFinite(v.stock) ? esc(v.stock) : v.id ? 'Consultar' : 'Após salvar'}</small></span><label class="variant-active"><input data-v-active type="checkbox" ${v.ativo !== false ? 'checked' : ''}> Ativa</label>${v.id ? '<span class="field-note" title="Variação cadastrada">✓</span>' : '<button type="button" class="variant-remove" data-v-remove aria-label="Remover nova variação">×</button>'}`;
    $('[data-editor-variants]').append(el);
    refresh();
  }
  form.addEventListener('input', (e) => {
    form.querySelectorAll('[data-v-sku],[data-v-size],[data-v-color]').forEach((input) => input.setCustomValidity(''));
    if (e.target === form.images) gallery(); else refresh();
  });
  form.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    if (button.hasAttribute('data-add-variant')) { row(); $('[data-editor-variants]').lastElementChild.querySelector('input').focus(); }
    if (button.hasAttribute('data-size-grid')) {
      const existing = new Set([...form.querySelectorAll('[data-v-size]')].map((input) => input.value.trim().toUpperCase()));
      for (const size of ['P', 'M', 'G', 'GG', 'XG']) if (!existing.has(size)) row({ nome: `Tamanho:${size}`, sku: form.sku.value ? `${form.sku.value}-${size}` : '' });
    }
    if (button.hasAttribute('data-v-remove')) { button.closest('.variant-edit-row').remove(); refresh(); }
    if (button.dataset.checkTarget) document.getElementById(button.dataset.checkTarget)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (button.hasAttribute('data-preview-open')) { $('[data-product-preview]').scrollIntoView({ block: 'center', behavior: 'smooth' }); $('[data-product-preview]').focus({ preventScroll: true }); }
    if (button.hasAttribute('data-photo-open')) { imageIndex = Number(button.dataset.photoOpen); refresh(); $('[data-product-preview]').focus(); }
    if (button.hasAttribute('data-preview-prev') || button.hasAttribute('data-preview-next')) {
      imageIndex = (imageIndex + (button.hasAttribute('data-preview-prev') ? -1 : 1) + photos().length) % Math.max(photos().length, 1); refresh();
    }
    if (button.hasAttribute('data-photo-add')) {
      if (binaryUpload && !filesInput.disabled) filesInput.click();
      else { $('.image-url-editor').open = true; form.images.focus(); }
    }
    if (!imagePermission || busy) return;
    const action = ['Main', 'Left', 'Right', 'Remove'].find((key) => button.dataset['photo' + key] !== undefined);
    if (action) {
      const index = Number(button.dataset['photo' + action]), list = photos(), [url] = list.splice(index, 1);
      if (action !== 'Remove') list.splice(action === 'Main' ? 0 : index + (action === 'Left' ? -1 : 1), 0, url);
      changePhotos(list);
    }
  });
  function setBusy(value) {
    busy = value;
    page.setAttribute('aria-busy', String(value));
    $('[data-product-form-submit]').disabled = $('[data-save-draft]').disabled = value || !ready;
    form.querySelectorAll('.product-fields input, .product-fields select, .product-fields textarea, [data-add-variant], [data-size-grid], [data-editor-stock]').forEach((el) => {
      if (value) { el.dataset.wasDisabled = String(el.disabled); el.disabled = true; }
      else if (el.dataset.wasDisabled !== undefined) { el.disabled = el.dataset.wasDisabled === 'true'; delete el.dataset.wasDisabled; }
    });
    gallery();
  }
  window.AnaProductEditor = {
    reset() {
      pendingFiles = [];
      filesInput.value = '';
      releasePreviews();
      pendingContainer.replaceChildren();
      generation++;
      ready = false; busy = false; savedProduct = null; imagePermission = false; binaryUpload = false; revision = null; imageIndex = 0;
      form.querySelectorAll('[data-was-disabled]').forEach((el) => { el.disabled = el.dataset.wasDisabled === 'true'; delete el.dataset.wasDisabled; });
      $('[data-editor-variants]').replaceChildren();
      form.images.value = ''; form.images.disabled = true;
      form.colecao.value = '';
      form.segmento.value = '';
      form.precoPromocional.value = '';
      form.querySelectorAll('[name="storeTag"]').forEach((input) => { input.checked = false; });
      $('[data-editor-stock]').disabled = true;
      $('[data-stock-availability]').textContent = 'Salve o produto para cadastrar estoque no depósito existente.';
      $('[data-editor-loading]').hidden = false;
      $('[data-product-status]').textContent = 'Carregando';
      $('[data-product-status-note]').textContent = 'Consultando o cadastro e as permissões…';
      $('[data-image-capability]').textContent = 'Verificando permissão de imagens…';
      $('[data-store-channel]').textContent = 'Consultando cadastro…';
      $('[data-save-draft]').hidden = false;
      setBusy(true);
    },
    cancel() { pendingFiles = []; filesInput.value = ''; releasePreviews(); pendingContainer.replaceChildren(); generation++; },
    setBusy,
    async load(id, listing) {
      const request = generation;
      const response = await window.GestaoApi.getProductDetail(id || undefined);
      if (request !== generation) return false;
      const p = response.product;
      savedProduct = id ? p : null;
      revision = response.revision || null;
      imagePermission = response.capabilities?.images === true;
      binaryUpload = imagePermission && response.capabilities?.binaryUpload === true;
      for (const k of ['nome', 'sku', 'preco', 'marca', 'unidade', 'gtin', 'descricaoCurta', 'descricaoComplementar', 'pesoLiquido', 'pesoBruto', 'volumes']) {
        if (p[k] != null) form.elements[k].value = p[k];
      }
      if (id) { form.ativo.checked = p.ativo; form.categoriaId.value = p.categoriaId || ''; }
      form.colecao.value = p.merchandising?.colecao ?? '';
      form.segmento.value = p.merchandising?.segmento ?? '';
      form.precoPromocional.value = p.merchandising?.precoPromocional ?? '';
      const selectedTags = new Set(p.merchandising?.tags ?? []);
      form.querySelectorAll('[name="storeTag"]').forEach((input) => {
        input.checked = selectedTags.has(input.value);
      });
      const factor = Number(p.dimensoes?.unidadeMedida) === 0 ? 100 : Number(p.dimensoes?.unidadeMedida) === 2 ? 0.1 : 1;
      for (const k of ['largura', 'altura', 'profundidade']) form.elements[k].value = p.dimensoes?.[k] != null ? Number(p.dimensoes[k]) * factor : '';
      for (const k of ['origem', 'ncm', 'cest']) form.elements[k].value = p.tributacao?.[k] ?? '';
      for (const v of p.variacoes || []) row({ ...v, stock: listing?.variants?.find((item) => String(item.blingId) === String(v.id))?.stock });
      form.images.value = (p.images || []).join('\n');
      form.images.dataset.wasDisabled = String(!imagePermission);
      filesInput.dataset.wasDisabled = String(!binaryUpload);
      $('[data-image-capability]').textContent = !imagePermission
        ? 'Galeria em leitura: o Bling ainda não autorizou gravar imagens.'
        : binaryUpload ? 'Selecione fotos do aparelho ou use links HTTPS; o envio ocorrerá ao salvar.'
        : 'As URLs podem ser usadas, mas o upload de arquivos ainda precisa ser habilitado no Supabase.';
      $('[data-editor-loading]').hidden = true;
      $('[data-editor-breadcrumb]').textContent = id ? 'Editar produto' : 'Novo produto';
      $('[data-product-form-submit]').textContent = id ? 'Salvar alterações' : 'Publicar produto';
      $('[data-save-draft]').hidden = !!id;
      $('.product-switch').hidden = !id;
      $('[data-product-status]').textContent = id ? (p.ativo ? 'Ativo no Bling' : 'Inativo no Bling') : 'Não salvo';
      $('[data-product-status-note]').textContent = id ? 'Situação do último cadastro carregado. Alterações aguardam salvamento.' : 'Este produto ainda não foi cadastrado. Salve como rascunho ou publique na loja.';
      $('[data-store-channel]').textContent = id ? (p.ativo ? 'Cadastro ativo · vitrine depende da sincronização e estoque' : 'Cadastro inativo no Bling') : 'Cadastro ainda não salvo';
      $('[data-editor-stock]').dataset.wasDisabled = String(!id);
      $('[data-stock-availability]').textContent = id ? 'Os saldos da grade são os da listagem na abertura. Consulte e ajuste por depósito em “Ajustar estoque”. Salvar o cadastro não movimenta estoque.' : 'Salve o produto para cadastrar estoque no depósito existente.';
      ready = true; setBusy(false);
      return true;
    },
    fail() { $('[data-editor-loading]').hidden = true; $('[data-product-status]').textContent = 'Não carregado'; $('[data-product-status-note]').textContent = 'Não foi possível consultar o produto. Reabra o cadastro para tentar novamente.'; },
    async uploadSelectedPhotos() {
      if (!pendingFiles.length) return imagePermission ? values() : undefined;
      if (!binaryUpload || !imagePermission) throw new ProductEditorValidationError('Envio de arquivos não está habilitado nesta integração.');
      if (values().length + pendingFiles.length > 12) throw new ProductEditorValidationError('Máximo de 12 fotos por produto.');
      // Concluídos são retirados da fila. Uma falha posterior não reenvia a mesma imagem no retry.
      while (pendingFiles.length) {
        const photo = pendingFiles[0];
        const result = await window.GestaoApi.uploadProductImage(photo);
        if (!result?.url || !result.url.startsWith('https://')) {
          throw new ProductEditorValidationError('Não foi possível receber o link da foto enviada.');
        }
        const urls = values();
        if (!urls.includes(result.url)) urls.push(result.url);
        form.images.value = urls.join('\n');
        pendingFiles.shift();
        showPendingFiles();
        gallery();
      }
      filesInput.value = '';
      $('[data-image-capability]').textContent = 'Fotos enviadas. Salve o cadastro para vinculá-las ao produto no Bling.';
      return values();
    },
    read() {
      if (!ready || busy) throw new ProductEditorValidationError('Aguarde o carregamento do produto.');
      const skus = new Set([form.sku.value.trim().toLowerCase()]), combinations = new Set();
      const variacoes = [...form.querySelectorAll('.variant-edit-row')].map((el) => {
        const size = el.querySelector('[data-v-size]').value.trim(), color = el.querySelector('[data-v-color]').value.trim();
        const skuInput = el.querySelector('[data-v-sku]'), sku = skuInput.value.trim();
        if (!sku || skus.has(sku.toLowerCase())) { skuInput.setCustomValidity('Cada variação precisa de um SKU único, diferente do produto principal.'); skuInput.reportValidity(); throw new ProductEditorValidationError('Revise os SKUs das variações: existem códigos vazios ou repetidos.'); }
        skus.add(sku.toLowerCase());
        const combination = [size.toLowerCase(), color.toLowerCase()].join(';');
        if ((!size && !color) || /[;:]/.test(size + color) || combinations.has(combination)) throw new ProductEditorValidationError('Informe tamanho ou cor em cada variação, sem combinações repetidas ou os caracteres ; e :.');
        combinations.add(combination);
        return { id: el.dataset.variantId || undefined, nome: [size ? `Tamanho:${size}` : '', color ? `Cor:${color}` : ''].filter(Boolean).join(';'), sku, preco: Number(el.querySelector('[data-v-price]').value), ativo: el.querySelector('[data-v-active]').checked };
      });
      if (imagePermission && (values().length > 12 || values().some((url) => !photos().includes(url) || url.length > 1000))) throw new ProductEditorValidationError('Use até 12 links HTTPS válidos, com no máximo 1000 caracteres cada.');
      return {
        revision, unidade: form.unidade.value, gtin: form.gtin.value,
        merchandising: {
          tags: [...form.querySelectorAll('[name="storeTag"]:checked')].map((el) => el.value),
          colecao: form.colecao.value.trim(),
          segmento: form.segmento.value.trim(),
          precoPromocional: form.precoPromocional.value ? Number(form.precoPromocional.value) : null,
        },
        descricaoComplementar: form.descricaoComplementar.value,
        pesoLiquido: form.pesoLiquido.value, pesoBruto: form.pesoBruto.value, volumes: form.volumes.value,
        dimensoes: Object.fromEntries(['largura', 'altura', 'profundidade'].map((k) => [k, form.elements[k].value])),
        tributacao: Object.fromEntries(['origem', 'ncm', 'cest'].map((k) => [k, form.elements[k].value])),
        ...(imagePermission ? { images: values() } : {}), variacoes,
      };
    },
    get savedProduct() { return savedProduct; },
  };
  refresh();
})();
