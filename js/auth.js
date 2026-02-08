const { supabase, TABLES } = window.APP;

let currentStep = 1;
let avatarFile = null;
let usernameCheckTimeout = null;

const CATEGORIES = [
  { id: 'boardgames', name: '🎲 Настольные игры', icon: '🎲' },
  { id: 'tennis', name: '🎾 Теннис', icon: '🎾' },
  { id: 'football', name: '⚽ Футбол', icon: '⚽' },
  { id: 'running', name: '🏃 Бег', icon: '🏃' },
  { id: 'coffee', name: '☕ Кофе', icon: '☕' },
  { id: 'cinema', name: '🎬 Кино', icon: '🎬' },
  { id: 'language', name: '🗣️ Языковая практика', icon: '🗣️' },
  { id: 'hiking', name: '🥾 Походы', icon: '🥾' },
  { id: 'music', name: '🎵 Музыка', icon: '🎵' },
  { id: 'photography', name: '📷 Фотография', icon: '📷' }
];

document.addEventListener('DOMContentLoaded', () => {
  initCategories();
  setupEventListeners();
});

function initCategories() {
  const container = document.getElementById('categories-container');
  CATEGORIES.forEach(category => {
    const checkboxId = `category-${category.id}`;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <input type="checkbox" id="${checkboxId}" class="category-checkbox" value="${category.id}">
      <label for="${checkboxId}" class="category-label">
        <span class="category-icon">${category.icon}</span>
        <span>${category.name}</span>
      </label>
    `;
    container.appendChild(wrapper.firstElementChild);
  });
}

function setupEventListeners() {
  document.getElementById('username').addEventListener('input', debounce(checkUsername, 500));
  document.getElementById('upload-text').addEventListener('click', () => {
    document.getElementById('avatar-input').click();
  });
  document.getElementById('avatar-input').addEventListener('change', handleAvatarUpload);

  document.getElementById('next-step-1').addEventListener('click', validateStep1);
  document.getElementById('prev-step-2').addEventListener('click', () => goToStep(1));
  document.getElementById('next-step-2').addEventListener('click', validateStep2);
  document.getElementById('prev-step-3').addEventListener('click', () => goToStep(2));
  document.getElementById('next-step-3').addEventListener('click', validateStep3);
  document.getElementById('go-to-login').addEventListener('click', () => {
    window.location.href = 'login.html';
  });
}

function goToStep(step) {
  document.querySelectorAll('.form-step').forEach(form => {
    form.classList.remove('active');
  });

  document.querySelectorAll('.step').forEach((stepEl, index) => {
    stepEl.classList.remove('active');
    if (index + 1 < step) {
      stepEl.classList.add('completed');
    } else if (index + 1 === step) {
      stepEl.classList.add('active');
    }
  });

  document.getElementById(`step${step}-form`).classList.add('active');
  currentStep = step;
}

async function validateStep1() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const fullName = document.getElementById('full-name').value.trim();
  const age = parseInt(document.getElementById('age').value);
  const gender = document.getElementById('gender').value;
  const city = document.getElementById('city').value.trim();
  const username = document.getElementById('username').value.trim();

  let isValid = true;
  resetErrors(['email', 'password', 'name', 'age', 'gender', 'city', 'username']);

  if (!email || !isValidEmail(email)) {
    showError('email-error', 'Введите корректный email');
    isValid = false;
  }

  if (!password || password.length < 6) {
    showError('password-error', 'Пароль должен быть не менее 6 символов');
    isValid = false;
  }

  if (!fullName) {
    showError('name-error', 'Введите ваше имя');
    isValid = false;
  }

  if (!age || age < 18 || age > 100) {
    showError('age-error', 'Возраст должен быть от 18 до 100 лет');
    isValid = false;
  }

  if (!gender) {
    showError('gender-error', 'Выберите ваш пол');
    isValid = false;
  }

  if (!city) {
    showError('city-error', 'Укажите город или район');
    isValid = false;
  }

  if (!username) {
    showError('username-error', 'Введите никнейм');
    isValid = false;
  } else if (username.length < 3) {
    showError('username-error', 'Никнейм должен быть не менее 3 символов');
    isValid = false;
  } else if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    showError('username-error', 'Только латинские буквы, цифры и подчеркивание');
    isValid = false;
  }

  if (isValid) {
    const usernameAvailable = await checkUsernameImmediately(username);
    if (!usernameAvailable) {
      showError('username-error', 'Этот никнейм уже занят');
      return;
    }
    goToStep(2);
  }
}

function validateStep2() {
  const selectedCategories = Array.from(
    document.querySelectorAll('.category-checkbox:checked')
  ).map(cb => cb.value);

  resetErrors(['categories']);

  if (selectedCategories.length === 0) {
    showError('categories-error', 'Выберите хотя бы одну категорию');
    return;
  }

  goToStep(3);
}

async function validateStep3() {
  resetErrors(['avatar']);

  if (!avatarFile) {
    showError('avatar-error', 'Загрузите фото профиля');
    return;
  }

  const button = document.getElementById('next-step-3');
  const originalText = button.textContent;
  button.innerHTML = '<span class="loading"></span> Регистрируем...';
  button.disabled = true;

  try {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const fullName = document.getElementById('full-name').value.trim();
    const age = parseInt(document.getElementById('age').value);
    const gender = document.getElementById('gender').value;
    const city = document.getElementById('city').value.trim();
    const username = document.getElementById('username').value.trim();
    const selectedCategories = Array.from(
      document.querySelectorAll('.category-checkbox:checked')
    ).map(cb => cb.value);

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          username: username,
          age: String(age),
          sex: gender,
          location: city
        },
        emailRedirectTo: `${window.location.origin}/login.html?confirmed=true`
      }
    });

    if (authError) throw authError;

    const userId = authData.user.id;

    const avatarPath = `avatars/${userId}/${Date.now()}_${avatarFile.name}`;
    const { error: uploadError } = await supabase.storage
      .from('profiles')
      .upload(avatarPath, avatarFile, {
        cacheControl: '3600',
        upsert: false
      });

    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = supabase.storage
      .from('profiles')
      .getPublicUrl(avatarPath);

    const { error: profileError } = await supabase
      .from(TABLES.profiles)
      .insert([{
        id: userId,
        email: email,
        username: username,
        full_name: fullName,
        age: String(age),
        sex: gender,
        location: city,
        photo_URL: publicUrl || 'user',
        interests: selectedCategories,
        created_at: new Date().toISOString()
      }]);

    if (profileError) throw profileError;

    document.getElementById('confirmation-text').innerHTML = `
      Мы отправили письмо с подтверждением на <strong>${email}</strong>.<br><br>
      Пожалуйста, проверьте почту и перейдите по ссылке в письме, чтобы активировать аккаунт.<br><br>
      <small style="color: #94a3b8;">Письмо может попасть в спам</small>
    `;

    goToStep(4);
  } catch (error) {
    console.error('Ошибка регистрации:', error);
    showNotification(error.message || 'Ошибка регистрации', 'error');
  } finally {
    button.textContent = originalText;
    button.disabled = false;
  }
}

async function checkUsername() {
  const username = document.getElementById('username').value.trim();
  const errorEl = document.getElementById('username-error');

  if (!username || username.length < 3) {
    hideUsernameStatus();
    return;
  }

  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    showError('username-error', 'Только латинские буквы, цифры и подчеркивание');
    hideUsernameStatus();
    return;
  }

  document.getElementById('username-checking').style.display = 'inline';
  document.getElementById('username-available').style.display = 'none';
  document.getElementById('username-taken').style.display = 'none';

  const isAvailable = await checkUsernameImmediately(username);

  if (isAvailable) {
    document.getElementById('username-checking').style.display = 'none';
    document.getElementById('username-available').style.display = 'inline';
    errorEl.classList.remove('show');
  } else {
    document.getElementById('username-checking').style.display = 'none';
    document.getElementById('username-taken').style.display = 'inline';
    errorEl.classList.add('show');
  }
}

async function checkUsernameImmediately(username) {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('username')
      .eq('username', username)
      .maybeSingle();

    if (error) throw error;
    return !data;
  } catch (error) {
    console.error('Ошибка проверки никнейма:', error);
    return false;
  }
}

function handleAvatarUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    showError('avatar-error', 'Выберите изображение');
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    showError('avatar-error', 'Изображение должно быть меньше 5MB');
    return;
  }

  avatarFile = file;

  const reader = new FileReader();
  reader.onload = function(e) {
    const avatarPreview = document.getElementById('avatar-preview');
    avatarPreview.innerHTML = `<img src="${e.target.result}" alt="Аватар">`;
    document.getElementById('upload-text').textContent = 'Изменить фото';
    document.getElementById('avatar-error').classList.remove('show');
  };
  reader.readAsDataURL(file);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function showError(elementId, message) {
  const element = document.getElementById(elementId);
  element.textContent = message;
  element.classList.add('show');
  document.getElementById(elementId.replace('-error', '')).classList.add('error');
}

function resetErrors(fields) {
  fields.forEach(field => {
    const errorEl = document.getElementById(`${field}-error`);
    if (errorEl) {
      errorEl.classList.remove('show');
      errorEl.textContent = '';
    }
    const inputEl = document.getElementById(field);
    if (inputEl) {
      inputEl.classList.remove('error');
    }
  });
}

function hideUsernameStatus() {
  document.getElementById('username-checking').style.display = 'none';
  document.getElementById('username-available').style.display = 'none';
  document.getElementById('username-taken').style.display = 'none';
}

function showNotification(message, type = 'success') {
  const notification = document.getElementById('notification');
  notification.textContent = message;
  notification.className = `notification ${type}`;
  notification.style.display = 'block';

  setTimeout(() => {
    notification.style.display = 'none';
  }, 5000);
}

function debounce(func, wait) {
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(usernameCheckTimeout);
      func(...args);
    };
    clearTimeout(usernameCheckTimeout);
    usernameCheckTimeout = setTimeout(later, wait);
  };
}
