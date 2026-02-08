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

const DEMO_PROFILES = [
  {
    id: 'demo-1',
    name: 'Алексей',
    age: 27,
    location: 'Москва, Хамовники',
    photo_URL: '',
    interests: ['boardgames', 'coffee', 'running']
  }
];

document.addEventListener('DOMContentLoaded', () => {
  const profile = getProfile();
  renderProfile(profile);
  renderMeetings(profile);
});

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

function getProfile() {
  const params = new URLSearchParams(window.location.search);
  const name = params.get('name');
  const id = params.get('id');

  let profile = null;
  if (id) {
    profile = DEMO_PROFILES.find(item => item.id === id) || null;
  }

  if (!profile && name) {
    profile = DEMO_PROFILES.find(item => item.name === name) || null;
  }

  if (!profile && name) {
    return {
      id: 'local',
      name: name,
      age: null,
      location: '',
      photo_URL: '',
      interests: []
    };
  }

  return profile || DEMO_PROFILES[0];
}

function renderProfile(profile) {
  const avatar = document.getElementById('profile-avatar');
  if (profile.photo_URL) {
    avatar.innerHTML = `<img src="${profile.photo_URL}" alt="${profile.name}">`;
  } else {
    avatar.textContent = profile.name[0].toUpperCase();
  }

  document.getElementById('profile-name').textContent = profile.name || 'Пользователь';
  document.getElementById('profile-meta').textContent = profile.age ? `${profile.age} лет` : 'Возраст не указан';
  document.getElementById('profile-city').textContent = profile.location || 'Город не указан';

  const interestsWrap = document.getElementById('profile-interests');
  interestsWrap.innerHTML = '';
  (profile.interests || []).forEach(id => {
    const topic = TOPICS.find(item => item.id === id);
    const pill = document.createElement('div');
    pill.className = 'interest-pill';
    pill.textContent = topic ? topic.name : id;
    interestsWrap.appendChild(pill);
  });
}

function renderMeetings(profile) {
  const list = document.getElementById('meeting-list');
  list.innerHTML = '';

  const meetings = getLocalMeetings().filter(meeting => {
    return meeting.creator?.name && meeting.creator.name === profile.name;
  });

  if (meetings.length === 0) {
    const empty = document.createElement('div');
    empty.style.color = '#94a3b8';
    empty.textContent = 'Пока нет запланированных встреч';
    list.appendChild(empty);
    return;
  }

  meetings.forEach(meeting => {
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
        <span>👥 ${meeting.participants_count || 0}/${meeting.max_slots || 0}</span>
        <span>📍 ${meeting.location || 'Город не указан'}</span>
      </div>
    `;
    list.appendChild(item);
  });
}

