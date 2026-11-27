/**
 * ANAROSA — servidor MCP comercial independente do desenvolvimento.
 * Ferramentas somente de Gestão. Não expõe SQL, segredos, GitHub,
 * ferramentas arbitrárias de HTTP ou caminhos de arquivo.
 *
 * Remote MCP via Streamable HTTP, stateless JSON-RPC.
 * OAuth 2.1: Supabase Auth (OAuth Server + DCR + consent UI).
 * RequireAdminUser valida a sessão E a allowlist store_admins
 * em TODAS as requisições MCP, inclusive tools/list e initialize.
 *
 * A geração criativa do ChatGPT produz os textos; a ferramenta de
 * importação recebe APENAS foto já gerada em base64, nunca
 * finge que criou imagem quando não há um provedor configurado.
 */
import { getServiceClient } from '../_shared/supabase.ts';
import { requireAdminUser } from '../_shared/admin-user-auth.ts';

type Args = Record<string, unknown>;
type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Args };
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type Tool = {
  description: string;
  schema: Record<string, unknown>;
  readOnly?: boolean;
  openWorld?: boolean;
  action: (args: Args, token: string) => Promise<unknown>;
};

const APP_URL = Deno.env.get('SUPABASE_URL') || '';
const PUBLIC_KEY = Deno.env.get('SUPABASE_ANON_KEY') || '';
const MAX_INPUT = 4 * 1024 * 1024 + 4096;

