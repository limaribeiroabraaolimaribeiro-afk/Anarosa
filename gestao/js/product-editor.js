(function () {
  'use strict';
  const form = document.querySelector('[data-product-form]');
  const esc = (v) =>
    String(v ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );
  let revision = null, imagePermission = false;
  const extra = document.createElement('div');
  extra.className = 'product-editor-sections';
  extra.innerHTML =
    `<details open><summary>Variações de tamanho e cor</summary><p class="gestao-note">Cada tamanho tem SKU, preço e saldo próprios. Salvar o cadastro não movimenta estoque.</p><div data-editor-variants></div><div class="gestao-actions"><button type="button" class="btn btn-outline" data-add-variant>Adicionar variação</button><button type="button" class="btn btn-outline" data-size-grid>Criar grade P a XG</button></div></details>
  <details><summary>Descrição e características</summary><label>Descrição completa e medidas<textarea name="descricaoComplementar" rows="5" maxlength="10000" placeholder="Informe as medidas reais e a composição da peça."></textarea></label></details>
  <details><summary>Logística</summary><div class="editor-grid">${
      [
        ['pesoLiquido', 'Peso líquido (kg)'],
        ['pesoBruto', 'Peso embalado (kg)'],
        ['volumes', 'Volumes'],
        ['largura', 'Largura embalada (cm)'],
        ['altura', 'Altura embalada (cm)'],
        ['profundidade', 'Profundidade embalada (cm)'],
      ].map(([name, label]) =>
        `<label>${label}<input name="${name}" type="number" min="0" step="${
          name === 'volumes' ? '1' : '0.001'
        }"></label>`
      ).join('')
    }</div></details>
  <details><summary>Fiscal</summary><p class="gestao-note">Preencha somente classificações conferidas com sua contabilidade.</p><div class="editor-grid"><label>Origem<select name="origem"><option value="">Não informada</option>${
      Array.from({ length: 9 }, (_, i) => `<option value="${i}">${i}</option>`).join('')
    }</select></label><label>NCM<input name="ncm" inputmode="numeric" maxlength="8"></label><label>CEST<input name="cest" inputmode="numeric" maxlength="7"></label></div></details>
  <details><summary>Galeria de imagens</summary><p class="gestao-note" data-image-capability></p><label>URLs HTTPS, uma por linha. A primeira será a principal.<textarea name="images" rows="4"></textarea></label><div class="editor-gallery" data-editor-gallery></div><p class="gestao-note">Reordene as linhas para ordenar a galeria; remova uma linha para excluir a imagem. Upload de arquivo depende de armazenamento e permissão verificados.</p></details>`;
  form.querySelector('.gestao-field-group')?.remove();
  form.querySelector('[data-product-form-error]').before(extra);
  function row(v = {}) {
    const el = document.createElement('div');
    el.className = 'variant-edit-row';
    el.dataset.variantId = v.id || '';
    const size = /(?:^|;)Tamanho:([^;]+)/i.exec(v.nome || '')?.[1] || '',
      color = /(?:^|;)Cor:([^;]+)/i.exec(v.nome || '')?.[1] || '';
    el.innerHTML = `<label>Tamanho<input data-v-size value="${
      esc(size)
    }" maxlength="20"></label><label>Cor<input data-v-color value="${
      esc(color)
    }" maxlength="30"></label><label>SKU<input data-v-sku required value="${
      esc(v.sku)
    }" maxlength="60"></label><label>Preço<input data-v-price required type="number" min="0" step="0.01" value="${
      esc(v.preco ?? form.preco.value)
    }"></label><label><input data-v-active type="checkbox" ${
      v.ativo !== false ? 'checked' : ''
    }> Ativa</label>${
      v.id ? '' : '<button type="button" data-v-remove aria-label="Remover nova variação">Remover</button>'
    }`;
    el.querySelector('[data-v-remove]')?.addEventListener('click', () => el.remove());
    extra.querySelector('[data-editor-variants]').append(el);
  }
  extra.querySelector('[data-add-variant]').addEventListener('click', () => row());
  extra.querySelector('[data-size-grid]').addEventListener('click', () => {
    if (extra.querySelector('.variant-edit-row')) return;
    for (const size of ['P', 'M', 'G', 'GG', 'XG']) {
      row({ nome: `Tamanho:${size}`, sku: form.sku.value ? `${form.sku.value}-${size}` : '' });
    }
  });
  function preview() {
    extra.querySelector('[data-editor-gallery]').replaceChildren();
    form.images.value.split('\n').map((x) => x.trim()).filter((x) => /^https:\/\//i.test(x)).forEach(
      (url, i) => {
        const img = document.createElement('img');
        img.src = url;
        img.alt = i === 0 ? 'Imagem principal' : `Imagem ${i + 1}`;
        img.loading = 'lazy';
        extra.querySelector('[data-editor-gallery]').append(img);
      },
    );
  }
  form.images.addEventListener('input', preview);
  window.AnaProductEditor = {
    async load(id) {
      revision = null;
      imagePermission = false;
      extra.querySelector('[data-editor-variants]').replaceChildren();
      const response = await window.GestaoApi.getProductDetail(id || undefined);
      const p = response.product;
      revision = response.revision || null;
      imagePermission = response.capabilities.images;
      for (
        const k of [
          'nome',
          'sku',
          'preco',
          'marca',
          'descricaoCurta',
          'descricaoComplementar',
          'pesoLiquido',
          'pesoBruto',
          'volumes',
        ]
      ) if (p[k] != null) form.elements[k].value = p[k];
      if (id) {
        form.ativo.checked = p.ativo;
        form.categoriaId.value = p.categoriaId;
      }
      const dimensionFactor = Number(p.dimensoes?.unidadeMedida) === 0
        ? 100
        : Number(p.dimensoes?.unidadeMedida) === 2
        ? 0.1
        : 1;
      for (const k of ['largura', 'altura', 'profundidade']) {
        form.elements[k].value = p.dimensoes?.[k] != null ? Number(p.dimensoes[k]) * dimensionFactor : '';
      }
      for (const k of ['origem', 'ncm', 'cest']) form.elements[k].value = p.tributacao?.[k] ?? '';
      for (const v of p.variacoes || []) row(v);
      form.images.value = (p.images || []).join('\n');
      form.images.disabled = !imagePermission;
      extra.querySelector('[data-image-capability]').textContent = imagePermission
        ? 'Permissão de gravação habilitada pela operação.'
        : 'Galeria em leitura. A permissão de salvar imagens ainda precisa ser validada no Bling.';
      preview();
    },
    read() {
      return {
        revision,
        descricaoComplementar: form.descricaoComplementar.value,
        pesoLiquido: form.pesoLiquido.value,
        pesoBruto: form.pesoBruto.value,
        volumes: form.volumes.value,
        dimensoes: Object.fromEntries(
          ['largura', 'altura', 'profundidade'].map((k) => [k, form.elements[k].value]),
        ),
        tributacao: Object.fromEntries(['origem', 'ncm', 'cest'].map((k) => [k, form.elements[k].value])),
        ...(imagePermission
          ? { images: form.images.value.split('\n').map((x) => x.trim()).filter(Boolean) }
          : {}),
        variacoes: [...extra.querySelectorAll('.variant-edit-row')].map((el) => ({
          id: el.dataset.variantId || undefined,
          nome: [
            el.querySelector('[data-v-size]').value
              ? `Tamanho:${el.querySelector('[data-v-size]').value}`
              : '',
            el.querySelector('[data-v-color]').value ? `Cor:${el.querySelector('[data-v-color]').value}` : '',
          ].filter(Boolean).join(';'),
          sku: el.querySelector('[data-v-sku]').value,
          preco: Number(el.querySelector('[data-v-price]').value),
          ativo: el.querySelector('[data-v-active]').checked,
        })),
      };
    },
  };
})();
