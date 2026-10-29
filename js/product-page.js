/** ANAROSA · Página de produto dedicada. Fonte: storefront-product (Bling/Supabase). */
(function () {
  'use strict';
  const $ = (selector,root=document) => root.querySelector(selector);
  const $$ = (selector,root=document) => [...root.querySelectorAll(selector)];
  const format = (amount) => Number(amount||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
  const esc = (s) => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const placeholder = window.ANAROSA_CONFIG.placeholderImage || 'assets/products/placeholder.svg';
  const catalog = window.AnarosaCatalog.createCatalogService(window.ANAROSA_CONFIG);
  const cart = window.AnarosaCart.createCartService();
  const query = new URLSearchParams(location.search);
  const slug = query.get('slug');
  let item = null, images = [], photoIndex = 0, selected = null, whatsapp = '554730911041';
  const variantList = (p) => p?.variants?.items || [];
  const validImage = (src) => {
    try {
      const u = new URL(src||placeholder,location.href);
      if (u.protocol==='https:' || u.origin===location.origin) return u.href;
    } catch {}
    return new URL(placeholder,location.href).href;
  };
  const variantOut = (v) => v.available===false || (v.stock!=null && Number(v.stock)<=0);
  const itemOut = (p) => p.available===false || (p.stock!=null && Number(p.stock)<=0 && !variantList(p).some(v=>!variantOut(v)));
  const priceOf = (p,v) => Number(v?.promotionalPrice??v?.price??p.promotionalPrice??p.price);
  const originalPrice = (p,v) => Number(v?.price??p.price);
  const variantName = (v) => [v.color,v.size].filter(Boolean).join(' • ') || v.name || 'Opção';
  const productURL = () => new URL('produto.html?slug='+encodeURIComponent(slug||''),location.href).href;
  const feedback = (message,bad=false) => {
    const target=$('[data-feedback]');
    target.textContent=message;
    target.classList.toggle('is-error',bad);
  };
  function status(message,bad=false) {
    const el=$('[data-product-status]');
    el.hidden=false;
    el.textContent=message;
    el.classList.toggle('is-error',bad);
  }
  function setMain(index) {
    photoIndex=(index+images.length)%images.length;
    const photo=$('[data-main-image]');
    photo.src=validImage(images[photoIndex]);
    photo.alt=item.name+' — foto '+(photoIndex+1)+' de '+images.length;
    $('[data-image-count]').textContent=(photoIndex+1)+' / '+images.length;
    $('[data-gallery-prev]').hidden=images.length<2;
    $('[data-gallery-next]').hidden=images.length<2;
    $$('[data-thumbnail]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.thumbnail)===photoIndex)));
    $('[data-lightbox-img]').src=photo.src;
    $('[data-lightbox-img]').alt=photo.alt;
  }
  function renderImages() {
    images=(item.images||[]).filter(Boolean);
    if(!images.length)images=[item.image||placeholder];
    $('[data-thumbnails]').innerHTML=images.length<2 ? '' : images.map((src,index)=>
      '<button type="button" class="pdp-thumbnail" data-thumbnail="'+index+'" aria-pressed="'+(index===0)+'" aria-label="Ver foto '+(index+1)+' de '+images.length+'"><img src="'+esc(validImage(src))+'" alt="" width="70" height="85" loading="lazy"></button>'
    ).join('');
    setMain(0);
  }
  function stockText(v) {
    if (!item || itemOut(item)) return 'Indisponível no momento.';
    if (variantList(item).length && !v) return 'Selecione um tamanho ou cor para conferir a disponibilidade.';
    const subject=v||item;
    if(variantOut(subject))return 'Esta opção está esgotada.';
    if(subject.stock!=null) return Number(subject.stock)+' '+(Number(subject.stock)===1?'unidade disponível':'unidades disponíveis');
    return 'Disponibilidade confirmada na revisão do pedido.';
  }
  function updateBuy() {
    const many=variantList(item).length>0,chosen=many?selected:item;
    const ready=!!chosen && !itemOut(item) && !variantOut(chosen);
    const price=priceOf(item,selected),old=originalPrice(item,selected);
    $('[data-price]').textContent=format(price);
    $('[data-old-price]').hidden=!(price<old);
    $('[data-old-price]').textContent=price<old?format(old):'';
    $('[data-sku]').textContent='Código: '+(selected?.sku||item.sku||'Consulte a loja');
    $('[data-availability]').textContent=stockText(selected);
    $('[data-availability]').classList.toggle('is-unavailable',!!chosen&&!ready);
    $('[data-add-cart]').disabled=!ready;
    $('[data-add-cart]').textContent=itemOut(item)?'Peça indisponível':'Adicionar ao carrinho';
    const cap=chosen?.stock!=null?Math.min(20,Math.floor(Number(chosen.stock))):20;
    const qty=$('[data-quantity]');
    qty.max=Math.max(1,cap);
    qty.value=Math.max(1,Math.min(Number(qty.value)||1,Number(qty.max)));
    $$('[data-variant]').forEach(b=>b.setAttribute('aria-pressed',String(selected?.id===b.dataset.variant)));
    $('[data-option-error]').hidden=true;
  }
  function selectVariant(id) {
    const v=variantList(item).find(x=>String(x.id)===String(id));
    if(!v||variantOut(v))return;
    selected=v;updateBuy();feedback('');
  }
  function productDescription(value) {
    const template=document.createElement('template');
    template.innerHTML=String(value||'');
    template.content.querySelectorAll('script,style,iframe,object,template').forEach(n=>n.remove());
    template.content.querySelectorAll('br,p,div,li,h1,h2,h3,h4').forEach(n=>n.append(document.createTextNode('\n')));
    return (template.content.textContent||'').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  }
  function renderVariants() {
    const variants=variantList(item);
    $('[data-options-section]').hidden=!variants.length;
    if(!variants.length){selected=null;return;}
    $('[data-options]').innerHTML=variants.map(v=>{
      const out=variantOut(v);
      return '<button type="button" class="pdp-option" data-variant="'+esc(v.id)+'" aria-pressed="false" '+(out?'disabled':'')+'><span class="pdp-option-title">'+esc(variantName(v))+'</span><small>'+(out?'Esgotado':format(priceOf(item,v)))+'</small></button>';
    }).join('');
  }
  function renderRelated(list) {
    const others=(list||[]).filter(p=>p.slug!==item.slug).slice(0,4);
    if(!others.length)return;
    $('[data-related-grid]').innerHTML=others.map(p=>
      '<a class="pdp-related-item" href="produto.html?slug='+encodeURIComponent(p.slug)+'"><span class="pdp-related-image"><img src="'+esc(validImage(p.image))+'" alt="'+esc(p.name)+'" loading="lazy" width="320" height="400"></span><strong>'+esc(p.name)+'</strong><span>'+format(p.promotionalPrice??p.price)+'</span></a>'
    ).join('');
    $('[data-related]').hidden=false;
  }
  function updateCart() {
    const items=cart.getItems();
    $('[data-cart-count]').textContent=cart.getCount();
    $('[data-cart-heading-count]').textContent='('+cart.getCount()+')';
    $('[data-cart-subtotal]').textContent=format(cart.getSubtotal());
    $('[data-checkout-link]').hidden=!items.length;
    $('[data-cart-lines]').innerHTML=items.length?items.map(line=>
      '<div class="pdp-cart-line"><img src="'+esc(validImage(line.image))+'" alt="" loading="lazy"><div><strong>'+esc(line.name)+'</strong><p>'+esc([line.color,line.size].filter(Boolean).join(' · '))+'</p><span>'+line.quantity+' × '+format(line.unitPrice)+'</span><button type="button" data-remove-line="'+esc(line.key)+'">Remover</button></div></div>'
    ).join(''):'<p class="pdp-cart-empty">Seu carrinho está esperando por um novo momento. ♡</p>';
  }
  function toggleCart(show) {
    $('[data-cart-drawer]').hidden=!show;
    $('[data-cart-overlay]').hidden=!show;
    document.body.classList.toggle('pdp-locked',show);
    if(show){updateCart();$('[data-cart-close]').focus();}
  }
  function openLightbox(show) {
    $('[data-lightbox]').hidden=!show;
    document.body.classList.toggle('pdp-locked',show);
    if(show)$('[data-lightbox-close]').focus();
  }
  async function share() {
    const link=productURL();
    const data={title:item.name,text:'Olha essa peça da ANAROSA: '+item.name,url:link};
    if(navigator.share) {
      try {await navigator.share(data);return;} catch(e){if(e.name==='AbortError')return;}
    }
    try {await navigator.clipboard.writeText(link);feedback('Link do produto copiado! Compartilhe onde quiser.');}
    catch {feedback('Copie o link na barra de endereço para compartilhar.');}
  }
  function render() {
    document.title=item.name+' | ANAROSA';
    const meta=document.querySelector('meta[name="description"]');
    if(meta)meta.content=('Conheça '+item.name+'. Fotos, opções e disponibilidade na ANAROSA.').slice(0,155);
    $('[data-title]').textContent=item.name;
    $('[data-breadcrumb-product]').textContent=item.name;
    $('[data-category]').textContent=(item.categoryName||'Seleção Anarosa').toUpperCase();
    const desc=productDescription(item.description);
    $('[data-description]').textContent=desc||'Deseja conhecer o tecido, caimento ou medidas? Fale com nossa equipe pelo WhatsApp antes de comprar.';
    renderImages();
    renderVariants();
    updateBuy();
    $('[data-whatsapp]').href='https://wa.me/'+whatsapp+'?text='+encodeURIComponent('Olá! Tenho interesse na peça '+item.name+'. Gostaria de saber mais: '+productURL());
    $('[data-product-status]').hidden=true;
    $('[data-product-content]').hidden=false;
  }
  async function boot() {
    updateCart();
    if(!slug || slug.length>180){status('Produto não informado. Volte ao catálogo para escolher uma peça.',true);return;}
    try {
      item=await catalog.getProductBySlug(slug);
      if(!item){status('Não encontramos essa peça no momento. Volte ao catálogo para escolher outra.',true);return;}
      render();
      Promise.allSettled([
        catalog.getProducts(),
        (async()=>{const cfg=window.ANAROSA_CONFIG;const base=cfg.functionsBaseUrl||cfg.supabaseUrl.replace(/\/+$/,'')+'/functions/v1';const res=await fetch(base+'/storefront-settings',{headers:cfg.supabaseAnonKey?{apikey:cfg.supabaseAnonKey}:{}});if(!res.ok)return;const data=await res.json();const number=data.settings?.whatsapp;if(/^\d{10,15}$/.test(String(number||''))){whatsapp=String(number);$('[data-whatsapp]').href='https://wa.me/'+whatsapp+'?text='+encodeURIComponent('Olá! Tenho interesse na peça '+item.name+': '+productURL());}})(),
      ]).then(results=>{if(results[0].status==='fulfilled')renderRelated(results[0].value);});
    }catch {status('Não foi possível carregar os detalhes agora. Verifique sua conexão e tente novamente.',true);}
  }
  $('[data-thumbnails]').addEventListener('click',e=>{const b=e.target.closest('[data-thumbnail]');if(b)setMain(Number(b.dataset.thumbnail));});
  $('[data-gallery-next]').addEventListener('click',()=>setMain(photoIndex+1));
  $('[data-gallery-prev]').addEventListener('click',()=>setMain(photoIndex-1));
  $('[data-options]').addEventListener('click',e=>{const b=e.target.closest('[data-variant]');if(b)selectVariant(b.dataset.variant);});
  $('[data-quantity-minus]').addEventListener('click',()=>{const el=$('[data-quantity]');el.value=Math.max(1,Number(el.value||1)-1);});
  $('[data-quantity-plus]').addEventListener('click',()=>{const el=$('[data-quantity]');el.value=Math.min(Number(el.max)||20,Number(el.value||1)+1);});
  $('[data-add-cart]').addEventListener('click',()=>{
    if(!item)return;
    if(variantList(item).length && !selected){$('[data-option-error]').hidden=false;$('[data-options]').focus();feedback('Escolha uma opção antes de adicionar ao carrinho.',true);return;}
    const qty=Math.max(1,Math.min(20,Math.trunc(Number($('[data-quantity]').value)||1)));
    const before=cart.getCount();
    const result=cart.addItem(item,selected,qty);
    if(cart.getCount()<=before){feedback('Não foi possível adicionar além do estoque disponível.',true);return;}
    feedback(result.clamped?'Quantidade ajustada ao estoque disponível.':'Peça adicionada ao carrinho com sucesso!');
    toggleCart(true);
  });
  $('[data-share]').addEventListener('click',share);
  $('[data-cart-toggle]').addEventListener('click',()=>toggleCart(true));
  $('[data-cart-close]').addEventListener('click',()=>toggleCart(false));
  $('[data-cart-continue]').addEventListener('click',()=>toggleCart(false));
  $('[data-cart-overlay]').addEventListener('click',()=>toggleCart(false));
  $('[data-cart-lines]').addEventListener('click',e=>{const b=e.target.closest('[data-remove-line]');if(b)cart.removeItem(b.dataset.removeLine);});
  $('[data-zoom]').addEventListener('click',()=>openLightbox(true));
  $('[data-lightbox-close]').addEventListener('click',()=>openLightbox(false));
  $('[data-lightbox]').addEventListener('click',e=>{if(e.target===$('[data-lightbox]'))openLightbox(false);});
  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){if(!$('[data-lightbox]').hidden)openLightbox(false);else if(!$('[data-cart-drawer]').hidden)toggleCart(false);}
    if(!item || !$('[data-lightbox]').hidden)return;
    if(e.key==='ArrowRight'&&document.activeElement.closest('.pdp-gallery'))setMain(photoIndex+1);
    if(e.key==='ArrowLeft'&&document.activeElement.closest('.pdp-gallery'))setMain(photoIndex-1);
  });
  let startX=null;
  $('[data-zoom]').addEventListener('touchstart',e=>{startX=e.touches?.[0]?.clientX??null;},{passive:true});
  $('[data-zoom]').addEventListener('touchend',e=>{if(startX===null||images.length<2)return;const delta=(e.changedTouches?.[0]?.clientX??startX)-startX;startX=null;if(Math.abs(delta)>45){e.preventDefault();setMain(photoIndex+(delta<0?1:-1));}},{passive:false});
  document.addEventListener('error',e=>{if(e.target.tagName==='IMG'&&!e.target.dataset.failed){e.target.dataset.failed='1';e.target.src=placeholder;}},true);
  cart.onChange(updateCart);
  boot();
})();
