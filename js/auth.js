const { TABLES } = window.APP || {};

let currentStep = 1;
let avatarFile = null;
let usernameCheckTimeout = null;
let categoryMenuOpen = false;
let CATEGORIES = [];

document.addEventListener('DOMContentLoaded', async () => {
  CATEGORIES = await window.fetchTopics();
  initCategories();
  setupEventListeners();
});

function goToStep(step) {
  document.querySelectorAll('.form-step').forEach(form => form.classList.remove('active'));

  document.querySelectorAll('.step').forEach((stepEl, index) => {
    stepEl.classList.remove('active');
    if (index + 1 < step) stepEl.classList.add('completed');
    else if (index + 1 === step) stepEl.classList.add('active');
  });

  const form = document.getElementById(`step${step}-form`);
  if (form) form.classList.add('active');
  currentStep = step;
}

function setupEventListeners() {
  const usernameEl = document.getElementById('username');
  if (usernameEl) usernameEl.addEventListener('input', debounce(checkUsername, 500));

  const uploadText = document.getElementById('upload-text');
  if (uploadText) {
    uploadText.addEventListener('click', () => {
      const input = document.getElementById('avatar-input');
      if (input) input.click();
    });
  }

  const avatarInput = document.getElementById('avatar-input');
  if (avatarInput) avatarInput.addEventListener('change', handleAvatarUpload);

  const next1 = document.getElementById('next-step-1');
  if (next1) next1.addEventListener('click', validateStep1);
  const prev2 = document.getElementById('prev-step-2');
  if (prev2) prev2.addEventListener('click', () => goToStep(1));
  const next2 = document.getElementById('next-step-2');
  if (next2) next2.addEventListener('click', validateStep2);
  const prev3 = document.getElementById('prev-step-3');
  if (prev3) prev3.addEventListener('click', () => goToStep(2));
  const next3 = document.getElementById('next-step-3');
  if (next3) next3.addEventListener('click', validateStep3);

  const goLogin = document.getElementById('go-to-login');
  if (goLogin) goLogin.addEventListener('click', () => (window.location.href = 'login.html'));

  setupCategoriesDropdown();
}

function isValidEmojiIcon(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  return /^[\p{Extended_Pictographic}\uFE0F\u200D]+$/u.test(v);
}

function resolveCategoryLabel(category) {
  let displayName = (category?.name || '').trim();
  let icon = '';

  const explicitIcon = (category?.icon || '').trim();
  if (isValidEmojiIcon(explicitIcon)) icon = explicitIcon;

  if (!icon && displayName) {
    const emojiMatch = displayName.match(/^([\p{Extended_Pictographic}\uFE0F\u200D]+)\s+/u);
    if (emojiMatch && isValidEmojiIcon(emojiMatch[1])) {
      icon = emojiMatch[1];
      displayName = displayName.slice(emojiMatch[0].length).trim();
    }
  }

  return { icon, displayName };
}

function initCategories() {
  const container = document.getElementById('categories-container');
  if (!container) return;
  container.innerHTML = '';
  const groups = typeof window.groupTopicsForDisplay === 'function'
    ? window.groupTopicsForDisplay(CATEGORIES)
    : [{ title: 'Категории', items: CATEGORIES }];

  groups.forEach(group => {
    const groupEl = document.createElement('section');
    groupEl.className = 'category-group';

    const title = document.createElement('div');
    title.className = 'category-group-title';
    title.textContent = group.title;
    groupEl.appendChild(title);

    const itemsWrap = document.createElement('div');
    itemsWrap.className = 'category-group-items';

    group.items.forEach(category => {
      const checkboxId = `category-${category.id}`;
      const wrapper = document.createElement('div');
      wrapper.className = 'category-option';

      const { icon } = resolveCategoryLabel(category);
      const displayName = typeof window.getTopicDisplayName === 'function'
        ? window.getTopicDisplayName(category)
        : resolveCategoryLabel(category).displayName;
      const iconHtml = icon ? `<span class="category-icon">${icon}</span>` : '';

      wrapper.innerHTML = `
        <input type="checkbox" id="${checkboxId}" class="category-checkbox" value="${category.id}">
        <label for="${checkboxId}" class="category-label">
          ${iconHtml}
          <span>${displayName}</span>
        </label>
      `;
      itemsWrap.appendChild(wrapper);
    });

    groupEl.appendChild(itemsWrap);
    container.appendChild(groupEl);
  });

  container.addEventListener('change', updateSelectedCategoriesLabel);
  updateSelectedCategoriesLabel();
}

