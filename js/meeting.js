const { TABLES } = window.APP || {};
const DEFAULT_AVATAR = 'assets/avatar.png';

async function fetchUserName(userId) {
  if (!userId) return 'Пользователь';
  try {
    const profile = await api.getOne(TABLES.profiles, userId);
    return profile?.full_name || profile?.username || 'Пользователь';
  } catch (_e) {
    return 'Пользователь';
  }
}

let TOPICS = [];

function isMeetingFull(meeting) {
  if (!meeting) return false;
  const maxSlots = Number(meeting.max_slots) || 0;
  if (maxSlots <= 0) return false;
  const currentSlots = Number(meeting.current_slots || meeting.participants_count || 0);
  return currentSlots >= maxSlots;
}

document.addEventListener('DOMContentLoaded', async () => {
  TOPICS = await window.fetchTopics();
  const user = typeof window.getCurrentUser === 'function'
    ? await window.getCurrentUser()
    : await api.request('/api/auth/me');

  const meetingId = new URLSearchParams(window.location.search).get('id');
  const storedMeeting = meetingId ? getMeetingFromStorage(meetingId) : null;
  const freshMeeting = await fetchMeeting(meetingId);
  const meeting = freshMeeting || storedMeeting;

  if (!meeting) {
    showNotification('Встреча не найдена');
    return;
  }

  renderMeeting(meeting, user);
  setupOwnerActions(meeting, user);
  await ensureMeetingChat(meeting, user);
  await setupChatState(meeting, user);
  await renderParticipantsList(meeting, user);

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
  const topicLabel = topic ? `#${getTopicDisplayName(topic)}` : '#Встреча';

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
  const countdownEl = document.getElementById('meeting-countdown');
  if (countdownEl) countdownEl.textContent = buildMeetingCountdownLabel(meeting.expires_at);
  const detailsEl = document.getElementById('meeting-details');
  if (detailsEl) detailsEl.textContent = meeting.full_description || 'Подробное описание появится позже.';

  const creatorName = meeting.creator?.full_name || meeting.creator?.username || 'Автор';
  const creatorAge = meeting.creator?.age ? `${meeting.creator.age} лет` : 'Возраст не указан';
  const avatarUrl = meeting.creator?.photo_URL && meeting.creator?.photo_URL !== 'user'
    ? meeting.creator.photo_URL
    : DEFAULT_AVATAR;

  const avatarEl = document.getElementById('creator-avatar');
  if (avatarEl) avatarEl.innerHTML = `<img src="${avatarUrl}" alt="${creatorName}" onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}';">`;

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

function setupOwnerActions(meeting, user) {
  const actionsWrap = document.getElementById('owner-actions');
  const menuBtn = document.getElementById('owner-menu-btn');
  const menu = document.getElementById('owner-menu');
  const editBtn = document.getElementById('owner-edit-btn');
  const deleteBtn = document.getElementById('owner-delete-btn');

  if (!actionsWrap || !menuBtn || !menu || !editBtn || !deleteBtn) return;

  const isOwner = !!(user && meeting && meeting.creator_id && user.id === meeting.creator_id);
  actionsWrap.style.display = isOwner ? 'block' : 'none';
  if (!isOwner) return;

  const closeMenu = () => menu.classList.remove('open');
  const toggleMenu = () => menu.classList.toggle('open');

  menuBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleMenu();
  };

  editBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    window.location.href = `create-meeting.html?edit=${meeting.id}`;
  };

  deleteBtn.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeMenu();

    const ok = confirm('Удалить эту встречу?');
    if (!ok) return;

    try {
      if (typeof window.deleteExpiredMeeting === 'function') {
        await window.deleteExpiredMeeting(meeting.id);
      } else {
        await api.delete(TABLES.meetings, meeting.id);
      }
      showNotification('Встреча удалена');
      setTimeout(() => { window.location.href = 'my-events.html'; }, 400);
    } catch (err) {
      console.error('Ошибка удаления встречи:', err);
      showNotification('Ошибка удаления встречи');
    }
  };

  document.addEventListener('click', (e) => {
    if (e.target.closest('#owner-actions')) return;
    closeMenu();
  });
}

