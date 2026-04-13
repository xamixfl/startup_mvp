document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('reset-form');
  if (form) form.addEventListener('submit', handleResetPassword);

  const token = new URLSearchParams(window.location.search).get('token');
  if (!token) {
    showMessage('Ссылка для сброса пароля недействительна.', 'error');
    if (form) form.style.display = 'none';
  }
});

async function handleResetPassword(event) {
  event.preventDefault();
  clearErrors();

  const token = new URLSearchParams(window.location.search).get('token');
  const password = document.getElementById('password').value;
  const passwordConfirm = document.getElementById('password-confirm').value;
  const button = document.getElementById('reset-btn');

  let hasError = false;
  if (!token) {
    showMessage('Ссылка для сброса пароля недействительна.', 'error');
    return;
  }
  if (!password || password.length < 6) {
    document.getElementById('password-error').textContent = 'Пароль должен быть не менее 6 символов';
    hasError = true;
  }
  if (password !== passwordConfirm) {
    document.getElementById('password-confirm-error').textContent = 'Пароли не совпадают';
    hasError = true;
  }
  if (hasError) return;

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Сохраняем...';

  try {
    await api.request('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password })
    });
    window.location.href = 'login.html?reset=success';
  } catch (error) {
    showMessage(error.message || 'Не удалось обновить пароль.', 'error');
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function clearErrors() {
  document.getElementById('password-error').textContent = '';
  document.getElementById('password-confirm-error').textContent = '';
  showMessage('', '');
}

function showMessage(message, type) {
  const el = document.getElementById('message');
  if (!el) return;
  el.textContent = message;
  el.className = type ? `message ${type}` : 'message';
}
