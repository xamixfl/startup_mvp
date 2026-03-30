const { TABLES } = window.APP || {};

let currentUser = null;
let chats = [];
let currentChat = null;
let TOPICS = null;

const DEFAULT_AVATAR = 'assets/avatar.png';
const UNREAD_KEY = 'pulse_chat_last_read';
const ADMIN_MODERATION_CHAT_TITLE = 'Жалобы и апелляции';
const LEGACY_ADMIN_CHAT_TITLES = new Set(['Reports', ADMIN_MODERATION_CHAT_TITLE]);

let messagePollTimer = null;
let chatListPollTimer = null;
let typingPollTimer = null;
let typingTimeoutId = null;
let chatEventSource = null;
let chatRealtimeConnected = false;
const typingStateByChat = new Map();
let realtimeReconnectTimer = null;
let chatListRefreshTimer = null;

let currentChatMessageSignature = 'empty';
let pendingImageFile = null;
const MAX_IMAGE_MB = 5;
const MESSAGE_PAGE_SIZE = 50;
let currentChatLastCreatedAt = null;
let openedChatReadAt = {};
const renderedMessageKeysByChat = new Map();
const loadedMessagesByChat = new Map();
const hasOlderMessagesByChat = new Map();
const loadingOlderMessagesByChat = new Map();
const profileCache = new Map();

function isModerationChat(chat) {
  return Boolean(chat && !chat.meeting_id && LEGACY_ADMIN_CHAT_TITLES.has(String(chat.title || '').trim()));
}

function showNotification(message) {
  const notification = document.getElementById('notification');
  if (!notification) return;
  notification.textContent = message;
  notification.style.display = 'block';
  setTimeout(() => {
    notification.style.display = 'none';
  }, 2500);
}

function showChatBootError(error) {
  const list = document.getElementById('chat-list');
  const body = document.getElementById('chat-body');
  const text = error?.message || String(error) || 'Неизвестная ошибка';
  if (list) {
    list.innerHTML = `<div class="chat-item" style="white-space:normal;color:#b91c1c;border-color:#fecaca;background:#fef2f2;">Ошибка запуска чатов: ${escapeHtml(text)}</div>`;
  }
  if (body) {
    body.innerHTML = `<div class="chat-empty" style="color:#b91c1c;">Не удалось открыть чаты.<br>${escapeHtml(text)}</div>`;
  }
}

function notifyUser(message) {
  if (typeof showNotification === 'function') {
    showNotification(message);
    return;
  }
  alert(message);
}

function isoMax(a, b) {
  if (!a) return b || null;
  if (!b) return a || null;
  // ISO-8601 timestamps compare lexicographically in the same order as time.
  return a > b ? a : b;
}

function getRenderedKeySet(chatId) {
  if (!chatId) return new Set();
  if (!renderedMessageKeysByChat.has(chatId)) {
    renderedMessageKeysByChat.set(chatId, new Set());
  }
  return renderedMessageKeysByChat.get(chatId);
}

function getChatActivityAt(chat) {
  return chat?.__lastActivityAt || chat?.created_at || null;
}

function sortChatsByActivity(chatList) {
  chatList.sort((a, b) => {
    const aPinned = isModerationChat(a) ? 1 : 0;
    const bPinned = isModerationChat(b) ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    const aTime = new Date(getChatActivityAt(a) || 0).getTime();
    const bTime = new Date(getChatActivityAt(b) || 0).getTime();
    return bTime - aTime;
  });
}

async function hydrateChatActivity(chatList) {
  await Promise.all((chatList || []).map(async (chat) => {
    if (!chat?.id) return;
    chat.__lastActivityAt = chat.created_at || null;
    try {
      let lastMessages = [];
      try {
        lastMessages = await api.get(TABLES.chat_messages, {
          chat_id: chat.id,
          $order: { column: 'created_at', ascending: false },
          $limit: 1
        });
      } catch (_e) {
        lastMessages = await api.get(TABLES.chat_messages, { chat_id: chat.id, $limit: 1 });
        lastMessages = (lastMessages || []).sort((x, y) =>
          new Date(getMsgCreatedAt(y) || 0).getTime() - new Date(getMsgCreatedAt(x) || 0).getTime()
        );
      }
      const lastAt = getMsgCreatedAt((lastMessages || [])[0]);
      if (lastAt) {
        chat.__lastActivityAt = lastAt;
      }
    } catch (_e) {
      // keep chat.created_at as fallback activity timestamp
    }
  }));
}

function refreshChatListOrder() {
  const list = document.getElementById('chat-list');
  if (!list) return;
  sortChatsByActivity(chats);
  renderChatList(list);
  if (currentChat?.id) {
    highlightActiveChat(currentChat.id);
  }
}

async function initChatPage() {
  try {
    window.__chatScriptLoaded = true;
    currentUser = typeof window.getCurrentUser === 'function'
      ? await window.getCurrentUser()
      : await api.request('/api/auth/me');
    primeProfileCache(currentUser);

    if (!currentUser) {
      window.location.href = 'login.html';
      return;
    }

    if (currentUser.role === 'banned') {
      const body = document.getElementById('chat-body');
      if (body) {
        body.innerHTML = '<div class="chat-empty"><strong>Ваш аккаунт заблокирован.</strong><br>Вы не можете общаться с другими пользователями.</div>';
      }
      const input = document.getElementById('chat-input');
      const sendBtn = document.getElementById('chat-send');
      if (input) input.disabled = true;
      if (sendBtn) sendBtn.disabled = true;
      return;
    }

    if (typeof window.fetchTopics === 'function') {
      TOPICS = await window.fetchTopics();
    }

    setupChatSelectionFromUrl();
    startRealtimeStream();
    await loadChats();
    setupSendMessage();
    setupImageUpload();
    setupTypingIndicator();
    setupImageModal();
    setupTitleToggle();
    setupChatBodyPagination();

    startChatListPolling();
  } catch (error) {
    console.error('Ошибка запуска страницы чатов:', error);
    showChatBootError(error);
  }
}

window.__chatScriptLoaded = true;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initChatPage);
} else {
  initChatPage();
}

