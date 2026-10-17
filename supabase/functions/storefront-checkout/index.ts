import { serve } from '../_shared/context.ts';
import { validateCheckout } from '../_shared/commerce-input.ts';
import { ValidationError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

serve(async (req,ctx)=> {
  if(req.method!=='POST') return methodNotAllowed(req,['POST']);
  const ip=(req.headers.get('x-forwarded-for')||'unknown').split(',')[0].slice(0,64);
  const limit=await ctx.db.rpc('rl_check_and_increment',{p_bucket:`checkout:${ip}`,p_limit:10,p_window_seconds:60});
  if(limit.error) throw new Error('rate_limit_unavailable');
  if(limit.data!==true) return json(req,{ok:false,message:'Muitas tentativas. Aguarde um minuto.'},429);
  const body=await req.text();
  if(new TextEncoder().encode(body).length>20000) throw new ValidationError('Pedido muito grande.');
  let raw; try {raw=JSON.parse(body);} catch {throw new ValidationError('JSON inválido.');}
  const request=await validateCheckout(raw);
  const {data,error}=await ctx.db.rpc('checkout_create',{p_request:request});
  if(error) {
    const messages:Record<string,string>={checkout_key_conflict:'Os dados deste pedido mudaram. Volte ao carrinho para iniciar uma nova revisão.',shipping_quote_required:'O frete precisa ser combinado antes do pagamento. Escolha combinar pelo WhatsApp.',insufficient_stock:'O estoque mudou ou ainda não foi confirmado. Revise os itens.',variant_required:'Escolha tamanho e cor antes de comprar.',variant_unavailable:'Variação indisponível.',product_unavailable:'Produto indisponível.',price_unavailable:'Preço ainda não disponível.',method_disabled:'Esta modalidade foi desabilitada. Atualize a página.'};
    if(messages[error.message]) throw new ValidationError(messages[error.message]);
    throw new Error('checkout_transaction_failed');
  }
  return json(req,{ok:true,...data},data.duplicate?200:201);
});
