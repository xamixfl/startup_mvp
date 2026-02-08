document.addEventListener('DOMContentLoaded', () => {
  setExpirationLimits();
  document.getElementById('create-meeting-form').addEventListener('submit', handleCreateMeeting);
});

function showNotification(message) {
  const notification = document.getElementById('notification');
  notification.textContent = message;
  notification.style.display = 'block';
  setTimeout(() => {
    notification.style.display = 'none';
  }, 3000);
}

function saveMeeting(meeting) {
  const raw = localStorage.getItem('meetup_meetings');
  const list = raw ? JSON.parse(raw) : [];
  list.unshift(meeting);
  localStorage.setItem('meetup_meetings', JSON.stringify(list));
}

function handleCreateMeeting(event) {
  event.preventDefault();

  const headline = document.getElementById('meeting-headline').value.trim();
  const topic = document.getElementById('meeting-topic').value;
  const maxSlots = parseInt(document.getElementById('meeting-max-slots').value);
  const expiresAt = document.getElementById('meeting-expires-at').value;
  const city = document.getElementById('meeting-city').value.trim();
  const details = document.getElementById('meeting-details').value.trim();

  if (!headline || !topic || !maxSlots || !expiresAt || !city || !details) {
    showNotification('Заполните все обязательные поля');
    return;
  }

  const now = new Date();
  const expiresDate = new Date(expiresAt);
  const diffHours = (expiresDate - now) / (1000 * 60 * 60);

  if (diffHours <= 0) {
    showNotification('Время жизни должно быть больше текущего времени');
    return;
  }

  if (diffHours > 24) {
    showNotification('Максимальный срок жизни встречи — 24 часа');
    return;
  }

  const meeting = {
    id: `m_${Date.now()}`,
    title: headline,
    full_description: details,
    topic: topic,
    location: city,
    max_slots: maxSlots,
    participants_count: 1,
    expires_at: expiresDate.toISOString(),
    creator: {
      name: 'Вы',
      age: null,
      avatar_url: ''
    }
  };

  saveMeeting(meeting);
  showNotification('Встреча опубликована');

  setTimeout(() => {
    window.location.href = `meeting.html?id=${meeting.id}`;
  }, 600);
}

function setExpirationLimits() {
  const input = document.getElementById('meeting-expires-at');
  const now = new Date();
  const maxDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const toLocalValue = (date) => {
    const pad = (num) => String(num).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  input.min = toLocalValue(now);
  input.max = toLocalValue(maxDate);
}
