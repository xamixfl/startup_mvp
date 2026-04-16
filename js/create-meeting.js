const { TABLES } = window.APP || {};

let isSubmitting = false;
let editingMeetingId = null;
let currentUser = null;
let currentProfile = null;
let allTopics = [];
let allMeetingTopics = [];
let meetingTopicsMenuOpen = false;

const MAX_LIFETIME_HOURS = 72;
const TIME_STEP_MINUTES = 15;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', async () => {
  await populateTopicDropdown();
  await checkAuthOrRedirect();
  setupExpiresInputs();
  setupTopicSearch();

  const urlParams = new URLSearchParams(window.location.search);
  const editId = urlParams.get('edit');
  if (editId) {
    editingMeetingId = editId;
    await loadMeetingForEdit(editId);
    const titleEl = document.querySelector('.title');
    if (titleEl) titleEl.textContent = 'Редактировать встречу';
    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.textContent = 'Сохранить изменения';
  }

  const form = document.getElementById('create-meeting-form');
  if (form) form.addEventListener('submit', handleCreateMeeting);
});

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function setupExpiresInputs() {
  const dateInput = document.getElementById('meeting-expires-date');
  const timeSelect = document.getElementById('meeting-expires-time');
  if (!dateInput || !timeSelect) return;

  const hintEl = document.getElementById('expires-hint');
  if (hintEl) hintEl.textContent = `Можно выбрать только в пределах ${MAX_LIFETIME_HOURS} часов.`;

  const now = new Date();
  const max = new Date(now.getTime() + MAX_LIFETIME_HOURS * 60 * 60 * 1000);
  const todayStr = formatLocalDate(now);
  const maxDateStr = formatLocalDate(max);

  dateInput.min = todayStr;
  dateInput.max = maxDateStr;
  if (!dateInput.value) dateInput.value = todayStr;

  const populateTimes = () => {
    timeSelect.innerHTML = '';
    const selectedDate = new Date(`${dateInput.value}T00:00:00`);
    const start = new Date(selectedDate);
    const end = new Date(selectedDate);

    if (dateInput.value === todayStr) {
      start.setHours(now.getHours(), now.getMinutes(), 0, 0);
      const minutes = start.getMinutes();
      const rounded = Math.ceil(minutes / TIME_STEP_MINUTES) * TIME_STEP_MINUTES;
      start.setMinutes(rounded);
    } else {
      start.setHours(0, 0, 0, 0);
    }

    if (dateInput.value === maxDateStr) {
      end.setHours(max.getHours(), max.getMinutes(), 0, 0);
    } else {
      end.setHours(23, 59, 0, 0);
    }

    if (end < start) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Нет доступного времени';
      timeSelect.appendChild(option);
      timeSelect.disabled = true;
      return;
    }

    timeSelect.disabled = false;
    const cursor = new Date(start);
    while (cursor <= end) {
      const hours = String(cursor.getHours()).padStart(2, '0');
      const mins = String(cursor.getMinutes()).padStart(2, '0');
      const value = `${hours}:${mins}`;
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      timeSelect.appendChild(option);
      cursor.setMinutes(cursor.getMinutes() + TIME_STEP_MINUTES);
    }
  };

  populateTimes();
  dateInput.addEventListener('change', populateTimes);
}

async function populateTopicDropdown() {
  if (!window.fetchTopics) return;
  const topics = await window.fetchTopics();
  allTopics = Array.isArray(topics) ? topics : [];
  allMeetingTopics = typeof window.getSelectableTopics === 'function'
    ? window.getSelectableTopics(allTopics)
    : allTopics.filter(topic => !topic?.is_group);
  renderMeetingTopicOptions(allTopics);
  updateMeetingSelectedTopic();
}

