/**
 * Validação/normalização das entradas administrativas de produto e
 * estoque (Gestão Anarosa → Bling). Funções PURAS — nenhuma rede/banco.
 *
 * Campos e códigos usados aqui são os documentados oficialmente pela
 * API v3 do Bling (produtos.tipo/situacao/formato/condicao,
 * estoques.operacao) — ver bling-client.ts para as referências
 * (developer.bling.com.br/referencia) de cada endpoint.
 */
import { ValidationError } from './errors.ts';

const SKU_RE = /^[A-Za-z0-9._-]{1,60}$/;
const BLING_ID_RE = /^[1-9][0-9]{0,18}$/; // Bling usa ids numéricos (bigint), sempre positivos

export function isValidBlingId(value: unknown): boolean {
  return typeof value === 'string' && BLING_ID_RE.test(value);
}

function sanitizeText(value: unknown, maxLen: number): string | null {
  if (value == null) return null;
  const s = String(value).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return s ? s.slice(0, maxLen) : null;
}

export interface ProductAdminInput {
  nome: string;
  sku: string | null;
  preco: number;
  categoriaId: string | null;
  descricaoCurta: string | null;
  marca: string | null;
  ativo: boolean;
}

/**
 * Valida a entrada do formulário de criar/editar produto. `raw` vem
 * direto do corpo da requisição — NUNCA confiado sem validação.
 */
export function validateProductAdminInput(raw: unknown): ProductAdminInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const errors: string[] = [];

  const nome = sanitizeText(body.nome, 120);
  if (!nome || nome.length < 2) errors.push('nome é obrigatório (mínimo 2 caracteres).');

  let sku: string | null = null;
  if (body.sku != null && String(body.sku).trim() !== '') {
    const raw_sku = String(body.sku).trim();
    if (!SKU_RE.test(raw_sku)) {
      errors.push('sku inválido — use apenas letras, números, ".", "_" ou "-" (máx. 60 caracteres).');
    } else {
      sku = raw_sku;
    }
  }

  const preco = Number(body.preco);
  if (!Number.isFinite(preco) || preco < 0) {
    errors.push('preco deve ser um número maior ou igual a zero.');
  }

  let categoriaId: string | null = null;
  if (body.categoriaId != null && String(body.categoriaId).trim() !== '') {
    categoriaId = String(body.categoriaId).trim();
    // categoriaId aqui é o bling_id da categoria (validado contra o
    // cache pelo chamador — ver admin-product-create/update).
  }

  const descricaoCurta = sanitizeText(body.descricaoCurta, 500);
  const marca = sanitizeText(body.marca, 100);
  const ativo = body.ativo !== false; // default true

  if (errors.length) throw new ValidationError('Dados do produto inválidos.', { errors });

  return {
    nome: nome as string,
    sku,
    preco: Math.round(preco * 100) / 100,
    categoriaId,
    descricaoCurta,
    marca,
    ativo,
  };
}

/**
 * Monta o payload para POST /produtos (criação — não há nada anterior
 * para preservar). `situacao`/`tipo`/`formato` fixos nesta primeira
 * versão (produto físico simples, sem variação — ver limitação
 * documentada em docs/BLING_PRODUCT_MANAGEMENT.md).
 */
export function buildBlingProductPayload(input: ProductAdminInput): Record<string, unknown> {
  return {
    nome: input.nome,
    ...(input.sku ? { codigo: input.sku } : {}),
    preco: input.preco,
    tipo: 'P', // Produto (não Serviço) — catálogo da Anarosa é só produto físico
    situacao: input.ativo ? 'A' : 'I',
    formato: 'S', // Simples — criação/edição de produto COM variação não é suportada nesta versão
    condicao: 0, // Não especificado
    ...(input.categoriaId ? { categoria: { id: Number(input.categoriaId) } } : {}),
    ...(input.descricaoCurta ? { descricaoCurta: input.descricaoCurta } : {}),
    ...(input.marca ? { marca: input.marca } : {}),
  };
}

