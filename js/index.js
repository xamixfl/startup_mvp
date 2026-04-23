const { TABLES } = window.APP || {};

let currentUser = null;
let allMeetings = [];
let currentProfile = null;
const DEFAULT_AVATAR = 'assets/avatar.png';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let TOPICS = [];

const selectedTopics = new Set();
const selectedCities = new Set();
let allCities = [];
const PARTICIPATION_NOTIFICATION_TYPES = [
  'event_join_request',
  'event_join_approved',
  'event_join_rejected',
  'event_joined_direct'
];

const BASE_CITIES = [
  'Москва',
  'Санкт-Петербург',
  'Казань',
  'Новосибирск',
  'Екатеринбург',
  'Нижний Новгород',
  'Самара',
  'Ростов-на-Дону',
  'Краснодар',
  'Владивосток'
];

document.addEventListener('DOMContentLoaded', async () => {
  TOPICS = await window.fetchTopics();
  populateTopicDropdown();
  await initApp();
  await loadMeetings();
  setupEventListeners();
  setupGlobalSearch();
});

function setupFilterDropdowns() {
  const sections = Array.from(document.querySelectorAll('.filter-section'));
  if (sections.length === 0) return;

  sections.forEach(section => {
    const clickZone = section.querySelector('.filter-click-zone');
    if (!clickZone || clickZone.dataset.bound === 'true') return;

    const toggleSection = (event) => {
      event.stopPropagation();
      const shouldOpen = !section.classList.contains('menu-open');
      sections.forEach(item => item.classList.remove('menu-open'));
      if (shouldOpen) section.classList.add('menu-open');
    };

    clickZone.addEventListener('click', (event) => {
      if (event.target.closest('.selected-topic-pill:not(.static), .selected-city-pill:not(.static)')) return;
      toggleSection(event);
    });

    const menu = section.querySelector('.filter-menu');
    if (menu) {
      menu.addEventListener('click', (event) => {
        event.stopPropagation();
      });
    }

    clickZone.dataset.bound = 'true';
  });

  document.addEventListener('click', () => {
    sections.forEach(section => section.classList.remove('menu-open'));
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      sections.forEach(section => section.classList.remove('menu-open'));
    }
  });
}

async function initApp() {
  currentUser = typeof window.getCurrentUser === 'function'
    ? await window.getCurrentUser()
    : await api.request('/api/auth/me');
  currentProfile = currentUser || null;
  updateUserUI(currentUser);

  loadFilters();
  loadCitiesFromDatabase();
  setupFilterDropdowns();
}

