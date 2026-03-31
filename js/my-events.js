const { TABLES } = window.APP || {};
const DEFAULT_AVATAR = 'assets/avatar.png';

let currentUser = null;
let allMeetings = [];
let TOPICS = [];
let currentFilter = 'all';
let participationNotifications = [];
let notificationsPollTimer = null;
let notificationsPanelOpen = false;

const PARTICIPATION_NOTIFICATION_TYPES = new Set([
  'event_join_request',
  'event_join_approved',
  'event_join_rejected',
  'event_joined_direct'
]);

document.addEventListener('DOMContentLoaded', async () => {
  currentUser = await window.getCurrentUser();
  if (!currentUser) {
    window.location.href = 'login.html';
    return;
  }

  TOPICS = await window.fetchTopics();
  await loadMeetings();
  await loadParticipationNotifications();
  setupTabs();
  setupNotificationActions();
  startNotificationsPolling();
});

async function loadMeetings() {
  if (!currentUser) return;
  const container = document.getElementById('meetings-container');
  if (container) {
    container.innerHTML = '<div style="text-align: center; padding: 40px; color: #94a3b8;">Загрузка...</div>';
  }

  try {
    const summary = await api.request('/api/my-events/summary');
    allMeetings = Array.isArray(summary?.meetings) ? summary.meetings : [];
    allMeetings.forEach(meeting => {
      if (meeting?.creator) window.primeProfileCache?.(meeting.creator);
    });
    renderMeetings(currentFilter);
  } catch (error) {
    console.error('Ошибка загрузки встреч:', error);
    if (container) {
      container.innerHTML =
        '<div class="empty-state"><div class="empty-state-icon">⚠️</div><div class="empty-state-title">Ошибка загрузки</div><div class="empty-state-text">Не удалось загрузить встречи</div></div>';
    }
  }
}

function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.dataset.tab;
      renderMeetings(currentFilter);
    });
  });
}

function setupNotificationActions() {
  const toggleBtn = document.getElementById('notifications-toggle');
  const panel = document.getElementById('notifications-panel');
  const markAllBtn = document.getElementById('notifications-mark-all');
  if (toggleBtn && panel) {
    toggleBtn.onclick = (event) => {
      event.stopPropagation();
      setNotificationsPanelOpen(!notificationsPanelOpen);
    };

    panel.addEventListener('click', (event) => {
      event.stopPropagation();
    });

    document.addEventListener('click', () => {
      if (!notificationsPanelOpen) return;
      setNotificationsPanelOpen(false);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && notificationsPanelOpen) {
        setNotificationsPanelOpen(false);
      }
    });
  }

  if (!markAllBtn) return;

  markAllBtn.onclick = async () => {
    const unread = participationNotifications.filter(item => !item.is_read);
    if (unread.length === 0) return;

    await Promise.all(unread.map(item => markNotificationRead(item.id)));
    await loadParticipationNotifications();
  };
}

function setNotificationsPanelOpen(isOpen) {
  const toggleBtn = document.getElementById('notifications-toggle');
  const panel = document.getElementById('notifications-panel');
  if (!toggleBtn || !panel) return;

  notificationsPanelOpen = Boolean(isOpen);
  panel.hidden = !notificationsPanelOpen;
  toggleBtn.setAttribute('aria-expanded', notificationsPanelOpen ? 'true' : 'false');
}

function startNotificationsPolling() {
  if (notificationsPollTimer) clearInterval(notificationsPollTimer);
  notificationsPollTimer = setInterval(async () => {
    if (!currentUser) return;
    await loadParticipationNotifications(true);
  }, 30000);
}

async function loadParticipationNotifications(silent = false) {
  if (!currentUser) return;

  try {
    const summary = await api.request('/api/my-events/notifications?limit=20');
    participationNotifications = Array.isArray(summary?.notifications) ? summary.notifications : [];
    participationNotifications.forEach(notification => {
      (notification?.pendingRequests || []).forEach(item => {
        if (item?.profile) window.primeProfileCache?.(item.profile);
      });
    });
    renderParticipationNotifications();
  } catch (error) {
    console.error('Ошибка загрузки уведомлений:', error);
    if (!silent) renderNotificationsError();
  }
}

