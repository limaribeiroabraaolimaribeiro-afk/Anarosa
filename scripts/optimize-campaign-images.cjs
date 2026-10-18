const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('@playwright/test');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'assets/img');
const sources = [
  ['Imagem do ChatGPT 17 de out. de 2026, 22_13_35-1.png', 'feminino-campanha', 'Mulher com conjunto bege listrado', 'Universo Feminino'],
  ['Imagem do ChatGPT 17 de out. de 2026, 22_13_37-2.png', 'infantil-campanha', 'Menina com camiseta branca de laços', 'Universo Infantil'],
  ['Imagem do ChatGPT 17 de out. de 2026, 22_13_38-3.png', 'masculino-campanha', 'Homem com camiseta preta', 'Universo Masculino'],
  ['Imagem do ChatGPT 17 de out. de 2026, 22_13_40-4.png', 'plus-size-campanha', 'Mulher com vestido verde oliva', 'Universo Plus Size'],
  ['Imagem do ChatGPT 17 de out. de 2026, 22_13_42-5.png', 'bebe-editorial', 'Bebê com conjunto verde estampado', 'Manifesto e faixa Instagram'],
  ['Imagem do ChatGPT 17 de out. de 2026, 22_13_44-6.png', 'infantil-editorial', 'Segunda fotografia da menina com camiseta de laços', 'Faixa Instagram'],
  ['Imagem do ChatGPT 17 de out. de 2026, 22_13_46-7.png', 'feminino-editorial', 'Segunda fotografia do conjunto bege', 'Manifesto e faixa Instagram'],
  ['Imagem do ChatGPT 17 de out. de 2026, 22_13_47-8.png', 'masculino-editorial', 'Segunda fotografia do homem com camiseta preta', 'Faixa Instagram'],
  ['Imagem do ChatGPT 17 de out. de 2026, 22_13_51-9.png', 'juvenil-editorial', 'Dois meninos com camisetas escuras', 'Faixa Instagram'],
  ['Imagem do ChatGPT 17 de out. de 2026, 22_13_52-10.png', 'plus-size-editorial', 'Segunda fotografia do vestido verde', 'Faixa Instagram'],
  ['banners/Moda que Veste Momentos em Família.png', 'familia-campanha', 'Família reunida em um jardim ensolarado', 'Hero; recorte sem textos e botões incorporados'],
];
async function main() {
  const output = path.join(directory, 'optimized');
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  // No remote asset can be requested during conversion.
  await page.route('**/*', (r) => r.abort());
  const manifest = [];
  try {
    for (const [source, slug, description, usage] of sources) {
      const bytes = fs.readFileSync(path.join(directory, source));
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      // The supplied banner contains drawn buttons and text. Keep only the family.
      const crop = slug === 'familia-campanha' ? { x: 840, y: 0, width: 880, height } : { x: 0, y: 0, width, height };
      const variants = [];
      for (const target of slug === 'familia-campanha' ? [640, 880] : [480, 960]) {
        const encoded = await page.evaluate(async ({ data, crop, target }) => {
          const img = new Image(); img.src = data; await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = target; canvas.height = Math.round(crop.height * target / crop.width);
          canvas.getContext('2d').drawImage(img, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/webp', 0.86);
        }, { data: 'data:image/png;base64,' + bytes.toString('base64'), crop, target });
        if (!encoded.startsWith('data:image/webp;base64,')) throw Error('WebP encoding unavailable');
        const derivative = Buffer.from(encoded.split(',')[1], 'base64');
        const name = `${slug}-${target}.webp`;
        fs.writeFileSync(path.join(output, name), derivative);
        variants.push({ file: 'optimized/' + name, width: target, height: Math.round(crop.height * target / crop.width), bytes: derivative.length });
      }
      manifest.push({ source, source_sha256: crypto.createHash('sha256').update(bytes).digest('hex'), width, height, description, usage, crop, variants });
    }
    fs.writeFileSync(path.join(directory, 'campaign-manifest.json'), JSON.stringify({ originals_preserved: true, product_sku_associations: false, images: manifest }, null, 2));
    console.log(JSON.stringify({ images: manifest.length, original_bytes: manifest.reduce((n, x) => n + fs.statSync(path.join(directory, x.source)).size, 0), webp_bytes: manifest.reduce((n, x) => n + x.variants.reduce((a, v) => a + v.bytes, 0), 0) }));
  } finally { await browser.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
