const supabaseClient = window.APP?.supabase;
const { TABLES } = window.APP || {};
let isSubmitting = false;

document.addEventListener('DOMContentLoaded', async () => {
  console.log('create-meeting.js loaded');
  await populateTopicDropdown();
  checkAuthOrRedirect();
  setupExpiresPicker();
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
  if (isSubmitting) return;
  if (!supabaseClient) {
    showNotification('Supabase не подключен');
    console.error('Supabase client missing in create-meeting.js');
    return;
  }

  const headline = document.getElementById('meeting-headline').value.trim();
  const topic = document.getElementById('meeting-topic').value;
  const maxSlots = parseInt(document.getElementById('meeting-max-slots').value);
  const expiresDate = document.getElementById('meeting-expires-date').value;
  const expiresTime = document.getElementById('meeting-expires-time').value;
  const city = document.getElementById('meeting-city').value.trim();
  const details = document.getElementById('meeting-details').value.trim();

  if (!headline || !topic || !maxSlots || !expiresDate || !expiresTime || !city || !details) {
    showNotification('Заполните все обязательные поля');
    return;
  }

  const now = new Date();
  const expires = new Date(`${expiresDate}T${expiresTime}`);
  const diffMs = expires - now;
  if (diffMs <= 0) {
    showNotification('Время жизни должно быть больше текущего времени');
    return;
  }
  if (diffMs > 24 * 60 * 60 * 1000) {
    showNotification('Максимальный срок жизни встречи — 24 часа');
    return;
  }

  createMeetingInDb({
    title: headline,
    full_description: details,
    topic: topic,
    location: city,
    max_slots: maxSlots,
    expires_at: expires.toISOString()
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
    isSubmitting = true;
    const submitBtn = document.querySelector('#create-meeting-form .btn');
    if (submitBtn) submitBtn.disabled = true;

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

    const { data: chatData, error: chatError } = await supabaseClient
      .from(TABLES.chats)
      .insert([{
        meeting_id: data.id,
        title: data.title || payload.title,
        owner_id: user.id
      }])
      .select()
      .single();

    if (chatError) {
      console.error('Ошибка создания чата:', chatError);
      throw chatError;
    }

    if (chatData?.id) {
      const { error: memberError } = await supabaseClient
        .from(TABLES.chat_members)
        .insert([{ chat_id: chatData.id, user_id: user.id, role: 'owner', status: 'approved' }]);
      if (memberError) {
        console.error('Ошибка добавления владельца в чат:', memberError);
        throw memberError;
      }

      const { error: updateError } = await supabaseClient
        .from(TABLES.meetings)
        .update({ chat_id: chatData.id })
        .eq('id', data.id);
      if (updateError) {
        console.error('Ошибка обновления chat_id в встрече:', updateError);
        throw updateError;
      }
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
  } finally {
    isSubmitting = false;
    const submitBtn = document.querySelector('#create-meeting-form .btn');
    if (submitBtn) submitBtn.disabled = false;
  }
}

function setupExpiresPicker() {
  const dateInput = document.getElementById('meeting-expires-date');
  const timeSelect = document.getElementById('meeting-expires-time');
  const hint = document.getElementById('expires-hint');
  if (!dateInput || !timeSelect) return;

  const now = new Date();
  const max = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  dateInput.min = toDateValue(now);
  dateInput.max = toDateValue(max);
  dateInput.value = toDateValue(now);

  const buildTimes = (dateStr) => {
    timeSelect.innerHTML = '';
    const date = new Date(`${dateStr}T00:00`);
    if (isNaN(date.getTime())) return;

    const start = new Date(now);
    const end = new Date(max);
    const dayStart = new Date(date);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const minTime = start > dayStart ? start : dayStart;
    const maxTime = end < dayEnd ? end : dayEnd;

    if (minTime > maxTime) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Нет доступного времени';
      timeSelect.appendChild(option);
      return;
    }

    const cursor = new Date(minTime);
    cursor.setMinutes(Math.ceil(cursor.getMinutes() / 5) * 5);
    cursor.setSeconds(0, 0);

    while (cursor <= maxTime) {
      const opt = document.createElement('option');
      opt.value = toTimeValue(cursor);
      opt.textContent = toTimeValue(cursor);
      timeSelect.appendChild(opt);
      cursor.setMinutes(cursor.getMinutes() + 5);
    }

    if (!timeSelect.value) {
      timeSelect.selectedIndex = 0;
    }
  };

  dateInput.addEventListener('change', () => buildTimes(dateInput.value));
  buildTimes(dateInput.value);

  if (hint) {
    hint.textContent = 'Можно выбрать только в пределах 24 часов.';
  }
}

function toDateValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toTimeValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
