const supabaseClient = window.APP?.supabase;
const { TABLES } = window.APP || {};
let isSubmitting = false;
let editingMeetingId = null;
const MAX_LIFETIME_HOURS = 24;
const TIME_STEP_MINUTES = 15;

document.addEventListener('DOMContentLoaded', async () => {
  console.log('create-meeting.js loaded');
  await populateTopicDropdown();
  await checkAuthOrRedirect();
  setupExpiresInputs();

  // Check if we're editing an existing meeting
  const urlParams = new URLSearchParams(window.location.search);
  const editId = urlParams.get('edit');
  if (editId) {
    editingMeetingId = editId;
    await loadMeetingForEdit(editId);
    const titleEl = document.querySelector('.title');
    if (titleEl) titleEl.textContent = 'Редактировать встречу';
    const submitBtn = document.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.textContent = 'Сохранить изменения';
  }

  document.getElementById('create-meeting-form').addEventListener('submit', handleCreateMeeting);
});

function setupExpiresInputs() {
  const dateInput = document.getElementById('meeting-expires-date');
  const timeSelect = document.getElementById('meeting-expires-time');
  if (!dateInput || !timeSelect) return;

  const now = new Date();
  const max = new Date(now.getTime() + MAX_LIFETIME_HOURS * 60 * 60 * 1000);
  dateInput.min = now.toISOString().slice(0, 10);
  dateInput.max = max.toISOString().slice(0, 10);
  if (!dateInput.value) {
    dateInput.value = now.toISOString().slice(0, 10);
  }

  const populateTimes = () => {
    timeSelect.innerHTML = '';
    const selectedDate = new Date(`${dateInput.value}T00:00:00`);
    const start = new Date(selectedDate);
    const end = new Date(selectedDate);

    if (dateInput.value === now.toISOString().slice(0, 10)) {
      start.setHours(now.getHours(), now.getMinutes(), 0, 0);
      const minutes = start.getMinutes();
      const rounded = Math.ceil(minutes / TIME_STEP_MINUTES) * TIME_STEP_MINUTES;
      start.setMinutes(rounded);
    } else {
      start.setHours(0, 0, 0, 0);
    }

    if (dateInput.value === max.toISOString().slice(0, 10)) {
      end.setHours(max.getHours(), max.getMinutes(), 0, 0);
    } else {
      end.setHours(23, 59, 0, 0);
    }

    if (end < start) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Нет доступного времени';
      timeSelect.appendChild(option);
      timeSelect.disabled = true;
      return;
    }

    timeSelect.disabled = false;
    const cursor = new Date(start);
    while (cursor <= end) {
      const hours = String(cursor.getHours()).padStart(2, '0');
      const mins = String(cursor.getMinutes()).padStart(2, '0');
      const value = `${hours}:${mins}`;
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value;
      timeSelect.appendChild(option);
      cursor.setMinutes(cursor.getMinutes() + TIME_STEP_MINUTES);
    }
  };

  populateTimes();
  dateInput.addEventListener('change', populateTimes);
}

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
  const city = document.getElementById('meeting-city').value.trim();
  const details = document.getElementById('meeting-details').value.trim();
  const dateValue = document.getElementById('meeting-expires-date')?.value;
  const timeValue = document.getElementById('meeting-expires-time')?.value;

  if (!headline || !topic || !maxSlots || !city || !details || !dateValue || !timeValue) {
    showNotification('Заполните все обязательные поля');
    return;
  }

  const now = new Date();
  const expires = new Date(`${dateValue}T${timeValue}:00`);
  const diffMs = expires.getTime() - now.getTime();
  if (Number.isNaN(expires.getTime()) || diffMs <= 0) {
    showNotification('Выберите корректное время жизни');
    return;
  }
  if (diffMs > MAX_LIFETIME_HOURS * 60 * 60 * 1000) {
    showNotification('Можно выбрать только в пределах 24 часов');
    return;
  }

  const meetingData = {
    title: headline,
    full_description: details,
    topic: topic,
    location: city,
    max_slots: maxSlots,
    expires_at: expires.toISOString()
  };

  // Update existing meeting or create new one
  if (editingMeetingId) {
    updateMeetingInDb(editingMeetingId, meetingData);
  } else {
    createMeetingInDb(meetingData);
  }
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

    // Create chat for this meeting
    console.log('Creating chat for meeting:', data.id);
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
      console.error('❌ Ошибка создания чата:', chatError);
      console.error('   Full error:', JSON.stringify(chatError, null, 2));
      console.error('   Error code:', chatError.code);
      console.error('   Error message:', chatError.message);
      console.error('   Error status:', chatError.status);
      // Don't throw - meeting was already created
    } else if (chatData?.id) {
      console.log('✅ Chat created:', chatData.id);
      
      // Add creator to chat members
      const { error: memberError } = await supabaseClient
        .from(TABLES.chat_members)
        .insert([{ chat_id: chatData.id, user_id: user.id, role: 'owner', status: 'approved' }]);

      if (memberError) {
        console.error('❌ Ошибка добавления владельца в чат:', memberError);
        console.error('   Error details:', JSON.stringify(memberError, null, 2));
      } else {
        console.log('✅ Creator added to chat members');
      }

      // Update meeting with chat_id
      const { error: updateError } = await supabaseClient
        .from(TABLES.meetings)
        .update({ chat_id: chatData.id })
        .eq('id', data.id);

      if (updateError) {
        console.error('❌ Ошибка обновления chat_id в встрече:', updateError);
        console.error('   Error details:', JSON.stringify(updateError, null, 2));
      } else {
        console.log('✅ Meeting updated with chat_id');
      }
    } else {
      console.error('❌ Chat creation returned no data:', chatData);
    }

    showNotification('✅ Встреча опубликована!');
    setTimeout(() => {
      window.location.href = `meeting.html?id=${data.id}`;
    }, 600);
  } catch (error) {
    console.error('Ошибка создания встречи:', error);
    showNotification('Ошибка: ' + error.message);
  } finally {
    isSubmitting = false;
    const submitBtn = document.querySelector('#create-meeting-form .btn');
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function updateMeetingInDb(meetingId, payload) {
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

    console.log('Updating meeting:', meetingId, 'Payload:', payload);

    // Update the meeting
    const { data, error } = await supabaseClient
      .from(TABLES.meetings)
      .update({
        title: payload.title,
        full_description: payload.full_description,
        topic: payload.topic,
        location: payload.location,
        max_slots: payload.max_slots,
        expires_at: payload.expires_at
      })
      .eq('id', meetingId)
      .eq('creator_id', user.id)
      .select();

    if (error) {
      console.error('Update error:', error);
      throw error;
    }

    if (!data || data.length === 0) {
      console.error('No meeting was updated. Possible reasons: meeting not found, not the owner, or RLS policy issue');
      throw new Error('Не удалось обновить встречу. Возможно, у вас нет прав на редактирование.');
    }

    console.log('Meeting updated successfully:', data);
    showNotification('✅ Встреча обновлена!');
    setTimeout(() => {
      window.location.href = `meeting.html?id=${meetingId}`;
    }, 600);
  } catch (error) {
    console.error('Ошибка обновления встречи:', error);
    showNotification('Ошибка: ' + (error.message || 'Не удалось обновить встречу'));
  } finally {
    isSubmitting = false;
    const submitBtn = document.querySelector('#create-meeting-form .btn');
    if (submitBtn) submitBtn.disabled = false;
  }
}

