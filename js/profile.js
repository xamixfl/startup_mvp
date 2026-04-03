// Topics will be fetched from database
let TOPICS = [];
let currentUser = null;
let viewedProfile = null;
let isCurrentUserAdmin = false;
let editInterestMenuOpen = false;

const DEFAULT_AVATAR = 'assets/avatar.png';

async function ensureMembership(chatId, userId, role = 'member') {
  const { TABLES } = window.APP || {};
  const existing = await api.get(TABLES.chat_members, { chat_id: chatId, user_id: userId });
  if ((existing || []).length > 0) return;
  try {
    await api.insert(TABLES.chat_members, { chat_id: chatId, user_id: userId, role, status: 'approved' });
  } catch (_e) {
    await api.insert(TABLES.chat_members, { chat_id: chatId, user_id: userId });
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  TOPICS = await window.fetchTopics();
  currentUser = typeof window.getCurrentUser === 'function'
    ? await window.getCurrentUser()
    : await api.request('/api/auth/me');
  isCurrentUserAdmin = currentUser?.role === 'admin';

  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  const name = params.get('name');

  if (!id && !name) {
    renderEmptyProfile();
    return;
  }

  const profile = await fetchProfile(id, name);
  if (!profile) {
    renderEmptyProfile();
    return;
  }

  viewedProfile = profile;
  renderProfile(profile);
  renderMeetings(profile);
  setupEditButton();
  setupReportButton();
  setupBanButton();
});

function getLocalMeetings() {
  const raw = localStorage.getItem('pulse_meetings');
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (_e) {
    return [];
  }
}

async function fetchProfile(id, name) {
  try {
    if (id) return await api.getOne('profiles', id);
    if (name) {
      const rows = await api.get('profiles', { username: name, $limit: 1 });
      return (rows || [])[0] || null;
    }
  } catch (error) {
    console.error('Ошибка загрузки профиля:', error);
  }
  return null;
}

function renderProfile(profile) {
  const avatar = document.getElementById('profile-avatar');
  const displayName = profile.full_name || profile.username || 'Пользователь';
  const avatarUrl = profile.photo_URL && profile.photo_URL !== 'user'
    ? profile.photo_URL
    : DEFAULT_AVATAR;

  if (avatar) {
    avatar.innerHTML = `<img src="${avatarUrl}" alt="${displayName}" onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}';">`;
    const modal = document.getElementById('avatar-modal');
    const modalImg = document.getElementById('avatar-modal-img');
    const modalClose = document.getElementById('avatar-modal-close');

    const closeModal = () => {
      if (!modal) return;
      modal.style.display = 'none';
      if (modalImg) modalImg.src = '';
      document.removeEventListener('keydown', onKeydown);
    };

    const onKeydown = (e) => {
      if (e.key === 'Escape') closeModal();
    };

    avatar.onclick = () => {
      if (!modal || !modalImg) return;
      modalImg.src = avatarUrl;
      modal.style.display = 'flex';
      document.addEventListener('keydown', onKeydown);
    };
    if (modal) {
      modal.onclick = (e) => {
        // Close only when clicking the overlay, not the image itself.
        if (e.target === modal) closeModal();
      };
    }
    if (modalClose) {
      modalClose.onclick = (e) => {
        e.stopPropagation();
        closeModal();
      };
    }
  }

  const nameEl = document.getElementById('profile-name');
  if (nameEl) nameEl.textContent = displayName;

  const metaEl = document.getElementById('profile-meta');
  if (metaEl) metaEl.textContent = profile.age ? `${profile.age} лет` : 'Возраст не указан';

  const cityEl = document.getElementById('profile-city');
  if (cityEl) cityEl.textContent = profile.location || 'Город не указан';

  const aboutEl = document.getElementById('profile-about');
  if (aboutEl) aboutEl.textContent = profile.about || profile.bio || profile.description || 'О себе: —';

  const messageBtn = document.getElementById('message-btn');
  if (messageBtn) {
    if (currentUser && profile.id && currentUser.id !== profile.id) {
      messageBtn.style.display = 'block';
      messageBtn.onclick = () => createDirectChat(profile);
    } else {
      messageBtn.style.display = 'none';
    }
  }

  const interestsWrap = document.getElementById('profile-interests');
  if (interestsWrap) {
    interestsWrap.innerHTML = '';
    (profile.interests || []).forEach(topicId => {
      const topic = TOPICS.find(item => item.id === topicId);
      const pill = document.createElement('div');
      pill.className = 'interest-pill';
      pill.textContent = topic
        ? getTopicDisplayName(topic)
        : normalizeInterestLabel(topicId);
      interestsWrap.appendChild(pill);
    });
  }
}

