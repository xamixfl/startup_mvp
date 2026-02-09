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
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  const name = params.get('name');

  if (!id && !name) {
    renderEmptyProfile();
    return;
  }

  const profile = await fetchProfile(id, name);
  if (!profile) {
    renderEmptyProfile();
    return;
  }

  renderProfile(profile);
  renderMeetings(profile);
});

const DEFAULT_AVATAR = 'assets/default-avatar.svg';

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

async function fetchProfile(id, name) {
  const supabaseClient = window.APP?.supabase;
  if (!supabaseClient) return null;

  try {
    if (id) {
      const { data, error } = await supabaseClient
        .from('profiles')
        .select('id, username, full_name, age, sex, location, photo_URL, interests')
        .eq('id', id)
        .single();
      if (error) throw error;
      return data;
    }

    if (name) {
      const { data, error } = await supabaseClient
        .from('profiles')
        .select('id, username, full_name, age, sex, location, photo_URL, interests')
        .eq('username', name)
        .maybeSingle();
      if (error) throw error;
      return data;
    }
  } catch (error) {
    console.error('Ошибка загрузки профиля:', error);
    return null;
  }

  return null;
}

function renderProfile(profile) {
  const avatar = document.getElementById('profile-avatar');
  const displayName = profile.full_name || profile.username || 'Пользователь';
  const avatarUrl = profile.photo_URL && profile.photo_URL !== 'user'
    ? profile.photo_URL
    : DEFAULT_AVATAR;
  avatar.innerHTML = `<img src="${avatarUrl}" alt="${displayName}">`;

  document.getElementById('profile-name').textContent = displayName;
  document.getElementById('profile-meta').textContent = profile.age ? `${profile.age} лет` : 'Возраст не указан';
  document.getElementById('profile-city').textContent = profile.location || 'Город не указан';

  const interestsWrap = document.getElementById('profile-interests');
  interestsWrap.innerHTML = '';
  (profile.interests || []).forEach(id => {
    const topic = TOPICS.find(item => item.id === id);
    const pill = document.createElement('div');
    pill.className = 'interest-pill';
    pill.textContent = topic ? topic.name : normalizeInterestLabel(id);
    interestsWrap.appendChild(pill);
  });
}

function normalizeInterestLabel(id) {
  const fallbackMap = {
    boardgames: '🎲 Настольные игры',
    tennis: '🎾 Теннис',
    football: '⚽ Футбол',
    running: '🏃 Бег',
    coffee: '☕ Кофе',
    cinema: '🎬 Кино',
    language: '🗣️ Языковая практика',
    hiking: '🥾 Походы',
    music: '🎵 Музыка',
    photography: '📷 Фотография'
  };

  if (fallbackMap[id]) return fallbackMap[id];
  return id;
}

function renderMeetings(profile) {
  const list = document.getElementById('meeting-list');
  list.innerHTML = '';

  fetchMeetingsForProfile(profile, list);
}

function renderEmptyProfile() {
  document.getElementById('profile-name').textContent = 'Профиль не найден';
  document.getElementById('profile-meta').textContent = '';
  document.getElementById('profile-city').textContent = '';
  document.getElementById('profile-interests').innerHTML = '';
  const list = document.getElementById('meeting-list');
  list.innerHTML = '';
  const empty = document.createElement('div');
  empty.style.color = '#94a3b8';
  empty.textContent = 'Нет данных профиля';
  list.appendChild(empty);
}

async function fetchMeetingsForProfile(profile, list) {
  const supabaseClient = window.APP?.supabase;
  if (!supabaseClient || !profile?.id) {
    renderMeetingsEmpty(list);
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from('meetings')
      .select('id, title, topic, location, max_slots, current_slots')
      .eq('creator_id', profile.id)
      .order('created_at', { ascending: false });

    if (error || !data || data.length === 0) {
      renderMeetingsEmpty(list);
      return;
    }

    data.forEach(meeting => {
      const topic = TOPICS.find(item => item.id === meeting.topic) || TOPICS[TOPICS.length - 1];
      const item = document.createElement('div');
      item.className = 'meeting-item';
      item.onclick = () => {
        window.location.href = `meeting.html?id=${meeting.id}`;
      };
      item.innerHTML = `
        <div class="meeting-tag">#${topic.name.replace(/^(\S+)\s/, '')}</div>
        <div class="meeting-headline">${meeting.title || 'Без названия'}</div>
        <div class="meeting-info">
          <span>👥 ${meeting.current_slots || 0}/${meeting.max_slots || 0}</span>
          <span>📍 ${meeting.location || 'Город не указан'}</span>
        </div>
      `;
      list.appendChild(item);
    });
  } catch (error) {
    console.error('Ошибка загрузки встреч профиля:', error);
    renderMeetingsEmpty(list);
  }
}

function renderMeetingsEmpty(list) {
  const empty = document.createElement('div');
  empty.style.color = '#94a3b8';
  empty.textContent = 'Пока нет запланированных встреч';
  list.appendChild(empty);
}

