/**
 * Supabase Reports and Bans Management Module
 * Handles database operations for reports and bans
 */

const supabaseClient = window.APP.supabase;

/**
 * Report Management Functions
 */
const ReportService = {
  /**
   * Submit a new report
   * @param {string} reportType - 'user', 'event', or 'chat'
   * @param {string} reportedItemId - UUID of reported item
   * @param {string} reportedByUserId - UUID of reporter
   * @param {string} reason - Reason from REPORT_REASONS
   * @param {string} description - Optional description
   * @returns {Promise}
   */
  async submitReport(reportType, reportedItemId, reportedByUserId, reason, description = '') {
    try {
      const { data, error } = await supabaseClient
        .from('reports')
        .insert([
          {
            report_type: reportType,
            reported_item_id: reportedItemId,
            reported_by_user_id: reportedByUserId,
            reason: reason,
            description: description,
            status: 'pending'
          }
        ])
        .select();

      if (error) throw error;

      // Notify admins about new report (non-blocking - don't fail if notification fails)
      if (data && data.length > 0) {
        const reportId = data[0].id;
        const typeLabel = {
          user: 'пользователя',
          event: 'встречу',
          chat: 'чат'
        }[reportType] || 'элемент';

        // Send notification asynchronously without waiting
        NotificationService.notifyAdmins(
          'new_report',
          'reports',
          reportId,
          `Новая жалоба на ${typeLabel}`,
          `Причина: ${reason}. ${description ? 'Описание: ' + description : ''}`
        ).catch(err => console.error('Failed to notify admins:', err));
      }

      return { success: true, data };
    } catch (error) {
      console.error('Error submitting report:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Get all reports (admin only)
   */
  async getAllReports(filters = {}) {
    try {
      let query = supabaseClient.from('reports').select('*');

      if (filters.status) {
        query = query.eq('status', filters.status);
      }
      if (filters.reportType) {
        query = query.eq('report_type', filters.reportType);
      }

      const { data, error } = await query.order('created_at', { ascending: false });
      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('Error fetching reports:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Get pending reports count
   */
  async getPendingReportsCount() {
    try {
      const { count, error } = await supabaseClient
        .from('reports')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending');

      if (error) throw error;
      return { success: true, count };
    } catch (error) {
      console.error('Error fetching pending reports count:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Update report status
   */
  async updateReportStatus(reportId, newStatus, adminNotes = '') {
    try {
      const { data, error } = await supabaseClient
        .from('reports')
        .update({
          status: newStatus,
          admin_notes: adminNotes,
          updated_at: new Date().toISOString()
        })
        .eq('id', reportId)
        .select();

      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('Error updating report:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Get reports for a specific item
   */
  async getReportsForItem(itemId, itemType) {
    try {
      const { data, error } = await supabaseClient
        .from('reports')
        .select('*')
        .eq('reported_item_id', itemId)
        .eq('report_type', itemType)
        .order('created_at', { ascending: false });

      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('Error fetching reports for item:', error);
      return { success: false, error: error.message };
    }
  }
};

/**
 * Ban Management Functions
 */
const BanService = {
  /**
   * Create a ban
   * @param {string} banType - 'user', 'event', or 'chat'
   * @param {string} bannedItemId - UUID of banned item
   * @param {string} bannedByUserId - UUID of admin
   * @param {string} reason - Ban reason
   * @param {boolean} isPermanent - True for permanent, false for temporary
   * @param {Date} banUntil - Expiration date (required if not permanent)
   */
  async createBan(banType, bannedItemId, bannedByUserId, reason, isPermanent = true, banUntil = null) {
    try {
      const { data, error } = await supabaseClient
        .from('bans')
        .insert([
          {
            ban_type: banType,
            banned_item_id: bannedItemId,
            banned_by_user_id: bannedByUserId,
            reason: reason,
            is_permanent: isPermanent,
            ban_until: banUntil,
            is_active: true
          }
        ])
        .select();

      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('Error creating ban:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Check if an item is currently banned
   */
  async isItemBanned(itemId, itemType) {
    try {
      const { data, error } = await supabaseClient
        .from('bans')
        .select('*')
        .eq('banned_item_id', itemId)
        .eq('ban_type', itemType)
        .eq('is_active', true)
        .or(`is_permanent.eq.true,ban_until.gt.${new Date().toISOString()}`)
        .limit(1);

      if (error) throw error;
      return { success: true, isBanned: data.length > 0, ban: data[0] || null };
    } catch (error) {
      console.error('Error checking ban status:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Get all active bans
   */
  async getActiveBans(filters = {}) {
    try {
      let query = supabaseClient
        .from('bans')
        .select('*')
        .eq('is_active', true)
        .or(`is_permanent.eq.true,ban_until.gt.${new Date().toISOString()}`);

      if (filters.banType) {
        query = query.eq('ban_type', filters.banType);
      }

      const { data, error } = await query.order('created_at', { ascending: false });
      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('Error fetching active bans:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Lift a ban (deactivate)
   */
  async liftBan(banId) {
    try {
      const { data, error } = await supabaseClient
        .from('bans')
        .update({
          is_active: false,
          updated_at: new Date().toISOString()
        })
        .eq('id', banId)
        .select();

      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('Error lifting ban:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Get ban for a specific item
   */
  async getBanForItem(itemId, itemType) {
    try {
      const { data, error } = await supabaseClient
        .from('bans')
        .select('*')
        .eq('banned_item_id', itemId)
        .eq('ban_type', itemType)
        .eq('is_active', true);

      if (error) throw error;
      return { success: true, ban: data[0] || null };
    } catch (error) {
      console.error('Error fetching ban for item:', error);
      return { success: false, error: error.message };
    }
  }
};

/**
 * Ban Appeals Management Functions
 */
const BanAppealService = {
  /**
   * Submit a ban appeal
   */
  async submitAppeal(banId, appealReason, userId) {
    try {
      const { data, error } = await supabaseClient
        .from('ban_appeals')
        .insert([
          {
            ban_id: banId,
            appeal_reason: appealReason,
            appealed_by_user_id: userId,
            status: 'pending'
          }
        ])
        .select();

      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('Error submitting ban appeal:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Get pending appeals
   */
  async getPendingAppeals() {
    try {
      const { data, error } = await supabaseClient
        .from('ban_appeals')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true });

      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('Error fetching pending appeals:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Respond to a ban appeal
   */
  async respondToAppeal(appealId, status, adminResponse = '') {
    try {
      const { data, error } = await supabaseClient
        .from('ban_appeals')
        .update({
          status: status,
          admin_response: adminResponse,
          updated_at: new Date().toISOString()
        })
        .eq('id', appealId)
        .select();

      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('Error responding to appeal:', error);
      return { success: false, error: error.message };
    }
  }
};

/**
 * Notification Management Functions
 */
const NotificationService = {
  /**
   * Send notification to all admin users
   */
  async notifyAdmins(notificationType, relatedTable, relatedId, title, message) {
    try {
      // Get all admin profiles
      const { data: admins, error: adminError } = await supabaseClient
        .from('profiles')
        .select('id')
        .eq('role', 'admin');

      if (adminError) throw adminError;
      if (!admins || admins.length === 0) {
        console.warn('No admin users found');
        return { success: true, data: [] };
      }

      // Create notifications for all admin users
      const notifications = admins.map(admin => ({
        admin_profile_id: admin.id,
        notification_type: notificationType,
        related_table: relatedTable,
        related_id: relatedId,
        title: title,
        message: message
      }));

      const { data, error } = await supabaseClient
        .from('notifications')
        .insert(notifications)
        .select();

      if (error) throw error;
      console.log(`Notification sent to ${admins.length} admin(s)`);
      return { success: true, data };
    } catch (error) {
      console.error('Error sending notifications:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Get admin notifications for current user
   */
  async getAdminNotifications(unreadOnly = false) {
    try {
      const { data: { user } } = await supabaseClient.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      let query = supabaseClient
        .from('notifications')
        .select('*')
        .eq('admin_profile_id', user.id);

      if (unreadOnly) {
        query = query.eq('is_read', false);
      }

      const { data, error } = await query.order('created_at', { ascending: false });
      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('Error fetching notifications:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Mark notification as read
   */
  async markNotificationRead(notificationId) {
    try {
      const { data, error } = await supabaseClient
        .from('notifications')
        .update({
          is_read: true,
          read_at: new Date().toISOString()
        })
        .eq('id', notificationId)
        .select();

      if (error) throw error;
      return { success: true, data };
    } catch (error) {
      console.error('Error marking notification read:', error);
      return { success: false, error: error.message };
    }
  },

  /**
   * Get unread notification count for current admin
   */
  async getUnreadCount() {
    try {
      const { data: { user } } = await supabaseClient.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      const { count, error } = await supabaseClient
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('admin_profile_id', user.id)
        .eq('is_read', false);

      if (error) throw error;
      return { success: true, count };
    } catch (error) {
      console.error('Error getting unread count:', error);
      return { success: false, error: error.message };
    }
  }
};

// Export services for use in other modules
window.supabaseClient = supabaseClient;
window.ReportService = ReportService;
window.BanService = BanService;
window.BanAppealService = BanAppealService;
window.NotificationService = NotificationService;
