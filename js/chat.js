const supabaseClient = window.APP?.supabase;
const { TABLES } = window.APP || {};
let currentUser = null;
let chats = [];
let currentChat = null;
let pendingOpenChatId = null;
let TOPICS = null;

const DEFAULT_AVATAR = 'assets/avatar.png';
const UNREAD_KEY = 'meetup_chat_last_read';

document.addEventListener('DOMContentLoaded', async () => {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) {
    window.location.href = 'login.html';
    return;
  }
  currentUser = user;
  if (typeof window.fetchTopics === 'function') {
    TOPICS = await window.fetchTopics();
  }

  setupChatSelectionFromUrl();
  await loadChats();
  setupSendMessage();
  setupTitleToggle();
});

async function loadChats() {
  const list = document.getElementById('chat-list');
  if (!list) return;

  let refreshedIds = [];
  let mergedIds = [];

  try {
    console.log('Step 1: Fetching chat_members for user:', currentUser.id);
    const { data: memberships, error } = await supabaseClient
      .from(TABLES.chat_members)
      .select('chat_id, status')
      .eq('user_id', currentUser.id)
      .eq('status', 'approved');

    if (error) {
      console.error('❌ Step 1 FAILED - Ошибка загрузки chat_members:', error);
      console.error('   Error code:', error.code);
      console.error('   Error message:', error.message);
      list.innerHTML = '<div class="chat-item">❌ Ошибка: ' + error.message + '</div>';
      return;
    }

    const memberChatIds = (memberships || []).map(m => m.chat_id);
    console.log('✅ Step 1 OK - Found member chats:', memberChatIds);

    console.log('Step 2: Fetching owned chats');
    const { data: ownedChats, error: ownedError } = await supabaseClient
      .from(TABLES.chats)
      .select('id, title, meeting_id, owner_id, created_at')
      .eq('owner_id', currentUser.id)
      .order('created_at', { ascending: false });

    if (ownedError) {
      console.error('❌ Step 2 FAILED - Ошибка загрузки chats:', ownedError);
      console.error('   Error code:', ownedError.code);
      console.error('   Error message:', ownedError.message);
    } else {
      console.log('✅ Step 2 OK - Found owned chats:', (ownedChats || []).map(c => c.id));
    }

    const ownedIds = (ownedChats || []).map(c => c.id);
    const missingOwner = ownedIds.filter(id => !memberChatIds.includes(id));

    if (missingOwner.length > 0) {
      console.log('Step 3: Adding owner to missing chat_members records');
      const { error: insertOwnerError } = await supabaseClient
        .from(TABLES.chat_members)
        .insert(missingOwner.map(chatId => ({
          chat_id: chatId,
          user_id: currentUser.id,
          role: 'owner',
          status: 'approved'
        })));
      if (insertOwnerError) {
        console.error('❌ Step 3 FAILED - Ошибка добавления владельца:', insertOwnerError);
      } else {
        console.log('✅ Step 3 OK - Owner added to', missingOwner.length, 'chats');
      }
    }

    console.log('Step 4: Refreshing chat_members list');
    const { data: refreshed, error: refreshedError } = await supabaseClient
      .from(TABLES.chat_members)
      .select('chat_id, status')
      .eq('user_id', currentUser.id)
      .eq('status', 'approved');

    if (refreshedError) {
      console.error('❌ Step 4 FAILED:', refreshedError);
    } else {
      console.log('✅ Step 4 OK - Refreshed member chats:', (refreshed || []).map(m => m.chat_id));
    }

    refreshedIds = (refreshed || []).map(m => m.chat_id);
    mergedIds = Array.from(new Set([...refreshedIds, ...ownedIds]));
    console.log('Merged chat IDs:', mergedIds);

    if (mergedIds.length === 0) {
      list.innerHTML = '<div class="chat-item">Нет чатов</div>';
      return;
    }

    console.log('Step 5: Fetching chat details for IDs:', mergedIds);
    const { data: chatsData, error: chatsError } = await supabaseClient
      .from(TABLES.chats)
      .select('id, title, meeting_id, owner_id, created_at, peer_id')
      .in('id', mergedIds)
      .order('created_at', { ascending: false });

    if (chatsError) {
      console.error('❌ Step 5 FAILED - Ошибка выборки чатов:', chatsError);
      console.error('   Error code:', chatsError.code);
      console.error('   Error message:', chatsError.message);
      list.innerHTML = '<div class="chat-item">❌ Ошибка: ' + chatsError.message + '</div>';
      return;
    }

    console.log('✅ Step 5 OK - Found', chatsData.length, 'chats');
    chats = chatsData || [];
  } catch (err) {
    console.error('❌ UNEXPECTED ERROR:', err);
    const list = document.getElementById('chat-list');
    if (list) {
      list.innerHTML = '<div class="chat-item">❌ Неожиданная ошибка: ' + err.message + '</div>';
    }
    return;
  }

  if (mergedIds.length > 0 && chats.length === 0) {
    list.innerHTML = '<div class="chat-item">Нет доступа к чатам (RLS)</div>';
    return;
  }

  try {
    console.log('Step 6: Processing chat metadata');
    await applyLastMessageMeta(mergedIds);
    console.log('✅ Step 6 OK');

    console.log('Step 7: Enriching direct chat titles');
    await enrichDirectChatTitles();
    console.log('✅ Step 7 OK');

    console.log('Step 8: Cleaning up empty direct chats');
    await cleanupEmptyDirectChats(new Set(refreshedIds), currentChat?.id);
    console.log('✅ Step 8 OK');

    console.log('Step 9: Sorting chats');
    sortChatsByLastActivity();
    console.log('✅ Step 9 OK');

    console.log('Step 10: Rendering chat list');
    renderChatList();
    console.log('✅ Step 10 OK - Rendered', chats.length, 'chats');

    if (pendingOpenChatId) {
      const chat = chats.find(c => c.id === pendingOpenChatId);
      if (chat) openChat(chat);
      pendingOpenChatId = null;
    }
  } catch (err) {
    console.error('❌ Error in chat processing steps:', err);
    list.innerHTML = '<div class="chat-item">❌ Ошибка обработки чатов: ' + err.message + '</div>';
  }
}

