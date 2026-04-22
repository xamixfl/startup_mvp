let currentStep = 1;
let avatarFile = null;
let usernameCheckTimeout = null;
let categoryMenuOpen = false;
let CATEGORIES = [];
const PENDING_SIGNUP_STORAGE_KEY = 'pending_signup_payload';
const RESEND_COOLDOWN_STORAGE_KEY = 'pending_signup_resend_until';
let resendCooldownTimerId = null;

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
  if (step === 4) {
    const emailInput = document.getElementById('email');
    if (emailInput && emailInput.value) {
      localStorage.setItem('pending_email', emailInput.value.trim());
    }
    setTimeout(() => {
      const resendBtn = document.getElementById('resend-verification-btn');
      const statusDiv = document.getElementById('verify-status');
      syncResendCooldownUi();
      if (resendBtn) {
        resendBtn.onclick = async () => {
          const email = localStorage.getItem('pending_email') || '';
          if (!email) {
            statusDiv.textContent = 'Email не найден. Зарегистрируйтесь заново.';
            statusDiv.style.color = '#ef4444';
            return;
          }
          resendBtn.disabled = true;
          statusDiv.textContent = '';
          try {
            const registration = readPendingSignupPayload();
            if (!registration || registration.email !== email) {
              throw new Error('Данные регистрации не найдены. Зарегистрируйтесь заново.');
            }
            const resendPayload = await api.request('/api/auth/resend-verification', {
              method: 'POST',
              body: JSON.stringify({ registration })
            });
            statusDiv.textContent = 'Письмо отправлено!';
            statusDiv.style.color = '#10b981';
            startResendCooldown(Number(resendPayload?.retry_after_seconds || 60));
          } catch (e) {
            if (e?.status === 429 && Number.isFinite(Number(e?.payload?.retry_after_seconds))) {
              startResendCooldown(Number(e.payload.retry_after_seconds));
            }
            statusDiv.textContent = e.message || 'Ошибка отправки.';
            statusDiv.style.color = '#ef4444';
          }
        };
      }
    }, 200);
  }
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
  const confirmCodeBtn = document.getElementById('confirm-code-btn');
  if (confirmCodeBtn) confirmCodeBtn.addEventListener('click', submitConfirmationCode);

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

  const precheck = await api.request('/api/auth/precheck-signup', {
    method: 'POST',
    body: JSON.stringify({ email, username })
  }).catch(error => {
    console.error('Ошибка пред-проверки регистрации:', error);
    return null;
  });

  if (!precheck) {
    showNotification('Не удалось проверить email и никнейм. Попробуйте еще раз.', 'error');
    return;
  }

  if (!precheck.emailAvailable) {
    showError('email-error', 'Этот email уже зарегистрирован');
    showNotification('Этот email уже зарегистрирован', 'error');
    return;
  }
  if (!precheck.domainExists) {
    showError('email-error', 'Введите действительный email');
    showNotification('У вас неверный email', 'error');
    return;
  }

  if (!precheck.usernameAvailable) {
    showError('username-error', 'Этот никнейм уже занят');
    showNotification('Этот никнейм уже занят', 'error');
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
    // Upload avatar (optional) to a temporary public location; the real profile is created only after email confirmation.
    let photoUrl = 'user';
    if (avatarFile) {
      const compressedAvatar = typeof window.compressImageFile === 'function'
        ? await window.compressImageFile(avatarFile, { maxWidth: 1200, maxHeight: 1200, maxBytes: 900 * 1024, quality: 0.8 })
        : avatarFile;
      const form = new FormData();
      form.append('file', compressedAvatar);
      const payload = await fetch('/api/auth/upload-avatar', {
        method: 'POST',
        credentials: 'same-origin',
        headers: typeof api?.buildHeaders === 'function' ? api.buildHeaders({ method: 'POST', body: form }) : {},
        body: form
      })
        .then(async r => {
          const p = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(p?.error || `Upload error: ${r.status}`);
          return p;
        });
      photoUrl = payload?.url || 'user';
    }
    const signupRequestBody = {
      email,
      password,
      username,
      full_name: fullName,
      age: String(age),
      sex: gender,
      location: city,
      photo_url: photoUrl,
      interests: selectedCategories,
      about,
      role: 'user',
      blocked_users: []
    };

    const signupPayload = await fetch('/api/auth/signup', {
      method: 'POST',
      credentials: 'same-origin',
      headers: typeof api?.buildHeaders === 'function'
        ? api.buildHeaders({ method: 'POST', body: JSON.stringify(signupRequestBody) })
        : { 'Content-Type': 'application/json' },
      body: JSON.stringify(signupRequestBody)
    }).then(async r => {
      const payload = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(payload?.error || `API error: ${r.status}`);
      return payload;
    });

    localStorage.setItem(PENDING_SIGNUP_STORAGE_KEY, JSON.stringify(signupRequestBody));
    localStorage.setItem('pending_email', email);

    const confirmationText = document.getElementById('confirmation-text');
    if (confirmationText) {
      confirmationText.textContent = signupPayload?.delivery === 'log'
        ? 'Регистрация почти завершена. Автоматическая отправка письма пока не настроена, поэтому код подтверждения выведен в логах сервера.'
        : 'Мы отправили код подтверждения на ваш email. Введите его ниже, чтобы активировать аккаунт.';
    }
    startResendCooldown(Number(signupPayload?.retry_after_seconds || 60));
    goToStep(4);
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
    const result = await api.request('/api/auth/precheck-signup', {
      method: 'POST',
      body: JSON.stringify({ username })
    });
    return !!result?.usernameAvailable;
  } catch (error) {
    console.error('Ошибка проверки никнейма:', error);
    return true;
  }
}

