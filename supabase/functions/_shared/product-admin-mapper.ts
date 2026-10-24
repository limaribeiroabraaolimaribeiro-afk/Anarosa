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

function textOptional(b: Record<string, unknown>, key: string, size: number): string | null {
  return sanitizeText(b[key], size);
}
function optionalPositiveNumber(b: Record<string, unknown>, key: string, errors: string[]): number | null {
  if (b[key] == null || String(b[key]).trim() === '') return null;
  const n = Number(b[key]);
  if (!Number.isFinite(n) || n < 0 || n > 1000000) {
    errors.push(key + ': valor inválido.'); return null;
  }
  return n;
}
function isGtin(v: string): boolean {
  if (!/^(?:[0-9]{8}|[0-9]{12}|[0-9]{13}|[0-9]{14})$/.test(v)) return false;
  const nums = [...v].map(Number);
  let sum = 0, weight = 3;
  for (let i = nums.length - 2; i >= 0; i--, weight = weight === 3 ? 1 : 3) sum += nums[i] * weight;
  return (10 - (sum % 10)) % 10 === nums[nums.length - 1];
}
function parseImageUrls(raw: unknown, errors: string[]): string[] {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 9) { errors.push('Máximo de 9 fotos.'); return []; }
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.length > 2048) { errors.push('URL da foto inválida.'); continue; }
    try {
      const url = new URL(item);
      if (url.protocol !== 'https:' || url.username || url.password || !url.hostname ||
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('insegura');
      if (!result.includes(item)) result.push(item);
    } catch { errors.push('Foto precisa de URL HTTPS pública.'); }
  }
  return result;
}
export interface ProductAdminInput {
  nome: string;
  sku: string | null;
  preco: number;
  categoriaId: string | null;
  descricaoCurta: string | null;
  marca: string | null;
  ativo: boolean;
  descricaoComplementar: string | null;
  unidade: string | null;
  gtin: string | null;
  pesoLiquido: number | null;
  pesoBruto: number | null;
  largura: number | null;
  altura: number | null;
  profundidade: number | null;
  volumes: number | null;
  ncm: string | null;
  cest: string | null;
  origemFiscal: number | null;
  imagemUrls: string[];
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
  const descricaoComplementar = textOptional(body, 'descricaoComplementar', 5000);
  const unidade = textOptional(body, 'unidade', 6);
  const gtin = textOptional(body, 'gtin', 14);
  if (gtin && gtin !== 'SEM GTIN' && !isGtin(gtin)) errors.push('GTIN/EAN inválido; confirme o código oficial.');
  const pesoLiquido = optionalPositiveNumber(body, 'pesoLiquido', errors);
  const pesoBruto = optionalPositiveNumber(body, 'pesoBruto', errors);
  const largura = optionalPositiveNumber(body, 'largura', errors);
  const altura = optionalPositiveNumber(body, 'altura', errors);
  const profundidade = optionalPositiveNumber(body, 'profundidade', errors);
  const volumes = optionalPositiveNumber(body, 'volumes', errors);
  if (volumes !== null && (!Number.isInteger(volumes) || volumes < 1)) errors.push('Volumes precisa ser inteiro positivo.');
  if ([largura, altura, profundidade].some((n) => n !== null) &&
    [largura, altura, profundidade].some((n) => n === null || n <= 1)) {
    errors.push('Informe largura, altura e profundidade da embalagem maiores que 1 cm.');
  }
  if (pesoBruto !== null && pesoLiquido !== null && pesoBruto < pesoLiquido) {
    errors.push('Peso embalado não pode ser menor que peso da peça.');
  }
  const ncm = textOptional(body, 'ncm', 20)?.replace(/\./g, '') ?? null;
  if (ncm && !/^\d{8}$/.test(ncm)) errors.push('NCM deve conter 8 dígitos (confirme na nota).');
  const cest = textOptional(body, 'cest', 20)?.replace(/\D/g, '') ?? null;
  if (cest && !/^\d{7}$/.test(cest)) errors.push('CEST deve conter 7 dígitos (quando aplicável).');
  const origin = textOptional(body, 'origemFiscal', 2);
  const origemFiscal = origin === null ? null : Number(origin);
  if (origin !== null && !/^[0-8]$/.test(origin)) errors.push('Origem fiscal inválida.');
  const imagemUrls = parseImageUrls(body.imagemUrls, errors);

