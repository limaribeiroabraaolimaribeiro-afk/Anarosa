/**
 * Gestão de anúncios multicanal: armazena rascunhos validados ligados ao
 * produto fonte do Bling. Publicação exige adapter autorizado e certificado.
 * NUNCA marca um anúncio como publicado sem confirmação real do canal.
 */
import { serve } from '../_shared/context.ts';
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { ValidationError } from '../_shared/errors.ts';

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
        .select('id,bling_product_id,marketplace,title,description,category_external_id,listing_type,shipping_mode,price,images,variation_mapping,attributes,status,external_listing_id,external_url,last_error,updated_at,published_at')
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
  const { data: product, error: productErr } = await ctx.db.from('store_products')
    .select('id,bling_id,sku,name,price,images,active,parent_bling_id').eq('bling_id',blingId).maybeSingle();
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
  const { data: connection } = await ctx.db.from('store_marketplace_connections')
    .select('status,external_store_id,verified_at').eq('marketplace',channel).maybeSingle();
  if (action === 'publish') {
    // A conexão do Bling, por si só, NÃO autoriza publicar no Mercado Livre
    // nem na Shopee. Não fazer POST especulativo a endpoints de terceiros.
    const reason = connection?.status === 'connected'
      ? 'O adaptador de publicação desta Gestão ainda precisa de validação antes de enviar anúncios.'
      : 'A conta pode estar autorizada no Bling, mas o envio por esta Gestão ainda não foi validado. Use o Bling para publicar enquanto a integração é concluída.';
    return json(req, { ok: false, status: 'blocked', message: reason,
      missing: [...errors, reason], externalListingId: null }, 409);
  }
  if (action === 'prepare' && errors.length) return json(req, {
    ok: false, message: 'Há campos obrigatórios pendentes antes de preparar o anúncio.', missing: errors,
  }, 422);
  const currentId = text(body.id,40);
  const data = {
    bling_product_id: blingId, marketplace: channel, title, description,
    category_external_id: category, listing_type: listingType, shipping_mode: shippingMode,
    price, images, variation_mapping: variations, attributes,
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
