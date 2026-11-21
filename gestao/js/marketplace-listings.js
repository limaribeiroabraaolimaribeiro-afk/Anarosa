/**
 * ANAROSA · Anúncios por marketplace
 * Rascunhos rastreáveis, seleção de variantes e fotos. Nunca trata
 * rascunho/pronto como publicação efetiva no Mercado Livre/Shopee.
 */
(function () {
  'use strict';
  const $ = (q) => document.querySelector(q);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const label = { mercado_livre: 'Mercado Livre', shopee:'Shopee' };
  const state = { listings:[], products:[], connections:[], editing:null, loaded:false, channelInspectionAt:0, meliSchema:null, chartPreview:null };
  const node = $('[data-marketplace-root]');
  const message = (s, kind='') => {
    const el=$('[data-marketplace-message]');
    if (!el) return;
    el.textContent=s; el.dataset.kind=kind;
  };
  const selectedProduct = () => state.products.find(p=>String(p.blingId)===$('[name="listing-product"]').value);
  const ownedVariants = (p) => Array.isArray(p?.variants) ? p.variants : [];
  const productPhotos = (p) => [p?.image].filter(Boolean);
  const fmt = (v) => Number(v || 0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const connectionFor = (marketplace) => state.connections.find(c=>c.marketplace===marketplace);
  function variantRows(variations) {
    const current = new Map((variations||[]).map(v=>[String(v.blingId),v]));
    const ml=$('[data-marketplace-form]')?.marketplace?.value==='mercado_livre';
    const first=ownedVariants(selectedProduct()).find(v=>v.active!==false);
    return ownedVariants(selectedProduct()).map(v=>{
      const saved=current.get(String(v.blingId));
      const enabled=Array.isArray(variations) ? !!saved && saved.enabled!==false && v.active!==false :
        v.active!==false && (!ml || String(first?.blingId)===String(v.blingId));
      const color=v.color || '—', size=v.size || '—';
      return `<div class="listing-variant-row" data-variation-id="${esc(v.blingId)}">
        <label><input type="checkbox" data-listing-variant-enabled ${enabled?'checked':''} ${v.active===false?'disabled':''}> ${esc(color)} / ${esc(size)}</label>
        <small>SKU: ${esc(v.sku)} · ${fmt(v.price ?? selectedProduct().price)}</small>
        <label>Foto específica (HTTPS)
          <input type="url" data-listing-variant-photo value="${esc(saved?.image || '')}" placeholder="https://…">
        </label>
        <label class="listing-upload-small">Enviar foto da cor
          <input type="file" data-listing-variant-file accept="image/jpeg,image/png,image/webp">
        </label>
      </div>`;
    }).join('');
  }
  function renderForm(item = null) {
    state.editing = item?.id || null;
    state.meliSchema=null;
    state.chartPreview=null;
    const productOptions=state.products.filter(p=>!p.parentBlingId).map(p=>
      `<option value="${esc(p.blingId)}">${esc(p.name)} (SKU ${esc(p.sku)})</option>`).join('');
    const form=$('[data-marketplace-form]');
    form.innerHTML=`
      <input type="hidden" name="id" value="${esc(item?.id || '')}">
      <section class="listing-step listing-step-primary" aria-label="Informações principais">
        <div class="listing-step-heading">
          <span class="listing-step-number">01</span>
          <div><h3>Informações principais</h3><p>Comece escolhendo o produto e o canal de venda.</p></div>
        </div>
        <div class="listing-step-body">
          <div class="listing-form-grid">
            <label>Produto do Bling *<select name="listing-product" required><option value="">Selecione um produto</option>${productOptions}</select></label>
            <label>Onde anunciar *<select name="marketplace"><option value="mercado_livre">Mercado Livre</option><option value="shopee">Shopee</option></select></label>
            <div class="listing-product-preview" data-listing-product-preview hidden></div>
            <label class="listing-span">Título do anúncio *<input name="listing-title" maxlength="160" required placeholder="Ex.: Bermuda Boxer Ogochi Masculina"></label>
            <label>Preço de venda (R$) *<input name="listing-price" type="number" min="0.01" step="0.01" inputmode="decimal" required placeholder="0,00"></label>
          </div>
        </div>
      </section>
      <details class="listing-step" data-listing-step="category">
        <summary><span class="listing-step-number">02</span><span class="listing-step-summary"><strong>Categoria e envio</strong><small>Tipo de anúncio, categoria e frete</small></span><span class="listing-step-chevron" aria-hidden="true">⌄</span></summary>
        <div class="listing-step-body">
          <div class="listing-form-grid">
            <label>Categoria do marketplace *<input name="listing-category" maxlength="60" placeholder="Código da categoria"></label>
            <label>Tipo de anúncio<select name="listing-type"><option value="marketplace">Marketplace / Normal</option><option value="catalogo">Catálogo (Mercado Livre)</option></select></label>
            <label class="listing-span">Forma de envio *<input name="listing-shipping" maxlength="100" placeholder="Ex.: Mercado Envios"></label>
          </div>
        </div>
      </details>
      <details class="listing-step" data-listing-step="media">
        <summary><span class="listing-step-number">03</span><span class="listing-step-summary"><strong>Descrição, fotos e vídeo</strong><small>Mídia comercial vinculada ao produto</small></span><span class="listing-step-chevron" aria-hidden="true">⌄</span></summary>
        <div class="listing-step-body">
          <div class="listing-form-grid">
            <label class="listing-span">Descrição<textarea name="listing-description" rows="4" maxlength="7000" placeholder="Descreva o produto sem alterar o cadastro no Bling"></textarea></label>
            <label class="listing-span">Fotos principais (uma URL HTTPS por linha)
              <textarea name="listing-images" rows="4" placeholder="https://…"></textarea>
              <small>Mercado Livre: limite conforme a categoria. Shopee: até 9 fotos. Imagens salvas no Storage da ANAROSA.</small>
            </label>
            <label class="listing-span">Adicionar fotos do celular
              <input type="file" data-listing-main-files multiple accept="image/jpeg,image/png,image/webp">
            </label>
            <div class="listing-span listing-video-panel">
              <label>Vídeo demonstrativo do anúncio
                <select name="listing-video" data-listing-video-select><option value="">Sem vídeo selecionado</option></select>
              </label>
              <p class="gestao-note" data-listing-video-note aria-live="polite">Selecione um produto para consultar seus vídeos.</p>
              <div class="listing-video-preview" data-listing-video-preview></div>
              <p class="gestao-note">Mercado Livre Clips: 9:16, 10–60 segundos e áudio. Shopee: prefira MP4. Esta etapa prepara o vídeo, mas não o envia ao marketplace.</p>
              <div class="listing-video-actions">
                <a class="btn btn-outline" href="#/produtos">Cadastrar vídeo no produto</a>
                <a class="btn btn-outline" data-listing-video-source hidden target="_blank" rel="noopener noreferrer">Abrir vídeo selecionado</a>
                <a class="btn btn-outline" data-listing-clip-help target="_blank" rel="noopener noreferrer" href="https://www.mercadolivre.com.br/a/store/clips">Abrir Clips no Mercado Livre</a>
                <a class="btn btn-outline" data-listing-shopee-help target="_blank" rel="noopener noreferrer" hidden href="https://base.com/pt-BR/ajuda/knowledgebase/adicionando-videos-nos-anuncios-da-shopee/">Como adicionar vídeo ao anúncio Shopee</a>
              </div>
            </div>
          </div>
        </div>
      </details>
      <details class="listing-step" data-listing-step="variants">
        <summary><span class="listing-step-number">04</span><span class="listing-step-summary"><strong>Variações e atributos</strong><small>Tamanhos, cores, fotos por opção</small></span><span class="listing-step-chevron" aria-hidden="true">⌄</span></summary>
        <div class="listing-step-body">
          <div class="listing-form-grid">
            <div class="listing-span">
              <strong>Variações a anunciar</strong>
              <p class="gestao-note">Cada SKU mantém seu estoque no Bling. Mercado Livre User Products: uma variação por anúncio, com família comum. Na Shopee, selecione múltiplas opções.</p>
              <div data-listing-variants class="listing-variant-grid"></div>
            </div>
            <div class="listing-span" data-meli-panel>
              <button type="button" class="btn btn-outline" data-meli-category>Consultar atributos oficiais</button>
              <p class="gestao-note" data-meli-category-note aria-live="polite">Consulte a categoria para carregar os campos oficiais do Mercado Livre.</p>
              <div class="listing-form-grid" data-meli-fields></div>
              <details class="listing-step" data-meli-chart-panel>
                <summary>Tabela de medidas</summary>
                <div class="listing-step-body listing-form-grid">
                  <button type="button" class="btn btn-outline" data-meli-charts>Buscar tabelas compatíveis</button>
                  <button type="button" class="btn btn-outline" data-meli-chart-rows>Preparar tabela de calçados</button>
                  <p class="listing-span gestao-note" data-meli-chart-note aria-live="polite">Confirme marca, gênero e medidas reais de cada numeração.</p>
                  <div class="listing-span" data-meli-chart-results></div>
                  <div class="listing-span" data-meli-chart-editor></div>
                </div>
              </details>
            </div>
            <details class="listing-span" data-meli-json>
              <summary>Atributos avançados (JSON)</summary>
              <label>Características confirmadas do canal
                <textarea name="listing-attributes" rows="3" placeholder='{"BRAND":"Ogochi","GENDER":"Meninos"}'></textarea>
              </label>
            </details>
          </div>
        </div>
      </details>
      <div class="listing-form-actions">
        <button type="button" class="btn btn-outline" data-listing-save>Salvar rascunho</button>
        <button type="button" class="btn btn-outline" data-listing-prepare>Verificar para publicar</button>
        <button type="button" class="btn btn-primary" data-listing-publish>Publicar no marketplace</button>
      </div>
      <p class="gestao-note" data-listing-publication-note role="status"></p>
    `;
    form['listing-product'].value=String(item?.bling_product_id || '');
    form.marketplace.value=item?.marketplace || 'mercado_livre';
    form['listing-title'].value=item?.title || '';
    form['listing-price'].value=item?.price ?? '';
    form['listing-category'].value=item?.category_external_id || '';
    form['listing-type'].value=item?.listing_type || 'marketplace';
    form['listing-shipping'].value=item?.shipping_mode || '';
    form['listing-description'].value=item?.description || '';
    form['listing-images'].value=(item?.images || []).join('\n');
    form['listing-attributes'].value=JSON.stringify(item?.attributes||{},null,2);
    drawProductDetails(item?.variation_mapping, item?.video_url || '');
    if (item) form.querySelectorAll('.listing-step[open], .listing-step[data-listing-step]')
      .forEach(step=>{ if (step.tagName==='DETAILS') step.open=true; });
    updateConnectionMessage();
    if(item?.marketplace==='mercado_livre' && item.category_external_id) void loadMeliSchema();
  }

  function drawVideoPicker(product, preferred = '') {
    const form=$('[data-marketplace-form]');
    const select=form?.querySelector('[data-listing-video-select]');
    if(!select) return;
    const videos=Array.isArray(product?.videos) ? product.videos.filter(x=>typeof x==='string' && x.startsWith('https://')).slice(0,3) : [];
    const saved=preferred || (videos.includes(select.value)?select.value:'');
    select.replaceChildren();
    const empty=document.createElement('option');
    empty.value=''; empty.textContent='Sem vídeo selecionado'; select.append(empty);
    videos.forEach((url,i)=>{
      const option=document.createElement('option');
      option.value=url; option.textContent='Vídeo '+(i+1)+' · '+(url.endsWith('.mp4')?'MP4':'WebM');
      select.append(option);
    });
    select.value=videos.includes(saved)?saved:'';
    select.disabled=!videos.length;
    updateVideoPreview();
  }
  function updateVideoPreview() {
    const form=$('[data-marketplace-form]');
    if(!form) return;
    const select=form.querySelector('[data-listing-video-select]');
    const note=form.querySelector('[data-listing-video-note]');
    const preview=form.querySelector('[data-listing-video-preview]');
    const source=form.querySelector('[data-listing-video-source]');
    const ml=form.querySelector('[data-listing-clip-help]');
    const shopee=form.querySelector('[data-listing-shopee-help]');
    const url=select?.value||'';
    const channel=form.marketplace.value;
    ml.hidden=channel!=='mercado_livre';
    shopee.hidden=channel!=='shopee';
    preview.replaceChildren();
    source.hidden=!url;
    if(url)source.href=url;else source.removeAttribute('href');
    if(!selectedProduct()){
      note.textContent='Selecione um produto do Bling para usar seu vídeo correto.';
      return;
    }
    if(select.disabled){
      note.textContent='Este produto ainda não possui vídeo salvo. Vá a Produtos → Editar → Vídeos do produto, envie um MP4 e salve.';
      return;
    }
    if(!url){
      note.textContent='Vídeos disponíveis no produto. Escolha um para preparar o anúncio.';
      return;
    }
    const player=document.createElement('video');
    player.src=url; player.controls=true; player.playsInline=true; player.preload='metadata';
    player.setAttribute('aria-label','Prévia do vídeo do anúncio');
    preview.append(player);
    note.textContent='Vídeo selecionado no rascunho. Ainda não foi enviado ao marketplace.';
    player.addEventListener('loadedmetadata',()=>{
      const duration=player.duration,width=player.videoWidth,height=player.videoHeight;
      if(!Number.isFinite(duration)||!width||!height)return;
      const info=width+'×'+height+' · '+Math.round(duration)+' segundos';
      const problems=[];
      if(channel==='mercado_livre'){
        if(duration<10||duration>60)problems.push('Clips exige 10–60 segundos');
        if(height<=width||Math.abs(width/height-9/16)>0.08)problems.push('Clips exige vídeo vertical 9:16');
        if(width<360||height<640)problems.push('Clips exige no mínimo 360×640');
      }
      if(!url.toLowerCase().endsWith('.mp4'))problems.push('Use um vídeo MP4');
      note.textContent=info+(problems.length?' · '+problems.join('; '):' · prévia técnica compatível, sujeita à aprovação do canal');
    },{once:true});
    player.addEventListener('error',()=>{
      note.textContent='Não foi possível abrir a prévia. Verifique o vídeo no cadastro do produto.';
    },{once:true});
  }
  function drawProductDetails(variants, preferredVideo = '') {
    const p=selectedProduct();
    const preview=$('[data-listing-product-preview]');
    if (preview) {
      preview.hidden=!p;
      if (p) {
        const image=typeof p.image==='string' && /^https:\/\//i.test(p.image) ? p.image : '';
        preview.innerHTML=`${image?'<img src="'+esc(image)+'" alt="" loading="lazy">':''}
          <span><strong>${esc(p.name||'Produto do Bling')}</strong><small>SKU ${esc(p.sku||'—')} · ${fmt(p.price)}</small></span>`;
      } else preview.textContent='';
    }
    $('[data-listing-variants]').innerHTML = p ? variantRows(variants) : '<p class="gestao-note">Selecione um produto primeiro.</p>';
    drawVideoPicker(p, preferredVideo);
    if (p && !state.editing){
      const form=$('[data-marketplace-form]');
      if (!form['listing-title'].value) form['listing-title'].value=p.name;
      if (!form['listing-price'].value) form['listing-price'].value=p.price;
      if (!form['listing-images'].value) form['listing-images'].value=productPhotos(p).join('\n');
    }
  }
  function updateConnectionMessage() {
    const f=$('[data-marketplace-form]');
    const channel=f.marketplace.value, c=connectionFor(channel);
    const status=c?.status === 'connected' ? 'Conexão de publicação autorizada' : 'Publicação pela Gestão ainda não validada';
    const note=$('[data-listing-publication-note]');
    const panel=f.querySelector('[data-meli-panel]');
    if(panel)panel.hidden=channel!=='mercado_livre';
    note.textContent=`${label[channel]}: ${status}. Salvar e verificar estão disponíveis. A publicação exige a conexão oficial do canal e confirmação pela API; um rascunho não é anúncio publicado.`;
  }
  async function inspectBlingChannels() {
    const button=$('[data-listing-inspect]');
    const target=$('[data-listing-channel-list]');
    button.disabled=true;
    button.textContent='Consultando Bling…';
    target.textContent='Verificando as integrações de venda existentes…';
    try {
      const response=await window.GestaoApi.inspectMarketplaceChannels();
      if(!response.available) {
        target.textContent=response.message||'Não foi possível consultar os canais do Bling.';
        return;
      }
      const channels=response.channels||[];
      const rows=['mercado_livre','shopee'].map(channel=>{
        const connected=channels.filter(c=>c.marketplace===channel);
        const description=connected.length
          ? connected.map(c=>`${esc(c.name)} · Código Bling ${esc(c.blingChannelId)}`).join('; ')
          : 'Não identificado na API de canais do Bling';
        return `<div class="listing-record"><div><strong>${esc(label[channel])}</strong>
          <p>${description}</p>
          <small>${connected.length?'Canal identificado no Bling; publicação ainda depende de validação técnica.':'Canal ainda não identificado pelo Bling.'}</small>
        </div></div>`;
      }).join('');
      target.innerHTML=rows;
      const note=document.createElement('p');
      note.className='gestao-note';
      note.textContent=response.adsAvailable
        ? 'Leitura pelo Bling: '+(response.ads||[]).length+' anúncio(s) retornado(s), disponíveis também ao ChatGPT pelo MCP da Gestão. Nenhum anúncio foi alterado. Publicação direta precisa de autorização própria.'
        : (response.adsMessage || 'O endpoint de anúncios ainda não está disponível; canais detectados não equivalem a anúncios lidos.');
      target.append(note);
      if(response.adsAvailable && Array.isArray(response.ads) && response.ads.length){
        const list=document.createElement('div');
        list.className='listing-remote-list';
        list.setAttribute('aria-label','Anúncios Mercado Livre consultados no Bling');
        const heading=document.createElement('h3');
        heading.textContent='Anúncios Mercado Livre existentes (leitura Bling)';
        list.append(heading);
        response.ads.forEach(a=>{
          const row=document.createElement('div');
          row.className='listing-record';
          const title=document.createElement('strong');
          title.textContent=String(a.titulo||a.codigo||('Anúncio Bling '+a.id));
          const detail=document.createElement('p');
          const status={1:'Publicado',2:'Rascunho',3:'Com problema',4:'Pausado'}[Number(a.situacao)]||'Não informada';
          const price=typeof a.preco==='number'&&Number.isFinite(a.preco)?fmt(a.preco):'Sem preço';
          detail.textContent='Bling '+String(a.id||'—')+
            (a.externalListingId?' · '+String(a.externalListingId):' · Sem código externo')+
            ' · '+price+' · Situação no Bling: '+status+' (não conferida diretamente no Mercado Livre)';
          row.append(title,detail);
          list.append(row);
        });
        target.append(list);
      }
      state.channelInspectionAt=Date.now();
      message('Leitura via Bling concluída; publicar pela Gestão requer autorização direta.','success');
    }catch(err) {
      target.textContent='Não foi possível consultar os canais. '+(err.message||'Verifique a integração.');
    }finally{
      button.disabled=false;
      button.textContent='Verificar canais no Bling';
    }
  }
  function listHTML() {
    const list=$('[data-marketplace-list]');
    list.innerHTML=state.listings.length ? state.listings.map(x=>{
      const status=x.external_listing_id && x.status!=='published' ? 'Vínculo pendente de confirmação externa' :
        ({draft:'Rascunho',ready:'Pronto para revisão',blocked:'Aguardando conexão',published:'Publicado',error:'Erro'}[x.status]||x.status);
      return `<div class="listing-record">
        <div><strong>${esc(x.title)}</strong><p>${esc(label[x.marketplace]||x.marketplace)} · ${esc(status)} · ${fmt(x.price)}</p>
        <small>Produto Bling ${esc(x.bling_product_id)}${x.external_listing_id?' · '+esc(x.external_listing_id):''}${x.video_url?' · Vídeo selecionado (não enviado)':''}</small></div>
        <button type="button" class="btn btn-outline" data-listing-edit="${esc(x.id)}">Editar</button>
      </div>`;
    }).join('') : '<p class="gestao-note">Nenhum anúncio preparado. Cadastre o primeiro rascunho abaixo.</p>';
  }
  async function load() {
    if (!node) return;
    message('Consultando anúncios e produtos…');
    // Consultas independentes: uma falha temporária nos rascunhos não deve
    // deixar a página inteira vazia nem bloquear a leitura dos produtos.
    const [listingsResult, productsResult] = await Promise.allSettled([
      window.GestaoApi.listMarketplaceListings(),
      window.GestaoApi.listProducts({ limit: 100, offset: 0 }),
    ]);
    if (listingsResult.status === 'fulfilled') {
      const response = listingsResult.value;
      state.listings = Array.isArray(response.items) ? response.items : [];
      state.connections = Array.isArray(response.connections) ? response.connections : [];
      listHTML();
    } else {
      // Não afirmar "Nenhum anúncio" se a consulta falhou.
      $('[data-marketplace-list]').innerHTML =
        '<p class="gestao-note">Não foi possível consultar os anúncios salvos. Toque em Atualizar para tentar novamente.</p>';
    }
    if (productsResult.status === 'fulfilled') {
      const response = productsResult.value;
      state.products = Array.isArray(response.items) ? response.items : [];
      const linkSelect=$('[name="link-product"]');
      if(linkSelect) linkSelect.innerHTML='<option value="">Selecione um produto do Bling</option>'+
        state.products.filter(p=>!p.parentBlingId).map(p=>'<option value="'+esc(p.blingId)+'">'+esc(p.name)+' ('+esc(p.sku||'sem SKU')+')</option>').join('');
      renderForm(state.editing ? state.listings.find(x => x.id === state.editing) : null);
    } else {
      $('[data-marketplace-form]').innerHTML =
        '<p class="gestao-note">Os produtos do Bling estão temporariamente indisponíveis. Toque em Atualizar.</p>';
    }
    // Exibe anúncios reais lidos do Bling ao abrir a página.
    // Respeita um intervalo mínimo para não exceder limites do ERP.
    if (Date.now() - state.channelInspectionAt > 120000) void inspectBlingChannels();
    if (listingsResult.status === 'rejected' || productsResult.status === 'rejected') {
      const missing = [
        listingsResult.status === 'rejected' ? 'anúncios salvos' : '',
        productsResult.status === 'rejected' ? 'produtos do Bling' : '',
      ].filter(Boolean).join(' e ');
      message('Falha ao carregar ' + missing + '. Confira a conexão e toque em Atualizar.','error');
      return;
    }
    state.loaded = true;
    message('Rascunhos e produtos carregados.');
  }
  function formAttributes() {
    const input=$('[name="listing-attributes"]'); let a;
    try{a=JSON.parse(input.value||'{}');}catch{throw Error('Atributos avançados contêm JSON inválido.');}
    if(!a||typeof a!=='object'||Array.isArray(a))throw Error('Atributos inválidos.');
    return a;
  }
  function storeAttributes(a){
    $('[name="listing-attributes"]').value=JSON.stringify(a,null,2);
  }
  function clearChart(){
    state.chartPreview=null;
    const result=$('[data-meli-chart-results]'),editor=$('[data-meli-chart-editor]');
    if(result)result.replaceChildren();if(editor)editor.replaceChildren();
  }
  function selectedMeliVariant(f=$('[data-marketplace-form]')){
    const rows=[...f.querySelectorAll('[data-variation-id]')].filter(row=>row.querySelector('[data-listing-variant-enabled]').checked);
    if(rows.length!==1)throw Error('Selecione exatamente uma variação para este anúncio Mercado Livre.');
    const v=ownedVariants(selectedProduct()).find(x=>String(x.blingId)===rows[0].dataset.variationId);
    if(!v||v.active===false)throw Error('Variação Bling indisponível.');
    return v;
  }
  async function loadMeliSchema(){
    const f=$('[data-marketplace-form]'),target=f.querySelector('[data-meli-fields]'),note=f.querySelector('[data-meli-category-note]');
    if(f.marketplace.value!=='mercado_livre'||!target)return;
    const categoryId=f['listing-category'].value.trim();
    if(!/^MLB\d+$/.test(categoryId)){note.textContent='Informe o código oficial MLB da categoria.';return;}
    note.textContent='Consultando atributos na API oficial…';
    try{
      const data=await window.GestaoApi.mercadoLivreControl('category_schema',{categoryId});
      if(!f.isConnected||$('[data-marketplace-form]')!==f||f['listing-category'].value.trim()!==categoryId||f.marketplace.value!=='mercado_livre')return;
      if(!data.ok||!Array.isArray(data.attributes))throw Error(data.message||'Ficha técnica indisponível.');
      state.meliSchema=data;
      const attrs=formAttributes(), product=selectedProduct();
      if(!attrs.BRAND&&product?.brand)attrs.BRAND=product.brand;
      target.replaceChildren();
      const derived=new Set(['COLOR','SIZE','SELLER_SKU','SIZE_GRID_ID','SIZE_GRID_ROW_ID']);
      const definitions=data.attributes.filter(d=>!derived.has(d.id)&&!d.tags?.read_only&&!d.tags?.hidden&&(d.tags?.required||d.tags?.catalog_required||Object.hasOwn(attrs,d.id)||['GTIN','EMPTY_GTIN_REASON','ITEM_CONDITION'].includes(d.id)));
      for(const d of definitions){
        const labelEl=document.createElement('label');
        labelEl.textContent=d.name+(d.tags?.required?' *':'');
        let control;
        const values=d.values||[];
        if(d.value_type==='list'&&values.length){
          control=document.createElement('select');
          const empty=document.createElement('option');empty.value='';empty.textContent='Selecione';control.append(empty);
          for(const v of values){const opt=document.createElement('option');opt.value=String(v.name);opt.textContent=v.name;control.append(opt);}
          const selected=values.find(v=>String(v.id)===String(attrs[d.id])||String(v.name).toLowerCase()===String(attrs[d.id]||'').toLowerCase());
          control.value=selected?.name||'';
        }else{
          control=document.createElement('input');control.type='text';control.value=attrs[d.id]??'';control.maxLength=255;
        }
        control.dataset.meliAttribute=d.id;
        control.addEventListener('change',()=>{
          const current=formAttributes(),previous=current[d.id];
          if(control.value.trim())current[d.id]=control.value.trim();else delete current[d.id];
          if(['BRAND','GENDER'].includes(d.id)&&String(previous||'')!==control.value.trim()){
            delete current.SIZE_GRID_ID;delete current.SIZE_GRID_ROW_ID;clearChart();
          }
          storeAttributes(current);
        });
        labelEl.append(control);target.append(labelEl);
      }
      storeAttributes(attrs);
      note.textContent=(data.name||categoryId)+' · '+definitions.length+' campos oficiais carregados. Cor, tamanho e SKU vêm do Bling.';
      f.querySelector('[data-meli-chart-panel]').hidden=!data.attributes.some(d=>d.id==='SIZE_GRID_ID'||d.id==='SIZE_GRID_ROW_ID');
    }catch(err){note.textContent=err.message||'Falha ao consultar atributos oficiais.';}
  }
  function chartFilter(){
    const f=$('[data-marketplace-form]'),a=formAttributes();
    if(!a.BRAND||!a.GENDER)throw Error('Preencha a marca e o gênero oficiais primeiro.');
    return {categoryId:f['listing-category'].value.trim(),brand:String(a.BRAND),gender:String(a.GENDER)};
  }
  function chartRowFor(chart,variant){
    const norm=s=>String(s??'').toLowerCase().replace(/[^a-z0-9]/g,'').replace(/br$/,'');
    return (chart.rows||[]).find(row=>(row.attributes||[]).some(x=>['SIZE','BR_SIZE','MANUFACTURER_SIZE',chart.main_attribute_id].includes(x.id)&&(x.values||[]).some(v=>norm(v.name)===norm(variant.size))));
  }
  function renderCharts(charts){
    const target=$('[data-meli-chart-results]');target.replaceChildren();
    if(!charts.length){target.textContent='Nenhuma tabela compatível encontrada.';return;}
    for(const chart of charts){
      const row=document.createElement('div');row.className='listing-record';
      const info=document.createElement('span');info.textContent=(chart.names?.MLB||'Tabela')+' · ID '+chart.id;
      const btn=document.createElement('button');btn.type='button';btn.className='btn btn-outline';btn.textContent='Vincular à variação';
      btn.addEventListener('click',async()=>{
        try{
          const variant=selectedMeliVariant();
          const result=await window.GestaoApi.mercadoLivreControl('chart_detail',{chartId:String(chart.id)});
          const full=result.chart;if(!result.ok||!full)throw Error('Tabela oficial indisponível.');
          const match=chartRowFor(full,variant);
          if(!match)throw Error('A tabela não possui a numeração '+variant.size+'.');
          const a=formAttributes();a.SIZE_GRID_ID=String(full.id);a.SIZE_GRID_ROW_ID=String(match.id);storeAttributes(a);
          message('Tabela '+full.id+' vinculada ao tamanho '+variant.size+'. Salve o rascunho.','success');
        }catch(err){message(err.message,'error');}
      });
      row.append(info,btn);target.append(row);
    }
  }
  async function searchMeliCharts(){
    const note=$('[data-meli-chart-note]');note.textContent='Buscando tabelas oficiais…';
    try{
      const q=chartFilter(),result=await window.GestaoApi.mercadoLivreControl('chart_search',q);
      if(!result.ok)throw Error(result.message||'Consulta indisponível.');
      renderCharts(result.charts||[]);note.textContent='Consulta concluída. Vincule somente uma tabela que represente as medidas reais.';
    }catch(err){note.textContent=err.message;}
  }
  function openChartEditor(){
    clearChart();
    const target=$('[data-meli-chart-editor]'),p=selectedProduct();
    try{
      chartFilter();if(!p)throw Error('Escolha o produto.');
      const sizes=[...new Set(ownedVariants(p).filter(v=>v.active!==false).map(v=>String(v.size||'').trim()).filter(Boolean))];
      if(!sizes.length)throw Error('Nenhum tamanho ativo no Bling.');
      const name=document.createElement('input');name.type='text';name.maxLength=60;name.placeholder='Nome da tabela (letras, números e espaços)';
      name.value=(String(p.name||'').replace(/[^\p{L}\p{N} ]/gu,' ')+' medidas').slice(0,60).trim();
      const h=document.createElement('p');h.className='gestao-note';h.textContent='Informe somente medidas do pé confirmadas em centímetros. A criação definitiva exige aprovação separada.';
      target.append(h,name);
      const controls=[];
      sizes.forEach(size=>{const lab=document.createElement('label');lab.textContent=size+' · Comprimento do pé (cm)';
        const input=document.createElement('input');input.type='number';input.min='1';input.max='60';input.step='0.1';lab.append(input);target.append(lab);controls.push({size,input});});
      const prepare=document.createElement('button');prepare.type='button';prepare.className='btn btn-outline';prepare.textContent='Gerar prévia da tabela';
      prepare.addEventListener('click',async()=>{
        prepare.disabled=true;
        try{
          if(!state.editing)throw Error('Salve primeiro o rascunho do anúncio.');
          if(controls.some(x=>!x.input.value||!Number.isFinite(Number(x.input.value))))throw Error('Preencha todas as medidas confirmadas.');
          const rows=controls.map(x=>({size:x.size,footLengthCm:Number(x.input.value)}));
          const response=await window.GestaoApi.mercadoLivreControl('chart_prepare',{listingId:state.editing,name:name.value.trim(),rows});
          if(!response.ok||!response.intentId)throw Error(response.message||'Prévia não criada.');
          state.chartPreview=response;const summary=rows.map(x=>x.size+': '+x.footLengthCm+' cm').join('\n');
          if(!window.confirm('Revise a tabela '+response.payload.names.MLB+' ('+chartFilter().gender+'):\n'+summary+'\n\nCriar tabela definitiva no Mercado Livre? Esta operação não publica anúncios e não pode ser desfeita.'))return;
          const done=await window.GestaoApi.mercadoLivreControl('chart_create',{intentId:response.intentId,confirmar:true});
          if(!done.ok||!done.chartId)throw Error(done.message||'Não houve confirmação da criação.');
          message(done.message||'Tabela criada. Pesquise e vincule à variação.','success');await searchMeliCharts();
        }catch(err){message(formatMeliError(err),'error');}
        finally{prepare.disabled=false;}
      });
      target.append(prepare);
    }catch(err){message(err.message,'error');}
  }
  function formatMeliError(err){
    const payload=err.payload||{}, reasons=[...(payload.missing||[]),...(payload.invalid||[]).map(x=>x.name||x.id),...(payload.validation?.causes||payload.causes||[]).map(x=>x.message)].filter(Boolean);
    return (err.message||'Operação não concluída')+(reasons.length?' — '+reasons.join('; '):'')+(payload.uncertain?' Não repetir sem conferir o marketplace.':'');
  }

  function collect() {
    const f=$('[data-marketplace-form]');
    const product=selectedProduct();
    if (!product) throw Error('Selecione o produto principal cadastrado no Bling.');
    const attributes=formAttributes();
    const variations=[...f.querySelectorAll('[data-variation-id]')].map(row=>({
      blingId:row.dataset.variationId,
      enabled:row.querySelector('[data-listing-variant-enabled]').checked,
      image:row.querySelector('[data-listing-variant-photo]').value.trim(),
    }));
    return {
      id:state.editing, blingId:String(product.blingId),
      marketplace:f.marketplace.value,
      title:f['listing-title'].value.trim(),
      price:Number(f['listing-price'].value),
      categoryExternalId:f['listing-category'].value.trim(),
      listingType:f['listing-type'].value,shippingMode:f['listing-shipping'].value.trim(),
      description:f['listing-description'].value.trim(),
      images:f['listing-images'].value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),
      variations,attributes,videoUrl:f['listing-video'].value,
    };
  }
  async function save(action) {
    const buttons=[...$('[data-marketplace-form]').querySelectorAll('.listing-form-actions button')];
    buttons.forEach(b=>b.disabled=true);
    message(action==='publish'?'Verificando autorização e requisitos do canal…':'Salvando e validando anúncio…');
    try {
      const data=collect(),ml=data.marketplace==='mercado_livre';
      if(ml&&action!=='save')selectedMeliVariant();
      if(action==='publish'&&!ml)throw Error('Publicação automática da Shopee ainda não homologada. Salve o rascunho.');
      // Always save the reviewed data before validation/publication; the server uses only the saved draft.
      const prepared=await window.GestaoApi.saveMarketplaceListing({...data,action:action==='save'?'save':'prepare'});
      if(prepared.item?.id)state.editing=prepared.item.id;
      if(!prepared.ok)throw Error(prepared.message||'Rascunho não salvo.');
      if(ml&&action!=='save'){
        if(!state.editing)throw Error('Rascunho sem identificador.');
        const preview=await window.GestaoApi.mercadoLivreControl('validate_listing',{listingId:state.editing});
        if(!preview.ok||!preview.validated)throw Error(preview.message||'Validação oficial não confirmou o anúncio.');
        if(action==='prepare'){
          await load();message('Validação oficial concluída. Nenhum anúncio publicado.','success');return;
        }
        if(!window.confirm('Publicar em produção no Mercado Livre?\n'+data.title+'\nSKU: '+preview.sku+'\nEstoque: '+preview.quantity+'\nPreço: '+fmt(data.price)))return;
        const published=await window.GestaoApi.mercadoLivreControl('publish_listing',{listingId:state.editing,confirmar:true});
        await load();
        if(published.externalListingId)message((published.active?'Anúncio ativo: ':'Anúncio criado, conferir status: ')+published.externalListingId,published.active?'success':'');
        else message(published.message||'Publicação não confirmada; confira antes de repetir.','error');
        return;
      }
      const missing=prepared.missing||[];
      await load();
      message(prepared.message+(missing.length?' Pendências: '+missing.join('; '):''),'success');
    }catch(err){
      message(formatMeliError(err),'error');
      const form=$('[data-marketplace-form]');
      if(form)form.querySelectorAll('details.listing-step').forEach(step=>step.open=true);
    }finally{buttons.forEach(b=>b.disabled=false);}
  }
  async function uploadFile(file) {
    if (!file) return '';
    if (file.size>3*1024*1024) throw Error('Foto acima de 3 MB.');
    if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw Error('Formato inválido de imagem.');
    const response=await window.GestaoApi.uploadProductImage(file);
    const url=response.url||response.imageUrl;
    if (!url||!url.startsWith('https://')) throw Error('O servidor não retornou URL válida para a foto.');
    return url;
  }
  node.addEventListener('change',async e=>{
    const f=$('[data-marketplace-form]');
    if (e.target.name==='listing-product'){state.editing=null;state.meliSchema=null;clearChart();storeAttributes({});f.querySelector('[data-meli-fields]').replaceChildren();drawProductDetails();return;}
    if (e.target.name==='marketplace'){state.meliSchema=null;clearChart();f.querySelector('[data-meli-fields]').replaceChildren();drawProductDetails();updateConnectionMessage();updateVideoPreview();return;}
    if (e.target.name==='listing-category'){state.meliSchema=null;clearChart();f.querySelector('[data-meli-fields]').replaceChildren();void loadMeliSchema();return;}
    if(e.target.matches('[data-listing-variant-enabled]')&&f.marketplace.value==='mercado_livre'&&e.target.checked){
      f.querySelectorAll('[data-listing-variant-enabled]').forEach(x=>{if(x!==e.target)x.checked=false;});
      try{const a=formAttributes();delete a.SIZE_GRID_ROW_ID;storeAttributes(a);}catch{}
    }
    if (e.target.name==='listing-video'){updateVideoPreview();return;}
    if (e.target.matches('[data-listing-main-files]')) {
      const files=[...e.target.files];
      try {
        message('Enviando fotos para o Storage da ANAROSA…');
        const urls=[];
        for(const file of files)urls.push(await uploadFile(file));
        const lines=f['listing-images'].value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
        f['listing-images'].value=[...new Set([...lines,...urls])].join('\n');
        message(`${urls.length} foto(s) enviada(s) para a galeria.`,'success');
      }catch(err){message(err.message,'error');}
      finally{e.target.value='';} return;
    }
    if (e.target.matches('[data-listing-variant-file]')){
      const row=e.target.closest('[data-variation-id]');
      try{message('Enviando foto da variação…');row.querySelector('[data-listing-variant-photo]').value=await uploadFile(e.target.files[0]);message('Foto da variação enviada. Salve o anúncio para registrar.','success');}
      catch(err){message(err.message,'error');}
      finally{e.target.value='';}
    }
  });
  node.addEventListener('click',e=>{
    const button=e.target.closest('button');
    if(!button)return;
    if(button.matches('[data-listing-edit]')){
      const item=state.listings.find(v=>v.id===button.dataset.listingEdit);
      if(item){renderForm(item);$('[data-marketplace-form]').scrollIntoView({behavior:'smooth',block:'start'});}
    }
    if(button.matches('[data-listing-new]')){renderForm();message('Novo rascunho. Escolha um produto do Bling.');}
    if(button.matches('[data-listing-inspect]'))inspectBlingChannels();
    if(button.matches('[data-listing-refresh]'))load();
    if(button.matches('[data-meli-category]'))void loadMeliSchema();
    if(button.matches('[data-meli-charts]'))void searchMeliCharts();
    if(button.matches('[data-meli-chart-rows]'))openChartEditor();
    if(button.matches('[data-listing-save]'))save('save');
    if(button.matches('[data-listing-prepare]'))save('prepare');
    if(button.matches('[data-listing-publish]'))save('publish');
  });
  node.addEventListener('submit', async (event)=>{
    const form=event.target.closest('[data-listing-link-form]');
    if(!form)return;
    event.preventDefault();
    const product=form.elements['link-product'].value;
    const sku=form.elements['link-sku'].value.trim();
    const externalListingId=form.elements['link-mlb'].value.trim().toUpperCase();
    if(!/^MLB[0-9]{8,16}$/.test(externalListingId)){
      message('Informe um código MLB válido, sem espaços.','error');return;
    }
    if(!window.confirm('Vincular '+externalListingId+' ao SKU '+sku+' na Gestão ANAROSA? Isto não publica nem altera o anúncio no Mercado Livre.'))return;
    const button=form.querySelector('[data-listing-link-submit]');
    button.disabled=true;
    try {
      const result=await window.GestaoApi.linkMarketplaceListing({
        confirmar:true,blingId:product,sku,externalListingId,marketplace:'mercado_livre',
      });
      message(result.message||'Vínculo registrado.','success');
      form.reset();
      await load();
    }catch(err){message(err.message||'Não foi possível vincular.','error');}
    finally{button.disabled=false;}
  });
  window.MarketplaceListings={load};
})();