function renderChatList() {
  const list = document.getElementById('chat-list');
  if (!list) return;
  list.innerHTML = '';

  chats.forEach(chat => {
    const item = document.createElement('div');
    item.className = 'chat-item';
    item.dataset.chatId = chat.id;
    const title = chat.meeting_id ? chat.title : (chat.display_title || chat.title);
    const isUnread = isChatUnread(chat);
    item.innerHTML = `
      <div class="chat-item-row">
        <div class="chat-item-title">${title}</div>
        ${isUnread ? '<div class="chat-unread">●</div>' : ''}
      </div>
      <div class="chat-item-sub">${chat.meeting_id ? 'Чат встречи' : 'Личный чат'}</div>
    `;
    item.onclick = () => openChat(chat);
    list.appendChild(item);
  });
}

function setupChatSelectionFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const chatId = params.get('chat_id');
  if (!chatId) return;
  pendingOpenChatId = chatId;
}

async function openChat(chat) {
  currentChat = chat;
  document.querySelectorAll('.chat-item').forEach(el => {
    el.classList.toggle('active', el.dataset.chatId === chat.id);
  });

  const titleEl = document.getElementById('chat-title');
  titleEl.textContent = chat.meeting_id ? chat.title : (chat.display_title || chat.title);

  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  input.disabled = false;
  sendBtn.disabled = false;

  await ensureDirectPeer(chat);
  await ensureDirectTitle(chat);
  if (!chat.meeting_id && chat.display_title) {
    titleEl.textContent = chat.display_title;
  }
  await loadMessages(chat.id);
  markChatRead(chat);
  renderChatList();
  await loadChatInfo(chat);
}

