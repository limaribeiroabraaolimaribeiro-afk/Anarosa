/**
 * ANAROSA — dados mock centralizados.
 *
 * Os produtos já seguem um formato próximo ao que a integração futura com o
 * Bling deve preencher (blingId, sku, description, promotionalPrice, images,
 * variants de tamanho/cor, stock, active). Nada aqui faz uma chamada real —
 * é só a estrutura pronta para receber esses dados depois.
 */

function formatPrice(value) {
  return value.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function makeInstallment(price, times = 6) {
  const value = price / times;
  return `${times}x de ${formatPrice(value)} sem juros`;
}

function makeProduct({
  id,
  sku,
  name,
  slug,
  category,
  price,
  promotionalPrice = null,
  image,
  badge = null,
  featured = false,
  bestSeller = false,
  weeklyPick = false,
}) {
  const activePrice = promotionalPrice ?? price;
  return {
    id,
    blingId: null,
    sku,
    name,
    slug,
    category,
    description: '',
    image,
    images: [image],
    price,
    promotionalPrice,
    installment: makeInstallment(activePrice),
    pixPrice: activePrice * 0.95,
    badge, // 'novo' | 'mais-vendido' | 'oferta' | null
    variants: {
      sizes: [],
      colors: [],
    },
    stock: null,
    active: true,
    featured,
    bestSeller,
    weeklyPick,
  };
}

const PRODUCTS = [
  makeProduct({
    id: 1,
    sku: 'AR-CAL-001',
    name: 'Calça Jeans Wide Leg',
    slug: 'calca-jeans-wide-leg',
    category: 'feminino',
    price: 159.9,
    image: 'assets/products/calca-jeans-wide-leg.svg',
    featured: true,
    badge: 'novo',
  }),
  makeProduct({
    id: 2,
    sku: 'AR-MAC-002',
    name: 'Macaquinho Jeans',
    slug: 'macaquinho-jeans',
    category: 'feminino',
    price: 149.9,
    image: 'assets/products/macaquinho-jeans.svg',
    featured: true,
    weeklyPick: true,
  }),
  makeProduct({
    id: 3,
    sku: 'AR-BEB-003',
    name: 'Conjunto Canelado Bebê',
    slug: 'conjunto-canelado-bebe',
    category: 'bebe',
    price: 79.9,
    image: 'assets/products/conjunto-canelado-bebe.svg',
    featured: true,
    badge: 'novo',
  }),
  makeProduct({
    id: 4,
    sku: 'AR-CAM-004',
    name: 'Camiseta Roadster',
    slug: 'camiseta-roadster',
    category: 'masculino',
    price: 89.9,
    image: 'assets/products/camiseta-roadster.svg',
    featured: true,
    weeklyPick: true,
  }),
  makeProduct({
    id: 5,
    sku: 'AR-CJA-005',
    name: 'Conjunto Alfaiataria',
    slug: 'conjunto-alfaiataria',
    category: 'feminino',
    price: 219.9,
    promotionalPrice: 189.9,
    image: 'assets/products/conjunto-alfaiataria.svg',
    featured: true,
    badge: 'oferta',
  }),
  makeProduct({
    id: 6,
    sku: 'AR-BOL-006',
    name: 'Bolsa Palha Dourada',
    slug: 'bolsa-palha-dourada',
    category: 'acessorios',
    price: 119.9,
    image: 'assets/products/bolsa-palha-dourada.svg',
    featured: true,
  }),
  makeProduct({
    id: 7,
    sku: 'AR-VES-007',
    name: 'Vestido Plus Size Floral',
    slug: 'vestido-plus-size-floral',
    category: 'plus-size',
    price: 179.9,
    image: 'assets/products/vestido-plus-size-floral.svg',
    bestSeller: true,
    badge: 'mais-vendido',
  }),
  makeProduct({
    id: 8,
    sku: 'AR-POL-008',
    name: 'Polo Masculina Piquet',
    slug: 'polo-masculina-piquet',
    category: 'masculino',
    price: 99.9,
    image: 'assets/products/polo-masculina-piquet.svg',
    bestSeller: true,
    badge: 'mais-vendido',
  }),
  makeProduct({
    id: 9,
    sku: 'AR-BOD-009',
    name: 'Body Bebê Algodão',
    slug: 'body-bebe-algodao',
    category: 'bebe',
    price: 59.9,
    image: 'assets/products/body-bebe-algodao.svg',
    bestSeller: true,
    weeklyPick: true,
  }),
  makeProduct({
    id: 10,
    sku: 'AR-BLU-010',
    name: 'Blusa Cropped Feminina',
    slug: 'blusa-cropped-feminina',
    category: 'feminino',
    price: 89.9,
    promotionalPrice: 69.9,
    image: 'assets/products/blusa-cropped-feminina.svg',
    bestSeller: true,
    badge: 'oferta',
  }),
  makeProduct({
    id: 11,
    sku: 'AR-CIN-011',
    name: 'Cinto Couro Dourado',
    slug: 'cinto-couro-dourado',
    category: 'acessorios',
    price: 49.9,
    image: 'assets/products/cinto-couro-dourado.svg',
    bestSeller: true,
    weeklyPick: true,
  }),
  makeProduct({
    id: 12,
    sku: 'AR-BER-012',
    name: 'Bermuda Jeans Plus Size',
    slug: 'bermuda-jeans-plus-size',
    category: 'plus-size',
    price: 139.9,
    image: 'assets/products/bermuda-jeans-plus-size.svg',
    bestSeller: true,
    badge: 'mais-vendido',
  }),
];

const CATEGORIES = [
  { name: 'Feminino', slug: 'feminino', image: 'assets/categories/feminino.svg' },
  { name: 'Bebê', slug: 'bebe', image: 'assets/categories/bebe.svg' },
  { name: 'Plus Size', slug: 'plus-size', image: 'assets/categories/plus-size.svg' },
  { name: 'Masculino', slug: 'masculino', image: 'assets/categories/masculino.svg' },
  { name: 'Acessórios', slug: 'acessorios', image: 'assets/categories/acessorios.svg' },
];

const HERO_SLIDES = [
  {
    image: 'assets/hero/hero-1.svg',
    title: 'Estilo Anarosa\npara todos os momentos',
    description:
      'Peças novas toda semana, com preço justo, entrega para todo o Brasil e a elegância que só a Anarosa tem.',
  },
  {
    image: 'assets/hero/hero-2.svg',
    title: 'Novidades toda semana\npra você se apaixonar',
    description: 'Coleções exclusivas chegando toda semana com a qualidade e o estilo Anarosa.',
  },
  {
    image: 'assets/hero/hero-3.svg',
    title: 'Condições especiais\npra toda a família',
    description: 'Parcelamento em até 6x sem juros e 5% de desconto exclusivo pagando no PIX.',
  },
];

const HERO_CTA_PRIMARY = { label: 'Comprar agora', href: '#mais-vendidos' };
const HERO_CTA_SECONDARY = { label: 'Ver novidades', href: '#novidades' };

const HERO_PERKS = [
  { icon: 'tag', label: '5% OFF no Pix' },
  { icon: 'card', label: '6x sem juros' },
  { icon: 'truck', label: 'Envio p/ todo o Brasil' },
  { icon: 'phone', label: 'Atendimento no WhatsApp' },
];

const INSTAGRAM_POSTS = [1, 2, 3, 4, 5, 6].map((n) => ({
  id: n,
  image: `assets/instagram/post-${n}.svg`,
  href: 'https://www.instagram.com/anarosatextil/',
}));

window.AnarosaData = {
  PRODUCTS,
  CATEGORIES,
  HERO_SLIDES,
  HERO_CTA_PRIMARY,
  HERO_CTA_SECONDARY,
  HERO_PERKS,
  INSTAGRAM_POSTS,
  formatPrice,
};
