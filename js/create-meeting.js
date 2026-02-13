const supabaseClient = window.APP?.supabase;
const { TABLES } = window.APP || {};

document.addEventListener('DOMContentLoaded', async () => {
  console.log('create-meeting.js loaded');
  await populateTopicDropdown();
  checkAuthOrRedirect();
  setExpirationLimits();
  document.getElementById('create-meeting-form').addEventListener('submit', handleCreateMeeting);
});

async function populateTopicDropdown() {
  const select = document.getElementById('meeting-topic');
  if (!select || !window.fetchTopics) return;
  
  const topics = await window.fetchTopics();
  topics.forEach(topic => {
    const option = document.createElement('option');
    option.value = topic.id;
    option.textContent = topic.name;
    select.appendChild(option);
  });
}

async function checkAuthOrRedirect() {
  const supabaseClient = window.APP?.supabase;
  if (!supabaseClient) return;
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    window.location.href = 'login.html';
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

function handleCreateMeeting(event) {
  event.preventDefault();
  if (!supabaseClient) {
    showNotification('Supabase не подключен');
    console.error('Supabase client missing in create-meeting.js');
    return;
  }

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

  createMeetingInDb({
    title: headline,
    full_description: details,
    topic: topic,
    location: city,
    max_slots: maxSlots,
    expires_at: expiresDate.toISOString()
  });
}

async function createMeetingInDb(payload) {
  if (!supabaseClient) return;
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    window.location.href = 'login.html';
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from(TABLES.meetings)
      .insert([{
        ...payload,
        creator_id: user.id,
        current_slots: 1
      }])
      .select()
      .single();

    if (error) throw error;

    if (TABLES?.participants) {
      await supabaseClient
        .from(TABLES.participants)
        .insert([{ meeting_id: data.id, user_id: user.id }]);
    }

    // Automatically add city to cities table
    if (payload.location && window.addCity) {
      await window.addCity(payload.location);
    }

    showNotification('Встреча опубликована');
    setTimeout(() => {
      window.location.href = `meeting.html?id=${data.id}`;
    }, 600);
  } catch (error) {
    console.error('Ошибка создания встречи:', error);
    showNotification(error.message || 'Ошибка создания встречи');
  }
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
