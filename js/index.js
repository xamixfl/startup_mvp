const supabaseClient = window.APP.supabase;
const { TABLES } = window.APP;

let currentUser = null;
let allMeetings = [];
let currentProfile = null;
const DEFAULT_AVATAR = 'assets/avatar.png';

// Topics and cities will be fetched from database
let TOPICS = [];

const selectedTopics = new Set();
const selectedCities = new Set();
let allCities = [];

document.addEventListener('DOMContentLoaded', async () => {
  TOPICS = await window.fetchTopics();
  populateTopicDropdown();
  await initApp();
  await loadMeetings();
  setupEventListeners();
});

async function initApp() {
  const { data: { user } } = await supabaseClient.auth.getUser();

  if (user) {
    currentUser = user;
    currentProfile = await fetchProfile(user.id);
    updateUserUI(user);
  }

  supabaseClient.auth.onAuthStateChange((event, session) => {
    if (session?.user) {
      currentUser = session.user;
      fetchProfile(session.user.id).then(profile => {
        currentProfile = profile;
        updateUserUI(session.user);
      });
      updateUserUI(session.user);
    } else {
      currentUser = null;
      currentProfile = null;
      updateUserUI(null);
    }
  });

  loadFilters();
  await loadCitiesFromDatabase();
  loadCityFilters();
}

function updateUserUI(user) {
  const authButton = document.getElementById('auth-button');
  const userName = document.getElementById('user-name');
  const userAvatar = document.getElementById('user-avatar');
  const createBtn = document.getElementById('create-meeting-btn');

  if (user) {
    authButton.textContent = 'Выйти';
    authButton.href = '#';
    authButton.onclick = (event) => {
      event.preventDefault();
      supabaseClient.auth.signOut();
    };

    const avatarUrl = currentProfile?.photo_URL && currentProfile?.photo_URL !== 'user'
      ? currentProfile.photo_URL
      : DEFAULT_AVATAR;
    userAvatar.innerHTML = `<img src="${avatarUrl}" alt="${userName.textContent}">`;
    userAvatar.className = 'user-avatar authenticated';
    userName.textContent = currentProfile?.username || user.email?.split('@')[0] || 'Пользователь';
    if (createBtn) createBtn.href = 'create-meeting.html';
    userName.style.cursor = 'pointer';
    userAvatar.style.cursor = 'pointer';
    userName.onclick = () => {
      window.location.href = `profile.html?id=${user.id}`;
    };
    userAvatar.onclick = () => {
      window.location.href = `profile.html?id=${user.id}`;
    };
  } else {
    authButton.textContent = 'Войти';
    authButton.href = 'login.html';
    authButton.onclick = null;
    userAvatar.innerHTML = `<img src="${DEFAULT_AVATAR}" alt="Гость">`;
    userAvatar.className = 'user-avatar';
    userName.textContent = 'Гость';
    if (createBtn) createBtn.href = 'login.html';
    userName.style.cursor = 'default';
    userAvatar.style.cursor = 'default';
    userName.onclick = null;
    userAvatar.onclick = null;
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
  const items = container.querySelectorAll('li');
  
  items.forEach(item => {
    const button = item.querySelector('.filter-tag');
    if (button.textContent === 'Все категории') {
      item.style.display = 'list-item';
    } else {
      const matches = button.textContent.toLowerCase().includes(searchTerm.toLowerCase());
      item.style.display = matches ? 'list-item' : 'none';
    }
  });
}

function populateTopicDropdown() {
  const select = document.getElementById('meeting-topic');
  if (!select) return;
  
  // Clear existing options except the first one (placeholder)
  while (select.options.length > 1) {
    select.remove(1);
  }
  
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
  citiesList.id = 'cities-list';
  citiesList.style.marginTop = '8px';
  citiesList.style.listStyle = 'none';
  
  const allItem = document.createElement('li');
  const allButton = document.createElement('button');
  allButton.className = 'filter-tag active';
  allButton.textContent = 'Все города';
  allButton.onclick = (event) => filterByCity('all', event);
  allItem.appendChild(allButton);
  citiesList.appendChild(allItem);

  const uniqueCities = Array.from(new Set(allCities))
    .filter(Boolean)
    .sort();

  uniqueCities.forEach(city => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'filter-tag city-option';
    button.textContent = city;
    button.setAttribute('data-city', city);
    button.onclick = (event) => filterByCity(city, event);
    item.appendChild(button);
    citiesList.appendChild(item);
  });

  container.appendChild(citiesList);
  updateCityLabel();
}