function renderParticipationNotifications() {
  const list = document.getElementById('notifications-list');
  const markAllBtn = document.getElementById('notifications-mark-all');
  const toggleBadge = document.getElementById('notifications-toggle-badge');
  if (!list || !markAllBtn) return;

  const unreadCount = participationNotifications.filter(item => item.is_read !== true).length;
  markAllBtn.disabled = unreadCount === 0;
  if (toggleBadge) {
    toggleBadge.style.display = unreadCount > 0 ? 'inline-flex' : 'none';
    toggleBadge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
  }

  if (participationNotifications.length === 0) {
    list.innerHTML = '<div class="notifications-empty">Пока нет уведомлений по участию во встречах.</div>';
    return;
  }

  list.innerHTML = '';
  participationNotifications.forEach(notification => {
    const item = document.createElement('div');
    item.className = `notification-item${notification.is_read === true ? '' : ' unread'}`;
    const meetingTitle = getNotificationMeetingTitle(notification);
    const bodyText = getNotificationBodyText(notification);
    const canModerateRequest = Boolean(
      notification.notification_type === 'event_join_request' &&
      notification.meeting?.creator_id === currentUser?.id &&
      notification.meeting?.chat_id &&
      notification.resolvedRequest?.userId
    );
    item.innerHTML = `
      <div class="notification-main">
        <div class="notification-meta">
          <span class="notification-pill">${escapeHtml(getNotificationTypeLabel(notification.notification_type))}</span>
          <span class="notification-time">${escapeHtml(formatNotificationTime(notification.created_at))}</span>
        </div>
        <button type="button" class="notification-title-link">${escapeHtml(meetingTitle)}</button>
        <div class="notification-message">${escapeHtml(bodyText)}</div>
      </div>
      <div class="notification-actions">
        ${canModerateRequest ? `
          <button type="button" class="notification-approve-btn">Одобрить</button>
          <button type="button" class="notification-reject-btn">Отклонить</button>
        ` : ''}
      </div>
    `;

    const titleLink = item.querySelector('.notification-title-link');
    if (titleLink) {
      titleLink.onclick = async () => {
        await handleNotificationOpen(notification);
      };
    }

    const approveBtn = item.querySelector('.notification-approve-btn');
    if (approveBtn) {
      approveBtn.onclick = async () => {
        await handleNotificationDecision(notification, 'approve', item);
      };
    }

    const rejectBtn = item.querySelector('.notification-reject-btn');
    if (rejectBtn) {
      rejectBtn.onclick = async () => {
        await handleNotificationDecision(notification, 'reject', item);
      };
    }

    list.appendChild(item);
  });
}

function renderNotificationsError() {
  const list = document.getElementById('notifications-list');
  if (!list) return;
  list.innerHTML = '<div class="notifications-empty">Не удалось загрузить уведомления.</div>';
}

async function handleNotificationOpen(notification) {
  if (!notification) return;
  if (notification.is_read !== true) await markNotificationRead(notification.id);
  if (notification.related_table === 'meetings' && notification.related_id) {
    window.location.href = `meeting.html?id=${notification.related_id}`;
    return;
  }
  await loadParticipationNotifications(true);
}

async function handleNotificationDecision(notification, action, item) {
  if (!notification?.meeting?.id || !notification?.resolvedRequest?.userId) return;

  const buttons = Array.from(item?.querySelectorAll('button') || []);
  buttons.forEach(button => { button.disabled = true; });

  try {
    if (action === 'approve') {
      await approveParticipationRequest(notification.meeting, notification.resolvedRequest.userId);
    } else {
      await rejectParticipationRequest(notification.meeting, notification.resolvedRequest.userId);
    }

    if (notification.is_read !== true) {
      await markNotificationRead(notification.id);
    }
    await loadParticipationNotifications(true);
  } catch (error) {
    console.error('Ошибка обработки заявки из уведомления:', error);
    alert(action === 'approve' ? 'Не удалось одобрить заявку' : 'Не удалось отклонить заявку');
    buttons.forEach(button => { button.disabled = false; });
  }
}

