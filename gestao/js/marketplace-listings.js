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
  const state = { listings:[], products:[], connections:[], editing:null, loaded:false };
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
    return ownedVariants(selectedProduct()).map(v=>{
      const saved=current.get(String(v.blingId));
      const enabled=saved ? saved.enabled !== false : v.active !== false;
      const color=v.color || '—', size=v.size || '—';
      return `<div class="listing-variant-row" data-variation-id="${esc(v.blingId)}">
        <label><input type="checkbox" data-listing-variant-enabled ${enabled?'checked':''}> ${esc(color)} / ${esc(size)}</label>
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
    const productOptions=state.products.filter(p=>!p.parentBlingId).map(p=>
      `<option value="${esc(p.blingId)}">${esc(p.name)} (SKU ${esc(p.sku)})</option>`).join('');
    const form=$('[data-marketplace-form]');
    form.innerHTML=`
      <input type="hidden" name="id" value="${esc(item?.id || '')}">
      <div class="listing-form-grid">
        <label>Produto mestre do Bling *<select name="listing-product" required><option value="">Selecione um produto</option>${productOptions}</select></label>
        <label>Marketplace *<select name="marketplace"><option value="mercado_livre">Mercado Livre</option><option value="shopee">Shopee</option></select></label>
        <label>Título do anúncio *<input name="listing-title" maxlength="160" required placeholder="Ex.: Bermuda Ogochi Masculina"></label>
        <label>Preço do anúncio (R$) *<input name="listing-price" type="number" min="0.01" step="0.01" required></label>
        <label>Categoria do marketplace *<input name="listing-category" maxlength="60" placeholder="ID da categoria no canal"></label>
        <label>Tipo do anúncio<select name="listing-type"><option value="marketplace">Marketplace / Normal</option><option value="catalogo">Catálogo (Mercado Livre)</option></select></label>
        <label>Forma de envio *<input name="listing-shipping" maxlength="100" placeholder="Ex.: Mercado Envios / Shopee Xpress"></label>
        <label class="listing-span">Descrição<textarea name="listing-description" rows="4" maxlength="7000" placeholder="Descrição do anúncio, não altera a descrição no Bling"></textarea></label>
        <label class="listing-span">Fotos principais (uma URL HTTPS por linha)
          <textarea name="listing-images" rows="4" placeholder="https://…"></textarea>
          <small>Mercado Livre: a categoria determina os limites. Shopee: até 9 fotos principais. As imagens são enviadas ao Storage da ANAROSA.</small>
        </label>
        <label class="listing-span">Adicionar várias fotos
          <input type="file" data-listing-main-files multiple accept="image/jpeg,image/png,image/webp">
        </label>
        <div class="listing-span">
          <strong>Variações a anunciar e foto de cada opção</strong>
          <p class="gestao-note">A foto por variação é usada no rascunho comercial. Cada SKU permanece vinculado ao Bling, com estoque próprio. Salve o produto com variações antes de criar anúncios.</p>
          <div data-listing-variants class="listing-variant-grid"></div>
        </div>
        <label class="listing-span">Atributos exigidos pelo canal (JSON de pares simples)
          <textarea name="listing-attributes" rows="3" placeholder='{"BRAND":"Ogochi","GENDER":"Masculino"}'></textarea>
          <small>Use somente os atributos confirmados nas exigências da categoria do marketplace. Não são alterados no Bling.</small>
        </label>
      </div>
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
    drawProductDetails(item?.variation_mapping);
    updateConnectionMessage();
  }
  function drawProductDetails(variants) {
    const p=selectedProduct();
    $('[data-listing-variants]').innerHTML = p ? variantRows(variants) : '<p class="gestao-note">Selecione um produto primeiro.</p>';
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
    const status=c?.status === 'connected' ? 'Conta autorizada' : 'Conta ainda não autorizada';
    const note=$('[data-listing-publication-note]');
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
          <small>${connected.length?'Canal detectado no ERP; publicação pela Gestão ainda exige autorização específica.':'É necessário integrar a conta de vendedor ao Bling.'}</small>
        </div></div>`;
      }).join('');
      target.innerHTML=rows;
      message(response.message||'Canais consultados.','success');
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
      const status={draft:'Rascunho',ready:'Pronto para revisão',blocked:'Aguardando conexão',published:'Publicado',error:'Erro'}[x.status]||x.status;
      return `<div class="listing-record">
        <div><strong>${esc(x.title)}</strong><p>${esc(label[x.marketplace]||x.marketplace)} · ${esc(status)} · ${fmt(x.price)}</p>
        <small>Produto Bling ${esc(x.bling_product_id)}</small></div>
        <button type="button" class="btn btn-outline" data-listing-edit="${esc(x.id)}">Editar</button>
      </div>`;
    }).join('') : '<p class="gestao-note">Nenhum anúncio preparado. Cadastre o primeiro rascunho abaixo.</p>';
  }
  async function load() {
    if (!node) return;
    message('Consultando anúncios e produtos…');
    try {
      const [records,products] = await Promise.all([
        window.GestaoApi.listMarketplaceListings(), window.GestaoApi.listProducts({limit:100,offset:0}),
      ]);
      state.listings=records.items||[];
      state.products=products.items||[];
      state.connections=records.connections||[];
      listHTML();
      renderForm(state.editing ? state.listings.find(x=>x.id===state.editing) : null);
      state.loaded=true;
      message('Rascunhos e produtos carregados.');
    } catch(e) {
      message(e.message||'Não foi possível carregar os anúncios.','error');
    }
  }
  function collect() {
    const f=$('[data-marketplace-form]');
    const product=selectedProduct();
    if (!product) throw Error('Selecione o produto principal cadastrado no Bling.');
    let attributes={};
    try { attributes=JSON.parse(f['listing-attributes'].value || '{}'); } catch { throw Error('Os atributos precisam estar em JSON válido.'); }
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
      variations,attributes,
    };
  }
  async function save(action) {
    const buttons=[...$('[data-marketplace-form]').querySelectorAll('.listing-form-actions button')];
    buttons.forEach(b=>b.disabled=true);
    message(action==='publish'?'Verificando autorização e requisitos do canal…':'Salvando e validando anúncio…');
    try {
      const response=await window.GestaoApi.saveMarketplaceListing({...collect(),action});
      if (response.item?.id) state.editing=response.item.id;
      const missing=response.missing||[];
      await load();
      message(response.message+(missing.length?' Pendências: '+missing.join('; '):''),'success');
    }catch(err){
      const missing=Array.isArray(err.payload?.missing)?err.payload.missing:[];
      message((err.message||'Não foi possível salvar.')+(missing.length?' Pendências: '+missing.join('; '):''),'error');
    } finally { buttons.forEach(b=>b.disabled=false); }
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
    if (e.target.name==='listing-product'){state.editing=null;drawProductDetails();return;}
    if (e.target.name==='marketplace'){updateConnectionMessage();return;}
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
    if(button.matches('[data-listing-save]'))save('save');
    if(button.matches('[data-listing-prepare]'))save('prepare');
    if(button.matches('[data-listing-publish]'))save('publish');
  });
  window.MarketplaceListings={load};
})();