function toText(value: unknown, max = 160): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}
function textTool(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function failure(message: string, status = 400): Response {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
function properties(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}
const S = {
  str: (description: string, maxLength = 160) => ({ type: 'string', description, maxLength }),
  bool: (description: string) => ({ type: 'boolean', description }),
  number: (description: string) => ({ type: 'number', description }),
  obj: (description: string) => ({ type: 'object', description }),
  arr: (description: string) => ({ type: 'array', description }),
};
function yes(args: Args): void {
  if (args.confirmar !== true) throw new Error('Confirmação explícita obrigatória: informe confirmar=true após o usuário aprovar esta operação.');
}
function requiredText(args: Args, key: string, max = 160): string {
  const v = toText(args[key], max);
  if (!v) throw new Error('Campo obrigatório: ' + key);
  return v;
}
function validBlingId(v: unknown): string {
  const id = toText(v, 19);
  if (!/^[1-9][0-9]{0,18}$/.test(id)) throw new Error('ID numérico de produto Bling inválido.');
  return id;
}
function operationId(args: Args): string {
  const id = requiredText(args, 'operationKey', 40);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('operationKey deve ser UUID. Reutilize o MESMO valor se precisar repetir uma operação.');
  }
  return id;
}
function jsonParams(args: Args, names: string[]): Args {
  const result: Args = {};
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null && value !== '') result[name] = value;
  }
  return result;
}
async function requestAdmin(endpoint: string, token: string, params?: Args, body?: Args): Promise<unknown> {
  const allowed = new Set([
    'admin-dashboard-summary','admin-products','admin-product-detail','admin-categories','admin-customers',
    'admin-orders','admin-stock-history','admin-deposits','admin-integration-status',
    'admin-product-create','admin-product-update','admin-stock-adjust','admin-marketplace-listings',
    'admin-marketplace-channels','mercadolivre-oauth-callback','admin-product-image-upload','admin-catalog-audit','admin-meta-ads',
  ]);
  if (!allowed.has(endpoint)) throw new Error('Operação não autorizada pelo MCP.');
  const url = new URL(APP_URL + '/functions/v1/' + endpoint);
  for (const [k,v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const headers: Record<string,string> = {
    Authorization: 'Bearer ' + token, Accept: 'application/json',
  };
  if (PUBLIC_KEY) headers.apikey = PUBLIC_KEY;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(24000),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Expor apenas mensagens já tratadas pelo endpoint admin.
    const msg = payload && typeof payload.message === 'string' ? payload.message : 'Erro no serviço administrativo (' + res.status + ').';
    const diagnostics:Record<string,unknown>={};
    if(endpoint==='mercadolivre-oauth-callback'||endpoint==='admin-marketplace-listings'){
      const clean=(v:unknown)=>typeof v==='string'?v.slice(0,500):undefined;
      const causes=(v:unknown)=>Array.isArray(v)?v.slice(0,15).map((c:any)=>({code:clean(c?.code),type:clean(c?.type),cause_id:Number.isInteger(c?.cause_id)?c.cause_id:undefined,message:clean(c?.message)})):[];
      if(Number.isInteger(payload.retryAfterSeconds)&&payload.retryAfterSeconds>0)diagnostics.retryAfterSeconds=payload.retryAfterSeconds;
      if(payload.stage)diagnostics.stage=clean(payload.stage);
      if(payload.detail)diagnostics.detail=clean(payload.detail);
      if(Array.isArray(payload.invalid))diagnostics.invalid=payload.invalid.slice(0,20);
      if(Array.isArray(payload.causes))diagnostics.causes=causes(payload.causes);
      if(payload.validation&&typeof payload.validation==='object')diagnostics.validation={httpStatus:payload.validation.httpStatus,error:clean(payload.validation.error),causes:causes(payload.validation.causes)};
      if(payload.shippingDiagnostic&&typeof payload.shippingDiagnostic==='object'){
        const d=payload.shippingDiagnostic;
        diagnostics.shippingDiagnostic={category:d.category,domainAttributes:d.domainAttributes,eligibilityStatus:d.eligibilityStatus,eligibility:d.eligibility};
      }
      if(payload.uncertain===true)diagnostics.uncertain=true;
      if(payload.verificationPending===true)diagnostics.verificationPending=true;
      if(typeof payload.externalListingId==='string'&&/^MLB[0-9]{8,16}$/.test(payload.externalListingId))diagnostics.externalListingId=payload.externalListingId;
    }
    return { ok: false, httpStatus: res.status, message: msg, ...(Array.isArray(payload.missing) ? { missing: payload.missing } : {}), ...diagnostics };
  }
  return payload;
}
async function uploadImage(args: Args, token: string): Promise<unknown> {
  yes(args);
  const mime = requiredText(args, 'mime', 32);
  if (!['image/png','image/jpeg','image/webp'].includes(mime)) throw new Error('Formato JPG, PNG ou WebP obrigatório.');
  const base64 = requiredText(args, 'base64', MAX_INPUT);
  if (!/^[A-Za-z0-9+\/=\r\n]+$/.test(base64)) throw new Error('Imagem base64 inválida.');
  if (base64.length > MAX_INPUT) throw new Error('Arquivo grande demais (máximo de 3 MB).');
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(base64.replace(/\s/g,'')), (c) => c.charCodeAt(0)); }
  catch { throw new Error('Imagem base64 inválida.'); }
  if (bytes.byteLength < 12 || bytes.byteLength > 3*1024*1024) throw new Error('Foto deve ter até 3 MB.');
  const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const form = new FormData();
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  form.append('photo', new File([buffer], 'mcp-photo.' + ext, { type: mime }));
  const url = APP_URL + '/functions/v1/admin-product-image-upload';
  const headers: Record<string,string> = { Authorization:'Bearer ' + token };
  if (PUBLIC_KEY) headers.apikey = PUBLIC_KEY;
  const response = await fetch(url, { method:'POST', headers, body:form, signal: AbortSignal.timeout(25000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { ok:false, httpStatus:response.status, message:data.message || 'Falha ao importar foto.' };
  return { ok:true, url:data.url, message:'Imagem recebida no Storage. Inclua esta URL ao salvar o produto ou anúncio; o envio sozinho NÃO altera o Bling.' };
}
// Import only uploaded attachments from the existing ANAROSA Pollo account.
// No arbitrary URL, no redirects, no credentials forwarded; actual bytes go
// through the same authenticated, format-checking product-image upload.
async function importAttachmentUrl(args: Args, token: string): Promise<unknown> {
  yes(args);
  const raw=requiredText(args,'url',1500);
  let u:URL;
  try{u=new URL(raw);}catch{throw new Error('URL de anexo inválida.');}
  const allowedPath=/^\/web-cdn\/pollo\/production\/cmp0kq6ey09a745o9i18wq0h2\/mcp-file\/[0-9]{10,16}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|png|jpg|jpeg)$/i;
  if(u.origin!=='https://videocdn.pollo.ai'||u.username||u.password||u.search||u.hash||!allowedPath.test(u.pathname))
    throw new Error('Origem não autorizada. Use o endereço de anexo retornado pelo Pollo conectado à ANAROSA.');
  const db=getServiceClient();
  const admin=await requireAdminUser(new Request(APP_URL,{headers:{Authorization:'Bearer '+token}}),db);
  const rate=await db.rpc('rl_check_and_increment',{p_bucket:'anarosa-mcp-attachment-import:'+admin.id,p_limit:20,p_window_seconds:60});
  if(rate.error||rate.data!==true)throw new Error('Limite de importação de anexos atingido.');
  const max=3*1024*1024;
  let response:Response;
  try{response=await fetch(u.href,{method:'GET',redirect:'error',signal:AbortSignal.timeout(12000)});}
  catch{throw new Error('Não foi possível baixar o anexo autorizado.');}
  const mime=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  const length=Number(response.headers.get('content-length')||0);
  if(!response.ok||!response.body||!['image/jpeg','image/png','image/webp'].includes(mime)||length>max){
    await response.body?.cancel().catch(()=>{});
    throw new Error('Anexo indisponível, formato não aceito ou imagem maior que 3 MB.');
  }
  const reader=response.body.getReader();
  let size=0; const chunks:Uint8Array[]=[];
  try{
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      size+=value.byteLength;
      if(size>max){await reader.cancel();throw new Error('Imagem maior que 3 MB.');}
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  if(size<12)throw new Error('Imagem vazia ou inválida.');
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  let binary='';
  for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return uploadImage({confirmar:true,mime,base64:btoa(binary)},token);
}
async function generateImage(args: Args, token: string): Promise<unknown> {
  yes(args);
  const key = Deno.env.get('OPENAI_API_KEY');
  if (!key) return { ok:false, message:'Geração de imagens comerciais não configurada. Para gerar automaticamente pelo servidor, ative uma chave de API no Supabase e confirme os custos de uso. Como alternativa, gere a imagem no ChatGPT e use importar_imagem_gerada.' };
  const prompt = requiredText(args, 'prompt', 1500);
  if (prompt.length < 15) throw new Error('Descrição da imagem insuficiente.');
  const db = getServiceClient();
  const user = await requireAdminUser(new Request(APP_URL, {headers:{Authorization:'Bearer '+token}}),db);
  const rate = await db.rpc('rl_check_and_increment',{
    p_bucket:'anarosa-mcp-image-generation:'+user.id,p_limit:3,p_window_seconds:3600,
  });
  if(rate.error || rate.data!==true)return {ok:false,message:'Limite de geração de imagens: até 3 por hora.'};
  const response=await fetch('https://api.openai.com/v1/images/generations',{
    method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body:JSON.stringify({
      model:'gpt-image-2.5-flare',prompt:prompt+' A imagem deve ser original. Não inventar logotipos de marcas, certificados ou características não fornecidas. Não incluir textos inventados.',
      n:1,quality:'low',size:'1024x1024',output_format:'jpeg',
      safety_identifier:user.id,
    }),signal:AbortSignal.timeout(55000),
  });
  if(!response.ok)return {ok:false,message:'Serviço de geração de imagens indisponível ou sem crédito. Verifique a chave e o orçamento no provedor.'};
  const result=await response.json();
  const photo=result.data?.[0]?.b64_json;
  if(typeof photo!=='string')return {ok:false,message:'A API não retornou imagem.'};
  const uploaded=await uploadImage({confirmar:true,mime:'image/jpeg',base64:photo},token);
  return { ...((uploaded&&typeof uploaded==='object')?uploaded:{}), generated:true,
    note:'Arte gerada por IA para revisão. Não representa necessariamente a peça real e não é automaticamente anexada ao Bling/anúncio.' };
}
const actions: Record<string,Tool> = {
  resumo_da_loja: {
    description:'Consultar indicadores da Gestão ANAROSA, sem modificar dados.',
    schema:properties({}),readOnly:true,
    action:(_,token)=>requestAdmin('admin-dashboard-summary',token),
  },
  listar_produtos: {
    description:'Consultar catálogo administrativo do Bling sincronizado: produtos, SKUs, preços, fotos e variações. Não fornece acesso ao código.',
    schema:properties({
      limit:{type:'integer',minimum:1,maximum:100,description:'Número máximo de produtos'},
      offset:{type:'integer',minimum:0},
      search:S.str('Nome ou SKU do produto',80),
      active:{type:'boolean',description:'Filtrar ativos/inativos'},
    }),readOnly:true,
    action:(a,t)=>requestAdmin('admin-products',t,jsonParams(a,['limit','offset','search','active'])),
  },
  detalhar_produto: {
    description:'Ler cadastro e revisão original do Bling para editar sem sobrescrever mudanças concorrentes.',
    schema:properties({id:S.str('ID numérico Bling')},['id']),readOnly:true,
    action:(a,t)=>requestAdmin('admin-product-detail',t,{id:validBlingId(a.id)}),
  },
  listar_categorias: {
    description:'Consultar categorias do catálogo do Bling sincronizado na Gestão.',
    schema:properties({}),readOnly:true,
    action:(_,t)=>requestAdmin('admin-categories',t),
  },
  consultar_estoque: {
    description:'Consultar saldos por depósito e movimentações de um produto ou variação.',
    schema:properties({id:S.str('ID numérico Bling')},['id']),readOnly:true,
    action:(a,t)=>requestAdmin('admin-stock-history',t,{id:validBlingId(a.id)}),
  },
  listar_depositos: {
    description:'Consultar IDs dos depósitos para ajustes de estoque válidos no Bling.',
    schema:properties({}),readOnly:true,
    action:(_,t)=>requestAdmin('admin-deposits',t),
  },
  listar_pedidos: {
    description:'Consultar pedidos administrativos existentes na Gestão ANAROSA sem edição.',
    schema:properties({limit:{type:'integer',minimum:1,maximum:100},offset:{type:'integer',minimum:0},status:S.str('novos, processando, concluidos ou cancelados',30)}),readOnly:true,
    action:(a,t)=>requestAdmin('admin-orders',t,jsonParams(a,['limit','offset','status'])),
  },
  listar_clientes: {
    description:'Consultar clientes da Gestão ANAROSA sob autenticação administrativa. Evite compartilhar dados pessoais fora da necessidade comercial.',
    schema:properties({limit:{type:'integer',minimum:1,maximum:50},offset:{type:'integer',minimum:0},
      search:S.str('Nome ou contato para buscar',80)}),readOnly:true,
    action:(a,t)=>requestAdmin('admin-customers',t,jsonParams(a,['limit','offset','search'])),
  },
  mercadolivre_status: {
    description:'Consultar status da conexão DIRETA Mercado Livre na Gestão ANAROSA. Consulta pela API Mercado Livre, não pelo Bling. Nunca retorna credenciais.',
    schema:properties({}),readOnly:true,openWorld:true,
    action:async (_a,token)=>requestAdmin('mercadolivre-oauth-callback',token,undefined,{action:'status'}),
  },
  mercadolivre_categoria: {
    description:'Consultar categoria oficial, atributos obrigatórios e valores aceitos pelo Mercado Livre. Somente leitura.',
    schema:properties({categoryId:S.str('Código MLB da categoria',30)},['categoryId']),readOnly:true,openWorld:true,
    action:(a,t)=>requestAdmin('mercadolivre-oauth-callback',t,undefined,{action:'category_schema',categoryId:requiredText(a,'categoryId',30)}),
  },
  mercadolivre_ficha_medidas: {
    description:'Consultar ficha técnica do domínio e requisitos de tabelas de medidas da categoria. Somente leitura; não cria tabelas.',
    schema:properties({categoryId:S.str('Código MLB da categoria',30)},['categoryId']),readOnly:true,openWorld:true,
    action:(a,t)=>requestAdmin('mercadolivre-oauth-callback',t,undefined,{action:'chart_schema',categoryId:requiredText(a,'categoryId',30)}),
  },
  mercadolivre_pesquisar_tabelas: {
    description:'Pesquisar tabelas de medidas oficiais compatíveis com a categoria, marca e gênero. Somente leitura.',
    schema:properties({categoryId:S.str('Código MLB da categoria',30),gender:S.str('Gênero oficial da categoria',50),brand:S.str('Marca real',100)},['categoryId','gender','brand']),readOnly:true,openWorld:true,
    action:(a,t)=>requestAdmin('mercadolivre-oauth-callback',t,undefined,{action:'chart_search',categoryId:requiredText(a,'categoryId',30),gender:requiredText(a,'gender',50),brand:requiredText(a,'brand',100)}),
  },
  mercadolivre_modelo_tabela: {
    description:'Consultar os campos oficiais da tabela de medidas para o gênero e marca informados. Somente leitura.',
    schema:properties({categoryId:S.str('Código MLB da categoria',30),gender:S.str('Gênero oficial da categoria',50),brand:S.str('Marca real',100)},['categoryId','gender','brand']),readOnly:true,openWorld:true,
    action:(a,t)=>requestAdmin('mercadolivre-oauth-callback',t,undefined,{action:'chart_template',categoryId:requiredText(a,'categoryId',30),gender:requiredText(a,'gender',50),brand:requiredText(a,'brand',100)}),
  },
  mercadolivre_preparar_tabela_calcados: {
    description:'Preparar uma prévia local de tabela de medidas de calçados para todas as numerações reais de um produto. Use medidas confirmadas da loja. Não cria tabela externa. Apresente a prévia para aprovação.',
    schema:properties({listingId:S.str('UUID do rascunho salvo',40),name:S.str('Nome simples da tabela',60),medidas:S.obj('Objeto com rows: [{size,footLengthCm,footLengthToCm opcional}], medidas reais em cm.')},['listingId','name','medidas']),
    action:(a,t)=>requestAdmin('mercadolivre-oauth-callback',t,undefined,{action:'chart_prepare',listingId:requiredText(a,'listingId',40),name:requiredText(a,'name',60),rows:(a.medidas as Args)?.rows}),
  },
  mercadolivre_preparar_tabela_vestuario: {
    description:'Prepara tabela de vestuário com medidas da roupa (CLOTHING_MEASURE) ou corporais (BODY_MEASURE), nunca misturadas. Consulte mercadolivre_modelo_tabela para os IDs oficiais. Informe fonte e medidas reais ou de referência claramente identificadas; não invente medidas. Não cria tabela externa. Mostre a prévia exata para aprovação.',
    schema:properties({listingId:S.str('UUID do rascunho Mercado Livre',40),name:S.str('Nome sem caracteres especiais',60),measurementType:{type:'string',enum:['CLOTHING_MEASURE','BODY_MEASURE']},measurementSource:S.str('Fonte das medidas e eventuais limitações',500),rows:{type:'array',minItems:1,maxItems:75,items:{type:'object',required:['size','measurements'],properties:{size:{type:'string'},equivalentSize:{type:'string'},measurements:{type:'object',additionalProperties:{type:'number'},description:'Chaves oficiais da ficha técnica, valores em cm. Ex.: GARMENT_CHEST_WIDTH_FROM e GARMENT_LENGTH_FROM.'}}}}},['listingId','name','measurementType','measurementSource','rows']),
    action:(a,t)=>requestAdmin('mercadolivre-oauth-callback',t,undefined,{action:'chart_prepare',listingId:requiredText(a,'listingId',40),name:requiredText(a,'name',60),measurementType:requiredText(a,'measurementType',30),measurementSource:requiredText(a,'measurementSource',500),rows:a.rows}),
  },
  mercadolivre_criar_tabela_vestuario: {
    description:'Cria tabela definitiva somente após aprovação expressa da prévia exata de vestuário. Tabelas não podem ser excluídas; não repetir após resposta incerta.',
    schema:properties({intentId:S.str('UUID da prévia aprovada',40),confirmar:S.bool('Administrador aprovou a prévia exata')},['intentId','confirmar']),openWorld:true,
    action:(a,t)=>{yes(a);return requestAdmin('mercadolivre-oauth-callback',t,undefined,{action:'chart_create',intentId:requiredText(a,'intentId',40),confirmar:true});},
  },
  mercadolivre_criar_tabela_calcados: {
    description:'Criar tabela definitiva no Mercado Livre APENAS após o usuário revisar e aprovar explicitamente a prévia exata. Tabelas não podem ser excluídas. Nunca repetir em caso de resposta incerta.',
    schema:properties({intentId:S.str('UUID da prévia aprovada',40),confirmar:S.bool('Administrador confirmou a criação definitiva da tabela')},['intentId','confirmar']),openWorld:true,
    action:(a,t)=>{yes(a);return requestAdmin('mercadolivre-oauth-callback',t,undefined,{action:'chart_create',intentId:requiredText(a,'intentId',40),confirmar:true});},
  },
  mercadolivre_detalhar_tabela: {
    description:'Consultar tabela de medidas existente pelo ID oficial e suas linhas. Somente leitura.',
    schema:properties({chartId:S.str('ID oficial da tabela',30)},['chartId']),readOnly:true,openWorld:true,
    action:(a,t)=>requestAdmin('mercadolivre-oauth-callback',t,undefined,{action:'chart_detail',chartId:requiredText(a,'chartId',30)}),
  },
  mercadolivre_validar_anuncio: {
    description:'Verificar anúncio salvo, ficha técnica, variação e estoque e executar validador oficial sem publicar. Nunca cria anúncio.',
    schema:properties({listingId:S.str('UUID de rascunho salvo na Gestão',40)},['listingId']),readOnly:true,openWorld:true,
    action:(a,t)=>requestAdmin('mercadolivre-oauth-callback',t,undefined,{action:'validate_listing',listingId:requiredText(a,'listingId',40)}),
  },
  mercadolivre_listar_anuncios: {
    description:'Listar IDs dos anúncios da conta vendedora Mercado Livre conectada diretamente via OAuth, com total e paginação; não consulta o Bling.',
    schema:properties({limit:{type:'integer',minimum:1,maximum:30},offset:{type:'integer',minimum:0,maximum:1000}}),
    readOnly:true,openWorld:true,
    action:async (a,token)=>requestAdmin('mercadolivre-oauth-callback',token,undefined,{
      action:'list',limit:Number(a.limit)||15,offset:Number(a.offset)||0}),
  },
  mercadolivre_detalhar_anuncio: {
    description:'Consultar diretamente na API Mercado Livre um anúncio da ANAROSA por ID MLB. Retorna atributos, fotos, descrição, situação e qualidade/performance oficial (ações pendentes), quando a API disponibilizar. Somente leitura.',
    schema:properties({id:S.str('Identificador do anúncio MLB (exemplo MLB1234567890)',30)},['id']),
    readOnly:true,openWorld:true,
    action:async (a,token)=>requestAdmin('mercadolivre-oauth-callback',token,undefined,{
      action:'detail',id:requiredText(a,'id',30)}),
  },
  mercadolivre_verificar_familia: {
    description:'Conferir na API oficial se todos os IDs MLB informados pertencem à mesma família de User Products. Somente leitura. Informe todos os tamanhos esperados.',
    schema:properties({ids:{type:'array',items:{type:'string',pattern:'^MLB[0-9]{8,16}$'},minItems:2,maxItems:10}},['ids']),
    readOnly:true,openWorld:true,
    action:async(a,t)=>{
      if(!Array.isArray(a.ids)||a.ids.length<2||a.ids.length>10||new Set(a.ids).size!==a.ids.length||a.ids.some(id=>typeof id!=='string'||!/^MLB[0-9]{8,16}$/.test(id)))throw Error('Informe de 2 a 10 IDs MLB distintos.');
      const results=await Promise.all(a.ids.map(async id=>{
        const r=await requestAdmin('mercadolivre-oauth-callback',t,undefined,{action:'detail',id}) as any;
        return {id,ok:r.ok===true,active:r.item?.status==='active',sku:r.item?.attributes?.find((x:any)=>x.id==='SELLER_SKU')?.value_name||null,price:r.item?.price??null,stock:r.item?.available_quantity??null,family:r.family||null};
      }));
      const families=new Set(results.map(r=>r.family?.familyId));
      const users=results.map(r=>r.family?.userProductId);
      const skus=results.map(r=>r.sku);
      const verified=results.every(r=>r.ok&&r.family?.verified===true&&!!r.family?.familyId&&!!r.sku)&&families.size===1&&new Set(users).size===results.length&&new Set(skus).size===results.length&&results.every(r=>users.every(u=>r.family.members.includes(u)));
      return {ok:verified,grouped:verified,allActive:results.every(r=>r.active),familyId:verified?results[0].family.familyId:null,results,message:verified?'Todos os IDs informados pertencem à mesma família oficial.':'Agrupamento não confirmado; não repita publicações.'};
    },
  },
  mercadolivre_fila_produto: {
    description:'Consultar fila local de rascunhos por SKU, detectar duplicidades e indicar o próximo rascunho único pronto. Somente leitura; sem execução em segundo plano. Valide e publique com confirmação explícita, um SKU por vez.',
    schema:properties({blingId:S.str('ID do produto principal Bling',19)},['blingId']),readOnly:true,
    action:async(a)=>{
      const blingId=validBlingId(a.blingId);
      const {data,error}=await getServiceClient().from('store_marketplace_listings').select('id,title,status,external_listing_id,variation_mapping,last_error').eq('bling_product_id',blingId).eq('marketplace','mercado_livre').order('id');
      if(error)return {ok:false,message:'Não foi possível consultar a fila local.'};
      const singles=(data||[]).flatMap((r:any)=>{
        const v=(Array.isArray(r.variation_mapping)?r.variation_mapping:[]).filter((x:any)=>x.enabled===true);
        return v.length===1&&v[0].sku?[{listingId:r.id,sku:v[0].sku,size:v[0].size,status:r.status,externalListingId:r.external_listing_id,lastError:r.last_error}]:[];
      });
      const duplicates=singles.filter((r:any,i:number)=>singles.some((x:any,j:number)=>i!==j&&x.sku===r.sku)).map((r:any)=>r.sku);
      const unresolved=singles.some((r:any)=>r.status==='blocked'||(r.externalListingId&&r.status!=='published'));
      const next=unresolved?null:singles.find((r:any)=>r.status==='ready'&&!r.externalListingId&&!duplicates.includes(r.sku))||null;
      return {ok:true,blingId,entries:singles,duplicateSkus:[...new Set(duplicates)],unresolved,next,message:unresolved?'Reconcilie publicação pendente antes de continuar.':'Fila consultada; nenhuma publicação executada.'};
    },
  },
  mercadolivre_comparar_modalidades: {
    description:'Consultar a cotação de tarifa por venda do Mercado Livre para Clássico e Premium do anúncio MLB informado, com detalhes de comissão. Somente leitura; nunca altera tipo de anúncio nem promete parcelamento.',
    schema:properties({id:S.str('ID MLB do anúncio',30)},['id']),readOnly:true,openWorld:true,
    action:(a,t)=>requestAdmin('mercadolivre-oauth-callback',t,undefined,{action:'fees',id:requiredText(a,'id',30)}),
  },
  mercadolivre_corrigir_condicao_body: {
    description:'Corrigir exclusivamente a condição do conjunto body DUZIZO da ANAROSA para Novo no anúncio MLB5529252361. Requer confirmação expressa, confere vendedor, item ativo, ausência de vendas e preserva preço, fotos, estoque e envio. Não repetir caso a resposta seja incerta.',
    schema:properties({
      confirmar:S.bool('Administrador autorizou a condição Novo neste anúncio específico.')
    },['confirmar']),
    openWorld:true,
    action:(a,t)=>{yes(a);return requestAdmin('mercadolivre-oauth-callback',t,undefined,{
      action:'correct_new_condition',id:'MLB5529252361',confirmar:true
    });},
  },
  mercadolivre_preparar_correcao: {
    description:'PREVIEW apenas: preparar uma proposta para CORRIGIR anúncio já publicado diretamente na API oficial Mercado Livre (sem Bling). Aceita título, descrição, atributos da categoria e adição de fotos públicas; não mexe em preço/estoque/variações. Mostre o antes/depois integral ao administrador e solicite aprovação explícita ANTES de chamar mercadolivre_aplicar_correcao. Nunca afirmar que a prévia foi publicada.',
    schema:properties({
      id:S.str('ID real MLB do anúncio da ANAROSA',30),
      changes:S.obj('Alterações comprovadas: {title?:string, description?:string, attributes?:[{id:string,value_name?:string,value_id?:string}], addPictureUrls?:string[]} . Não inventar características, GTIN ou URLs. Foto deve ser pública da loja/Storage ANAROSA.')
    },['id','changes']),
    readOnly:true,openWorld:true,
    action:(a,t)=>{
      const id=requiredText(a,'id',30).toUpperCase();
      if(!/^MLB[0-9]{8,16}$/.test(id))throw Error('Código MLB inválido.');
      if(!a.changes||typeof a.changes!=='object'||Array.isArray(a.changes))throw Error('Objeto changes inválido.');
      return requestAdmin('mercadolivre-oauth-callback',t,undefined,{
        action:'edit_preview',id,changes:a.changes
      });
    },
  },
  mercadolivre_aplicar_correcao: {
    description:'AÇÃO DE ESCRITA REAL e irreversível no anúncio ativo do Mercado Livre. SOMENTE depois que o administrador revisar a prévia e AUTORIZAR EXPRESSAMENTE a alteração deste anúncio MLB. Precisa do previewId gerado na função anterior, confirmar=true. Recusa estado alterado, revisão expirada e reexecuções; nunca usar automaticamente nem sem aprovação do usuário. Pode alterar título, descrição, atributos ou acrescentar fotos conforme prévia; não altera estoque, preço nem variações. Consulte resultado real e não faça retry cego.',
    schema:properties({
      previewId:S.str('UUID exato da prévia aprovada pelo administrador',40),
      confirmar:S.bool('A pessoa administradora aprovou expressamente as alterações descritas na prévia. Nunca true sem essa aprovação.')
    },['previewId','confirmar']),
    openWorld:true,
    action:(a,t)=>{
      yes(a);
      const previewId=requiredText(a,'previewId',40);
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(previewId))
        throw Error('previewId inválido.');
      return requestAdmin('mercadolivre-oauth-callback',t,undefined,{
        action:'edit_apply',previewId,confirmar:true
      });
    },
  },
  listar_anuncios: {
    description:'Consultar anúncios reais no Bling por canal, inclusive códigos MLB, títulos, preços e situação; também retorna rascunhos da Gestão. Leitura apenas, sem publicar ou editar.',
    schema:properties({}),readOnly:true,
    action:async(_,t)=>{
      const [local,remote]=await Promise.allSettled([
        requestAdmin('admin-marketplace-listings',t),
        requestAdmin('admin-marketplace-channels',t),
      ]);
      if(local.status==='rejected')throw local.reason;
      const outside=remote.status==='fulfilled' ? remote.value as Record<string,unknown> : {};
      return {
        ...local.value as Record<string,unknown>,
        anunciosBling: Array.isArray(outside.ads) ? outside.ads : [],
        leituraExternaConfirmada:outside.adsAvailable===true,
        diagnosticoExterno:typeof outside.adsMessage==='string'?outside.adsMessage:'Não foi possível consultar os anúncios externos.',
        canaisBling: Array.isArray(outside.channels)?outside.channels:[],
      };
    },
  },
  verificar_canais_bling: {
    description:'Verificar canais Mercado Livre/Shopee no Bling, sem confundir presença do canal com autorização de publicação.',
    schema:properties({}),readOnly:true,
    action:(_,t)=>requestAdmin('admin-marketplace-channels',t),
  },

  listar_anuncios_bling: {
    description:'Consultar somente leitura os anúncios do Bling. Em caso de erro no endpoint oficial, informa claramente que a leitura externa não foi confirmada; nunca inventa publicações.',
    schema:properties({}),readOnly:true,
    action:(_,t)=>requestAdmin('admin-marketplace-channels',t),
  },
  vincular_anuncio_existente: {
    description:'Registrar para acompanhamento um código MLB que já existe no Mercado Livre e conferir o SKU contra o Bling. Não publica, não modifica o anúncio externo, não altera estoque e não comprova situação externa.',
    schema:properties({
      confirmar:S.bool('Confirmação explícita do administrador para salvar o vínculo local'),
      blingId:S.str('ID do produto principal Bling',19),
      sku:S.str('SKU exato do anúncio real, deve pertencer ao produto/variação',120),
      externalListingId:S.str('Código MLB do anúncio que já existe',40),
    },['confirmar','blingId','sku','externalListingId']),
    action:(a,t)=>{yes(a);validBlingId(a.blingId);
      const external=requiredText(a,'externalListingId',40).toUpperCase();
      if(!/^MLB[0-9]{8,16}$/.test(external))throw Error('Código MLB inválido.');
      return requestAdmin('admin-marketplace-listings',t,undefined,{
        action:'link',confirmar:true,marketplace:'mercado_livre',
        blingId:a.blingId,sku:requiredText(a,'sku',120),externalListingId:external,
      });
    },
  },
  auditar_catalogo: {
    description:'Identificar pendências de SKU, fotos, categorias e variações da loja.',
    schema:properties({}),readOnly:true,
    action:(_,t)=>requestAdmin('admin-catalog-audit',t),
  },
  cadastrar_produto: {
    description:'Cadastrar produto físico real no BLING pela mesma função segura da Gestão. Requer confirmação prévia do administrador e UUID de idempotência. Não invente dados fiscais, preços ou estoque.',
    schema:properties({confirmar:S.bool('Confirmação explícita do administrador'),operationKey:S.str('UUID persistente para não duplicar requisição',40),nome:S.str('Nome real',120),sku:S.str('Código único',60),
      preco:S.number('Preço base confirmado em BRL'),marca:S.str('Marca comprovada',100),categoriaId:S.str('Categoria Bling numérica, previamente consultada',19),
      descricaoCurta:S.str('Descrição curta baseada em dados reais',500),descricaoComplementar:S.str('Descrição completa',7000),
      ativo:S.bool('Ativar produto no Bling'),images:S.arr('Até 12 URLs HTTPS das fotos, previamente carregadas'),
      variacoes:S.arr('Variações com nome Tamanho:P;Cor:Preto, SKU e preço válidos'),
      gtin:S.str('Código GTIN real ou SEM GTIN',14),unidade:S.str('Unidade, ex. UN',6),
      tributacao:S.obj('NCM, CEST, origem fornecidos pelo vendedor'),
      dimensoes:S.obj('Dimensões confirmadas'),
    },['confirmar','operationKey','nome','sku','preco']),
    action:(a,t)=>{yes(a);operationId(a);return requestAdmin('admin-product-create',t,undefined,
      {...jsonParams(a,['nome','sku','preco','marca','categoriaId','descricaoCurta','descricaoComplementar','ativo','images','variacoes','gtin','unidade','tributacao','dimensoes']),operationKey:a.operationKey});},
  },
  atualizar_produto: {
    description:'Atualizar produto já existente no BLING sem remover variações, usando revisão obtida em detalhar_produto. Exige confirmação e UUID de idempotência.',
    schema:properties({confirmar:S.bool('Confirmação explícita'),operationKey:S.str('UUID persistente',40),
      blingId:S.str('ID Bling',19),revision:S.str('Revisão retornada ao consultar cadastro',100),
      nome:S.str('Nome real'),sku:S.str('SKU atual'),preco:S.number('Preço base confirmado'),
      descricaoCurta:S.str('Descrição curta',500),descricaoComplementar:S.str('Descrição completa',7000),marca:S.str('Marca',100),
      categoriaId:S.str('Categoria Bling',19),ativo:S.bool('Ativo ou inativo'),
      variacoes:S.arr('Manter todas variações existentes com IDs; desativar em vez de apagar'),
      images:S.arr('URLs HTTPS, não sobrescrever imagens internas do Bling'),
    },['confirmar','operationKey','blingId','revision','nome','sku','preco']),
    action:(a,t)=>{yes(a);operationId(a);validBlingId(a.blingId);
      return requestAdmin('admin-product-update',t,undefined,
        {...jsonParams(a,['blingId','revision','nome','sku','preco','descricaoCurta','descricaoComplementar','marca','categoriaId','ativo','variacoes','images']),operationKey:a.operationKey});},
  },
  ajustar_estoque: {
    description:'Registrar entrada, saída ou balanço por SKU/depósito no Bling e sincronizar saldo. Exige confirmação explícita; nunca definir números presumidos.',
    schema:properties({confirmar:S.bool('Confirmação da movimentação'),operationKey:S.str('UUID idempotente',40),
      blingProductId:S.str('ID do produto ou variação',19),depositoId:S.str('ID do depósito',19),
      operacao:{type:'string',enum:['entrada','saida','balanco']},quantidade:S.number('Quantidade confirmada; balanço é estoque absoluto'),
      observacoes:S.str('Observação',500)},['confirmar','operationKey','blingProductId','depositoId','operacao','quantidade']),
    action:(a,t)=>{yes(a);operationId(a);validBlingId(a.blingProductId);validBlingId(a.depositoId);
      return requestAdmin('admin-stock-adjust',t,undefined,{...jsonParams(a,['blingProductId','depositoId','operacao','quantidade','observacoes']),operationKey:a.operationKey});},
  },
  meta_status: {
    description:'Consultar se a conta de anúncios Meta está autorizada para a ANAROSA; NÃO retorna tokens nem publica nada.',
    schema:properties({}),readOnly:true,
    action:(_a,t)=>requestAdmin('admin-meta-ads',t,{action:'status'}),
  },
  meta_listar_conjuntos: {
    description:'Consultar conjuntos de anúncios disponíveis na conta Meta da ANAROSA. Exige conexão oficial prévia; sem criação.',
    schema:properties({}),readOnly:true,openWorld:true,
    action:(_a,t)=>requestAdmin('admin-meta-ads',t,{action:'adsets'}),
  },
  meta_listar_rascunhos: {
    description:'Listar rascunhos, aprovações e anúncios pausados gerados pela Gestão ANAROSA. Não cria anúncios.',
    schema:properties({}),readOnly:true,
    action:(_a,t)=>requestAdmin('admin-meta-ads',t,{action:'list'}),
  },
  meta_criar_rascunho: {
    description:'Criar ou editar SOMENTE prévia local de anúncio patrocinado Meta para produto real da ANAROSA. Não publica nem ativa orçamento. Título, texto e imagem devem refletir a peça. Exigir confirmação do usuário para salvar.',
    schema:properties({
      confirmar:S.bool('Usuário autorizou salvar este rascunho local'),
      blingId:S.str('ID real do produto do Bling',19),
      title:S.str('Título publicitário com fatos verificados',160),
      primaryText:S.str('Texto principal persuasivo sem inventar características',2200),
      description:S.str('Descrição complementar',500),
      imageUrl:S.str('URL da foto pertencente ao produto; omitir para a primeira',1500),
      adsetId:S.str('ID de conjunto de anúncios da Meta, quando já conectado',19),
      id:S.str('UUID do rascunho existente para revisar',36),
    },['confirmar','blingId']),
    action:(a,t)=>{yes(a);validBlingId(a.blingId);
      return requestAdmin('admin-meta-ads',t,undefined,
        {action:'save',...jsonParams(a,['blingId','title','primaryText','description','imageUrl','adsetId','id'])});},
  },
  meta_aprovar_rascunho: {
    description:'Aprovar explicitamente UMA versão de anúncio Meta após mostrar título, foto, texto, destino e conjunto da Meta ao usuário. Aprovar NÃO publica ou ativa campanha.',
    schema:properties({confirmar:S.bool('Usuário aprovou a prévia EXATA'),
      id:S.str('UUID do anúncio',36),revision:{type:'integer',minimum:1}},['confirmar','id','revision']),
    action:(a,t)=>{yes(a);
      return requestAdmin('admin-meta-ads',t,undefined,{action:'approve',id:requiredText(a,'id',36),revision:a.revision,confirmar:true});},
  },
  meta_publicar_anuncio_pausado: {
    description:'Cria anuncio pago EXTERNAMENTE na conta Meta SEM VEICULAÇÃO (status PAUSED). Requer autorização Meta, conjunto válido, aprovação expressa da versão e nova confirmação do usuário. Não cria, ativa nem altera orçamento de campanha/conjunto. Não repetir após resultado incerto.',
    schema:properties({confirmar:S.bool('Usuário autorizou criar ESTE anúncio PAUSADO na Meta'),
      id:S.str('UUID do anúncio aprovado',36),revision:{type:'integer',minimum:1}},['confirmar','id','revision']),
    openWorld:true,
    action:(a,t)=>{yes(a);
      return requestAdmin('admin-meta-ads',t,undefined,{action:'publish_paused',id:requiredText(a,'id',36),revision:a.revision,confirmar:true});},
  },
  salvar_anuncio: {
    description:'Salvar rascunho ou preparar revisão de anúncio de Mercado Livre/Shopee ligado a um produto Bling; preparar NÃO publica.',
    schema:properties({confirmar:S.bool('Administrador aprovou criação/alteração do rascunho'),
      acao:{type:'string',enum:['save','prepare']}, dados:S.obj('Objeto com blingId, marketplace, title, price, categoryExternalId, shippingMode, images, variations, attributes e campos opcionais.')},['confirmar','acao','dados']),
    action:(a,t)=>{yes(a);if(!a.dados||typeof a.dados!=='object'||Array.isArray(a.dados))throw Error('Objeto de anúncio inválido.');
      return requestAdmin('admin-marketplace-listings',t,undefined,{...(a.dados as Args),action:a.acao});},
  },
  solicitar_publicacao_anuncio: {
    description:'Solicitar publicação real ao Mercado Livre, com revisão de categoria, SKU, estoque, imagens, deduplicação e verificação de ID MLB. Requer confirmação administrativa. Não repetir automaticamente após resultado incerto. Para testar sem publicar, use mercadolivre_validar_anuncio.',
    schema:properties({confirmar:S.bool('Administrador autorizou publicar'),dados:S.obj('Dados e ID do anúncio preparados; dryRun:true executa apenas a validação.')},['confirmar','dados']),
    action:(a,t)=>{yes(a);if(!a.dados||typeof a.dados!=='object'||Array.isArray(a.dados))throw Error('Anúncio inválido.');
      const args=a.dados as Args;
      // Compatibilidade com sessões MCP que ainda possuem o catálogo anterior de ferramentas.
      // As operações de metadados não podem publicar nem criar tabelas.
      if(args.dryRun===true&&['category_schema','chart_schema','chart_detail','chart_template','chart_search','chart_prepare'].includes(String(args.metadata||''))){
        return requestAdmin('mercadolivre-oauth-callback',t,undefined,{action:args.metadata,categoryId:args.categoryExternalId,chartId:args.chartId,gender:args.gender,brand:args.brand,gridType:args.gridType,listingId:args.id,name:args.name,rows:args.rows,measurementType:args.measurementType,measurementSource:args.measurementSource});
      }
      // Compatibilidade com o catálogo MCP anterior: mesma aprovação e mesma prévia imutável.
      if(args.operation==='create_size_chart'){
        if(args.dryRun===true||args.marketplace!=='mercado_livre')throw Error('Confirme a criação definitiva de tabela Mercado Livre.');
        const intentId=requiredText(args,'intentId',40);
        if(!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(intentId))throw Error('ID de prévia inválido.');
        return requestAdmin('mercadolivre-oauth-callback',t,undefined,{action:'chart_create',intentId,confirmar:true});
      }
      return requestAdmin('admin-marketplace-listings',t,undefined,{...args,action:'publish',confirmar:true});},
  },
  gerar_imagem_comercial: {
    description:'Gerar uma imagem de divulgação original via API paga de imagens, somente quando OPENAI_API_KEY estiver configurada no servidor. Limite 3/h; exige aprovação de custo. Salvar no Storage; NÃO associa automaticamente ao produto.',
    schema:properties({confirmar:S.bool('Administrador aprovou geração paga desta imagem'),prompt:S.str('Descrição visual detalhada. Não inventar características de peça real',1500)},['confirmar','prompt']),
    action:generateImage,
  },
  importar_imagem_gerada: {
    description:'Receber foto JÁ criada no ChatGPT ou outra ferramenta, em base64 JPG/PNG/WebP (máximo 3MB), validar pelo backend e guardar no Storage. Não gera imagem aqui; retorno traz URL para usar no cadastro.',
    schema:properties({confirmar:S.bool('Autorização para armazenar foto'),mime:{type:'string',enum:['image/jpeg','image/png','image/webp']},
      base64:S.str('Conteúdo binário base64 da imagem sem prefixo data URI',MAX_INPUT)},['confirmar','mime','base64']),
    action:uploadImage,
  },
  importar_imagem_anexo: {
    description:'Importar uma imagem de anexo já transferida pelo Pollo conectado à ANAROSA, usando o accessURL retornado por upload_attachment. Somente origem e caminho autorizados, JPG/PNG/WebP até 3MB. Requer confirmação. Salva no Storage sem alterar produto ou anúncio. Não aceita caminhos locais, IDs de arquivos ou URLs arbitrárias.',
    schema:properties({confirmar:S.bool('Administrador autorizou armazenar esta imagem'),url:S.str('accessURL exato do anexo retornado pelo Pollo da ANAROSA',1500)},['confirmar','url']),
    action:importAttachmentUrl,
  },
  sugerir_titulo_e_briefing: {
    description:'Gerar títulos iniciais e briefing de fotos a partir de atributos comprovados. Você, ChatGPT, pode melhorar a redação e criar a imagem visual antes de enviá-la via importar_imagem_gerada. Não inventar materiais, marcas nem características.',
    schema:properties({produto:S.str('Nome real do produto',120),marca:S.str('Marca confirmada',60),
      categoria:S.str('Categoria confirmada',80),cor:S.str('Cor confirmada',40),tamanho:S.str('Tamanho',25),
      diferenciais:S.str('Atributos comerciais confirmados',200)},['produto']),readOnly:true,
    action:async(a)=>{
      const vals=[toText(a.marca,60),requiredText(a,'produto',120),toText(a.cor,40),toText(a.tamanho,25)].filter(Boolean);
      const title=vals.join(' ').replace(/\s+/g,' ').slice(0,120);
      const details=toText(a.diferenciais,200);
      return { title, shorterTitle:title.slice(0,60),
        description:[requiredText(a,'produto',120),details].filter(Boolean).join('. '),
        creativeBrief:'Fotografia comercial realista em fundo neutro da peça ' + title +
          ', com frente, costas e detalhes reais do tecido; não inventar logotipo, estampas ou características não presentes nas fotos fornecidas.',
        notice:'Revisar informações reais e imagens antes de cadastrar. A ferramenta não gera bytes da foto automaticamente.' };
    },
  },
};
const toolIndex = Object.entries(actions).map(([name, t]) => ({
  name, description:t.description, inputSchema:t.schema,
  annotations:{ readOnlyHint:!!t.readOnly, destructiveHint:!t.readOnly, openWorldHint:!!t.openWorld },
}));
const ok = (id: string|number|null|undefined, result: unknown) =>
  new Response(JSON.stringify({jsonrpc:'2.0',id:id??null,result}),{
    headers:{'Content-Type':'application/json','Cache-Control':'no-store'},
  });
const rpcError = (id: string|number|null|undefined, code: number, message: string) =>
  new Response(JSON.stringify({jsonrpc:'2.0',id:id??null,error:{code,message}}),{
    headers:{'Content-Type':'application/json','Cache-Control':'no-store'},
  });

Deno.serve(async (req: Request): Promise<Response> => {
  const url=new URL(req.url);
  const resource=APP_URL + '/functions/v1/anarosa-mcp';
  const metadataUrl=resource + '/oauth-protected-resource';
  // Discovery is public. It NEVER contains user, store or token data.
  if(req.method==='GET' && (url.pathname.endsWith('/oauth-protected-resource') ||
     url.pathname.endsWith('/.well-known/oauth-protected-resource'))) {
    return new Response(JSON.stringify({
      resource, authorization_servers:[APP_URL + '/auth/v1'],
      bearer_methods_supported:['header'],
    }),{headers:{'Content-Type':'application/json','Cache-Control':'public,max-age=300'}});
  }
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers:{Allow:'GET,POST,OPTIONS'}});
  if(req.method!=='POST')return failure('Use MCP Streamable HTTP via POST.',405);
  const authHeader=req.headers.get('authorization')||'';
  const token=/^Bearer\s+(.+)$/i.exec(authHeader)?.[1]?.trim();
  if(!token)return new Response(JSON.stringify({error:'Login administrativo necessário.'}),{
    status:401,headers:{'Content-Type':'application/json','Cache-Control':'no-store',
      'WWW-Authenticate':'Bearer resource_metadata="' + metadataUrl + '"'},
  });
  let admin;
  try { admin=await requireAdminUser(req,getServiceClient()); }
  catch {return failure('Sessão inválida ou usuário não autorizado para Gestão ANAROSA.',403);}
  const length=Number(req.headers.get('content-length')||0);
  if(length>MAX_INPUT+10000)return failure('Solicitação acima do limite.',413);
  let raw: string;
  try { raw=await req.text(); } catch { return failure('Body inválido.'); }
  if(raw.length>MAX_INPUT+10000)return failure('Body grande demais.',413);
  let data: JsonRpc;
  try { data=JSON.parse(raw); } catch{return rpcError(null,-32700,'JSON inválido.');}
  if(!data||data.jsonrpc!=='2.0'||typeof data.method!=='string')return rpcError(data?.id,-32600,'JSON-RPC inválido.');
  if(data.method==='notifications/initialized'||data.method.startsWith('notifications/'))return new Response(null,{status:202});
  if(data.method==='initialize')return ok(data.id,{
    protocolVersion:'2025-06-18',
    capabilities:{tools:{listChanged:false}},
    serverInfo:{name:'Anarosa Gestao MCP',version:'1.3.0'},
    instructions:'Ferramentas comerciais da Gestão ANAROSA para leitura, cadastro de produtos, estoque, rascunhos e anúncios. Nunca acesso a código, GitHub, SQL, secrets ou rede arbitrária. Confirmar explicitamente cada edição no Mercado Livre após exibir prévia e conferir versão; nunca executar modificações sem autorização expressa. Publicações reais somente se o canal autorizado confirmar.',
  });
  if(data.method==='ping')return ok(data.id,{});
  if(data.method==='tools/list')return ok(data.id,{tools:toolIndex});
  if(data.method!=='tools/call')return rpcError(data.id,-32601,'Método não disponível.');
  const name=toText(data.params?.name,90),tool=actions[name];
  if(!tool)return rpcError(data.id,-32602,'Ferramenta desconhecida.');
  const args=data.params?.arguments;
  if(args && (typeof args!=='object'||Array.isArray(args)))return rpcError(data.id,-32602,'Argumentos inválidos.');
  const {data:allowed,error:rateError}=await getServiceClient().rpc('rl_check_and_increment',{
    p_bucket:'anarosa-mcp:' + admin.id,p_limit:40,p_window_seconds:60,
  });
  if(rateError||allowed!==true)return ok(data.id,{content:[{type:'text',text:'Limite temporário do MCP. Tente novamente em instantes.'}],isError:true});
  try{
    const result=await tool.action((args||{}) as Args,token);
    return ok(data.id,textTool(result));
  }catch{
    // Evitar vazamento de internals, token ou stack em mensagens MCP.
    return ok(data.id,{content:[{type:'text',text:'Operação não concluída. Confira os campos exigidos e consulte novamente o cadastro antes de repetir uma alteração.'}],isError:true});
  }
});
