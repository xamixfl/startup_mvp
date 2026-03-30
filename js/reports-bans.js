/**
 * Reports and Bans Management Module (API-backed)
 * Replaces old Supabase direct DB calls with `js/api.js` proxy requests.
 */

const REPORTS_ADMIN_MODERATION_CHAT_TITLE = 'Жалобы и апелляции';
const REPORTS_LEGACY_ADMIN_CHAT_TITLES = [REPORTS_ADMIN_MODERATION_CHAT_TITLE, 'Reports'];

const ModerationChatService = {
  async chatMembersHasStatus() {
    try {
      await api.get('chat_members', { $limit: 1, status: 'approved' });
      return true;
    } catch (_e) {
      return false;
    }
  },

  async safeInsertChatMember(data) {
    try {
      return await api.insert('chat_members', data);
    } catch (_e) {
      return await api.insert('chat_members', { chat_id: data.chat_id, user_id: data.user_id });
    }
  },

  async getAdmins() {
    try {
      return await api.get('profiles', { role: 'admin' });
    } catch (_e) {
      return [];
    }
  },

  async ensureModerationChat() {
    const admins = await this.getAdmins();
    if (!admins.length) return null;

    let rows = [];
    try {
      rows = await api.get('chats', {
        title: { in: REPORTS_LEGACY_ADMIN_CHAT_TITLES },
        $order: { column: 'created_at', ascending: false }
      });
    } catch (_e) {
      rows = [];
    }

    let chat = (rows || []).find(row =>
      row && !row.meeting_id && admins.some(admin => admin.id === row.owner_id)
    ) || null;

    if (!chat) {
      const created = await api.insert('chats', {
        title: REPORTS_ADMIN_MODERATION_CHAT_TITLE,
        owner_id: admins[0].id
      });
      chat = Array.isArray(created) ? created[0] : created;
    }
    if (!chat) return null;

    const hasStatus = await this.chatMembersHasStatus();
    let members = [];
    try {
      members = await api.get('chat_members', { chat_id: chat.id });
    } catch (_e) {
      members = [];
    }
    const existingIds = new Set((members || []).map(row => row.user_id).filter(Boolean));

    for (const admin of admins) {
      if (!admin?.id || existingIds.has(admin.id)) continue;
      try {
        await this.safeInsertChatMember(hasStatus
          ? {
              chat_id: chat.id,
              user_id: admin.id,
              role: admin.id === chat.owner_id ? 'owner' : 'member',
              status: 'approved'
            }
          : { chat_id: chat.id, user_id: admin.id }
        );
        existingIds.add(admin.id);
      } catch (_e) {
        // ignore duplicate/legacy failures
      }
    }

    return chat;
  },

  async postSystemMessage(text) {
    if (!text) return null;
    const chat = await this.ensureModerationChat();
    if (!chat?.id || !chat.owner_id) return null;
    try {
      const rows = await api.insert('chat_messages', {
        chat_id: chat.id,
        user_id: chat.owner_id,
        content: `system:${text}`
      });
      return Array.isArray(rows) ? rows[0] : rows;
    } catch (_e) {
      return null;
    }
  },

  async postReportMessage(report) {
    if (!report) return null;
    let reporter = null;
    try {
      reporter = report.reported_by_user_id ? await api.getOne('profiles', report.reported_by_user_id) : null;
    } catch (_e) {
      reporter = null;
    }
    const reporterName = reporter?.full_name || reporter?.username || 'Пользователь';
    const typeLabel = { user: 'пользователя', event: 'встречу', chat: 'чат' }[report.report_type] || 'объект';
    const lines = [
      `Новая жалоба на ${typeLabel}`,
      `Отправитель: ${reporterName}`,
      `Причина: ${report.reason || 'не указана'}`,
      report.description ? `Описание: ${report.description}` : '',
      report.reported_item_id ? `ID объекта: ${report.reported_item_id}` : '',
      report.id ? `ID жалобы: ${report.id}` : ''
    ].filter(Boolean);
    return this.postSystemMessage(lines.join('\n'));
  },

  async postAppealMessage(appeal) {
    if (!appeal) return null;
    let profile = null;
    try {
      profile = appeal.appealed_by_user_id ? await api.getOne('profiles', appeal.appealed_by_user_id) : null;
    } catch (_e) {
      profile = null;
    }
    const userName = profile?.full_name || profile?.username || 'Пользователь';
    const lines = [
      'Новый запрос на разбан',
      `Отправитель: ${userName}`,
      `Причина апелляции: ${appeal.appeal_reason || 'не указана'}`,
      appeal.ban_id ? `ID бана: ${appeal.ban_id}` : '',
      appeal.id ? `ID апелляции: ${appeal.id}` : ''
    ].filter(Boolean);
    return this.postSystemMessage(lines.join('\n'));
  }
};

