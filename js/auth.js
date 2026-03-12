const app = window.APP;
const supabaseClient = app.supabase;
const { TABLES } = app;

let currentStep = 1;
let avatarFile = null;
let usernameCheckTimeout = null;

// Categories will be fetched from database
let CATEGORIES = [];

function buildSafeAvatarPath(userId, file) {
  const fallbackExt = 'jpg';
  const byName = (file?.name || '').split('.').pop() || '';
  const byType = (file?.type || '').split('/').pop() || '';
  const rawExt = (byName || byType || fallbackExt).toLowerCase();
  const ext = rawExt.replace(/[^a-z0-9]/g, '') || fallbackExt;
  // Storage key must be URL-safe; avoid spaces/cyrillic/special chars in filename.
  return `avatars/${userId}/${Date.now()}.${ext}`;
}

document.addEventListener('DOMContentLoaded', async () => {
  CATEGORIES = await window.fetchTopics();
  initCategories();
  setupEventListeners();
});

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
  if (isValidEmojiIcon(explicitIcon)) {
    icon = explicitIcon;
  }

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
  CATEGORIES.forEach(category => {
    const checkboxId = `category-${category.id}`;
    const wrapper = document.createElement('div');
    
    const { icon, displayName } = resolveCategoryLabel(category);
    const iconHtml = icon ? `<span class="category-icon">${icon}</span>` : '';
    
    wrapper.innerHTML = `
      <input type="checkbox" id="${checkboxId}" class="category-checkbox" value="${category.id}">
      <label for="${checkboxId}" class="category-label">
        ${iconHtml}
        <span>${displayName}</span>
      </label>
    `;
    container.appendChild(wrapper);
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
    showError('email-error', 'Р’РІРµРґРёС‚Рµ РєРѕСЂСЂРµРєС‚РЅС‹Р№ email');
    isValid = false;
  }

  if (!password || password.length < 6) {
    showError('password-error', 'РџР°СЂРѕР»СЊ РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ РЅРµ РјРµРЅРµРµ 6 СЃРёРјРІРѕР»РѕРІ');
    isValid = false;
  }

  if (!fullName) {
    showError('name-error', 'Р’РІРµРґРёС‚Рµ РІР°С€Рµ РёРјСЏ');
    isValid = false;
  }

  if (!age || age < 18 || age > 100) {
    showError('age-error', 'Р’РѕР·СЂР°СЃС‚ РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ РѕС‚ 18 РґРѕ 100 Р»РµС‚');
    isValid = false;
  }

  if (!gender) {
    showError('gender-error', 'Р’С‹Р±РµСЂРёС‚Рµ РІР°С€ РїРѕР»');
    isValid = false;
  }

  if (!city) {
    showError('city-error', 'РЈРєР°Р¶РёС‚Рµ РіРѕСЂРѕРґ РёР»Рё СЂР°Р№РѕРЅ');
    isValid = false;
  }

  if (!username) {
    showError('username-error', 'Р’РІРµРґРёС‚Рµ РЅРёРєРЅРµР№Рј');
    isValid = false;
  } else if (username.length < 3) {
    showError('username-error', 'РќРёРєРЅРµР№Рј РґРѕР»Р¶РµРЅ Р±С‹С‚СЊ РЅРµ РјРµРЅРµРµ 3 СЃРёРјРІРѕР»РѕРІ');
    isValid = false;
  } else if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    showError('username-error', 'РўРѕР»СЊРєРѕ Р»Р°С‚РёРЅСЃРєРёРµ Р±СѓРєРІС‹, С†РёС„СЂС‹ Рё РїРѕРґС‡РµСЂРєРёРІР°РЅРёРµ');
    isValid = false;
  }

  if (isValid) {
    const emailAvailable = await checkEmailImmediately(email);
    if (!emailAvailable) {
      showError('email-error', 'Этот email уже зарегистрирован');
      return;
    }

    const usernameAvailable = await checkUsernameImmediately(username);
    if (!usernameAvailable) {
      showError('username-error', 'Р­С‚РѕС‚ РЅРёРєРЅРµР№Рј СѓР¶Рµ Р·Р°РЅСЏС‚');
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
    showError('categories-error', 'Р’С‹Р±РµСЂРёС‚Рµ С…РѕС‚СЏ Р±С‹ РѕРґРЅСѓ РєР°С‚РµРіРѕСЂРёСЋ');
    return;
  }

  goToStep(3);
}