function renderMeetingTopicOptions(topics) {
  const container = document.getElementById('meeting-categories-container');
  if (!container) return;

  const selectedValue = document.getElementById('meeting-topic')?.value || '';
  container.innerHTML = '';

  let groups = typeof window.groupTopicsForDisplay === 'function'
    ? window.groupTopicsForDisplay(topics)
    : [{ title: 'Категории', items: topics }];
  groups = groups.map(group => ({
    ...group,
    items: (group.items || []).filter(topic => !topic?.is_group)
  })).filter(group => group.items.length > 0);

  groups.forEach(group => {
    const groupEl = document.createElement('section');
    groupEl.className = 'topic-filter-group';
    groupEl.dataset.groupId = group.id || '';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'topic-filter-group-trigger';
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = `
      <span class="topic-filter-group-trigger-main">
        ${group.icon ? `<span class="topic-filter-group-icon">${escapeHtml(group.icon)}</span>` : ''}
        <span class="topic-filter-group-title">${escapeHtml(group.title)}</span>
      </span>
      <span class="topic-filter-group-arrow">▼</span>
    `;

    const itemsWrap = document.createElement('div');
    itemsWrap.className = 'topic-filter-options';
    itemsWrap.hidden = true;

    group.items.forEach(topic => {
      const radioId = `meeting-topic-${topic.id}`;
      const wrapper = document.createElement('div');
      wrapper.className = 'category-option';
      const icon = typeof window.getTopicIcon === 'function' ? window.getTopicIcon(topic) : '';
      const displayName = typeof window.getTopicDisplayName === 'function'
        ? window.getTopicDisplayName(topic)
        : topic.name;
      const checked = String(topic.id) === String(selectedValue) ? 'checked' : '';
      const iconHtml = icon ? `<span class="category-icon">${icon}</span>` : '';

      wrapper.innerHTML = `
        <input type="radio" name="meeting-topic-choice" id="${radioId}" class="category-radio" value="${topic.id}" ${checked}>
        <label for="${radioId}" class="category-label">
          ${iconHtml}
          <span>${displayName}</span>
        </label>
      `;
      itemsWrap.appendChild(wrapper);
    });

    trigger.addEventListener('click', () => toggleMeetingTopicGroup(groupEl));
    groupEl.appendChild(trigger);
    groupEl.appendChild(itemsWrap);
    container.appendChild(groupEl);

    const hasSelectedTopic = group.items.some(topic => String(topic.id) === String(selectedValue));
    setMeetingTopicGroupOpen(groupEl, hasSelectedTopic);
  });

  container.querySelectorAll('.category-radio').forEach(radio => {
    radio.addEventListener('change', () => {
      const hiddenInput = document.getElementById('meeting-topic');
      if (hiddenInput) hiddenInput.value = radio.value;
      updateMeetingSelectedTopic();
      closeMeetingTopicsMenu();
    });
  });

  updateMeetingCategoriesEmptyState();
}

function setupTopicSearch() {
  const trigger = document.getElementById('meeting-categories-trigger');
  const menu = document.getElementById('meeting-categories-menu');
  const searchInput = document.getElementById('meeting-categories-search');
  const dropdown = document.getElementById('meeting-categories-dropdown');

  if (!trigger || !menu || !searchInput || !dropdown) return;

  trigger.addEventListener('click', () => {
    if (meetingTopicsMenuOpen) closeMeetingTopicsMenu();
    else openMeetingTopicsMenu();
  });

  searchInput.addEventListener('input', e => filterMeetingTopicsList(e.target.value));

  document.addEventListener('click', e => {
    if (!dropdown.contains(e.target)) closeMeetingTopicsMenu();
  });
}

function openMeetingTopicsMenu() {
  const trigger = document.getElementById('meeting-categories-trigger');
  const menu = document.getElementById('meeting-categories-menu');
  const searchInput = document.getElementById('meeting-categories-search');
  if (!trigger || !menu) return;

  meetingTopicsMenuOpen = true;
  trigger.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');
  menu.classList.add('open');
  if (searchInput) {
    searchInput.focus();
    filterMeetingTopicsList(searchInput.value || '');
  }
}

function closeMeetingTopicsMenu() {
  const trigger = document.getElementById('meeting-categories-trigger');
  const menu = document.getElementById('meeting-categories-menu');
  if (!trigger || !menu) return;

  meetingTopicsMenuOpen = false;
  trigger.classList.remove('open');
  trigger.setAttribute('aria-expanded', 'false');
  menu.classList.remove('open');
}

function filterMeetingTopicsList(query) {
  const container = document.getElementById('meeting-categories-container');
  if (!container) return;
  const q = String(query || '').trim().toLowerCase();

  container.querySelectorAll('.topic-filter-group').forEach(group => {
    let groupVisible = 0;
    group.querySelectorAll('.category-option').forEach(item => {
      const text = (item.textContent || '').toLowerCase();
      const selected = item.querySelector('.category-radio:checked');
      const ok = !q || text.includes(q) || Boolean(selected);
      item.style.display = ok ? '' : 'none';
      if (ok) groupVisible += 1;
    });
    group.style.display = groupVisible > 0 ? '' : 'none';
    setMeetingTopicGroupOpen(group, q ? groupVisible > 0 : group.classList.contains('open'));
  });

  updateMeetingCategoriesEmptyState();
}

function setMeetingTopicGroupOpen(groupEl, isOpen) {
  const trigger = groupEl?.querySelector('.topic-filter-group-trigger');
  const options = groupEl?.querySelector('.topic-filter-options');
  if (!trigger || !options) return;
  groupEl.classList.toggle('open', Boolean(isOpen));
  trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  options.hidden = !isOpen;
}