function updateUserUI(user) {
  const authButton = document.getElementById('auth-button');
  const myEventsButton = document.getElementById('my-events-button');
  const chatButton = document.getElementById('chat-button');
  const userName = document.getElementById('user-name');
  const userAvatar = document.getElementById('user-avatar');
  const userLink = document.getElementById('user-link');
  const createBtn = document.getElementById('create-meeting-btn');

  if (user) {
    if (currentProfile?.role === 'banned') {
      if (authButton) authButton.style.display = 'none';
      if (myEventsButton) myEventsButton.style.display = 'none';
      if (chatButton) chatButton.style.display = 'none';
      if (createBtn) createBtn.href = '#';
      if (userName) userName.textContent = 'Аккаунт заблокирован';
      if (userAvatar) {
        userAvatar.innerHTML = `<img src="${DEFAULT_AVATAR}" alt="Заблокирован">`;
        userAvatar.className = 'user-avatar';
      }
      const feed = document.getElementById('meetings-feed');
      if (feed) {
        feed.innerHTML = `
          <div class="empty-state">
            <h3>Ваш аккаунт заблокирован</h3>
            <p>Вы не можете создавать встречи, участвовать в них или общаться с другими пользователями.</p>
          </div>
        `;
      }
      return;
    }

    if (authButton) authButton.style.display = 'none';
    if (myEventsButton) {
      myEventsButton.style.display = 'flex';
      myEventsButton.href = 'my-events.html';
    }
    if (chatButton) chatButton.style.display = 'flex';
    if (userName) userName.textContent = currentProfile?.username || user.email?.split('@')[0] || 'Пользователь';
    if (userAvatar) {
      const avatarUrl = currentProfile?.photo_URL && currentProfile?.photo_URL !== 'user'
        ? currentProfile.photo_URL
        : DEFAULT_AVATAR;
      userAvatar.innerHTML = `<img src="${avatarUrl}" alt="${userName ? userName.textContent : ''}" onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}';">`;
      userAvatar.className = 'user-avatar authenticated';
    }
    if (createBtn) createBtn.href = 'create-meeting.html';
    if (userLink) {
      userLink.href = `profile.html?id=${user.id}`;
      userLink.style.cursor = 'pointer';
    }
    startChatBadgePolling();
    startMyEventsBadgePolling();
  } else {
    if (authButton) {
      authButton.style.display = 'flex';
      authButton.textContent = 'Войти';
      authButton.href = 'login.html';
    }
    if (myEventsButton) myEventsButton.style.display = 'none';
    if (chatButton) chatButton.style.display = 'none';
    if (userAvatar) {
      userAvatar.innerHTML = `<img src="${DEFAULT_AVATAR}" alt="Гость">`;
      userAvatar.className = 'user-avatar';
    }
    if (userName) userName.textContent = 'Гость';
    if (createBtn) createBtn.href = 'login.html';
    if (userLink) {
      userLink.href = '#';
      userLink.style.cursor = 'default';
      userLink.onclick = (e) => e.preventDefault();
    }
    stopChatBadgePolling();
    stopMyEventsBadgePolling();
  }
}

function loadFilters() {
  const container = document.getElementById('filter-tags');
  if (!container) return;

  container.innerHTML = '';

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Поиск интересов...';
  searchInput.className = 'topic-search-input';
  searchInput.style.display = 'block';
  searchInput.style.marginBottom = '8px';
  searchInput.addEventListener('input', (e) => filterTopicList(e.target.value));
  container.appendChild(searchInput);

  const allButton = document.createElement('button');
  allButton.className = 'filter-tag active';
  allButton.textContent = 'Все категории';
  allButton.onclick = (event) => filterMeetings('all', event);
  container.appendChild(allButton);

  const groups = typeof window.groupTopicsForDisplay === 'function'
    ? window.groupTopicsForDisplay(TOPICS)
    : [{ title: 'Категории', items: TOPICS }];

  groups.forEach(group => {
    const groupWrap = document.createElement('section');
    groupWrap.className = 'topic-filter-group';
    groupWrap.dataset.groupId = group.id || '';

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

    const options = document.createElement('div');
    options.className = 'topic-filter-options';
    options.hidden = true;

    group.items.forEach(topic => {
      const button = document.createElement('button');
      button.className = 'filter-tag topic-filter-option';
      const icon = typeof window.getTopicIcon === 'function' ? window.getTopicIcon(topic) : '';
      const label = typeof window.getTopicDisplayName === 'function'
        ? window.getTopicDisplayName(topic)
        : topic.name;
      button.innerHTML = `${icon ? `<span class="topic-filter-option-icon">${escapeHtml(icon)}</span>` : ''}<span>${escapeHtml(label)}</span>`;
      button.setAttribute('data-topic-id', topic.id);
      button.onclick = (event) => filterMeetings(topic.id, event);
      options.appendChild(button);
    });

    trigger.onclick = () => toggleTopicGroup(groupWrap);
    groupWrap.appendChild(trigger);
    groupWrap.appendChild(options);
    container.appendChild(groupWrap);
  });

  updateTopicFilterUI();
}

function setTopicGroupOpen(groupEl, isOpen) {
  const trigger = groupEl?.querySelector('.topic-filter-group-trigger');
  const options = groupEl?.querySelector('.topic-filter-options');
  if (!trigger || !options) return;
  groupEl.classList.toggle('open', Boolean(isOpen));
  trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  options.hidden = !isOpen;
}

function toggleTopicGroup(groupEl) {
  if (!groupEl) return;
  const shouldOpen = !groupEl.classList.contains('open');
  setTopicGroupOpen(groupEl, shouldOpen);
}

