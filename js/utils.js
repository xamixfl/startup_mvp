/**
 * Fetch all topics from the database
 */
async function fetchTopics() {
  const supabaseClient = window.APP?.supabase;
  const { TABLES } = window.APP || {};

  if (!supabaseClient || !TABLES) {
    console.error('Supabase client or TABLES not available');
    return [];
  }

  try {
    const { data, error } = await supabaseClient
      .from(TABLES.topics)
      .select('*')
      .order('name', { ascending: true });

    if (error) throw error;
    return data || [];
  } catch (error) {
    console.error('Error fetching topics:', error);
    return [];
  }
}

/**
 * Clean up expired meetings along with their chats and messages
 */
async function cleanupExpiredMeetings() {
  const supabaseClient = window.APP?.supabase;
  const { TABLES } = window.APP || {};

  if (!supabaseClient || !TABLES) {
    console.error('Supabase client or TABLES not available');
    return;
  }

  try {
    // Find all expired meetings
    const { data: expiredMeetings, error: fetchError } = await supabaseClient
      .from(TABLES.meetings)
      .select('id')
      .lt('expires_at', new Date().toISOString());

    if (fetchError) {
      console.error('Ошибка получения устаревших встреч:', fetchError);
      return;
    }

    if (!expiredMeetings || expiredMeetings.length === 0) {
      console.log('Нет устаревших встреч для удаления');
      return;
    }

    console.log(`Найдено ${expiredMeetings.length} устаревших встреч для удаления`);

    // Delete each expired meeting with its associated data
    for (const meeting of expiredMeetings) {
      await deleteExpiredMeeting(meeting.id);
    }

    console.log('Очистка устаревших встреч завершена');
  } catch (error) {
    console.error('Ошибка очистки устаревших встреч:', error);
  }
}

/**
 * Delete a single expired meeting with all associated data
 */
async function deleteExpiredMeeting(meetingId) {
  const supabaseClient = window.APP?.supabase;
  const { TABLES } = window.APP || {};

  if (!supabaseClient || !TABLES) {
    console.error('Supabase client or TABLES not available');
    return;
  }

  try {
    // Get the chat associated with this meeting
    const { data: chatsData } = await supabaseClient
      .from(TABLES.chats)
      .select('id')
      .eq('meeting_id', meetingId)
      .maybeSingle();

    if (chatsData?.id) {
      // Delete chat messages
      const { error: messagesError } = await supabaseClient
        .from(TABLES.chat_messages)
        .delete()
        .eq('chat_id', chatsData.id);

      if (messagesError) {
        console.error(`Ошибка удаления сообщений чата ${chatsData.id}:`, messagesError);
      }

      // Delete chat members
      const { error: membersError } = await supabaseClient
        .from(TABLES.chat_members)
        .delete()
        .eq('chat_id', chatsData.id);

      if (membersError) {
        console.error(`Ошибка удаления участников чата ${chatsData.id}:`, membersError);
      }

      // Delete the chat
      const { error: chatError } = await supabaseClient
        .from(TABLES.chats)
        .delete()
        .eq('id', chatsData.id);

      if (chatError) {
        console.error(`Ошибка удаления чата ${chatsData.id}:`, chatError);
      }
    }

    // Delete participants
    const { error: participantsError, data: participantsData } = await supabaseClient
      .from(TABLES.participants)
      .delete()
      .eq('meeting_id', meetingId)
      .select();

    if (participantsError) {
      console.error(`Ошибка удаления участников встречи ${meetingId}:`, participantsError);
    }

    // Delete the meeting
    const { error: deleteMeetingError, data: deletedMeeting } = await supabaseClient
      .from(TABLES.meetings)
      .delete()
      .eq('id', meetingId)
      .select();

    if (deleteMeetingError) {
      console.error(`Ошибка удаления встречи ${meetingId}:`, deleteMeetingError);
      throw deleteMeetingError;
    }

    if (!deletedMeeting || deletedMeeting.length === 0) {
      console.warn(`Встреча ${meetingId} не была удалена (возможно, проблема с правами доступа RLS)`);
    } else {
      console.log(`Устаревшая встреча ${meetingId} успешно удалена`);
    }
  } catch (error) {
    console.error(`Ошибка удаления устаревшей встречи ${meetingId}:`, error);
  }
}

// Make functions globally available
window.fetchTopics = fetchTopics;
window.cleanupExpiredMeetings = cleanupExpiredMeetings;
window.deleteExpiredMeeting = deleteExpiredMeeting;