function toggleMeetingTopicGroup(groupEl) {
  if (!groupEl) return;
  const shouldOpen = !groupEl.classList.contains('open');
  setMeetingTopicGroupOpen(groupEl, shouldOpen);
}

function updateMeetingCategoriesEmptyState() {
  const container = document.getElementById('meeting-categories-container');
  const empty = document.getElementById('meeting-categories-empty');
  if (!container || !empty) return;

  const visible = Array.from(container.querySelectorAll('.category-option'))
    .some(item => item.style.display !== 'none');
  empty.style.display = visible ? 'none' : 'block';
}

function updateMeetingSelectedTopic() {
  const hiddenInput = document.getElementById('meeting-topic');
  const triggerText = document.getElementById('meeting-categories-trigger-text');
  const pills = document.getElementById('meeting-selected-topic');
  const value = hiddenInput?.value || '';
  const selectedTopic = allMeetingTopics.find(topic => String(topic.id) === String(value));

  if (pills) pills.innerHTML = '';

  if (!selectedTopic) {
    if (triggerText) triggerText.textContent = 'Выберите категорию';
    return;
  }

  const displayName = typeof window.getTopicDisplayName === 'function'
    ? window.getTopicDisplayName(selectedTopic)
    : selectedTopic.name;
  if (triggerText) triggerText.textContent = displayName;
  if (!pills) return;

  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'selected-interest-pill';
  pill.textContent = displayName;
  pill.addEventListener('click', clearMeetingSelectedTopic);
  pills.appendChild(pill);
}

function clearMeetingSelectedTopic() {
  const hiddenInput = document.getElementById('meeting-topic');
  if (hiddenInput) hiddenInput.value = '';
  document.querySelectorAll('input[name="meeting-topic-choice"]').forEach(radio => {
    radio.checked = false;
  });
  updateMeetingSelectedTopic();
}

async function checkAuthOrRedirect() {
  const user = await window.getCurrentUser();
  if (!user) {
    window.location.href = 'login.html';
    return;
  }
  currentUser = user;

  try {
    const profile = await api.getOne(TABLES.profiles, user.id);
    currentProfile = profile || {};
    if (currentProfile.role === 'banned') {
      alert('Ваш аккаунт заблокирован. Вы не можете создавать встречи.');
      window.location.href = 'index.html';
    }
  } catch (error) {
    console.error('Error fetching profile:', error);
  }
}

function showNotification(message) {
  const notification = document.getElementById('notification');
  if (!notification) return;
  notification.textContent = message;
  notification.style.display = 'block';
  setTimeout(() => {
    notification.style.display = 'none';
  }, 3000);
}

async function handleCreateMeeting(event) {
  event.preventDefault();
  if (isSubmitting) return;

  if (currentProfile?.role === 'banned') {
    showNotification('Ваш аккаунт заблокирован. Вы не можете создавать встречи');
    return;
  }

  const headline = document.getElementById('meeting-headline').value.trim();
  const topic = document.getElementById('meeting-topic').value;
  const maxSlots = parseInt(document.getElementById('meeting-max-slots').value, 10);
  const city = document.getElementById('meeting-city').value.trim();
  const details = document.getElementById('meeting-details').value.trim();
  const dateValue = document.getElementById('meeting-expires-date')?.value;
  const timeValue = document.getElementById('meeting-expires-time')?.value;

  if (!headline || !topic || !maxSlots || !city || !details || !dateValue || !timeValue) {
    showNotification('Заполните все обязательные поля');
    return;
  }

  const now = new Date();
  const expires = new Date(`${dateValue}T${timeValue}:00`);
  const diffMs = expires.getTime() - now.getTime();
  if (Number.isNaN(expires.getTime()) || diffMs <= 0) {
    showNotification('Выберите корректное время жизни');
    return;
  }
  if (diffMs > MAX_LIFETIME_HOURS * 60 * 60 * 1000) {
    showNotification('Можно выбрать только в пределах 72 часов');
    return;
  }

  const meetingData = {
    title: headline,
    full_description: details,
    topic,
    location: city,
    max_slots: maxSlots,
    expires_at: expires.toISOString()
  };

  if (editingMeetingId) await updateMeetingInDb(editingMeetingId, meetingData);
  else await createMeetingInDb(meetingData);
}

