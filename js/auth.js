const { TABLES } = window.APP || {};

let currentStep = 1;
let avatarFile = null;
let usernameCheckTimeout = null;
let categoryMenuOpen = false;
let CATEGORIES = [];
const collapsedCategoryGroups = new Set();
const TOPIC_EMOJI_FALLBACKS = [
  { emoji: '🎨', keywords: ['искус', 'арт', 'дизайн', 'рисов', 'творч'] },
  { emoji: '🎵', keywords: ['музык', 'песн', 'концерт', 'вокал'] },
  { emoji: '🎬', keywords: ['кино', 'фильм', 'сериал'] },
  { emoji: '📚', keywords: ['книг', 'литератур', 'чтени', 'поэз'] },
  { emoji: '💻', keywords: ['it', 'айти', 'программ', 'код', 'технол', 'стартап'] },
  { emoji: '🎮', keywords: ['игр', 'game', 'гейм', 'кибер'] },
  { emoji: '⚽', keywords: ['спорт', 'футбол', 'баскетбол', 'волейбол'] },
  { emoji: '🏋️', keywords: ['фитнес', 'тренаж', 'йог', 'пилатес', 'бег', 'workout'] },
  { emoji: '🏔️', keywords: ['поход', 'хайкинг', 'горы', 'природ', 'кемп'] },
  { emoji: '✈️', keywords: ['путеше', 'travel', 'туризм', 'поездк'] },
  { emoji: '🍳', keywords: ['еда', 'кулинар', 'готов', 'кухн', 'кофе', 'ресторан'] },
  { emoji: '🧘', keywords: ['медитац', 'осознан', 'психолог', 'wellness'] },
  { emoji: '🗣️', keywords: ['язык', 'англий', 'speaking', 'общени', 'нетворк'] },
  { emoji: '👨‍💼', keywords: ['бизнес', 'карьер', 'предприним', 'маркетинг'] },
  { emoji: '🎉', keywords: ['вечерин', 'тусов', 'развлеч', 'ивент'] },
  { emoji: '🧩', keywords: ['настол', 'квиз', 'головолом', 'quiz'] }
];

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
    // Show verification UI in step 4, store email for resend
    if (step === 4) {
      const emailInput = document.getElementById('email');
      if (emailInput && emailInput.value) {
        localStorage.setItem('pending_email', emailInput.value.trim());
      }
      // Update confirmation text
      setTimeout(() => {
        const confirmationText = document.getElementById('confirmation-text');
        if (confirmationText) {
          confirmationText.innerHTML = 'Письмо отправлено на ваш email. Пожалуйста, проверьте почту и перейдите по ссылке для активации аккаунта.';
        }
        const resendBtn = document.getElementById('resend-verification-btn');
        const statusDiv = document.getElementById('verify-status');
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
              await api.request('/api/auth/resend-verification', { method: 'POST', body: JSON.stringify({ email }) });
              statusDiv.textContent = 'Письмо отправлено!';
              statusDiv.style.color = '#10b981';
            } catch (e) {
              statusDiv.textContent = e.message || 'Ошибка отправки.';
              statusDiv.style.color = '#ef4444';
            }
            setTimeout(() => { resendBtn.disabled = false; }, 3000);
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

  if (!icon) {
    icon = getFallbackTopicEmoji(displayName || category?.name || '');
  }

  return { icon, displayName };
}

function getFallbackTopicEmoji(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';

  const match = TOPIC_EMOJI_FALLBACKS.find(entry => entry.keywords.some(keyword => normalized.includes(keyword)));
  return match ? match.emoji : '✨';
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
    groupEl.dataset.groupId = String(group.id || group.title || '');

    const selectedCount = group.items.filter(category => {
      const existing = document.querySelector(`.category-checkbox[value="${CSS.escape(String(category.id))}"]`);
      return Boolean(existing?.checked);
    }).length;

    const shouldCollapse = collapsedCategoryGroups.has(groupEl.dataset.groupId)
      || (!selectedCount && container.children.length > 0);
    if (shouldCollapse) groupEl.classList.add('is-collapsed');

    const groupIcon = isValidEmojiIcon(String(group.icon || '').trim())
      ? String(group.icon || '').trim()
      : getFallbackTopicEmoji(group.title);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'category-group-toggle';
    toggle.setAttribute('aria-expanded', shouldCollapse ? 'false' : 'true');
    toggle.dataset.groupToggle = groupEl.dataset.groupId;
    toggle.innerHTML = `
      <span class="category-group-heading">
        ${groupIcon ? `<span class="category-icon" aria-hidden="true">${groupIcon}</span>` : ''}
        <span class="category-group-title">${group.title}</span>
        <span class="category-group-count">${group.items.length}</span>
      </span>
      <span class="category-group-chevron" aria-hidden="true">▼</span>
    `;
    groupEl.appendChild(toggle);

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
  if (!container.dataset.groupToggleBound) {
    container.addEventListener('click', handleCategoryGroupToggle);
    container.dataset.groupToggleBound = 'true';
  }
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

  trapScrollWithin(menu.querySelector('.categories-list'));
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
    if (groupVisible > 0 && q) setCategoryGroupCollapsed(group, false);
    if (!q && collapsedCategoryGroups.has(group.dataset.groupId)) {
      setCategoryGroupCollapsed(group, true);
    }
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

function handleCategoryGroupToggle(event) {
  const toggle = event.target.closest('.category-group-toggle');
  if (!toggle) return;
  const group = toggle.closest('.category-group');
  if (!group) return;
  setCategoryGroupCollapsed(group, !group.classList.contains('is-collapsed'));
}

function setCategoryGroupCollapsed(group, collapsed) {
  const groupId = String(group?.dataset?.groupId || '');
  const toggle = group?.querySelector('.category-group-toggle');
  if (!group || !groupId || !toggle) return;

  group.classList.toggle('is-collapsed', collapsed);
  toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

  if (collapsed) collapsedCategoryGroups.add(groupId);
  else collapsedCategoryGroups.delete(groupId);
}

function trapScrollWithin(element) {
  if (!element || element.dataset.scrollTrapBound) return;

  element.addEventListener('wheel', event => {
    const { scrollTop, scrollHeight, clientHeight } = element;
    const delta = event.deltaY;
    const atTop = scrollTop <= 0;
    const atBottom = scrollTop + clientHeight >= scrollHeight - 1;

    if ((delta < 0 && atTop) || (delta > 0 && atBottom)) {
      event.preventDefault();
    }
  }, { passive: false });

  let touchStartY = 0;
  element.addEventListener('touchstart', event => {
    touchStartY = event.touches[0]?.clientY || 0;
  }, { passive: true });

  element.addEventListener('touchmove', event => {
    const currentY = event.touches[0]?.clientY || 0;
    const deltaY = touchStartY - currentY;
    const { scrollTop, scrollHeight, clientHeight } = element;
    const atTop = scrollTop <= 0;
    const atBottom = scrollTop + clientHeight >= scrollHeight - 1;

    if ((deltaY < 0 && atTop) || (deltaY > 0 && atBottom)) {
      event.preventDefault();
    }
  }, { passive: false });

  element.dataset.scrollTrapBound = 'true';
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
  resetErrors(['avatar', 'email']);
  
  const email = document.getElementById('email').value.trim();
  if (!email) {
    showError('email-error', 'Введите email');
    return;
  }
  if (!isValidEmail(email)) {
    showError('email-error', 'Введите корректный email (например: user@example.com)');
    return;
  }
  
  const button = document.getElementById('next-step-3');
  const originalText = button ? button.textContent : '';
  if (button) {
    button.innerHTML = '<span class="loading"></span> Регистрируем...';
    button.disabled = true;
  }

  const password = document.getElementById('password').value;
  const fullName = document.getElementById('full-name').value.trim();
  const age = parseInt(document.getElementById('age').value, 10);
  const gender = document.getElementById('gender').value;
  const city = document.getElementById('city').value.trim();
  const username = document.getElementById('username').value.trim();
  const about = document.getElementById('bio')?.value.trim() || '';
  const selectedCategories = Array.from(document.querySelectorAll('.category-checkbox:checked')).map(cb => cb.value);

  try {
    // Sign up and create the full profile in one request.
    const signupPayload = await fetch('/api/auth/signup', {
      method: 'POST',
      credentials: 'same-origin',
      headers: typeof api?.buildHeaders === 'function'
        ? api.buildHeaders({ method: 'POST', body: JSON.stringify({
          email,
          password,
          username,
          full_name: fullName,
          age: String(age),
          sex: gender,
          location: city,
          photo_url: 'user',
          interests: selectedCategories,
          about,
          role: 'user',
          blocked_users: []
        }) })
        : { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        username,
        full_name: fullName,
        age: String(age),
        sex: gender,
        location: city,
        photo_url: 'user',
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

    const confirmationText = document.getElementById('confirmation-text');
    if (confirmationText) {
      confirmationText.textContent = signupPayload?.delivery === 'log'
        ? 'Аккаунт создан. Автоматическая отправка письма пока не настроена, поэтому ссылка подтверждения выведена в логах сервера.'
        : 'Мы отправили письмо с подтверждением на ваш email. Проверьте почту и перейдите по ссылке, чтобы активировать аккаунт.';
    }
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
  // Более строгая проверка email
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  if (!emailRegex.test(email)) return false;
  
  // Дополнительная проверка: домен должен содержать точку и иметь корректную структуру
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  
  const domain = parts[1].toLowerCase();
  // Домен должен содержать хотя бы одну точку и не может начинаться/заканчиваться на точку
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return false;
  
  // Проверка что после последней точки есть минимум 2 символа (например .com, .ru)
  const lastDotIndex = domain.lastIndexOf('.');
  if (lastDotIndex === -1 || domain.length - lastDotIndex - 1 < 2) return false;
  
  // Разрешённые почтовые домены
  const allowedDomains = [
    'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
    'mail.ru', 'yandex.ru', 'yandex.by', 'yandex.kz', 'rambler.ru',
    'icloud.com', 'protonmail.com', 'proton.me', 'tutanota.com', 'zoho.com',
    'yandex.com', 'mail.ua', 'ukr.net', 'i.ua', 'bigmir.net',
    'telegram.org', 'discord.com', 'slack.com', 'bk.ru'
  ];
  
  // Проверяем, что домен в списке разрешённых
  if (!allowedDomains.includes(domain)) {
    return false;
  }
  
  return true;
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
