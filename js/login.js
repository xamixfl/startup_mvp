const { supabase } = window.APP;

document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('confirmed') === 'true') {
    document.getElementById('success-message').style.display = 'block';
  }

  const form = document.getElementById('login-form');
  if (form) {
    form.onsubmit = handleLogin;
  }

  window.signInWithGoogle = signInWithGoogle;
  window.resetPassword = resetPassword;
});

async function handleLogin(e) {
  e.preventDefault();

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const button = document.getElementById('login-btn');

  document.getElementById('email-error').textContent = '';
  document.getElementById('password-error').textContent = '';

  if (!email) {
    document.getElementById('email-error').textContent = 'Введите email';
    return;
  }

  if (!password) {
    document.getElementById('password-error').textContent = 'Введите пароль';
    return;
  }

  const originalText = button.textContent;
  button.innerHTML = '<span class="loading"></span> Вход...';
  button.disabled = true;

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error) throw error;

    const { data: profile } = await supabase
      .from('profiles')
      .select('is_verified')
      .eq('id', data.user.id)
      .single();

    if (!profile?.is_verified) {
      await supabase.auth.signOut();
      throw new Error('Подтвердите email перед входом. Проверьте вашу почту.');
    }

    window.location.href = 'index.html';
  } catch (error) {
    console.error('Ошибка входа:', error);

    if (error.message.includes('Invalid login credentials')) {
      document.getElementById('password-error').textContent = 'Неверный email или пароль';
    } else if (error.message.includes('Email not confirmed')) {
      document.getElementById('email-error').textContent = 'Подтвердите email перед входом';
    } else {
      document.getElementById('email-error').textContent = error.message;
    }

    button.textContent = originalText;
    button.disabled = false;
  }
}

async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/index.html`
    }
  });

  if (error) {
    alert('Ошибка входа через Google: ' + error.message);
  }
}

async function resetPassword() {
  const email = prompt('Введите ваш email для сброса пароля:');
  if (!email) return;

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/reset-password.html`
  });

  if (error) {
    alert('Ошибка: ' + error.message);
  } else {
    alert('Инструкции по сбросу пароля отправлены на вашу почту');
  }
}