const ReportService = {
  async submitReport(reportType, reportedItemId, reportedByUserId, reason, description = '') {
    try {
      const rows = await api.insert('reports', {
        report_type: reportType,
        reported_item_id: reportedItemId,
        reported_by_user_id: reportedByUserId,
        reason,
        description,
        status: 'pending'
      });

      const data = Array.isArray(rows) ? rows : [];

      // Non-blocking admin notification
      if (data.length > 0) {
        const reportId = data[0].id;
        const typeLabel = { user: 'пользователя', event: 'встречу', chat: 'чат' }[reportType] || 'элемент';
        NotificationService.notifyAdmins(
          'new_report',
          'reports',
          reportId,
          `Новая жалоба на ${typeLabel}`,
          `Причина: ${reason}. ${description ? 'Описание: ' + description : ''}`
        ).catch(() => {});
        ModerationChatService.postReportMessage(data[0]).catch(() => {});
      }

      return { success: true, data };
    } catch (error) {
      console.error('Error submitting report:', error);
      return { success: false, error: error.message || String(error) };
    }
  },

  async getAllReports(filters = {}) {
    try {
      const q = {
        $order: { column: 'created_at', ascending: false }
      };
      if (filters.status) q.status = filters.status;
      if (filters.reportType) q.report_type = filters.reportType;
      const data = await api.get('reports', q);
      return { success: true, data: data || [] };
    } catch (error) {
      console.error('Error fetching reports:', error);
      return { success: false, error: error.message || String(error) };
    }
  },

  async getPendingReportsCount() {
    try {
      const result = await api.query('reports', 'count', {}, { status: 'pending' });
      return { success: true, count: Number(result && result.count) || 0 };
    } catch (error) {
      console.error('Error fetching pending reports count:', error);
      return { success: false, error: error.message || String(error) };
    }
  },

  async updateReportStatus(reportId, newStatus, adminNotes = '') {
    try {
      const rows = await api.update('reports', reportId, {
        status: newStatus,
        admin_notes: adminNotes,
        updated_at: new Date().toISOString()
      });
      return { success: true, data: rows || [] };
    } catch (error) {
      console.error('Error updating report:', error);
      return { success: false, error: error.message || String(error) };
    }
  },

  async getReportsForItem(itemId, itemType) {
    try {
      const data = await api.get('reports', {
        reported_item_id: itemId,
        report_type: itemType,
        $order: { column: 'created_at', ascending: false }
      });
      return { success: true, data: data || [] };
    } catch (error) {
      console.error('Error fetching reports for item:', error);
      return { success: false, error: error.message || String(error) };
    }
  }
};

const BanService = {
  async createBan(banType, bannedItemId, bannedByUserId, reason, isPermanent = true, banUntil = null) {
    try {
      const rows = await api.insert('bans', {
        ban_type: banType,
        banned_item_id: bannedItemId,
        banned_by_user_id: bannedByUserId,
        reason,
        is_permanent: !!isPermanent,
        ban_until: banUntil,
        is_active: true
      });
      return { success: true, data: rows || [] };
    } catch (error) {
      console.error('Error creating ban:', error);
      return { success: false, error: error.message || String(error) };
    }
  },

  async isItemBanned(itemId, itemType) {
    try {
      const nowIso = new Date().toISOString();
      const data = await api.get('bans', {
        banned_item_id: itemId,
        ban_type: itemType,
        is_active: true,
        $or: [{ is_permanent: true }, { ban_until: { gt: nowIso } }],
        $order: { column: 'created_at', ascending: false },
        $limit: 1
      });
      const ban = (data || [])[0] || null;
      return { success: true, isBanned: !!ban, ban };
    } catch (error) {
      console.error('Error checking ban status:', error);
      return { success: false, error: error.message || String(error) };
    }
  },

  async getActiveBans(filters = {}) {
    try {
      const nowIso = new Date().toISOString();
      const q = {
        is_active: true,
        $or: [{ is_permanent: true }, { ban_until: { gt: nowIso } }],
        $order: { column: 'created_at', ascending: false }
      };
      if (filters.banType) q.ban_type = filters.banType;
      const data = await api.get('bans', q);
      return { success: true, data: data || [] };
    } catch (error) {
      console.error('Error fetching active bans:', error);
      return { success: false, error: error.message || String(error) };
    }
  },

  async liftBan(banId) {
    try {
      const rows = await api.update('bans', banId, {
        is_active: false,
        updated_at: new Date().toISOString()
      });
      return { success: true, data: rows || [] };
    } catch (error) {
      console.error('Error lifting ban:', error);
      return { success: false, error: error.message || String(error) };
    }
  }
};

