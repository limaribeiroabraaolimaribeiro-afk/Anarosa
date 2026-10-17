import assert from 'node:assert/strict';
import {
  type OrderJob,
  type OrderWorkerDeps,
  processOrderJob,
  workerDeps,
} from '../_shared/bling-order-worker.ts';
import type { AppContext } from '../_shared/context.ts';
const job = { id: 'test-order', bling_submission_started_at: null, bling_sync_attempts: 1 } as OrderJob;

function contactFixture() {
  let contacts: Record<string, unknown>[] = [], posts = 0;
  const client = {
    findContactsByDocument: async () => ({ data: contacts }),
    createContact: async (payload: Record<string, unknown>) => {
      posts++;
      assert.equal(payload.tipo, 'F');
      contacts = [{ id: 77, numeroDocumento: payload.numeroDocumento }];
      return { data: { id: 77 } };
    },
  };
  const chain = {
    select: () => chain,
    eq: () => chain,
    update: () => chain,
    then: (resolve: CallableFunction) => resolve({ error: null }),
  };
  const ctx = {
    blingConfig: { orderSyncEnabled: false },
    client: () => client,
    db: {
      rpc: async () => ({ data: { state: 'claimed' }, error: null }),
      from: (table: string) =>
        table === 'store_admin_operations' ? chain : {
          select: () => ({
            eq: async () => ({
              data: [{ bling_product_id: '101', sku: 'TEST', name: 'Teste', quantity: 1, unit_price: 100 }],
              error: null,
            }),
          }),
        },
    },
  } as unknown as AppContext;
  const order = {
    ...job,
    total: 100,
    discount: 0,
    customer_data: { name: 'Teste', phone: '47999990000', document: '52998224725' },
    shipping_data: { method: 'pickup', cost: 0 },
    payment_data: { method: 'pix' },
  } as OrderJob;
  return { ctx, order, posts: () => posts };
}
Deno.test('paid order: contact provisioning requires capability before any remote write', async () => {
  const prior = Deno.env.get('BLING_CONTACT_CREATE_ENABLED');
  Deno.env.delete('BLING_CONTACT_CREATE_ENABLED');
  try {
    const f = contactFixture();
    await assert.rejects(workerDeps(f.ctx).prepare(f.order), /ainda não validado/);
    assert.equal(f.posts(), 0);
  } finally {
    if (prior === undefined) Deno.env.delete('BLING_CONTACT_CREATE_ENABLED');
    else Deno.env.set('BLING_CONTACT_CREATE_ENABLED', prior);
  }
});
Deno.test('paid order: new contact is durably registered and subsequent orders reuse exact document', async () => {
  const prior = Deno.env.get('BLING_CONTACT_CREATE_ENABLED');
  Deno.env.set('BLING_CONTACT_CREATE_ENABLED', 'true');
  try {
    const f = contactFixture();
    const first = await workerDeps(f.ctx).prepare(f.order);
    await workerDeps(f.ctx).prepare(f.order);
    assert.deepEqual(first.contato, { id: 77 });
    assert.equal(f.posts(), 1);
  } finally {
    if (prior === undefined) Deno.env.delete('BLING_CONTACT_CREATE_ENABLED');
    else Deno.env.set('BLING_CONTACT_CREATE_ENABLED', prior);
  }
});
function fake(p: Partial<OrderWorkerDeps> = {}) {
  const events: string[] = [];
  const deps: OrderWorkerDeps = {
    enabled: true,
    claim: async () => job,
    find: async () => [],
    prepare: async () => ({}),
    start: async () => {
      events.push('start');
    },
    create: async () => {
      events.push('create');
      return { data: { id: 123 } };
    },
    finish: async (_o, s) => {
      events.push(s);
    },
    ...p,
  };
  return { deps, events };
}
Deno.test('paid order: successful export is marked synced once', async () => {
  const { deps, events } = fake();
  assert.equal(await processOrderJob(deps), 'synced');
  assert.deepEqual(events, ['start', 'create', 'synced']);
});
Deno.test('paid order: reference recovers an uncertain POST without creating again', async () => {
  const { deps, events } = fake({ find: async () => [{ id: 123, numeroLoja: 'anarosa-test-order' }] });
  await processOrderJob(deps);
  assert.deepEqual(events, ['synced']);
});
Deno.test('paid order: ambiguous timeout requires review, never retries POST', async () => {
  const { deps, events } = fake({
    create: async () => {
      throw new Error('timeout');
    },
  });
  assert.equal(await processOrderJob(deps), 'review');
  assert.deepEqual(events, ['start', 'review']);
});
Deno.test('paid order: expired claim with submitted marker only performs lookup', async () => {
  const { deps, events } = fake({
    claim: async () => ({ ...job, bling_submission_started_at: '2026-01-01' }),
  });
  await processOrderJob(deps);
  assert.deepEqual(events, ['review']);
});
Deno.test('paid order: read failure can be retried before submission', async () => {
  const { deps, events } = fake({
    find: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(await processOrderJob(deps), 'failed');
  assert.deepEqual(events, ['failed']);
});
Deno.test('paid order: disabled integration has no side effects', async () => {
  const { deps, events } = fake({
    enabled: false,
    claim: async () => {
      throw new Error('must not claim');
    },
  });
  assert.equal(await processOrderJob(deps), 'disabled');
  assert.deepEqual(events, []);
});
Deno.test('paid order: two matches require review', async () => {
  const { deps, events } = fake({
    find:
      async () => [{ id: 1, numeroLoja: 'anarosa-test-order' }, { id: 2, numeroLoja: 'anarosa-test-order' }],
  });
  await processOrderJob(deps);
  assert.deepEqual(events, ['review']);
});
