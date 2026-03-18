const { TABLES } = window.APP || {};
const DEFAULT_AVATAR = 'assets/avatar.png';

let TOPICS = [];

document.addEventListener('DOMContentLoaded', async () => {
  TOPICS = await window.fetchTopics();
  const user = typeof window.getCurrentUser === 'function'
    ? await window.getCurrentUser()
    : await api.request('/api/auth/me');

  const meetingId = new URLSearchParams(window.location.search).get('id');
  const storedMeeting = meetingId ? getMeetingFromStorage(meetingId) : null;
  const meeting = storedMeeting || (await fetchMeeting(meetingId));

  if (!meeting) {
    showNotification('Встреча не найдена');
    return;
  }

  renderMeeting(meeting, user);
  await setupChatState(meeting, user);

  const joinBtn = document.getElementById('join-button');
  if (joinBtn) {
    joinBtn.addEventListener('click', async () => {
      await requestJoin(meeting, user);
    });
  }
});

function getMeetingFromStorage(meetingId) {
  const raw = localStorage.getItem('pulse_meetings');
  if (!raw) return null;
  try {
    const list = JSON.parse(raw);
    return (list || []).find(item => item.id === meetingId) || null;
  } catch (_e) {
    return null;
  }
}

function renderMeeting(meeting, _user) {
  const topic = TOPICS.find(item => item.id === meeting.topic) || TOPICS[0];
  const topicLabel = topic?.name ? `#${topic.name.replace(/^(\S+)\s/, '')}` : '#Встреча';

  const tagEl = document.getElementById('meeting-tag');
  if (tagEl) {
    tagEl.textContent = topicLabel;
    if (topic?.color) {
      tagEl.style.background = `${topic.color}20`;
      tagEl.style.color = topic.color;
    }
  }

  const cityEl = document.getElementById('meeting-city');
  if (cityEl) {
    if (meeting.location) {
      cityEl.innerHTML = `<span class="location-icon" aria-hidden="true"></span>${meeting.location}`;
      cityEl.style.display = 'inline-flex';
    } else {
      cityEl.style.display = 'none';
    }
  }

  const titleEl = document.getElementById('meeting-headline');
  if (titleEl) titleEl.textContent = meeting.title || 'Без названия';
  const detailsEl = document.getElementById('meeting-details');
  if (detailsEl) detailsEl.textContent = meeting.full_description || 'Подробное описание появится позже.';

  const creatorName = meeting.creator?.full_name || meeting.creator?.username || 'Автор';
  const creatorAge = meeting.creator?.age ? `${meeting.creator.age} лет` : 'Возраст не указан';
  const avatarUrl = meeting.creator?.photo_URL && meeting.creator?.photo_URL !== 'user'
    ? meeting.creator.photo_URL
    : DEFAULT_AVATAR;

  const avatarEl = document.getElementById('creator-avatar');
  if (avatarEl) avatarEl.innerHTML = `<img src="${avatarUrl}" alt="${creatorName}">`;

  const creatorLink = document.getElementById('creator-name');
  if (creatorLink) {
    creatorLink.textContent = creatorName;
    creatorLink.href = meeting.creator?.id ? `profile.html?id=${meeting.creator.id}` : '#';
  }

  const ageEl = document.getElementById('creator-age');
  if (ageEl) ageEl.textContent = creatorAge;

  const currentSlots = meeting.current_slots || meeting.participants_count || 0;
  const infoEl = document.getElementById('participants-info');
  if (infoEl) infoEl.textContent = `👥 ${currentSlots}/${meeting.max_slots || 0} участников`;
}

async function fetchMeeting(meetingId) {
  if (!meetingId) return null;
  try {
    const meeting = await api.getOne(TABLES.meetings, meetingId);
    if (!meeting) return null;

    if (meeting.creator_id) {
      const creator = await api.getOne(TABLES.profiles, meeting.creator_id);
      return { ...meeting, creator: creator ? pickCreatorFields(creator) : null };
    }
    return meeting;
  } catch (error) {
    console.error('Ошибка загрузки встречи:', error);
    return null;
  }
}

function pickCreatorFields(profile) {
  if (!profile) return null;
  return {
    id: profile.id,
    username: profile.username,
    full_name: profile.full_name,
    age: profile.age,
    photo_URL: profile.photo_URL
  };
}

