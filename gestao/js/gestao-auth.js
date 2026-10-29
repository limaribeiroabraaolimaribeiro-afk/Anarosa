/**
 * Gestão Anarosa — autenticação (Supabase Auth real).
 *
 * NUNCA usa senha hardcoded nem o INTEGRATION_ADMIN_SECRET. O login é
 * feito direto contra o Supabase Auth (supabase-js + anon key — a anon
 * key é pública por design, não é segredo). A sessão do usuário
 * (access_token) é o que vai no header Authorization das chamadas às
 * Edge Functions admin-*; o backend confere de novo, contra
 * store_admins, se esse usuário pode mesmo usar o painel — um login
 * válido no Supabase Auth não basta por si só.
 *
 * service_role, BLING_CLIENT_SECRET e tokens do Bling nunca existem
 * neste arquivo nem em nenhum outro sob /gestao/.
 */
(function () {
  'use strict';

  const cfg = window.ANAROSA_CONFIG || {};
  let client = null;

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.error('[GestaoAuth] biblioteca supabase-js não carregou (CDN indisponível?).');
  } else if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    console.error('[GestaoAuth] supabaseUrl/supabaseAnonKey não configurados em js/config.js.');
  } else {
    client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'anarosa-gestao-auth' },
    });
  }

  function assertClient() {
    if (!client) throw new Error('Supabase Auth não está configurado neste ambiente.');
    return client;
  }

  async function signIn(email, password) {
    const { data, error } = await assertClient().auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  }

  /**
   * Envia o link oficial do Supabase Auth. A URL precisa estar autorizada
   * em Authentication > URL Configuration > Redirect URLs.
   */
  async function requestPasswordReset(email) {
    const redirectTo = new URL('redefinir-senha.html', window.location.href);
    redirectTo.search = '';
    redirectTo.hash = '';
    const { error } = await assertClient().auth.resetPasswordForEmail(email, {
      redirectTo: redirectTo.toString(),
    });
    if (error) throw error;
  }

  /** Confirma a senha atual antes de permitir a alteração na conta logada. */
  async function changePassword(currentPassword, newPassword) {
    const auth = assertClient().auth;
    const { data: userData, error: userError } = await auth.getUser();
    const user = userData?.user;
    if (userError || !user?.id || !user.email) {
      throw new Error('Sua sessão expirou. Entre novamente.');
    }
    const { data: verified, error: verifyError } = await auth.signInWithPassword({
      email: user.email, password: currentPassword,
    });
    if (verifyError || verified?.user?.id !== user.id) {
      throw new Error('A senha atual está incorreta.');
    }
    const { error } = await auth.updateUser({ password: newPassword });
    if (error) throw error;
  }

  /** Só pode ser chamado após validar uma sessão de recuperação no link. */
  async function finishPasswordRecovery(newPassword) {
    const auth = assertClient().auth;
    const { data } = await auth.getSession();
    if (!data?.session) throw new Error('Link de recuperação inválido ou expirado.');
    const { error } = await auth.updateUser({ password: newPassword });
    if (error) throw error;
    // Uma sessão temporária de recuperação não deve manter o painel aberto.
    await auth.signOut();
  }

  async function signOut() {
    if (!client) return;
    await client.auth.signOut();
  }

  async function getSession() {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    return data.session ?? null;
  }

  /** dispara em SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED e falha de refresh. */
  function onAuthStateChange(callback) {
    if (!client) return () => {};
    const { data } = client.auth.onAuthStateChange((event, session) => callback(event, session));
    return () => data.subscription.unsubscribe();
  }

  window.GestaoAuth = {
    isConfigured: () => client !== null,
    signIn,
    requestPasswordReset,
    changePassword,
    finishPasswordRecovery,
    signOut,
    getSession,
    onAuthStateChange,
  };
})();