function filterTopicList(searchTerm) {
  const container = document.getElementById('filter-tags');
  if (!container) return;
  const normalized = String(searchTerm || '').toLowerCase();

  const allButton = container.querySelector('.filter-tag:not([data-topic-id])');
  if (allButton) allButton.style.display = '';

  container.querySelectorAll('.topic-filter-group').forEach(group => {
    let visible = 0;
    group.querySelectorAll('.topic-filter-option').forEach(button => {
      const matches = button.textContent.toLowerCase().includes(normalized);
      button.style.display = matches ? '' : 'none';
      if (matches) visible += 1;
    });
    group.style.display = visible > 0 ? '' : 'none';
    setTopicGroupOpen(group, normalized ? visible > 0 : group.classList.contains('open'));
  });
}

function populateTopicDropdown() {
  const select = document.getElementById('meeting-topic');
  if (!select) return;

  while (select.options.length > 1) select.remove(1);

  const selectableTopics = typeof window.getSelectableTopics === 'function'
    ? window.getSelectableTopics(TOPICS)
    : TOPICS.filter(topic => !topic?.is_group);

  selectableTopics.forEach(topic => {
    const option = document.createElement('option');
    option.value = topic.id;
    option.textContent = typeof window.getTopicDisplayName === 'function'
      ? window.getTopicDisplayName(topic)
      : topic.name;
    select.appendChild(option);
  });
}

function loadCityFilters() {
  const container = document.getElementById('city-filter-list');
  if (!container) return;

  container.innerHTML = '';

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Поиск города...';
  searchInput.className = 'city-search-input';
  searchInput.addEventListener('input', (e) => filterCityList(e.target.value));
  container.appendChild(searchInput);

  const citiesList = document.createElement('ul');
  citiesList.className = 'city-filter-items';
  container.appendChild(citiesList);

  allCities.forEach(city => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `city-filter-tag${selectedCities.has(city) ? ' active' : ''}`;
    button.textContent = city;
    button.onclick = () => toggleCity(city);
    item.appendChild(button);
    citiesList.appendChild(item);
  });

  updateCityFilterUI();
}

function filterCityList(searchTerm) {
  const container = document.getElementById('city-filter-list');
  if (!container) return;
  const items = container.querySelectorAll('li');
  const term = String(searchTerm || '').toLowerCase();
  items.forEach(item => {
    const button = item.querySelector('.city-filter-tag');
    if (!button) return;
    item.style.display = button.textContent.toLowerCase().includes(term) ? 'list-item' : 'none';
  });
}

function toggleCity(city) {
  if (selectedCities.has(city)) selectedCities.delete(city);
  else selectedCities.add(city);
  updateCityFilterUI();
  renderFilteredMeetings();
}

function updateCityLabel() {
  return;
}

function renderSelectedCityPills() {
  const container = document.getElementById('selected-city-pills');
  if (!container) return;
  container.innerHTML = '';

  if (selectedCities.size === 0) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'selected-city-pill static';
    pill.textContent = 'Все города';
    container.appendChild(pill);
    return;
  }

  Array.from(selectedCities).forEach(city => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'selected-city-pill';
    pill.textContent = city;
    pill.addEventListener('click', () => removeSelectedCity(city));
    container.appendChild(pill);
  });
}

function updateCityFilterButtons() {
  document.querySelectorAll('.city-filter-tag').forEach(button => {
    button.classList.toggle('active', selectedCities.has(button.textContent));
  });
}

function removeSelectedCity(city) {
  if (!selectedCities.has(city)) return;
  selectedCities.delete(city);
  updateCityFilterUI();
  renderFilteredMeetings();
}

function updateCityFilterUI() {
  updateCityFilterButtons();
  updateCityLabel();
  renderSelectedCityPills();
}

