const supabaseClient = window.APP?.supabase;
const { TABLES } = window.APP || {};
const DEFAULT_AVATAR = 'assets/default-avatar.svg';

// Topics will be fetched from database
let TOPICS = [];

document.addEventListener('DOMContentLoaded', async () => {
  TOPICS = await window.fetchTopics();
  const meetingId = new URLSearchParams(window.location.search).get('id');
  const storedMeeting = meetingId ? getMeetingFromStorage(meetingId) : null;
  const meeting = storedMeeting || (await fetchMeeting(meetingId));

  if (!meeting) {
    showNotification('Встреча не найдена');
    return;
  }

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
  if (meeting.location) {
    cityEl.textContent = `📍 ${meeting.location}`;
    cityEl.style.display = 'inline-flex';
  } else {
    cityEl.style.display = 'none';
  }

  document.getElementById('meeting-headline').textContent = meeting.title || 'Без названия';
  document.getElementById('meeting-details').textContent = meeting.full_description || 'Подробное описание появится позже.';

  const creatorName = meeting.creator?.full_name || meeting.creator?.username || 'Автор';
  const creatorAge = meeting.creator?.age ? `${meeting.creator.age} лет` : 'Возраст не указан';
  const avatarUrl = meeting.creator?.photo_URL && meeting.creator?.photo_URL !== 'user'
    ? meeting.creator.photo_URL
    : DEFAULT_AVATAR;

  const avatarEl = document.getElementById('creator-avatar');
  avatarEl.innerHTML = `<img src="${avatarUrl}" alt="${creatorName}">`;

  const creatorLink = document.getElementById('creator-name');
  creatorLink.textContent = creatorName;
  if (meeting.creator?.id) {
    creatorLink.href = `profile.html?id=${meeting.creator.id}`;
  } else {
    creatorLink.href = '#';
  }

  document.getElementById('creator-age').textContent = creatorAge;
  const currentSlots = meeting.current_slots || meeting.participants_count || 0;
  document.getElementById('participants-info').textContent = `👥 ${currentSlots}/${meeting.max_slots || 0} участников`;
}

async function fetchMeeting(meetingId) {
  if (!supabaseClient || !meetingId) return null;
  try {
    const { data: meeting, error } = await supabaseClient
      .from(TABLES.meetings)
      .select('*')
      .eq('id', meetingId)
      .single();

    if (error) throw error;
    if (!meeting) return null;

    if (meeting.creator_id) {
      const { data: creator } = await supabaseClient
        .from(TABLES.profiles)
        .select('id, username, full_name, age, photo_URL')
        .eq('id', meeting.creator_id)
        .single();
      return { ...meeting, creator };
    }

    return meeting;
  } catch (error) {
    console.error('Ошибка загрузки встречи:', error);
    return null;
  }
}

function showNotification(message) {
  const notification = document.getElementById('notification');
  notification.textContent = message;
  notification.style.display = 'block';
  setTimeout(() => {
    notification.style.display = 'none';
  }, 3000);
}

