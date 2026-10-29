/** Redefinição de senha iniciada pelo link de recuperação do Supabase Auth. */
(function () {
  'use strict';

  const form = document.querySelector('[data-reset-password-form]');
  const status = document.querySelector('[data-reset-status]');
  const submit = document.querySelector('[data-reset-submit]');
  let recoveryAuthorized = false;
  let completed = false;

  function message(text, kind) {
    status.textContent = text;
    status.dataset.kind = kind;
    status.hidden = false;
  }

  function boot() {
    if (!window.GestaoAuth.isConfigured()) {
      message('Autenticação indisponível neste momento.', 'error');
      return;
    }
    if (!window.ANAROSA_RECOVERY_LINK) {
      message('Este link é inválido ou expirou. Solicite um novo link na tela de login.', 'error');
      return;
    }
    // Uma sessão normal já aberta NÃO autoriza redefinição de senha.
    // Exige confirmação do Supabase de que o link é de recuperação.
    window.GestaoAuth.onAuthStateChange((event, session) => {
      if (event !== 'PASSWORD_RECOVERY' || !session?.access_token) return;
      recoveryAuthorized = true;
      form.hidden = false;
      message('Link validado. Informe sua nova senha.', 'success');
    });
    // Aguarda o processamento inicial do link pelo cliente Supabase.
    // Não confia só no hash da URL ou em uma sessão antiga já existente.
    window.GestaoAuth.getSession().then(() => {
      if (!recoveryAuthorized) {
        message('Este link é inválido ou expirou. Solicite um novo link na tela de login.', 'error');
      }
    }).catch(() => {
      message('Não foi possível validar o link. Solicite um novo na tela de login.', 'error');
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!recoveryAuthorized || form.hidden || completed) return;
    const password = form.elements.namedItem('password').value;
    const confirmation = form.elements.namedItem('confirmation').value;
    if (password.length < 12) return message('A nova senha precisa ter pelo menos 12 caracteres.', 'error');
    if (password !== confirmation) return message('As senhas não coincidem.', 'error');
    submit.disabled = true;
    submit.textContent = 'Redefinindo…';
    try {
      // A autenticação é feita com o token temporário recebido no link.
      // Em seguida, a sessão é encerrada para exigir um novo login.
      await window.GestaoAuth.finishPasswordRecovery(password);
      completed = true;
      form.reset();
      form.hidden = true;
      message('Senha redefinida com sucesso! Volte ao login e entre com sua nova senha.', 'success');
    } catch {
      message('Não foi possível redefinir a senha. O link pode ter expirado. Solicite outro e tente novamente.', 'error');
    } finally {
      submit.disabled = false;
      submit.textContent = 'Redefinir senha';
    }
  });

  boot();
})();