async function loadMeetings() {
  const feed = document.getElementById('meetings-feed');
  if (feed) feed.innerHTML = '<div class="loading">Загрузка встреч...</div>';

  try {
    const nowIso = new Date().toISOString();
    const meetings = await api.request('/api/feed/meetings');
    const activeMeetings = (meetings || []).filter(meeting => meeting?.expires_at && meeting.expires_at > nowIso);

    if (!activeMeetings || activeMeetings.length === 0) {
      allMeetings = [];
      loadCityFilters();
      renderEmptyState();
      return;
    }

    const uniqueMeetings = Array.from(new Map(activeMeetings.map(m => [m.id, m])).values());

    // If user just created a meeting and returned to the feed, ensure it shows up.
    // This also helps debug cases where the list query filters it out unexpectedly.
    let lastCreatedId = null;
    try {
      lastCreatedId = localStorage.getItem('last_created_meeting_id');
    } catch (_e) { /* ignore */ }
    if (lastCreatedId && !uniqueMeetings.some(m => String(m.id) === String(lastCreatedId))) {
      try {
        const created = await api.getOne(TABLES.meetings, lastCreatedId);
        if (created && created.expires_at && new Date(created.expires_at).toISOString() > nowIso) {
          uniqueMeetings.unshift(created);
        }
      } catch (_e) { /* ignore */ }
    }
    try {
      if (lastCreatedId) localStorage.removeItem('last_created_meeting_id');
    } catch (_e) { /* ignore */ }

    allMeetings = uniqueMeetings;
    loadCityFilters();
    renderFilteredMeetings();
  } catch (error) {
    console.error('Ошибка загрузки встреч:', error);
    allMeetings = [];
    renderEmptyState();
  }
}

function renderEmptyState(message = 'Активных встреч пока нет') {
  const feed = document.getElementById('meetings-feed');
  if (!feed) return;
  feed.innerHTML = `
    <div class="empty-state">
      <h3 class="empty-state-title">${message}</h3>
      <p class="empty-state-description">
        Будьте первым, кто создаст встречу!<br>
        Соберите компанию для игры, спорта или просто общения.
      </p>
      <button onclick="showCreateModal()" class="btn-primary">
        Создать встречу
      </button>
    </div>
  `;
}

function renderMeetings(meetings) {
  const feed = document.getElementById('meetings-feed');
  if (!feed) return;
  feed.innerHTML = '';

  meetings.forEach(meeting => {
    const topic = TOPICS.find(t => t.id === meeting.topic) || TOPICS[TOPICS.length - 1];
    const participantsCount = meeting.current_slots || 0;
    const creatorName = meeting.creator?.full_name || meeting.creator?.email?.split('@')[0] || 'Автор';
    const creatorAge = meeting.creator?.age ? `${meeting.creator.age} лет` : '';
    const creatorAvatar = meeting.creator?.photo_URL && meeting.creator?.photo_URL !== 'user'
      ? meeting.creator.photo_URL
      : DEFAULT_AVATAR;
    const topicIcon = typeof window.getTopicIcon === 'function' ? window.getTopicIcon(topic) : '';
    const topicLabel = topic ? `#${topicIcon ? `${topicIcon} ` : ''}${getTopicDisplayName(topic)}` : '#Встреча';
    const locationLabel = meeting.location || 'Город не указан';

    const countdownLabel = buildMeetingCountdownLabel(meeting.expires_at);
    const meetingCard = document.createElement('div');
    meetingCard.className = 'meeting-card';
    meetingCard.onclick = () => {
      window.location.href = `meeting.html?id=${meeting.id}`;
    };
    meetingCard.innerHTML = `
      <div class="meeting-topline">
        <div class="meeting-tag" style="background: ${topic.color}20; color: ${topic.color};">${topicLabel}</div>
        <div class="meeting-location"><span class="location-icon" aria-hidden="true"></span>${locationLabel}</div>
      </div>
      <div class="meeting-thread">${meeting.title || meeting.headline || 'Новая встреча'}</div>
      <div class="meeting-meta">
        <div class="participants-pill">👥 ${participantsCount}/${meeting.max_slots}</div>
        <div class="creator-block">
           <div class="creator-avatar">
             <img src="${creatorAvatar}" alt="${creatorName}" onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}';">
           </div>
          <div>
            <div class="creator-name">${creatorName}</div>
            <div class="creator-age">${creatorAge}</div>
          </div>
        </div>
      </div>
      <div class="meeting-countdown">${escapeHtml(countdownLabel)}</div>
    `;
    feed.appendChild(meetingCard);
  });
}

