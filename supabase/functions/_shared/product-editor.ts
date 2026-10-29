import { ValidationError } from './errors.ts';
import { validateProductAdminInput } from './product-admin-mapper.ts';
import { sha256Hex } from './crypto.ts';
type Row = Record<string, any>;
export function productEditorView(raw: Row) {
  return {
    nome: raw.nome,
    sku: raw.codigo ?? '',
    preco: raw.preco,
    categoriaId: raw.categoria?.id ? String(raw.categoria.id) : '',
    marca: raw.marca ?? '',
    unidade: raw.unidade ?? 'UN',
    gtin: raw.gtin ?? '',
    descricaoCurta: raw.descricaoCurta ?? '',
    descricaoComplementar: raw.descricaoComplementar ?? '',
    ativo: raw.situacao === 'A',
    pesoLiquido: raw.pesoLiquido ?? null,
    pesoBruto: raw.pesoBruto ?? null,
    volumes: raw.volumes ?? null,
    dimensoes: raw.dimensoes ?? {},
    tributacao: {
      origem: raw.tributacao?.origem ?? null,
      ncm: raw.tributacao?.ncm ?? '',
      cest: raw.tributacao?.cest ?? '',
    },
    images: [...new Set([
      ...(raw.midia?.imagens?.imagensURL ?? []),
      ...(raw.midia?.imagens?.externas ?? []),
      ...(raw.midia?.imagens?.internas ?? []),
    ].map((i: Row | string) => typeof i === 'string' ? i : i?.link).filter(Boolean))],
    variacoes: (raw.variacoes ?? []).map((v: Row) => ({
      id: String(v.id),
      nome: v.variacao?.nome ?? v.nome,
      sku: v.codigo,
      preco: v.preco,
      ativo: v.situacao === 'A',
    })),
  };
}
/**
 * A API Bling v3 não documenta gravação de tags comerciais, coleção ou
 * preço promocional no cadastro base. Não enviar campos arbitrários ao
 * Bling: persistir a curadoria apenas no cache vinculado ao bling_id.
 */
export function validateMerchandising(raw: Row): {
  tags: string[]; colecao: string; segmento: string; precoPromocional: number | null;
} | null {
  if (raw.merchandising === undefined) return null; // clientes antigos
  const data = raw.merchandising;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ValidationError('Dados comerciais inválidos.');
  }
  const allowed = new Set(['novo', 'mais-vendido', 'oferta', 'escolha-da-semana', 'destaque']);
  if (!Array.isArray(data.tags) || data.tags.length > allowed.size ||
    data.tags.some((tag: unknown) => typeof tag !== 'string' || !allowed.has(tag)) ||
    new Set(data.tags).size !== data.tags.length) {
    throw new ValidationError('Tags da loja inválidas.');
  }
  const colecao = String(data.colecao ?? '').trim();
  const segmento = String(data.segmento ?? '').trim();
  if (colecao.length > 80 || segmento.length > 80 || /[<>]/.test(colecao + segmento)) {
    throw new ValidationError('Coleção ou segmento inválidos (máximo 80 caracteres).');
  }
  const provided = data.precoPromocional !== null && data.precoPromocional !== undefined &&
    String(data.precoPromocional).trim() !== '';
  const precoPromocional = provided ? Number(data.precoPromocional) : null;
  const basePrice = Number(raw.preco);
  if (precoPromocional !== null && (!Number.isFinite(precoPromocional) ||
    precoPromocional <= 0 || precoPromocional >= basePrice)) {
    throw new ValidationError('Preço promocional deve ser maior que zero e menor que o preço normal.');
  }
  return { tags: [...data.tags], colecao, segmento, precoPromocional };
}

