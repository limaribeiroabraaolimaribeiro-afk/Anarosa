import assert from 'node:assert/strict';
import { mapBlingDeposits } from '../_shared/deposit-mapper.ts';

// Exemplo real fornecido pelo usuário (conta com 1 depósito "Geral", padrão).
const GERAL_DEPOSIT_RESPONSE = [
  { id: 123, descricao: 'Geral', situacao: 1, padrao: true, desconsiderarSaldo: false },
];

Deno.test('mapBlingDeposits: devolve o depósito "Geral" corretamente (caso real reportado)', () => {
  const items = mapBlingDeposits(GERAL_DEPOSIT_RESPONSE);
  assert.deepEqual(items, [
    { id: '123', descricao: 'Geral', ativo: true, padrao: true, desconsiderarSaldo: false },
  ]);
});

Deno.test('mapBlingDeposits: situacao inteiro 1 (não a string "A") é o que marca ativo', () => {
  const items = mapBlingDeposits([{ id: 1, descricao: 'X', situacao: 1, padrao: false, desconsiderarSaldo: false }]);
  assert.equal(items.length, 1);
  assert.equal(items[0].ativo, true);
});

Deno.test('mapBlingDeposits: situacao 0 é excluído (nunca aparece no seletor)', () => {
  const items = mapBlingDeposits([
    { id: 1, descricao: 'Ativo', situacao: 1, padrao: true, desconsiderarSaldo: false },
    { id: 2, descricao: 'Inativo', situacao: 0, padrao: false, desconsiderarSaldo: false },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].descricao, 'Ativo');
});

Deno.test('mapBlingDeposits: situacao como string "A"/"1" (formato errado) NÃO é tratado como ativo — nunca inventa depósito', () => {
  const items = mapBlingDeposits([
    { id: 1, descricao: 'X', situacao: 'A', padrao: false, desconsiderarSaldo: false },
    { id: 2, descricao: 'Y', situacao: '1', padrao: false, desconsiderarSaldo: false },
  ]);
  assert.deepEqual(items, [], 'só o inteiro 1 (===) conta como ativo, conforme o contrato oficial');
});

Deno.test('mapBlingDeposits: data vazio → lista vazia (não lança, não inventa)', () => {
  assert.deepEqual(mapBlingDeposits([]), []);
});

Deno.test('mapBlingDeposits: entrada malformada (não-array/null/undefined) → lista vazia', () => {
  // deno-lint-ignore no-explicit-any
  assert.deepEqual(mapBlingDeposits(null as any), []);
  // deno-lint-ignore no-explicit-any
  assert.deepEqual(mapBlingDeposits(undefined as any), []);
});

Deno.test('mapBlingDeposits: id ausente/nulo é descartado (nunca inventa um id)', () => {
  const items = mapBlingDeposits([
    { descricao: 'Sem id', situacao: 1, padrao: false, desconsiderarSaldo: false },
    { id: null, descricao: 'Id nulo', situacao: 1, padrao: false, desconsiderarSaldo: false },
    { id: 5, descricao: 'Com id', situacao: 1, padrao: false, desconsiderarSaldo: false },
  ]);
  assert.deepEqual(items.map((d) => d.id), ['5']);
});

Deno.test('mapBlingDeposits: descricao ausente cai num rótulo previsível (nunca fica em branco)', () => {
  const items = mapBlingDeposits([{ id: 7, situacao: 1, padrao: false, desconsiderarSaldo: false }]);
  assert.equal(items[0].descricao, 'Depósito 7');
});

Deno.test('mapBlingDeposits: preserva padrao e desconsiderarSaldo exatamente como vieram', () => {
  const items = mapBlingDeposits([{ id: 1, descricao: 'X', situacao: 1, padrao: true, desconsiderarSaldo: true }]);
  assert.equal(items[0].padrao, true);
  assert.equal(items[0].desconsiderarSaldo, true);
});
