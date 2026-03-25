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
      const countResult = await api.query(TABLES.chat_messages, 'count', {}, { chat_id: chat.id });
      const messageCount = Number(countResult && countResult.count) || 0;

      if (messageCount === 0) {
        await api.query(TABLES.chat_members, 'deleteWhere', {}, { chat_id: chat.id });
        await api.delete(TABLES.chats, chat.id);
      } else {
        // Detach chat from meeting if it has messages.
        await api.update(TABLES.chats, chat.id, { meeting_id: null });
      }
    }

    await api.query(TABLES.participants, 'deleteWhere', {}, { meeting_id: meetingId });
    await api.delete(TABLES.meetings, meetingId);
  } catch (error) {
    console.error('Error deleting expired meeting:', meetingId, error);
  }
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

window.fetchTopics = fetchTopics;
window.getCurrentUser = getCurrentUser;
window.cleanupExpiredMeetings = cleanupExpiredMeetings;
window.deleteExpiredMeeting = deleteExpiredMeeting;
window.createUserNotification = createUserNotification;