async function setupChatState(meeting, user) {
  const statusCard = document.getElementById('join-status-card');
  const statusText = document.getElementById('join-status-text');
  const openBtn = document.getElementById('open-chat-btn');
  const leaveBtn = document.getElementById('leave-chat-btn');
  const requestsCard = document.getElementById('requests-card');
  const requestsList = document.getElementById('requests-list');
  const joinButton = document.getElementById('join-button');
  const joinUnavailable = document.getElementById('join-unavailable');
  const meetingFull = isMeetingFull(meeting);

  const showJoinAction = () => {
    if (joinButton) joinButton.style.display = meetingFull ? 'none' : '';
    if (joinUnavailable) joinUnavailable.style.display = meetingFull ? 'block' : 'none';
  };

  const hideJoinAction = () => {
    if (joinButton) joinButton.style.display = 'none';
    if (joinUnavailable) joinUnavailable.style.display = 'none';
  };

  if (!meeting.chat_id || !user) {
    if (statusCard) statusCard.style.display = 'none';
    if (requestsCard) requestsCard.style.display = 'none';
    showJoinAction();
    // Not logged in or chat missing -> hide members list
    const membersCard = document.getElementById('participants-list-card');
    if (membersCard) membersCard.style.display = 'none';
    return;
  }

  const hasStatus = await chatMembersHasStatus();
  let membership = null;
  try {
    const memberships = await api.get(TABLES.chat_members, { chat_id: meeting.chat_id, user_id: user.id });
    membership = (memberships || [])[0] || null;
  } catch (_e) {
    membership = null;
  }

  if (statusCard && statusText) {
    statusCard.style.display = 'block';
    if (!membership) {
      statusText.textContent = 'Вы не отправляли заявку.';
      showJoinAction();
    } else if (hasStatus && membership.status === 'pending') {
      statusText.textContent = 'Заявка отправлена, ожидает одобрения.';
      hideJoinAction();
    } else if (!hasStatus || membership.status === 'approved') {
      statusText.textContent = meeting.creator_id === user.id ? 'Вы создатель встречи.' : 'Вы участник чата.';
      hideJoinAction();
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
    } else if (hasStatus && membership.status === 'rejected') {
      statusText.textContent = 'Заявка отклонена.';
      hideJoinAction();
    }
  }

  if (meeting.creator_id && meeting.creator_id === user.id && hasStatus) {
    let pending = [];
    try {
      pending = await api.get(TABLES.chat_members, { chat_id: meeting.chat_id, status: 'pending' });
    } catch (_e) {
      pending = [];
    }

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
          <div class="request-person">
            <a href="profile.html?id=${req.user_id}">${name}${age}</a>
            <div class="request-caption">Хочет присоединиться к этой встрече</div>
          </div>
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

async function canSeeParticipants(meeting, user) {
  if (!meeting || !user) return false;
  if (meeting.creator_id && user.id === meeting.creator_id) return true;

  // Prefer chat membership (approved) when chat exists.
  if (meeting.chat_id) {
    try {
      const hasStatus = await chatMembersHasStatus();
      const rows = await api.get(TABLES.chat_members, { chat_id: meeting.chat_id, user_id: user.id });
      const m = (rows || [])[0] || null;
      if (!m) return false;
      if (!hasStatus) return true;
      return m.status === 'approved';
    } catch (_e) {}
  }

  // Fallback to legacy participants table.
  try {
    const rows = await api.get(TABLES.participants, { meeting_id: meeting.id, user_id: user.id });
    return !!(rows && rows[0]);
  } catch (_e) {
    return false;
  }
}

async function renderParticipantsList(meeting, user) {
  const card = document.getElementById('participants-list-card');
  const list = document.getElementById('participants-list');
  if (!card || !list) return;

  const allowed = await canSeeParticipants(meeting, user);
  if (!allowed) {
    card.style.display = 'none';
    return;
  }

  list.innerHTML = 'Загрузка...';
  card.style.display = 'block';

  let userIds = [];
  try {
    if (meeting.chat_id) {
      const hasStatus = await chatMembersHasStatus();
      const rows = await api.get(TABLES.chat_members, hasStatus
        ? { chat_id: meeting.chat_id, status: 'approved' }
        : { chat_id: meeting.chat_id }
      );
      userIds = (rows || []).map(r => r.user_id).filter(Boolean);
    } else {
      const rows = await api.get(TABLES.participants, { meeting_id: meeting.id });
      userIds = (rows || []).map(r => r.user_id).filter(Boolean);
    }
  } catch (_e) {
    userIds = [];
  }

  if (meeting.creator_id) userIds.push(meeting.creator_id);
  userIds = Array.from(new Set(userIds.filter(Boolean)));

  if (userIds.length === 0) {
    list.innerHTML = '<div style="color:#64748b;">Пока нет участников</div>';
    return;
  }

  let profiles = [];
  try {
    profiles = await api.get(TABLES.profiles, { id: { in: userIds } });
  } catch (_e) {
    profiles = [];
  }
  const byId = new Map((profiles || []).map(p => [p.id, p]));

  const ownerId = meeting.creator_id || null;
  const orderedIds = ownerId ? [ownerId, ...userIds.filter(id => id !== ownerId)] : userIds;
  const canManageParticipants = !!(user && ownerId && user.id === ownerId);

  list.innerHTML = '';
  orderedIds.forEach(id => {
    const p = byId.get(id) || {};
    const name = p.full_name || p.username || 'Пользователь';
    const sub = p.age ? `${p.age} лет` : '';
    const avatar = p.photo_URL && p.photo_URL !== 'user' ? p.photo_URL : DEFAULT_AVATAR;
    const isOwner = ownerId && id === ownerId;
    const row = document.createElement('div');
    row.className = 'member-row';

    const a = document.createElement('a');
    a.className = 'member-item' + (isOwner ? ' owner' : '');
    a.href = `profile.html?id=${id}`;
    a.innerHTML = `
      <div class="member-avatar"><img src="${avatar}" alt="${name}" onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}';"></div>
      <div>
        <div class="member-name">${name}</div>
        <div class="member-sub">${sub}</div>
      </div>
      ${isOwner ? '<div class="member-badge">Создатель</div>' : ''}
    `;
    row.appendChild(a);

    if (canManageParticipants && !isOwner) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'member-remove';
      removeBtn.textContent = 'Удалить';
      removeBtn.onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await removeParticipantFromMeetingPage(meeting, user, id, name);
      };
      row.appendChild(removeBtn);
    }

    list.appendChild(row);
  });
}