async function markNotificationRead(notificationId) {
  if (!notificationId) return null;
  try {
    const rows = await api.update(TABLES.notifications, notificationId, {
      is_read: true,
      read_at: new Date().toISOString()
    });
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (error) {
    console.error('Ошибка отметки уведомления:', error);
    return null;
  }
}

async function approveParticipationRequest(meeting, userId) {
  const rows = await api.get(TABLES.chat_members, { chat_id: meeting.chat_id, user_id: userId });
  const membership = (rows || [])[0];
  if (!membership?.id) throw new Error('Membership not found');

  await api.update(TABLES.chat_members, membership.id, { status: 'approved' });
  await ensureParticipantRecordSafe(meeting.id, userId);

  const currentSlots = Number(meeting.current_slots || 0);
  await api.update(TABLES.meetings, meeting.id, { current_slots: currentSlots + 1 });

  if (userId && typeof window.createUserNotification === 'function') {
    await window.createUserNotification(userId, {
      notification_type: 'event_join_approved',
      related_table: 'meetings',
      related_id: meeting.id,
      title: meeting.title || 'Встреча',
      message: `Организатор добавил вас во встречу «${meeting.title || 'Встреча'}».`
    });
  }

  if (meeting.chat_id) {
    const senderName = await fetchNotificationUserName(userId);
    await window.postChatSystemMessage?.(meeting.chat_id, `${senderName} присоединился к чату встречи`, userId);
  }
}

async function rejectParticipationRequest(meeting, userId) {
  const rows = await api.get(TABLES.chat_members, { chat_id: meeting.chat_id, user_id: userId });
  const membership = (rows || [])[0];
  if (!membership?.id) throw new Error('Membership not found');

  await api.update(TABLES.chat_members, membership.id, { status: 'rejected' });

  if (userId && typeof window.createUserNotification === 'function') {
    await window.createUserNotification(userId, {
      notification_type: 'event_join_rejected',
      related_table: 'meetings',
      related_id: meeting.id,
      title: meeting.title || 'Встреча',
      message: `Организатор отклонил вашу заявку на встречу «${meeting.title || 'Встреча'}».`
    });
  }
}

function getNotificationTypeLabel(type) {
  switch (type) {
    case 'event_join_request':
      return 'Новая заявка';
    case 'event_join_approved':
      return 'Одобрено';
    case 'event_join_rejected':
      return 'Отклонено';
    case 'event_joined_direct':
      return 'Новый участник';
    default:
      return 'Уведомление';
  }
}

function formatNotificationTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getProfileDisplayName(profile, fallback = 'Пользователь') {
  return profile?.full_name || profile?.username || profile?.email || fallback;
}

function parseJoinRequesterName(message) {
  const text = String(message || '');
  const marker = ' хочет присоединиться';
  const index = text.indexOf(marker);
  if (index <= 0) return '';
  return text.slice(0, index).trim();
}

function normalizeNotificationName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function resolveNotificationRequest(notification, pendingRequests) {
  if (!Array.isArray(pendingRequests) || pendingRequests.length === 0) return null;
  if (pendingRequests.length === 1) return pendingRequests[0];

  const senderName = normalizeNotificationName(parseJoinRequesterName(notification.message));
  if (!senderName) return null;

  const matches = pendingRequests.filter(request => normalizeNotificationName(request.displayName) === senderName);
  return matches.length === 1 ? matches[0] : null;
}

function getNotificationMeetingTitle(notification) {
  return notification.meeting?.title || notification.title || 'Встреча';
}

function getNotificationBodyText(notification) {
  if (notification.notification_type === 'event_join_request') {
    const requesterName = notification.resolvedRequest?.displayName || parseJoinRequesterName(notification.message) || 'Пользователь';
    if (notification.pendingRequests?.length > 1 && !notification.resolvedRequest) {
      return `${requesterName}. Откройте встречу, если нужно выбрать заявку вручную.`;
    }
    return `${requesterName} хочет присоединиться к событию.`;
  }

  return notification.message || '';
}

async function fetchNotificationUserName(userId) {
  if (!userId) return 'Пользователь';
  try {
    const profile = typeof window.getProfileCached === 'function'
      ? await window.getProfileCached(userId)
      : (await api.get(TABLES.profiles, { id: userId, $limit: 1 }))[0];
    return getProfileDisplayName(profile, userId);
  } catch (_error) {
    return userId;
  }
}

async function ensureParticipantRecordSafe(meetingId, userId) {
  try {
    const existing = await api.get(TABLES.participants, { meeting_id: meetingId, user_id: userId, $limit: 1 });
    if (existing && existing[0]) return existing[0];
  } catch (_error) {
    // Fall through to insert attempt for older schemas.
  }

  try {
    const rows = await api.insert(TABLES.participants, { meeting_id: meetingId, user_id: userId });
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (_error) {
    return null;
  }
}

function renderMeetings(filter) {
  const container = document.getElementById('meetings-container');
  if (!container) return;

  let filteredMeetings = allMeetings;
  if (filter === 'owner') filteredMeetings = allMeetings.filter(m => m.role === 'owner');
  if (filter === 'participant') {
    // "Участвую" should include meetings where the user participates, including meetings they created.
    filteredMeetings = allMeetings.filter(m => m.role === 'participant' || m.role === 'owner');
  }

  if (!filteredMeetings || filteredMeetings.length === 0) {
    let emptyMessage = 'Вы пока не участвуете ни в одной встрече';
    let emptyIcon = '📭';
    if (filter === 'owner') {
      emptyMessage = 'Вы пока не создали ни одной встречи';
      emptyIcon = '📝';
    }
    if (filter === 'participant') {
      emptyMessage = 'Вы пока не участвуете ни в одной встрече';
      emptyIcon = '👥';
    }
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">${emptyIcon}</div>
        <div class="empty-state-title">${emptyMessage}</div>
        <div class="empty-state-text">Здесь будут отображаться ваши встречи</div>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  filteredMeetings.forEach(meeting => container.appendChild(createMeetingCard(meeting)));
}

function getTopicName(topicId) {
  if (!topicId) return 'Тема';
  const topic = (TOPICS || []).find(item => item.id === topicId);
  if (topic) return getTopicDisplayName(topic);
  return topicId;
}

function createMeetingCard(meeting) {
  const card = document.createElement('div');
  card.className = 'meeting-card';

  const creator = meeting.creator || {};
  const creatorName = creator.full_name || creator.username || 'Пользователь';
  const creatorAvatar = creator.photo_URL && creator.photo_URL !== 'user'
    ? creator.photo_URL
    : DEFAULT_AVATAR;

  const topicName = getTopicName(meeting.topic);
  const currentSlots = meeting.current_slots || 0;
  const maxSlots = meeting.max_slots || 0;

  const statusBadge = meeting.role === 'owner'
    ? '<div class="status-badge status-owner">Создатель</div>'
    : '<div class="status-badge status-participant">Участник</div>';

  const menuItems = meeting.role === 'owner'
    ? `<button class="meeting-menu-item" onclick="event.stopPropagation(); window.editMeeting('${meeting.id}')">✏️ Редактировать</button>
       <button class="meeting-menu-item danger" onclick="event.stopPropagation(); window.deleteMeeting('${meeting.id}')">🗑️ Удалить встречу</button>`
    : `<button class="meeting-menu-item" onclick="event.stopPropagation(); window.leaveMeeting('${meeting.id}')">Покинуть</button>`;

  card.innerHTML = `
    <div class="meeting-header">
      <div class="meeting-title">${meeting.title || 'Встреча'}</div>
      ${statusBadge}
    </div>
    <div class="meeting-meta">
      <div class="meeting-tag">#${topicName}</div>
      <div class="meeting-location">📍 ${meeting.location || ''}</div>
      <div class="meeting-slots">👥 ${currentSlots}/${maxSlots}</div>
    </div>
    <div class="meeting-description">${meeting.full_description || ''}</div>
    <div class="meeting-footer">
      <div class="creator-info">
        <div class="creator-avatar">
          <img src="${creatorAvatar}" alt="${creatorName}" onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}';">
        </div>
        <div class="creator-name">${creatorName}</div>
      </div>
      ${meeting.role === 'owner' ? `<button class="meeting-menu-btn" type="button">⋮</button>` : ''}
    </div>
    ${meeting.role === 'owner' ? `<div class="meeting-menu" data-meeting-id="${meeting.id}">${menuItems}</div>` : ''}
    ${meeting.role === 'owner' ? '' : `<button class="btn-report-card" data-meeting-id="${meeting.id}">⚠️ Пожаловаться</button>`}
  `;

  card.onclick = (e) => {
    if (e.target.closest('.meeting-menu-btn') || e.target.closest('.meeting-menu') || e.target.closest('.btn-report-card')) {
      return;
    }
    window.location.href = `meeting.html?id=${meeting.id}`;
  };

  const menuBtn = card.querySelector('.meeting-menu-btn');
  if (menuBtn) {
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      toggleMeetingMenu(meeting.id, card);
    };
  }

  const reportBtn = card.querySelector('.btn-report-card');
  if (reportBtn) {
    reportBtn.onclick = (e) => {
      e.stopPropagation();
      if (typeof window.openReportModal === 'function') {
        window.openReportModal('event', meeting.id, meeting.title || 'Встреча');
      }
    };
  }

  return card;
}

function toggleMeetingMenu(meetingId, cardElement) {
  const menu = cardElement.querySelector(`[data-meeting-id="${meetingId}"].meeting-menu`);
  if (!menu) return;
  document.querySelectorAll('.meeting-menu.open').forEach(m => {
    if (m !== menu) m.classList.remove('open');
  });
  menu.classList.toggle('open');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.meeting-menu') && !e.target.closest('.meeting-menu-btn')) {
    document.querySelectorAll('.meeting-menu.open').forEach(m => m.classList.remove('open'));
  }
});

