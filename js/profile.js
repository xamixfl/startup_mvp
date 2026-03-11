// Topics will be fetched from database
let TOPICS = [];
let currentUser = null;
let viewedProfile = null;
let isCurrentUserBanned = false;

document.addEventListener('DOMContentLoaded', async () => {
  TOPICS = await window.fetchTopics();
  const { data: { user } } = await window.APP.supabase.auth.getUser();
  currentUser = user || null;
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

const DEFAULT_AVATAR = 'assets/avatar.png';

function getLocalMeetings() {
  const raw = localStorage.getItem('pulse_meetings');
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (error) {
    return [];
  }
}

async function fetchProfile(id, name) {
  const supabaseClient = window.APP?.supabase;
  if (!supabaseClient) return null;

  try {
    if (id) {
      const { data, error } = await supabaseClient
        .from('profiles')
        .select('*')
        .eq('id', id)
        .single();
      if (error) throw error;
      return data;
    }

    if (name) {
      const { data, error } = await supabaseClient
        .from('profiles')
        .select('*')
        .eq('username', name)
        .maybeSingle();
      if (error) throw error;
      return data;
    }
  } catch (error) {
    console.error('Ошибка загрузки профиля:', error);
    return null;
  }

  return null;
}

function renderProfile(profile) {
  const avatar = document.getElementById('profile-avatar');
  const displayName = profile.full_name || profile.username || 'Пользователь';
  const avatarUrl = profile.photo_URL && profile.photo_URL !== 'user'
    ? profile.photo_URL
    : DEFAULT_AVATAR;
  avatar.innerHTML = `<img src="${avatarUrl}" alt="${displayName}">`;

  document.getElementById('profile-name').textContent = displayName;
  document.getElementById('profile-meta').textContent = profile.age ? `${profile.age} лет` : 'Возраст не указан';
  document.getElementById('profile-city').textContent = profile.location || 'Город не указан';
  document.getElementById('profile-about').textContent = profile.about || profile.bio || profile.description || 'О себе: —';

  const modal = document.getElementById('avatar-modal');
  const modalImg = document.getElementById('avatar-modal-img');
  avatar.onclick = () => {
    if (!modal || !modalImg) return;
    modalImg.src = avatarUrl;
    modal.style.display = 'flex';
  };
  if (modal) {
    modal.onclick = () => {
      modal.style.display = 'none';
    };
  }

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
  interestsWrap.innerHTML = '';
  (profile.interests || []).forEach(id => {
    const topic = TOPICS.find(item => item.id === id);
    const pill = document.createElement('div');
    pill.className = 'interest-pill';
    pill.textContent = topic ? topic.name : normalizeInterestLabel(id);
    interestsWrap.appendChild(pill);
  });
}

async function createDirectChat(profile) {
  if (!currentUser) {
    window.location.href = 'login.html';
    return;
  }
  const { TABLES } = window.APP;
  try {
    const { data: myMemberships } = await window.APP.supabase
      .from(TABLES.chat_members)
      .select('chat_id')
      .eq('user_id', currentUser.id)
      .eq('status', 'approved');

    const myChatIds = (myMemberships || []).map(m => m.chat_id);
    if (myChatIds.length > 0) {
      const { data: otherMemberships } = await window.APP.supabase
        .from(TABLES.chat_members)
        .select('chat_id')
        .eq('user_id', profile.id)
        .eq('status', 'approved')
        .in('chat_id', myChatIds);

      const commonChatIds = (otherMemberships || []).map(m => m.chat_id);
      if (commonChatIds.length > 0) {
        const { data: existingChats } = await window.APP.supabase
          .from(TABLES.chats)
          .select('id, meeting_id')
          .in('id', commonChatIds);
        const direct = (existingChats || []).find(c => !c.meeting_id);
        if (direct) {
          window.location.href = `chat.html?chat_id=${direct.id}`;
          return;
        }
      }
    }

    const title = profile.full_name || profile.username || 'Чат';
    const { data: chat, error: chatError } = await window.APP.supabase
      .from(TABLES.chats)
      .insert([{
        meeting_id: null,
        title,
        owner_id: currentUser.id,
        peer_id: profile.id
      }])
      .select()
      .single();
    if (chatError) throw chatError;

    const { error: ownerInsertError } = await window.APP.supabase
      .from(TABLES.chat_members)
      .insert([
        { chat_id: chat.id, user_id: currentUser.id, role: 'owner', status: 'approved' }
      ]);
    if (ownerInsertError) {
      await window.APP.supabase.from(TABLES.chats).delete().eq('id', chat.id);
      throw ownerInsertError;
    }

    const { error: peerInsertError } = await window.APP.supabase
      .from(TABLES.chat_members)
      .insert([
        { chat_id: chat.id, user_id: profile.id, role: 'member', status: 'approved' }
      ]);
    if (peerInsertError) {
      await window.APP.supabase.from(TABLES.chat_members).delete().eq('chat_id', chat.id);
      await window.APP.supabase.from(TABLES.chats).delete().eq('id', chat.id);
      throw peerInsertError;
    }

    window.location.href = `chat.html?chat_id=${chat.id}`;
  } catch (error) {
    console.error('Ошибка создания личного чата:', error);
    alert('Не удалось создать личный чат. Проверьте RLS политики.');
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

  if (fallbackMap[id]) return fallbackMap[id];
  return id;
}

function renderMeetings(profile) {
  const list = document.getElementById('meeting-list');
  list.innerHTML = '';

  // If viewing own profile, show both created and joined meetings
  if (currentUser && currentUser.id === profile.id) {
    fetchUserMeetings(profile, list);
  } else {
    // If viewing others profile, show only their created meetings
    fetchMeetingsForProfile(profile, list);
  }
}

function renderEmptyProfile() {
  document.getElementById('profile-name').textContent = 'Профиль не найден';
  document.getElementById('profile-meta').textContent = '';
  document.getElementById('profile-city').textContent = '';
  document.getElementById('profile-interests').innerHTML = '';
  const list = document.getElementById('meeting-list');
  list.innerHTML = '';
  const empty = document.createElement('div');
  empty.style.color = '#94a3b8';
  empty.textContent = 'Нет данных профиля';
  list.appendChild(empty);
}

async function fetchUserMeetings(profile, list) {
  const supabaseClient = window.APP?.supabase;
  if (!supabaseClient || !profile?.id) {
    renderMeetingsEmpty(list);
    return;
  }

  try {
    const { TABLES } = window.APP;

    // First, clean up meetings with 0 current_slots
    await supabaseClient
      .from('meetings')
      .delete()
      .eq('current_slots', 0);

    // Fetch created meetings
    const { data: createdData, error: createdError } = await supabaseClient
      .from('meetings')
      .select('id, title, topic, location, max_slots, current_slots, creator_id')
      .eq('creator_id', profile.id)
      .order('created_at', { ascending: false });

    if (createdError) throw createdError;

    // Fetch joined meetings
    const { data: participantData, error: participantError } = await supabaseClient
      .from(TABLES.participants)
      .select('meeting_id')
      .eq('user_id', profile.id);

    if (participantError) throw participantError;

    const joinedMeetingIds = (participantData || []).map(p => p.meeting_id);
    let joinedData = [];

    if (joinedMeetingIds.length > 0) {
      const { data: meetings, error: meetingsError } = await supabaseClient
        .from('meetings')
        .select('id, title, topic, location, max_slots, current_slots, creator_id')
        .in('id', joinedMeetingIds)
        .order('created_at', { ascending: false });

      if (!meetingsError && meetings) {
        joinedData = meetings;
      }
    }

    // Combine and remove duplicates
    const allMeetings = [...(createdData || []), ...(joinedData || [])];
    const uniqueMeetings = Array.from(
      new Map(allMeetings.map(m => [m.id, m])).values()
    ).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

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

function renderMeetingsList(meetings, list) {
  console.log('Rendering meetings:', meetings.length);
  console.log('Current user:', currentUser?.id);
  console.log('Viewed profile:', viewedProfile?.id);

  meetings.forEach(meeting => {
    const topic = TOPICS.find(item => item.id === meeting.topic) || TOPICS[TOPICS.length - 1];
    const item = document.createElement('div');
    item.className = 'meeting-item';

    // Show menu button when viewing own profile
    const showMenu = currentUser && currentUser.id === viewedProfile?.id;
    const isCreator = currentUser && currentUser.id === meeting.creator_id;

    console.log(`Meeting ${meeting.id}: showMenu=${showMenu}, isCreator=${isCreator}`);

    const menuItems = isCreator
      ? `<button class="meeting-menu-item" onclick="window.editMeeting('${meeting.id}')">✏️ Редактировать</button>
         <button class="meeting-menu-item danger" onclick="window.deleteMeeting('${meeting.id}')">🗑️ Удалить встречу</button>
         <button class="meeting-menu-item" onclick="window.shareMeeting('${meeting.id}')">Поделиться</button>`
      : `<button class="meeting-menu-item" onclick="window.leaveMeeting('${meeting.id}')">Покинуть</button>
         <button class="meeting-menu-item" onclick="window.shareMeeting('${meeting.id}')">Поделиться</button>`;

    item.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start;">
        <div style="flex: 1;">
          <div class="meeting-tag">#${topic.name.replace(/^(\S+)\s/, '')}</div>
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
      // Don't navigate if clicking menu button or menu
      if (e.target.closest('.meeting-menu-btn') || e.target.closest('.meeting-menu')) {
        e.stopPropagation();
        return;
      }
      window.location.href = `meeting.html?id=${meeting.id}`;
    };

    // Setup menu button
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
  console.log('Toggling menu for meeting:', meetingId);
  const menu = itemElement.querySelector(`[data-meeting-id="${meetingId}"].meeting-menu`);
  if (!menu) {
    console.error('Menu not found for meeting:', meetingId);
    return;
  }

  // Close other menus
  document.querySelectorAll('.meeting-menu.open').forEach(m => {
    if (m !== menu) m.classList.remove('open');
  });

  menu.classList.toggle('open');
  console.log('Menu is now:', menu.classList.contains('open') ? 'open' : 'closed');
}

async function fetchMeetingsForProfile(profile, list) {
  const supabaseClient = window.APP?.supabase;
  if (!supabaseClient || !profile?.id) {
    renderMeetingsEmpty(list);
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from('meetings')
      .select('id, title, topic, location, max_slots, current_slots, creator_id')
      .eq('creator_id', profile.id)
      .order('created_at', { ascending: false });

    if (error || !data || data.length === 0) {
      renderMeetingsEmpty(list);
      return;
    }

    renderMeetingsList(data, list);
  } catch (error) {
    console.error('Ошибка загрузки встреч профиля:', error);
    renderMeetingsEmpty(list);
  }
}

window.leaveMeeting = async function (meetingId) {
  if (!currentUser) {
    alert('Вы должны быть авторизованы');
    return;
  }

  if (!confirm('Вы действительно хотите покинуть эту встречу?')) {
    return;
  }

  try {
    const supabaseClient = window.APP.supabase;
    const { TABLES } = window.APP;

    // Check if user is participant
    const { data: participant, error: partError } = await supabaseClient
      .from(TABLES.participants)
      .select('id')
      .eq('meeting_id', meetingId)
      .eq('user_id', currentUser.id)
      .single();

    if (partError || !participant) {
      alert('Вы не участник этой встречи');
      return;
    }

    // Delete participant
    const { error: deleteError } = await supabaseClient
      .from(TABLES.participants)
      .delete()
      .eq('meeting_id', meetingId)
      .eq('user_id', currentUser.id);

    if (deleteError) throw deleteError;

    // Decrease meeting current_slots
    const { data: meeting, error: fetchError } = await supabaseClient
      .from('meetings')
      .select('current_slots')
      .eq('id', meetingId)
      .single();

    if (!fetchError && meeting) {
      const newSlots = Math.max(0, meeting.current_slots - 1);
      await supabaseClient
        .from('meetings')
        .update({ current_slots: newSlots })
        .eq('id', meetingId);

      // If no users left, delete the meeting
      if (newSlots === 0) {
        await supabaseClient
          .from('meetings')
          .delete()
          .eq('id', meetingId);
      }
    }

    alert('✅ Вы покинули встречу');
    // Reload profile
    location.reload();
  } catch (error) {
    console.error('Ошибка при выходе из встречи:', error);
    alert('❌ Ошибка: ' + error.message);
  }
};

window.editMeeting = function (meetingId) {
  if (!currentUser) {
    alert('Вы должны быть авторизованы');
    return;
  }

  // Redirect to create-meeting page with edit parameter
  window.location.href = `create-meeting.html?edit=${meetingId}`;
};

window.shareMeeting = async function (meetingId) {
  try {
    const meetingUrl = `${window.location.origin}/meeting.html?id=${meetingId}`;

    // Try native share API
    if (navigator.share) {
      await navigator.share({
        title: 'pulse - встреча',
        text: 'Приглашаю вас к встрече!',
        url: meetingUrl
      });
    } else {
      // Fallback: copy to clipboard
      await navigator.clipboard.writeText(meetingUrl);
      alert('✅ Ссылка скопирована в буфер обмена!');
    }
  } catch (error) {
    console.error('Ошибка при общей ссылке:', error);
  }
};

window.deleteMeeting = async function (meetingId) {
  console.log('deleteMeeting called with ID:', meetingId);

  if (!currentUser) {
    alert('Вы должны быть авторизованы');
    return;
  }

  if (!confirm('Вы уверены, что хотите удалить эту встречу?')) {
    console.log('User cancelled deletion');
    return;
  }

  try {
    const supabaseClient = window.APP.supabase;
    const { TABLES } = window.APP;

    console.log('Fetching meeting:', meetingId);

    // First verify this is the creator
    const { data: meeting, error: fetchError } = await supabaseClient
      .from('meetings')
      .select('creator_id, chat_id')
      .eq('id', meetingId)
      .single();

    if (fetchError || !meeting) {
      alert('❌ Встреча не найдена');
      console.error('Fetch error:', fetchError);
      return;
    }

    console.log('Meeting found:', meeting);

    if (meeting.creator_id !== currentUser.id) {
      alert('❌ Вы не являетесь создателем этой встречи');
      return;
    }

    // Delete chat members if chat exists
    if (meeting.chat_id) {
      console.log('Deleting chat members for chat:', meeting.chat_id);
      const { error: chatMembersError } = await supabaseClient
        .from(TABLES.chat_members)
        .delete()
        .eq('chat_id', meeting.chat_id);

      if (chatMembersError) {
        console.error('Error deleting chat members:', chatMembersError);
      }

      // Delete chat messages
      console.log('Deleting chat messages for chat:', meeting.chat_id);
      const { error: chatMessagesError } = await supabaseClient
        .from(TABLES.chat_messages)
        .delete()
        .eq('chat_id', meeting.chat_id);

      if (chatMessagesError) {
        console.error('Error deleting chat messages:', chatMessagesError);
      }

      // Delete chat
      console.log('Deleting chat:', meeting.chat_id);
      const { error: chatError } = await supabaseClient
        .from(TABLES.chats)
        .delete()
        .eq('id', meeting.chat_id);

      if (chatError) {
        console.error('Error deleting chat:', chatError);
      }
    }

    // Delete all participants
    console.log('Deleting participants for meeting:', meetingId);
    const { error: partError } = await supabaseClient
      .from(TABLES.participants)
      .delete()
      .eq('meeting_id', meetingId);

    if (partError) {
      console.error('Ошибка удаления участников:', partError);
      // Continue even if participants deletion fails (might not exist)
    }

    // Delete the meeting
    console.log('Deleting meeting:', meetingId);
    const { error: deleteError } = await supabaseClient
      .from('meetings')
      .delete()
      .eq('id', meetingId)
      .eq('creator_id', currentUser.id);

    if (deleteError) {
      console.error('Ошибка удаления встречи:', deleteError);
      alert('❌ Ошибка удаления встречи: ' + deleteError.message);
      return;
    }

    console.log('Meeting deleted successfully');
    alert('✅ Встреча удалена');

    // Reload profile
    location.reload();
  } catch (error) {
    console.error('Ошибка при удалении встречи:', error);
    alert('❌ Ошибка: ' + error.message);
  }
};

// Close menus when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.meeting-item')) {
    document.querySelectorAll('.meeting-menu.open').forEach(menu => {
      menu.classList.remove('open');
    });
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

  // Show edit and logout buttons only if viewing own profile
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

function openEditModal() {
  if (!viewedProfile) return;

  document.getElementById('edit-name').value = viewedProfile.full_name || '';
  document.getElementById('edit-nickname').value = viewedProfile.username || '';
  document.getElementById('edit-age').value = viewedProfile.age || '';
  document.getElementById('edit-location').value = viewedProfile.location || '';
  document.getElementById('edit-about').value = viewedProfile.about || viewedProfile.bio || viewedProfile.description || '';

  // Render interests checkboxes
  const interestsContainer = document.getElementById('edit-interests-container');
  interestsContainer.innerHTML = '';
  TOPICS.forEach(topic => {
    const isChecked = (viewedProfile.interests || []).includes(topic.id);
    const wrapper = document.createElement('div');
    wrapper.className = 'interest-checkbox-wrapper';

    // Extract icon from name if not separate
    let icon = topic.icon || '';
    let displayName = topic.name;
    if (!icon && topic.name) {
      const emojiMatch = topic.name.match(/^([\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}])\s*/u);
      if (emojiMatch) {
        icon = emojiMatch[0].trim();
        displayName = topic.name.substring(emojiMatch[0].length).trim();
      }
    }

    wrapper.innerHTML = `
      <input type="checkbox" id="interest-${topic.id}" class="interest-checkbox-input" value="${topic.id}" ${isChecked ? 'checked' : ''}>
      <label for="interest-${topic.id}" class="interest-checkbox-label">
        <span>${icon}</span>
        <span>${displayName}</span>
      </label>
    `;
    interestsContainer.appendChild(wrapper);
  });

  // Clear file input and show current photo
  const photoInput = document.getElementById('edit-photo');
  photoInput.value = '';

  const photoPreview = document.getElementById('photo-preview');
  const avatarUrl = viewedProfile.photo_URL && viewedProfile.photo_URL !== 'user'
    ? viewedProfile.photo_URL
    : null;

  if (avatarUrl) {
    photoPreview.innerHTML = `<img src="${avatarUrl}" alt="Current photo">`;
  } else {
    photoPreview.innerHTML = `<div class="avatar-placeholder-edit"><div class="icon">👤</div></div>`;
  }

  // Add change listener for photo preview
  photoInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file && file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = (event) => {
        photoPreview.innerHTML = `<img src="${event.target.result}" alt="Preview">`;
      };
      reader.readAsDataURL(file);
    }
  };

  document.getElementById('edit-modal').style.display = 'flex';
}

function closeEditModal() {
  document.getElementById('edit-modal').style.display = 'none';
}

async function saveProfile() {
  if (!currentUser || !viewedProfile) {
    alert('Ошибка: профиль не загружен');
    return;
  }

  const fullName = document.getElementById('edit-name').value.trim();
  const nickname = document.getElementById('edit-nickname').value.trim();
  const age = parseInt(document.getElementById('edit-age').value) || null;
  const location = document.getElementById('edit-location').value.trim();
  const about = document.getElementById('edit-about').value.trim();
  const photoInput = document.getElementById('edit-photo');
  const photoFile = photoInput.files[0];

  // Get selected interests
  const selectedInterests = Array.from(
    document.querySelectorAll('.interest-checkbox-input:checked')
  ).map(cb => cb.value);

  if (!fullName) {
    alert('Пожалуйста, введите имя');
    return;
  }

  if (!nickname) {
    alert('Пожалуйста, введите никнейм');
    return;
  }

  // Check if nickname is available (if changed)
  if (nickname !== viewedProfile.username) {
    if (nickname.length < 3) {
      alert('Никнейм должен быть не менее 3 символов');
      return;
    }
    if (!/^[a-zA-Z0-9_]+$/.test(nickname)) {
      alert('Никнейм может содержать только латинские буквы, цифры и подчеркивание');
      return;
    }

    // Check if nickname is taken
    const { data: existingUser } = await window.APP.supabase
      .from('profiles')
      .select('id')
      .eq('username', nickname)
      .maybeSingle();

    if (existingUser && existingUser.id !== currentUser.id) {
      alert('Этот никнейм уже занят');
      return;
    }
  }

  try {
    let photoUrl = viewedProfile.photo_URL; // Keep existing if no new file

    // Upload new photo if selected
    if (photoFile) {
      // Validate file
      if (!photoFile.type.startsWith('image/')) {
        alert('Пожалуйста, выберите изображение');
        return;
      }
      if (photoFile.size > 5 * 1024 * 1024) {
        alert('Размер файла должен быть меньше 5MB');
        return;
      }

      const avatarPath = `avatars/${currentUser.id}/${Date.now()}_${photoFile.name}`;
      const { error: uploadError } = await window.APP.supabase.storage
        .from('profiles')
        .upload(avatarPath, photoFile, {
          cacheControl: '3600',
          upsert: false
        });

      if (uploadError) throw uploadError;

      const { data } = window.APP.supabase.storage
        .from('profiles')
        .getPublicUrl(avatarPath);
      photoUrl = data?.publicUrl || 'user';
    }

    const { error } = await window.APP.supabase
      .from('profiles')
      .update({
        full_name: fullName,
        username: nickname,
        age: age,
        location: location,
        about: about,
        photo_URL: photoUrl,
        interests: selectedInterests
      })
      .eq('id', currentUser.id);

    if (error) throw error;

    // Update local profile object
    viewedProfile.full_name = fullName;
    viewedProfile.username = nickname;
    viewedProfile.age = age;
    viewedProfile.location = location;
    viewedProfile.about = about;
    viewedProfile.photo_URL = photoUrl;
    viewedProfile.interests = selectedInterests;

    // Re-render profile
    renderProfile(viewedProfile);
    closeEditModal();
    alert('✅ Профиль успешно обновлен!');
  } catch (error) {
    console.error('Ошибка при сохранении профиля:', error);
    alert('❌ Ошибка при сохранении профиля: ' + error.message);
  }
}

async function handleLogout() {
  const confirmed = confirm('Вы уверены, что хотите выйти?');
  if (!confirmed) {
    return;
  }

  try {
    const { error } = await window.APP.supabase.auth.signOut();
    if (error) throw error;

    window.location.href = 'index.html';
  } catch (error) {
    console.error('Ошибка при выходе:', error);
    alert('❌ Ошибка при выходе: ' + error.message);
  }
}

function setupReportButton() {
  const reportBtn = document.getElementById('report-btn');
  const messageBtn = document.getElementById('message-btn');
  if (!reportBtn) return;

  // Show report button only if viewing someone else's profile
  if (currentUser && viewedProfile && currentUser.id !== viewedProfile.id) {
    reportBtn.style.display = 'block';
    reportBtn.onclick = () => {
      const displayName = viewedProfile.full_name || viewedProfile.username || 'Пользователь';
      if (typeof window.openReportModal === 'function') {
        window.openReportModal('user', viewedProfile.id, displayName);
      }
    };
  } else {
    reportBtn.style.display = 'none';
  }
}

async function setupBanButton() {
  const banBtn = document.getElementById('ban-btn');
  if (!banBtn) return;

  if (!currentUser || !viewedProfile || currentUser.id === viewedProfile.id) {
    banBtn.style.display = 'none';
    return;
  }

  banBtn.style.display = 'block';

  let isBlocked = await checkIfUserIsBlocked(viewedProfile.id);
  updateBanButton(banBtn, isBlocked);

  banBtn.onclick = async () => {
    if (isBlocked) {
      await unbanUser(viewedProfile.id);
    } else {
      await banUser(viewedProfile.id);
    }
    isBlocked = await checkIfUserIsBlocked(viewedProfile.id);
    updateBanButton(banBtn, isBlocked);
  };
}

function updateBanButton(btn, isBlocked) {
  if (isBlocked) {
    btn.textContent = 'Разблокировать';
    btn.classList.add('blocked');
  } else {
    btn.textContent = 'Заблокировать';
    btn.classList.remove('blocked');
  }
}

async function getCurrentUserBlockedList() {
  if (!currentUser) return [];

  try {
    const { data, error } = await window.APP.supabase
      .from(window.APP.TABLES.profiles)
      .select('blocked_users')
      .eq('id', currentUser.id)
      .single();

    if (error) {
      console.error('Error loading blocked list:', error);
      return [];
    }

    return Array.isArray(data?.blocked_users) ? data.blocked_users : [];
  } catch (error) {
    console.error('Error loading blocked list:', error);
    return [];
  }
}

async function checkIfUserIsBlocked(blockedUserId) {
  const blockedList = await getCurrentUserBlockedList();
  return blockedList.includes(blockedUserId);
}

async function banUser(blockedUserId) {
  if (!currentUser) return;

  const blockedList = await getCurrentUserBlockedList();
  if (blockedList.includes(blockedUserId)) return;

  const nextList = [...blockedList, blockedUserId];
  const { error } = await window.APP.supabase
    .from(window.APP.TABLES.profiles)
    .update({ blocked_users: nextList })
    .eq('id', currentUser.id);

  if (error) {
    console.error('Error blocking user:', error);
    alert('Failed to block user');
    return;
  }

  alert('User blocked');
}

async function unbanUser(blockedUserId) {
  if (!currentUser) return;

  const blockedList = await getCurrentUserBlockedList();
  const nextList = blockedList.filter((id) => id !== blockedUserId);

  const { error } = await window.APP.supabase
    .from(window.APP.TABLES.profiles)
    .update({ blocked_users: nextList })
    .eq('id', currentUser.id);

  if (error) {
    console.error('Error unblocking user:', error);
    alert('Failed to unblock user');
    return;
  }

  alert('User unblocked');
}