function getChatDisplayTitle(chat) {
  if (!chat) return 'Чат';
  return chat.__displayTitle || chat.title || 'Чат';
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

async function ensureModerationChatExistsForAdmins() {
  if (!currentUser || currentUser.role !== 'admin') return null;

  let admins = [];
  try {
    admins = await api.get(TABLES.profiles, { role: 'admin' });
  } catch (_e) {
    admins = [];
  }
  if (!admins.length) return null;

  let chat = null;
  try {
    const rows = await api.get(TABLES.chats, {
      title: { in: Array.from(LEGACY_ADMIN_CHAT_TITLES) },
      $order: { column: 'created_at', ascending: false }
    });
    chat = (rows || []).find(row => !row.meeting_id) || null;
  } catch (_e) {
    chat = null;
  }

  if (!chat) {
    try {
      const inserted = await api.insert(TABLES.chats, {
        title: ADMIN_MODERATION_CHAT_TITLE,
        owner_id: admins[0].id
      });
      chat = Array.isArray(inserted) ? inserted[0] : inserted;
    } catch (_e) {
      chat = null;
    }
  }
  if (!chat) return null;

  chat.title = ADMIN_MODERATION_CHAT_TITLE;
  chat.is_admin_chat = true;
  chat.__subTitle = 'Жёлтый чат для жалоб и апелляций';

  let existingMembers = [];
  try {
    existingMembers = await api.get(TABLES.chat_members, { chat_id: chat.id });
  } catch (_e) {
    existingMembers = [];
  }
  const memberIds = new Set((existingMembers || []).map(row => row.user_id).filter(Boolean));
  const hasStatus = await chatMembersHasStatus();

  for (const admin of admins) {
    if (!admin?.id || memberIds.has(admin.id)) continue;
    try {
      await safeInsertChatMember(hasStatus
        ? {
            chat_id: chat.id,
            user_id: admin.id,
            role: admin.id === chat.owner_id ? 'owner' : 'member',
            status: 'approved'
          }
        : { chat_id: chat.id, user_id: admin.id }
      );
      memberIds.add(admin.id);
    } catch (_e) {
      // ignore duplicate/legacy rows
    }
  }

  return chat;
}

async function getOwnedChatsForUser(userId) {
  try {
    return await api.get(TABLES.chats, { owner_id: userId, $order: { column: 'created_at', ascending: false } });
  } catch (_e) {
    // Some schemas may use a different column name.
    try {
      return await api.get(TABLES.chats, { creator_id: userId, $order: { column: 'created_at', ascending: false } });
    } catch (_e2) {
      return [];
    }
  }
}

function setupChatSelectionFromUrl() {
  const chatId = new URLSearchParams(window.location.search).get('chat_id');
  if (chatId) {
    // will be opened after loadChats()
    window.__pendingOpenChatId = chatId;
  }
}

function startChatListPolling() {
  stopChatListPolling();
  chatListPollTimer = setInterval(async () => {
    if (!currentUser) return;
    await loadChats(true);
  }, 15000);
}

function stopChatListPolling() {
  if (chatListPollTimer) clearInterval(chatListPollTimer);
  chatListPollTimer = null;
}

function startMessagePolling(chatId) {
  stopMessagePolling();
  messagePollTimer = setInterval(async () => {
    if (!currentChat || currentChat.id !== chatId) return;
    await pollNewMessages(chatId);
  }, 2000);
}

function stopMessagePolling() {
  if (messagePollTimer) clearInterval(messagePollTimer);
  messagePollTimer = null;
}

function startTypingPolling(chatId) {
  stopTypingPolling();
  typingPollTimer = setInterval(async () => {
    if (!currentChat || currentChat.id !== chatId) return;
    await refreshTypingIndicator(chatId);
  }, 2000);
}

function stopTypingPolling() {
  if (typingPollTimer) clearInterval(typingPollTimer);
  typingPollTimer = null;
}

function startRealtimeStream() {
  stopRealtimeStream();
  try {
    chatEventSource = new EventSource('/api/events/stream');
  } catch (error) {
    console.warn('Не удалось открыть realtime-поток:', error);
    chatRealtimeConnected = false;
    return;
  }

  chatEventSource.addEventListener('ready', () => {
    chatRealtimeConnected = true;
    stopMessagePolling();
    stopTypingPolling();
  });

  chatEventSource.addEventListener('chat_message', async (event) => {
    let payload = null;
    try {
      payload = JSON.parse(event.data || '{}');
    } catch (_e) {
      payload = null;
    }
    const chatId = payload?.chat_id;
    const message = payload?.message;
    if (!chatId || !message) return;
    await handleRealtimeMessage(chatId, message);
  });

  chatEventSource.addEventListener('typing', (event) => {
    let payload = null;
    try {
      payload = JSON.parse(event.data || '{}');
    } catch (_e) {
      payload = null;
    }
    applyRealtimeTypingEvent(payload);
  });

  chatEventSource.onerror = () => {
    chatRealtimeConnected = false;
    if (currentChat?.id) {
      startMessagePolling(currentChat.id);
      startTypingPolling(currentChat.id);
    }
    if (!realtimeReconnectTimer) {
      realtimeReconnectTimer = setTimeout(() => {
        realtimeReconnectTimer = null;
        startRealtimeStream();
      }, 3000);
    }
  };
}

function stopRealtimeStream() {
  if (chatEventSource) {
    chatEventSource.close();
    chatEventSource = null;
  }
  if (realtimeReconnectTimer) {
    clearTimeout(realtimeReconnectTimer);
    realtimeReconnectTimer = null;
  }
  chatRealtimeConnected = false;
}

function scheduleChatListRefresh() {
  if (chatListRefreshTimer) return;
  chatListRefreshTimer = setTimeout(async () => {
    chatListRefreshTimer = null;
    await loadChats(true);
  }, 400);
}

function setupChatBodyPagination() {
  const body = document.getElementById('chat-body');
  if (!body || body.dataset.paginationBound === 'true') return;
  body.dataset.paginationBound = 'true';
  body.addEventListener('scroll', () => {
    if (!currentChat?.id) return;
    if (body.scrollTop > 80) return;
    loadOlderMessages(currentChat.id).catch(() => {});
  });
}

async function removeChatCompletely(chatId) {
  if (!chatId) return;
  try {
    await api.query(TABLES.chat_messages, 'deleteWhere', {}, { chat_id: chatId });
  } catch (_e) {}
  try {
    await api.query(TABLES.chat_members, 'deleteWhere', {}, { chat_id: chatId });
  } catch (_e) {}
  try {
    await api.delete(TABLES.chats, chatId);
  } catch (_e) {}
}

async function filterOutStaleMeetingChats(chatRows) {
  const rows = Array.isArray(chatRows) ? [...chatRows] : [];
  const meetingChats = rows.filter(chat => chat?.meeting_id);
  if (!meetingChats.length) return rows;

  const meetingIds = Array.from(new Set(meetingChats.map(chat => chat.meeting_id).filter(Boolean)));
  let meetings = [];
  try {
    meetings = await api.get(TABLES.meetings, { id: { in: meetingIds } });
  } catch (_e) {
    return rows;
  }

  const nowIso = new Date().toISOString();
  const byId = new Map((meetings || []).map(meeting => [meeting.id, meeting]));
  const staleChatIds = [];
  const filtered = rows.filter(chat => {
    if (!chat?.meeting_id) return true;
    const meeting = byId.get(chat.meeting_id);
    if (!meeting) {
      staleChatIds.push(chat.id);
      return false;
    }
    if (meeting.expires_at && meeting.expires_at <= nowIso) {
      staleChatIds.push(chat.id);
      return false;
    }
    return true;
  });

  await Promise.all(staleChatIds.map(chatId => removeChatCompletely(chatId)));
  return filtered;
}

async function loadChats(isRefresh = false) {
  const list = document.getElementById('chat-list');
  if (!list) return;
  if (!isRefresh) list.innerHTML = '<div class="chat-item">Загрузка...</div>';

  try {
    await ensureModerationChatExistsForAdmins();

    const summary = await api.request('/api/chats/summary');
    const summaryChats = Array.isArray(summary?.chats) ? summary.chats : [];
    chats = await filterOutStaleMeetingChats(summaryChats);

    if (chats.length === 0) {
      list.innerHTML = '<div class="chat-item">Нет чатов</div>';
      renderEmptyChat();
      return;
    }

    sortChatsByActivity(chats);
    renderChatList(list);

    const pendingId = window.__pendingOpenChatId;
    if (pendingId) {
      window.__pendingOpenChatId = null;
      openChat(pendingId);
    } else if (!currentChat && chats.length > 0) {
      openChat(chats[0].id);
    } else if (currentChat) {
      // keep selection highlight
      highlightActiveChat(currentChat.id);
    }
  } catch (error) {
    console.error('Ошибка загрузки чатов:', error);
    if (!isRefresh) list.innerHTML = '<div class="chat-item">Ошибка загрузки</div>';
  }
}

async function enrichChatsForUi(chatsList) {
  const direct = (chatsList || []).filter(c => c && !c.meeting_id);
  if (direct.length === 0) return;

  // 1) Find peer ids for direct chats from chat_members (ignore unreliable chat.peer_id/chat.title).
  const directChatIds = direct.map(c => c.id).filter(Boolean);
  const byChatId = new Map();
  try {
    const memberRows = await api.get(TABLES.chat_members, { chat_id: { in: directChatIds } });
    (memberRows || []).forEach(r => {
      if (!r?.chat_id || !r?.user_id) return;
      if (!byChatId.has(r.chat_id)) byChatId.set(r.chat_id, []);
      byChatId.get(r.chat_id).push(r.user_id);
    });
  } catch (_e) {
    // ignore
  }

  const peerIds = [];
  for (const chat of direct) {
    const ids = byChatId.get(chat.id) || [];
    let peerId = ids.find(id => id && id !== currentUser.id) || null;
    // If chat.peer_id points to self, treat it as invalid.
    if (!peerId && chat.peer_id && chat.peer_id !== currentUser.id) {
      peerId = chat.peer_id;
    }
    if (peerId) {
      chat.peer_id = peerId;
      peerIds.push(peerId);
    }
  }

  // 2) Fetch peer profiles in batch and attach display titles
  const uniquePeerIds = Array.from(new Set(peerIds));
  const profiles = uniquePeerIds.length
    ? await api.get(TABLES.profiles, { id: { in: uniquePeerIds } })
    : [];
  const byId = new Map((profiles || []).map(p => [p.id, p]));

  for (const chat of direct) {
    const peer = chat.peer_id ? byId.get(chat.peer_id) : null;
    chat.__peerProfile = peer || null;
    chat.__displayTitle = peer
      ? (peer.full_name || peer.username || chat.title || 'Личный чат')
      : (chat.title || 'Личный чат');
  }
}

function renderChatList(list) {
  list.innerHTML = '';

  chats.forEach(chat => {
    const item = document.createElement('div');
    item.className = 'chat-item';
    if (chat.is_admin_chat || isModerationChat(chat)) item.classList.add('chat-item-admin');
    item.dataset.chatId = chat.id;

    const title = getChatDisplayTitle(chat);
    item.innerHTML = `
      <div class="chat-item-row">
        <div class="chat-item-title">${escapeHtml(title)}</div>
        <div class="chat-unread" style="display:none;"></div>
      </div>
      <div class="chat-item-sub">${escapeHtml(chat.__subTitle || (isModerationChat(chat) ? 'Жалобы и апелляции' : (chat.meeting_id ? 'Чат встречи' : 'Личный чат')))}</div>
    `;

    item.onclick = () => openChat(chat.id);
    list.appendChild(item);
  });

  // Update unread badges asynchronously
  updateChatListUnreadBadges().catch(() => {});
}

function highlightActiveChat(chatId) {
  document.querySelectorAll('.chat-item').forEach(el => {
    el.classList.toggle('active', el.dataset.chatId === chatId);
  });
}

async function updateChatListUnreadBadges() {
  if (!currentUser) return;

  let readMap = {};
  try {
    const raw = localStorage.getItem(UNREAD_KEY);
    readMap = raw ? JSON.parse(raw) : {};
  } catch (_e) {}

  const perChatReadMap = {};
  for (const chat of chats) {
    const readKey = `${currentUser.id}:${chat.id}`;
    perChatReadMap[chat.id] = openedChatReadAt[chat.id] || readMap[readKey] || null;
  }

  let counts = {};
  try {
    const summary = await api.request('/api/chats/unread-summary', {
      method: 'POST',
      body: JSON.stringify({ lastReadMap: perChatReadMap })
    });
    counts = summary?.counts || {};
  } catch (_e) {
    counts = {};
  }

  for (const chat of chats) {
    const el = document.querySelector(`.chat-item[data-chat-id="${chat.id}"] .chat-unread`);
    if (!el) continue;
    const count = currentChat && currentChat.id === chat.id ? 0 : Number(counts[chat.id] || 0);
    if (count > 0) {
      el.textContent = count > 99 ? '99+' : String(count);
      el.style.display = 'inline-flex';
    } else {
      el.style.display = 'none';
    }
  }
}

async function openChat(chatId) {
  const chat = chats.find(c => c.id === chatId);
  if (!chat) return;

  currentChat = chat;
  highlightActiveChat(chatId);

  const title = document.getElementById('chat-title');
  if (title) title.textContent = getChatDisplayTitle(chat);

  // Refresh info panel content if it's currently open.
  const app = document.getElementById('chat-app');
  if (app && app.classList.contains('show-info')) {
    renderInfoPanel(chat).catch(() => {});
  }

  // Enable input controls now that a chat is selected
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const attachBtn = document.getElementById('chat-attach');
  if (input) {
    input.disabled = false;
    input.placeholder = 'Сообщение...';
  }
  if (sendBtn) sendBtn.disabled = false;
  if (attachBtn) attachBtn.disabled = false;

  renderEmptyChat('Загрузка сообщений...');
  const meta = await loadInitialMessages(chatId);
  currentChatMessageSignature = meta?.signature || currentChatMessageSignature;
  currentChatLastCreatedAt = meta?.lastCreatedAt || null;

  // Mark as read at the moment the user opened the chat.
  // This avoids "unread" badges sticking around when the chat has many messages
  // or when we only fetched a limited window of history.
  const readAt = new Date().toISOString();
  openedChatReadAt[chatId] = readAt;
  markChatRead(chatId, readAt);
  // Optimistically clear badge for the opened chat.
  const badgeEl = document.querySelector(`.chat-item[data-chat-id="${chatId}"] .chat-unread`);
  if (badgeEl) badgeEl.style.display = 'none';
  updateChatListUnreadBadges().catch(() => {});

  if (chatRealtimeConnected) {
    stopMessagePolling();
    stopTypingPolling();
  } else {
    startMessagePolling(chatId);
    startTypingPolling(chatId);
  }
}

function renderEmptyChat(text = 'Выберите чат слева') {
  const body = document.getElementById('chat-body');
  if (!body) return;
  body.innerHTML = `<div class="chat-empty">${escapeHtml(text)}</div>`;
}

function computeMessageSignature(messages) {
  if (!messages || messages.length === 0) return 'empty';
  const last = messages[messages.length - 1];
  const at = getMsgCreatedAt(last) || '';
  return `${messages.length}:${last.id || ''}:${at}`;
}

function getMsgCreatedAt(msg) {
  return msg?.created_at || msg?.createdAt || msg?.timestamp || null;
}

function normalizeMessageProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const normalized = { ...profile };
  if (normalized.photo_url && !normalized.photo_URL) {
    normalized.photo_URL = normalized.photo_url;
  }
  if (normalized.city && !normalized.location) {
    normalized.location = normalized.city;
  }
  if (!normalized.about) {
    if (normalized.bio) normalized.about = normalized.bio;
    else if (normalized.description) normalized.about = normalized.description;
  }
  return normalized;
}

