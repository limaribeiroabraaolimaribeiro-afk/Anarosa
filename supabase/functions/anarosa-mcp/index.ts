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
    'admin-marketplace-channels','admin-product-image-upload','admin-catalog-audit',
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
    return { ok: false, httpStatus: res.status, message: msg, ...(Array.isArray(payload.missing) ? { missing: payload.missing } : {}) };
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
  form.append('photo', new File([bytes], 'mcp-photo.' + ext, { type: mime }));
  const url = APP_URL + '/functions/v1/admin-product-image-upload';
  const headers: Record<string,string> = { Authorization:'Bearer ' + token };
  if (PUBLIC_KEY) headers.apikey = PUBLIC_KEY;
  const response = await fetch(url, { method:'POST', headers, body:form, signal: AbortSignal.timeout(25000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { ok:false, httpStatus:response.status, message:data.message || 'Falha ao importar foto.' };
  return { ok:true, url:data.url, message:'Imagem recebida no Storage. Inclua esta URL ao salvar o produto ou anúncio; o envio sozinho NÃO altera o Bling.' };
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
  listar_anuncios: {
    description:'Consultar anúncios rascunhos, status, Mercado Livre e Shopee. Publicado é somente o estado confirmado.',
    schema:properties({}),readOnly:true,
    action:(_,t)=>requestAdmin('admin-marketplace-listings',t),
  },
  verificar_canais_bling: {
    description:'Verificar canais Mercado Livre/Shopee no Bling, sem confundir presença do canal com autorização de publicação.',
    schema:properties({}),readOnly:true,
    action:(_,t)=>requestAdmin('admin-marketplace-channels',t),
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
  salvar_anuncio: {
    description:'Salvar rascunho ou preparar revisão de anúncio de Mercado Livre/Shopee ligado a um produto Bling; preparar NÃO publica.',
    schema:properties({confirmar:S.bool('Administrador aprovou criação/alteração do rascunho'),
      acao:{type:'string',enum:['save','prepare']}, dados:S.obj('Objeto com blingId, marketplace, title, price, categoryExternalId, shippingMode, images, variations, attributes e campos opcionais.')},['confirmar','acao','dados']),
    action:(a,t)=>{yes(a);if(!a.dados||typeof a.dados!=='object'||Array.isArray(a.dados))throw Error('Objeto de anúncio inválido.');
      return requestAdmin('admin-marketplace-listings',t,undefined,{...(a.dados as Args),action:a.acao});},
  },
  solicitar_publicacao_anuncio: {
    description:'Solicitar publicação por fluxo oficial. Atualmente a API da Gestão bloqueia envio sem canal homologado; NUNCA relatar como publicado sem ID externo confirmado.',
    schema:properties({confirmar:S.bool('Administrador autorizou publicar'),dados:S.obj('Dados e ID do anúncio preparados; o backend recusa se o marketplace não estiver conectado.')},['confirmar','dados']),
    action:(a,t)=>{yes(a);if(!a.dados||typeof a.dados!=='object'||Array.isArray(a.dados))throw Error('Anúncio inválido.');
      return requestAdmin('admin-marketplace-listings',t,undefined,{...(a.dados as Args),action:'publish'});},
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
    serverInfo:{name:'Anarosa Gestao MCP',version:'1.0.0'},
    instructions:'Ferramentas comerciais da Gestão ANAROSA para leitura, cadastro de produtos, estoque, rascunhos e anúncios. Nunca acesso a código, GitHub, SQL, secrets ou rede arbitrária. Confirmar operações de gravação. Publicações reais somente se o canal autorizado confirmar.',
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