async function enrichDirectChatTitles() {
  const directChats = chats.filter(chat => !chat.meeting_id);
  if (!directChats.length) return;

  const directIds = directChats.map(chat => chat.id);
  const { data: members, error: membersError } = await supabaseClient
    .from(TABLES.chat_members)
    .select('chat_id, user_id, status')
    .in('chat_id', directIds)
    .eq('status', 'approved');
  if (membersError) {
    console.error('Ошибка загрузки участников личных чатов:', membersError);
    return;
  }

  const membersByChat = new Map();
  (members || []).forEach(member => {
    if (!membersByChat.has(member.chat_id)) {
      membersByChat.set(member.chat_id, []);
    }
    membersByChat.get(member.chat_id).push(member.user_id);
  });

  const peerIds = new Set();
  directChats.forEach(chat => {
    let peerId = null;
    if (chat.owner_id && chat.owner_id !== currentUser.id) {
      peerId = chat.owner_id;
    } else if (chat.peer_id && chat.peer_id !== currentUser.id) {
      peerId = chat.peer_id;
    } else {
      const ids = membersByChat.get(chat.id) || [];
      peerId = ids.find(id => id !== currentUser.id) || null;
    }
    if (peerId) {
      chat._peerId = peerId;
      peerIds.add(peerId);
    }
  });

  if (peerIds.size === 0) return;
  const { data: profiles, error: profilesError } = await supabaseClient
    .from(TABLES.profiles)
    .select('id, full_name, username')
    .in('id', Array.from(peerIds));
  if (profilesError) {
    console.error('Ошибка загрузки профилей собеседников:', profilesError);
    return;
  }

  const byId = new Map((profiles || []).map(profile => [profile.id, profile]));
  directChats.forEach(chat => {
    const profile = byId.get(chat._peerId);
    const name = profile?.full_name || profile?.username;
    if (name) {
      chat.display_title = name;
    }
  });
}

async function loadMessages(chatId) {
  const body = document.getElementById('chat-body');
  body.innerHTML = '';

  const { data: messages, error } = await supabaseClient
    .from(TABLES.chat_messages)
    .select('id, user_id, content, created_at')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true });

  if (error || !messages || messages.length === 0) {
    if (error) {
      console.error('Ошибка загрузки сообщений:', error);
    }
    body.innerHTML = '<div class="chat-empty">Сообщений пока нет</div>';
    return;
  }

  const userIds = Array.from(new Set(messages.map(m => m.user_id)));
  const { data: profiles } = await supabaseClient
    .from(TABLES.profiles)
    .select('id, full_name, username')
    .in('id', userIds);
  const byId = new Map((profiles || []).map(p => [p.id, p]));

  messages.forEach(msg => {
    const profile = byId.get(msg.user_id);
    const name = profile?.full_name || profile?.username || 'Пользователь';
    const bubble = document.createElement('div');
    bubble.className = 'message';
    if (msg.user_id === currentUser.id) {
      bubble.classList.add('mine');
    }
    bubble.innerHTML = `
      <div class="message-author">${name}</div>
      <div class="message-text">${msg.content}</div>
    `;
    body.appendChild(bubble);
  });
  body.scrollTop = body.scrollHeight;
}

async function applyLastMessageMeta(chatIds) {
  if (!chatIds || chatIds.length === 0) return;
  const { data: messages, error } = await supabaseClient
    .from(TABLES.chat_messages)
    .select('chat_id, created_at')
    .in('chat_id', chatIds)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('Ошибка загрузки последних сообщений:', error);
    return;
  }
  const latestByChat = new Map();
  (messages || []).forEach(msg => {
    if (!latestByChat.has(msg.chat_id)) {
      latestByChat.set(msg.chat_id, msg.created_at);
    }
  });
  chats.forEach(chat => {
    chat.last_message_at = latestByChat.get(chat.id) || null;
  });
}

function sortChatsByLastActivity() {
  chats.sort((a, b) => {
    const aTime = Date.parse(a.last_message_at || a.created_at || 0);
    const bTime = Date.parse(b.last_message_at || b.created_at || 0);
    return bTime - aTime;
  });
}