function primeProfileCache(profile) {
  const normalized = normalizeMessageProfile(profile);
  if (!normalized?.id) return normalized;
  profileCache.set(normalized.id, normalized);
  return normalized;
}

function getMessageProfile(msg, fallbackProfile = null) {
  const direct = primeProfileCache(msg?.sender_profile || msg?.__profile || fallbackProfile);
  if (direct) return direct;
  return msg?.user_id ? (profileCache.get(msg.user_id) || null) : null;
}

function isAtBottom(bodyEl) {
  if (!bodyEl) return true;
  return (bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight) < 60;
}

async function fetchChatMessagesPage(chatId, options = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(options.limit || MESSAGE_PAGE_SIZE));
  if (options.before) params.set('before', options.before);
  if (options.after) params.set('after', options.after);
  const queryString = params.toString();
  return api.request(`/api/chats/${encodeURIComponent(chatId)}/messages${queryString ? `?${queryString}` : ''}`, {
    method: 'GET'
  });
}

function renderMessagesFromStore(chatId, options = {}) {
  const body = document.getElementById('chat-body');
  if (!body) return;
  const messages = loadedMessagesByChat.get(chatId) || [];

  body.innerHTML = '';
  getRenderedKeySet(chatId).clear();

  if (hasOlderMessagesByChat.get(chatId)) {
    const marker = document.createElement('div');
    marker.className = 'message-history-marker';
    marker.textContent = loadingOlderMessagesByChat.get(chatId)
      ? 'Загрузка более ранних сообщений...'
      : 'Прокрутите вверх, чтобы загрузить более ранние сообщения';
    body.appendChild(marker);
  }

  const userIds = Array.from(new Set(messages.map(m => m.user_id).filter(Boolean)));
  return (async () => {
    let profiles = [];
    const missingIds = userIds.filter(id => !profileCache.has(id));
    try {
      profiles = missingIds.length ? await api.get(TABLES.profiles, { id: { in: missingIds } }) : [];
    } catch (_e) {
      profiles = [];
    }
    (profiles || []).forEach(primeProfileCache);

    let previousMessageDateKey = null;
    messages.forEach(msg => {
      const messageDateKey = getMessageDateKey(msg.created_at);
      if (messageDateKey && messageDateKey !== previousMessageDateKey) {
        body.appendChild(renderDateSeparator(msg.created_at));
        previousMessageDateKey = messageDateKey;
      }

      const key = msg.id ? `id:${msg.id}` : `k:${getMsgCreatedAt(msg) || ''}:${msg.user_id || ''}:${msg.content || ''}`;
      getRenderedKeySet(chatId).add(key);
      const mine = msg.user_id === currentUser.id;
      const p = getMessageProfile(msg, mine ? currentUser : null);
      body.appendChild(renderMessage(msg, p, mine));
    });

    if (options.preserveOffset) {
      const nextHeight = body.scrollHeight;
      body.scrollTop = Math.max(nextHeight - options.preserveOffset, 0);
    } else if (options.scrollToBottom) {
      body.scrollTop = body.scrollHeight;
    }
  })();
}