async function loadMeetingForEdit(meetingId) {
  if (!supabaseClient) return;

  try {
    console.log('Loading meeting for edit:', meetingId);

    const { data: meeting, error } = await supabaseClient
      .from(TABLES.meetings)
      .select('*')
      .eq('id', meetingId)
      .single();

    if (error) {
      console.error('Error loading meeting:', error);
      throw error;
    }
    if (!meeting) {
      alert('Встреча не найдена');
      window.location.href = 'index.html';
      return;
    }

    console.log('Meeting loaded:', meeting);

    // Check if current user is the creator
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (meeting.creator_id !== user?.id) {
      alert('Вы не можете редактировать эту встречу');
      window.location.href = 'index.html';
      return;
    }

    // Pre-fill form fields
    document.getElementById('meeting-headline').value = meeting.title || '';
    document.getElementById('meeting-topic').value = meeting.topic || '';
    document.getElementById('meeting-max-slots').value = meeting.max_slots || 8;
    document.getElementById('meeting-city').value = meeting.location || '';
    document.getElementById('meeting-details').value = meeting.full_description || '';

    console.log('Form fields populated');

    // Set expiration date/time based on saved meeting
    if (meeting.expires_at) {
      const expiresDate = new Date(meeting.expires_at);
      const dateInput = document.getElementById('meeting-expires-date');
      const timeSelect = document.getElementById('meeting-expires-time');
      if (dateInput && timeSelect) {
        dateInput.value = expiresDate.toISOString().slice(0, 10);
        setupExpiresInputs();
        const hours = String(expiresDate.getHours()).padStart(2, '0');
        const minutes = String(expiresDate.getMinutes()).padStart(2, '0');
        timeSelect.value = `${hours}:${minutes}`;
      }
    }

  } catch (error) {
    console.error('Ошибка загрузки встречи:', error);
    alert('Ошибка загрузки встречи');
    window.location.href = 'index.html';
  }
}

