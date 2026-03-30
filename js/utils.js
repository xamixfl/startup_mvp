async function fetchTopics() {
  const { TABLES } = window.APP || {};
  try {
    const rows = await api.get(TABLES.topics, { $order: { column: 'sort_order', ascending: true } });
    return sortTopicsForDisplay(rows || []);
  } catch (error) {
    console.error('Error fetching topics:', error);
    return [];
  }
}

async function getCurrentUser() {
  try {
    return await api.request('/api/auth/me');
  } catch (error) {
    return null;
  }
}

async function cleanupExpiredMeetings() {
  const { TABLES } = window.APP || {};
  try {
    const expiredMeetings = await api.get(TABLES.meetings, { expires_at: { lt: new Date().toISOString() } });
    if (!expiredMeetings || expiredMeetings.length === 0) return;
    for (const meeting of expiredMeetings) {
      if (meeting && meeting.id) {
        await deleteExpiredMeeting(meeting.id);
      }
    }
  } catch (error) {
    console.error('Error cleaning expired meetings:', error);
  }
}

async function deleteExpiredMeeting(meetingId) {
  const { TABLES } = window.APP || {};
  if (!meetingId) return;

  try {
    const chats = await api.get(TABLES.chats, { meeting_id: meetingId });
    const chat = (chats || [])[0];

    if (chat && chat.id) {
      try {
        await api.query(TABLES.chat_members, 'deleteWhere', {}, { chat_id: chat.id });
      } catch (_e) {}
      try {
        await api.query(TABLES.chat_messages, 'deleteWhere', {}, { chat_id: chat.id });
      } catch (_e) {}
      try {
        await api.delete(TABLES.chats, chat.id);
      } catch (_e) {}
    }

    await api.query(TABLES.participants, 'deleteWhere', {}, { meeting_id: meetingId });
    await api.delete(TABLES.meetings, meetingId);
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
  return `\u23f1 ${raw}`;
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

window.fetchTopics = fetchTopics;
window.getCurrentUser = getCurrentUser;
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
