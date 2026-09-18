import assert from 'node:assert/strict';
import {
  buildBlingProductPayload,
  buildBlingProductUpdatePayload,
  isValidBlingId,
  validateProductAdminInput,
  validateStockAdjustmentInput,
} from '../_shared/product-admin-mapper.ts';
import { ValidationError } from '../_shared/errors.ts';

Deno.test('isValidBlingId: aceita só ids numéricos positivos', () => {
  assert.equal(isValidBlingId('1001'), true);
  assert.equal(isValidBlingId('0'), false);
  assert.equal(isValidBlingId('-1'), false);
  assert.equal(isValidBlingId('abc'), false);
  assert.equal(isValidBlingId('1e5'), false);
  assert.equal(isValidBlingId(''), false);
  assert.equal(isValidBlingId(null), false);
});

Deno.test('validateProductAdminInput: caminho feliz', () => {
  const input = validateProductAdminInput({
    nome: 'Camiseta Ogochi Infantil',
    sku: 'OG-001',
    preco: 60,
    categoriaId: '123',
    descricaoCurta: 'Camiseta 100% algodão',
    marca: 'Anarosa',
    ativo: true,
  });
  assert.equal(input.nome, 'Camiseta Ogochi Infantil');
  assert.equal(input.sku, 'OG-001');
  assert.equal(input.preco, 60);
  assert.equal(input.categoriaId, '123');
  assert.equal(input.ativo, true);
});

Deno.test('validateProductAdminInput: nome ausente → ValidationError', () => {
  assert.throws(() => validateProductAdminInput({ preco: 10 }), (err: unknown) => {
    assert.ok(err instanceof ValidationError);
    return true;
  });
});

Deno.test('validateProductAdminInput: preço negativo é rejeitado', () => {
  assert.throws(() => validateProductAdminInput({ nome: 'Produto', preco: -1 }), ValidationError);
});

Deno.test('validateProductAdminInput: preço não-numérico é rejeitado', () => {
  assert.throws(() => validateProductAdminInput({ nome: 'Produto', preco: 'grátis' }), ValidationError);
});

Deno.test('validateProductAdminInput: preço zero é aceito (produto gratuito é uma decisão de negócio válida)', () => {
  const input = validateProductAdminInput({ nome: 'Produto', preco: 0 });
  assert.equal(input.preco, 0);
});

Deno.test('validateProductAdminInput: SKU inválido é rejeitado (espaços/símbolos)', () => {
  assert.throws(() => validateProductAdminInput({ nome: 'Produto', preco: 10, sku: 'OG 001!' }), ValidationError);
});

Deno.test('validateProductAdminInput: nome com HTML/script passa como TEXTO puro (nunca renderizado como HTML no backend)', () => {
  const input = validateProductAdminInput({ nome: '<script>alert(1)</script>', preco: 10 });
  assert.equal(input.nome, '<script>alert(1)</script>');
  // a defesa contra XSS é no FRONTEND (escapeHtml antes de inserir no DOM),
  // não aqui — este teste documenta que o backend não filtra/rejeita
  // marcação, só sanitiza espaços/quebras de linha e tamanho.
});

Deno.test('validateProductAdminInput: ativo default é true quando omitido', () => {
  const input = validateProductAdminInput({ nome: 'Produto', preco: 10 });
  assert.equal(input.ativo, true);
});

Deno.test('buildBlingProductPayload: mapeia para os códigos oficiais do Bling (tipo=P, formato=S)', () => {
  const payload = buildBlingProductPayload(validateProductAdminInput({
    nome: 'Produto', sku: 'SKU-1', preco: 99.9, categoriaId: '5', marca: 'X', ativo: false,
  }));
  assert.equal(payload.nome, 'Produto');
  assert.equal(payload.codigo, 'SKU-1');
  assert.equal(payload.preco, 99.9);
  assert.equal(payload.tipo, 'P');
  assert.equal(payload.situacao, 'I');
  assert.equal(payload.formato, 'S');
  assert.equal(payload.condicao, 0);
  assert.deepEqual(payload.categoria, { id: 5 });
  assert.equal(payload.marca, 'X');
});

