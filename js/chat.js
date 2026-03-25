const { TABLES } = window.APP || {};

let currentUser = null;
let chats = [];
let currentChat = null;
let TOPICS = null;

const DEFAULT_AVATAR = 'assets/avatar.png';
const UNREAD_KEY = 'pulse_chat_last_read';

let messagePollTimer = null;
let chatListPollTimer = null;
let typingPollTimer = null;
let typingTimeoutId = null;

let currentChatMessageSignature = 'empty';
let pendingImageFile = null;
const MAX_IMAGE_MB = 5;

document.addEventListener('DOMContentLoaded', async () => {
  currentUser = typeof window.getCurrentUser === 'function'
    ? await window.getCurrentUser()
    : await api.request('/api/auth/me');

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
  await loadChats();
  setupSendMessage();
  setupImageUpload();
  setupTypingIndicator();
  setupImageModal();
  setupTitleToggle();
  setupReportButton();

  startChatListPolling();
});

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
    const meta = await loadMessages(chatId, { silent: true });
    if (meta?.signature) currentChatMessageSignature = meta.signature;
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
  }, 1000);
}

function stopTypingPolling() {
  if (typingPollTimer) clearInterval(typingPollTimer);
  typingPollTimer = null;
}

async function loadChats(isRefresh = false) {
  const list = document.getElementById('chat-list');
  if (!list) return;
  if (!isRefresh) list.innerHTML = '<div class="chat-item">Загрузка...</div>';

  try {
    const hasStatus = await chatMembersHasStatus();
    let memberships = [];
    try {
      memberships = await api.get(TABLES.chat_members, hasStatus
        ? { user_id: currentUser.id, status: 'approved' }
        : { user_id: currentUser.id }
      );
    } catch (_e) {
      memberships = [];
    }
    const memberChatIds = (memberships || []).map(m => m.chat_id).filter(Boolean);

    // Ensure owner chats are present
    const ownedChats = await getOwnedChatsForUser(currentUser.id);
    const ownedIds = (ownedChats || []).map(c => c.id).filter(Boolean);
    const missingOwner = ownedIds.filter(id => !memberChatIds.includes(id));
    for (const chatId of missingOwner) {
      try {
        await safeInsertChatMember(hasStatus
          ? { chat_id: chatId, user_id: currentUser.id, role: 'owner', status: 'approved' }
          : { chat_id: chatId, user_id: currentUser.id }
        );
        memberChatIds.push(chatId);
      } catch (_e) {
        // ignore
      }
    }

    const mergedIds = Array.from(new Set([...memberChatIds, ...ownedIds]));
    if (mergedIds.length === 0) {
      chats = [];
      list.innerHTML = '<div class="chat-item">Нет чатов</div>';
      renderEmptyChat();
      return;
    }

    const chatsRows = await api.get(TABLES.chats, {
      id: { in: mergedIds },
      $order: { column: 'created_at', ascending: false }
    });

    chats = Array.isArray(chatsRows) ? chatsRows : [];
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

function renderChatList(list) {
  list.innerHTML = '';

  chats.forEach(chat => {
    const item = document.createElement('div');
    item.className = 'chat-item';
    if (chat.is_admin_chat) item.classList.add('chat-item-admin');
    item.dataset.chatId = chat.id;

    const title = chat.title || 'Чат';
    item.innerHTML = `
      <div class="chat-item-row">
        <div class="chat-item-title">${escapeHtml(title)}</div>
        <div class="chat-unread" style="display:none;"></div>
      </div>
      <div class="chat-item-sub">${chat.meeting_id ? 'Чат встречи' : 'Личный чат'}</div>
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

  for (const chat of chats) {
    const el = document.querySelector(`.chat-item[data-chat-id="${chat.id}"] .chat-unread`);
    if (!el) continue;
    const readKey = `${currentUser.id}:${chat.id}`;
    const lastRead = readMap[readKey];

    const filters = {
      chat_id: chat.id,
      user_id: { neq: currentUser.id }
    };
    if (lastRead) filters.created_at = { gt: lastRead };

    try {
      const result = await api.query(TABLES.chat_messages, 'count', {}, filters);
      const count = Number(result && result.count) || 0;
      if (count > 0) {
        el.textContent = count > 99 ? '99+' : String(count);
        el.style.display = 'inline-flex';
      } else {
        el.style.display = 'none';
      }
    } catch (_e) {
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
  if (title) title.textContent = chat.title || 'Чат';

  // Enable input controls now that a chat is selected
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const attachBtn = document.getElementById('chat-attach');
  if (input) input.disabled = false;
  if (sendBtn) sendBtn.disabled = false;
  if (attachBtn) attachBtn.disabled = false;

  const reportBtn = document.getElementById('chat-report-btn');
  if (reportBtn) reportBtn.style.display = 'inline-flex';

  renderEmptyChat('Загрузка сообщений...');
  const meta = await loadMessages(chatId);
  currentChatMessageSignature = meta?.signature || currentChatMessageSignature;

  markChatRead(chatId, meta?.lastCreatedAt);
  updateChatListUnreadBadges().catch(() => {});

  startMessagePolling(chatId);
  startTypingPolling(chatId);
}

function renderEmptyChat(text = 'Выберите чат слева') {
  const body = document.getElementById('chat-body');
  if (!body) return;
  body.innerHTML = `<div class="chat-empty">${escapeHtml(text)}</div>`;
}

function computeMessageSignature(messages) {
  if (!messages || messages.length === 0) return 'empty';
  const last = messages[messages.length - 1];
  return `${messages.length}:${last.id || ''}:${last.created_at || ''}`;
}

async function loadMessages(chatId, opts = {}) {
  const body = document.getElementById('chat-body');
  if (!body) return null;

  try {
    const messages = await api.get(TABLES.chat_messages, {
      chat_id: chatId,
      $order: { column: 'created_at', ascending: true },
      $limit: 200
    });

    const signature = computeMessageSignature(messages);
    if (opts.silent && signature === currentChatMessageSignature) {
      return { signature, lastCreatedAt: null };
    }

    currentChatMessageSignature = signature;
    body.innerHTML = '';

    const userIds = Array.from(new Set((messages || []).map(m => m.user_id).filter(Boolean)));
    const profiles = userIds.length ? await api.get(TABLES.profiles, { id: { in: userIds } }) : [];
    const byId = new Map((profiles || []).map(p => [p.id, p]));

    (messages || []).forEach(msg => {
      const mine = msg.user_id === currentUser.id;
      const p = byId.get(msg.user_id);
      body.appendChild(renderMessage(msg, p, mine));
    });

    body.scrollTop = body.scrollHeight;

    const lastCreatedAt = (messages && messages.length) ? messages[messages.length - 1].created_at : null;
    return { signature, lastCreatedAt };
  } catch (error) {
    if (!opts.silent) {
      console.error('Ошибка загрузки сообщений:', error);
      renderEmptyChat('Ошибка загрузки сообщений');
    }
    return null;
  }
}

function renderMessage(msg, profile, mine) {
  const wrap = document.createElement('div');
  wrap.className = 'message' + (mine ? ' mine' : '');

  const senderName = mine ? 'Вы' : (profile?.full_name || profile?.username || 'Пользователь');

  const content = String(msg.content || '');
  const isImage = content.startsWith('image:');
  const payload = isImage ? content.slice('image:'.length) : content;

  const avatarUrl = profile?.photo_URL && profile.photo_URL !== 'user' ? profile.photo_URL : DEFAULT_AVATAR;

  const when = msg.created_at ? new Date(msg.created_at).toLocaleString() : '';

  wrap.innerHTML = `
    <div class="message-meta">
      <div class="message-avatar"><img src="${avatarUrl}" alt="${escapeHtml(senderName)}" onerror="this.onerror=null;this.src='${DEFAULT_AVATAR}';"></div>
      <div class="message-sender">${escapeHtml(senderName)}</div>
      <div class="message-time">${escapeHtml(when)}</div>
    </div>
    <div class="message-content"></div>
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
      contentEl.textContent = payload;
    }
  }

  return wrap;
}

function markChatRead(chatId, createdAt) {
  if (!currentUser) return;
  let readMap = {};
  try {
    const raw = localStorage.getItem(UNREAD_KEY);
    readMap = raw ? JSON.parse(raw) : {};
  } catch (_e) {}
  const key = `${currentUser.id}:${chatId}`;
  readMap[key] = createdAt || new Date().toISOString();
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
      await api.insert(TABLES.chat_messages, { chat_id: currentChat.id, user_id: currentUser.id, content: text });
      input.value = '';
      const meta = await loadMessages(currentChat.id);
      markChatRead(currentChat.id, meta?.lastCreatedAt);
      updateChatListUnreadBadges().catch(() => {});
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

    await api.insert(TABLES.chat_messages, { chat_id: currentChat.id, user_id: currentUser.id, content: `image:${imageUrl}` });

    const meta = await loadMessages(currentChat.id);
    markChatRead(currentChat.id, meta?.lastCreatedAt);
    updateChatListUnreadBadges().catch(() => {});
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
    // For meeting chats: open meeting; for direct chats: open peer profile
    if (currentChat.meeting_id) {
      window.location.href = `meeting.html?id=${currentChat.meeting_id}`;
      return;
    }
    if (currentChat.peer_id) {
      window.location.href = `profile.html?id=${currentChat.peer_id}`;
    }
  };
}

function setupReportButton() {
  const btn = document.getElementById('chat-report-btn');
  if (!btn) return;
  btn.onclick = () => {
    if (!currentChat) return;
    if (typeof window.openReportModal !== 'function') {
      alert('Модуль жалоб не загружен');
      return;
    }
    window.openReportModal('chat', currentChat.id, { title: currentChat.title || 'Чат' });
  };
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