function showCreateModal() {
  if (!currentUser) {
    window.location.href = 'login.html';
    return;
  }
  window.location.href = 'create-meeting.html';
}

function hideCreateModal() {
  const modal = document.getElementById('create-modal');
  if (modal) modal.style.display = 'none';
}

function filterMeetings(topicId, event) {
  if (event && event.target) event.target.blur();

  if (topicId === 'all') {
    selectedTopics.clear();
  } else {
    if (selectedTopics.has(topicId)) selectedTopics.delete(topicId);
    else selectedTopics.add(topicId);
  }

  updateTopicFilterUI();
  renderFilteredMeetings();
}

function setActiveFilterButtons() {
  document.querySelectorAll('#filter-tags .filter-tag').forEach(btn => {
    const topicId = btn.getAttribute('data-topic-id');
    if (!topicId) {
      btn.classList.toggle('active', selectedTopics.size === 0);
      return;
    }
    btn.classList.toggle('active', selectedTopics.has(topicId));
  });
}

function syncTopicGroupVisibility() {
  const groups = Array.from(document.querySelectorAll('#filter-tags .topic-filter-group'));

  groups.forEach(group => {
    const hasSelectedChild = Array.from(group.querySelectorAll('.topic-filter-option'))
      .some(button => selectedTopics.has(button.getAttribute('data-topic-id')));
    const shouldOpen = hasSelectedChild;
    setTopicGroupOpen(group, shouldOpen);
  });
}

function loadCitiesFromDatabase() {
  allCities = [...BASE_CITIES];
  loadCityFilters();
}

function renderFilteredMeetings() {
  let filtered = allMeetings;

  if (selectedTopics.size > 0) {
    filtered = filtered.filter(meeting => selectedTopics.has(meeting.topic));
  }

  if (selectedCities.size > 0) {
    filtered = filtered.filter(meeting => {
      if (!meeting.location) return false;
      const city = matchCityFromLocation(meeting.location);
      return city ? selectedCities.has(city) : false;
    });
  }

  if (filtered.length === 0) renderEmptyState('Встречи не найдены');
  else renderMeetings(filtered);
}

function updateFilterLabel() {
  const label = document.querySelector('.filter-current');
  if (!label) return;
  label.innerHTML = '';

  if (selectedTopics.size === 0) {
    const pill = document.createElement('div');
    pill.className = 'selected-topic-pill static';
    pill.textContent = 'Все интересы';
    label.appendChild(pill);
    return;
  }

  TOPICS.filter(topic => selectedTopics.has(topic.id)).forEach(topic => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'selected-topic-pill';
    pill.textContent = typeof window.getTopicDisplayName === 'function'
      ? window.getTopicDisplayName(topic)
      : topic.name.replace(/^\S+\s/, '');
    pill.addEventListener('click', () => removeSelectedTopic(topic.id));
    label.appendChild(pill);
  });
}

function renderSelectedTopicPills() {
  const container = document.getElementById('selected-topic-pills');
  if (!container) return;
  container.innerHTML = '';

  if (selectedTopics.size === 0) return;

  TOPICS.filter(topic => selectedTopics.has(topic.id)).forEach(topic => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'selected-topic-pill';
    pill.textContent = typeof window.getTopicDisplayName === 'function'
      ? window.getTopicDisplayName(topic)
      : topic.name.replace(/^\S+\s/, '');
    pill.addEventListener('click', () => removeSelectedTopic(topic.id));
    container.appendChild(pill);
  });
}

function removeSelectedTopic(topicId) {
  if (!selectedTopics.has(topicId)) return;
  selectedTopics.delete(topicId);
  updateTopicFilterUI();
  renderFilteredMeetings();
}