async function createDirectChat(profile) {
  if (!currentUser) {
    window.location.href = 'login.html';
    return;
  }
  const { TABLES } = window.APP || {};

  try {
    // Find existing direct chat (no meeting_id) between two users
    const myMemberships = await api.get(TABLES.chat_members, { user_id: currentUser.id, status: 'approved' });
    const myChatIds = (myMemberships || []).map(m => m.chat_id).filter(Boolean);

    if (myChatIds.length > 0) {
      const otherMemberships = await api.get(TABLES.chat_members, {
        user_id: profile.id,
        status: 'approved',
        chat_id: { in: myChatIds }
      });
      const commonChatIds = (otherMemberships || []).map(m => m.chat_id).filter(Boolean);
      if (commonChatIds.length > 0) {
        const chats = await api.get(TABLES.chats, { id: { in: commonChatIds } });
        const direct = (chats || []).find(c => !c.meeting_id);
        if (direct) {
          window.location.href = `chat.html?chat_id=${direct.id}`;
          return;
        }
      }
    }

    const title = profile.full_name || profile.username || 'Чат';
    const pairChats = await api.get(TABLES.chats, {
      meeting_id: null,
      owner_id: { in: [currentUser.id, profile.id] },
      peer_id: { in: [currentUser.id, profile.id] }
    });
    const archivedDirect = (pairChats || []).find(chat =>
      !chat.meeting_id
      && (
        (chat.owner_id === currentUser.id && chat.peer_id === profile.id)
        || (chat.owner_id === profile.id && chat.peer_id === currentUser.id)
      )
    );

    if (archivedDirect?.id) {
      await ensureMembership(
        archivedDirect.id,
        currentUser.id,
        archivedDirect.owner_id === currentUser.id ? 'owner' : 'member'
      );
      await ensureMembership(
        archivedDirect.id,
        profile.id,
        archivedDirect.owner_id === profile.id ? 'owner' : 'member'
      );
      window.location.href = `chat.html?chat_id=${archivedDirect.id}`;
      return;
    }

    const inserted = await api.insert(TABLES.chats, {
      meeting_id: null,
      title,
      owner_id: currentUser.id,
      peer_id: profile.id
    });
    const chat = Array.isArray(inserted) ? inserted[0] : null;
    if (!chat?.id) throw new Error('Chat not created');

    await api.insert(TABLES.chat_members, { chat_id: chat.id, user_id: currentUser.id, role: 'owner', status: 'approved' });
    await api.insert(TABLES.chat_members, { chat_id: chat.id, user_id: profile.id, role: 'member', status: 'approved' });

    window.location.href = `chat.html?chat_id=${chat.id}`;
  } catch (error) {
    console.error('Ошибка создания личного чата:', error);
    alert('Не удалось создать личный чат.');
  }
}

function normalizeInterestLabel(id) {
  const fallbackMap = {
    boardgames: '🎲 Настольные игры',
    tennis: '🎾 Теннис',
    football: '⚽ Футбол',
    running: '🏃 Бег',
    coffee: '☕ Кофе',
    cinema: '🎬 Кино',
    language: '🗣️ Языковая практика',
    hiking: '🥾 Походы',
    music: '🎵 Музыка',
    photography: '📷 Фотография'
  };
  return fallbackMap[id] || id;
}

function renderMeetings(profile) {
  const list = document.getElementById('meeting-list');
  if (!list) return;
  list.innerHTML = '';

  if (currentUser && currentUser.id === profile.id) {
    fetchUserMeetings(profile, list);
  } else {
    fetchMeetingsForProfile(profile, list);
  }
}

