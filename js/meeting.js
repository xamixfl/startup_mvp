const supabaseClient = window.APP?.supabase;
const { TABLES } = window.APP || {};
const DEFAULT_AVATAR = 'assets/avatar.png';

// Topics will be fetched from database
let TOPICS = [];

document.addEventListener('DOMContentLoaded', async () => {
  TOPICS = await window.fetchTopics();
  const { data: { user } } = await supabaseClient.auth.getUser();
  const meetingId = new URLSearchParams(window.location.search).get('id');
  const storedMeeting = meetingId ? getMeetingFromStorage(meetingId) : null;
  const meeting = storedMeeting || (await fetchMeeting(meetingId));

  if (!meeting) {
    showNotification('Встреча не найдена');
    return;
  }

  renderMeeting(meeting, user);
  await setupChatState(meeting, user);

  document.getElementById('join-button').addEventListener('click', async () => {
    await requestJoin(meeting, user);
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

function renderMeeting(meeting, user) {
  const topic = TOPICS.find(item => item.id === meeting.topic) || TOPICS[0];
  const topicLabel = `#${topic.name.replace(/^(\S+)\s/, '')}`;

  document.getElementById('meeting-tag').textContent = topicLabel;
  document.getElementById('meeting-tag').style.background = `${topic.color}20`;
  document.getElementById('meeting-tag').style.color = topic.color;

  const cityEl = document.getElementById('meeting-city');
  if (meeting.location) {
    cityEl.innerHTML = `<span class="location-icon" aria-hidden="true"></span>${meeting.location}`;
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

async function setupChatState(meeting, user) {
  const statusCard = document.getElementById('join-status-card');
  const statusText = document.getElementById('join-status-text');
  const openBtn = document.getElementById('open-chat-btn');
  const leaveBtn = document.getElementById('leave-chat-btn');
  const requestsCard = document.getElementById('requests-card');
  const requestsList = document.getElementById('requests-list');

  if (!meeting.chat_id || !user) {
    if (statusCard) statusCard.style.display = 'none';
    if (requestsCard) requestsCard.style.display = 'none';
    return;
  }

  const { data: membership } = await supabaseClient
    .from(TABLES.chat_members)
    .select('id, role, status')
    .eq('chat_id', meeting.chat_id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (statusCard && statusText) {
    statusCard.style.display = 'block';
    if (!membership) {
      statusText.textContent = 'Вы не отправляли заявку.';
    } else if (membership.status === 'pending') {
      statusText.textContent = 'Заявка отправлена, ожидает одобрения.';
    } else if (membership.status === 'approved') {
      statusText.textContent = 'Вы участник чата.';
      if (openBtn) {
        openBtn.style.display = 'block';
        openBtn.onclick = () => {
          window.location.href = `chat.html?chat_id=${meeting.chat_id}`;
        };
      }
      if (leaveBtn) {
        leaveBtn.style.display = 'block';
        leaveBtn.onclick = async () => {
          await leaveChat(meeting, user);
        };
      }
    } else if (membership.status === 'rejected') {
      statusText.textContent = 'Заявка отклонена.';
    }
  }

  if (meeting.creator_id && meeting.creator_id === user.id) {
    const { data: pending } = await supabaseClient
      .from(TABLES.chat_members)
      .select('id, user_id, status')
      .eq('chat_id', meeting.chat_id)
      .eq('status', 'pending');

    if (requestsCard && requestsList) {
      requestsCard.style.display = 'block';
      requestsList.innerHTML = '';
      if (!pending || pending.length === 0) {
        requestsList.textContent = 'Нет заявок';
      } else {
        const userIds = pending.map(req => req.user_id).filter(Boolean);
        const { data: profiles } = await supabaseClient
          .from(TABLES.profiles)
          .select('id, full_name, username, age')
          .in('id', userIds);
        const byId = new Map((profiles || []).map(p => [p.id, p]));

        pending.forEach(req => {
          const profile = byId.get(req.user_id);
          const name = profile?.full_name || profile?.username || req.user_id;
          const age = profile?.age ? `, ${profile.age}` : '';
          const row = document.createElement('div');
          row.className = 'request-item';
          row.innerHTML = `
            <div><a href="profile.html?id=${req.user_id}">${name}${age}</a></div>
            <div class="request-actions">
              <button class="btn-approve">Одобрить</button>
              <button class="btn-reject">Отклонить</button>
            </div>
          `;
          row.querySelector('.btn-approve').onclick = async () => {
            await approveRequest(meeting, req.user_id);
          };
          row.querySelector('.btn-reject').onclick = async () => {
            await rejectRequest(meeting, req.user_id);
          };
          requestsList.appendChild(row);
        });
      }
    }
  }
}

async function requestJoin(meeting, user) {
  if (!user) {
    showNotification('Сначала войдите в аккаунт');
    return;
  }
  if (!meeting.chat_id) {
    showNotification('Чат не создан');
    return;
  }

  const { data: existing } = await supabaseClient
    .from(TABLES.chat_members)
    .select('id, status')
    .eq('chat_id', meeting.chat_id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (existing) {
    showNotification(existing.status === 'pending' ? 'Заявка уже отправлена' : 'Вы уже в чате');
    return;
  }

  const { error } = await supabaseClient
    .from(TABLES.chat_members)
    .insert([{ chat_id: meeting.chat_id, user_id: user.id, role: 'member', status: 'pending' }]);

  if (error) {
    showNotification('Ошибка отправки заявки');
    return;
  }
  showNotification('Заявка отправлена');
  await setupChatState(meeting, user);
}

async function approveRequest(meeting, userId) {
  const { error } = await supabaseClient
    .from(TABLES.chat_members)
    .update({ status: 'approved' })
    .eq('chat_id', meeting.chat_id)
    .eq('user_id', userId);

  if (error) {
    showNotification('Ошибка одобрения');
    return;
  }

  await supabaseClient
    .from(TABLES.meetings)
    .update({ current_slots: (meeting.current_slots || 0) + 1 })
    .eq('id', meeting.id);

  showNotification('Пользователь добавлен');
  await setupChatState(meeting, { id: meeting.creator_id });
}

async function rejectRequest(meeting, userId) {
  const { error } = await supabaseClient
    .from(TABLES.chat_members)
    .update({ status: 'rejected' })
    .eq('chat_id', meeting.chat_id)
    .eq('user_id', userId);

  if (error) {
    showNotification('Ошибка отклонения');
    return;
  }
  showNotification('Заявка отклонена');
  await setupChatState(meeting, { id: meeting.creator_id });
}

async function leaveChat(meeting, user) {
  const { error } = await supabaseClient
    .from(TABLES.chat_members)
    .delete()
    .eq('chat_id', meeting.chat_id)
    .eq('user_id', user.id);

  if (error) {
    showNotification('Ошибка выхода');
    return;
  }

  await supabaseClient
    .from(TABLES.meetings)
    .update({ current_slots: Math.max((meeting.current_slots || 1) - 1, 0) })
    .eq('id', meeting.id);

  showNotification('Вы вышли из чата');
  await setupChatState(meeting, user);
}

function showNotification(message) {
  const notification = document.getElementById('notification');
  notification.textContent = message;
  notification.style.display = 'block';
  setTimeout(() => {
    notification.style.display = 'none';
  }, 3000);
}

