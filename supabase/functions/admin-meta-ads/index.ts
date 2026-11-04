/**
 * Meta Marketing API — anúncios patrocinados da loja ANAROSA.
 * Rascunho e aprovação explícita antes de qualquer escrita externa.
 * O único anúncio criado externamente tem status PAUSED: sem gasto automático.
 * Nunca usa tokens no navegador, no MCP ou no retorno HTTP.
 */
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { serve } from '../_shared/context.ts';
import { ValidationError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { displayCatalogImage } from '../_shared/catalog-image-url.ts';

type Item = Record<string, unknown>;
const SITE = 'https://www.lojaanarosa.com.br';
const TABLE = 'store_meta_ad_drafts';
const ID = /^[1-9][0-9]{0,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const txt = (v: unknown, limit: number) =>
  typeof v === 'string' ? v.replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, limit) : '';
function configured() {
  const account = Deno.env.get('META_AD_ACCOUNT_ID')?.replace(/^act_/, '') || '';
  const page = Deno.env.get('META_PAGE_ID') || '';
  const token = Deno.env.get('META_ACCESS_TOKEN') || '';
  const ig = Deno.env.get('META_IG_ACTOR_ID') || '';
  return {
    account, page, token, ig,
    ready: ID.test(account) && ID.test(page) && token.length > 20,
  };
}
function version() {
  const v = Deno.env.get('META_GRAPH_VERSION') || 'v26.0';
  return /^v[0-9]{1,3}\.0$/.test(v) ? v : 'v26.0';
}
async function graph(path: string, method: 'GET'|'POST', payload: Record<string, string> = {}): Promise<Item> {
  const cfg = configured();
  if (!cfg.ready) throw new ValidationError(
    'A conta de anúncios Meta ainda não está conectada. Configure META_AD_ACCOUNT_ID, META_PAGE_ID e META_ACCESS_TOKEN no servidor da ANAROSA.',
    { reason: 'meta_not_configured' });
  const url = new URL('https://graph.facebook.com/' + version() + '/' + path);
  if (method === 'GET') for (const [k, v] of Object.entries(payload)) url.searchParams.set(k, v);
  const body = method === 'POST' ? new URLSearchParams(payload) : undefined;
  let result: Response;
  try {
    result = await fetch(url, {
      method, headers: { Authorization: 'Bearer ' + cfg.token,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(22000),
    });
  } catch {
    throw new ValidationError('Meta não respondeu. Verifique a operação no Gerenciador de Anúncios antes de repetir.',
      { reason: 'meta_network_uncertain' });
  }
  const data = await result.json().catch(() => ({})) as Item;
  if (!result.ok || data.error) {
    const error = (data.error && typeof data.error === 'object') ? data.error as Item : {};
    const msg = txt(error.error_user_msg || error.message, 260) ||
      'A Meta não autorizou a operação. Confira conta, permissões e políticas.';
    throw new ValidationError('Meta: ' + msg, { reason: 'meta_api_rejected', metaStatus: result.status,
      metaCode: error.code ?? null, metaSubcode: error.error_subcode ?? null });
  }
  return data;
}
function checkUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ValidationError('ID do rascunho inválido.');
  return value;
}
async function productFor(ctx: {db: any}, blingId: string) {
  const { data, error } = await ctx.db.from('store_products')
    .select('id,bling_id,sku,name,brand,slug,description,short_description,price,promotional_price,images,metadata,active,parent_bling_id,deleted_from_bling_at,hidden_from_gestao_at')
    .eq('bling_id', blingId).maybeSingle();
  if (error) throw new Error('meta_product_lookup_failed');
  if (!data || !data.active || data.parent_bling_id || data.deleted_from_bling_at ||
      data.hidden_from_gestao_at) throw new ValidationError('Produto indisponível na ANAROSA.');
  const media = Array.isArray(data.images) ? data.images : [];
  const images = media.map((m: Item, i: number) =>
    displayCatalogImage(m, blingId, i, data.metadata)).filter((v: unknown): v is string =>
    typeof v === 'string' && v.startsWith('https://') && !/placeholder/i.test(v));
  if (!images.length || Number(data.price) <= 0 || !data.slug ||
      !/^[a-z0-9-]{1,160}$/i.test(data.slug)) {
    throw new ValidationError('O produto precisa de foto HTTPS, preço positivo e página pública para anunciar.');
  }
  return { product: data, images, link: SITE + '/p/' + encodeURIComponent(data.slug) + '.html' };
}
function validDraftFields(body: Item, product: Item, images: string[], link: string) {
  const title = txt(body.title, 160) || txt(product.name, 160);
  const primaryText = txt(body.primaryText, 2200) ||
    'Conheça ' + txt(product.name, 140) + ' na ANAROSA. Confira fotos, tamanhos e detalhes antes de comprar.';
  const description = txt(body.description, 500) ||
    'Confira os detalhes desta peça na loja ANAROSA.';
  const image = txt(body.imageUrl, 1500) || images[0];
  const adsetId = txt(body.adsetId, 19);
  if (!title || !primaryText || !images.includes(image)) {
    throw new ValidationError('Título, texto e imagem devem corresponder ao produto selecionado.');
  }
  if (adsetId && !ID.test(adsetId)) throw new ValidationError('ID de conjunto de anúncios Meta inválido.');
  return { title, primary_text: primaryText, description,
    image_url: image, destination_url: link, adset_id: adsetId };
}
async function readDraft(db: any, id: string) {
  const {data,error} = await db.from(TABLE).select('*').eq('id',id).maybeSingle();
  if(error) throw new Error('meta_draft_read_failed');
  if(!data) throw new ValidationError('Rascunho não encontrado.');
  return data as Item;
}
async function updateDraft(db: any, id: string, values: Item, expectedStatus?: string, expectedRevision?: number) {
  let q = db.from(TABLE).update({ ...values, updated_at: new Date().toISOString() }).eq('id',id);
  if(expectedStatus) q = q.eq('status',expectedStatus);
  if(expectedRevision != null) q = q.eq('revision',expectedRevision);
  const {data,error} = await q.select('*').maybeSingle();
  if(error) throw new Error('meta_draft_update_failed');
  if(!data) throw new ValidationError('O rascunho foi alterado. Atualize a página antes de prosseguir.');
  return data as Item;
}
serve(async (req,ctx) => {
  if (!['GET','POST'].includes(req.method)) return methodNotAllowed(req,['GET','POST']);
  const admin = await requireAdminUser(req,ctx.db);
  const cfg = configured();
  if(req.method==='GET') {
    const action = new URL(req.url).searchParams.get('action') || 'list';
    if(action==='status') return json(req,{ ok:true, connected:cfg.ready,
      accountConfigured: ID.test(cfg.account), pageConfigured: ID.test(cfg.page),
      authorizationConfigured: cfg.token.length>20, publisherMode:'PAUSED_ONLY',
      setupUrl:'https://business.facebook.com/settings', metaAdsUrl:'https://business.facebook.com/adsmanager' });
    if(action==='adsets') {
      if(!cfg.ready) return json(req,{ok:true,items:[],connected:false});
      const result=await graph('act_'+cfg.account+'/adsets','GET',{
        fields:'id,name,status,effective_status,account_id',limit:'50'});
      return json(req,{ok:true,items:Array.isArray(result.data)?result.data:[],connected:true});
    }
    if(action!=='list') throw new ValidationError('Consulta inválida.');
    const {data,error}=await ctx.db.from(TABLE).select(
      'id,bling_product_id,product_name,product_sku,title,primary_text,description,image_url,destination_url,adset_id,status,revision,approved_revision,approved_at,meta_ad_id,last_error,created_at,updated_at'
    ).order('updated_at',{ascending:false}).limit(50);
    if(error)throw new Error('meta_list_failed');
    return json(req,{ok:true,items:data??[],connected:cfg.ready});
  }

  const {data:rate,error:rateError} = await ctx.db.rpc('rl_check_and_increment', {
    p_bucket:'meta-ads-admin:'+admin.id,p_limit:20,p_window_seconds:60});
  if(rateError || rate!==true)throw new ValidationError('Limite de operações atingido. Aguarde um minuto.');
  const body = await req.json().catch(()=>null) as Item | null;
  if(!body || typeof body!=='object' || Array.isArray(body)) throw new ValidationError('Corpo inválido.');
  const action=txt(body.action,30);
  if(action==='save') {
    const blingId=txt(body.blingId,20);
    if(!ID.test(blingId))throw new ValidationError('Selecione um produto real do Bling.');
    const {product,images,link}=await productFor(ctx,blingId);
    const fields=validDraftFields(body,product,images,link);
    if(body.id){
      const id=checkUuid(body.id);
      const old=await readDraft(ctx.db,id);
      if(old.bling_product_id!==blingId || ['publishing','paused_on_meta','needs_reconciliation'].includes(String(old.status)))
        throw new ValidationError('Não é possível alterar este anúncio ou trocar seu produto.');
      const revision=Number(old.revision)+1;
      const saved=await updateDraft(ctx.db,id,{
        ...fields,revision,status:'draft',approved_revision:null,approved_by:null,approved_at:null,
        last_error:null,updated_by:admin.id},String(old.status),Number(old.revision));
      return json(req,{ok:true,draft:saved,message:'Prévia atualizada; aprovação anterior anulada.'});
    }
    const {data:saved,error}=await ctx.db.from(TABLE).insert({
      bling_product_id:blingId, product_name:txt(product.name,200),product_sku:txt(product.sku,120),
      ...fields,created_by:admin.id,updated_by:admin.id,status:'draft',
    }).select('*').single();
    if(error)throw new Error('meta_draft_create_failed');
    return json(req,{ok:true,draft:saved,message:'Rascunho criado para revisão. Nada foi enviado à Meta.'},201);
  }
  if(action==='approve') {
    if(body.confirmar!==true)throw new ValidationError('Aprovação explícita obrigatória.');
    const id=checkUuid(body.id);const original=await readDraft(ctx.db,id);
    const revision=Number(body.revision);
    if(!Number.isInteger(revision) || revision!==Number(original.revision))
      throw new ValidationError('A prévia mudou. Revise o anúncio novamente.');
    if(!['draft','error'].includes(String(original.status)))
      throw new ValidationError('Este anúncio não está aguardando aprovação.');
    const saved=await updateDraft(ctx.db,id,{status:'approved',approved_revision:revision,
      approved_at:new Date().toISOString(),approved_by:admin.id,updated_by:admin.id,last_error:null},
      String(original.status),revision);
    return json(req,{ok:true,draft:saved,message:'Anúncio aprovado, ainda NÃO publicado. A publicação cria somente um anúncio PAUSADO.'});
  }
  if(action==='publish_paused') {
    if(body.confirmar!==true)throw new ValidationError('Confirme a criação do anúncio PAUSADO na Meta.');
    if(!cfg.ready)throw new ValidationError('Conecte a conta de anúncios Meta antes de publicar.',
      {reason:'meta_not_configured'});
    const id=checkUuid(body.id);const original=await readDraft(ctx.db,id);
    if(original.status!=='approved' || Number(original.approved_revision)!==Number(original.revision) ||
      Number(body.revision)!==Number(original.revision))
      throw new ValidationError('O anúncio precisa de aprovação atualizada antes da publicação.');
    const adset=String(original.adset_id||'');
    if(!ID.test(adset))throw new ValidationError('Escolha um conjunto de anúncios válido na Meta.');
    const {images,link}=await productFor(ctx,String(original.bling_product_id));
    if(link!==original.destination_url || !images.includes(String(original.image_url)))
      throw new ValidationError('O produto mudou após a revisão. Atualize o rascunho.');
    const adsetInfo=await graph(adset,'GET',{fields:'id,account_id,status'});
    if(String(adsetInfo.id)!==adset || String(adsetInfo.account_id)!==cfg.account)
      throw new ValidationError('O conjunto não pertence à conta Meta configurada.');
    // Troca atômica do status: cliques repetidos NÃO geram anúncios duplicados.
    await updateDraft(ctx.db,id,{status:'publishing',updated_by:admin.id,last_error:null},
      'approved',Number(original.revision));
    let creativeId:string|null=null;
    try {
      const spec: Item = {page_id:cfg.page, link_data:{
        message:original.primary_text,name:original.title,
        description:original.description,link:original.destination_url,
        picture:original.image_url,
        call_to_action:{type:'SHOP_NOW',value:{link:original.destination_url}},
      }};
      if(ID.test(cfg.ig))spec.instagram_actor_id=cfg.ig;
      const creative=await graph('act_'+cfg.account+'/adcreatives','POST',{
        name:'ANAROSA | '+txt(original.product_name,75)+' | '+id.slice(0,8),
        object_story_spec:JSON.stringify(spec),
      });
      creativeId=String(creative.id||'');
      if(!ID.test(creativeId))throw new Error('meta_creative_id_unverified');
      await updateDraft(ctx.db,id,{meta_creative_id:creativeId},'publishing');
      const ad=await graph('act_'+cfg.account+'/ads','POST',{
        name:'ANAROSA | '+txt(original.product_name,75)+' | '+id.slice(0,8),
        adset_id:adset,creative:JSON.stringify({creative_id:creativeId}),status:'PAUSED',
      });
      const adId=String(ad.id||'');
      if(!ID.test(adId))throw new Error('meta_ad_id_unverified');
      const saved=await updateDraft(ctx.db,id,{
        meta_ad_id:adId,status:'paused_on_meta',last_error:null,
      },'publishing');
      return json(req,{ok:true,draft:saved,externalAdId:adId,
        message:'Anúncio criado na Meta com status PAUSADO. Não houve ativação de campanha nem alteração de orçamento.'});
    }catch(error){
      const safe=error instanceof ValidationError ? error.message.slice(0,400) :
        'Resultado da Meta inconclusivo. Confira a conta antes de tentar outra criação.';
      await ctx.db.from(TABLE).update({status:'needs_reconciliation',
        ...(creativeId?{meta_creative_id:creativeId}:{}),last_error:safe,updated_at:new Date().toISOString()})
        .eq('id',id).eq('status','publishing');
      return json(req,{ok:false,needsReconciliation:true,message:safe,
        notice:'Rascunho bloqueado contra repetição. Confira o Gerenciador de Anúncios Meta para evitar duplicações.'},409);
    }
  }
  throw new ValidationError('Ação desconhecida.');
});
