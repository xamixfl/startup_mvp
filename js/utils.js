let topicsCache = null;
let topicsPromise = null;
let currentUserCache = undefined;
let currentUserPromise = null;
const profileCache = new Map();

async function fetchTopics(options = {}) {
  const { TABLES } = window.APP || {};
  if (!options.force && Array.isArray(topicsCache)) return topicsCache;
  if (!options.force && topicsPromise) return topicsPromise;

  topicsPromise = (async () => {
    try {
      const rows = await api.get(TABLES.topics, { $order: { column: 'sort_order', ascending: true } });
      topicsCache = sortTopicsForDisplay(rows || []);
      return topicsCache;
    } catch (error) {
      console.error('Error fetching topics:', error);
      return [];
    } finally {
      topicsPromise = null;
    }
  })();

  return topicsPromise;
}

function normalizeProfileRecord(profile) {
  if (!profile || typeof profile !== 'object') return profile;
  const normalized = { ...profile };
  if (normalized.photo_url && !normalized.photo_URL) normalized.photo_URL = normalized.photo_url;
  if (normalized.city && !normalized.location) normalized.location = normalized.city;
  if (!normalized.about) normalized.about = normalized.bio || normalized.description || '';
  return normalized;
}

function primeProfileCache(profile) {
  const normalized = normalizeProfileRecord(profile);
  if (!normalized?.id) return normalized;
  profileCache.set(String(normalized.id), normalized);
  return normalized;
}

async function getCurrentUser(options = {}) {
  if (!options.force && currentUserCache !== undefined) return currentUserCache;
  if (!options.force && currentUserPromise) return currentUserPromise;

  currentUserPromise = (async () => {
    try {
      currentUserCache = await api.request('/api/auth/me');
      if (currentUserCache?.id) primeProfileCache(currentUserCache);
      return currentUserCache;
    } catch (_error) {
      currentUserCache = null;
      return null;
    } finally {
      currentUserPromise = null;
    }
  })();

  return currentUserPromise;
}

async function getProfileCached(userId, options = {}) {
  const key = String(userId || '').trim();
  if (!key) return null;
  if (!options.force && profileCache.has(key)) return profileCache.get(key);

  try {
    const profile = await api.request(`/api/profiles/${encodeURIComponent(key)}`);
    return primeProfileCache(profile);
  } catch (error) {
    console.error('Error loading profile:', key, error);
    return null;
  }
}

function clearAppCaches() {
  topicsCache = null;
  topicsPromise = null;
  currentUserCache = undefined;
  currentUserPromise = null;
  profileCache.clear();
}

async function cleanupExpiredMeetings() {
  try {
    await api.request('/api/maintenance/cleanup-expired-meetings', {
      method: 'POST',
      body: JSON.stringify({})
    });
  } catch (error) {
    console.error('Error cleaning expired meetings:', error);
  }
}

async function deleteExpiredMeeting(meetingId) {
  if (!meetingId) return;

  try {
    await api.request(`/api/meetings/${encodeURIComponent(meetingId)}/cascade`, {
      method: 'DELETE'
    });
  } catch (error) {
    console.error('Error deleting expired meeting:', meetingId, error);
  }
}

function formatMeetingCountdown(isoString) {
  if (!isoString) return 'Срок не указан';
  const target = new Date(isoString);
  if (Number.isNaN(target.getTime())) return 'Срок не указан';
  const diffMs = target.getTime() - Date.now();
  if (diffMs <= 0) return 'Событие завершено';

  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  const hours = Math.floor((diffMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000));
  const parts = [];
  if (days) parts.push(`${days} д`);
  if (hours) parts.push(`${hours} ч`);
  if (!days && !hours) parts.push(`${minutes} мин`);
  return parts.join(' ');
}

function buildMeetingCountdownLabel(expiresAt) {
  const raw = formatMeetingCountdown(expiresAt);
  if (!raw) return '';
  return `⏱ ${raw}`;
}

