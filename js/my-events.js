const { TABLES } = window.APP || {};
const DEFAULT_AVATAR = 'assets/avatar.png';

let currentUser = null;
let allMeetings = [];
let TOPICS = [];
let currentFilter = 'all';
let participationNotifications = [];
let notificationsPollTimer = null;

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
  await window.cleanupExpiredMeetings();
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
    const chatMembersHasStatus = async () => {
      try {
        await api.get(TABLES.chat_members, { $limit: 1, status: 'approved' });
        return true;
      } catch (_e) {
        return false;
      }
    };

    const safeGetMeetings = async (filters) => {
      // Some deployments may not have `created_at` (or server-side ordering support).
      // Prefer DB ordering when available, otherwise sort client-side.
      try {
        return await api.get(TABLES.meetings, {
          ...filters,
          $order: { column: 'created_at', ascending: false }
        });
      } catch (_e) {
        const rows = await api.get(TABLES.meetings, filters);
        return (rows || []).sort((a, b) => {
          const ta = new Date(a?.created_at || a?.updated_at || 0).getTime();
          const tb = new Date(b?.created_at || b?.updated_at || 0).getTime();
          return tb - ta;
        });
      }
    };

    const ownedMeetings = await safeGetMeetings({ creator_id: currentUser.id });

    // Participation can be stored either in TABLES.participants (legacy "table-connector")
    // or via chat membership (chat_members -> chats.meeting_id).
    const participantMeetingIds = new Set();
    try {
      const participantRows = await api.get(TABLES.participants, { user_id: currentUser.id });
      (participantRows || []).forEach(item => {
        if (item?.meeting_id) participantMeetingIds.add(item.meeting_id);
      });
    } catch (_e) {
      // ignore
    }

    try {
      const hasStatus = await chatMembersHasStatus();
      const memberships = await api.get(TABLES.chat_members, hasStatus
        ? { user_id: currentUser.id, status: 'approved' }
        : { user_id: currentUser.id }
      );
      const chatIds = Array.from(new Set((memberships || []).map(m => m.chat_id).filter(Boolean)));
      if (chatIds.length > 0) {
        const chatsRows = await api.get(TABLES.chats, { id: { in: chatIds } });
        (chatsRows || []).forEach(chat => {
          if (chat?.meeting_id) participantMeetingIds.add(chat.meeting_id);
        });
      }
    } catch (_e) {
      // ignore
    }

    let participantMeetings = [];
    if (participantMeetingIds.size > 0) {
      participantMeetings = await safeGetMeetings({ id: { in: Array.from(participantMeetingIds) } });
    }

    // Merge + dedupe by meeting id (can happen when creator is also listed as participant).
    const byMeetingId = new Map();
    (ownedMeetings || []).forEach(m => {
      if (!m?.id) return;
      byMeetingId.set(m.id, { ...m, role: 'owner' });
    });
    (participantMeetings || []).forEach(m => {
      if (!m?.id) return;
      const existing = byMeetingId.get(m.id);
      if (existing) return;
      const role = m.creator_id === currentUser.id ? 'owner' : 'participant';
      byMeetingId.set(m.id, { ...m, role });
    });
    allMeetings = Array.from(byMeetingId.values());

    const creatorIds = Array.from(new Set(allMeetings.map(m => m.creator_id).filter(Boolean)));
    const creators = creatorIds.length > 0
      ? await api.get(TABLES.profiles, { id: { in: creatorIds } })
      : [];
    const byId = new Map((creators || []).map(p => [p.id, p]));

    allMeetings = allMeetings.map(m => ({ ...m, creator: byId.get(m.creator_id) || null }));
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
  const markAllBtn = document.getElementById('notifications-mark-all');
  if (!markAllBtn) return;

  markAllBtn.onclick = async () => {
    const unread = participationNotifications.filter(item => !item.is_read);
    if (unread.length === 0) return;

    await Promise.all(unread.map(item => markNotificationRead(item.id)));
    await loadParticipationNotifications();
  };
}

function startNotificationsPolling() {
  if (notificationsPollTimer) clearInterval(notificationsPollTimer);
  notificationsPollTimer = setInterval(async () => {
    if (!currentUser) return;
    await loadParticipationNotifications(true);
  }, 15000);
}

async function loadParticipationNotifications(silent = false) {
  if (!currentUser) return;

  try {
    const rows = await api.get(TABLES.notifications, {
      admin_profile_id: currentUser.id,
      $order: { column: 'created_at', ascending: false },
      $limit: 20
    });
    participationNotifications = (rows || []).filter(item => PARTICIPATION_NOTIFICATION_TYPES.has(item.notification_type));
    renderParticipationNotifications();
  } catch (error) {
    console.error('Ошибка загрузки уведомлений:', error);
    if (!silent) renderNotificationsError();
  }
}

function renderParticipationNotifications() {
  const list = document.getElementById('notifications-list');
  const markAllBtn = document.getElementById('notifications-mark-all');
  if (!list || !markAllBtn) return;

  const unreadCount = participationNotifications.filter(item => !item.is_read).length;
  markAllBtn.disabled = unreadCount === 0;

  if (participationNotifications.length === 0) {
    list.innerHTML = '<div class="notifications-empty">Пока нет уведомлений по участию во встречах.</div>';
    return;
  }

  list.innerHTML = '';
  participationNotifications.forEach(notification => {
    const item = document.createElement('div');
    item.className = `notification-item${notification.is_read ? '' : ' unread'}`;
    item.innerHTML = `
      <div class="notification-main">
        <div class="notification-meta">
          <span class="notification-pill">${escapeHtml(getNotificationTypeLabel(notification.notification_type))}</span>
          <span class="notification-time">${escapeHtml(formatNotificationTime(notification.created_at))}</span>
        </div>
        <div class="notification-heading">${escapeHtml(notification.title || 'Обновление по встрече')}</div>
        <div class="notification-message">${escapeHtml(notification.message || '')}</div>
      </div>
      <div class="notification-actions">
        <button type="button" class="notification-open-btn">Открыть</button>
        ${notification.is_read ? '' : '<button type="button" class="notification-read-btn">Прочитано</button>'}
      </div>
    `;

    const openBtn = item.querySelector('.notification-open-btn');
    if (openBtn) {
      openBtn.onclick = async () => {
        await handleNotificationOpen(notification);
      };
    }

    const readBtn = item.querySelector('.notification-read-btn');
    if (readBtn) {
      readBtn.onclick = async () => {
        await markNotificationRead(notification.id);
        await loadParticipationNotifications(true);
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
  if (!notification.is_read) await markNotificationRead(notification.id);
  if (notification.related_table === 'meetings' && notification.related_id) {
    window.location.href = `meeting.html?id=${notification.related_id}`;
    return;
  }
  await loadParticipationNotifications(true);
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
  if (topic?.name) return topic.name.replace(/^(\S+)\s/, '');
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

    // Keep legacy participants ("table-connector") clean.
    try {
      await api.query(TABLES.participants, 'deleteWhere', {}, { meeting_id: meetingId });
    } catch (_e) {}
    await api.delete(TABLES.meetings, meetingId);
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
      await api.update(TABLES.meetings, meetingId, { current_slots: Math.max(0, (meeting.current_slots || 1) - 1) });
    }

    await loadMeetings();
  } catch (error) {
    console.error('Ошибка выхода из встречи:', error);
    alert('Ошибка при выходе из встречи');
  }
};