async function removeParticipantFromMeetingPage(meeting, user, memberId, memberName) {
  if (!meeting || !user || user.id !== meeting.creator_id) return;
  if (!memberId || memberId === meeting.creator_id) return;

  const confirmed = confirm(`Удалить ${memberName} из встречи?`);
  if (!confirmed) return;

  try {
    let shouldDecrement = true;
    if (meeting.chat_id) {
      const hasStatus = await chatMembersHasStatus();
      if (hasStatus) {
        const rows = await api.get(TABLES.chat_members, { chat_id: meeting.chat_id, user_id: memberId });
        const membership = (rows || [])[0] || null;
        shouldDecrement = membership?.status === 'approved';
      }
      await api.query(TABLES.chat_members, 'deleteWhere', {}, { chat_id: meeting.chat_id, user_id: memberId });
    }

    await removeParticipantRecord(meeting.id, memberId);

    if (shouldDecrement) {
      const currentSlots = Number(meeting.current_slots || 0);
      const nextSlots = Math.max(currentSlots - 1, 0);
      await api.update(TABLES.meetings, meeting.id, { current_slots: nextSlots });
      meeting.current_slots = nextSlots;
    }

    if (meeting.chat_id) {
      await window.postChatSystemMessage?.(meeting.chat_id, `${memberName} удалён из встречи`, memberId);
    }

    showNotification('Участник удалён');
    renderMeeting(meeting, user);
    await setupChatState(meeting, user);
    await renderParticipantsList(meeting, user);
  } catch (error) {
    console.error('Ошибка удаления участника со страницы встречи:', error);
    showNotification('Ошибка удаления участника');
  }
}