async function loadInitialMessages(chatId) {
  const body = document.getElementById('chat-body');
  if (!body) return null;

  try {
    const page = await fetchChatMessagesPage(chatId, { limit: MESSAGE_PAGE_SIZE });
    const messages = Array.isArray(page?.messages) ? page.messages : [];
    loadedMessagesByChat.set(chatId, messages);
    hasOlderMessagesByChat.set(chatId, Boolean(page?.has_more));

    const signature = computeMessageSignature(messages);
    currentChatMessageSignature = signature;
    await renderMessagesFromStore(chatId, { scrollToBottom: true });

    const lastCreatedAt = (messages && messages.length) ? getMsgCreatedAt(messages[messages.length - 1]) : null;
    return { signature, lastCreatedAt };
  } catch (error) {
    console.error('Ошибка загрузки сообщений:', error);
    renderEmptyChat('Ошибка загрузки сообщений');
    return null;
  }
}

async function pollNewMessages(chatId) {
  const body = document.getElementById('chat-body');
  if (!body || !currentUser || !currentChat || currentChat.id !== chatId) return;

  const wasAtBottom = isAtBottom(body);

  const filters = {
    chat_id: chatId,
    $order: { column: 'created_at', ascending: true },
    $limit: 50
  };
  if (currentChatLastCreatedAt) {
    filters.created_at = { gt: currentChatLastCreatedAt };
  }

  let messages = [];
  try {
    messages = await api.get(TABLES.chat_messages, filters);
  } catch (_e) {
    return;
  }
  if (!messages || messages.length === 0) return;

  const seen = getRenderedKeySet(chatId);
  const fresh = [];
  for (const msg of messages) {
    const key = msg.id ? `id:${msg.id}` : `k:${getMsgCreatedAt(msg) || ''}:${msg.user_id || ''}:${msg.content || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(msg);
  }
  if (fresh.length === 0) return;
  await appendMessagesToChat(chatId, fresh);

  const last = fresh[fresh.length - 1];
  const lastAt = getMsgCreatedAt(last);
  if (lastAt) {
    currentChatLastCreatedAt = isoMax(currentChatLastCreatedAt, lastAt);
    openedChatReadAt[chatId] = isoMax(openedChatReadAt[chatId], lastAt);
    markChatRead(chatId, lastAt);
    if (currentChat?.id === chatId) {
      currentChat.__lastActivityAt = lastAt;
    }
  }

  refreshChatListOrder();
  if (wasAtBottom) body.scrollTop = body.scrollHeight;
  updateChatListUnreadBadges().catch(() => {});
}

async function appendMessagesToChat(chatId, fresh, options = {}) {
  const body = document.getElementById('chat-body');
  if (!body || !Array.isArray(fresh) || fresh.length === 0) return;

  const wasAtBottom = options.forceScroll ? true : isAtBottom(body);
  const existing = loadedMessagesByChat.get(chatId) || [];
  const knownKeys = new Set(existing.map(msg => msg.id ? `id:${msg.id}` : `k:${getMsgCreatedAt(msg) || ''}:${msg.user_id || ''}:${msg.content || ''}`));
  const uniqueFresh = fresh.filter(msg => {
    const key = msg.id ? `id:${msg.id}` : `k:${getMsgCreatedAt(msg) || ''}:${msg.user_id || ''}:${msg.content || ''}`;
    if (knownKeys.has(key)) return false;
    knownKeys.add(key);
    return true;
  });
  if (uniqueFresh.length === 0) return;

  loadedMessagesByChat.set(chatId, existing.concat(uniqueFresh));
  const userIds = Array.from(new Set(uniqueFresh.map(m => m.user_id).filter(Boolean)));
  let profiles = [];
  const missingIds = userIds.filter(id => !profileCache.has(id) && !uniqueFresh.some(msg => msg.user_id === id && (msg.sender_profile || msg.__profile)));
  try {
    profiles = missingIds.length ? await api.get(TABLES.profiles, { id: { in: missingIds } }) : [];
  } catch (_e) {
    profiles = [];
  }
  (profiles || []).forEach(primeProfileCache);

  uniqueFresh.forEach(msg => {
    const key = msg.id ? `id:${msg.id}` : `k:${getMsgCreatedAt(msg) || ''}:${msg.user_id || ''}:${msg.content || ''}`;
    getRenderedKeySet(chatId).add(key);
    const mine = msg.user_id === currentUser.id;
    const p = getMessageProfile(msg, mine ? currentUser : null);
    body.appendChild(renderMessage(msg, p, mine));
  });

  const last = uniqueFresh[uniqueFresh.length - 1];
  const lastAt = getMsgCreatedAt(last);
  if (lastAt) {
    currentChatLastCreatedAt = isoMax(currentChatLastCreatedAt, lastAt);
    openedChatReadAt[chatId] = isoMax(openedChatReadAt[chatId], lastAt);
    markChatRead(chatId, lastAt);
    if (currentChat?.id === chatId) {
      currentChat.__lastActivityAt = lastAt;
    }
  }

  if (wasAtBottom) {
    body.scrollTop = body.scrollHeight;
  }
}

async function loadOlderMessages(chatId) {
  if (!chatId || loadingOlderMessagesByChat.get(chatId) || !hasOlderMessagesByChat.get(chatId)) return;
  const currentMessages = loadedMessagesByChat.get(chatId) || [];
  const oldest = currentMessages.length > 0 ? getMsgCreatedAt(currentMessages[0]) : null;
  if (!oldest) return;

  loadingOlderMessagesByChat.set(chatId, true);
  const body = document.getElementById('chat-body');
  const preserveOffset = body ? (body.scrollHeight - body.scrollTop) : null;

  try {
    const page = await fetchChatMessagesPage(chatId, {
      limit: MESSAGE_PAGE_SIZE,
      before: oldest
    });
    const olderMessages = Array.isArray(page?.messages) ? page.messages : [];
    if (olderMessages.length > 0) {
      loadedMessagesByChat.set(chatId, olderMessages.concat(currentMessages));
    }
    hasOlderMessagesByChat.set(chatId, Boolean(page?.has_more));
    await renderMessagesFromStore(chatId, {
      preserveOffset
    });
  } catch (error) {
    console.error('Ошибка загрузки старых сообщений:', error);
  } finally {
    loadingOlderMessagesByChat.set(chatId, false);
  }
}

async function handleRealtimeMessage(chatId, message) {
  const chat = chats.find(item => item.id === chatId);
  const eventAt = getMsgCreatedAt(message) || new Date().toISOString();
  if (!chat) {
    scheduleChatListRefresh();
    return;
  }

  chat.__lastActivityAt = eventAt;
  chat.__lastMessage = {
    id: message.id || null,
    user_id: message.user_id || null,
    content: message.content || '',
    created_at: eventAt
  };

  if (!currentChat || currentChat.id !== chatId) {
    refreshChatListOrder();
    updateChatListUnreadBadges().catch(() => {});
    return;
  }

  const key = message.id ? `id:${message.id}` : `k:${getMsgCreatedAt(message) || ''}:${message.user_id || ''}:${message.content || ''}`;
  if (!getRenderedKeySet(chatId).has(key)) {
    await appendMessagesToChat(chatId, [message], {
      forceScroll: message.user_id === currentUser.id
    });
  }

  refreshChatListOrder();
  updateChatListUnreadBadges().catch(() => {});
}

function renderMessage(msg, profile, mine) {
  const wrap = document.createElement('div');

  const rawContent = String(msg.content || '');
  const isSystem = rawContent.startsWith('system:');
  const bodyContent = isSystem ? rawContent.slice('system:'.length).trim() : rawContent;
  if (isSystem) {
    wrap.className = 'message system';
    wrap.innerHTML = `<div class="message-content">${escapeHtml(bodyContent)}</div>`;
    return wrap;
  }
  const isImage = !isSystem && bodyContent.startsWith('image:');
  const payload = isImage ? bodyContent.slice('image:'.length) : bodyContent;
  const classes = ['message'];
  if (mine) classes.push('mine');
  wrap.className = classes.join(' ');

  const senderName = mine ? 'Вы' : (profile?.full_name || profile?.username || 'Пользователь');
  const avatarUrl = profile?.photo_URL && profile.photo_URL !== 'user' ? profile.photo_URL : DEFAULT_AVATAR;
  const fullWhen = formatMessageDateTime(msg.created_at);
  const shortWhen = formatMessageTime(msg.created_at);
  const profileId = profile?.id || msg.user_id;
  const nameHtml = profileId
    ? `<a href="profile.html?id=${escapeHtml(profileId)}" class="message-sender">${escapeHtml(senderName)}</a>`
    : `<span class="message-sender">${escapeHtml(senderName)}</span>`;
  const avatarHtml = mine ? '' : `<div class="message-avatar"><img src="${avatarUrl}" alt="${escapeHtml(senderName)}" onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}';"></div>`;

  wrap.innerHTML = `
    <div class="message-meta">
      ${avatarHtml}
      ${nameHtml}
    </div>
    <div class="message-content"></div>
    <div class="message-time" title="${escapeHtml(fullWhen)}">${escapeHtml(shortWhen)}</div>
  `;

  const contentEl = wrap.querySelector('.message-content');
  if (contentEl) {
    if (isImage) {
      contentEl.innerHTML = `<img class="message-image" src="${escapeHtml(payload)}" alt="image" style="max-width:100%;border-radius:12px;cursor:pointer;">`;
      const img = contentEl.querySelector('img');
      if (img) {
        img.addEventListener('click', () => openImageModal(payload));
      }
    } else {
      contentEl.textContent = bodyContent;
    }
  }

  return wrap;
}