// Campos escalares "seguros" que sabemos como preservar do cadastro
// atual quando o formulário simplificado não os informa. Objetos
// complexos (tributacao/estrutura/dimensoes/camposCustomizados/midia)
// NÃO são preservados nesta versão — ver limitação documentada em
// docs/BLING_PRODUCT_MANAGEMENT.md.
const PRESERVED_SCALAR_FIELDS = [
  'codigo', 'gtin', 'gtinEmbalagem', 'unidade', 'condicao', 'tipo',
  'pesoLiquido', 'pesoBruto', 'volumes', 'itensPorCaixa', 'freteGratis',
  'linkExterno', 'descricaoComplementar', 'observacoes', 'dataValidade',
  'tipoProducao', 'marca', 'descricaoCurta',
] as const;

/**
 * Monta o payload para PUT /produtos/{id}. PUT SUBSTITUI o cadastro
 * inteiro — por isso partimos do registro ATUAL (`existingRaw`, de
 * GET /produtos/{id}) e sobrepomos só os campos que este formulário
 * de fato edita. Sem isso, salvar aqui apagaria silenciosamente marca/
 * descrição/categoria/etc. já cadastrados no Bling mas não expostos
 * neste formulário simplificado.
 */
export function buildBlingProductUpdatePayload(
  input: ProductAdminInput,
  // deno-lint-ignore no-explicit-any
  existingRaw: Record<string, any>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const field of PRESERVED_SCALAR_FIELDS) {
    if (existingRaw[field] !== undefined && existingRaw[field] !== null) merged[field] = existingRaw[field];
  }
  if (existingRaw.categoria?.id != null) merged.categoria = { id: existingRaw.categoria.id };

  return {
    ...merged,
    nome: input.nome,
    ...(input.sku ? { codigo: input.sku } : { codigo: merged.codigo }),
    preco: input.preco,
    tipo: (merged.tipo as string) ?? 'P',
    situacao: input.ativo ? 'A' : 'I',
    formato: 'S',
    ...(input.categoriaId ? { categoria: { id: Number(input.categoriaId) } } : {}),
    ...(input.descricaoCurta ? { descricaoCurta: input.descricaoCurta } : {}),
    ...(input.marca ? { marca: input.marca } : {}),
  };
}

const OPERACAO_MAP: Record<string, 'B' | 'E' | 'S'> = {
  entrada: 'E',
  saida: 'S',
  balanco: 'B',
};

export interface StockAdjustmentInput {
  blingProductId: string;
  depositoId: string;
  operacao: 'B' | 'E' | 'S';
  quantidade: number;
  observacoes: string | null;
}

export function validateStockAdjustmentInput(raw: unknown): StockAdjustmentInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const errors: string[] = [];

  const blingProductId = typeof body.blingProductId === 'string' ? body.blingProductId.trim() : '';
  if (!isValidBlingId(blingProductId)) errors.push('blingProductId inválido.');

  const depositoId = typeof body.depositoId === 'string' ? body.depositoId.trim() : '';
  if (!isValidBlingId(depositoId)) errors.push('depositoId inválido — escolha um depósito real da lista.');

  const operacaoKey = typeof body.operacao === 'string' ? body.operacao.trim().toLowerCase() : '';
  const operacao = OPERACAO_MAP[operacaoKey];
  if (!operacao) errors.push('operacao deve ser "entrada", "saida" ou "balanco".');

  const quantidade = Number(body.quantidade);
  if (!Number.isFinite(quantidade) || quantidade <= 0) {
    errors.push('quantidade deve ser um número maior que zero.');
  }

  const observacoes = sanitizeText(body.observacoes, 500);

  if (errors.length) throw new ValidationError('Ajuste de estoque inválido.', { errors });

  return {
    blingProductId,
    depositoId,
    operacao: operacao as 'B' | 'E' | 'S',
    quantidade: Math.round(quantidade * 1000) / 1000,
    observacoes,
  };
}
