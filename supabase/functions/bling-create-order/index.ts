import { serve } from '../_shared/context.ts';
import { requireAdmin } from '../_shared/admin-auth.ts';
import { processOrderJob, workerDeps } from '../_shared/bling-order-worker.ts';
import { ValidationError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
// Legacy endpoint now delegates to the single paid-order pipeline.
serve(async(req,ctx)=>{
  if(req.method!=='POST')return methodNotAllowed(req,['POST']);
  requireAdmin(req); const body=await req.json();
  if(!/^[a-f0-9-]{36}$/i.test(body.orderId??''))throw new ValidationError('Informe orderId de um pedido pago existente.');
  return json(req,{ok:true,result:await processOrderJob(workerDeps(ctx,body.orderId))});
});
