const supabaseClient = window.APP?.supabase;
const { TABLES } = window.APP || {};
let currentUser = null;
let chats = [];
let currentChat = null;
let pendingOpenChatId = null;
let TOPICS = null;

const DEFAULT_AVATAR = 'assets/avatar.png';
const UNREAD_KEY = 'pulse_chat_last_read';
const CHAT_BUCKET = 'chat-media';
let listChannel = null;
let messageChannels = [];
let typingChannel = null;
let typingTimeoutId = null;
let typingHideTimeoutId = null;
let messagePollTimer = null;
let chatListPollTimer = null;
let currentChatMessageSignature = 'empty';
let isChatListPolling = false;
let pendingImageFile = null;
const MAX_IMAGE_MB = 5;

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
  setupImageUpload();
  setupTypingIndicator();
  setupImageModal();
  setupTitleToggle();
  startChatListPolling();
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

    console.log('Step 8.1: Calculating unread counts');
    await applyUnreadCounts(mergedIds);
    console.log('✅ Step 8.1 OK');

    console.log('Step 9: Sorting chats');
    sortChatsByLastActivity();
    console.log('✅ Step 9 OK');

    console.log('Step 10: Rendering chat list');
    renderChatList();
    console.log('✅ Step 10 OK - Rendered', chats.length, 'chats');

    setupRealtimeSubscriptions(mergedIds);

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
    item.className = `chat-item${currentChat && currentChat.id === chat.id ? ' active' : ''}`;
    item.dataset.chatId = chat.id;
    const title = chat.meeting_id ? chat.title : (chat.display_title || chat.title);
    const isUnread = isChatUnread(chat);
    const unreadCount = chat.unread_count || 0;
    const unreadLabel = unreadCount > 99 ? '99+' : String(unreadCount);
    item.innerHTML = `
    <div class="chat-item-row">
      <div class="chat-item-title">${title}</div>
      ${isUnread ? `<div class="chat-unread">${unreadLabel}</div>` : ''}
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
  setupChatTypingChannel(chat.id);
  const messageMeta = await loadMessages(chat.id);
  currentChatMessageSignature = messageMeta?.signature || 'empty';
  startMessagePolling(chat.id);
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
    return { signature: 'empty', lastMessageAt: null };
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
    const isImage = typeof msg.content === 'string' && msg.content.startsWith('image:');
    if (isImage) {
      const imageUrl = msg.content.slice('image:'.length).trim();
      bubble.innerHTML = `
        <div class="message-author">${name}</div>
        <img class="message-image" src="${imageUrl}" alt="image" data-full="${imageUrl}">
      `;
    } else {
      bubble.innerHTML = `
        <div class="message-author">${name}</div>
        <div class="message-text">${msg.content}</div>
      `;
    }
    body.appendChild(bubble);
  });
  body.scrollTop = body.scrollHeight;

  const modal = document.getElementById('image-modal');
  const modalImg = document.getElementById('image-modal-img');
  if (modal && modalImg) {
    body.querySelectorAll('.message-image').forEach(img => {
      img.addEventListener('click', () => {
        modalImg.src = img.getAttribute('data-full') || img.src;
        modal.style.display = 'flex';
      });
    });
  }
  const lastMessage = messages[messages.length - 1];
  return {
    signature: `${lastMessage.id}:${lastMessage.created_at}`,
    lastMessageAt: lastMessage.created_at
  };
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

async function applyUnreadCounts(chatIds) {
  if (!chatIds || chatIds.length === 0) return;
  const map = getReadMap();
  const countsById = new Map();

  for (const chatId of chatIds) {
    const lastRead = map[getChatReadKey(chatId)];
    let query = supabaseClient
      .from(TABLES.chat_messages)
      .select('id', { count: 'exact', head: true })
      .eq('chat_id', chatId);
    if (lastRead) {
      query = query.gt('created_at', lastRead);
    }
    const { count, error } = await query;
    if (error) {
      continue;
    }
    countsById.set(chatId, count || 0);
  }

  chats.forEach(chat => {
    chat.unread_count = countsById.get(chat.id) || 0;
  });
}

function setupRealtimeSubscriptions(chatIds) {
  if (!supabaseClient) return;
  if (listChannel) {
    supabaseClient.removeChannel(listChannel);
    listChannel = null;
  }
  if (messageChannels.length > 0) {
    messageChannels.forEach(channel => supabaseClient.removeChannel(channel));
    messageChannels = [];
  }
  listChannel = supabaseClient
    .channel('chat-list-updates')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: TABLES.chat_members, filter: `user_id=eq.${currentUser.id}` },
      () => loadChats()
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: TABLES.chat_members, filter: `user_id=eq.${currentUser.id}` },
      () => loadChats()
    )
    .on(
      'postgres_changes',
      { event: 'DELETE', schema: 'public', table: TABLES.chat_members, filter: `user_id=eq.${currentUser.id}` },
      () => loadChats()
    )
    .subscribe();

  if (!chatIds || chatIds.length === 0) return;

  // Use per-chat subscriptions to avoid unreliable `in.(...)` filters with UUID ids.
  chatIds.forEach(chatId => {
    const channel = supabaseClient
      .channel(`chat-messages:${chatId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: TABLES.chat_messages, filter: `chat_id=eq.${chatId}` },
        payload => handleMessageRealtime(payload)
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: TABLES.chat_messages, filter: `chat_id=eq.${chatId}` },
        () => handleMessageStructureChange(chatId)
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: TABLES.chat_messages, filter: `chat_id=eq.${chatId}` },
        () => handleMessageStructureChange(chatId)
      )
      .subscribe();
    messageChannels.push(channel);
  });
}

