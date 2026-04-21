document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  handleUrlState(urlParams);

  const form = document.getElementById('login-form');
  if (form) form.onsubmit = handleLogin;
  const resetForm = document.getElementById('reset-request-form');
  if (resetForm) resetForm.onsubmit = handleResetRequest;
  const backButton = document.getElementById('back-to-login-btn');
  if (backButton) backButton.onclick = showLoginMode;

  window.signInWithGoogle = signInWithGoogle;
  window.resetPassword = resetPassword;
});

async function handleUrlState(urlParams) {
  const confirmed = urlParams.get('confirmed') === 'true';
  const resetDone = urlParams.get('reset') === 'success';

  if (confirmed) {
    showBanner('Аккаунт подтвержден. Теперь вы можете войти.', 'success');
  } else if (resetDone) {
    showBanner('Пароль обновлен. Теперь войдите с новым паролем.', 'success');
  }
}

async function handleLogin(e) {
  e.preventDefault();

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const button = document.getElementById('login-btn');

  const emailErr = document.getElementById('email-error');
  const passErr = document.getElementById('password-error');
  if (emailErr) emailErr.textContent = '';
  if (passErr) passErr.textContent = '';

  if (!email) {
    if (emailErr) emailErr.textContent = 'Введите email';
    return;
  }
  if (!password) {
    if (passErr) passErr.textContent = 'Введите пароль';
    return;
  }

  const originalText = button ? button.textContent : '';
  if (button) {
    button.innerHTML = '<span class="loading"></span> Вход...';
    button.disabled = true;
  }

  try {
    await api.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    window.location.href = 'index.html';
  } catch (error) {
    console.error('Ошибка входа:', error);
    if (emailErr) {
      emailErr.textContent = /confirm your email/i.test(error.message)
        ? 'Подтвердите email перед входом'
        : 'Неверный email или пароль';
    }
    if (button) {
      button.textContent = originalText;
      button.disabled = false;
    }
  }
}

async function signInWithGoogle() {
  alert('Вход через Google пока не поддерживается в локальном API.');
}

async function resetPassword() {
  const loginEmail = document.getElementById('email');
  const resetEmail = document.getElementById('reset-email');
  if (resetEmail && loginEmail && loginEmail.value.trim()) {
    resetEmail.value = loginEmail.value.trim();
  }
  showResetMode();
}

async function handleResetRequest(event) {
  event.preventDefault();

  const emailInput = document.getElementById('reset-email');
  const errorEl = document.getElementById('reset-email-error');
  const button = document.getElementById('reset-request-btn');
  const email = emailInput ? emailInput.value.trim() : '';
  if (errorEl) errorEl.textContent = '';

  if (!email) {
    if (errorEl) errorEl.textContent = 'Введите email';
    return;
  }

  const originalText = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = 'Отправляем...';
  }

  try {
    await api.request('/api/auth/request-password-reset', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
    showBanner('Если такой email существует, мы отправили письмо для сброса пароля.', 'success');
    showLoginMode();
  } catch (error) {
    showBanner(error.message || 'Не удалось отправить письмо для сброса пароля.', 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function showBanner(message, type) {
  const el = document.getElementById('success-message');
  if (!el) return;
  el.textContent = message;
  el.style.display = 'block';
  el.style.background = type === 'error' ? '#fee2e2' : '#d1fae5';
  el.style.color = type === 'error' ? '#991b1b' : '#065f46';
  el.style.borderColor = type === 'error' ? '#fecaca' : '#a7f3d0';
}

function showResetMode() {
  toggleAuthMode('reset');
}

function showLoginMode() {
  toggleAuthMode('login');
}
  
function toggleAuthMode(mode) {
  const pageTitle = document.querySelector('.page-title');
  const loginForm = document.getElementById('login-form');
  const resetForm = document.getElementById('reset-request-form');
  const divider = document.querySelector('.divider');
  const googleButton = document.getElementById('google-login-btn');
  const links = document.getElementById('login-links');

  if (pageTitle) {
    pageTitle.textContent = mode === 'reset' ? 'Сброс пароля' : 'Вход в аккаунт';
  }
  if (loginForm) loginForm.style.display = mode === 'login' ? '' : 'none';
  if (resetForm) resetForm.style.display = mode === 'reset' ? 'block' : 'none';
  if (divider) divider.style.display = mode === 'login' ? '' : 'none';
  if (googleButton) googleButton.style.display = mode === 'login' ? '' : 'none';
  if (links) links.style.display = mode === 'login' ? '' : 'none';
}