function renderDateSeparator(isoString) {
  const el = document.createElement('div');
  el.className = 'message-date-separator';
  el.textContent = formatMessageDayLabel(isoString);
  return el;
}

function getMessageDateKey(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return [date.getFullYear(), date.getMonth(), date.getDate()].join('-');
}

function formatMessageTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatMessageDateTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function formatMessageDayLabel(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';

  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (isSameCalendarDay(date, today)) return 'Сегодня';
  if (isSameCalendarDay(date, yesterday)) return 'Вчера';

  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    weekday: 'long'
  }).format(date);
}

function isSameCalendarDay(a, b) {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function markChatRead(chatId, createdAt) {
  if (!currentUser) return;
  let readMap = {};
  try {
    const raw = localStorage.getItem(UNREAD_KEY);
    readMap = raw ? JSON.parse(raw) : {};
  } catch (_e) {}
  const key = `${currentUser.id}:${chatId}`;
  const next = createdAt || new Date().toISOString();
  // Never move the read cursor backwards.
  readMap[key] = isoMax(readMap[key], next) || next;
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify(readMap));
  } catch (_e) {}
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
      clearImagePreview();
      await uploadAndSendImage(fileToSend);
      if (!text) return;
    }

    try {
      const row = await api.request(`/api/chats/${encodeURIComponent(currentChat.id)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: text })
      });
      input.value = '';

      if (!chatRealtimeConnected && row) {
        await handleRealtimeMessage(currentChat.id, row);
      }
    } catch (error) {
      console.error('Ошибка отправки сообщения:', error);
      alert(error.message || 'Сообщение не отправлено');
    }
  };

  input.addEventListener('keydown', (event) => {
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

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file || !currentChat) return;
    if (!file.type.startsWith('image/')) {
      alert('Можно загружать только изображения');
      fileInput.value = '';
      return;
    }
    const maxBytes = MAX_IMAGE_MB * 1024 * 1024;
    if (file.size > maxBytes) {
      alert(`Максимальный размер изображения - ${MAX_IMAGE_MB} МБ`);
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
      clearImagePreview();
      if (fileInput) fileInput.value = '';
    };
  }
}

function clearImagePreview() {
  const preview = document.getElementById('image-preview');
  const previewImg = document.getElementById('image-preview-img');
  const previewName = document.getElementById('image-preview-name');
  if (preview) preview.style.display = 'none';
  if (previewImg) previewImg.src = '';
  if (previewName) previewName.textContent = '';
}

async function uploadAndSendImage(file) {
  if (!currentChat) return;

  try {
    const fd = new FormData();
    fd.append('file', file);
    const resp = await fetch('/api/upload/chat-image', { method: 'POST', body: fd });
    if (!resp.ok) throw new Error(`upload failed: ${resp.status}`);
    const json = await resp.json();
    const imageUrl = json && json.url ? json.url : null;
    if (!imageUrl) throw new Error('no url');

    const row = await api.request(`/api/chats/${encodeURIComponent(currentChat.id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: `image:${imageUrl}` })
    });

    if (!chatRealtimeConnected && row) {
      await handleRealtimeMessage(currentChat.id, row);
    }
  } catch (error) {
    console.error('Ошибка отправки изображения:', error);
    alert('Изображение не отправлено');
  }
}

