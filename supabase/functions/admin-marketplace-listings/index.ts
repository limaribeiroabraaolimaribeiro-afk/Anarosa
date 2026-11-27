/**
 * Gestão de anúncios multicanal: armazena rascunhos validados ligados ao
 * produto fonte do Bling. Publicação exige adapter autorizado e certificado.
 * NUNCA marca um anúncio como publicado sem confirmação real do canal.
 */
import { serve } from '../_shared/context.ts';
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { ValidationError } from '../_shared/errors.ts';
import { isPublishedProductVideoUrl } from '../_shared/product-video.ts';

type Obj = Record<string, unknown>;
type Variant = { blingId: string; sku: string; color: string; size: string; enabled: boolean; image: string };
const text = (v: unknown, limit: number) => String(v ?? '').trim().slice(0, limit);
function urlImage(v: unknown): string {
  const str = text(v, 1000);
  if (!str) return '';
  try {
    const u = new URL(str);
    if (u.protocol !== 'https:' || u.username || u.password) throw Error('invalid');
    return u.toString();
  } catch { throw new ValidationError('As fotos precisam utilizar endereços HTTPS válidos.'); }
}
function uniqueImages(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw) || raw.length > max) throw new ValidationError(`Máximo de ${max} fotos no anúncio.`);
  return [...new Set(raw.map(urlImage).filter(Boolean))];
}
function dataObject(raw: unknown): Obj {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('Atributos inválidos.');
  const data = raw as Obj;
  if (JSON.stringify(data).length > 8000 || Object.keys(data).length > 35) throw new ValidationError('Atributos excedem o limite.');
  for (const [k, v] of Object.entries(data)) {
    if (!/^[a-zA-Z0-9_\-]{1,55}$/.test(k) || (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean'))
      throw new ValidationError('Informe características simples por código do marketplace.');
  }
  return data;
}

serve(async (req, ctx) => {
  const admin = await requireAdminUser(req, ctx.db);
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const id = text(url.searchParams.get('id'), 40);
    const [listings, connections] = await Promise.all([
      ctx.db.from('store_marketplace_listings')
        .select('id,bling_product_id,marketplace,title,description,category_external_id,listing_type,shipping_mode,price,images,variation_mapping,attributes,status,external_listing_id,external_url,last_error,updated_at,published_at,video_url,video_status,video_external_id')
        .order('updated_at', { ascending: false }).limit(150),
      ctx.db.from('store_marketplace_connections')
        .select('marketplace,status,external_store_name,verified_at'),
    ]);
    if (listings.error || connections.error) throw new Error('marketplace_listing_read_failed');
    return json(req, { ok: true, items: id ? (listings.data ?? []).filter(x => x.id === id) : listings.data ?? [], connections: connections.data ?? [] });
  }
  if (req.method !== 'POST') return methodNotAllowed(req, ['GET','POST']);
  const { data: permitted, error: rlError } = await ctx.db.rpc('rl_check_and_increment', {
    p_bucket: `marketplace-admin:${admin.id}`, p_limit: 25, p_window_seconds: 60,
  });
  if (rlError || permitted !== true) return json(req, { ok: false, message: 'Muitas operações. Tente novamente em instantes.' }, 429);
  const body = await req.json() as Obj;
  const action = text(body.action, 20);
  if (!['save','prepare','publish','link'].includes(action)) throw new ValidationError('Ação inválida.');
  const blingId = text(body.blingId, 19);
  if (!/^[1-9]\d{0,18}$/.test(blingId)) throw new ValidationError('Selecione um produto existente no Bling.');
  const channel = text(body.marketplace, 30);
  if (!['mercado_livre','shopee'].includes(channel)) throw new ValidationError('Canal inválido.');

  if (action === 'publish' && channel === 'mercado_livre' && body.familyVariantGreen === true) {
    if (body.confirmar !== true || blingId !== '16725286274' ||
        body.redItemId !== 'MLB5529252361') {
      return json(req,{ok:false,message:'Vínculo da família DUZIZO exige autorização explícita.'},400);
    }
    const app=Deno.env.get('SUPABASE_URL')||'';
    if(!app)return json(req,{ok:false,message:'Conexão Supabase indisponível.'},503);
    let remote:Response;
    try {
      remote=await fetch(app+'/functions/v1/mercadolivre-oauth-callback',{
        method:'POST',
        headers:{
          Authorization:req.headers.get('authorization')||'',
          apikey:Deno.env.get('SUPABASE_ANON_KEY')||'',
          'Content-Type':'application/json',
        },
        body:JSON.stringify({action:'link_green_family',redItemId:'MLB5529252361',confirmar:true}),
        signal:AbortSignal.timeout(110000),
      });
    }catch{
      return json(req,{ok:false,uncertain:true,
        message:'Publicador não respondeu; confira o vínculo antes de qualquer nova tentativa.'},502);
    }
    const answer=await remote.json().catch(()=>({
      ok:false,message:'Publicador retornou resposta não estruturada. Confira antes de repetir.'
    }));
    return json(req,answer,remote.status);
  }


  if (action === 'publish' && channel === 'mercado_livre' && body.mergeGreenFamily === true) {
    if (body.confirmar !== true || blingId !== '16725286274' ||
        body.redItemId !== 'MLB5529252361' || body.greenItemId !== 'MLB7960343796') {
      return json(req,{ok:false,message:'Confirme o vínculo entre os dois itens da família DUZIZO.'},400);
    }
    const app=Deno.env.get('SUPABASE_URL')||'';
    if(!app)return json(req,{ok:false,message:'Supabase indisponível.'},503);
    let remote:Response;
    try{
      remote=await fetch(app+'/functions/v1/mercadolivre-oauth-callback',{
        method:'POST',headers:{
          Authorization:req.headers.get('authorization')||'',
          apikey:Deno.env.get('SUPABASE_ANON_KEY')||'',
          'Content-Type':'application/json'
        },
        body:JSON.stringify({action:'merge_green_family',confirmar:true,
          redItemId:'MLB5529252361',greenItemId:'MLB7960343796'}),
        signal:AbortSignal.timeout(110000)
      });
    }catch{return json(req,{ok:false,uncertain:true,message:'Resposta de integração interrompida. Não repetir sem verificar famílias.'},502);}
    const result=await remote.json().catch(()=>({ok:false,message:'Sem confirmação estruturada do marketplace.'}));
    return json(req,result,remote.status);
  }


  if(action==='publish' && channel==='mercado_livre' && body.finalizeSeparatedColors===true){
    if(body.confirmar!==true||blingId!=='16725286274'||
      body.redItemId!=='MLB5529252361'||body.greenItemId!=='MLB7960343796')
      return json(req,{ok:false,message:'Confirmação do par de anúncios DUZIZO obrigatória.'},400);
    const host=Deno.env.get('SUPABASE_URL')||'';
    if(!host)return json(req,{ok:false,message:'Integração Supabase indisponível.'},503);
    let remote:Response;
    try{
      remote=await fetch(host+'/functions/v1/mercadolivre-oauth-callback',{
        method:'POST',
        headers:{Authorization:req.headers.get('authorization')||'',
          apikey:Deno.env.get('SUPABASE_ANON_KEY')||'',
          'Content-Type':'application/json'},
        body:JSON.stringify({action:'finalize_separate_colors',
          redItemId:'MLB5529252361',greenItemId:'MLB7960343796',confirmar:true}),
        signal:AbortSignal.timeout(110000)
      });
    }catch{return json(req,{ok:false,uncertain:true,message:'Verificação externa interrompida. Não repetir antes de conferir os anúncios.'},502);}
    const outcome=await remote.json().catch(()=>({ok:false,message:'Resposta externa não estruturada.'}));
    return json(req,outcome,remote.status);
  }


  if(action==='publish'&&channel==='mercado_livre'&&body.replaceRedGallery===true){
    if(body.confirmar!==true||blingId!=='16725286274'||body.redItemId!=='MLB5529252361')
      return json(req,{ok:false,message:'Confirme a substituição das quatro fotos do conjunto vermelho RN.'},400);
    const host=Deno.env.get('SUPABASE_URL')||'';
    if(!host)return json(req,{ok:false,message:'Integração indisponível.'},503);
    let response:Response;
    try{
      response=await fetch(host+'/functions/v1/mercadolivre-oauth-callback',{
        method:'POST',
        headers:{
          Authorization:req.headers.get('authorization')||'',
          apikey:Deno.env.get('SUPABASE_ANON_KEY')||'',
          'Content-Type':'application/json'
        },
        body:JSON.stringify({action:'replace_red_gallery',itemId:'MLB5529252361',confirmar:true}),
        signal:AbortSignal.timeout(110000)
      });
    }catch{
      return json(req,{ok:false,uncertain:true,
        message:'Resposta da troca das fotos interrompida; consulte o anúncio antes de repetir.'},502);
    }
    const result=await response.json().catch(()=>({
      ok:false,message:'Resultado não estruturado; confira a galeria antes de repetir.'
    }));
    return json(req,result,response.status);
  }


  if(action==='publish'&&channel==='mercado_livre'&&body.diagnoseRedGallery===true){
    if(body.confirmar!==true||blingId!=='16725286274'||body.redItemId!=='MLB5529252361')
      return json(req,{ok:false,message:'Diagnóstico autorizado apenas para o vermelho.'},400);
    const host=Deno.env.get('SUPABASE_URL')||'';
    if(!host)return json(req,{ok:false,message:'Integração indisponível.'},503);
    let res:Response;
    try{
      res=await fetch(host+'/functions/v1/mercadolivre-oauth-callback',{
        method:'POST',headers:{
          Authorization:req.headers.get('authorization')||'',
          apikey:Deno.env.get('SUPABASE_ANON_KEY')||'',
          'Content-Type':'application/json'
        },
        body:JSON.stringify({action:'diagnose_red_gallery',itemId:'MLB5529252361',confirmar:true}),
        signal:AbortSignal.timeout(30000)
      });
    }catch{return json(req,{ok:false,message:'Falha na consulta do arquivo.'},502);}
    const result=await res.json().catch(()=>({ok:false,message:'Sem resposta estruturada.'}));
    return json(req,result,res.status);
  }


  if(action==='publish'&&channel==='mercado_livre'&&body.diagnoseGreenGallery===true){
    if(body.confirmar!==true||blingId!=='16725286274'||body.greenItemId!=='MLB7960343796')
      return json(req,{ok:false,message:'Diagnóstico autorizado apenas para a galeria verde DUZIZO.'},400);
    const host=Deno.env.get('SUPABASE_URL')||'';
    if(!host)return json(req,{ok:false,message:'Integração indisponível.'},503);
    let res:Response;
    try{
      res=await fetch(host+'/functions/v1/mercadolivre-oauth-callback',{
        method:'POST',headers:{Authorization:req.headers.get('authorization')||'',
          apikey:Deno.env.get('SUPABASE_ANON_KEY')||'', 'Content-Type':'application/json'},
        body:JSON.stringify({action:'diagnose_green_gallery',itemId:'MLB7960343796',confirmar:true}),
        signal:AbortSignal.timeout(100000)
      });
    }catch{return json(req,{ok:false,message:'Falha ao verificar arquivos do verde.'},502);}
    const result=await res.json().catch(()=>({ok:false,message:'Sem resposta estruturada.'}));
    return json(req,result,res.status);
  }

  if(action==='publish'&&channel==='mercado_livre'&&body.replaceGreenGallery===true){
    if(body.confirmar!==true||blingId!=='16725286274'||body.greenItemId!=='MLB7960343796')
      return json(req,{ok:false,message:'Confirme a troca das quatro fotos do conjunto verde P.'},400);
    const host=Deno.env.get('SUPABASE_URL')||'';
    if(!host)return json(req,{ok:false,message:'Integração indisponível.'},503);
    let res:Response;
    try{
      res=await fetch(host+'/functions/v1/mercadolivre-oauth-callback',{
        method:'POST',headers:{Authorization:req.headers.get('authorization')||'',
          apikey:Deno.env.get('SUPABASE_ANON_KEY')||'', 'Content-Type':'application/json'},
        body:JSON.stringify({action:'replace_green_gallery',itemId:'MLB7960343796',confirmar:true}),
        signal:AbortSignal.timeout(110000)
      });
    }catch{return json(req,{ok:false,uncertain:true,
      message:'Resposta da troca de fotos interrompida: conferir o anúncio antes de repetir.'},502);}
    const result=await res.json().catch(()=>({ok:false,uncertain:true,message:'Sem confirmação estruturada do Mercado Livre.'}));
    return json(req,result,res.status);
  }


  if (action==='publish' && channel==='mercado_livre' && body.ogochiGalleryProbe===true) {
    if(body.confirmar!==true||blingId!=='16720620962')return json(req,{ok:false,message:'Confirmação do produto Ogochi obrigatória.'},403);
    const app=Deno.env.get('SUPABASE_URL')||'';
    if(!app)return json(req,{ok:false,message:'Integração indisponível.'},503);
    try{
      const res=await fetch(app+'/functions/v1/mercadolivre-oauth-callback',{
       method:'POST',headers:{Authorization:req.headers.get('authorization')||'',
         apikey:Deno.env.get('SUPABASE_ANON_KEY')||'','Content-Type':'application/json'},
       body:JSON.stringify({action:'ogochi_probe',confirmar:true,includeImage:body.includeImage===true,imageIndex:Number(body.imageIndex||0),previewProcessed:body.previewProcessed===true,checkOriginal:body.checkOriginal===true,checkThumbnail:body.checkThumbnail===true,itemId:String(body.ogochiProbeItemId||'MLB5409091633'),imageVariant:String(body.imageVariant||'F')}),
       signal:AbortSignal.timeout(105000)});
      const data=await res.json().catch(()=>({ok:false,message:'Resposta inválida da API.'}));
      return json(req,data,res.status);
    }catch{return json(req,{ok:false,message:'Não foi possível inspecionar as fotos.'},502);}
  }


  if (action==='publish' && channel==='mercado_livre' && body.ogochiTransformProbe===true) {
    if(body.confirmar!==true||blingId!=='16720620962')return json(req,{ok:false,message:'Confirmação exigida.'},403);
    const host=Deno.env.get('SUPABASE_URL')||'';
    if(!host)return json(req,{ok:false,message:'Função indisponível.'},503);
    try{
      const res=await fetch(host+'/functions/v1/mercadolivre-oauth-callback',{
       method:'POST',headers:{Authorization:req.headers.get('authorization')||'',
        apikey:Deno.env.get('SUPABASE_ANON_KEY')||'','Content-Type':'application/json'},
       body:JSON.stringify({action:'ogochi_transform_probe',confirmar:true}),
       signal:AbortSignal.timeout(110000)});
      return json(req,await res.json().catch(()=>({ok:false,message:'Sem resposta'})),res.status);
    }catch{return json(req,{ok:false,message:'Falha no processamento de imagens.'},502);}
  }


  if(action==='publish'&&channel==='mercado_livre'&&body.ogochiGalleryPrepare===true){
    if(body.confirmar!==true||blingId!=='16720620962')
      return json(req,{ok:false,message:'Confirmação da preparação Ogochi obrigatória.'},403);
    const host=Deno.env.get('SUPABASE_URL')||'';
    if(!host)return json(req,{ok:false,message:'Integração indisponível.'},503);
    try{
      const response=await fetch(host+'/functions/v1/mercadolivre-oauth-callback',{
        method:'POST',headers:{
          Authorization:req.headers.get('authorization')||'',
          apikey:Deno.env.get('SUPABASE_ANON_KEY')||'','Content-Type':'application/json'},
        body:JSON.stringify({action:'ogochi_gallery_prepare',confirmar:true}),
        signal:AbortSignal.timeout(110000)
      });
      return json(req,await response.json().catch(()=>({ok:false,message:'Resposta inválida'})),response.status);
    }catch{return json(req,{ok:false,message:'Preparação de fotos interrompida.'},502);}
  }


  if(action==='publish'&&channel==='mercado_livre'&&body.ogochiGalleryPublish===true){
    if(body.confirmar!==true||blingId!=='16720620962')
      return json(req,{ok:false,message:'Confirmação de substituição Ogochi necessária.'},403);
    const host=Deno.env.get('SUPABASE_URL')||'';
    if(!host)return json(req,{ok:false,message:'Supabase não configurado.'},503);
    try{
      const response=await fetch(host+'/functions/v1/mercadolivre-oauth-callback',{
        method:'POST',
        headers:{Authorization:req.headers.get('authorization')||'',
          apikey:Deno.env.get('SUPABASE_ANON_KEY')||'','Content-Type':'application/json'},
        body:JSON.stringify({action:'ogochi_gallery_publish',confirmar:true,dryRun:body.dryRun===true}),
        signal:AbortSignal.timeout(110000)
      });
      const answer=await response.json().catch(()=>({ok:false,message:'Resposta não estruturada.'}));
      return json(req,answer,response.status);
    }catch{
      return json(req,{ok:false,uncertain:true,message:'Resposta interrompida. Verifique os anúncios antes de repetir.'},502);
    }
  }


  if(action==='publish'&&channel==='mercado_livre'&&body.ogochiFamilyDiagnose===true){
    if(body.confirmar!==true||blingId!=='16720620962')
      return json(req,{ok:false,message:'Diagnóstico autorizado apenas para Ogochi.'},403);
    const host=Deno.env.get('SUPABASE_URL')||'';
    if(!host)return json(req,{ok:false,message:'Integração indisponível.'},503);
    try{
      const response=await fetch(host+'/functions/v1/mercadolivre-oauth-callback',{
       method:'POST',headers:{Authorization:req.headers.get('authorization')||'',
        apikey:Deno.env.get('SUPABASE_ANON_KEY')||'','Content-Type':'application/json'},
       body:JSON.stringify({action:'ogochi_family_diagnose',confirmar:true}),
       signal:AbortSignal.timeout(110000)
      });
      return json(req,await response.json().catch(()=>({ok:false,message:'Resposta inválida'})),response.status);
    }catch{return json(req,{ok:false,message:'Diagnóstico da família interrompido.'},502);}
  }


  if(action==='publish'&&channel==='mercado_livre'&&body.anarosaGrowthAudit===true){
    if(body.confirmar!==true||blingId!=='16725286274')
      return json(req,{ok:false,message:'Auditoria de crescimento só para ANAROSA autorizada.'},403);
    const host=Deno.env.get('SUPABASE_URL')||'';
    if(!host)return json(req,{ok:false,message:'Integração indisponível.'},503);
    try{
      const response=await fetch(host+'/functions/v1/mercadolivre-oauth-callback',{
        method:'POST',headers:{Authorization:req.headers.get('authorization')||'',
         apikey:Deno.env.get('SUPABASE_ANON_KEY')||'','Content-Type':'application/json'},
        body:JSON.stringify({action:'anarosa_growth_audit',confirmar:true}),
        signal:AbortSignal.timeout(105000)
      });
      const data=await response.json().catch(()=>({ok:false,message:'Resposta não estruturada.'}));
      return json(req,data,response.status);
    }catch{
      return json(req,{ok:false,message:'Consulta de crescimento indisponível.'},502);
    }
  }


  if(action==='publish'&&channel==='shopee'&&body.shopeeCredentialProbe===true){
    if(body.confirmar!==true||blingId!=='16725286274')
      return json(req,{ok:false,message:'Verificação sem autorização.'},403);
    const available=['SHOPEE_PARTNER_ID','SHOPEE_PARTNER_KEY','SHOPEE_APP_ID','SHOPEE_APP_SECRET',
      'SHOPEE_TOKEN_ENCRYPTION_KEY'].reduce((acc:any,name)=>{
       acc[name]=Boolean(Deno.env.get(name)?.trim());return acc;},{});
    return json(req,{ok:true,shopeeCredentialsConfigured:available,
      marketplace:'shopee',readOnly:true,noPublication:true});
  }

  const { data: product, error: productErr } = await ctx.db.from('store_products')
    .select('id,bling_id,sku,name,price,images,metadata,active,parent_bling_id').eq('bling_id',blingId).maybeSingle();
  if (productErr || !product || product.parent_bling_id) throw new ValidationError('Selecione um produto principal do catálogo sincronizado.');
  if (action === 'link') {
    // Vínculo administrativo sem alegação de publicação: o ID MLB e SKU
    // fornecidos serão confirmados futuramente pela API oficial do canal.
    // Nunca altera o anúncio existente ou o estoque do ERP.
    if (body.confirmar !== true) throw new ValidationError('Confirme o vínculo do anúncio existente.');
    if (channel !== 'mercado_livre') throw new ValidationError('Vínculo manual disponível apenas para Mercado Livre.');
    const external = text(body.externalListingId, 40).toUpperCase();
    if (!/^MLB[0-9]{8,16}$/.test(external)) throw new ValidationError('Informe o código MLB válido do anúncio.');
    const sku = text(body.sku, 120);
    if (!sku) throw new ValidationError('Informe o SKU do anúncio existente.');
    const { data: variantRows, error: variantError } = await ctx.db.from('store_product_variants')
      .select('sku,active').eq('product_id',product.id);
    if (variantError) throw new Error('marketplace_variant_lookup_failed');
    const knownSkus = [product.sku,...(variantRows ?? []).filter(x=>x.active !== false).map(x=>x.sku)]
      .filter((v):v is string=>typeof v==='string'&&v.length>0);
    if (!knownSkus.some(v=>v.trim().toUpperCase()===sku.toUpperCase())) {
      throw new ValidationError('O SKU informado não corresponde ao produto ou suas variações no Bling.');
    }
    const { data: duplicate, error: dupeError } = await ctx.db.from('store_marketplace_listings')
      .select('id').eq('marketplace',channel).eq('external_listing_id',external).limit(1);
    if (dupeError) throw new Error('marketplace_link_lookup_failed');
    if (duplicate?.length) return json(req,{ok:false,message:'Este anúncio já está vinculado à Gestão ANAROSA.',item:duplicate[0]},409);
    const {data:saved,error:saveError}=await ctx.db.from('store_marketplace_listings')
      .insert({
        bling_product_id:blingId,marketplace:channel,title:product.name.slice(0,160),
        description:'',category_external_id:'',listing_type:'marketplace',
        shipping_mode:'',price:Number(product.price) || 0,images:[],
        variation_mapping:[],attributes:{linkedSku:sku},
        status:'ready',external_listing_id:external,
        last_error:'Vínculo manual pendente de confirmação remota; não indica publicação validada.',
        created_by:admin.id,updated_by:admin.id,
      }).select('id,status,external_listing_id,bling_product_id').single();
    if(saveError) throw new Error('marketplace_link_save_failed');
    return json(req,{ok:true,item:saved,message:'Vínculo registrado para acompanhamento. Publicação no Mercado Livre ainda não verificada.'},201);
  }

  const title = text(body.title, 160);
  const description = text(body.description, 7000);
  const category = text(body.categoryExternalId, 60);
  const listingType = text(body.listingType, 30) || 'marketplace';
  const shippingMode = text(body.shippingMode, 100);
  const price = Number(body.price);
  if (title.length < 3 || !Number.isFinite(price) || price <= 0) throw new ValidationError('Informe título e preço válidos.');
  const images = uniqueImages(body.images, channel === 'shopee' ? 9 : 12);
  // O vídeo só pode vir da galeria do mesmo produto, nunca de URL arbitrária.
  const videoUrl = text(body.videoUrl, 1024);
  const ownedVideos = Array.isArray(product.metadata?.videos)
    ? product.metadata.videos.filter((url: unknown): url is string => typeof url === 'string')
    : [];
  if (videoUrl && (!isPublishedProductVideoUrl(videoUrl) || !ownedVideos.includes(videoUrl))) {
    throw new ValidationError('Selecione um vídeo já salvo na galeria deste produto na ANAROSA.');
  }

  const attributes = dataObject(body.attributes);
  const raws = body.variations;
  if (!Array.isArray(raws) || raws.length > 100) throw new ValidationError('Grade de variações inválida.');
  const { data: allVariants, error: variantsError } = await ctx.db.from('store_product_variants')
    .select('bling_id,sku,color,size,active').eq('product_id',product.id);
  if (variantsError) throw new Error('marketplace_variants_read_failed');
  const byId = new Map((allVariants ?? []).map(v => [String(v.bling_id),v]));
  const ids = new Set<string>();
  const variations: Variant[] = raws.map((raw: unknown) => {
    const v = dataObject(raw);
    const id = text(v.blingId,19);
    const item = byId.get(id);
    if (!item || ids.has(id)) throw new ValidationError('Uma variação não pertence a este produto ou foi duplicada.');
    ids.add(id);
    return {
      blingId: id, sku: item.sku, color: item.color ?? '', size: item.size ?? '',
      enabled: v.enabled !== false && item.active, image: urlImage(v.image),
    };
  });
  const errors: string[] = [];
  if (!category) errors.push('Informe a categoria específica do marketplace.');
  if (!images.length) errors.push('Adicione ao menos uma foto do anúncio.');
  if (!product.active) errors.push('Ative primeiro o produto principal no Bling.');
  if (byId.size && !variations.some(v=>v.enabled)) errors.push('Selecione ao menos uma variação ativa.');
  if (channel === 'mercado_livre' && !['marketplace','catalogo'].includes(listingType))
    errors.push('Informe o tipo Marketplace ou Catálogo.');
  if (!shippingMode) errors.push('Defina a modalidade de envio.');
  // A preparação aceita vídeo opcional, mas nunca chama o upload externo.
  // Os dois canais preferem MP4; WebM permanece só na loja, sem "pronto".
  if (videoUrl && !videoUrl.toLowerCase().endsWith('.mp4')) {
    errors.push('Para o marketplace, envie uma versão MP4 do vídeo ao cadastro do produto.');
  }

  const { data: connection } = await ctx.db.from('store_marketplace_connections')
    .select('status,external_store_id,verified_at').eq('marketplace',channel).maybeSingle();
  if (action === 'publish') {
    if (body.confirmar !== true) return json(req, {
      ok: false, message: 'Confirmação administrativa obrigatória antes de publicar.'
    }, 403);
    if (channel !== 'mercado_livre') return json(req,{
      ok: false, message: 'Publicação automatizada da Shopee ainda não homologada.'
    }, 409);
    if (errors.length) return json(req,{
      ok:false,message:'Complete os campos obrigatórios do anúncio antes de publicar.',missing:errors
    },422);
    const draftId=text(body.id,40);
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(draftId))
      return json(req,{ok:false,message:'Selecione o ID do rascunho Mercado Livre existente para evitar duplicidade.'},400);
    const {data:original,error:readError}=await ctx.db.from('store_marketplace_listings')
      .select('id,bling_product_id,marketplace,status,external_listing_id')
      .eq('id',draftId).eq('bling_product_id',blingId).eq('marketplace','mercado_livre').maybeSingle();
    if(readError||!original)return json(req,{ok:false,message:'Rascunho não encontrado ou pertence a outro produto.'},404);
    if(original.external_listing_id||!['draft','ready'].includes(original.status))
      return json(req,{ok:false,message:'Anúncio já possui vínculo MLB, ou há publicação pendente. Não duplicar.',externalListingId:original.external_listing_id},409);
    const app=Deno.env.get('SUPABASE_URL')||'';
    if(!app)return json(req,{ok:false,message:'Integração de publicação indisponível.'},503);
    let remote:Response;
    try {
      remote=await fetch(app+'/functions/v1/mercadolivre-oauth-callback',{
        method:'POST',
        headers:{
          'Authorization':req.headers.get('authorization')||'',
          'apikey':Deno.env.get('SUPABASE_ANON_KEY')||'',
          'Content-Type':'application/json',
        },
        body:JSON.stringify({action:body.dryRun===true?'validate_listing':'publish_listing',listingId:draftId,confirmar:body.dryRun!==true}),
        signal:AbortSignal.timeout(110000),
      });
    }catch{
      return json(req,{ok:false,message:'Publicador externo não respondeu. Confira a situação do rascunho antes de repetir.'},502);
    }
    const outcome=await remote.json().catch(()=>({
      ok:false,message:'O publicador não retornou confirmação estruturada.'
    }));
    return json(req,outcome,remote.status);
  }
  if (action === 'prepare' && errors.length) return json(req, {
    ok: false, message: 'Há campos obrigatórios pendentes antes de preparar o anúncio.', missing: errors,
  }, 422);
  const currentId = text(body.id,40);
  const data = {
    bling_product_id: blingId, marketplace: channel, title, description,
    category_external_id: category, listing_type: listingType, shipping_mode: shippingMode,
    price, images, variation_mapping: variations, attributes,
    video_url: videoUrl || null, video_status: videoUrl ? 'selected' : 'not_selected', video_external_id: null,
    status: action === 'prepare' ? 'ready' : 'draft', updated_by: admin.id,
    updated_at: new Date().toISOString(),
  };
  if (currentId) {
    if (!/^[0-9a-f-]{36}$/i.test(currentId)) throw new ValidationError('ID de anúncio inválido.');
    const { data: existing } = await ctx.db.from('store_marketplace_listings').select('status,bling_product_id,marketplace')
      .eq('id',currentId).maybeSingle();
    if (!existing) throw new ValidationError('Anúncio não encontrado.');
    if (existing.status === 'published') throw new ValidationError('Um anúncio publicado não pode ser substituído como rascunho.');
    if (existing.bling_product_id !== blingId || existing.marketplace !== channel)
      throw new ValidationError('Para trocar o produto ou o canal, crie outro anúncio.');
    const { data: saved, error } = await ctx.db.from('store_marketplace_listings')
      .update(data).eq('id',currentId).select('id,status').single();
    if (error) throw new Error('marketplace_listing_update_failed');
    return json(req, { ok: true, item:saved, missing: errors, message: action === 'prepare' ? 'Anúncio pronto para revisão. Ainda não publicado.' : 'Rascunho salvo.' });
  }
  const { data: saved, error } = await ctx.db.from('store_marketplace_listings')
    .insert({ ...data,created_by:admin.id }).select('id,status').single();
  if (error) throw new Error('marketplace_listing_create_failed');
  return json(req, { ok: true,item:saved,missing:errors,
    message: action === 'prepare' ? 'Anúncio pronto para revisão. Ainda não publicado.' : 'Rascunho salvo.' }, 201);
});
