/**
 * ANAROSA — página interna de diagnóstico (integration-status.html).
 *
 * Segurança:
 *  - O segredo administrativo NUNCA fica neste arquivo. O operador digita
 *    o valor na página; ele só é mantido em sessionStorage do próprio
 *    navegador (limpo ao fechar a aba) e enviado no header
 *    x-integration-admin-secret.
 *  - A página abre BLOQUEADA: nenhuma chamada de status/backend acontece
 *    antes do segredo ser validado com sucesso pelo backend (bling-status
 *    responde 401 para um header presente e inválido — ver
 *    supabase/functions/_shared/admin-auth.ts). Um visitante que só
 *    conhece a URL, sem o segredo, não vê nenhum dado nem aciona nada.
 *  - Isto é uma camada de UX/defesa em profundidade, não uma substituta
 *    de autenticação real: o HTML/JS deste arquivo é público como
 *    qualquer outro arquivo estático. A proteção que realmente importa
 *    é feita no backend (cada Edge Function administrativa valida o
 *    segredo de novo, de forma independente desta página).
 */
(function () {
  'use strict';

  const cfg = window.ANAROSA_CONFIG || {};
  const baseUrl = cfg.functionsBaseUrl || (cfg.supabaseUrl ? `${cfg.supabaseUrl.replace(/\/+$/, '')}/functions/v1` : '');
  const SECRET_KEY = 'anarosa_admin_secret_session';

  const $ = (sel) => document.querySelector(sel);
  const els = {
    envPill: $('[data-env-pill]'),
    provider: $('[data-provider]'),
    functionsUrl: $('[data-functions-url]'),
    blingPill: $('[data-bling-pill]'),
    blingStatus: $('[data-bling-status]'),
    configured: $('[data-configured]'),
    company: $('[data-company]'),
    expires: $('[data-expires]'),
    lastSync: $('[data-last-sync]'),
    lastWebhook: $('[data-last-webhook]'),
    products: $('[data-products]'),
    webhooks: $('[data-webhooks]'),
    orders: $('[data-orders]'),
    errors: $('[data-errors]'),
    log: $('[data-log]'),
    lockGate: $('[data-lock-gate]'),
    lockError: $('[data-lock-error]'),
    dashboard: $('[data-dashboard]'),
    secretInput: $('[data-secret-input]'),
    secretSave: $('[data-secret-save]'),
    secretClear: $('[data-secret-clear]'),
    btnConnect: $('[data-btn-connect]'),
    btnStatus: $('[data-btn-status]'),
    btnHealth: $('[data-btn-health]'),
    btnSync: $('[data-btn-sync]'),
    btnProcess: $('[data-btn-process]'),
    callbackUrl: $('[data-callback-url]'),
    webhookUrl: $('[data-webhook-url]'),
  };

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString('pt-BR');
  }

  function log(msg, obj) {
    if (!els.log) return;
    const stamp = new Date().toLocaleTimeString('pt-BR');
    const line = obj !== undefined ? `${msg}\n${JSON.stringify(obj, null, 2)}` : msg;
    els.log.textContent = `[${stamp}] ${line}\n\n` + els.log.textContent;
  }

  function setPill(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.className = `diag-pill ${kind ? `is-${kind}` : ''}`;
  }

  function escapeHtml(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  /**
   * Traduz o resultado de uma chamada em uma mensagem para o operador.
   * Não confunde "segredo errado" com "o backend quebrou": 401/403 são
   * sempre problema de credencial; 5xx é sempre erro interno do backend
   * (ex.: permissão de banco faltando) — nunca o contrário.
   */
  function classifyHttpError(err) {
    const status = err && typeof err.status === 'number' ? err.status : null;
    if (status === 401 || status === 403) return 'Segredo administrativo inválido.';
    if (status != null && status >= 500) return 'Erro interno da integração. Consulte os logs.';
    if (status != null) return `Falha na chamada (HTTP ${status}): ${(err && err.message) || 'erro desconhecido'}`;
    return `Falha de rede/configuração: ${(err && err.message) || 'erro desconhecido'}`;
  }

  function getSecret() {
    try {
      return sessionStorage.getItem(SECRET_KEY) || '';
    } catch {
      return '';
    }
  }

  function setSecret(value) {
    try {
      if (value) sessionStorage.setItem(SECRET_KEY, value);
      else sessionStorage.removeItem(SECRET_KEY);
    } catch {
      /* sessionStorage indisponível */
    }
  }

  /**
   * Chamada às Edge Functions. `admin: true` envia o header com o
   * segredo salvo em sessionStorage — ou `secretOverride`, usado só na
   * primeira validação, antes de o segredo ser salvo.
   */
  async function call(path, opts = {}) {
    if (!baseUrl) throw new Error('supabaseUrl não configurado em js/config.js');
    const headers = Object.assign({ Accept: 'application/json' }, opts.headers || {});
    if (opts.admin) headers['x-integration-admin-secret'] = opts.secretOverride ?? getSecret();
    if (cfg.supabaseAnonKey) {
      headers.apikey = cfg.supabaseAnonKey;
      headers.Authorization = `Bearer ${cfg.supabaseAnonKey}`;
    }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${baseUrl}/${path}`, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.message || json.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return json;
  }

  function renderStatus(s) {
    setPill(els.blingPill, s.connected ? 'Conectado' : 'Não conectado', s.connected ? 'ok' : 'bad');
    if (els.blingStatus) els.blingStatus.textContent = s.status || '—';
    if (els.configured) els.configured.textContent = s.blingConfigured ? 'Sim' : 'Não (faltam secrets)';
    if (els.company) els.company.textContent = s.companyId || '—';
    if (els.expires) els.expires.textContent = fmtDate(s.expiresAt);
    if (els.lastSync) els.lastSync.textContent = fmtDate(s.lastSyncAt);
    if (els.lastWebhook) els.lastWebhook.textContent = fmtDate(s.lastWebhookAt);
    if (els.products) {
      const p = s.cachedProducts || {};
      els.products.textContent = `${p.active ?? 0} ativos / ${p.total ?? 0} no cache`;
    }
    if (els.webhooks) {
      const w = s.webhooks || {};
      els.webhooks.textContent = Object.keys(w).length
        ? Object.entries(w).map(([k, v]) => `${k}: ${v}`).join(' · ')
        : '—';
    }
    if (els.orders) els.orders.textContent = s.orderSyncEnabled ? 'ATIVADA' : 'desativada (BLING_ORDER_SYNC_ENABLED=false)';
    if (els.errors) {
      const list = Array.isArray(s.recentErrors) ? s.recentErrors : [];
      els.errors.innerHTML = list.length
        ? list.map((e) => `<li>${escapeHtml(e.operation)} — ${escapeHtml(e.message)}<small>${fmtDate(e.at)}${e.httpStatus ? ` · HTTP ${e.httpStatus}` : ''}${e.code ? ` · ${escapeHtml(e.code)}` : ''}</small></li>`).join('')
        : '<li style="border-color:#1f6b3a">Nenhum erro recente.</li>';
    }
  }

  // ---------------------------------------------------------------
  // Bloqueio / desbloqueio da página
  // ---------------------------------------------------------------
  function showLocked(message) {
    els.dashboard?.setAttribute('hidden', '');
    els.lockGate?.removeAttribute('hidden');
    if (els.lockError) {
      if (message) {
        els.lockError.textContent = message;
        els.lockError.removeAttribute('hidden');
      } else {
        els.lockError.setAttribute('hidden', '');
      }
    }
  }

  function showUnlocked() {
    els.lockGate?.setAttribute('hidden', '');
    els.dashboard?.removeAttribute('hidden');
  }

  /**
   * 401/403 em qualquer chamada administrativa dentro do painel → o
   * segredo não é mais aceito, bloqueia de novo. Um 5xx NÃO bloqueia a
   * sessão (o segredo continua válido; o problema é no backend) — só é
   * reportado no log via classifyHttpError().
   */
  function handleAuthFailure(err, context) {
    const status = err && err.status;
    if (status === 401 || status === 403) {
      setSecret('');
      showLocked('Segredo administrativo inválido.');
      log(`${context}: sessão bloqueada (HTTP ${status} — segredo inválido ou revogado).`);
      return true;
    }
    return false;
  }

  async function tryUnlock(secretValue, { silent } = {}) {
    if (!baseUrl) {
      if (!silent) showLocked('Backend não configurado. Preencha supabaseUrl em js/config.js.');
      return false;
    }
    if (!secretValue) {
      if (!silent) showLocked('Informe o segredo administrativo.');
      return false;
    }
    try {
      const s = await call('bling-status', { admin: true, secretOverride: secretValue });
      if (!s.adminAuthenticated) {
        setSecret('');
        showLocked('Segredo administrativo inválido.');
        log('Tentativa de login rejeitada (adminAuthenticated=false).');
        return false;
      }
      setSecret(secretValue);
      if (els.secretInput) els.secretInput.value = '';
      showUnlocked();
      renderStatus(s);
      log(silent ? 'Sessão retomada com o segredo salvo neste navegador.' : 'Login administrativo confirmado pelo backend.', s);
      return true;
    } catch (err) {
      setSecret('');
      const message = classifyHttpError(err);
      showLocked(message);
      log(`Login falhou (HTTP ${(err && err.status) ?? '?'}): ${message}`, err && err.payload);
      return false;
    }
  }

  function lockAgain() {
    setSecret('');
    showLocked();
    if (els.secretInput) els.secretInput.value = '';
    log('Sessão administrativa encerrada nesta aba.');
  }

  // ---------------------------------------------------------------
  // Ações (só acionáveis com o painel desbloqueado)
  // ---------------------------------------------------------------
  async function refreshStatus() {
    try {
      const s = await call('bling-status', { admin: true });
      renderStatus(s);
      log('bling-status OK', s);
    } catch (err) {
      if (handleAuthFailure(err, 'bling-status')) return;
      setPill(els.blingPill, 'Indisponível', 'warn');
      log(`bling-status falhou: ${classifyHttpError(err)}`, err.payload);
    }
  }

  async function health() {
    try {
      const h = await call('integration-health');
      log('integration-health', h);
    } catch (err) {
      log(`integration-health falhou: ${classifyHttpError(err)}`, err.payload);
    }
  }

  async function connect() {
    try {
      const r = await call('bling-auth-start', { method: 'POST', admin: true });
      log('bling-auth-start OK — redirecionando para o Bling', { redirectUri: r.redirectUri, expiresAt: r.expiresAt });
      window.location.href = r.authorizeUrl;
    } catch (err) {
      if (handleAuthFailure(err, 'bling-auth-start')) return;
      log(`bling-auth-start falhou: ${classifyHttpError(err)}`, err.payload);
    }
  }

  async function sync() {
    if (!window.confirm('Executar sincronização completa Bling → cache? (somente leitura no Bling)')) return;
    try {
      log('bling-sync-products iniciado…');
      const r = await call('bling-sync-products', { method: 'POST', admin: true });
      log('bling-sync-products concluído', r.summary);
      await refreshStatus();
    } catch (err) {
      if (handleAuthFailure(err, 'bling-sync-products')) return;
      log(`bling-sync-products falhou: ${classifyHttpError(err)}`, err.payload);
    }
  }

  async function processQueue() {
    try {
      const r = await call('bling-webhook-process?limit=50', { method: 'POST', admin: true });
      log('bling-webhook-process', r.summary);
      await refreshStatus();
    } catch (err) {
      if (handleAuthFailure(err, 'bling-webhook-process')) return;
      log(`bling-webhook-process falhou: ${classifyHttpError(err)}`, err.payload);
    }
  }

  // ---------------------------------------------------------------
  // Inicialização
  // ---------------------------------------------------------------
  if (els.provider) els.provider.textContent = cfg.catalogProvider || 'mock';
  if (els.functionsUrl) els.functionsUrl.textContent = baseUrl || 'não configurado (js/config.js → supabaseUrl)';
  if (els.callbackUrl) els.callbackUrl.textContent = baseUrl ? `${baseUrl}/bling-oauth-callback` : '<COLOCAR_URL_DO_DEPLOY_AQUI>/bling-oauth-callback';
  if (els.webhookUrl) els.webhookUrl.textContent = baseUrl ? `${baseUrl}/bling-webhook` : '<COLOCAR_URL_DO_DEPLOY_AQUI>/bling-webhook';
  setPill(els.envPill, baseUrl ? 'Backend configurado' : 'Backend não configurado', baseUrl ? 'ok' : 'warn');

  if (els.secretSave) els.secretSave.disabled = !baseUrl;
  els.secretInput?.addEventListener('input', () => {
    if (els.secretSave) els.secretSave.disabled = !baseUrl || !els.secretInput.value.trim();
  });
  els.secretInput?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      els.secretSave?.click();
    }
  });

  els.secretSave?.addEventListener('click', () => {
    const v = (els.secretInput?.value || '').trim();
    tryUnlock(v);
  });
  els.secretClear?.addEventListener('click', lockAgain);

  els.btnStatus?.addEventListener('click', refreshStatus);
  els.btnHealth?.addEventListener('click', health);
  els.btnConnect?.addEventListener('click', connect);
  els.btnSync?.addEventListener('click', sync);
  els.btnProcess?.addEventListener('click', processQueue);

  // Resultado do callback OAuth (?bling=connected | ?bling=error&reason=...)
  const params = new URLSearchParams(window.location.search);
  const oauthReturn = params.has('bling');
  if (params.get('bling') === 'connected') log('✅ Bling autorizado com sucesso (callback OAuth).');
  if (params.get('bling') === 'error') log(`❌ Callback OAuth retornou erro: ${params.get('reason') || 'desconhecido'}`);
  if (oauthReturn) history.replaceState(null, '', window.location.pathname);

  // Sempre começa bloqueada. Se já houver um segredo desta mesma aba
  // (ex.: voltando do redirect OAuth), tenta retomar em silêncio; se o
  // segredo não validar mais, volta ao estado bloqueado normalmente.
  showLocked();
  const stored = getSecret();
  if (stored) {
    tryUnlock(stored, { silent: true });
  } else if (!baseUrl) {
    showLocked('Backend não configurado. Preencha supabaseUrl em js/config.js após o deploy das Edge Functions.');
  }
})();
