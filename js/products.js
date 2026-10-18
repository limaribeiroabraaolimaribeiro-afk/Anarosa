/** Editorial assets only. Sale products always come from CatalogService. */
(function () {
  'use strict';
  const base = 'assets/img/optimized/';
  const CATEGORIES = [
    { slug: 'feminino', name: 'Feminino', line: 'Elegância para todos os seus dias', image: 'feminino-campanha', alt: 'Campanha feminina: conjunto bege listrado' },
    { slug: 'infantil', name: 'Infantil', line: 'Pequenos looks, grandes aventuras', image: 'infantil-campanha', alt: 'Campanha infantil: camiseta branca com laços' },
    { slug: 'masculino', name: 'Masculino', line: 'Estilo para todas as ocasiões', image: 'masculino-campanha', alt: 'Campanha masculina: camiseta preta' },
    { slug: 'plus-size', name: 'Plus Size', line: 'Beleza em todas as suas formas', image: 'plus-size-campanha', alt: 'Campanha plus size: vestido verde oliva' },
  ];
  const INSTAGRAM_POSTS = [
    ['bebe-editorial', 'Bebê com conjunto verde estampado'],
    ['infantil-editorial', 'Menina com camiseta branca de laços'],
    ['masculino-editorial', 'Homem com camiseta preta'],
    ['feminino-editorial', 'Mulher com conjunto bege'],
    ['juvenil-editorial', 'Dois meninos com camisetas escuras'],
    ['plus-size-editorial', 'Mulher com vestido verde oliva'],
  ].map(([image, alt]) => ({ image: base + image + '-480.webp', alt: 'Imagem de campanha: ' + alt }));
  window.AnarosaData = {
    PRODUCTS: [], CATEGORIES, INSTAGRAM_POSTS,
    formatPrice: (value) => Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }),
  };
})();