Deno.test('buildBlingProductUpdatePayload: preserva marca/categoria/gtin do cadastro atual quando o formulário não os informa', () => {
  const input = validateProductAdminInput({ nome: 'Novo Nome', preco: 50, ativo: true });
  const existingRaw = {
    codigo: 'OLD-SKU', marca: 'MarcaAntiga', gtin: '7891234567890', unidade: 'UN',
    categoria: { id: 42, nome: 'Camisetas' }, tipo: 'P', condicao: 1,
  };
  const payload = buildBlingProductUpdatePayload(input, existingRaw);
  assert.equal(payload.nome, 'Novo Nome');
  assert.equal(payload.preco, 50);
  assert.equal(payload.codigo, 'OLD-SKU', 'sku não informado no formulário → preserva o atual');
  assert.equal(payload.marca, 'MarcaAntiga', 'marca não informada no formulário → preserva a atual');
  assert.equal(payload.gtin, '7891234567890');
  assert.deepEqual(payload.categoria, { id: 42 }, 'categoria não informada no formulário → preserva a atual');
  assert.equal(payload.condicao, 1);
});

Deno.test('buildBlingProductUpdatePayload: valores do formulário sempre sobrescrevem o cadastro atual', () => {
  const input = validateProductAdminInput({ nome: 'Produto X', preco: 10, sku: 'NEW-SKU', categoriaId: '99', marca: 'MarcaNova', ativo: false });
  const existingRaw = { codigo: 'OLD-SKU', marca: 'MarcaAntiga', categoria: { id: 42 } };
  const payload = buildBlingProductUpdatePayload(input, existingRaw);
  assert.equal(payload.codigo, 'NEW-SKU');
  assert.equal(payload.marca, 'MarcaNova');
  assert.deepEqual(payload.categoria, { id: 99 });
  assert.equal(payload.situacao, 'I');
});

Deno.test('buildBlingProductUpdatePayload: cadastro atual vazio não quebra (produto sem esses campos)', () => {
  const input = validateProductAdminInput({ nome: 'Produto X', preco: 10 });
  const payload = buildBlingProductUpdatePayload(input, {});
  assert.equal(payload.nome, 'Produto X');
  assert.equal(payload.tipo, 'P');
  assert.equal(payload.categoria, undefined);
});

Deno.test('validateStockAdjustmentInput: caminho feliz (entrada)', () => {
  const input = validateStockAdjustmentInput({ blingProductId: '1001', depositoId: '1', operacao: 'entrada', quantidade: 5 });
  assert.equal(input.operacao, 'E');
  assert.equal(input.quantidade, 5);
});

Deno.test('validateStockAdjustmentInput: mapeia saida→S e balanco→B', () => {
  assert.equal(validateStockAdjustmentInput({ blingProductId: '1', depositoId: '1', operacao: 'saida', quantidade: 1 }).operacao, 'S');
  assert.equal(validateStockAdjustmentInput({ blingProductId: '1', depositoId: '1', operacao: 'balanco', quantidade: 1 }).operacao, 'B');
});

Deno.test('validateStockAdjustmentInput: operacao inválida é rejeitada', () => {
  assert.throws(() => validateStockAdjustmentInput({ blingProductId: '1', depositoId: '1', operacao: 'transferencia', quantidade: 1 }), ValidationError);
});

Deno.test('validateStockAdjustmentInput: quantidade zero ou negativa é rejeitada', () => {
  assert.throws(() => validateStockAdjustmentInput({ blingProductId: '1', depositoId: '1', operacao: 'entrada', quantidade: 0 }), ValidationError);
  assert.throws(() => validateStockAdjustmentInput({ blingProductId: '1', depositoId: '1', operacao: 'entrada', quantidade: -5 }), ValidationError);
});

Deno.test('validateStockAdjustmentInput: depósito inválido (não numérico) é rejeitado', () => {
  assert.throws(() => validateStockAdjustmentInput({ blingProductId: '1001', depositoId: 'principal', operacao: 'entrada', quantidade: 1 }), ValidationError);
});
