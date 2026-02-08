const { supabase, TABLES } = window.APP;

let currentUser = null;

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

const DEMO_MEETINGS = [
  {
    id: 'demo-1',
    title: 'Ищем пару человек на вечер настолок — спокойно и без спешки',
    description: 'Будем играть в пару кооперативов и знакомиться. Можно прийти одному.',
    topic: 'boardgames',
    max_slots: 6,
    participants_count: 2,
    creator: { name: 'Алексей', age: 27, avatar_url: '' }
  }
];

document.addEventListener('DOMContentLoaded', async () => {
  await initApp();
  await loadMeetings();
  setupEventListeners();
});

async function initApp() {
  const { data: { user } } = await supabase.auth.getUser();

  if (user) {
    currentUser = user;
    updateUserUI(user);
  }

  supabase.auth.onAuthStateChange((event, session) => {
    if (session?.user) {
      currentUser = session.user;
      updateUserUI(session.user);
    } else {
      currentUser = null;
      updateUserUI(null);
    }
  });

  loadFilters();
}

function updateUserUI(user) {
  const authButton = document.getElementById('auth-button');
  const userName = document.getElementById('user-name');
  const userAvatar = document.getElementById('user-avatar');

  if (user) {
    authButton.textContent = 'Выйти';
    authButton.href = '#';
    authButton.onclick = (event) => {
      event.preventDefault();
      supabase.auth.signOut();
    };

    const letter = user.email?.[0]?.toUpperCase() || 'U';
    userAvatar.textContent = letter;
    userAvatar.className = 'user-avatar authenticated';
    userName.textContent = user.email?.split('@')[0] || 'Пользователь';
  } else {
    authButton.textContent = 'Войти';
    authButton.href = 'login.html';
    authButton.onclick = null;
    userAvatar.textContent = '👤';
    userAvatar.className = 'user-avatar';
    userName.textContent = 'Гость';
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
    const { data: meetings, error } = await supabase
      .from(TABLES.meetings)
      .select(`
        *,
        ${TABLES.participants}(count),
        creator:profiles(email, full_name, age, photo_URL)
      `)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });

    if (error) throw error;

    if (!meetings || meetings.length === 0) {
      renderEmptyState();
    } else {
      renderMeetings(meetings);
    }
  } catch (error) {
    console.error('Ошибка загрузки встреч:', error);
    const localMeetings = getLocalMeetings();
    if (localMeetings.length > 0) {
      renderMeetings(localMeetings);
      return;
    }
    renderMeetings(DEMO_MEETINGS);
  }
}

function renderEmptyState() {
  const feed = document.getElementById('meetings-feed');
  feed.innerHTML = `
    <div class="empty-state">
      <h3 class="empty-state-title">Активных встреч пока нет</h3>
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
    const participantsCount = meeting[TABLES.participants]?.[0]?.count || meeting.participants_count || 0;
    const creatorName = meeting.creator?.full_name || meeting.creator?.name || meeting.creator?.email?.split('@')[0] || 'Автор';
    const creatorAge = meeting.creator?.age ? `${meeting.creator.age} лет` : '';
    const creatorAvatar = meeting.creator?.photo_URL || meeting.creator?.avatar_url || '';
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
            ${creatorAvatar ? `<img src="${creatorAvatar}" alt="${creatorName}">` : creatorName[0].toUpperCase()}
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

function showCreateModal() {
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
  const topicName = topicId === 'all' ? 'Все встречи' : TOPICS.find(t => t.id === topicId)?.name;
  showNotification(`Фильтр: ${topicName}`);
}

async function joinMeeting(meetingId) {
  if (!currentUser) {
    showNotification('Сначала войдите в аккаунт', 'error');
    return;
  }

  try {
    const { data: meeting } = await supabase
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

    const { data: existing } = await supabase
      .from(TABLES.participants)
      .select('id')
      .eq('meeting_id', meetingId)
      .eq('user_id', currentUser.id)
      .single();

    if (existing) {
      showNotification('Вы уже участвуете в этой встрече', 'error');
      return;
    }

    const { error: participantError } = await supabase
      .from(TABLES.participants)
      .insert([{ meeting_id: meetingId, user_id: currentUser.id }]);

    if (participantError) throw participantError;

    const { error: meetingError } = await supabase
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

window.showCreateModal = showCreateModal;
window.joinMeeting = joinMeeting;
window.filterMeetings = filterMeetings;