function renderEmptyProfile() {
  const nameEl = document.getElementById('profile-name');
  if (nameEl) nameEl.textContent = 'Профиль не найден';
  const metaEl = document.getElementById('profile-meta');
  if (metaEl) metaEl.textContent = '';
  const cityEl = document.getElementById('profile-city');
  if (cityEl) cityEl.textContent = '';
  const interests = document.getElementById('profile-interests');
  if (interests) interests.innerHTML = '';
  const list = document.getElementById('meeting-list');
  if (list) {
    list.innerHTML = '';
    renderMeetingsEmpty(list);
  }
}

async function fetchUserMeetings(profile, list) {
  try {
    const { TABLES } = window.APP || {};
    const created = await api.get(TABLES.meetings, {
      creator_id: profile.id,
      $order: { column: 'created_at', ascending: false }
    });

    // Joined meetings can be tracked via legacy participants ("table-connector") or via chat membership.
    let meetingIds = [];
    try {
      const memberships = await api.get(TABLES.participants, { user_id: profile.id });
      meetingIds = Array.from(new Set((memberships || []).map(m => m.meeting_id).filter(Boolean)));
    } catch (_e) {
      meetingIds = [];
    }

    try {
      // chat_members -> chats.meeting_id
      let hasStatus = true;
      try {
        await api.get(TABLES.chat_members, { $limit: 1, status: 'approved' });
        hasStatus = true;
      } catch (_e2) {
        hasStatus = false;
      }

      const rows = await api.get(TABLES.chat_members, hasStatus
        ? { user_id: profile.id, status: 'approved' }
        : { user_id: profile.id }
      );
      const chatIds = Array.from(new Set((rows || []).map(r => r.chat_id).filter(Boolean)));
      if (chatIds.length) {
        const chats = await api.get(TABLES.chats, { id: { in: chatIds } });
        const ids2 = (chats || []).map(c => c.meeting_id).filter(Boolean);
        meetingIds = Array.from(new Set([...meetingIds, ...ids2]));
      }
    } catch (_e) {
      // ignore
    }

    let joined = [];
    if (meetingIds.length) joined = await api.get(TABLES.meetings, { id: { in: meetingIds } });

    const merged = [...(created || []), ...(joined || [])];
    const uniqueMeetings = Array.from(new Map(merged.map(m => [m.id, m])).values());

    if (uniqueMeetings.length === 0) {
      renderMeetingsEmpty(list);
      return;
    }

    renderMeetingsList(uniqueMeetings, list);
  } catch (error) {
    console.error('Ошибка загрузки встреч пользователя:', error);
    renderMeetingsEmpty(list);
  }
}

async function fetchMeetingsForProfile(profile, list) {
  try {
    const data = await api.get('meetings', {
      creator_id: profile.id,
      $order: { column: 'created_at', ascending: false }
    });
    if (!data || data.length === 0) {
      renderMeetingsEmpty(list);
      return;
    }
    renderMeetingsList(data, list);
  } catch (error) {
    console.error('Ошибка загрузки встреч профиля:', error);
    renderMeetingsEmpty(list);
  }
}