function handleMessageRealtime(payload) {
  const msg = payload?.new;
  if (!msg?.chat_id) return;
  const chat = chats.find(c => c.id === msg.chat_id);
  if (chat) {
    chat.last_message_at = msg.created_at || new Date().toISOString();
    if (currentChat && currentChat.id === msg.chat_id) {
      chat.unread_count = 0;
    } else {
      chat.unread_count = (chat.unread_count || 0) + 1;
    }
  }
  sortChatsByLastActivity();
  if (currentChat && currentChat.id === msg.chat_id) {
    loadMessages(currentChat.id);
    currentChatMessageSignature = `${msg.id}:${msg.created_at}`;
    markChatRead(currentChat);
  }
  renderChatList();
}

async function handleMessageStructureChange(chatId) {
  const chat = chats.find(c => c.id === chatId);
  if (!chat) return;
  await applyLastMessageMeta([chatId]);
  if (currentChat && currentChat.id === chatId) {
    const messageMeta = await loadMessages(chatId);
    currentChatMessageSignature = messageMeta?.signature || 'empty';
    markChatRead(chat);
  } else {
    chat.unread_count = (chat.unread_count || 0) + 1;
  }
  sortChatsByLastActivity();
  renderChatList();
}

function startMessagePolling(chatId) {
  stopMessagePolling();
  if (!chatId) return;
  messagePollTimer = setInterval(() => {
    pollCurrentChatMessages(chatId);
  }, 2500);
}

function stopMessagePolling() {
  if (!messagePollTimer) return;
  clearInterval(messagePollTimer);
  messagePollTimer = null;
}

async function pollCurrentChatMessages(chatId) {
  if (!currentChat || currentChat.id !== chatId || document.hidden) return;
  const { data: latest, error } = await supabaseClient
    .from(TABLES.chat_messages)
    .select('id, created_at')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return;
  const latestSignature = latest ? `${latest.id}:${latest.created_at}` : 'empty';
  if (latestSignature === currentChatMessageSignature) return;

  const messageMeta = await loadMessages(chatId);
  currentChatMessageSignature = messageMeta?.signature || latestSignature;

  const chat = chats.find(c => c.id === chatId);
  if (!chat) return;
  chat.last_message_at = messageMeta?.lastMessageAt || latest?.created_at || null;
  chat.unread_count = 0;
  sortChatsByLastActivity();
  renderChatList();
  markChatRead(chat);
}

function startChatListPolling() {
  stopChatListPolling();
  chatListPollTimer = setInterval(async () => {
    if (document.hidden || isChatListPolling) return;
    isChatListPolling = true;
    try {
      await loadChats();
    } finally {
      isChatListPolling = false;
    }
  }, 15000);
}

function stopChatListPolling() {
  if (!chatListPollTimer) return;
  clearInterval(chatListPollTimer);
  chatListPollTimer = null;
}