export const productRevision = (raw: Row) => sha256Hex(JSON.stringify(productEditorView(raw)));
export function buildProductEditorPayload(raw: Row, current: Row | null = null, imagesAllowed = false): Row {
  const b = validateProductAdminInput(raw);
  if (!b.sku) throw new ValidationError('Informe um SKU único para o produto.');
  const out: Row = {
    nome: b.nome,
    codigo: b.sku,
    preco: b.preco,
    situacao: b.ativo ? 'A' : 'I',
    marca: b.marca ?? '',
    descricaoCurta: b.descricaoCurta ?? '',
  };
  if (raw.unidade != null && String(raw.unidade).trim() !== '') {
    const unidade = String(raw.unidade).trim().toUpperCase();
    if (!/^[A-Z]{1,6}$/.test(unidade)) throw new ValidationError('Unidade de venda inválida.');
    out.unidade = unidade;
  }
  if (raw.gtin != null && String(raw.gtin).trim() !== '') {
    const gtin = String(raw.gtin).trim();
    const previous = String(current?.gtin ?? '').trim();
    if (gtin !== previous && gtin !== 'SEM GTIN') {
      if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(gtin)) {
        throw new ValidationError('GTIN/EAN inválido. Não use código interno no lugar do EAN.');
      }
      const digits = [...gtin].map(Number);
      let sum = 0, factor = 3;
      for (let i = digits.length - 2; i >= 0; i--, factor = factor === 3 ? 1 : 3) sum += digits[i] * factor;
      if ((10 - sum % 10) % 10 !== digits[digits.length - 1]) throw new ValidationError('GTIN/EAN inválido: dígito verificador incorreto.');
    }
    out.gtin = gtin;
  }
  if (!current) Object.assign(out, { tipo: 'P', formato: 'S', condicao: 0 });
  if (b.categoriaId) out.categoria = { id: Number(b.categoriaId) };
  if (raw.descricaoComplementar !== undefined) {
    out.descricaoComplementar = String(raw.descricaoComplementar).slice(0, 10000);
  }
  for (const k of ['pesoLiquido', 'pesoBruto', 'volumes']) {
    if (raw[k] != null && raw[k] !== '') {
      const n = Number(raw[k]);
      if (
        !Number.isFinite(n) || n < 0 || (k === 'volumes' && !Number.isInteger(n))
      ) throw new ValidationError('Peso ou volumes inválidos.');
      out[k] = n;
    }
  }
  if (raw.dimensoes) {
    out.dimensoes = { ...(current?.dimensoes ?? {}), unidadeMedida: 1 };
    for (const k of ['largura', 'altura', 'profundidade']) {
      if (raw.dimensoes[k] == null || raw.dimensoes[k] === '') continue;
      const n = Number(raw.dimensoes[k]);
      if (!Number.isFinite(n) || n < 0) throw new ValidationError('Dimensão inválida.');
      out.dimensoes[k] = n;
    }
  }
  if (raw.tributacao) {
    out.tributacao = { ...(current?.tributacao ?? {}) };
    for (const [k, len] of [['ncm', 8], ['cest', 7]] as const) {
      if (raw.tributacao[k] === undefined) continue;
      const v = String(raw.tributacao[k]).replace(/[.\s]/g, '');
      if (v && !new RegExp(`^\\d{${len}}$`).test(v)) {
        throw new ValidationError(`${k.toUpperCase()} inválido.`);
      }
      out.tributacao[k] = v;
    }
    if (raw.tributacao.origem != null && raw.tributacao.origem !== '') {
      const n = Number(raw.tributacao.origem);
      if (!Number.isInteger(n) || n < 0 || n > 8) throw new ValidationError('Origem fiscal inválida.');
      out.tributacao.origem = n;
    }
  }
  if (raw.images !== undefined) {
    const same = current && JSON.stringify(raw.images) === JSON.stringify(productEditorView(current).images);
    if (!same) {
      if (!imagesAllowed) {
        throw new ValidationError('Permissão para salvar imagens ainda não validada na conexão Bling.');
      }
      if (!Array.isArray(raw.images) || raw.images.length > 12) {
        throw new ValidationError('Máximo de 12 imagens.');
      }
      if (
        raw.images.some((u: unknown) => typeof u !== 'string' || !/^https:\/\//i.test(u) || u.length > 1000)
      ) throw new ValidationError('Use URLs HTTPS de imagens.');
      if (Array.isArray(current?.midia?.imagens?.internas) && current.midia.imagens.internas.length) {
        throw new ValidationError('Este produto possui imagens internas no Bling. Edite as fotos diretamente no Bling para não remover imagens existentes.');
      }
      out.midia = {
        ...(current?.midia ?? {}),
        imagens: { imagensURL: raw.images.map((link: string) => ({ link })) },
      };
    }
  }
  if (raw.variacoes !== undefined) {
    if (!Array.isArray(raw.variacoes) || raw.variacoes.length > 100) {
      throw new ValidationError('Variações inválidas.');
    }
    const existing = current?.variacoes ?? [];
    if (current && current.formato !== 'V' && raw.variacoes.length) {
      throw new ValidationError(
        'Converter produto simples altera seu estoque. Faça essa conversão no Bling antes de editar as variações aqui.',
      );
    }
    if (existing.some((v: Row) => !raw.variacoes.some((x: Row) => String(x.id) === String(v.id)))) {
      throw new ValidationError(
        'Não remova variações existentes. Desative a variação para preservar histórico e estoque.',
      );
    }
    const skus = new Set([b.sku.toLowerCase()]);
    const ids = new Set();
    out.variacoes = raw.variacoes.map((v: Row, index: number) => {
      if (v.id && (ids.has(v.id) || !existing.some((x: Row) => String(x.id) === String(v.id)))) {
        throw new ValidationError('Variação não pertence ao produto ou está repetida.');
      }
      ids.add(v.id);
      const data = validateProductAdminInput({ nome: v.nome, sku: v.sku, preco: v.preco, ativo: v.ativo });
      if (!data.sku || skus.has(data.sku.toLowerCase())) {
        throw new ValidationError('Cada variação precisa de SKU único.');
      }
      skus.add(data.sku.toLowerCase());
      if (!/^(?:Tamanho|Cor):[^;:]+(?:;(?:Tamanho|Cor):[^;:]+)*$/i.test(data.nome)) {
        throw new ValidationError('Use Tamanho:M;Cor:Azul nas características da variação.');
      }
      return {
        ...(v.id ? { id: Number(v.id) } : { tipo: 'P', formato: 'S' }),
        nome: `${b.nome} ${data.nome}`.slice(0, 120),
        codigo: data.sku,
        preco: data.preco,
        situacao: data.ativo ? 'A' : 'I',
        variacao: { nome: data.nome, ordem: index, produtoPai: { cloneInfo: false } },
      };
    });
    if (!current && out.variacoes.length) out.formato = 'V';
    if (!out.variacoes.length) delete out.variacoes;
  }
  return out;
}