const BanAppealService = {
  async submitAppeal(banId, userId, appealText) {
    try {
      const rows = await api.insert('ban_appeals', {
        ban_id: banId,
        appealed_by_user_id: userId,
        appeal_reason: appealText,
        status: 'pending'
      });
      const data = rows || [];
      if (data.length > 0) {
        NotificationService.notifyAdmins(
          'new_ban_appeal',
          'ban_appeals',
          data[0].id,
          'Новая апелляция на бан',
          appealText || 'Пользователь запросил пересмотр блокировки'
        ).catch(() => {});
        ModerationChatService.postAppealMessage(data[0]).catch(() => {});
      }
      return { success: true, data };
    } catch (error) {
      console.error('Error submitting ban appeal:', error);
      return { success: false, error: error.message || String(error) };
    }
  },

  async getPendingAppeals() {
    try {
      const data = await api.get('ban_appeals', {
        status: 'pending',
        $order: { column: 'created_at', ascending: true }
      });
      return { success: true, data: data || [] };
    } catch (error) {
      console.error('Error fetching pending appeals:', error);
      return { success: false, error: error.message || String(error) };
    }
  },

  async respondToAppeal(appealId, status, adminResponse = '') {
    try {
      const rows = await api.update('ban_appeals', appealId, {
        status,
        admin_response: adminResponse,
        updated_at: new Date().toISOString()
      });
      return { success: true, data: rows || [] };
    } catch (error) {
      console.error('Error responding to appeal:', error);
      return { success: false, error: error.message || String(error) };
    }
  }
};

const NotificationService = {
  async notifyAdmins(notificationType, relatedTable, relatedId, title, message) {
    try {
      const admins = await api.get('profiles', { role: 'admin' });
      if (!admins || admins.length === 0) return { success: true, data: [] };

      const created = [];
      for (const admin of admins) {
        try {
          const rows = await api.insert('notifications', {
            admin_profile_id: admin.id,
            notification_type: notificationType,
            related_table: relatedTable,
            related_id: relatedId,
            title,
            message
          });
          if (Array.isArray(rows) && rows[0]) created.push(rows[0]);
        } catch (e) {
          // Don't fail the whole notification fanout
        }
      }
      return { success: true, data: created };
    } catch (error) {
      console.error('Error sending notifications:', error);
      return { success: false, error: error.message || String(error) };
    }
  },

  async getAdminNotifications(unreadOnly = false) {
    try {
      const user = typeof window.getCurrentUser === 'function' ? await window.getCurrentUser() : await api.request('/api/auth/me');
      if (!user) throw new Error('Not authenticated');

      const q = {
        admin_profile_id: user.id,
        $order: { column: 'created_at', ascending: false }
      };
      if (unreadOnly) q.is_read = false;

      const data = await api.get('notifications', q);
      return { success: true, data: data || [] };
    } catch (error) {
      console.error('Error fetching notifications:', error);
      return { success: false, error: error.message || String(error) };
    }
  },

  async markNotificationRead(notificationId) {
    try {
      const rows = await api.update('notifications', notificationId, {
        is_read: true,
        read_at: new Date().toISOString()
      });
      return { success: true, data: rows || [] };
    } catch (error) {
      console.error('Error marking notification read:', error);
      return { success: false, error: error.message || String(error) };
    }
  },

  async getUnreadCount() {
    try {
      const user = typeof window.getCurrentUser === 'function' ? await window.getCurrentUser() : await api.request('/api/auth/me');
      if (!user) throw new Error('Not authenticated');
      const result = await api.query('notifications', 'count', {}, { admin_profile_id: user.id, is_read: false });
      return { success: true, count: Number(result && result.count) || 0 };
    } catch (error) {
      console.error('Error getting unread count:', error);
      return { success: false, error: error.message || String(error) };
    }
  }
};

window.ReportService = ReportService;
window.BanService = BanService;
window.BanAppealService = BanAppealService;
window.NotificationService = NotificationService;
