document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('confirmed') === 'true') {
    const el = document.getElementById('success-message');
    if (el) el.style.display = 'block';
  }

  const form = document.getElementById('login-form');
  if (form) form.onsubmit = handleLogin;

  window.signInWithGoogle = signInWithGoogle;
  window.resetPassword = resetPassword;
});

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
    if (emailErr) emailErr.textContent = 'Неверный email или пароль';
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
  alert('Сброс пароля пока не поддерживается в локальном API.');
}

