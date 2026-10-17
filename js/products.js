/** Identidade visual da loja. Produtos e categorias vêm exclusivamente do Bling via Supabase. */
function formatPrice(value) { return Number(value||0).toLocaleString("pt-BR", {style:"currency",currency:"BRL"}); }
const PRODUCTS=[];
const CATEGORIES=[];
const HERO_SLIDES = [
  {
    image: 'assets/hero/hero-1.svg',
    title: 'Estilo Anarosa\npara todos os momentos',
    description:
      'Encontre sua próxima peça favorita e combine a retirada ou entrega com a nossa equipe.',
  },
  {
    image: 'assets/hero/hero-2.svg',
    title: 'Novidades toda semana\npra você se apaixonar',
    description: 'Coleções exclusivas chegando toda semana com a qualidade e o estilo Anarosa.',
  },
  {
    image: 'assets/hero/hero-3.svg',
    title: 'Condições especiais\npra toda a família',
    description: 'Escolha Pix ou cartão no ambiente seguro da InfinitePay.',
  },
];

const HERO_CTA_PRIMARY = { label: 'Comprar agora', href: '#mais-vendidos' };
const HERO_CTA_SECONDARY = { label: 'Ver novidades', href: '#novidades' };

const HERO_PERKS = [
  { icon: 'tag', label: 'Atendimento próximo' },
  { icon: 'card', label: 'Pagamento online' },
  { icon: 'truck', label: 'Retirada ou entrega' },
  { icon: 'phone', label: 'Atendimento no WhatsApp' },
];

const INSTAGRAM_POSTS=[];

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