function setupImageModal() {
  const modal = document.getElementById('image-modal');
  const modalImg = document.getElementById('image-modal-img');
  if (!modal || !modalImg) return;

  modal.addEventListener('click', () => {
    modal.style.display = 'none';
    modalImg.src = '';
  });
}

function openImageModal(url) {
  const modal = document.getElementById('image-modal');
  const modalImg = document.getElementById('image-modal-img');
  if (!modal || !modalImg) return;
  modalImg.src = url;
  modal.style.display = 'flex';
}

async function clearDirectChat(forEveryone) {
  if (!currentChat || currentChat.meeting_id) return;
  const chatId = currentChat.id;
  const prompt = forEveryone
    ? 'Удалить чат у всех участников? Это действие уберёт историю и закроет переписку для собеседника.'
    : 'Удалить чат только у себя? Вы сможете начать переписку заново позже.';
  if (!confirm(prompt)) return;

  try {
    if (forEveryone) {
      await api.query(TABLES.chat_messages, 'deleteWhere', {}, { chat_id: chatId });
      await api.query(TABLES.chat_members, 'deleteWhere', {}, { chat_id: chatId });
      await api.delete(TABLES.chats, chatId);
    } else {
      await api.query(TABLES.chat_members, 'deleteWhere', {}, { chat_id: chatId, user_id: currentUser.id });
    }

    delete openedChatReadAt[chatId];
    currentChat = null;
    currentChatLastCreatedAt = null;
    renderedMessageKeysByChat.delete(chatId);
    renderEmptyChat('Выберите чат слева');
    stopMessagePolling();
    stopTypingPolling();
    await loadChats(true);
    toggleInfoPanel(false);
    notifyUser('Чат очищен');
  } catch (error) {
    console.error('Ошибка очищения чата:', error);
    alert('Не удалось очистить чат');
  }
}

function setupTypingIndicator() {
  const input = document.getElementById('chat-input');
  if (!input) return;

  input.addEventListener('input', async () => {
    if (!currentChat) return;
    try {
      await api.request('/api/typing', {
        method: 'POST',
        body: JSON.stringify({ chat_id: currentChat.id, is_typing: true })
      });
    } catch (_e) {}

    if (typingTimeoutId) clearTimeout(typingTimeoutId);
    typingTimeoutId = setTimeout(async () => {
      if (!currentChat) return;
      try {
        await api.request('/api/typing', {
          method: 'POST',
          body: JSON.stringify({ chat_id: currentChat.id, is_typing: false })
        });
      } catch (_e) {}
    }, 1500);
  });
}

async function refreshTypingIndicator(chatId) {
  const el = document.getElementById('typing-indicator');
  if (!el) return;
  if (chatRealtimeConnected) {
    const perChat = typingStateByChat.get(chatId) || new Map();
    const now = Date.now();
    for (const [userId, expiresAt] of perChat.entries()) {
      if (expiresAt <= now) {
        perChat.delete(userId);
      }
    }
    if (perChat.size > 0) {
      el.textContent = 'Собеседник печатает...';
      el.style.display = 'inline';
    } else {
      el.textContent = '';
      el.style.display = 'none';
    }
    return;
  }
  try {
    const resp = await api.request(`/api/typing?chat_id=${encodeURIComponent(chatId)}`, { method: 'GET' });
    const ids = Array.isArray(resp?.user_ids) ? resp.user_ids : [];
    if (ids.length > 0) {
      el.textContent = 'Собеседник печатает...';
      el.style.display = 'inline';
    } else {
      el.textContent = '';
      el.style.display = 'none';
    }
  } catch (_e) {
    el.textContent = '';
    el.style.display = 'none';
  }
}

function applyRealtimeTypingEvent(payload) {
  const chatId = payload?.chat_id;
  const userId = payload?.user_id;
  if (!chatId || !userId || userId === currentUser?.id) return;

  if (!typingStateByChat.has(chatId)) {
    typingStateByChat.set(chatId, new Map());
  }
  const perChat = typingStateByChat.get(chatId);
  if (payload.is_typing) {
    perChat.set(userId, Date.now() + TYPING_TTL_MS);
  } else {
    perChat.delete(userId);
  }

  if (currentChat?.id === chatId) {
    refreshTypingIndicator(chatId).catch(() => {});
  }
}

async function ensureDirectPeer(chat) {
  if (!chat || chat.meeting_id) return;
  if (!chat.peer_id) return;

  try {
    const members = await api.get(TABLES.chat_members, { chat_id: chat.id });
    const hasMe = (members || []).some(m => m.user_id === currentUser.id);
    const hasPeer = (members || []).some(m => m.user_id === chat.peer_id);
    const hasStatus = await chatMembersHasStatus();
    if (!hasMe) {
      await safeInsertChatMember(hasStatus
        ? { chat_id: chat.id, user_id: currentUser.id, role: 'owner', status: 'approved' }
        : { chat_id: chat.id, user_id: currentUser.id }
      );
    }
    if (!hasPeer) {
      await safeInsertChatMember(hasStatus
        ? { chat_id: chat.id, user_id: chat.peer_id, role: 'member', status: 'approved' }
        : { chat_id: chat.id, user_id: chat.peer_id }
      );
    }
  } catch (_e) {
    // ignore
  }
}

