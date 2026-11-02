/** Consulta e melhoria de anúncio próprio via API oficial Mercado Livre.
 * Não modifica preço, estoque, frete, categoria ou publicação.
 * Toda gravação exige confirmar=true e revisão do conteúdo atual.
 */
import {serve} from '../_shared/context.ts';
import {requireAdminUser} from '../_shared/admin-user-auth.ts';
import {json,methodNotAllowed} from '../_shared/responses.ts';
import {ValidationError} from '../_shared/errors.ts';
import {mlAccessToken,mlApi} from '../_shared/mercadolivre.ts';
const ID=/^MLB[0-9]{8,16}$/;
const trim=(v:unknown,max:number)=>typeof v==='string'?v.trim().slice(0,max):'';
function owned(item:Record<string,unknown>,sellerId:number):void{
  if(Number(item.seller_id)!==sellerId)throw new ValidationError('Este anúncio não pertence à conta Mercado Livre autorizada.');
}
serve(async(req,ctx)=>{
  const admin=await requireAdminUser(req,ctx.db);
  if(req.method!=='GET'&&req.method!=='POST')return methodNotAllowed(req,['GET','POST']);
  const {data:allowed,error:limitError}=await ctx.db.rpc('rl_check_and_increment',{
    p_bucket:'admin-ml-listing:'+admin.id,p_limit:40,p_window_seconds:60,
  });
  if(limitError||allowed!==true)throw new ValidationError('Limite de consultas/edições atingido.');
  const input=req.method==='POST'?await req.json() as Record<string,unknown>:{itemId:new URL(req.url).searchParams.get('itemId')};
  const id=trim(input.itemId,30).toUpperCase();
  if(!ID.test(id))throw new ValidationError('Informe um código MLB válido.');
  const {token,sellerId}=await mlAccessToken(ctx.db);
  const item=await mlApi(token,'/items/'+id);
  owned(item,sellerId);
  const descr=await mlApi(token,'/items/'+id+'/description').catch(()=>({plain_text:''}));
  const currentTitle=String(item.title||'');
  const currentDescription=String(descr.plain_text||'');
  if(req.method==='GET'){
    return json(req,{ok:true,item:{
      id,title:currentTitle,description:currentDescription,status:item.status,
      soldQuantity:item.sold_quantity,availableQuantity:item.available_quantity,
      price:item.price,categoryId:item.category_id,permalink:item.permalink,
      pictures:item.pictures,attributes:item.attributes,variations:item.variations,
      sellerId,canEditTitle:Number(item.sold_quantity)===0,
    },notice:'Dados diretos do Mercado Livre. Alterações exigem confirmação e não modificam preço ou estoque.'});
  }
  if(input.confirmar!==true)throw new ValidationError('Aprovação do usuário obrigatória para alterar anúncio.');
  const field=trim(input.field,35),value=trim(input.value,7000);
  const expected=typeof input.expectedValue==='string'?input.expectedValue:null;
  if(expected===null)throw new ValidationError('Primeiro consulte o anúncio e envie o valor anterior para evitar edição desatualizada.');
  if(field==='title'){
    if(Number(item.sold_quantity)>0)throw new ValidationError('Este anúncio tem vendas; Mercado Livre bloqueia alteração de título.');
    if(expected!==currentTitle)throw new ValidationError('O título mudou; consulte novamente antes de editar.');
    if(value.length<5||value.length>120)throw new ValidationError('Título deve conter entre 5 e 120 caracteres.');
    if(value!==currentTitle)await mlApi(token,'/items/'+id,'PUT',{title:value});
  }else if(field==='description'){
    if(expected!==currentDescription)throw new ValidationError('Descrição alterada desde a consulta; revise antes de editar.');
    if(value.length<20||value.length>7000||/<[^>]+>/.test(value)){
      throw new ValidationError('Descrição deve ser texto simples entre 20 e 7000 caracteres.');
    }
    if(value!==currentDescription)await mlApi(token,'/items/'+id+'/description?api_version=2','PUT',{plain_text:value});
  }else throw new ValidationError('Apenas título ou descrição podem ser editados nesta versão. Preço/estoque permanecem no Bling.');
  const confirmed=field==='title'?await mlApi(token,'/items/'+id):
    await mlApi(token,'/items/'+id+'/description');
  const actual=field==='title'?String(confirmed.title||''):String(confirmed.plain_text||'');
  return json(req,{ok:actual===value,id,field,confirmed:actual===value,
    message:actual===value?'Atualização confirmada no Mercado Livre.':'A plataforma não confirmou a mudança; consulte o anúncio novamente.'});
});