async function leaveChatFromList(chatId) {
  if (!chatId) return;
  const confirmLeave = confirm('Покинуть этот чат?');
  if (!confirmLeave) return;

  const { error } = await supabaseClient
    .from(TABLES.chat_members)
    .delete()
    .eq('chat_id', chatId)
    .eq('user_id', currentUser.id);

  if (error) {
    alert('Не удалось покинуть чат');
    console.error('Ошибка выхода из чата:', error);
    return;
  }

  removeChatFromList(chatId);
}

async function deletePersonalChat(chatId) {
  if (!chatId) return;
  const confirmDelete = confirm('Удалить этот личный чат у себя?');
  if (!confirmDelete) return;

  const { error } = await supabaseClient
    .from(TABLES.chat_members)
    .delete()
    .eq('chat_id', chatId)
    .eq('user_id', currentUser.id);

  if (error) {
    alert('Не удалось удалить чат');
    console.error('Ошибка удаления личного чата:', error);
    return;
  }

  removeChatFromList(chatId);
}

function removeChatFromList(chatId) {
  chats = chats.filter(chat => chat.id !== chatId);
  if (currentChat?.id === chatId) {
    stopMessagePolling();
    currentChatMessageSignature = 'empty';
    currentChat = null;
    const titleEl = document.getElementById('chat-title');
    const body = document.getElementById('chat-body');
    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('chat-send');
    if (titleEl) titleEl.textContent = 'Выберите чат';
    if (body) body.innerHTML = '<div class="chat-empty">Нет выбранного чата</div>';
    if (input) input.disabled = true;
    if (sendBtn) sendBtn.disabled = true;
    const infoContent = document.getElementById('info-content');
    if (infoContent) infoContent.innerHTML = '';
  }
  renderChatList();
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
    if (!currentChat) return;
    if (!text && !pendingImageFile) return;

    await ensureDirectPeer(currentChat);

    if (pendingImageFile) {
      const fileToSend = pendingImageFile;
      pendingImageFile = null;
      const preview = document.getElementById('image-preview');
      const previewImg = document.getElementById('image-preview-img');
      const previewName = document.getElementById('image-preview-name');
      if (preview) preview.style.display = 'none';
      if (previewImg) previewImg.src = '';
      if (previewName) previewName.textContent = '';
      await uploadAndSendImage(fileToSend);
      if (!text) return;
    }

    const { error } = await supabaseClient
      .from(TABLES.chat_messages)
      .insert([{ chat_id: currentChat.id, user_id: currentUser.id, content: text }]);

    if (error) {
      console.error('Ошибка отправки сообщения:', error);
      alert(error.message || 'Сообщение не отправлено');
      return;
    }
    input.value = '';
    const messageMeta = await loadMessages(currentChat.id);
    currentChatMessageSignature = messageMeta?.signature || currentChatMessageSignature;
  };

  input.addEventListener('keydown', async (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendBtn.click();
    }
  });
}

function setupImageUpload() {
  const attachBtn = document.getElementById('chat-attach');
  const fileInput = document.getElementById('chat-image-input');
  const preview = document.getElementById('image-preview');
  const previewImg = document.getElementById('image-preview-img');
  const previewName = document.getElementById('image-preview-name');
  const previewRemove = document.getElementById('image-preview-remove');
  if (!attachBtn || !fileInput) return;

  attachBtn.onclick = () => {
    if (!currentChat) return;
    fileInput.click();
  };

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file || !currentChat) return;
    if (!file.type.startsWith('image/')) {
      alert('Можно загружать только изображения');
      fileInput.value = '';
      return;
    }
    const maxBytes = MAX_IMAGE_MB * 1024 * 1024;
    if (file.size > maxBytes) {
      alert(`Максимальный размер изображения — ${MAX_IMAGE_MB} МБ`);
      fileInput.value = '';
      return;
    }
    pendingImageFile = file;
    if (preview && previewImg && previewName) {
      previewImg.src = URL.createObjectURL(file);
      previewName.textContent = file.name;
      preview.style.display = 'flex';
    }
  });

  if (previewRemove) {
    previewRemove.onclick = () => {
      pendingImageFile = null;
      if (preview) preview.style.display = 'none';
      if (previewImg) previewImg.src = '';
      if (previewName) previewName.textContent = '';
      if (fileInput) fileInput.value = '';
    };
  }
}