function setupTitleToggle() {
  const title = document.getElementById('chat-title');
  if (!title) return;
  title.onclick = () => {
    if (!currentChat) return;
    toggleInfoPanel();
  };
}

function toggleInfoPanel(force) {
  const app = document.getElementById('chat-app');
  if (!app) return;
  const next = typeof force === 'boolean' ? force : !app.classList.contains('show-info');
  app.classList.toggle('show-info', next);
  if (next) {
    renderInfoPanel(currentChat).catch(() => {});
  }
}

async function renderInfoPanel(chat) {
  const content = document.getElementById('info-content');
  if (!content) return;

  if (!chat) {
    content.innerHTML = '<div class="chat-empty">Нет выбранного чата</div>';
    return;
  }

  content.innerHTML = '<div class="chat-empty">Загрузка...</div>';

  if (chat.meeting_id) {
    await renderMeetingInfo(chat, content);
    return;
  }
  if (isModerationChat(chat)) {
    content.innerHTML = `
      <div class="chat-empty" style="text-align:left;">
        <div style="font-weight:700;color:#0f172a;margin-bottom:8px;">Жалобы и апелляции</div>
        <div style="color:#475569;line-height:1.5;">
          Это общий админский чат. Сюда автоматически попадают новые жалобы и запросы на разбан,
          а администраторы могут обсуждать их прямо здесь.
        </div>
      </div>
    `;
    return;
  }
  await renderDirectInfo(chat, content);
}

async function renderMeetingInfo(chat, contentEl) {
  const meetingId = chat.meeting_id;
  if (!meetingId) {
    contentEl.innerHTML = '<div class="chat-empty">Нет данных о встрече</div>';
    return;
  }

  let meeting = null;
  try {
    meeting = await api.getOne(TABLES.meetings, meetingId);
  } catch (_e) {}

  if (!meeting) {
    contentEl.innerHTML = '<div class="chat-empty">Встреча не найдена</div>';
    return;
  }

  let creator = null;
  if (meeting.creator_id) {
    try {
      creator = await api.getOne(TABLES.profiles, meeting.creator_id);
    } catch (_e) {}
  }

  const topic = TOPICS && meeting.topic ? (TOPICS.find(t => t.id === meeting.topic) || null) : null;
  const tagLabel = topic ? `#${getTopicDisplayName(topic)}` : '#Встреча';
  const tagStyle = topic?.color ? `style="background:${escapeHtml(topic.color)}20;color:${escapeHtml(topic.color)}"` : '';

  const location = meeting.location || 'Город не указан';
  const slots = `${meeting.current_slots || 0}/${meeting.max_slots || 0}`;

  // Participants: take them from chat_members of this meeting chat.
  let memberRows = [];
  try {
    const hasStatus = await chatMembersHasStatus();
    memberRows = await api.get(TABLES.chat_members, hasStatus
      ? { chat_id: chat.id, status: 'approved' }
      : { chat_id: chat.id }
    );
  } catch (_e) {
    memberRows = [];
  }
  const userIds = Array.from(new Set([meeting.creator_id, ...(memberRows || []).map(r => r.user_id)].filter(Boolean)));
  let profiles = [];
  try {
    profiles = userIds.length ? await api.get(TABLES.profiles, { id: { in: userIds } }) : [];
  } catch (_e) {
    profiles = [];
  }
  const byId = new Map((profiles || []).map(p => [p.id, p]));

  const ownerId = meeting.creator_id;
  const orderedIds = ownerId ? [ownerId, ...userIds.filter(id => id !== ownerId)] : userIds;
  const canLeave = !!(currentUser && ownerId);
  const canManageParticipants = !!(currentUser && ownerId && currentUser.id === ownerId);

  const participantsHtml = orderedIds.map(id => {
    const p = byId.get(id) || {};
    const name = p.full_name || p.username || 'Пользователь';
    const age = p.age ? `${p.age} лет` : '';
    const avatar = p.photo_URL && p.photo_URL !== 'user' ? p.photo_URL : DEFAULT_AVATAR;
    const isOwner = ownerId && id === ownerId;
    const removeButton = canManageParticipants && !isOwner
      ? `<button type="button" class="member-remove" data-user-id="${escapeHtml(id)}" data-user-name="${escapeHtml(name)}">Удалить</button>`
      : '';
    return `
      <div class="participant-item-row ${isOwner ? 'owner' : ''}">
        <a class="member-link" href="profile.html?id=${escapeHtml(id)}">
          <img class="participant-avatar" src="${escapeHtml(avatar)}" alt="${escapeHtml(name)}" onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}';">
          <div>
            <div class="participant-name">${escapeHtml(name)}</div>
            <div class="participant-age">${escapeHtml(age)}</div>
          </div>
          ${isOwner ? '<div class="participant-badge">Создатель</div>' : ''}
        </a>
        ${removeButton}
      </div>
    `;
  }).join('');

  const creatorName = creator?.full_name || creator?.username || 'Автор';
  const creatorAge = creator?.age ? `${creator.age} лет` : 'Возраст не указан';
  const creatorAvatar = creator?.photo_URL && creator.photo_URL !== 'user' ? creator.photo_URL : DEFAULT_AVATAR;

  contentEl.innerHTML = `
    <div class="meeting-card">
      <div class="meeting-tag" ${tagStyle}>${escapeHtml(tagLabel)}</div>
      <a class="meeting-title" href="meeting.html?id=${escapeHtml(meeting.id)}">${escapeHtml(meeting.title || 'Встреча')}</a>
      <div class="meeting-meta">
        <div>📍 ${escapeHtml(location)}</div>
        <div>👥 ${escapeHtml(slots)} участников</div>
      </div>
    </div>
    <div class="info-profile">
      <img class="info-avatar" src="${escapeHtml(creatorAvatar)}" alt="${escapeHtml(creatorName)}" onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}';">
      <a class="info-name" href="profile.html?id=${escapeHtml(creator?.id || meeting.creator_id)}">${escapeHtml(creatorName)}</a>
      <div class="info-age">${escapeHtml(creatorAge)}</div>
      <div class="info-actions">
        <button type="button" class="info-btn secondary" onclick="window.location.href='meeting.html?id=${escapeHtml(meeting.id)}'">Открыть встречу</button>
        ${canLeave ? `<button type="button" class="info-btn danger" id="info-leave-btn">Выйти из чата</button>` : ''}
      </div>
    </div>
    <div>
      <div style="font-weight:700;color:#0f172a;margin-bottom:8px;">Участники</div>
      <div class="participants-list">
        ${participantsHtml || '<div class=\"chat-empty\">Пока нет участников</div>'}
      </div>
    </div>
  `;

  if (canLeave) {
    const btn = contentEl.querySelector('#info-leave-btn');
    if (btn) {
      btn.onclick = async () => {
        await leaveMeetingChatFromPanel(chat, meeting);
      };
    }
  }

  if (canManageParticipants) {
    contentEl.querySelectorAll('.member-remove').forEach(btn => {
      btn.addEventListener('click', async (event) => {
        event.stopPropagation();
        const memberId = btn.dataset.userId;
        const memberName = btn.dataset.userName || 'Участник';
        if (!memberId) return;
        await removeParticipantFromInfoPanel(chat, meeting, memberId, memberName, contentEl);
      });
    });
  }
}