function setupCategoriesDropdown() {
  const trigger = document.getElementById('categories-trigger');
  const menu = document.getElementById('categories-menu');
  const searchInput = document.getElementById('categories-search');
  const dropdown = document.getElementById('categories-dropdown');

  if (!trigger || !menu || !searchInput || !dropdown) return;

  trigger.addEventListener('click', () => {
    if (categoryMenuOpen) closeCategoriesMenu();
    else openCategoriesMenu();
  });

  searchInput.addEventListener('input', e => filterCategoriesList(e.target.value));

  document.addEventListener('click', e => {
    if (!dropdown.contains(e.target)) closeCategoriesMenu();
  });
}

function openCategoriesMenu() {
  const trigger = document.getElementById('categories-trigger');
  const menu = document.getElementById('categories-menu');
  const searchInput = document.getElementById('categories-search');
  if (!trigger || !menu) return;

  categoryMenuOpen = true;
  trigger.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');
  menu.classList.add('open');
  if (searchInput) {
    searchInput.focus();
    filterCategoriesList(searchInput.value || '');
  }
}

function closeCategoriesMenu() {
  const trigger = document.getElementById('categories-trigger');
  const menu = document.getElementById('categories-menu');
  if (!trigger || !menu) return;
  categoryMenuOpen = false;
  trigger.classList.remove('open');
  trigger.setAttribute('aria-expanded', 'false');
  menu.classList.remove('open');
  const empty = document.getElementById('categories-empty');
  if (empty) empty.style.display = 'none';
}

function filterCategoriesList(query) {
  const container = document.getElementById('categories-container');
  const empty = document.getElementById('categories-empty');
  if (!container) return;
  const q = String(query || '').trim().toLowerCase();
  let visible = 0;
  container.querySelectorAll('.category-group').forEach(group => {
    let groupVisible = 0;
    group.querySelectorAll('.category-option').forEach(item => {
      const text = (item.textContent || '').toLowerCase();
      const ok = !q || text.includes(q);
      item.style.display = ok ? '' : 'none';
      if (ok) {
        visible += 1;
        groupVisible += 1;
      }
    });
    group.style.display = groupVisible > 0 ? '' : 'none';
  });
  if (empty) empty.style.display = visible === 0 ? 'block' : 'none';
}

function updateSelectedCategoriesLabel() {
  const selected = Array.from(document.querySelectorAll('.category-checkbox:checked'))
    .map(cb => cb.value);

  const pills = document.getElementById('selected-interests');
  const triggerText = document.getElementById('categories-trigger-text');
  if (pills) pills.innerHTML = '';

  if (!selected || selected.length === 0) {
    if (triggerText) triggerText.textContent = 'Выберите категории';
    return;
  }

  if (triggerText) triggerText.textContent = `Выбрано: ${selected.length}`;
  if (!pills) return;

  selected.forEach(id => {
    const item = CATEGORIES.find(c => String(c.id) === String(id));
    const name = item
      ? (typeof window.getTopicDisplayName === 'function' ? window.getTopicDisplayName(item) : item.name.replace(/^(\S+)\s+/, ''))
      : id;
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'selected-interest-pill';
    pill.textContent = name;
    pill.addEventListener('click', () => removeSelectedCategory(id));
    pills.appendChild(pill);
  });
}

function removeSelectedCategory(id) {
  const checkbox = document.querySelector(`.category-checkbox[value="${CSS.escape(String(id))}"]`);
  if (!checkbox) return;
  checkbox.checked = false;
  updateSelectedCategoriesLabel();
}

async function validateStep1() {
  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const fullName = document.getElementById('full-name').value.trim();
  const age = parseInt(document.getElementById('age').value, 10);
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

  if (!isValid) return;

  const emailAvailable = await checkEmailImmediately(email);
  if (!emailAvailable) {
    showError('email-error', 'Этот email уже зарегистрирован');
    return;
  }

  const usernameAvailable = await checkUsernameImmediately(username);
  if (!usernameAvailable) {
    showError('username-error', 'Этот никнейм уже занят');
    return;
  }

  goToStep(2);
}

function validateStep2() {
  const selected = Array.from(document.querySelectorAll('.category-checkbox:checked')).map(cb => cb.value);
  resetErrors(['categories']);
  if (!selected || selected.length === 0) {
    showError('categories-error', 'Выберите хотя бы одну категорию');
    return;
  }
  goToStep(3);
}