window.editMeeting = function (meetingId) {
  if (!currentUser) {
    alert('Вы должны быть авторизованы');
    return;
  }
  window.location.href = `create-meeting.html?edit=${meetingId}`;
};

window.deleteMeeting = async function (meetingId) {
  if (!currentUser) {
    alert('Вы должны быть авторизованы');
    return;
  }
  if (!confirm('Вы уверены, что хотите удалить эту встречу?')) return;

  try {
    // Ensure ownership check on the server is not implemented here; we also filter locally.
    const meeting = await api.getOne(TABLES.meetings, meetingId);
    if (!meeting || meeting.creator_id !== currentUser.id) {
      alert('Нет прав на удаление');
      return;
    }

    await api.request(`/api/meetings/${encodeURIComponent(meetingId)}/cascade`, {
      method: 'DELETE'
    });
    await loadMeetings();
  } catch (error) {
    console.error('Ошибка удаления встречи:', error);
    alert('Ошибка при удалении встречи');
  }
};

window.leaveMeeting = async function (meetingId) {
  if (!currentUser) {
    alert('Вы должны быть авторизованы');
    return;
  }
  if (!confirm('Вы уверены, что хотите покинуть эту встречу?')) return;

  try {
    const rows = await api.get(TABLES.participants, { meeting_id: meetingId, user_id: currentUser.id });
    const row = (rows || [])[0];
    if (row?.id) {
      await api.delete(TABLES.participants, row.id);
    } else {
      // Fallback
      await api.query(TABLES.participants, 'deleteWhere', {}, { meeting_id: meetingId, user_id: currentUser.id });
    }

    const meeting = await api.getOne(TABLES.meetings, meetingId);
    if (meeting) {
      if (meeting.chat_id) {
        try {
          await api.query(TABLES.chat_members, 'deleteWhere', {}, { chat_id: meeting.chat_id, user_id: currentUser.id });
        } catch (_e) {}
      }
      await api.update(TABLES.meetings, meetingId, { current_slots: Math.max(0, (meeting.current_slots || 1) - 1) });
    }

    await loadMeetings();
  } catch (error) {
    console.error('Ошибка выхода из встречи:', error);
    alert('Ошибка при выходе из встречи');
  }
};