async function createMeetingInDb(payload) {
  if (!currentUser) return;

  try {
    isSubmitting = true;
    const submitBtn = document.querySelector('#create-meeting-form .btn');
    if (submitBtn) submitBtn.disabled = true;

    const inserted = await api.insert(TABLES.meetings, {
      ...payload,
      creator_id: currentUser.id,
      current_slots: 1
    });
    const meeting = Array.isArray(inserted) ? inserted[0] : inserted;
    if (!meeting?.id) throw new Error('Meeting not created');

    // Extra safety: if something went wrong with the insert response, double-check that the meeting is readable.
    try {
      const check = await api.getOne(TABLES.meetings, meeting.id);
      if (!check) throw new Error('not found after insert');
    } catch (e) {
      console.warn('Встреча создана, но не читается сразу после вставки:', e);
    }

    // Link creator as participant
    try {
      await api.insert(TABLES.participants, { meeting_id: meeting.id, user_id: currentUser.id });
    } catch (e) {
      // Meeting is already created. If participants insert fails due to schema/constraints,
      // still redirect to the meeting page and let the user continue.
      console.warn('Не удалось добавить создателя в участники (встреча создана):', e);
    }

    // Create chat for meeting. If it fails, meeting must still be usable.
    try {
      const chats = await api.insert(TABLES.chats, {
        meeting_id: meeting.id,
        title: meeting.title || payload.title,
        owner_id: currentUser.id
      });
      const chat = Array.isArray(chats) ? chats[0] : chats;
      if (chat?.id) {
        await api.insert(TABLES.chat_members, { chat_id: chat.id, user_id: currentUser.id, role: 'owner', status: 'approved' });
        await api.update(TABLES.meetings, meeting.id, { chat_id: chat.id });
      }
    } catch (e) {
      console.warn('Не удалось создать чат для встречи (встреча создана):', e);
    }

    showNotification('Встреча опубликована!');

    const targetUrl = `meeting.html?id=${meeting.id}`;
    try {
      localStorage.setItem('last_created_meeting_id', String(meeting.id));
    } catch (_e) { /* ignore */ }

    // Navigate ASAP; add a small fallback in case the first navigation is blocked by the browser for any reason.
    setTimeout(() => window.location.assign(targetUrl), 50);
    setTimeout(() => window.location.assign(targetUrl), 1500);
  } catch (error) {
    console.error('Ошибка создания встречи:', error);
    showNotification('Ошибка: ' + (error.message || 'Не удалось создать'));
  } finally {
    isSubmitting = false;
    const submitBtn = document.querySelector('#create-meeting-form .btn');
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function updateMeetingInDb(meetingId, payload) {
  if (!currentUser) return;
  try {
    isSubmitting = true;
    const submitBtn = document.querySelector('#create-meeting-form .btn');
    if (submitBtn) submitBtn.disabled = true;

    const updated = await api.update(TABLES.meetings, meetingId, {
      title: payload.title,
      full_description: payload.full_description,
      topic: payload.topic,
      location: payload.location,
      max_slots: payload.max_slots,
      expires_at: payload.expires_at
    });
    const row = Array.isArray(updated) ? updated[0] : updated;
    if (!row) throw new Error('Не удалось обновить встречу');

    showNotification('Встреча обновлена!');
    setTimeout(() => {
      window.location.href = `meeting.html?id=${meetingId}`;
    }, 600);
  } catch (error) {
    console.error('Ошибка обновления встречи:', error);
    showNotification('Ошибка: ' + (error.message || 'Не удалось обновить встречу'));
  } finally {
    isSubmitting = false;
    const submitBtn = document.querySelector('#create-meeting-form .btn');
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function loadMeetingForEdit(meetingId) {
  try {
    const meeting = await api.getOne(TABLES.meetings, meetingId);
    if (!meeting) {
      alert('Встреча не найдена');
      window.location.href = 'index.html';
      return;
    }

    if (!currentUser || meeting.creator_id !== currentUser.id) {
      alert('Вы не можете редактировать эту встречу');
      window.location.href = 'index.html';
      return;
    }

    document.getElementById('meeting-headline').value = meeting.title || '';
    document.getElementById('meeting-topic').value = meeting.topic || '';
    renderMeetingTopicOptions(allTopics);
    updateMeetingSelectedTopic();
    document.getElementById('meeting-max-slots').value = meeting.max_slots || 8;
    document.getElementById('meeting-city').value = meeting.location || '';
    document.getElementById('meeting-details').value = meeting.full_description || '';

    if (meeting.expires_at) {
      const expiresDate = new Date(meeting.expires_at);
      const dateInput = document.getElementById('meeting-expires-date');
      const timeSelect = document.getElementById('meeting-expires-time');
      if (dateInput && timeSelect) {
        dateInput.value = formatLocalDate(expiresDate);
        setupExpiresInputs();
        const hours = String(expiresDate.getHours()).padStart(2, '0');
        const minutes = String(expiresDate.getMinutes()).padStart(2, '0');
        timeSelect.value = `${hours}:${minutes}`;
      }
    }
  } catch (error) {
    console.error('Ошибка загрузки встречи:', error);
    alert('Ошибка загрузки встречи');
    window.location.href = 'index.html';
  }
}