function getReadMap() {
  try {
    const raw = localStorage.getItem(UNREAD_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function setReadMap(map) {
  localStorage.setItem(UNREAD_KEY, JSON.stringify(map));
}

function getChatReadKey(chatId) {
  return `${currentUser?.id || 'guest'}:${chatId}`;
}

function markChatRead(chat) {
  if (!chat) return;
  const map = getReadMap();
  const lastAt = chat.last_message_at || new Date().toISOString();
  map[getChatReadKey(chat.id)] = lastAt;
  setReadMap(map);
}

function isChatUnread(chat) {
  if (!chat || !chat.last_message_at) return false;
  const map = getReadMap();
  const lastRead = map[getChatReadKey(chat.id)];
  if (!lastRead) return true;
  return Date.parse(chat.last_message_at) > Date.parse(lastRead);
}

async function cleanupEmptyDirectChats(approvedSet, openedChatId) {
  if (!chats.length) return;
  try {
    const directChats = chats.filter(c => !c.meeting_id);
    if (!directChats.length) return;
    const deletedIds = new Set();
    for (const chat of directChats) {
      if (pendingOpenChatId && chat.id === pendingOpenChatId) continue;
      if (openedChatId && chat.id === openedChatId) continue;
      if (!approvedSet || !approvedSet.has(chat.id)) continue;
      const { count, error: countError } = await supabaseClient
        .from(TABLES.chat_messages)
        .select('id', { count: 'exact', head: true })
        .eq('chat_id', chat.id);
      if (countError) continue;
      if (count !== 0) continue;
      const { error: membersDeleteError } = await supabaseClient
        .from(TABLES.chat_members)
        .delete()
        .eq('chat_id', chat.id);
      if (membersDeleteError) continue;
      const { error: chatDeleteError } = await supabaseClient
        .from(TABLES.chats)
        .delete()
        .eq('id', chat.id);
      if (!chatDeleteError) {
        deletedIds.add(chat.id);
      }
    }
    if (deletedIds.size > 0) {
      chats = chats.filter(c => !deletedIds.has(c.id));
    }
  } catch (error) {
    console.error('Ошибка очистки пустых личных чатов:', error);
  }
}

function setupSendMessage() {
  const sendBtn = document.getElementById('chat-send');
  const input = document.getElementById('chat-input');
  if (!sendBtn || !input) return;

  sendBtn.onclick = async () => {
    const text = input.value.trim();
    if (!text || !currentChat) return;

    await ensureDirectPeer(currentChat);

    const { error } = await supabaseClient
      .from(TABLES.chat_messages)
      .insert([{ chat_id: currentChat.id, user_id: currentUser.id, content: text }]);

    if (error) {
      console.error('Ошибка отправки сообщения:', error);
      alert(error.message || 'Сообщение не отправлено');
      return;
    }
    input.value = '';
    await loadMessages(currentChat.id);
  };

  input.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendBtn.click();
    }
  });
}

async function ensureDirectPeer(chat) {
  if (!chat || chat.meeting_id) return;
  if (!chat.peer_id) return;
  if (chat.owner_id !== currentUser.id) return;

  const { data: members } = await supabaseClient
    .from(TABLES.chat_members)
    .select('user_id')
    .eq('chat_id', chat.id);

  const memberIds = new Set((members || []).map(m => m.user_id));
  const inserts = [];
  if (!memberIds.has(chat.owner_id)) {
    inserts.push({ chat_id: chat.id, user_id: chat.owner_id, role: 'owner', status: 'approved' });
  }
  if (!memberIds.has(chat.peer_id)) {
    inserts.push({ chat_id: chat.id, user_id: chat.peer_id, role: 'member', status: 'approved' });
  }
  if (inserts.length > 0) {
    await supabaseClient.from(TABLES.chat_members).insert(inserts);
  }
}

async function ensureDirectTitle(chat) {
  if (!chat || chat.meeting_id) return;
  if (chat.display_title) return;

  let peerId = null;
  if (chat.owner_id && chat.owner_id !== currentUser.id) {
    peerId = chat.owner_id;
  } else if (chat.peer_id && chat.peer_id !== currentUser.id) {
    peerId = chat.peer_id;
  }
  if (!peerId) {
    const { data: members } = await supabaseClient
      .from(TABLES.chat_members)
      .select('user_id, status')
      .eq('chat_id', chat.id)
      .eq('status', 'approved');
    const ids = (members || []).map(m => m.user_id);
    peerId = ids.find(id => id !== currentUser.id) || null;
  }
  if (!peerId) return;

  const { data: profile } = await supabaseClient
    .from(TABLES.profiles)
    .select('id, full_name, username')
    .eq('id', peerId)
    .single();
  const name = profile?.full_name || profile?.username;
  if (name) {
    chat.display_title = name;
    chat._peerId = peerId;
  }
}