async function setupChatState(meeting, user) {
  const statusCard = document.getElementById('join-status-card');
  const statusText = document.getElementById('join-status-text');
  const openBtn = document.getElementById('open-chat-btn');
  const leaveBtn = document.getElementById('leave-chat-btn');
  const requestsCard = document.getElementById('requests-card');
  const requestsList = document.getElementById('requests-list');
  const joinButton = document.getElementById('join-button');

  if (!meeting.chat_id || !user) {
    if (statusCard) statusCard.style.display = 'none';
    if (requestsCard) requestsCard.style.display = 'none';
    if (joinButton) joinButton.style.display = '';
    return;
  }

  const memberships = await api.get(TABLES.chat_members, { chat_id: meeting.chat_id, user_id: user.id });
  const membership = (memberships || [])[0] || null;

  if (statusCard && statusText) {
    statusCard.style.display = 'block';
    if (!membership) {
      statusText.textContent = 'Вы не отправляли заявку.';
      if (joinButton) joinButton.style.display = '';
    } else if (membership.status === 'pending') {
      statusText.textContent = 'Заявка отправлена, ожидает одобрения.';
      if (joinButton) joinButton.style.display = 'none';
    } else if (membership.status === 'approved') {
      statusText.textContent = 'Вы участник чата.';
      if (joinButton) joinButton.style.display = 'none';
      if (openBtn) {
        openBtn.style.display = 'block';
        openBtn.onclick = () => { window.location.href = `chat.html?chat_id=${meeting.chat_id}`; };
      }
      if (leaveBtn && meeting.creator_id !== user.id) {
        leaveBtn.style.display = 'block';
        leaveBtn.onclick = async () => { await leaveChat(meeting, user); };
      } else if (leaveBtn) {
        leaveBtn.style.display = 'none';
      }
    } else if (membership.status === 'rejected') {
      statusText.textContent = 'Заявка отклонена.';
      if (joinButton) joinButton.style.display = 'none';
    }
  }

  if (meeting.creator_id && meeting.creator_id === user.id) {
    const pending = await api.get(TABLES.chat_members, { chat_id: meeting.chat_id, status: 'pending' });

    if (requestsCard && requestsList) {
      requestsCard.style.display = 'block';
      requestsList.innerHTML = '';

      if (!pending || pending.length === 0) {
        requestsList.textContent = 'Нет заявок';
        return;
      }

      const userIds = pending.map(req => req.user_id).filter(Boolean);
      const profiles = userIds.length ? await api.get(TABLES.profiles, { id: { in: userIds } }) : [];
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
        row.querySelector('.btn-approve').onclick = async () => { await approveRequest(meeting, req.user_id); };
        row.querySelector('.btn-reject').onclick = async () => { await rejectRequest(meeting, req.user_id); };
        requestsList.appendChild(row);
      });
    }
  }
}

async function requestJoin(meeting, user) {
  if (!user) {
    const returnTo = meeting?.id ? `meeting.html?id=${meeting.id}` : 'meeting.html';
    window.location.href = `login.html?next=${encodeURIComponent(returnTo)}`;
    return;
  }
  if (!meeting.chat_id) {
    showNotification('Чат не создан');
    return;
  }

  const existing = await api.get(TABLES.chat_members, { chat_id: meeting.chat_id, user_id: user.id });
  if (existing && existing[0]) {
    showNotification(existing[0].status === 'pending' ? 'Заявка уже отправлена' : 'Вы уже в чате');
    return;
  }

  try {
    await api.insert(TABLES.chat_members, { chat_id: meeting.chat_id, user_id: user.id, role: 'member', status: 'pending' });
    showNotification('Заявка отправлена');
    const freshUser = typeof window.getCurrentUser === 'function' ? await window.getCurrentUser() : await api.request('/api/auth/me');
    await setupChatState(meeting, freshUser || user);
  } catch (e) {
    console.error('Ошибка отправки заявки:', e);
    showNotification('Ошибка отправки заявки');
  }
}

async function approveRequest(meeting, userId) {
  try {
    const rows = await api.get(TABLES.chat_members, { chat_id: meeting.chat_id, user_id: userId });
    const membership = (rows || [])[0];
    if (!membership?.id) {
      showNotification('Не удалось найти заявку');
      return;
    }
    await api.update(TABLES.chat_members, membership.id, { status: 'approved' });

    const currentSlots = meeting.current_slots || 0;
    await api.update(TABLES.meetings, meeting.id, { current_slots: currentSlots + 1 });
    meeting.current_slots = currentSlots + 1;

    showNotification('Пользователь добавлен');
    await setupChatState(meeting, { id: meeting.creator_id });
  } catch (e) {
    console.error('Ошибка одобрения:', e);
    showNotification('Ошибка одобрения');
  }
}

async function rejectRequest(meeting, userId) {
  try {
    const rows = await api.get(TABLES.chat_members, { chat_id: meeting.chat_id, user_id: userId });
    const membership = (rows || [])[0];
    if (!membership?.id) {
      showNotification('Не удалось найти заявку');
      return;
    }
    await api.update(TABLES.chat_members, membership.id, { status: 'rejected' });
    showNotification('Заявка отклонена');
    await setupChatState(meeting, { id: meeting.creator_id });
  } catch (e) {
    console.error('Ошибка отклонения:', e);
    showNotification('Ошибка отклонения');
  }
}

async function leaveChat(meeting, user) {
  const confirmLeave = confirm('Покинуть чат встречи?');
  if (!confirmLeave) return;
  try {
    await api.query(TABLES.chat_members, 'deleteWhere', {}, { chat_id: meeting.chat_id, user_id: user.id });
    const currentSlots = meeting.current_slots || 1;
    const nextSlots = Math.max(currentSlots - 1, 0);
    await api.update(TABLES.meetings, meeting.id, { current_slots: nextSlots });
    meeting.current_slots = nextSlots;
    showNotification('Вы вышли из чата');
    await setupChatState(meeting, user);
  } catch (e) {
    console.error('Ошибка выхода:', e);
    showNotification('Ошибка выхода');
  }
}

function showNotification(message) {
  const notification = document.getElementById('notification');
  if (!notification) return;
  notification.textContent = message;
  notification.style.display = 'block';
  setTimeout(() => { notification.style.display = 'none'; }, 3000);
}