function updateTopicFilterUI() {
  setActiveFilterButtons();
  syncTopicGroupVisibility();
  updateFilterLabel();
  renderSelectedTopicPills();
}

async function joinMeeting(meetingId) {
  if (!currentUser) {
    showNotification('Сначала войдите в аккаунт', 'error');
    return;
  }

  if (currentProfile?.role === 'banned') {
    showNotification('Ваш аккаунт заблокирован. Вы не можете принимать участие в встречах', 'error');
    return;
  }

  try {
    const meeting = await api.getOne(TABLES.meetings, meetingId);
    if (!meeting) {
      showNotification('Встреча не найдена', 'error');
      return;
    }

    // If the backend schema supports approval flow (chat_members.status),
    // joining should go through meeting chat requests instead of directly editing table-connector/slots.
    let chatMembersHasStatus = true;
    try {
      await api.get(TABLES.chat_members, { $limit: 1, status: 'approved' });
      chatMembersHasStatus = true;
    } catch (_e) {
      chatMembersHasStatus = false;
    }

    if (chatMembersHasStatus) {
      // Joining happens via chat_members (pending -> approved). Redirect user to the meeting page.
      if (!meeting.chat_id) {
        showNotification('Откройте встречу, чтобы отправить заявку', 'error');
        window.location.href = `meeting.html?id=${meetingId}`;
        return;
      }

      try {
        const existing = await api.get(TABLES.chat_members, { chat_id: meeting.chat_id, user_id: currentUser.id });
        if (existing && existing[0]) {
          showNotification(existing[0].status === 'pending' ? 'Заявка уже отправлена' : 'Вы уже в чате');
          window.location.href = `meeting.html?id=${meetingId}`;
          return;
        }
      } catch (_e) {}

      try {
        // Try full payload first; fallback to minimal schema.
        try {
          await api.insert(TABLES.chat_members, { chat_id: meeting.chat_id, user_id: currentUser.id, role: 'member', status: 'pending' });
        } catch (_e) {
          await api.insert(TABLES.chat_members, { chat_id: meeting.chat_id, user_id: currentUser.id });
        }
        showNotification('Заявка отправлена');
        window.location.href = `meeting.html?id=${meetingId}`;
        return;
      } catch (e) {
        console.error('Ошибка отправки заявки:', e);
        showNotification(e.message || 'Ошибка при записи на встречу', 'error');
        return;
      }
    }

    if (meeting.creator_id) {
      const isBlockedByCreator = await checkIfBlockedByUser(meeting.creator_id);
      if (isBlockedByCreator) {
        showNotification('Организатор встречи вас заблокировал', 'error');
        return;
      }
      const hasBlockedCreator = await hasCurrentUserBlocked(meeting.creator_id);
      if (hasBlockedCreator) {
        showNotification('Вы заблокировали организатора этой встречи', 'error');
        return;
      }
    }

    if ((meeting.current_slots || 0) >= (meeting.max_slots || 0)) {
      showNotification('К сожалению, места закончились', 'error');
      return;
    }

    const existing = await api.get(TABLES.participants, { meeting_id: meetingId, user_id: currentUser.id });
    if (existing && existing.length > 0) {
      showNotification('Вы уже участвуете в этой встрече', 'error');
      return;
    }

    await api.insert(TABLES.participants, { meeting_id: meetingId, user_id: currentUser.id });
    await api.update(TABLES.meetings, meetingId, { current_slots: (meeting.current_slots || 0) + 1 });

    const senderName = currentProfile?.full_name || currentProfile?.username || currentUser.email || 'Пользователь';
    if (meeting.creator_id && meeting.creator_id !== currentUser.id && typeof window.createUserNotification === 'function') {
      await window.createUserNotification(meeting.creator_id, {
        notification_type: 'event_joined_direct',
        related_table: 'meetings',
        related_id: meetingId,
        title: 'Новый участник встречи',
        message: `${senderName} присоединился к встрече «${meeting.title || 'Встреча'}».`
      });
    }

    if (meeting.chat_id) {
      await window.postChatSystemMessage?.(meeting.chat_id, `${senderName} присоединился к чату встречи`, currentUser.id);
    }

    showNotification('Вы присоединились к встрече!');
    loadMeetings();
  } catch (error) {
    console.error('Ошибка записи:', error);
    showNotification(error.message || 'Ошибка при записи на встречу', 'error');
  }
}

