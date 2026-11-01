/** Renova tokens Mercado Livre sob lock para não reutilizar refresh_token descartado. */
import type { Db } from './supabase.ts';
import { mlExchange, type MlCredentials } from './mercadolivre-oauth.ts';

export interface MlConnection {
  connection_key: string; seller_id: string; seller_nickname: string; scope: string;
  access_token: string; refresh_token: string; expires_at: string; status: string;
  refresh_lock_until: string | null; connected_at: string;
}

export async function activeMlConnection(db:Db, c:MlCredentials):Promise<{row:MlConnection|null; renewing:boolean}> {
  const {data,error}=await db.from('ml_oauth_tokens').select('*').eq('connection_key','anarosa').maybeSingle();
  if(error) throw new Error('ml_session_read_failed');
  if(!data) return {row:null,renewing:false};
  const row = data as MlConnection;
  if(Date.parse(row.expires_at)>Date.now()+120000 && row.status==='connected') return {row,renewing:false};
  if(!c.clientId || !c.clientSecret || !row.refresh_token) return {row,renewing:false};
  // A alteração do lock é atômica; chamadas simultâneas não reutilizam o mesmo refresh token.
  const {data:claimed,error:lockError}=await db.from('ml_oauth_tokens')
    .update({refresh_lock_until:new Date(Date.now()+45000).toISOString()})
    .eq('connection_key','anarosa')
    .eq('refresh_token',row.refresh_token)
    .or('refresh_lock_until.is.null,refresh_lock_until.lt.'+new Date().toISOString())
    .select('connection_key').maybeSingle();
  if(lockError) throw new Error('ml_session_lock_failed');
  if(!claimed) return {row,renewing:true};
  try {
    const next=await mlExchange(c,{grant_type:'refresh_token',refresh_token:row.refresh_token});
    if(String(next.user_id)!==row.seller_id) throw new Error('ml_session_seller_changed');
    const {data:updated,error:saveError}=await db.from('ml_oauth_tokens').update({
      access_token:next.access_token,refresh_token:next.refresh_token,
      scope:next.scope,expires_at:new Date(Date.now()+next.expires_in*1000).toISOString(),
      refresh_lock_until:null,status:'connected',updated_at:new Date().toISOString(),
    }).eq('connection_key','anarosa').eq('refresh_token',row.refresh_token)
      .select('*').maybeSingle();
    if(saveError || !updated) throw new Error('ml_session_rotation_failed');
    return {row:updated as MlConnection,renewing:false};
  } catch {
    await db.from('ml_oauth_tokens').update({refresh_lock_until:null,status:'error'})
      .eq('connection_key','anarosa').eq('refresh_token',row.refresh_token);
    throw new Error('ml_session_refresh_failed_reauthorize');
  }
}