function filterCityList(searchTerm) {
  const listItems = document.querySelectorAll('.city-option');
  const term = searchTerm.toLowerCase();
  
  listItems.forEach(item => {
    const cityName = item.getAttribute('data-city').toLowerCase();
    if (cityName.includes(term)) {
      item.parentElement.style.display = '';
    } else {
      item.parentElement.style.display = 'none';
    }
  });
}

function filterByCity(city, event) {
  if (city === 'all') {
    selectedCities.clear();
    setActiveCityButton('all');
    updateCityLabel();
    renderFilteredMeetings();
    return;
  }

  const allButton = document.querySelector('#city-filter-list .filter-tag');
  if (allButton) allButton.classList.remove('active');

  if (selectedCities.has(city)) {
    selectedCities.delete(city);
  } else {
    selectedCities.add(city);
  }

  if (selectedCities.size === 0) {
    setActiveCityButton('all');
  } else if (event?.target) {
    event.target.classList.toggle('active');
  }

  updateCityLabel();
  renderFilteredMeetings();
}

function setActiveCityButton(city) {
  document.querySelectorAll('#city-filter-list .filter-tag').forEach(btn => {
    btn.classList.remove('active');
  });
  if (city === 'all') {
    const allButton = document.querySelector('#city-filter-list .filter-tag:first-of-type');
    if (allButton) allButton.classList.add('active');
  }
}

function updateCityLabel() {
  const label = document.querySelector('.city-filter-current');
  if (!label) return;

  if (selectedCities.size === 0) {
    label.textContent = 'Все города';
    return;
  }

  const cities = Array.from(selectedCities);
  if (cities.length <= 2) {
    label.textContent = cities.join(', ');
  } else {
    label.textContent = `${cities.slice(0, 2).join(', ')} +${cities.length - 2}`;
  }
}

async function loadMeetings() {
  const feed = document.getElementById('meetings-feed');
  feed.innerHTML = '<div class="loading">Загрузка встреч...</div>';

  try {
    const { data: meetings, error } = await supabaseClient
      .from(TABLES.meetings)
      .select('*')
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (error) throw error;

    if (!meetings || meetings.length === 0) {
      allMeetings = [];
      await loadCitiesFromDatabase();
      renderEmptyState();
    } else {
      const meetingsWithCreators = await attachCreators(meetings);
      allMeetings = meetingsWithCreators;
      await loadCitiesFromDatabase();
      renderFilteredMeetings();
    }
  } catch (error) {
    console.error('Ошибка загрузки встреч:', error);
    allMeetings = [];
    renderEmptyState();
  }
}

function renderEmptyState(message = 'Активных встреч пока нет') {
  const feed = document.getElementById('meetings-feed');
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
            <img src="${creatorAvatar}" alt="${creatorName}">
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
  if (creatorIds.length === 0) {
    return meetings.map(m => ({ ...m, creator: null }));
  }

  const { data: profiles, error } = await supabaseClient
    .from(TABLES.profiles)
    .select('id, full_name, age, photo_URL, email')
    .in('id', creatorIds);

  if (error || !profiles) {
    return meetings.map(m => ({ ...m, creator: null }));
  }

  const byId = new Map(profiles.map(p => [p.id, p]));
  return meetings.map(m => ({ ...m, creator: byId.get(m.creator_id) || null }));
}

function showCreateModal() {
  if (!currentUser) {
    window.location.href = 'login.html';
    return;
  }
  window.location.href = 'create-meeting.html';
}

function hideCreateModal() {
  document.getElementById('create-modal').style.display = 'none';
  document.getElementById('meeting-form').reset();
}

function filterMeetings(topicId, event) {
  if (topicId === 'all') {
    selectedTopics.clear();
    setActiveFilterButton('all');
    updateFilterLabel();
    renderFilteredMeetings();
    return;
  }

  const allButton = document.querySelector('#filter-tags .filter-tag');
  if (allButton) allButton.classList.remove('active');

  if (selectedTopics.has(topicId)) {
    selectedTopics.delete(topicId);
  } else {
    selectedTopics.add(topicId);
  }

  if (selectedTopics.size === 0) {
    setActiveFilterButton('all');
  } else if (event?.target) {
    event.target.classList.toggle('active');
  }

  updateFilterLabel();
  renderFilteredMeetings();
}

function setActiveFilterButton(topicId) {
  document.querySelectorAll('#filter-tags .filter-tag').forEach(btn => {
    btn.classList.remove('active');
  });

  if (topicId === 'all') {
    const allButton = document.querySelector('#filter-tags .filter-tag:first-of-type');
    if (allButton) allButton.classList.add('active');
    return;
  }

  const topic = TOPICS.find(t => t.id === topicId);
  if (!topic) return;
  document.querySelectorAll('#filter-tags .filter-tag').forEach(btn => {
    if (btn.textContent === topic.name) {
      btn.classList.add('active');
    }
  });
}