function renderMeetingsList(meetings, list) {
  meetings.forEach(meeting => {
    const topic = TOPICS.find(item => item.id === meeting.topic) || TOPICS[TOPICS.length - 1];
    const item = document.createElement('div');
    item.className = 'meeting-item';

    const showMenu = currentUser && currentUser.id === viewedProfile?.id;
    const isCreator = currentUser && currentUser.id === meeting.creator_id;

    const menuItems = isCreator
      ? `<button class="meeting-menu-item" onclick="window.editMeeting('${meeting.id}')">✏️ Редактировать</button>
         <button class="meeting-menu-item danger" onclick="window.deleteMeeting('${meeting.id}')">🗑️ Удалить встречу</button>
         <button class="meeting-menu-item" onclick="window.shareMeeting('${meeting.id}')">Поделиться</button>`
      : `<button class="meeting-menu-item" onclick="window.leaveMeeting('${meeting.id}')">Покинуть</button>
         <button class="meeting-menu-item" onclick="window.shareMeeting('${meeting.id}')">Поделиться</button>`;

    item.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start;">
        <div style="flex: 1;">
          <div class="meeting-tag">#${(topic?.name || 'Встреча').replace(/^(\S+)\s/, '')}</div>
          <div class="meeting-headline">${meeting.title || 'Без названия'}</div>
          <div class="meeting-info">
            <span>👥 ${meeting.current_slots || 0}/${meeting.max_slots || 0}</span>
            <span>📍 ${meeting.location || 'Город не указан'}</span>
          </div>
        </div>
        ${showMenu ? `<button class="meeting-menu-btn" data-meeting-id="${meeting.id}">⋮</button>` : ''}
      </div>
      <div class="meeting-menu" data-meeting-id="${meeting.id}">
        ${menuItems}
      </div>
    `;

    item.onclick = (e) => {
      if (e.target.closest('.meeting-menu-btn') || e.target.closest('.meeting-menu')) {
        e.stopPropagation();
        return;
      }
      window.location.href = `meeting.html?id=${meeting.id}`;
    };

    const menuBtn = item.querySelector('.meeting-menu-btn');
    if (menuBtn) {
      menuBtn.onclick = (e) => {
        e.stopPropagation();
        toggleMeetingMenu(meeting.id, item);
      };
    }

    list.appendChild(item);
  });
}

function toggleMeetingMenu(meetingId, itemElement) {
  const menu = itemElement.querySelector(`[data-meeting-id="${meetingId}"].meeting-menu`);
  if (!menu) return;
  document.querySelectorAll('.meeting-menu.open').forEach(m => {
    if (m !== menu) m.classList.remove('open');
  });
  menu.classList.toggle('open');
}

window.editMeeting = function (meetingId) {
  window.location.href = `create-meeting.html?edit=${meetingId}`;
};

window.shareMeeting = async function (meetingId) {
  const url = `${window.location.origin}${window.location.pathname.replace(/profile\\.html.*$/i, 'meeting.html')}?id=${meetingId}`;
  try {
    await navigator.clipboard.writeText(url);
    alert('Ссылка скопирована');
  } catch (_e) {
    prompt('Скопируйте ссылку:', url);
  }
};

window.leaveMeeting = async function (meetingId) {
  if (!currentUser) {
    alert('Вы должны быть авторизованы');
    return;
  }
  if (!confirm('Вы действительно хотите покинуть эту встречу?')) return;

  try {
    const { TABLES } = window.APP || {};
    const participants = await api.get(TABLES.participants, { meeting_id: meetingId, user_id: currentUser.id });
    if (!participants || participants.length === 0) {
      alert('Вы не участник этой встречи');
      return;
    }
    await api.query(TABLES.participants, 'deleteWhere', {}, { meeting_id: meetingId, user_id: currentUser.id });

    const meeting = await api.getOne(TABLES.meetings, meetingId);
    if (meeting) {
      await api.update(TABLES.meetings, meetingId, { current_slots: Math.max((meeting.current_slots || 1) - 1, 0) });
      if (meeting.chat_id) {
        await api.query(TABLES.chat_members, 'deleteWhere', {}, { chat_id: meeting.chat_id, user_id: currentUser.id });
      }
    }

    alert('Вы покинули встречу');
    location.reload();
  } catch (error) {
    console.error('Ошибка покидания встречи:', error);
    alert('Ошибка: ' + (error.message || String(error)));
  }
};

window.deleteMeeting = async function (meetingId) {
  if (!currentUser) {
    alert('Вы должны быть авторизованы');
    return;
  }
  if (!confirm('Удалить встречу?')) return;

  try {
    const { TABLES } = window.APP || {};
    const meeting = await api.getOne(TABLES.meetings, meetingId);
    if (!meeting) {
      alert('Встреча не найдена');
      return;
    }
    if (meeting.creator_id !== currentUser.id) {
      alert('Вы не являетесь создателем этой встречи');
      return;
    }

    if (meeting.chat_id) {
      await api.query(TABLES.chat_members, 'deleteWhere', {}, { chat_id: meeting.chat_id });
      await api.query(TABLES.chat_messages, 'deleteWhere', {}, { chat_id: meeting.chat_id });
      await api.delete(TABLES.chats, meeting.chat_id);
    }

    await api.query(TABLES.participants, 'deleteWhere', {}, { meeting_id: meetingId });
    await api.delete(TABLES.meetings, meetingId);

    alert('Встреча удалена');
    location.reload();
  } catch (error) {
    console.error('Ошибка при удалении встречи:', error);
    alert('Ошибка: ' + (error.message || String(error)));
  }
};

document.addEventListener('click', (e) => {
  if (!e.target.closest('.meeting-item')) {
    document.querySelectorAll('.meeting-menu.open').forEach(menu => menu.classList.remove('open'));
  }
});

function renderMeetingsEmpty(list) {
  const empty = document.createElement('div');
  empty.style.color = '#94a3b8';
  empty.textContent = 'Пока нет запланированных встреч';
  list.appendChild(empty);
}

function setupEditButton() {
  const editBtn = document.getElementById('edit-btn');
  const logoutBtn = document.getElementById('logout-btn');
  if (!editBtn || !logoutBtn) return;

  if (currentUser && viewedProfile && currentUser.id === viewedProfile.id) {
    editBtn.style.display = 'block';
    editBtn.onclick = openEditModal;
    logoutBtn.style.display = 'block';
    logoutBtn.onclick = handleLogout;
  } else {
    editBtn.style.display = 'none';
    logoutBtn.style.display = 'none';
  }
}

function setupReportButton() {
  const reportBtn = document.getElementById('report-btn');
  if (!reportBtn) return;
  if (!currentUser || !viewedProfile || currentUser.id === viewedProfile.id) {
    reportBtn.style.display = 'none';
    return;
  }
  reportBtn.style.display = 'block';
  reportBtn.onclick = () => {
    if (typeof window.openReportModal !== 'function') {
      alert('Модуль жалоб не загружен');
      return;
    }
    const info = {
      name: viewedProfile.full_name || viewedProfile.username || viewedProfile.id
    };
    window.openReportModal('user', viewedProfile.id, info);
  };
}

function setupBanButton() {
  const banBtn = document.getElementById('ban-btn');
  if (!banBtn) return;
  if (!currentUser || !isCurrentUserAdmin || !viewedProfile || currentUser.id === viewedProfile.id) {
    banBtn.style.display = 'none';
    return;
  }
  banBtn.style.display = 'block';
  updateBanButtonLabel(banBtn);
  banBtn.onclick = async () => {
    const isBanned = viewedProfile?.role === 'banned';
    const nextRole = isBanned ? 'user' : 'banned';
    const ok = confirm(isBanned ? 'Разблокировать пользователя?' : 'Заблокировать пользователя?');
    if (!ok) return;
    try {
      await api.update('profiles', viewedProfile.id, { role: nextRole });
      viewedProfile.role = nextRole;
      updateBanButtonLabel(banBtn);
      alert(isBanned ? 'Пользователь разблокирован' : 'Пользователь заблокирован');
    } catch (e) {
      console.error('Ban update error:', e);
      alert('Не удалось изменить статус пользователя');
    }
  };
}

function updateBanButtonLabel(btn) {
  if (!btn) return;
  const isBanned = viewedProfile?.role === 'banned';
  btn.textContent = isBanned ? '✅ Разблокировать' : '🚫 Заблокировать';
  btn.classList.toggle('blocked', isBanned);
}

function openEditModal() {
  if (!viewedProfile) return;
  const modal = document.getElementById('edit-modal');
  if (!modal) return;

  document.getElementById('edit-name').value = viewedProfile.full_name || '';
  document.getElementById('edit-nickname').value = viewedProfile.username || '';
  document.getElementById('edit-age').value = viewedProfile.age || '';
  document.getElementById('edit-location').value = viewedProfile.location || '';
  document.getElementById('edit-about').value = viewedProfile.about || viewedProfile.bio || viewedProfile.description || '';

  const preview = document.getElementById('photo-preview');
  if (preview) {
    const url = viewedProfile.photo_URL && viewedProfile.photo_URL !== 'user' ? viewedProfile.photo_URL : DEFAULT_AVATAR;
    preview.innerHTML = `<img src="${url}" alt="photo">`;
  }

  renderEditInterests();
  setupEditInterestsDropdown();
  setupEditPhotoPreview();
  setupEditFormSubmit();

  modal.style.display = 'flex';
}

function closeEditModal() {
  const modal = document.getElementById('edit-modal');
  if (modal) modal.style.display = 'none';
}
window.closeEditModal = closeEditModal;

function renderEditInterests() {
  const container = document.getElementById('edit-interests-container');
  if (!container) return;
  container.innerHTML = '';

  const groups = typeof window.groupTopicsForDisplay === 'function'
    ? window.groupTopicsForDisplay(TOPICS)
    : [{ title: 'Интересы', items: TOPICS }];

  groups.forEach(group => {
    const groupEl = document.createElement('section');
    groupEl.className = 'interest-group';

    const title = document.createElement('div');
    title.className = 'interest-group-title';
    title.textContent = group.title;
    groupEl.appendChild(title);

    const itemsWrap = document.createElement('div');
    itemsWrap.className = 'interest-group-items';

    group.items.forEach(topic => {
      const isChecked = (viewedProfile.interests || []).includes(topic.id);
      const wrapper = document.createElement('div');
      wrapper.className = 'interest-checkbox-wrapper';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'interest-checkbox-input';
      input.id = `interest-${topic.id}`;
      input.value = topic.id;
      input.checked = isChecked;

      const label = document.createElement('label');
      label.className = 'interest-checkbox-label';
      label.htmlFor = input.id;
      label.textContent = typeof window.getTopicDisplayName === 'function'
        ? window.getTopicDisplayName(topic)
        : topic.name;

      wrapper.appendChild(input);
      wrapper.appendChild(label);
      itemsWrap.appendChild(wrapper);
    });

    groupEl.appendChild(itemsWrap);
    container.appendChild(groupEl);
  });

  container.onchange = () => updateEditSelectedInterests();
  updateEditSelectedInterests();
  filterEditInterestsList(document.getElementById('edit-interest-search')?.value || '');
}

function setupEditInterestsDropdown() {
  const selector = document.getElementById('edit-interest-selector');
  const trigger = document.getElementById('edit-interest-trigger');
  const search = document.getElementById('edit-interest-search');
  if (!selector || !trigger || !search) return;

  if (!selector.dataset.bound) {
    trigger.addEventListener('click', () => {
      if (editInterestMenuOpen) closeEditInterestsMenu();
      else openEditInterestsMenu();
    });

    search.addEventListener('input', e => filterEditInterestsList(e.target.value));

    document.addEventListener('click', e => {
      if (!selector.contains(e.target)) closeEditInterestsMenu();
    });

    selector.dataset.bound = 'true';
  }

  closeEditInterestsMenu();
}

function openEditInterestsMenu() {
  const trigger = document.getElementById('edit-interest-trigger');
  const menu = document.getElementById('edit-interest-menu');
  const search = document.getElementById('edit-interest-search');
  if (!trigger || !menu) return;

  editInterestMenuOpen = true;
  trigger.classList.add('open');
  trigger.setAttribute('aria-expanded', 'true');
  menu.classList.add('open');

  if (search) {
    search.focus();
    filterEditInterestsList(search.value || '');
  }
}

function closeEditInterestsMenu() {
  const trigger = document.getElementById('edit-interest-trigger');
  const menu = document.getElementById('edit-interest-menu');
  const empty = document.getElementById('edit-interest-empty');
  if (!trigger || !menu) return;

  editInterestMenuOpen = false;
  trigger.classList.remove('open');
  trigger.setAttribute('aria-expanded', 'false');
  menu.classList.remove('open');
  if (empty) empty.style.display = 'none';
}

function filterEditInterestsList(query) {
  const container = document.getElementById('edit-interests-container');
  const empty = document.getElementById('edit-interest-empty');
  if (!container) return;

  const normalized = String(query || '').trim().toLowerCase();
  let visible = 0;
  container.querySelectorAll('.interest-group').forEach(group => {
    let groupVisible = 0;
    group.querySelectorAll('.interest-checkbox-wrapper').forEach(item => {
      const text = (item.textContent || '').toLowerCase();
      const matches = !normalized || text.includes(normalized);
      item.style.display = matches ? 'inline-flex' : 'none';
      if (matches) {
        visible += 1;
        groupVisible += 1;
      }
    });
    group.style.display = groupVisible > 0 ? '' : 'none';
  });

  if (empty) empty.style.display = visible === 0 ? 'block' : 'none';
}

function updateEditSelectedInterests() {
  const selectedIds = Array.from(document.querySelectorAll('#edit-interests-container input[type="checkbox"]:checked'))
    .map(input => input.value);

  const pills = document.getElementById('edit-selected-interests');
  const triggerText = document.getElementById('edit-interest-trigger-text');
  if (pills) pills.innerHTML = '';

  if (selectedIds.length === 0) {
    if (triggerText) triggerText.textContent = 'Выберите интересы';
    return;
  }

  if (triggerText) triggerText.textContent = `Выбрано: ${selectedIds.length}`;
  if (!pills) return;

  selectedIds.forEach(id => {
    const topic = TOPICS.find(item => String(item.id) === String(id));
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'edit-selected-interest-pill';
    pill.textContent = topic
      ? (typeof window.getTopicDisplayName === 'function' ? window.getTopicDisplayName(topic) : topic.name)
      : id;
    pill.addEventListener('click', () => removeEditSelectedInterest(id));
    pills.appendChild(pill);
  });
}

function removeEditSelectedInterest(id) {
  const checkbox = document.querySelector(`#edit-interests-container input[value="${CSS.escape(String(id))}"]`);
  if (!checkbox) return;
  checkbox.checked = false;
  updateEditSelectedInterests();
}

function setupEditPhotoPreview() {
  const fileInput = document.getElementById('edit-photo');
  const preview = document.getElementById('photo-preview');
  if (!fileInput || !preview) return;

  fileInput.onchange = () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      alert('Можно загружать только изображения');
      fileInput.value = '';
      return;
    }
    const url = URL.createObjectURL(file);
    preview.innerHTML = `<img src="${url}" alt="preview">`;
  };
}