function showNotification(message, type = 'success') {
  const notification = document.getElementById('notification');
  if (!notification) return;
  notification.textContent = message;
  notification.style.background = type === 'success' ? '#10b981' : '#ef4444';
  notification.style.display = 'block';
  setTimeout(() => { notification.style.display = 'none'; }, 3000);
}

function setupEventListeners() {
  // no-op (kept for compatibility)
}

function matchCityFromLocation(location) {
  if (!location) return null;
  const normalized = location.trim().toLowerCase();
  const direct = BASE_CITIES.find(city => normalized.startsWith(city.toLowerCase()));
  if (direct) return direct;
  const firstPart = location.split(',')[0]?.trim();
  if (!firstPart) return null;
  const byFirst = BASE_CITIES.find(city => city.toLowerCase() === firstPart.toLowerCase());
  return byFirst || null;
}

window.showCreateModal = showCreateModal;
window.joinMeeting = joinMeeting;
window.filterMeetings = filterMeetings;

let chatBadgeInterval = null;
let myEventsBadgeInterval = null;

async function updateChatBadge() {
  const badge = document.getElementById('chat-badge');
  if (!badge || !currentUser) return;

  try {
    const UNREAD_KEY = 'pulse_chat_last_read';
    let readMap = {};
    try {
      const raw = localStorage.getItem(UNREAD_KEY);
      readMap = raw ? JSON.parse(raw) : {};
    } catch (e) { /* ignore */ }

    const perChatReadMap = {};
    Object.entries(readMap).forEach(([key, value]) => {
      const prefix = `${currentUser.id}:`;
      if (key.startsWith(prefix)) {
        perChatReadMap[key.slice(prefix.length)] = value;
      }
    });

    const summary = await api.request('/api/chats/unread-summary', {
      method: 'POST',
      body: JSON.stringify({ lastReadMap: perChatReadMap })
    });
    const total = Number(summary?.total || 0);

    if (total > 0) {
      badge.textContent = total > 99 ? '99+' : String(total);
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  } catch (e) {
    // ignore
  }
}

function startChatBadgePolling() {
  updateChatBadge();
  if (chatBadgeInterval) clearInterval(chatBadgeInterval);
  chatBadgeInterval = setInterval(updateChatBadge, 45000);
}

function stopChatBadgePolling() {
  if (chatBadgeInterval) {
    clearInterval(chatBadgeInterval);
    chatBadgeInterval = null;
  }
  const badge = document.getElementById('chat-badge');
  if (badge) badge.style.display = 'none';
}

async function updateMyEventsBadge() {
  const badge = document.getElementById('my-events-badge');
  if (!badge || !currentUser) return;

  try {
    const summary = await api.request('/api/my-events/notifications?limit=20');
    const rows = Array.isArray(summary?.notifications) ? summary.notifications : [];
    const total = rows.filter(item => item.is_read !== true).length;
    if (total > 0) {
      badge.textContent = total > 99 ? '99+' : String(total);
      badge.style.display = 'flex';
    } else {
      badge.style.display = 'none';
    }
  } catch (_e) {
    badge.style.display = 'none';
  }
}

function startMyEventsBadgePolling() {
  updateMyEventsBadge();
  if (myEventsBadgeInterval) clearInterval(myEventsBadgeInterval);
  myEventsBadgeInterval = setInterval(updateMyEventsBadge, 45000);
}

function stopMyEventsBadgePolling() {
  if (myEventsBadgeInterval) {
    clearInterval(myEventsBadgeInterval);
    myEventsBadgeInterval = null;
  }
  const badge = document.getElementById('my-events-badge');
  if (badge) badge.style.display = 'none';
}

async function checkIfBlockedByUser(otherUserId) {
  try {
    const profile = typeof window.getProfileCached === 'function'
      ? await window.getProfileCached(otherUserId)
      : await api.getOne(TABLES.profiles, otherUserId);
    const blockedUsers = Array.isArray(profile?.blocked_users) ? profile.blocked_users : [];
    return currentUser?.id ? blockedUsers.includes(currentUser.id) : false;
  } catch (e) {
    return false;
  }
}

async function hasCurrentUserBlocked(otherUserId) {
  if (!currentUser?.id) return false;
  try {
    const profile = typeof window.getProfileCached === 'function'
      ? await window.getProfileCached(currentUser.id)
      : await api.getOne(TABLES.profiles, currentUser.id);
    const blockedUsers = Array.isArray(profile?.blocked_users) ? profile.blocked_users : [];
    return blockedUsers.includes(otherUserId);
  } catch (e) {
    return false;
  }
}

function setupGlobalSearch() {
  const input = document.getElementById('global-search');
  const results = document.getElementById('search-results');
  if (!input || !results) return;

  let timer = null;
  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(q, results), 250);
  });
  input.addEventListener('blur', () => {
    setTimeout(() => { if (results) results.style.display = 'none'; }, 200);
  });
  input.addEventListener('focus', () => {
    if (results && results.childElementCount > 0) results.style.display = 'flex';
  });
}