async function uploadAndSendImage(file) {
  if (!currentChat) return;
  const ext = file.name.split('.').pop() || 'jpg';
  const safeExt = ext.replace(/[^a-z0-9]/gi, '');
  const path = `${currentUser.id}/${currentChat.id}/${Date.now()}.${safeExt || 'jpg'}`;

  const { error: uploadError } = await supabaseClient
    .storage
    .from(CHAT_BUCKET)
    .upload(path, file, { cacheControl: '3600', upsert: false });

  if (uploadError) {
    console.error('Ошибка загрузки изображения:', uploadError);
    alert(`Не удалось загрузить изображение: ${uploadError.message || uploadError.error || 'Ошибка'}`);
    return;
  }

  const { data: publicData } = supabaseClient
    .storage
    .from(CHAT_BUCKET)
    .getPublicUrl(path);

  const imageUrl = publicData?.publicUrl;
  if (!imageUrl) {
    alert('Не удалось получить ссылку на изображение');
    return;
  }

  await ensureDirectPeer(currentChat);

  const { error } = await supabaseClient
    .from(TABLES.chat_messages)
    .insert([{ chat_id: currentChat.id, user_id: currentUser.id, content: `image:${imageUrl}` }]);

  if (error) {
    console.error('Ошибка отправки изображения:', error);
    alert('Изображение не отправлено');
    return;
  }

  const messageMeta = await loadMessages(currentChat.id);
  currentChatMessageSignature = messageMeta?.signature || currentChatMessageSignature;
}

function setupImageModal() {
  const modal = document.getElementById('image-modal');
  const modalImg = document.getElementById('image-modal-img');
  const previewImg = document.getElementById('image-preview-img');
  if (!modal || !modalImg) return;

  if (previewImg) {
    previewImg.addEventListener('click', () => {
      if (!previewImg.src) return;
      modalImg.src = previewImg.src;
      modal.style.display = 'flex';
    });
  }

  modal.addEventListener('click', () => {
    modal.style.display = 'none';
    modalImg.src = '';
  });
}

function setupTypingIndicator() {
  const input = document.getElementById('chat-input');
  if (!input) return;

  input.addEventListener('input', () => {
    if (!currentChat || !typingChannel) return;
    typingChannel.send({
      type: 'broadcast',
      event: 'typing',
      payload: { user_id: currentUser.id, chat_id: currentChat.id }
    });
    if (typingTimeoutId) clearTimeout(typingTimeoutId);
    typingTimeoutId = setTimeout(() => {
      typingChannel.send({
        type: 'broadcast',
        event: 'stop_typing',
        payload: { user_id: currentUser.id, chat_id: currentChat.id }
      });
    }, 1500);
  });
}

function setupChatTypingChannel(chatId) {
  const indicator = document.getElementById('typing-indicator');
  if (typingChannel) {
    supabaseClient.removeChannel(typingChannel);
    typingChannel = null;
  }

  if (!chatId) return;
  typingChannel = supabaseClient
    .channel(`typing:${chatId}`)
    .on('broadcast', { event: 'typing' }, payload => {
      if (!indicator) return;
      if (payload?.payload?.user_id === currentUser.id) return;
      indicator.style.display = 'inline';
      if (typingHideTimeoutId) clearTimeout(typingHideTimeoutId);
      typingHideTimeoutId = setTimeout(() => {
        indicator.style.display = 'none';
      }, 2000);
    })
    .on('broadcast', { event: 'stop_typing' }, payload => {
      if (!indicator) return;
      if (payload?.payload?.user_id === currentUser.id) return;
      indicator.style.display = 'none';
    })
    .subscribe();
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

    if (chat.owner_id !== currentUser.id) {
      const actions = document.createElement('div');
      actions.className = 'info-actions';
      actions.innerHTML = `
        <button class="info-btn danger" type="button">Покинуть чат</button>
      `;
      actions.querySelector('button').onclick = () => leaveChatFromList(chat.id);
      infoContent.appendChild(actions);
    }
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

    const actions = document.createElement('div');
    actions.className = 'info-actions';
    actions.innerHTML = `
      <button class="info-btn danger" type="button">Удалить чат</button>
    `;
    actions.querySelector('button').onclick = () => deletePersonalChat(chat.id);
    infoContent.appendChild(actions);
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

window.addEventListener('beforeunload', () => {
  stopMessagePolling();
  stopChatListPolling();
});