async function removeParticipantFromInfoPanel(chat, meeting, memberId, memberName, contentEl) {
  if (!currentUser || !chat || !meeting || currentUser.id !== meeting.creator_id) return;
  if (!memberId || memberId === meeting.creator_id) return;
  const confirmLeave = confirm(`Удалить ${memberName} из чата?`);
  if (!confirmLeave) return;

  try {
    const hasStatus = await chatMembersHasStatus();
    let shouldDecrement = true;
    if (hasStatus) {
      const rows = await api.get(TABLES.chat_members, { chat_id: chat.id, user_id: memberId });
      const membership = (rows || [])[0];
      shouldDecrement = (membership && membership.status === 'approved');
    }

    await api.query(TABLES.chat_members, 'deleteWhere', {}, { chat_id: chat.id, user_id: memberId });
    await api.query(TABLES.participants, 'deleteWhere', {}, { meeting_id: meeting.id, user_id: memberId });

    if (shouldDecrement) {
      const currentSlots = meeting.current_slots || 1;
      const nextSlots = Math.max(currentSlots - 1, 0);
      await api.update(TABLES.meetings, meeting.id, { current_slots: nextSlots });
      meeting.current_slots = nextSlots;
    }

    await window.postChatSystemMessage?.(chat.id, `${memberName} покинул чат встречи`, memberId);
    await renderMeetingInfo(chat, contentEl);
    await loadChats(true);
  } catch (error) {
    console.error('Ошибка удаления участника:', error);
    alert('Не удалось удалить участника');
  }
}

async function leaveMeetingChatFromPanel(chat, meeting) {
  if (!currentUser || !chat || !meeting) return;
  const ok = confirm('�������� ��� �������?');
  if (!ok) return;

  try {
    const hasStatus = await chatMembersHasStatus();
    let shouldDecrement = true;
    if (hasStatus) {
      const rows = await api.get(TABLES.chat_members, { chat_id: chat.id, user_id: currentUser.id });
      const m = (rows || [])[0];
      shouldDecrement = (m && m.status === 'approved');
    }

    const currentUserName = currentUser.full_name || currentUser.username || '������������';
    await window.postChatSystemMessage?.(chat.id, `${currentUserName} ������� ��� �������`, currentUser.id);

    await api.query(TABLES.chat_members, 'deleteWhere', {}, { chat_id: chat.id, user_id: currentUser.id });
    try {
      await api.query(TABLES.participants, 'deleteWhere', {}, { meeting_id: meeting.id, user_id: currentUser.id });
    } catch (_e) {}

    if (shouldDecrement) {
      const currentSlots = meeting.current_slots || 1;
      const nextSlots = Math.max(currentSlots - 1, 0);
      try {
        await api.update(TABLES.meetings, meeting.id, { current_slots: nextSlots });
      } catch (_e) {}
    }

    let remainingMembers = [];
    try {
      const hasStatusNow = await chatMembersHasStatus();
      remainingMembers = await api.get(TABLES.chat_members, hasStatusNow
        ? { chat_id: chat.id, status: 'approved' }
        : { chat_id: chat.id }
      );
    } catch (_e) {
      remainingMembers = [];
    }

    if (remainingMembers.length === 0) {
      try {
        await api.query(TABLES.chat_members, 'deleteWhere', {}, { chat_id: chat.id });
        await api.delete(TABLES.chats, chat.id);
        renderedMessageKeysByChat.delete(chat.id);
        if (meeting.id) {
          try {
            await api.delete(TABLES.meetings, meeting.id);
          } catch (_e) {}
        }
      } catch (_e) {}
      if (meeting.id) {
        notifyUser('������� �������');
      }
    }

    currentChat = null;
    renderEmptyChat('�������� ��� �����');
    await loadChats(true);
    toggleInfoPanel(false);
  } catch (e) {
    console.error('������ ������ �� ����:', e);
    alert('�� ������� �������� ���');
  }
}
async function renderDirectInfo(chat, contentEl) {
  let peer = chat.__peerProfile || null;
  let peerId = chat.peer_id || null;
  if (peerId === currentUser.id) peerId = null;

  if (!peerId) {
    try {
      const members = await api.get(TABLES.chat_members, { chat_id: chat.id });
      peerId = (members || []).map(m => m.user_id).find(id => id && id !== currentUser.id) || null;
      if (peerId) chat.peer_id = peerId;
    } catch (_e) {}
  }

  if (!peer && peerId) {
    try {
      peer = await api.getOne(TABLES.profiles, peerId);
    } catch (_e) {
      peer = null;
    }
  }

  if (!peer) {
    contentEl.innerHTML = '<div class="chat-empty">Не удалось загрузить профиль собеседника</div>';
    return;
  }

  const name = peer.full_name || peer.username || 'Пользователь';
  const age = peer.age ? `${peer.age} лет` : '';
  const city = peer.location || peer.city || '';
  const about = peer.about || peer.bio || peer.description || '';
  const avatar = peer.photo_URL && peer.photo_URL !== 'user' ? peer.photo_URL : DEFAULT_AVATAR;

  const interests = Array.isArray(peer.interests) ? peer.interests : [];
  const pills = interests.map(id => {
    const topic = TOPICS ? TOPICS.find(t => t.id === id) : null;
    const label = topic ? getTopicDisplayName(topic) : String(id);
    return `<div class="info-pill">${escapeHtml(label)}</div>`;
  }).join('');

  contentEl.innerHTML = `
    <div class="info-profile">
      <img class="info-avatar" src="${escapeHtml(avatar)}" alt="${escapeHtml(name)}" onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}';">
      <a class="info-name" href="profile.html?id=${escapeHtml(peer.id)}">${escapeHtml(name)}</a>
      <div class="info-age">${escapeHtml([age, city].filter(Boolean).join(' • '))}</div>
      ${about ? `<div class="info-about">${escapeHtml(about)}</div>` : ''}
      ${pills ? `<div class="info-interests">${pills}</div>` : ''}
      <div class="info-actions">
        <button type="button" class="info-btn secondary" onclick="window.location.href='profile.html?id=${escapeHtml(peer.id)}'">Открыть профиль</button>
      </div>
      <div class="direct-clear-actions">
        <button type="button" class="info-btn secondary" id="clear-chat-local">Очистить только у себя</button>
        <button type="button" class="info-btn danger" id="clear-chat-all">Очистить у всех</button>
      </div>
    </div>
  `;

  const localBtn = contentEl.querySelector('#clear-chat-local');
  if (localBtn) {
    localBtn.onclick = () => clearDirectChat(false);
  }
  const globalBtn = contentEl.querySelector('#clear-chat-all');
  if (globalBtn) {
    globalBtn.onclick = () => clearDirectChat(true);
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