async function requestJoin(meeting, user) {
  if (!user) {
    const returnTo = meeting?.id ? `meeting.html?id=${meeting.id}` : 'meeting.html';
    window.location.href = `login.html?next=${encodeURIComponent(returnTo)}`;
    return;
  }
  if (isMeetingFull(meeting)) {
    showNotification('Свободных мест сейчас нет');
    await setupChatState(meeting, user);
    return;
  }
  if (!meeting.chat_id) {
    showNotification('Чат не создан');
    return;
  }

  const existing = await api.get(TABLES.chat_members, { chat_id: meeting.chat_id, user_id: user.id });
  if (existing && existing[0]) {
    const hasStatus = await chatMembersHasStatus();
    showNotification(hasStatus && existing[0].status === 'pending' ? 'Заявка уже отправлена' : 'Вы уже в чате');
    return;
  }

  try {
    const hasStatus = await chatMembersHasStatus();
    if (hasStatus) {
      await safeInsertChatMember({ chat_id: meeting.chat_id, user_id: user.id, role: 'member', status: 'pending' });
      if (meeting.creator_id && meeting.creator_id !== user.id && typeof window.createUserNotification === 'function') {
        const senderName = user.full_name || user.username || user.email || 'Пользователь';
        await window.createUserNotification(meeting.creator_id, {
          notification_type: 'event_join_request',
          related_table: 'meetings',
          related_id: meeting.id,
          title: meeting.title || 'Встреча',
          message: `${senderName} хочет присоединиться к встрече «${meeting.title || 'Встреча'}».`
        });
      }
      showNotification('Заявка отправлена');
    } else {
      await safeInsertChatMember({ chat_id: meeting.chat_id, user_id: user.id });
      // Legacy mode: joining is immediate.
      let participantAdded = false;
      try {
        const existingParticipant = await api.get(TABLES.participants, { meeting_id: meeting.id, user_id: user.id, $limit: 1 });
        if (!existingParticipant || !existingParticipant[0]) {
          await ensureParticipantRecord(meeting.id, user.id);
          participantAdded = true;
        }
      } catch (_e) {
        const inserted = await ensureParticipantRecord(meeting.id, user.id);
        participantAdded = !!inserted;
      }

      if (participantAdded) {
        const currentSlots = meeting.current_slots || 0;
        await api.update(TABLES.meetings, meeting.id, { current_slots: currentSlots + 1 });
        meeting.current_slots = currentSlots + 1;

        if (meeting.creator_id && meeting.creator_id !== user.id && typeof window.createUserNotification === 'function') {
          const senderName = user.full_name || user.username || user.email || 'Пользователь';
          await window.createUserNotification(meeting.creator_id, {
            notification_type: 'event_joined_direct',
            related_table: 'meetings',
            related_id: meeting.id,
            title: 'Новый участник встречи',
            message: `${senderName} присоединился к встрече «${meeting.title || 'Встреча'}».`
          });
        }
      }

      showNotification('Вы присоединились к встрече');
    }
    const freshUser = typeof window.getCurrentUser === 'function' ? await window.getCurrentUser() : await api.request('/api/auth/me');
    await setupChatState(meeting, freshUser || user);
    await renderParticipantsList(meeting, freshUser || user);
  } catch (e) {
    console.error('Ошибка отправки заявки:', e);
    showNotification(e.message || 'Ошибка отправки заявки');
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
    await ensureParticipantRecord(meeting.id, userId);

    const currentSlots = meeting.current_slots || 0;
    await api.update(TABLES.meetings, meeting.id, { current_slots: currentSlots + 1 });
    meeting.current_slots = currentSlots + 1;

    const senderName = await fetchUserName(userId);
    if (userId && typeof window.createUserNotification === 'function') {
      await window.createUserNotification(userId, {
        notification_type: 'event_join_approved',
        related_table: 'meetings',
        related_id: meeting.id,
        title: 'Заявка одобрена',
        message: `Организатор добавил вас во встречу «${meeting.title || 'Встреча'}».`
      });
    }

    if (meeting.chat_id) {
      await window.postChatSystemMessage?.(meeting.chat_id, `${senderName} присоединился к чату встречи`, userId);
    }

    showNotification('Пользователь добавлен');
    await setupChatState(meeting, { id: meeting.creator_id });
    await renderParticipantsList(meeting, { id: meeting.creator_id });
  } catch (e) {
    console.error('Ошибка одобрения:', e);
    showNotification(e.message || 'Ошибка одобрения');
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
    if (userId && typeof window.createUserNotification === 'function') {
      await window.createUserNotification(userId, {
        notification_type: 'event_join_rejected',
        related_table: 'meetings',
        related_id: meeting.id,
        title: 'Заявка отклонена',
        message: `Организатор отклонил вашу заявку на встречу «${meeting.title || 'Встреча'}».`
      });
    }
    showNotification('Заявка отклонена');
    await setupChatState(meeting, { id: meeting.creator_id });
  } catch (e) {
    console.error('Ошибка отклонения:', e);
    showNotification(e.message || 'Ошибка отклонения');
  }
}