async function validateStep3() {
  resetErrors(['avatar']);
  const button = document.getElementById('next-step-3');
  const originalText = button ? button.textContent : '';
  if (button) {
    button.innerHTML = '<span class="loading"></span> Регистрируем...';
    button.disabled = true;
  }

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;
  const fullName = document.getElementById('full-name').value.trim();
  const age = parseInt(document.getElementById('age').value, 10);
  const gender = document.getElementById('gender').value;
  const city = document.getElementById('city').value.trim();
  const username = document.getElementById('username').value.trim();
  const about = document.getElementById('bio')?.value.trim() || '';
  const selectedCategories = Array.from(document.querySelectorAll('.category-checkbox:checked')).map(cb => cb.value);

  try {
    // Signup (creates session cookie)
    await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, username, full_name: fullName })
    }).then(async r => {
      const payload = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(payload?.error || `API error: ${r.status}`);
      return payload;
    });

    // Upload avatar (optional)
    let photoUrl = 'user';
    if (avatarFile) {
      const compressedAvatar = typeof window.compressImageFile === 'function'
        ? await window.compressImageFile(avatarFile, { maxWidth: 1200, maxHeight: 1200, maxBytes: 900 * 1024, quality: 0.8 })
        : avatarFile;
      const form = new FormData();
      form.append('file', compressedAvatar);
      const payload = await fetch('/api/upload/avatar', { method: 'POST', body: form })
        .then(async r => {
          const p = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(p?.error || `Upload error: ${r.status}`);
          return p;
        });
      photoUrl = payload?.url || 'user';
    }

    // Complete profile
    await fetch('/api/users/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        full_name: fullName,
        age: String(age),
        sex: gender,
        location: city,
        photo_URL: photoUrl,
        interests: selectedCategories,
        about,
        role: 'user',
        blocked_users: []
      })
    }).then(async r => {
      const payload = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(payload?.error || `API error: ${r.status}`);
      return payload;
    });

    showNotification('Аккаунт создан', 'success');
    setTimeout(() => {
      window.location.href = 'index.html';
    }, 500);
  } catch (error) {
    console.error('Ошибка регистрации:', error);
    showNotification(error.message || 'Ошибка регистрации', 'error');
  } finally {
    if (button) {
      button.textContent = originalText;
      button.disabled = false;
    }
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

  const checkingEl = document.getElementById('username-checking');
  const availableEl = document.getElementById('username-available');
  const takenEl = document.getElementById('username-taken');
  if (checkingEl) checkingEl.style.display = 'inline';
  if (availableEl) availableEl.style.display = 'none';
  if (takenEl) takenEl.style.display = 'none';

  const isAvailable = await checkUsernameImmediately(username);
  if (checkingEl) checkingEl.style.display = 'none';

  if (isAvailable) {
    if (availableEl) availableEl.style.display = 'inline';
    if (errorEl) errorEl.classList.remove('show');
  } else {
    if (takenEl) takenEl.style.display = 'inline';
    if (errorEl) errorEl.classList.add('show');
  }
}

async function checkUsernameImmediately(username) {
  try {
    const items = await api.get(TABLES.profiles, { username });
    return !items || items.length === 0;
  } catch (error) {
    console.error('Ошибка проверки никнейма:', error);
    return true;
  }
}

async function checkEmailImmediately(email) {
  try {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return false;
    const items = await api.get(TABLES.profiles, { email: normalizedEmail });
    return !items || items.length === 0;
  } catch (error) {
    console.error('Ошибка проверки email:', error);
    return true;
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
    if (avatarPreview) avatarPreview.innerHTML = `<img src="${e.target.result}" alt="Аватар">`;
    const uploadText = document.getElementById('upload-text');
    if (uploadText) uploadText.textContent = 'Изменить фото';
    const err = document.getElementById('avatar-error');
    if (err) err.classList.remove('show');
  };
  reader.readAsDataURL(file);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function showError(elementId, message) {
  const element = document.getElementById(elementId);
  if (!element) return;
  element.textContent = message;
  element.classList.add('show');
  const inputEl = document.getElementById(elementId.replace('-error', ''));
  if (inputEl) inputEl.classList.add('error');
}

function resetErrors(fields) {
  fields.forEach(field => {
    const errorEl = document.getElementById(`${field}-error`);
    if (errorEl) {
      errorEl.classList.remove('show');
      errorEl.textContent = '';
    }
    const inputEl = document.getElementById(field);
    if (inputEl) inputEl.classList.remove('error');
  });
}

function hideUsernameStatus() {
  const checkingEl = document.getElementById('username-checking');
  const availableEl = document.getElementById('username-available');
  const takenEl = document.getElementById('username-taken');
  if (checkingEl) checkingEl.style.display = 'none';
  if (availableEl) availableEl.style.display = 'none';
  if (takenEl) takenEl.style.display = 'none';
}

function showNotification(message, type = 'success') {
  const notification = document.getElementById('notification');
  if (!notification) return;
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