async function validateStep3() {
  resetErrors(['avatar']);

  const button = document.getElementById('next-step-3');
  const originalText = button.textContent;
  button.innerHTML = '<span class="loading"></span> Р РµРіРёСЃС‚СЂРёСЂСѓРµРј...';
  button.disabled = true;

  try {
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const fullName = document.getElementById('full-name').value.trim();
    const age = parseInt(document.getElementById('age').value);
    const gender = document.getElementById('gender').value;
    const city = document.getElementById('city').value.trim();
    const username = document.getElementById('username').value.trim();
    const about = document.getElementById('bio')?.value.trim() || '';
    const selectedCategories = Array.from(
      document.querySelectorAll('.category-checkbox:checked')
    ).map(cb => cb.value);

    const { data: authData, error: authError } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          username: username,
          age: String(age),
          sex: gender,
          location: city,
          about: about
        },
        emailRedirectTo: `${window.location.origin}/login.html?confirmed=true`
      }
    });

    if (authError) throw authError;

    const userId = authData.user.id;

    let publicUrl = 'user';
    if (avatarFile) {
      const avatarPath = buildSafeAvatarPath(userId, avatarFile);
      const { error: uploadError } = await supabaseClient.storage
        .from('profiles')
        .upload(avatarPath, avatarFile, {
          cacheControl: '3600',
          upsert: false
        });

      if (uploadError) throw uploadError;

      const { data } = supabaseClient.storage
        .from('profiles')
        .getPublicUrl(avatarPath);
      publicUrl = data?.publicUrl || 'user';
    }

    const { error: profileError } = await supabaseClient
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
        about: about
      }]);

    if (profileError) throw profileError;

    showNotification('РђРєРєР°СѓРЅС‚ СЃРѕР·РґР°РЅ', 'success');
    setTimeout(() => {
      window.location.href = 'index.html';
    }, 500);
  } catch (error) {
    console.error('РћС€РёР±РєР° СЂРµРіРёСЃС‚СЂР°С†РёРё:', error);
    if (error?.message?.includes('User already registered')) {
      showNotification('Р­С‚РѕС‚ email СѓР¶Рµ Р·Р°СЂРµРіРёСЃС‚СЂРёСЂРѕРІР°РЅ. Р’РѕР№РґРёС‚Рµ РІ Р°РєРєР°СѓРЅС‚.', 'error');
      const loginLink = document.querySelector('.login-link a');
      if (loginLink) {
        loginLink.textContent = 'Р’РѕР№С‚Рё РІ Р°РєРєР°СѓРЅС‚';
      }
    } else {
      showNotification(error.message || 'РћС€РёР±РєР° СЂРµРіРёСЃС‚СЂР°С†РёРё', 'error');
    }
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
    showError('username-error', 'РўРѕР»СЊРєРѕ Р»Р°С‚РёРЅСЃРєРёРµ Р±СѓРєРІС‹, С†РёС„СЂС‹ Рё РїРѕРґС‡РµСЂРєРёРІР°РЅРёРµ');
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
    const { data, error } = await supabaseClient
      .from('profiles')
      .select('username')
      .eq('username', username)
      .maybeSingle();

    if (error) throw error;
    return !data;
  } catch (error) {
    console.error('РћС€РёР±РєР° РїСЂРѕРІРµСЂРєРё РЅРёРєРЅРµР№РјР°:', error);
    // Р•СЃР»Рё РїСЂРѕРІРµСЂРєР° РЅРµРґРѕСЃС‚СѓРїРЅР° (РЅР°РїСЂРёРјРµСЂ, РёР·-Р·Р° RLS), РЅРµ Р±Р»РѕРєРёСЂСѓРµРј СЂРµРіРёСЃС‚СЂР°С†РёСЋ
    return true;
  }
}
async function checkEmailImmediately(email) {
  try {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return false;

    const { data, error } = await supabaseClient
      .from(TABLES.profiles)
      .select('id')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (error) throw error;
    return !data;
  } catch (error) {
    console.error('Ошибка проверки email:', error);
    // Не блокируем шаг при временной недоступности проверки.
    return true;
  }
}
function handleAvatarUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    showError('avatar-error', 'Р’С‹Р±РµСЂРёС‚Рµ РёР·РѕР±СЂР°Р¶РµРЅРёРµ');
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    showError('avatar-error', 'РР·РѕР±СЂР°Р¶РµРЅРёРµ РґРѕР»Р¶РЅРѕ Р±С‹С‚СЊ РјРµРЅСЊС€Рµ 5MB');
    return;
  }

  avatarFile = file;

  const reader = new FileReader();
  reader.onload = function(e) {
    const avatarPreview = document.getElementById('avatar-preview');
    avatarPreview.innerHTML = `<img src="${e.target.result}" alt="РђРІР°С‚Р°СЂ">`;
    document.getElementById('upload-text').textContent = 'РР·РјРµРЅРёС‚СЊ С„РѕС‚Рѕ';
    document.getElementById('avatar-error').classList.remove('show');
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
  if (inputEl) {
    inputEl.classList.add('error');
  }
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
  const checkingEl = document.getElementById('username-checking');
  const availableEl = document.getElementById('username-available');
  const takenEl = document.getElementById('username-taken');
  if (checkingEl) checkingEl.style.display = 'none';
  if (availableEl) availableEl.style.display = 'none';
  if (takenEl) takenEl.style.display = 'none';
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