async function runSearch(query, results) {
  if (!results) return;
  if (!query || query.length < 2) {
    results.style.display = 'none';
    results.innerHTML = '';
    return;
  }

  const [people, meetings] = await Promise.all([
    searchProfiles(query),
    Promise.resolve(searchMeetings(query))
  ]);

  results.innerHTML = '';
  if (people.length === 0 && meetings.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'search-subtitle';
    empty.textContent = 'Ничего не найдено';
    results.appendChild(empty);
    results.style.display = 'flex';
    return;
  }

  if (people.length > 0) {
    const title = document.createElement('div');
    title.className = 'search-section-title';
    title.textContent = 'Люди';
    results.appendChild(title);
    people.forEach(p => results.appendChild(renderProfileResult(p)));
  }

  if (meetings.length > 0) {
    const title = document.createElement('div');
    title.className = 'search-section-title';
    title.textContent = 'Встречи';
    results.appendChild(title);
    meetings.forEach(m => results.appendChild(renderMeetingResult(m)));
  }

  results.style.display = 'flex';
}

async function searchProfiles(query) {
  try {
    const data = await api.get(TABLES.profiles, {
      $or: [
        { username: { ilike: `%${query}%` } },
        { full_name: { ilike: `%${query}%` } }
      ],
      $limit: 5
    });
    return data || [];
  } catch (error) {
    console.error('Ошибка поиска профилей:', error);
    return [];
  }
}

function searchMeetings(query) {
  const term = query.toLowerCase();
  return allMeetings
    .filter(m => (m.title || m.headline || '').toLowerCase().includes(term))
    .slice(0, 5);
}

function renderProfileResult(profile) {
  const item = document.createElement('div');
  item.className = 'search-item';
  item.onclick = () => { window.location.href = `profile.html?id=${profile.id}`; };

  const avatarUrl = profile.photo_URL && profile.photo_URL !== 'user' ? profile.photo_URL : DEFAULT_AVATAR;
  const name = profile.full_name || profile.username || 'Пользователь';
  const age = profile.age ? `${profile.age} лет` : '';

  item.innerHTML = `
    <div class="search-avatar"><img src="${avatarUrl}" alt="${name}" onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}';"></div>
    <div>
      <div class="search-title">${name}</div>
      <div class="search-subtitle">${age}</div>
    </div>
  `;
  return item;
}

function renderMeetingResult(meeting) {
  const item = document.createElement('div');
  item.className = 'search-item';
  item.onclick = () => { window.location.href = `meeting.html?id=${meeting.id}`; };
  const title = meeting.title || meeting.headline || 'Встреча';
  item.innerHTML = `
    <div>
      <div class="search-title">${title}</div>
      <div class="search-subtitle">${meeting.location || ''}</div>
    </div>
  `;
  return item;
}