function setupEditFormSubmit() {
  const form = document.getElementById('edit-form');
  if (!form) return;

  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!currentUser || !viewedProfile || currentUser.id !== viewedProfile.id) return;

    const full_name = document.getElementById('edit-name').value.trim();
    const username = document.getElementById('edit-nickname').value.trim();
    const ageRaw = document.getElementById('edit-age').value;
    const location = document.getElementById('edit-location').value.trim();
    const about = document.getElementById('edit-about').value.trim();

    const age = ageRaw ? Number(ageRaw) : null;
    const interests = Array.from(document.querySelectorAll('#edit-interests-container input[type="checkbox"]:checked'))
      .map(el => el.value);

    let photo_URL = viewedProfile.photo_URL;
    const fileInput = document.getElementById('edit-photo');
    const file = fileInput && fileInput.files && fileInput.files[0];
    if (file) {
      try {
        const compressedFile = typeof window.compressImageFile === 'function'
          ? await window.compressImageFile(file, { maxWidth: 1200, maxHeight: 1200, maxBytes: 900 * 1024, quality: 0.8 })
          : file;
        const fd = new FormData();
        fd.append('file', compressedFile);
      const resp = await fetch('/api/upload/avatar', {
        method: 'POST',
        credentials: 'same-origin',
        headers: typeof api?.buildHeaders === 'function' ? api.buildHeaders({ method: 'POST', body: fd }) : {},
        body: fd
      });
        if (!resp.ok) throw new Error(`upload failed: ${resp.status}`);
        const json = await resp.json();
        photo_URL = json && json.url ? json.url : photo_URL;
      } catch (err) {
        console.error('Avatar upload error:', err);
        alert('Не удалось загрузить фото');
        return;
      }
    }

    try {
      const updated = await api.request('/api/users/profile', {
        method: 'PUT',
        body: JSON.stringify({
          full_name,
          username,
          age,
          location,
          about,
          interests,
          photo_URL
        })
      });
      viewedProfile = updated;
      renderProfile(viewedProfile);
      closeEditModal();
    } catch (error) {
      console.error('Profile update error:', error);
      alert('Не удалось сохранить профиль');
    }
  };
}

async function handleLogout() {
  try {
    await api.request('/api/auth/logout', { method: 'POST' });
  } catch (_e) {
    // ignore
  }
  window.location.href = 'index.html';
}
