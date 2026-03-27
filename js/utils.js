async function fetchTopics() {
  const { TABLES } = window.APP || {};
  try {
    return await api.get(TABLES.topics, { $order: { column: 'name', ascending: true } });
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
      // Keep the meeting chat intact even after the meeting is deleted.
      // This prevents turning a meeting chat into a broken direct chat.
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

async function createUserNotification(recipientId, payload = {}) {
  const { TABLES } = window.APP || {};
  if (!recipientId || !TABLES?.notifications) return null;

  const notification = {
    admin_profile_id: recipientId,
    notification_type: payload.notification_type || 'event_update',
    related_table: payload.related_table || 'meetings',
    related_id: payload.related_id,
    title: payload.title || 'Обновление по встрече',
    message: payload.message || ''
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
  const payload = { chat_id: chatId, content: `system:${message}` };
  if (actorId) payload.user_id = actorId;
  try {
    const rows = await api.insert(TABLES.chat_messages, payload);
    return Array.isArray(rows) ? rows[0] || null : null;
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