function stripTopicEmoji(value) {
  return String(value || '')
    .replace(/^([\p{Extended_Pictographic}\uFE0F\u200D]+)\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTopicLocalizedField(topic, baseKey) {
  if (!topic || typeof topic !== 'object') return '';
  const htmlLang = String(document?.documentElement?.lang || '').toLowerCase();
  const preferredKeys = htmlLang.startsWith('en')
    ? [`${baseKey}_en`, `${baseKey}_ru`, baseKey]
    : [`${baseKey}_ru`, `${baseKey}_en`, baseKey];

  for (const key of preferredKeys) {
    const value = String(topic[key] || '').trim();
    if (value) return value;
  }
  return '';
}

function getTopicIcon(topic) {
  if (!topic || typeof topic !== 'object') return '';
  return String(topic.icon || '').trim();
}

function getTopicDisplayName(topicOrId, fallbackName = '') {
  const topicId = typeof topicOrId === 'object' && topicOrId ? String(topicOrId.id || '') : String(topicOrId || '');
  const rawName = typeof topicOrId === 'object' && topicOrId
    ? getTopicLocalizedField(topicOrId, 'name') || fallbackName || topicId
    : fallbackName || topicId;
  return stripTopicEmoji(rawName) || topicId;
}

function getTopicSortOrder(topic) {
  const value = Number(topic?.sort_order);
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function compareTopics(a, b) {
  const orderDiff = getTopicSortOrder(a) - getTopicSortOrder(b);
  if (orderDiff !== 0) return orderDiff;
  return getTopicDisplayName(a).localeCompare(getTopicDisplayName(b), 'ru', { sensitivity: 'base' });
}

function sortTopicsForDisplay(topics) {
  return [...(topics || [])].sort(compareTopics);
}

function isTopicGroup(topic) {
  return Boolean(topic?.is_group === true);
}

function getSelectableTopics(topics) {
  return sortTopicsForDisplay((topics || []).filter(topic => !isTopicGroup(topic)));
}

function groupTopicsForDisplay(topics) {
  const allTopics = sortTopicsForDisplay(topics || []);
  const groups = allTopics.filter(isTopicGroup);
  const children = allTopics.filter(topic => !isTopicGroup(topic));

  if (groups.length === 0) {
    return children.length > 0 ? [{ id: 'all_topics', title: 'Интересы', items: children }] : [];
  }

  const byParent = new Map();
  children.forEach(topic => {
    const parentId = topic.parent_topic_id || '';
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(topic);
  });

  const result = groups.map(group => ({
    id: group.id,
    title: getTopicDisplayName(group),
    icon: String(group.icon || '').trim(),
    items: sortTopicsForDisplay(byParent.get(group.id) || [])
  })).filter(group => group.items.length > 0);

  const orphanTopics = sortTopicsForDisplay(
    children.filter(topic => !topic.parent_topic_id || !groups.some(group => group.id === topic.parent_topic_id))
  );
  if (orphanTopics.length > 0) {
    result.push({
      id: 'ungrouped_topics',
      title: 'Другие интересы',
      icon: '',
      items: orphanTopics
    });
  }

  return result;
}

async function createUserNotification(recipientId, payload = {}) {
  const { TABLES } = window.APP || {};
  if (!recipientId || !TABLES?.notifications) return null;

  const notification = {
    admin_profile_id: recipientId,
    notification_type: payload.notification_type || 'event_update',
    related_table: payload.related_table || 'meetings',
    related_id: payload.related_id,
    title: payload.title || 'Обновление по встрече',
    message: payload.message || '',
    is_read: false,
    read_at: null
  };

  if (!notification.related_id) return null;

  try {
    const rows = await api.insert(TABLES.notifications, notification);
    return Array.isArray(rows) ? rows[0] || null : null;
  } catch (error) {
    console.error('Error creating user notification:', error);
    return null;
  }
}

async function postChatSystemMessage(chatId, message, actorId) {
  const { TABLES } = window.APP || {};
  if (!chatId || !message || !TABLES?.chat_messages) return null;
  try {
    return await api.request(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: `system:${message}`, actor_id: actorId || null })
    });
  } catch (error) {
    console.warn('postChatSystemMessage failed:', error);
    return null;
  }
}

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Не удалось прочитать изображение'));
    };
    image.src = objectUrl;
  });
}

async function compressImageFile(file, options = {}) {
  if (!(file instanceof File) || !String(file.type || '').startsWith('image/')) return file;

  const maxWidth = Number(options.maxWidth || 1600);
  const maxHeight = Number(options.maxHeight || 1600);
  const quality = Number(options.quality || 0.82);
  const maxBytes = Number(options.maxBytes || 1.2 * 1024 * 1024);

  if (file.size <= maxBytes && !options.force) return file;

  try {
    const image = await loadImageFromBlob(file);
    const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
    const targetWidth = Math.max(1, Math.round(image.width * scale));
    const targetHeight = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;

    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
    const outputType = file.type === 'image/png' ? 'image/webp' : (file.type || 'image/jpeg');
    const blob = await new Promise(resolve => canvas.toBlob(resolve, outputType, quality));
    if (!blob || blob.size <= 0 || blob.size >= file.size) return file;

    const extension = outputType === 'image/webp' ? 'webp' : outputType === 'image/png' ? 'png' : 'jpg';
    return new File([blob], file.name.replace(/\.[^.]+$/, `.${extension}`), {
      type: outputType,
      lastModified: Date.now()
    });
  } catch (error) {
    console.warn('compressImageFile failed:', error);
    return file;
  }
}

window.fetchTopics = fetchTopics;
window.getCurrentUser = getCurrentUser;
window.getProfileCached = getProfileCached;
window.primeProfileCache = primeProfileCache;
window.clearAppCaches = clearAppCaches;
window.cleanupExpiredMeetings = cleanupExpiredMeetings;
window.deleteExpiredMeeting = deleteExpiredMeeting;
window.createUserNotification = createUserNotification;
window.postChatSystemMessage = postChatSystemMessage;
window.formatMeetingCountdown = formatMeetingCountdown;
window.buildMeetingCountdownLabel = buildMeetingCountdownLabel;
window.getTopicIcon = getTopicIcon;
window.getTopicDisplayName = getTopicDisplayName;
window.groupTopicsForDisplay = groupTopicsForDisplay;
window.getSelectableTopics = getSelectableTopics;
window.compressImageFile = compressImageFile;
