/**
 * Inspeção SOMENTE LEITURA de canais de venda do Bling.
 * Ver um canal no ERP não prova permissão de publicar anúncios nele.
 * Nunca retorna tokens, credenciais, IDs internos de outras entidades,
 * dados pessoais da loja ou respostas brutas de terceiros.
 */
import { serve } from '../_shared/context.ts';
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

type BlingChannel = Record<string, unknown>;
function str(input: unknown): string {
  return typeof input === 'string' ? input.trim().slice(0, 120) : '';
}
export function channelKey(input: BlingChannel): 'mercado_livre'|'shopee'|null {
  const v=[input.nome,input.descricao,input.nomeCanal,input.plataforma,input.tipo, input.nomeLoja]
    .map(str).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/mercado\s*livre|mercadolivre|mercado\s*envios/.test(v)) return 'mercado_livre';
  if (/\bshopee\b/.test(v)) return 'shopee';
  return null;
}

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);
  const admin=await requireAdminUser(req,ctx.db);
  const { data: allowed, error: rateError }=await ctx.db.rpc('rl_check_and_increment',{
    p_bucket:`marketplace-channels:${admin.id}`,p_limit:6,p_window_seconds:60,
  });
  if(rateError||allowed!==true)return json(req,{ok:false,message:'Aguarde antes de consultar novamente.'},429);
  let data: BlingChannel[];
  try {
    const response=await ctx.client().request<{data: BlingChannel[]}>('canais-venda',{
      method:'GET',query:{pagina:1,limite:100},operation:'channels.list_for_marketplace',
    });
    data=Array.isArray(response?.data)?response.data:[];
  } catch {
    return json(req,{ok:true,available:false,channels:[],
      message:'Não foi possível consultar os canais de venda no Bling com a autorização atual. Confira o escopo de canais de venda.'});
  }
  const channels=data.map((item)=>{
    const marketplace=channelKey(item);
    const id=item.id;
    return marketplace&&id != null && /^\d+$/.test(String(id))
      ? { marketplace,blingChannelId:String(id),name:str(item.nome)||str(item.descricao)||str(item.nomeLoja)||marketplace }
      : null;
  }).filter(Boolean).slice(0,50);
  // Tenta os filtros oficiais conhecidos, sem fazer qualquer gravação externa.
  // O endpoint /anuncios requer parâmetros que variam por versão da API.
  let ads: Record<string, unknown>[] = [];
  let adsAvailable = false;
  let adsMessage = '';
  const mercado = channels.find(c=>c?.marketplace==='mercado_livre');
  const storeId = mercado ? Number(mercado.blingChannelId) : 0;
  const candidates = [
    { pagina:1, limite:100, idCanalVenda:storeId },
    { pagina:1, limite:100, idLoja:storeId },
    { pagina:1 },
  ];
  const outcomes:string[]=[];
  for (const query of candidates) {
    try {
      const response = await ctx.client().request<{data: Record<string, unknown>[]}>('anuncios', {
        method: 'GET', query, operation: 'marketplace_ads.read_live',
      });
      if (!Array.isArray(response?.data)) throw new Error('unexpected_ads_response');
      adsAvailable = true;
      ads = response.data.slice(0, 100).map(a => ({
        id: a.id ?? null, codigo: a.codigo ?? null,
        titulo: a.titulo ?? a.nome ?? null,
        situacao: a.situacao ?? a.status ?? null,
        sku: a.sku ?? a.codigoProduto ?? null,
        produto: a.produto ?? null,
        loja: a.loja ?? a.canalVenda ?? a.idLoja ?? null,
        preco: a.preco ?? a.precoVenda ?? null,
        rawKeys: Object.keys(a).slice(0, 35),
      }));
      break;
    } catch (err) {
      const code = err && typeof err === 'object' && 'status' in err ? Number(err.status) : null;
      const kind = code && [400,401,403,404,422,429].includes(code) ? String(code) : 'indisponivel';
      outcomes.push(kind);
      if (code !== 400) break;
      // O Bling limita consultas por segundo.
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }
  if (!adsAvailable) {
    adsMessage = 'Consulta de anúncios ainda indisponível (tentativas HTTP: ' + outcomes.join(',') + '). Não houve publicação nem alteração.';
    // Diagnóstico adicional: somente tipos de validação e nomes de campos,
    // nunca dados brutos, tokens, IDs de pessoas ou credenciais.
    try {
      const token = await ctx.client().getValidAccessToken();
      const url = new URL('https://api.bling.com.br/Api/v3/anuncios');
      url.searchParams.set('pagina','1');
      url.searchParams.set('limite','100');
      url.searchParams.set('idLoja',String(storeId));
      const response = await fetch(url.href, {
        headers:{Authorization:'Bearer '+token,'enable-jwt':'1',Accept:'application/json'},
        signal:AbortSignal.timeout(8000),
      });
      const payload = await response.json();
      const err = payload && typeof payload==='object' ? payload.error : null;
      const safeType = typeof err?.type==='string' && /^[a-zA-Z_]{1,60}$/.test(err.type) ? err.type : '';
      const fields = Array.isArray(err?.fields)
        ? err.fields.map((f:unknown)=>typeof f==='object'&&f!==null&&'field' in f ? String(f.field) : '').filter((v:string)=>/^[a-zA-Z_]{1,60}$/.test(v)).slice(0,10)
        : [];
      adsMessage += (safeType?' Tipo: '+safeType+'.':'') + (fields.length?' Campos: '+fields.join(',')+'.':'');
    } catch { /* diagnóstico opcional e sem exposição de erros upstream */ }
  }
  return json(req,{ok:true,available:true,channels,adsAvailable,ads,adsMessage,
    message:channels.length
      ? 'Canais encontrados no Bling. A presença do canal não comprova autorização para publicar anúncios pela Gestão.'
      : 'O Bling não retornou instalações de Mercado Livre ou Shopee nesta consulta.'});
});
