const TOPICS = [
  { id: 'boardgames', name: '🎲 Настольные игры', color: '#3b82f6' },
  { id: 'tennis', name: '🎾 Теннис', color: '#10b981' },
  { id: 'football', name: '⚽ Футбол', color: '#f97316' },
  { id: 'running', name: '🏃 Бег', color: '#6366f1' },
  { id: 'coffee', name: '☕ Кофе', color: '#8b5cf6' },
  { id: 'cinema', name: '🎬 Кино', color: '#ef4444' },
  { id: 'language', name: '🗣️ Языковая практика', color: '#14b8a6' },
  { id: 'hiking', name: '🥾 Походы', color: '#22c55e' },
  { id: 'music', name: '🎵 Музыка', color: '#eab308' },
  { id: 'photography', name: '📷 Фотография', color: '#0ea5e9' }
];

const DEMO_MEETINGS = [
  {
    id: 'demo-1',
    topic: 'boardgames',
    title: 'Ищем людей на настолки в субботу — будет лёгкий вечер и новые игры',
    description: 'Планируем вечер настолок на 3-4 часа. Возьмём пару кооперативов и классические игры. Если хочешь — принеси любимую игру, но это необязательно.',
    max_slots: 6,
    participants_count: 2,
    city: 'Москва, Хамовники',
    creator: { name: 'Алексей', age: 27, avatar_url: '' }
  }
];

document.addEventListener('DOMContentLoaded', () => {
  const meetingId = new URLSearchParams(window.location.search).get('id');
  const storedMeeting = meetingId ? getMeetingFromStorage(meetingId) : null;
  const meeting = storedMeeting || DEMO_MEETINGS.find(item => item.id === meetingId) || DEMO_MEETINGS[0];
  renderMeeting(meeting);

  document.getElementById('join-button').addEventListener('click', () => {
    showNotification('Запрос на участие отправлен');
  });
});

function getMeetingFromStorage(meetingId) {
  const raw = localStorage.getItem('meetup_meetings');
  if (!raw) return null;
  try {
    const list = JSON.parse(raw);
    return list.find(item => item.id === meetingId) || null;
  } catch (error) {
    return null;
  }
}

function renderMeeting(meeting) {
  const topic = TOPICS.find(item => item.id === meeting.topic) || TOPICS[0];
  const topicLabel = `#${topic.name.replace(/^(\S+)\s/, '')}`;

  document.getElementById('meeting-tag').textContent = topicLabel;
  document.getElementById('meeting-tag').style.background = `${topic.color}20`;
  document.getElementById('meeting-tag').style.color = topic.color;

  const cityEl = document.getElementById('meeting-city');
  if (meeting.city) {
    cityEl.textContent = `📍 ${meeting.city}`;
    cityEl.style.display = 'inline-flex';
  } else {
    cityEl.style.display = 'none';
  }

  document.getElementById('meeting-headline').textContent = meeting.title || 'Без названия';
  document.getElementById('meeting-details').textContent = meeting.description || 'Подробное описание появится позже.';

  const creatorName = meeting.creator?.name || 'Автор';
  const creatorAge = meeting.creator?.age ? `${meeting.creator.age} лет` : 'Возраст не указан';
  const avatarUrl = meeting.creator?.avatar_url || '';

  const avatarEl = document.getElementById('creator-avatar');
  if (avatarUrl) {
    avatarEl.innerHTML = `<img src="${avatarUrl}" alt="${creatorName}">`;
  } else {
    avatarEl.textContent = creatorName[0].toUpperCase();
  }

  const creatorLink = document.getElementById('creator-name');
  creatorLink.textContent = creatorName;
  creatorLink.href = `profile.html?name=${encodeURIComponent(creatorName)}`;

  document.getElementById('creator-age').textContent = creatorAge;
  document.getElementById('participants-info').textContent = `👥 ${meeting.participants_count || 0}/${meeting.max_slots || 0} участников`;
}

function showNotification(message) {
  const notification = document.getElementById('notification');
  notification.textContent = message;
  notification.style.display = 'block';
  setTimeout(() => {
    notification.style.display = 'none';
  }, 3000);
}
