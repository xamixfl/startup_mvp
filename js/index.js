const supabaseClient = window.APP.supabase;
const { TABLES } = window.APP;

let currentUser = null;
let allMeetings = [];
let currentProfile = null;
const DEFAULT_AVATAR = 'assets/default-avatar.svg';

const TOPICS = [
  { id: 'boardgames', name: '🎲 Настольные игры', color: '#8b5cf6' },
  { id: 'tennis', name: '🎾 Теннис', color: '#10b981' },
  { id: 'football', name: '⚽ Футбол', color: '#ef4444' },
  { id: 'running', name: '🏃 Бег', color: '#3b82f6' },
  { id: 'coffee', name: '☕ Кофе', color: '#f59e0b' },
  { id: 'cinema', name: '🎬 Кино', color: '#ec4899' },
  { id: 'language', name: '🗣️ Языковая практика', color: '#06b6d4' },
  { id: 'other', name: '🎭 Другое', color: '#64748b' }
];


document.addEventListener('DOMContentLoaded', async () => {
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
  container.innerHTML = '';

  const allButton = document.createElement('button');
  allButton.className = 'filter-tag active';
  allButton.textContent = 'Все встречи';
  allButton.onclick = () => filterMeetings('all');
  container.appendChild(allButton);

  TOPICS.forEach(topic => {
    const button = document.createElement('button');
    button.className = 'filter-tag';
    button.textContent = topic.name;
    button.onclick = () => filterMeetings(topic.id);
    container.appendChild(button);
  });
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
      renderEmptyState();
    } else {
      const meetingsWithCreators = await attachCreators(meetings);
      allMeetings = meetingsWithCreators;
      renderMeetings(meetingsWithCreators);
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

    const meetingCard = document.createElement('div');
    meetingCard.className = 'meeting-card';
    meetingCard.onclick = () => {
      window.location.href = `meeting.html?id=${meeting.id}`;
    };
    meetingCard.innerHTML = `
      <div class="meeting-tag" style="background: ${topic.color}20; color: ${topic.color};">${topicLabel}</div>
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

function filterMeetings(topicId) {
  document.querySelectorAll('.filter-tag').forEach(btn => {
    btn.classList.remove('active');
  });

  event.target.classList.add('active');
  if (topicId === 'all') {
    if (allMeetings.length === 0) {
      renderEmptyState();
    } else {
      renderMeetings(allMeetings);
    }
    return;
  }

  const filtered = allMeetings.filter(meeting => meeting.topic === topicId);
  if (filtered.length === 0) {
    renderEmptyState('Встречи не найдены');
  } else {
    renderMeetings(filtered);
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
