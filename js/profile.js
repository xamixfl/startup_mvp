// Topics will be fetched from database
let TOPICS = [];
let currentUser = null;

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

  renderProfile(profile);
  renderMeetings(profile);
});

const DEFAULT_AVATAR = 'assets/avatar.png';

function getLocalMeetings() {
  const raw = localStorage.getItem('meetup_meetings');
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

  fetchMeetingsForProfile(profile, list);
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

async function fetchMeetingsForProfile(profile, list) {
  const supabaseClient = window.APP?.supabase;
  if (!supabaseClient || !profile?.id) {
    renderMeetingsEmpty(list);
    return;
  }

  try {
    const { data, error } = await supabaseClient
      .from('meetings')
      .select('id, title, topic, location, max_slots, current_slots')
      .eq('creator_id', profile.id)
      .order('created_at', { ascending: false });

    if (error || !data || data.length === 0) {
      renderMeetingsEmpty(list);
      return;
    }

    data.forEach(meeting => {
      const topic = TOPICS.find(item => item.id === meeting.topic) || TOPICS[TOPICS.length - 1];
      const item = document.createElement('div');
      item.className = 'meeting-item';
      item.onclick = () => {
        window.location.href = `meeting.html?id=${meeting.id}`;
      };
      item.innerHTML = `
        <div class="meeting-tag">#${topic.name.replace(/^(\S+)\s/, '')}</div>
        <div class="meeting-headline">${meeting.title || 'Без названия'}</div>
        <div class="meeting-info">
          <span>👥 ${meeting.current_slots || 0}/${meeting.max_slots || 0}</span>
          <span>📍 ${meeting.location || 'Город не указан'}</span>
        </div>
      `;
      list.appendChild(item);
    });
  } catch (error) {
    console.error('Ошибка загрузки встреч профиля:', error);
    renderMeetingsEmpty(list);
  }
}

function renderMeetingsEmpty(list) {
  const empty = document.createElement('div');
  empty.style.color = '#94a3b8';
  empty.textContent = 'Пока нет запланированных встреч';
  list.appendChild(empty);
}