async function checkEmailImmediately(email) {
  try {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return { available: false, domainExists: false };
    const result = await api.request('/api/auth/precheck-signup', {
      method: 'POST',
      body: JSON.stringify({ email: normalizedEmail })
    });
    return {
      available: !!result?.emailAvailable,
      domainExists: !!result?.domainExists
    };
  } catch (error) {
    console.error('Ошибка проверки email:', error);
    return { available: true, domainExists: true };
  }
}

function readPendingSignupPayload() {
  try {
    const raw = localStorage.getItem(PENDING_SIGNUP_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function getResendCooldownRemainingSeconds() {
  const raw = Number(localStorage.getItem(RESEND_COOLDOWN_STORAGE_KEY) || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  const remainingMs = raw - Date.now();
  if (remainingMs <= 0) {
    localStorage.removeItem(RESEND_COOLDOWN_STORAGE_KEY);
    return 0;
  }
  return Math.ceil(remainingMs / 1000);
}

function renderResendCooldown() {
  const resendBtn = document.getElementById('resend-verification-btn');
  const timerEl = document.getElementById('resend-timer');
  const remaining = getResendCooldownRemainingSeconds();
  if (!resendBtn) return remaining;

  if (remaining > 0) {
    resendBtn.disabled = true;
    resendBtn.textContent = `Отправить ещё раз через ${remaining} сек`;
    if (timerEl) timerEl.textContent = `Повторная отправка станет доступна через ${remaining} сек.`;
  } else {
    resendBtn.disabled = false;
    resendBtn.textContent = 'Отправить письмо ещё раз';
    if (timerEl) timerEl.textContent = 'Код не пришёл? Можно запросить новое письмо через минуту.';
  }
  return remaining;
}

function stopResendCooldownTimer() {
  if (resendCooldownTimerId) {
    clearInterval(resendCooldownTimerId);
    resendCooldownTimerId = null;
  }
}

function syncResendCooldownUi() {
  stopResendCooldownTimer();
  const remaining = renderResendCooldown();
  if (remaining > 0) {
    resendCooldownTimerId = setInterval(() => {
      const nextRemaining = renderResendCooldown();
      if (nextRemaining <= 0) {
        stopResendCooldownTimer();
      }
    }, 1000);
  }
}

function startResendCooldown(seconds) {
  const duration = Math.max(1, Number(seconds || 60));
  localStorage.setItem(RESEND_COOLDOWN_STORAGE_KEY, String(Date.now() + duration * 1000));
  syncResendCooldownUi();
}

async function submitConfirmationCode() {
  const registration = readPendingSignupPayload();
  const codeInput = document.getElementById('confirmation-code');
  const codeError = document.getElementById('confirmation-code-error');
  const button = document.getElementById('confirm-code-btn');
  const code = codeInput ? codeInput.value.trim() : '';

  if (codeError) codeError.textContent = '';

  if (!registration?.email) {
    showNotification('Данные регистрации не найдены. Зарегистрируйтесь заново.', 'error');
    return;
  }
  if (!/^\d{6}$/.test(code)) {
    if (codeError) codeError.textContent = 'Введите 6-значный код';
    showNotification('Введите 6-значный код', 'error');
    return;
  }

  const originalText = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = 'Подтверждаем...';
  }

  try {
    await api.request('/api/auth/confirm', {
      method: 'POST',
      body: JSON.stringify({ email: registration.email, code })
    });
    localStorage.removeItem(PENDING_SIGNUP_STORAGE_KEY);
    localStorage.removeItem('pending_email');
    window.location.href = 'login.html?confirmed=true';
  } catch (error) {
    if (codeError) codeError.textContent = error.message || 'Неверный код';
    showNotification(error.message || 'Неверный код подтверждения', 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
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
