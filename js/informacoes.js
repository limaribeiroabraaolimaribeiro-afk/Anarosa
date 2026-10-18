(function () {
  'use strict';
  document.querySelectorAll('[data-current-year]').forEach((el) => el.textContent = new Date().getFullYear());
  const openTarget = () => { let id; try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; } const target = document.getElementById(id); if (target?.tagName === 'DETAILS') target.open = true; };
  window.addEventListener('hashchange', openTarget); openTarget();
})();