  if (errors.length) throw new ValidationError('Dados do produto inválidos.', { errors });

  return {
    nome: nome as string,
    sku,
    preco: Math.round(preco * 100) / 100,
    categoriaId,
    descricaoCurta,
    marca,
    ativo,
    descricaoComplementar, unidade, gtin, pesoLiquido, pesoBruto,
    largura, altura, profundidade, volumes, ncm, cest, origemFiscal, imagemUrls,
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
    ...(input.descricaoComplementar ? { descricaoComplementar: input.descricaoComplementar } : {}),
    unidade: input.unidade || 'UN',
    ...(input.gtin ? { gtin: input.gtin } : {}),
    ...(input.pesoLiquido !== null ? { pesoLiquido: input.pesoLiquido } : {}),
    ...(input.pesoBruto !== null ? { pesoBruto: input.pesoBruto } : {}),
    volumes: input.volumes ?? 1,
    ...(input.largura !== null ? { dimensoes: {
      largura: input.largura, altura: input.altura, profundidade: input.profundidade, unidadeMedida: 1,
    } } : {}),
    ...(input.ncm || input.cest || input.origemFiscal !== null ? { tributacao: {
      ...(input.ncm ? { ncm: input.ncm } : {}),
      ...(input.cest ? { cest: input.cest } : {}),
      ...(input.origemFiscal !== null ? { origem: input.origemFiscal } : {}),
    } } : {}),
    ...(input.imagemUrls.length ? { midia: { imagens: { externas: input.imagemUrls.map((link) => ({ link })) } } } : {}),
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
  const dims = existingRaw.dimensoes && typeof existingRaw.dimensoes === 'object' ? existingRaw.dimensoes : {};
  const tax = existingRaw.tributacao && typeof existingRaw.tributacao === 'object' ? existingRaw.tributacao : {};
  const currentMedia = existingRaw.midia && typeof existingRaw.midia === 'object' ? existingRaw.midia : {};
  const currentExternal = Array.isArray(currentMedia?.imagens?.externas) ? currentMedia.imagens.externas : [];
  const currentInternal = Array.isArray(currentMedia?.imagens?.internas) ? currentMedia.imagens.internas : [];
  if (currentInternal.length && input.imagemUrls.length) {
    throw new ValidationError('Este produto já tem fotos internas no Bling. Acrescente fotos diretamente no Bling para evitar perda de imagens.');
  }
  const existingUrls = currentExternal.map((v: { link?: string }) => v?.link).filter((v: unknown): v is string => typeof v === 'string' && !!v);
  const allUrls = [...new Set([...existingUrls, ...input.imagemUrls])];
  if (allUrls.length > 9) throw new ValidationError('Máximo de 9 URLs de imagens por produto.');

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
    ...(input.descricaoComplementar ? { descricaoComplementar: input.descricaoComplementar } : {}),
    ...(input.unidade ? { unidade: input.unidade } : {}),
    ...(input.gtin ? { gtin: input.gtin } : {}),
    ...(input.pesoLiquido !== null ? { pesoLiquido: input.pesoLiquido } : {}),
    ...(input.pesoBruto !== null ? { pesoBruto: input.pesoBruto } : {}),
    ...(input.volumes !== null ? { volumes: input.volumes } : {}),
    ...(Object.keys(dims).length || input.largura !== null ? { dimensoes: {
      ...dims, ...(input.largura !== null ? { largura: input.largura, altura: input.altura,
        profundidade: input.profundidade, unidadeMedida: 1 } : {}),
    } } : {}),
    ...(Object.keys(tax).length || input.ncm || input.cest || input.origemFiscal !== null ? { tributacao: {
      ...tax, ...(input.ncm ? { ncm: input.ncm } : {}),
      ...(input.cest ? { cest: input.cest } : {}),
      ...(input.origemFiscal !== null ? { origem: input.origemFiscal } : {}),
    } } : {}),
    ...(Object.keys(currentMedia).length || allUrls.length ? { midia: {
      ...currentMedia,
      ...(allUrls.length ? { imagens: {
        ...(currentMedia?.imagens ?? {}),
        externas: allUrls.map((link) => ({ link })),
      } } : {}),
    } } : {}),
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
  if (!Number.isFinite(quantidade) || quantidade < 0 || (quantidade === 0 && operacao !== 'B')) {
    errors.push('quantidade deve ser positiva; balanço permite zero.');
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
