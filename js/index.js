const { TABLES } = window.APP || {};

let currentUser = null;
let allMeetings = [];
let currentProfile = null;
const DEFAULT_AVATAR = 'assets/avatar.png';

let TOPICS = [];

const selectedTopics = new Set();
const selectedCities = new Set();
let allCities = [];

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
  await window.cleanupExpiredMeetings();
  await loadMeetings();
  setupEventListeners();
  setupGlobalSearch();
});

async function initApp() {
  currentUser = typeof window.getCurrentUser === 'function'
    ? await window.getCurrentUser()
    : await api.request('/api/auth/me');
  currentProfile = currentUser || null;
  updateUserUI(currentUser);

  loadFilters();
  loadCitiesFromDatabase();
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
  }
}

function loadFilters() {
  const container = document.getElementById('filter-tags');
  if (!container) return;

  container.innerHTML = '';

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Поиск тем...';
  searchInput.className = 'topic-search-input';
  searchInput.style.display = 'block';
  searchInput.style.marginBottom = '8px';
  searchInput.addEventListener('input', (e) => filterTopicList(e.target.value));
  container.appendChild(searchInput);

  const allItem = document.createElement('li');
  const allButton = document.createElement('button');
  allButton.className = 'filter-tag active';
  allButton.textContent = 'Все категории';
  allButton.onclick = (event) => filterMeetings('all', event);
  allItem.appendChild(allButton);
  container.appendChild(allItem);

  TOPICS.forEach(topic => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'filter-tag';
    button.textContent = topic.name;
    button.setAttribute('data-topic-id', topic.id);
    button.onclick = (event) => filterMeetings(topic.id, event);
    item.appendChild(button);
    container.appendChild(item);
  });

  updateFilterLabel();
}

function filterTopicList(searchTerm) {
  const container = document.getElementById('filter-tags');
  if (!container) return;
  const items = container.querySelectorAll('li');

  items.forEach(item => {
    const button = item.querySelector('.filter-tag');
    if (!button) return;
    if (button.textContent === 'Все категории') {
      item.style.display = 'list-item';
      return;
    }
    const matches = button.textContent.toLowerCase().includes(String(searchTerm || '').toLowerCase());
    item.style.display = matches ? 'list-item' : 'none';
  });
}

function populateTopicDropdown() {
  const select = document.getElementById('meeting-topic');
  if (!select) return;

  while (select.options.length > 1) select.remove(1);

  TOPICS.forEach(topic => {
    const option = document.createElement('option');
    option.value = topic.id;
    option.textContent = topic.name;
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
    const label = document.createElement('label');
    label.className = 'city-filter-item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedCities.has(city);
    checkbox.onchange = () => toggleCity(city);

    const span = document.createElement('span');
    span.textContent = city;

    label.appendChild(checkbox);
    label.appendChild(span);
    item.appendChild(label);
    citiesList.appendChild(item);
  });

  updateCityLabel();
}

function filterCityList(searchTerm) {
  const container = document.getElementById('city-filter-list');
  if (!container) return;
  const items = container.querySelectorAll('li');
  const term = String(searchTerm || '').toLowerCase();
  items.forEach(item => {
    const label = item.querySelector('span');
    if (!label) return;
    item.style.display = label.textContent.toLowerCase().includes(term) ? 'list-item' : 'none';
  });
}

function toggleCity(city) {
  if (selectedCities.has(city)) selectedCities.delete(city);
  else selectedCities.add(city);
  updateCityLabel();
  renderFilteredMeetings();
}

function updateCityLabel() {
  const label = document.querySelector('.city-filter-current');
  if (!label) return;
  if (selectedCities.size === 0) {
    label.textContent = 'Все города';
    return;
  }
  const cities = Array.from(selectedCities);
  label.textContent = cities.length <= 2 ? cities.join(', ') : `${cities.slice(0, 2).join(', ')} +${cities.length - 2}`;
}