function setupTitleToggle() {
  const titleEl = document.getElementById('chat-title');
  const app = document.getElementById('chat-app');
  if (!titleEl || !app) return;
  titleEl.onclick = () => {
    app.classList.toggle('show-info');
  };
}

async function loadChatInfo(chat) {
  const infoContent = document.getElementById('info-content');
  if (!infoContent) return;
  infoContent.innerHTML = '';

  if (chat.meeting_id) {
    const { data: meeting } = await supabaseClient
      .from(TABLES.meetings)
      .select('id, title, creator_id, topic, location, current_slots, max_slots')
      .eq('id', chat.meeting_id)
      .single();

    const topicName = getTopicName(meeting?.topic);
    const card = document.createElement('div');
    card.className = 'meeting-card';
    card.innerHTML = `
      <div class="meeting-tag">#${topicName}</div>
      <a class="meeting-title" href="meeting.html?id=${meeting?.id || ''}">${meeting?.title || 'Встреча'}</a>
      <div class="meeting-meta">
        <div>👥 ${meeting?.current_slots || 0}/${meeting?.max_slots || 0}</div>
        <div>📍 ${meeting?.location || 'Город не указан'}</div>
      </div>
    `;
    infoContent.appendChild(card);

    const { data: members } = await supabaseClient
      .from(TABLES.chat_members)
      .select('user_id, role, status')
      .eq('chat_id', chat.id)
      .eq('status', 'approved');

    const memberIds = (members || []).map(m => m.user_id);
    const { data: profiles } = await supabaseClient
      .from(TABLES.profiles)
      .select('id, full_name, username, age, photo_URL')
      .in('id', memberIds);
    const byId = new Map((profiles || []).map(p => [p.id, p]));

    const list = document.createElement('div');
    list.className = 'participants-list';
    (members || []).forEach(m => {
      const profile = byId.get(m.user_id);
      const name = profile?.full_name || profile?.username || 'Пользователь';
      const age = profile?.age ? `${profile.age} лет` : 'Возраст не указан';
      const avatarUrl = profile?.photo_URL && profile?.photo_URL !== 'user'
        ? profile.photo_URL
        : DEFAULT_AVATAR;
      const row = document.createElement('a');
      row.className = 'participant-item';
      row.href = `profile.html?id=${m.user_id}`;
      row.innerHTML = `
        <img class="participant-avatar" src="${avatarUrl}" alt="${name}">
        <div>
          <div class="participant-name">${name}</div>
          <div class="participant-age">${age}</div>
        </div>
      `;
      list.appendChild(row);
    });
    infoContent.appendChild(list);
  } else {
    const peerId = chat._peerId
      || (chat.owner_id && chat.owner_id !== currentUser.id ? chat.owner_id : null);
    const { data: peerProfile } = await supabaseClient
      .from(TABLES.profiles)
      .select('id, full_name, username, age, photo_URL')
      .eq('id', peerId)
      .maybeSingle();
    const name = peerProfile?.full_name || peerProfile?.username || 'Собеседник';
    const age = peerProfile?.age ? `${peerProfile.age} лет` : 'Возраст не указан';
    const avatarUrl = peerProfile?.photo_URL && peerProfile?.photo_URL !== 'user'
      ? peerProfile.photo_URL
      : DEFAULT_AVATAR;

    const card = document.createElement('div');
    card.className = 'info-profile';
    card.innerHTML = `
      <img class="info-avatar" src="${avatarUrl}" alt="${name}">
      <a class="info-name" href="profile.html?id=${peerProfile?.id || ''}">${name}</a>
      <div class="info-age">${age}</div>
    `;
    infoContent.appendChild(card);
  }
}

function getTopicName(topicId) {
  if (!topicId) return 'Тема';
  const topic = (TOPICS || []).find(item => item.id === topicId);
  if (topic?.name) return topic.name.replace(/^(\S+)\s/, '');
  const fallback = {
    boardgames: 'Настольные игры',
    tennis: 'Теннис',
    football: 'Футбол',
    running: 'Бег',
    coffee: 'Кофе',
    cinema: 'Кино',
    language: 'Языковая практика',
    hiking: 'Походы',
    music: 'Музыка',
    photography: 'Фотография'
  };
  return fallback[topicId] || topicId;
}
