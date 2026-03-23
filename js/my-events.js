const { TABLES } = window.APP || {};
const DEFAULT_AVATAR = 'assets/avatar.png';

let currentUser = null;
let allMeetings = [];
let TOPICS = [];
let currentFilter = 'all';

document.addEventListener('DOMContentLoaded', async () => {
  currentUser = await window.getCurrentUser();
  if (!currentUser) {
    window.location.href = 'login.html';
    return;
  }

  TOPICS = await window.fetchTopics();
  await window.cleanupExpiredMeetings();
  await loadMeetings();
  setupTabs();
});

async function loadMeetings() {
  if (!currentUser) return;
  const container = document.getElementById('meetings-container');
  if (container) {
    container.innerHTML = '<div style="text-align: center; padding: 40px; color: #94a3b8;">Загрузка...</div>';
  }

  try {
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

    const participantRows = await api.get(TABLES.participants, { user_id: currentUser.id });
    const participantMeetingIds = (participantRows || []).map(p => p.meeting_id).filter(Boolean);

    let participantMeetings = [];
    if (participantMeetingIds.length > 0) {
      participantMeetings = await safeGetMeetings({ id: { in: participantMeetingIds } });
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
          <img src="${creatorAvatar}" alt="${creatorName}">
        </div>
        <div class="creator-name">${creatorName}</div>
      </div>
      ${meeting.role === 'owner' ? `<button class="meeting-menu-btn" type="button">⋮</button>` : ''}
    </div>
    ${meeting.role === 'owner' ? `<div class="meeting-menu" data-meeting-id="${meeting.id}">${menuItems}</div>` : ''}
    <button class="btn-report-card" data-meeting-id="${meeting.id}">⚠️ Пожаловаться</button>
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