async function loadMeetings() {
  const feed = document.getElementById('meetings-feed');
  if (feed) feed.innerHTML = '<div class="loading">Загрузка встреч...</div>';

  try {
    const nowIso = new Date().toISOString();
    const meetings = await api.get(TABLES.meetings, {
      expires_at: { gt: nowIso },
      $order: { column: 'created_at', ascending: false }
    });

    if (!meetings || meetings.length === 0) {
      allMeetings = [];
      loadCityFilters();
      renderEmptyState();
      return;
    }

    const uniqueMeetings = Array.from(new Map(meetings.map(m => [m.id, m])).values());

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

    const meetingsWithCreators = await attachCreators(uniqueMeetings);
    allMeetings = meetingsWithCreators;
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
    const topicLabel = topic?.name ? `#${topic.name.replace(/^(\S+)\s/, '')}` : '#Встреча';
    const locationLabel = meeting.location || 'Город не указан';

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
    `;
    feed.appendChild(meetingCard);
  });
}

async function attachCreators(meetings) {
  const creatorIds = Array.from(new Set(meetings.map(m => m.creator_id).filter(Boolean)));
  if (creatorIds.length === 0) return meetings.map(m => ({ ...m, creator: null }));

  try {
    const profiles = await api.get(TABLES.profiles, { id: { in: creatorIds } });
    const byId = new Map((profiles || []).map(p => [p.id, p]));
    return meetings.map(m => ({ ...m, creator: byId.get(m.creator_id) || null }));
  } catch (e) {
    return meetings.map(m => ({ ...m, creator: null }));
  }
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

  setActiveFilterButton(topicId);
  updateFilterLabel();
  renderFilteredMeetings();
}

function setActiveFilterButton(topicId) {
  document.querySelectorAll('#filter-tags .filter-tag').forEach(btn => btn.classList.remove('active'));

  if (topicId === 'all') {
    const allButton = document.querySelector('#filter-tags .filter-tag:first-of-type');
    if (allButton) allButton.classList.add('active');
    return;
  }

  const topic = TOPICS.find(t => t.id === topicId);
  if (!topic) return;
  document.querySelectorAll('#filter-tags .filter-tag').forEach(btn => {
    if (btn.textContent === topic.name) btn.classList.add('active');
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

  if (selectedTopics.size === 0) {
    label.textContent = 'Все категории';
    return;
  }

  const names = TOPICS.filter(topic => selectedTopics.has(topic.id))
    .map(topic => topic.name.replace(/^\S+\s/, ''));
  label.textContent = names.length <= 2 ? names.join(', ') : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
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
        showNotification('Ошибка при записи на встречу', 'error');
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

    showNotification('Вы присоединились к встрече!');
    loadMeetings();
  } catch (error) {
    console.error('Ошибка записи:', error);
    showNotification('Ошибка при записи на встречу', 'error');
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

    const memberships = await api.get(TABLES.chat_members, {
      user_id: currentUser.id,
      status: 'approved'
    });
    if (!memberships || memberships.length === 0) {
      badge.style.display = 'none';
      return;
    }

    const chatIds = memberships.map(m => m.chat_id).filter(Boolean);
    let total = 0;

    for (const chatId of chatIds) {
      const readKey = `${currentUser.id}:${chatId}`;
      const lastRead = readMap[readKey];
      const filters = {
        chat_id: chatId,
        user_id: { neq: currentUser.id }
      };
      if (lastRead) filters.created_at = { gt: lastRead };
      const result = await api.query(TABLES.chat_messages, 'count', {}, filters);
      total += Number(result && result.count) || 0;
    }

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
  chatBadgeInterval = setInterval(updateChatBadge, 30000);
}

function stopChatBadgePolling() {
  if (chatBadgeInterval) {
    clearInterval(chatBadgeInterval);
    chatBadgeInterval = null;
  }
  const badge = document.getElementById('chat-badge');
  if (badge) badge.style.display = 'none';
}

async function checkIfBlockedByUser(otherUserId) {
  try {
    const profile = await api.getOne(TABLES.profiles, otherUserId);
    const blockedUsers = Array.isArray(profile?.blocked_users) ? profile.blocked_users : [];
    return currentUser?.id ? blockedUsers.includes(currentUser.id) : false;
  } catch (e) {
    return false;
  }
}

async function hasCurrentUserBlocked(otherUserId) {
  if (!currentUser?.id) return false;
  try {
    const profile = await api.getOne(TABLES.profiles, currentUser.id);
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