async function leaveChat(meeting, user) {
  const confirmLeave = confirm('Покинуть чат встречи?');
  if (!confirmLeave) return;
  try {
    let shouldDecrement = true;
    try {
      const hasStatus = await chatMembersHasStatus();
      if (hasStatus) {
        const rows = await api.get(TABLES.chat_members, { chat_id: meeting.chat_id, user_id: user.id });
        const m = (rows || [])[0];
        shouldDecrement = (m && m.status === 'approved');
      }
    } catch (_e) {}

    const userName = user.full_name || user.username || 'Пользователь';
    await window.postChatSystemMessage?.(meeting.chat_id, `${userName} покинул чат встречи`, user.id);

    await api.query(TABLES.chat_members, 'deleteWhere', {}, { chat_id: meeting.chat_id, user_id: user.id });
    if (shouldDecrement) {
      const currentSlots = meeting.current_slots || 1;
      const nextSlots = Math.max(currentSlots - 1, 0);
      await api.update(TABLES.meetings, meeting.id, { current_slots: nextSlots });
      meeting.current_slots = nextSlots;
    }
    await removeParticipantRecord(meeting.id, user.id);

    showNotification('Вы вышли из чата');
    await setupChatState(meeting, user);
    await renderParticipantsList(meeting, user);
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
  requestAnimationFrame(() => {
    notification.classList.add('is-visible');
  });
  setTimeout(() => {
    notification.classList.remove('is-visible');
    setTimeout(() => {
      notification.style.display = 'none';
    }, 240);
  }, 3000);
}

let __chatMembersHasStatus = null;
async function chatMembersHasStatus() {
  if (__chatMembersHasStatus !== null) return __chatMembersHasStatus;
  try {
    await api.get(TABLES.chat_members, { $limit: 1, status: 'approved' });
    __chatMembersHasStatus = true;
  } catch (_e) {
    __chatMembersHasStatus = false;
  }
  return __chatMembersHasStatus;
}

async function safeInsertChatMember(data) {
  try {
    return await api.insert(TABLES.chat_members, data);
  } catch (_e) {
    return await api.insert(TABLES.chat_members, { chat_id: data.chat_id, user_id: data.user_id });
  }
}

async function ensureParticipantRecord(meetingId, userId) {
  if (!meetingId || !userId) return;
  try {
    const existing = await api.get(TABLES.participants, { meeting_id: meetingId, user_id: userId, $limit: 1 });
    if (existing && existing[0]) return existing[0];
    const rows = await api.insert(TABLES.participants, { meeting_id: meetingId, user_id: userId });
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (e) {
    console.warn('ensureParticipantRecord failed:', e);
    return null;
  }
}

async function removeParticipantRecord(meetingId, userId) {
  if (!meetingId || !userId) return;
  try {
    await api.query(TABLES.participants, 'deleteWhere', {}, { meeting_id: meetingId, user_id: userId });
  } catch (e) {
    console.warn('removeParticipantRecord failed:', e);
  }
}

async function ensureMeetingChat(meeting, user) {
  if (!meeting || meeting.chat_id || !user) return;
  if (!meeting.id) return;
  if (meeting.creator_id !== user.id) return;

  try {
    // Try to link an existing chat by meeting_id (useful if meeting.chat_id wasn't set).
    const existingChats = await api.get(TABLES.chats, {
      meeting_id: meeting.id,
      $order: { column: 'created_at', ascending: false },
      $limit: 1
    });
    const existing = (existingChats || [])[0];
    if (existing?.id) {
      meeting.chat_id = existing.id;
      try { await api.update(TABLES.meetings, meeting.id, { chat_id: existing.id }); } catch (_e) {}
    } else {
      // Create chat on-demand for the owner.
      const inserted = await api.insert(TABLES.chats, {
        meeting_id: meeting.id,
        title: meeting.title || 'Чат встречи',
        owner_id: user.id
      });
      const chat = Array.isArray(inserted) ? inserted[0] : inserted;
      if (chat?.id) {
        meeting.chat_id = chat.id;
        try { await api.update(TABLES.meetings, meeting.id, { chat_id: chat.id }); } catch (_e) {}
      }
    }

    if (!meeting.chat_id) return;

    // Ensure owner is in chat_members so the chat appears in the chat list.
    const current = await api.get(TABLES.chat_members, { chat_id: meeting.chat_id, user_id: user.id });
    if (current && current[0]) return;

    const hasStatus = await chatMembersHasStatus();
    if (hasStatus) {
      await safeInsertChatMember({ chat_id: meeting.chat_id, user_id: user.id, role: 'owner', status: 'approved' });
    } else {
      await safeInsertChatMember({ chat_id: meeting.chat_id, user_id: user.id });
    }
  } catch (e) {
    console.warn('ensureMeetingChat failed:', e);
  }
}