async function loadCitiesFromDatabase() {
  const citiesSet = new Set();

  try {
    // Load cities from meetings
    const { data: meetings, error: meetingsError } = await supabaseClient
      .from(TABLES.meetings)
      .select('location');

    if (!meetingsError && meetings) {
      meetings.forEach(m => {
        if (m.location) {
          const parts = m.location.split(',');
          let city = parts[parts.length - 1].trim();
          if (city && city.length > 0) {
            city = city.charAt(0).toUpperCase() + city.slice(1);
            citiesSet.add(city);
          }
        }
      });
    }

    // Load cities from profiles
    const { data: profiles, error: profilesError } = await supabaseClient
      .from(TABLES.profiles)
      .select('location');

    if (!profilesError && profiles) {
      profiles.forEach(p => {
        if (p.location) {
          const parts = p.location.split(',');
          let city = parts[parts.length - 1].trim();
          if (city && city.length > 0) {
            city = city.charAt(0).toUpperCase() + city.slice(1);
            citiesSet.add(city);
          }
        }
      });
    }
  } catch (error) {
    console.error('Ошибка загрузки городов:', error);
  }

  allCities = Array.from(citiesSet).sort();
  loadCityFilters();
}

function renderFilteredMeetings() {
  let filtered = allMeetings;

  // Filter by topics
  if (selectedTopics.size > 0) {
    filtered = filtered.filter(meeting => selectedTopics.has(meeting.topic));
  }

  // Filter by cities
  if (selectedCities.size > 0) {
    filtered = filtered.filter(meeting => {
      if (!meeting.location) return false;
      const parts = meeting.location.split(',');
      let city = parts[parts.length - 1].trim();
      // Capitalize first letter to match BASE_CITIES format
      city = city.charAt(0).toUpperCase() + city.slice(1);
      return selectedCities.has(city);
    });
  }

  if (filtered.length === 0) {
    renderEmptyState('Встречи не найдены');
  } else {
    renderMeetings(filtered);
  }
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

  if (names.length <= 2) {
    label.textContent = names.join(', ');
  } else {
    label.textContent = `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
  }
}

async function joinMeeting(meetingId) {
  if (!currentUser) {
    showNotification('Сначала войдите в аккаунт', 'error');
    return;
  }

  try {
    const { data: meeting } = await supabaseClient
      .from('meetings')
      .select('current_slots, max_slots')
      .eq('id', meetingId)
      .single();

    if (!meeting) {
      showNotification('Встреча не найдена', 'error');
      return;
    }

    if (meeting.current_slots >= meeting.max_slots) {
      showNotification('К сожалению, места закончились', 'error');
      return;
    }

    const { data: existing } = await supabaseClient
      .from(TABLES.participants)
      .select('id')
      .eq('meeting_id', meetingId)
      .eq('user_id', currentUser.id)
      .single();

    if (existing) {
      showNotification('Вы уже участвуете в этой встрече', 'error');
      return;
    }

    const { error: participantError } = await supabaseClient
      .from(TABLES.participants)
      .insert([{ meeting_id: meetingId, user_id: currentUser.id }]);

    if (participantError) throw participantError;

    const { error: meetingError } = await supabaseClient
      .from('meetings')
      .update({ current_slots: meeting.current_slots + 1 })
      .eq('id', meetingId);

    if (meetingError) throw meetingError;

    showNotification('Вы присоединились к встрече!');
    loadMeetings();
  } catch (error) {
    console.error('Ошибка записи:', error);
    showNotification('Ошибка при записи на встречу', 'error');
  }
}

function showNotification(message, type = 'success') {
  const notification = document.getElementById('notification');
  notification.textContent = message;
  notification.style.background = type === 'success' ? '#10b981' : '#ef4444';
  notification.style.display = 'block';

  setTimeout(() => {
    notification.style.display = 'none';
  }, 3000);
}

function getLocalMeetings() {
  const raw = localStorage.getItem('meetup_meetings');
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (error) {
    return [];
  }
}

function setupEventListeners() {
  // no-op for now
}

window.showCreateModal = showCreateModal;
window.joinMeeting = joinMeeting;
window.filterMeetings = filterMeetings;

async function fetchProfile(userId) {
  try {
    const { data } = await supabaseClient
      .from(TABLES.profiles)
      .select('id, username, full_name, age, photo_URL, email')
      .eq('id', userId)
      .single();
    return data || null;
  } catch (error) {
    console.error('Ошибка загрузки профиля:', error);
    return null;
  }
}
