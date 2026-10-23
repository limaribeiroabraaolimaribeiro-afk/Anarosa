import type { AppContext } from './context.ts';
import { describeError, ValidationError } from './errors.ts';
import { sha256Hex } from './crypto.ts';

/** Durable command identity and resource exclusion, including uncertain writes.
 * Every call marks submission BEFORE its remote mutation. An interrupted remote
 * operation requires reconciliation; a new browser key cannot bypass that lock.
 */
export async function runAdminMutation(
  ctx: AppContext,
  input: { key: string; resource: string; actor: string | null; payload: unknown },
  work: (submitted: () => Promise<void>) => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  if (!/^[a-f0-9-]{36}$/i.test(input.key ?? '')) {
    throw new ValidationError('Reabra o formulário para obter uma referência de operação.');
  }
  const fingerprint = await sha256Hex(JSON.stringify(input.payload));
  const claim = await ctx.db.rpc('gestao_claim_operation', {
    p_key: input.key,
    p_resource: input.resource,
    p_actor: input.actor,
    p_fingerprint: fingerprint,
  });
  if (claim.error) {
    throw new ValidationError(
      'Já existe uma operação pendente neste produto. Confira o resultado no Bling antes de tentar novamente.',
    );
  }
  if (claim.data.state === 'completed') return claim.data.result;
  if (claim.data.state !== 'claimed') {
    throw new ValidationError(
      'Esta operação aguarda conferência no Bling. Não repita uma movimentação sem confirmar o resultado anterior.',
    );
  }
  let submitted = false;
  const markSubmitted = async () => {
    const result = await ctx.db.from('gestao_admin_operations').update({
      submitted_at: new Date().toISOString(),
    }).eq('operation_key', input.key).eq('status', 'processing');
    if (result.error) throw new Error('operation_submission_marker_failed');
    submitted = true;
  };
  try {
    const result = await work(markSubmitted);
    const saved = await ctx.db.rpc('gestao_finish_operation', {
      p_key: input.key,
      p_status: 'completed',
      p_result: result,
    });
    if (saved.error) throw new Error('operation_result_persist_failed');
    return result;
  } catch (error) {
    const description = describeError(error);
    const remoteStatus = Number(description.details?.blingStatus ?? 0);
    const uncertain = submitted && !(remoteStatus >= 400 && remoteStatus < 500 && remoteStatus !== 408);
    const result = await ctx.db.rpc('gestao_finish_operation', {
      p_key: input.key,
      p_status: uncertain ? 'review' : 'failed',
      p_result: { errorCode: description.code },
    });
    if (result.error) throw new Error('operation_finish_failed');
    throw error;
  }
}
