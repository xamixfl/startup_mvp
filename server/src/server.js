

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv');

// Env loading:
// - Production server should keep using `server/.env`
// - Local dev can create `server/.env.local` without touching production config
// - Optional: set ENV_FILE to point to an explicit env file
(() => {
  const envDir = path.resolve(__dirname, '..');
  const explicit = process.env.ENV_FILE;
  const candidates = explicit
    ? [path.isAbsolute(explicit) ? explicit : path.resolve(process.cwd(), explicit)]
    : [path.join(envDir, '.env.local'), path.join(envDir, '.env')];

  for (const p of candidates) {
    dotenv.config({ path: p, override: false });
  }
})();

const { selectRows, insertRow, updateRow, deleteRow, deleteWhere } = require('./query');
const {
  createProfileUser,
  findProfileByEmail,
  createEmailVerification,
  consumeEmailVerification,
  createPasswordResetToken,
  resetPasswordWithToken,
  markEmailVerified,
  createSession,
  deleteSession,
  setSessionCookie,
  clearSessionCookie,
  authMiddleware,
  requireAuth,
  updateProfile
} = require('./auth');
const { uploader, getUploadRoot } = require('./uploads');
const { query } = require('./db');
const { createPublicUrl, sendEmail, buildEmailConfirmationMessage, buildPasswordResetMessage } = require('./mail');
const bcrypt = require('bcryptjs');

const app = express();
const port = Number(process.env.PORT || 3000);
app.set('trust proxy', 1);

// Minimal in-memory typing state: { chatId -> { userId -> expiresAtMs } }
const typingState = new Map();
const TYPING_TTL_MS = 3500;
const schemaColumnCache = new Map();
const eventClients = new Map();
const EXPIRED_MEETINGS_CLEANUP_INTERVAL_MS = 60 * 1000;
let moderationChatEnsured = false;
const loginRateLimitState = new Map();
const LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 5;
const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const CSRF_COOKIE_NAME = process.env.CSRF_COOKIE_NAME || 'csrf_token';
const CSRF_HEADER_NAME = 'x-csrf-token';

function shouldUseSecureCookies() {
  const raw = process.env.COOKIE_SECURE;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function setCsrfCookie(res, token) {
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    sameSite: 'lax',
    secure: shouldUseSecureCookies(),
    path: '/'
  });
}

function ensureCsrfToken(req, res, next) {
  const existingToken = req.cookies && req.cookies[CSRF_COOKIE_NAME];
  if (existingToken) {
    req.csrfToken = existingToken;
    return next();
  }

  const token = generateCsrfToken();
  req.csrfToken = token;
  setCsrfCookie(res, token);
  return next();
}

function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const cookieToken = req.cookies && req.cookies[CSRF_COOKIE_NAME];
  const headerToken = req.get(CSRF_HEADER_NAME);
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'CSRF token invalid or missing' });
  }
  return next();
}

function getLoginRateLimitKey(req) {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const ip = String(req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown');
  return `${ip}:${email || 'unknown'}`;
}

function pruneExpiredLoginRateLimitEntries(now = Date.now()) {
  for (const [key, value] of loginRateLimitState.entries()) {
    if (!value || value.resetAt <= now) {
      loginRateLimitState.delete(key);
    }
  }
}

function enforceLoginRateLimit(req, res, next) {
  pruneExpiredLoginRateLimitEntries();
  const key = getLoginRateLimitKey(req);
  const now = Date.now();
  const bucket = loginRateLimitState.get(key);
  if (bucket && bucket.count >= LOGIN_RATE_LIMIT_MAX_ATTEMPTS && bucket.resetAt > now) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({
      error: 'Слишком много попыток входа. Попробуйте позже.',
      retry_after_seconds: retryAfterSec
    });
  }
  req.loginRateLimitKey = key;
  return next();
}

function registerFailedLoginAttempt(key) {
  if (!key) return;
  const now = Date.now();
  const bucket = loginRateLimitState.get(key);
  if (!bucket || bucket.resetAt <= now) {
    loginRateLimitState.set(key, { count: 1, resetAt: now + LOGIN_RATE_LIMIT_WINDOW_MS });
    return;
  }
  bucket.count += 1;
}

function clearLoginRateLimit(key) {
  if (!key) return;
  loginRateLimitState.delete(key);
}

async function tableHasColumn(tableName, columnName) {
  const cacheKey = `${tableName}:${columnName}`;
  if (schemaColumnCache.has(cacheKey)) {
    return schemaColumnCache.get(cacheKey);
  }

  const result = await query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1`,
    [tableName, columnName]
  );
  const hasColumn = result.rowCount > 0;
  schemaColumnCache.set(cacheKey, hasColumn);
  return hasColumn;
}

async function getTableColumns(tableName) {
  const cacheKey = `${tableName}:__all__`;
  if (schemaColumnCache.has(cacheKey)) {
    return schemaColumnCache.get(cacheKey);
  }

  const result = await query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1`,
    [tableName]
  );
  const columns = new Set((result.rows || []).map(row => row.column_name).filter(Boolean));
  schemaColumnCache.set(cacheKey, columns);
  return columns;
}

async function buildProfileJsonObjectSql(alias) {
  const profileColumns = await getTableColumns('profiles');
  const fields = [
    'id',
    'username',
    'full_name',
    'email',
    'age',
    'location',
    'city',
    'about',
    'bio',
    'description',
    'photo_url'
  ].filter(column => profileColumns.has(column));

  if (fields.length === 0) {
    return 'NULL::jsonb';
  }

  return `jsonb_build_object(${fields.map(column => `'${column}', ${alias}."${column}"`).join(', ')})`;
}

function getProfileDisplayNameServer(profile, fallback = 'Пользователь') {
  return profile?.full_name || profile?.username || profile?.email || fallback;
}

function parseJoinRequesterNameServer(message) {
  const text = String(message || '');
  const marker = ' хочет присоединиться';
  const index = text.indexOf(marker);
  if (index <= 0) return '';
  return text.slice(0, index).trim();
}

function normalizeNotificationNameServer(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function resolveNotificationRequestServer(notification, pendingRequests) {
  if (!Array.isArray(pendingRequests) || pendingRequests.length === 0) return null;
  if (pendingRequests.length === 1) return pendingRequests[0];

  const senderName = normalizeNotificationNameServer(parseJoinRequesterNameServer(notification.message));
  if (!senderName) return null;

  const matches = pendingRequests.filter(request => normalizeNotificationNameServer(request.displayName) === senderName);
  return matches.length === 1 ? matches[0] : null;
}

function addEventClient(userId, res) {
  const key = String(userId);
  if (!eventClients.has(key)) {
    eventClients.set(key, new Set());
  }
  eventClients.get(key).add(res);
}

function removeEventClient(userId, res) {
  const key = String(userId);
  const set = eventClients.get(key);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) {
    eventClients.delete(key);
  }
}

function sendEventToUser(userId, eventName, payload) {
  const key = String(userId);
  const clients = eventClients.get(key);
  if (!clients || clients.size === 0) return;
  const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try {
      res.write(data);
    } catch (_e) {
      removeEventClient(key, res);
    }
  }
}

async function getChatAudience(chatId) {
  const hasStatus = await tableHasColumn('chat_members', 'status');
  const membershipWhere = hasStatus ? ` AND cm.status = 'approved'` : '';
  const result = await query(
    `SELECT DISTINCT user_id
       FROM (
         SELECT cm.user_id
           FROM chat_members cm
          WHERE cm.chat_id = $1${membershipWhere}
         UNION
         SELECT c.owner_id AS user_id
           FROM chats c
          WHERE c.id = $1
       ) audience
      WHERE user_id IS NOT NULL`,
    [chatId]
  );
  return Array.from(new Set((result.rows || []).map(row => String(row.user_id)).filter(Boolean)));
}

async function broadcastToChat(chatId, eventName, payload) {
  const audience = await getChatAudience(chatId);
  audience.forEach(userId => sendEventToUser(userId, eventName, payload));
}

async function ensureChatAccess(chatId, userId) {
  const hasStatus = await tableHasColumn('chat_members', 'status');
  const membershipWhere = hasStatus ? ` AND cm.status = 'approved'` : '';
  const result = await query(
    `SELECT c.id
       FROM chats c
       LEFT JOIN chat_members cm
         ON cm.chat_id = c.id
        AND cm.user_id = $2${membershipWhere}
      WHERE c.id = $1
        AND (c.owner_id = $2 OR cm.user_id IS NOT NULL)
      LIMIT 1`,
    [chatId, userId]
  );
  return result.rowCount > 0;
}

async function deleteMeetingCascade(meetingId) {
  if (!meetingId) return;

  const chats = await selectRows('chats', { meeting_id: meetingId });
  const chat = (chats || [])[0];

  if (chat?.id) {
    try {
      await deleteWhere('chat_members', { chat_id: chat.id });
    } catch (_e) {}
    try {
      await deleteWhere('chat_messages', { chat_id: chat.id });
    } catch (_e) {}
    try {
      await deleteRow('chats', { id: chat.id });
    } catch (_e) {}
  }

  try {
    await deleteWhere('table-connector', { meeting_id: meetingId });
  } catch (_e) {}

  try {
    await deleteRow('meetings', { id: meetingId });
  } catch (_e) {}
}

async function cleanupExpiredMeetingsServer() {
  const nowIso = new Date().toISOString();
  const expiredMeetings = await selectRows('meetings', { expires_at: { lt: nowIso } });
  let deleted = 0;

  for (const meeting of expiredMeetings || []) {
    if (!meeting?.id) continue;
    await deleteMeetingCascade(meeting.id);
    deleted += 1;
  }

  return { deleted };
}

function normalizeProfilesRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(row => {
    if (!row || typeof row !== 'object') return row;
    if ('password_hash' in row) {
      delete row.password_hash;
    }
    if (row.photo_url && !row.photo_URL) {
      row.photo_URL = row.photo_url;
    }
    if (row.city && !row.location) {
      row.location = row.city;
    }
    if (!row.about) {
      if (row.bio) row.about = row.bio;
      else if (row.description) row.about = row.description;
    }
    // Ensure both verification fields are present for frontend
    if (typeof row.verified === 'undefined') {
      row.verified = !!row.email_verified_at;
    }
    if (typeof row.email_verified_at === 'undefined') {
      row.email_verified_at = row.verified ? new Date().toISOString() : null;
    }
    return row;
  });
}

function normalizeQueryPayload(table, data) {
  if (!data || typeof data !== 'object') return data;
  if (table !== 'profiles') return data;

  // Accept frontend legacy field names.
  if ('photo_URL' in data && !('photo_url' in data)) {
    const { photo_URL, ...rest } = data;
    return { ...rest, photo_url: photo_URL };
  }
  return data;
}

function createHttpError(message, status = 400) {
  const error = new Error(message);
  error.statusCode = status;
  return error;
}

function isAdmin(req) {
  return req.user?.role === 'admin';
}

function requireAuthenticatedUser(req) {
  if (!req.user) throw createHttpError('Unauthorized', 401);
}

function extractFilterIds(value) {
  if (!value) return [];
  if (typeof value === 'string' || typeof value === 'number') {
    return [String(value)];
  }
  if (value && typeof value === 'object' && Array.isArray(value.in)) {
    return value.in.map(item => String(item)).filter(Boolean);
  }
  return [];
}

async function getMeetingRecord(meetingId) {
  const rows = await selectRows('meetings', { id: meetingId, $limit: 1 });
  return (rows || [])[0] || null;
}

async function getChatRecord(chatId) {
  const rows = await selectRows('chats', { id: chatId, $limit: 1 });
  return (rows || [])[0] || null;
}

async function canManageMeeting(req, meetingId) {
  if (isAdmin(req)) return true;
  const meeting = await getMeetingRecord(meetingId);
  if (!meeting) throw createHttpError('Meeting not found', 404);
  return String(meeting.creator_id || '') === String(req.user?.id || '');
}

async function assertChatAccess(req, chatIds) {
  requireAuthenticatedUser(req);
  if (!Array.isArray(chatIds) || chatIds.length === 0) {
    throw createHttpError('Missing chat access filter', 400);
  }
  for (const chatId of chatIds) {
    const hasAccess = await ensureChatAccess(String(chatId), String(req.user.id));
    if (!hasAccess && !isAdmin(req)) {
      throw createHttpError('Forbidden', 403);
    }
  }
}

async function canManageChat(req, chatId) {
  if (isAdmin(req)) return true;
  const chat = await getChatRecord(chatId);
  if (!chat) throw createHttpError('Chat not found', 404);
  if (String(chat.owner_id || '') === String(req.user?.id || '')) {
    return true;
  }
  if (chat.meeting_id) {
    return canManageMeeting(req, chat.meeting_id);
  }
  return false;
}

async function canDeleteChat(req, chatId) {
  if (await canManageChat(req, chatId)) return true;
  const members = await selectRows('chat_members', { chat_id: chatId, $limit: 1 });
  return !Array.isArray(members) || members.length === 0;
}

async function authorizeQueryOperation(req, table, action, data, filters) {
  const normalizedData = normalizeQueryPayload(table, data);
  const normalizedFilters = filters && typeof filters === 'object' ? { ...filters } : {};
  const publicReadTables = new Set(['topics', 'meetings', 'profiles', 'table-connector']);
  const allowedActions = new Set(['select', 'count', 'insert', 'update', 'delete', 'deleteWhere']);

  if (!allowedActions.has(action)) {
    throw createHttpError('Unknown action', 400);
  }

  const allowedTables = new Set([
    'profiles',
    'meetings',
    'table-connector',
    'topics',
    'chats',
    'chat_members',
    'chat_messages',
    'reports',
    'bans',
    'ban_appeals',
    'notifications'
  ]);

  if (!allowedTables.has(table)) {
    throw createHttpError('Forbidden table', 403);
  }

  if (!['select', 'count'].includes(action)) {
    requireAuthenticatedUser(req);
  } else if (!publicReadTables.has(table)) {
    requireAuthenticatedUser(req);
  }

  if (table === 'profiles') {
    if (action === 'insert' || action === 'delete' || action === 'deleteWhere') {
      throw createHttpError('Forbidden', 403);
    }
    if (action === 'update') {
      const targetId = String(normalizedData?.id || '');
      if (!targetId) throw createHttpError('Missing id', 400);
      if (!isAdmin(req) && targetId !== String(req.user.id)) {
        throw createHttpError('Forbidden', 403);
      }
    }
    return { data: normalizedData, filters: normalizedFilters };
  }

  if (table === 'meetings') {
    if (action === 'insert') {
      return {
        data: { ...normalizedData, creator_id: req.user.id },
        filters: normalizedFilters
      };
    }
    if (action === 'update' || action === 'delete') {
      const meetingId = String(normalizedData?.id || '');
      if (!meetingId) throw createHttpError('Missing id', 400);
      const canManage = await canManageMeeting(req, meetingId);
      if (!canManage) throw createHttpError('Forbidden', 403);
    }
    return { data: normalizedData, filters: normalizedFilters };
  }

  if (table === 'table-connector') {
    if (action === 'select' || action === 'count') {
      const hasMeetingFilter = Boolean(normalizedFilters?.meeting_id);
      const hasUserFilter = Boolean(normalizedFilters?.user_id);
      if (!isAdmin(req) && !hasMeetingFilter && !hasUserFilter) {
        throw createHttpError('Forbidden', 403);
      }
      return { data: normalizedData, filters: normalizedFilters };
    }
    if (action === 'insert') {
      const meetingId = String(normalizedData?.meeting_id || '');
      const userId = String(normalizedData?.user_id || req.user.id);
      if (!meetingId) throw createHttpError('Missing meeting_id', 400);
      if (!isAdmin(req) && userId !== String(req.user.id) && !(await canManageMeeting(req, meetingId))) {
        throw createHttpError('Forbidden', 403);
      }
      return { data: { ...normalizedData, user_id: userId }, filters: normalizedFilters };
    }
    if (action === 'delete') {
      const rowId = String(normalizedData?.id || '');
      if (!rowId) throw createHttpError('Missing id', 400);
      const rows = await selectRows('table-connector', { id: rowId, $limit: 1 });
      const row = (rows || [])[0];
      if (!row) throw createHttpError('Not found', 404);
      if (!isAdmin(req) && String(row.user_id || '') !== String(req.user.id) && !(await canManageMeeting(req, row.meeting_id))) {
        throw createHttpError('Forbidden', 403);
      }
    }
    if (action === 'deleteWhere') {
      const meetingId = String(normalizedFilters?.meeting_id || '');
      const userId = String(normalizedFilters?.user_id || '');
      if (!meetingId) throw createHttpError('Missing meeting_id', 400);
      if (!isAdmin(req) && userId && userId !== String(req.user.id) && !(await canManageMeeting(req, meetingId))) {
        throw createHttpError('Forbidden', 403);
      }
    }
    return { data: normalizedData, filters: normalizedFilters };
  }

  if (table === 'chats') {
    if (action === 'select' || action === 'count') {
      if (!isAdmin(req)) {
        const ownerId = normalizedFilters?.owner_id ? String(normalizedFilters.owner_id) : '';
        const creatorId = normalizedFilters?.creator_id ? String(normalizedFilters.creator_id) : '';
        const chatIds = extractFilterIds(normalizedFilters?.id);
        if (ownerId && ownerId === String(req.user.id)) {
          return { data: normalizedData, filters: normalizedFilters };
        }
        if (creatorId && creatorId === String(req.user.id)) {
          return { data: normalizedData, filters: normalizedFilters };
        }
        if (chatIds.length > 0) {
          await assertChatAccess(req, chatIds);
          return { data: normalizedData, filters: normalizedFilters };
        }
        throw createHttpError('Forbidden', 403);
      }
      return { data: normalizedData, filters: normalizedFilters };
    }
    if (action === 'insert') {
      const meetingId = normalizedData?.meeting_id ? String(normalizedData.meeting_id) : '';
      if (meetingId && !isAdmin(req) && !(await canManageMeeting(req, meetingId))) {
        throw createHttpError('Forbidden', 403);
      }
      return { data: { ...normalizedData, owner_id: req.user.id }, filters: normalizedFilters };
    }
    if (action === 'update') {
      const chatId = String(normalizedData?.id || '');
      if (!chatId) throw createHttpError('Missing id', 400);
      if (!(await canManageChat(req, chatId))) {
        throw createHttpError('Forbidden', 403);
      }
    }
    if (action === 'delete') {
      const chatId = String(normalizedData?.id || '');
      if (!chatId) throw createHttpError('Missing id', 400);
      if (!(await canDeleteChat(req, chatId))) {
        throw createHttpError('Forbidden', 403);
      }
    }
    return { data: normalizedData, filters: normalizedFilters };
  }

  if (table === 'chat_members') {
    if (action === 'select' || action === 'count') {
      const directUserId = normalizedFilters?.user_id ? String(normalizedFilters.user_id) : '';
      const chatIds = extractFilterIds(normalizedFilters?.chat_id);
      const filterKeys = Object.keys(normalizedFilters || {}).filter(key => !key.startsWith('$'));
      const schemaProbeOnly = filterKeys.length > 0 && filterKeys.every(key => key === 'status');

      if (schemaProbeOnly) {
        return { data: normalizedData, filters: normalizedFilters };
      }
      if (directUserId && (directUserId === String(req.user.id) || isAdmin(req))) {
        return { data: normalizedData, filters: normalizedFilters };
      }
      await assertChatAccess(req, chatIds);
      return { data: normalizedData, filters: normalizedFilters };
    }
    if (action === 'insert') {
      const chatId = String(normalizedData?.chat_id || '');
      const userId = String(normalizedData?.user_id || req.user.id);
      if (!chatId) throw createHttpError('Missing chat_id', 400);
      const canAccess = await ensureChatAccess(chatId, String(req.user.id));
      const canManage = await canManageChat(req, chatId);
      if (!canAccess && !canManage) throw createHttpError('Forbidden', 403);
      if (!isAdmin(req) && userId !== String(req.user.id) && !canManage) {
        throw createHttpError('Forbidden', 403);
      }
      return { data: { ...normalizedData, user_id: userId }, filters: normalizedFilters };
    }
    if (action === 'update') {
      const rowId = String(normalizedData?.id || '');
      if (!rowId) throw createHttpError('Missing id', 400);
      const rows = await selectRows('chat_members', { id: rowId, $limit: 1 });
      const row = (rows || [])[0];
      if (!row) throw createHttpError('Not found', 404);
      if (!isAdmin(req) && String(row.user_id || '') !== String(req.user.id) && !(await canManageChat(req, row.chat_id))) {
        throw createHttpError('Forbidden', 403);
      }
    }
    if (action === 'deleteWhere') {
      const chatId = String(normalizedFilters?.chat_id || '');
      const userId = normalizedFilters?.user_id ? String(normalizedFilters.user_id) : '';
      if (!chatId) throw createHttpError('Missing chat_id', 400);
      if (!isAdmin(req) && userId && userId !== String(req.user.id) && !(await canManageChat(req, chatId))) {
        throw createHttpError('Forbidden', 403);
      }
      if (!isAdmin(req) && !userId && !(await canManageChat(req, chatId))) {
        throw createHttpError('Forbidden', 403);
      }
    }
    return { data: normalizedData, filters: normalizedFilters };
  }

  if (table === 'chat_messages') {
    if (action === 'select' || action === 'count') {
      const chatIds = extractFilterIds(normalizedFilters?.chat_id);
      await assertChatAccess(req, chatIds);
      return { data: normalizedData, filters: normalizedFilters };
    }
    if (action === 'insert') {
      const chatId = String(normalizedData?.chat_id || '');
      if (!chatId) throw createHttpError('Missing chat_id', 400);
      await assertChatAccess(req, [chatId]);
      return { data: { ...normalizedData, user_id: req.user.id }, filters: normalizedFilters };
    }
    if (action === 'deleteWhere') {
      const chatId = String(normalizedFilters?.chat_id || '');
      if (!chatId) throw createHttpError('Missing chat_id', 400);
      const chat = await getChatRecord(chatId);
      if (!chat) throw createHttpError('Chat not found', 404);
      if (chat.meeting_id) {
        if (!(await canManageChat(req, chatId))) throw createHttpError('Forbidden', 403);
      } else {
        await assertChatAccess(req, [chatId]);
      }
    }
    if (action === 'update' || action === 'delete') {
      throw createHttpError('Forbidden', 403);
    }
    return { data: normalizedData, filters: normalizedFilters };
  }

  if (table === 'notifications') {
    requireAuthenticatedUser(req);
    if (action === 'select' || action === 'count') {
      if (!isAdmin(req)) {
        if (normalizedFilters.admin_profile_id && String(normalizedFilters.admin_profile_id) !== String(req.user.id)) {
          throw createHttpError('Forbidden', 403);
        }
        normalizedFilters.admin_profile_id = req.user.id;
      }
    }
    if (action === 'update') {
      const rowId = String(normalizedData?.id || '');
      const rows = await selectRows('notifications', { id: rowId, $limit: 1 });
      const row = (rows || [])[0];
      if (!row) throw createHttpError('Not found', 404);
      if (!isAdmin(req) && String(row.admin_profile_id || '') !== String(req.user.id)) {
        throw createHttpError('Forbidden', 403);
      }
    }
    if (action === 'insert') {
      return { data: normalizedData, filters: normalizedFilters };
    }
    return { data: normalizedData, filters: normalizedFilters };
  }

  if (table === 'reports') {
    if (action === 'insert') {
      return { data: normalizedData, filters: normalizedFilters };
    }
    if (!isAdmin(req)) {
      throw createHttpError('Forbidden', 403);
    }
    return { data: normalizedData, filters: normalizedFilters };
  }

  if (table === 'bans' || table === 'ban_appeals') {
    if (table === 'ban_appeals' && action === 'insert') {
      return { data: normalizedData, filters: normalizedFilters };
    }
    if (!isAdmin(req)) {
      throw createHttpError('Forbidden', 403);
    }
    return { data: normalizedData, filters: normalizedFilters };
  }

  if (table === 'topics') {
    if (action !== 'select' && action !== 'count') {
      throw createHttpError('Forbidden', 403);
    }
    return { data: normalizedData, filters: normalizedFilters };
  }

  return { data: normalizedData, filters: normalizedFilters };
}

app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(ensureCsrfToken);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// Serve uploads and frontend from the project root so js/api.js can call `/api/*` same-origin.
// Note: `express.static` returns 404 for directory requests like `/uploads/` (no index, no listing).
// Provide a small health response for that exact path to reduce confusion during debugging.
app.get(['/uploads', '/uploads/'], (_req, res) => res.status(200).json({ ok: true }));
app.use('/uploads', express.static(getUploadRoot()));
app.use(express.static(path.resolve(__dirname, '..', '..')));

// Only API routes need auth/session lookup. Static assets/pages must not depend on DB.
app.use('/api', authMiddleware);
app.use('/api', csrfProtection);

app.get('/api/health', async (_req, res) => {
  return res.json({ ok: true });
});

app.get('/api/csrf-token', (req, res) => {
  return res.json({ csrfToken: req.csrfToken || null });
});

// DB connectivity check (useful when debugging "topics not loading").
app.get('/api/db-health', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    await query('select 1 as ok');
    return res.json({ ok: true, db: true });
  } catch (e) {
    return res.status(500).json({ ok: false, db: false, error: e.message || 'DB error', code: e.code });
  }
});

// Quick diagnostic for topics table.
app.get('/api/debug/topics', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const countRes = await query('select count(*)::int as count from topics');
    const listRes = await query('select * from topics order by 1 asc limit 5');
    return res.json({ ok: true, count: countRes.rows[0]?.count || 0, sample: listRes.rows || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'DB error', code: e.code, detail: e.detail });
  }
});

app.post('/api/maintenance/cleanup-expired-meetings', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const result = await cleanupExpiredMeetingsServer();
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'Cleanup failed' });
  }
});

app.post('/api/query', async (req, res) => {
  try {
    const { table, action, data, filters } = req.body || {};
    const { data: normalizedData, filters: normalizedFilters } = await authorizeQueryOperation(
      req,
      table,
      action,
      data,
      filters
    );
    if (action === 'select') {
      const rows = await selectRows(table, normalizedFilters);
      return res.json(table === 'profiles' ? normalizeProfilesRows(rows) : rows);
    }
    if (action === 'count') {
      const rows = await selectRows(table, normalizedFilters);
      return res.json({ count: Array.isArray(rows) ? rows.length : 0 });
    }
    if (action === 'insert') {
      const rows = await insertRow(table, normalizedData);
      return res.json(table === 'profiles' ? normalizeProfilesRows(rows) : rows);
    }
    if (action === 'update') {
      const rows = await updateRow(table, normalizedData);
      return res.json(table === 'profiles' ? normalizeProfilesRows(rows) : rows);
    }
    if (action === 'delete') {
      if (table === 'meetings') {
        const meetingId = String(normalizedData?.id || '');
        const rows = await selectRows('meetings', { id: meetingId, $limit: 1 });
        const meeting = (rows || [])[0];
        if (!meeting) return res.json([]);
        await deleteMeetingCascade(meetingId);
        return res.json([meeting]);
      }
      const rows = await deleteRow(table, normalizedData);
      return res.json(table === 'profiles' ? normalizeProfilesRows(rows) : rows);
    }
    if (action === 'deleteWhere') {
      const rows = await deleteWhere(table, normalizedFilters);
      return res.json(table === 'profiles' ? normalizeProfilesRows(rows) : rows);
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(400).json({
      error: e && e.message ? e.message : 'Bad request',
      code: e && e.code ? e.code : undefined,
      detail: e && e.detail ? e.detail : undefined
    });
  }
});

// Keep compatibility with js/api.js helpers.
app.get('/api/meetings', async (_req, res) => {
  try {
    const rows = await selectRows('meetings', {});
    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.post('/api/meetings/:meetingId/join-request', requireAuth, async (req, res) => {
  try {
    const meetingId = String(req.params.meetingId || '');
    if (!meetingId) return res.status(400).json({ error: 'Missing meetingId' });

    const meetingRows = await selectRows('meetings', { id: meetingId, $limit: 1 });
    const meeting = (meetingRows || [])[0];
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    if (!meeting.chat_id) return res.status(400).json({ error: 'Chat not created' });

    const maxSlots = Number(meeting.max_slots || 0);
    const currentSlots = Number(meeting.current_slots || 0);
    if (maxSlots > 0 && currentSlots >= maxSlots) {
      return res.status(409).json({ error: 'Свободных мест сейчас нет' });
    }

    const userId = String(req.user.id || '');
    const existingRows = await selectRows('chat_members', {
      chat_id: meeting.chat_id,
      user_id: userId,
      $limit: 1
    });
    const existing = (existingRows || [])[0];
    const hasStatus = await tableHasColumn('chat_members', 'status');
    const hasRole = await tableHasColumn('chat_members', 'role');

    if (existing) {
      if (hasStatus && existing.status === 'pending') {
        return res.json({ ok: true, state: 'pending', alreadyExists: true });
      }
      return res.json({ ok: true, state: 'joined', alreadyExists: true });
    }

    const membershipData = {
      chat_id: meeting.chat_id,
      user_id: userId
    };
    if (hasRole) membershipData.role = 'member';
    if (hasStatus) membershipData.status = 'pending';
    await insertRow('chat_members', membershipData);

    if (hasStatus) {
      if (meeting.creator_id && String(meeting.creator_id) !== userId) {
        const senderName = getProfileDisplayNameServer(req.user, userId);
        await insertRow('notifications', {
          admin_profile_id: meeting.creator_id,
          notification_type: 'event_join_request',
          related_table: 'meetings',
          related_id: meeting.id,
          title: meeting.title || 'Встреча',
          message: `${senderName} хочет присоединиться к встрече «${meeting.title || 'Встреча'}».`,
          is_read: false,
          read_at: null
        });
      }
      return res.json({ ok: true, state: 'pending' });
    }

    const existingParticipant = await selectRows('table-connector', {
      meeting_id: meeting.id,
      user_id: userId,
      $limit: 1
    });
    let participantAdded = false;
    if (!existingParticipant || !existingParticipant[0]) {
      await insertRow('table-connector', { meeting_id: meeting.id, user_id: userId });
      participantAdded = true;
    }

    let nextSlots = currentSlots;
    if (participantAdded) {
      nextSlots = currentSlots + 1;
      await updateRow('meetings', { id: meeting.id, current_slots: nextSlots });
      if (meeting.creator_id && String(meeting.creator_id) !== userId) {
        const senderName = getProfileDisplayNameServer(req.user, userId);
        await insertRow('notifications', {
          admin_profile_id: meeting.creator_id,
          notification_type: 'event_joined_direct',
          related_table: 'meetings',
          related_id: meeting.id,
          title: 'Новый участник встречи',
          message: `${senderName} присоединился к встрече «${meeting.title || 'Встреча'}».`,
          is_read: false,
          read_at: null
        });
      }
    }

    return res.json({ ok: true, state: 'joined', current_slots: nextSlots });
  } catch (e) {
    const status = Number(e?.statusCode || e?.status || 400);
    return res.status(status).json({ error: e.message || 'Failed to create join request' });
  }
});

app.post('/api/meetings/:meetingId/leave', requireAuth, async (req, res) => {
  try {
    const meetingId = String(req.params.meetingId || '');
    if (!meetingId) return res.status(400).json({ error: 'Missing meetingId' });

    const meetingRows = await selectRows('meetings', { id: meetingId, $limit: 1 });
    const meeting = (meetingRows || [])[0];
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

    const userId = String(req.user.id || '');
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    if (String(meeting.creator_id || '') === userId) {
      return res.status(403).json({ error: 'Creator cannot leave own meeting' });
    }

    let shouldDecrement = true;
    if (meeting.chat_id) {
      const hasStatus = await tableHasColumn('chat_members', 'status');
      if (hasStatus) {
        const rows = await selectRows('chat_members', { chat_id: meeting.chat_id, user_id: userId });
        const membership = (rows || [])[0] || null;
        shouldDecrement = membership?.status === 'approved';
      }
      await deleteWhere('chat_members', { chat_id: meeting.chat_id, user_id: userId });
    }

    try {
      await deleteWhere('table-connector', { meeting_id: meetingId, user_id: userId });
    } catch (_e) {}

    let nextSlots = Number(meeting.current_slots || 0);
    if (shouldDecrement) {
      const updateResult = await query(
        `UPDATE meetings
            SET current_slots = GREATEST(COALESCE(current_slots, 0) - 1, 0)
          WHERE id = $1
          RETURNING current_slots`,
        [meetingId]
      );
      nextSlots = Number(updateResult.rows?.[0]?.current_slots || 0);
    }

    return res.json({
      ok: true,
      current_slots: nextSlots
    });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Failed to leave meeting' });
  }
});

app.delete('/api/meetings/:meetingId/cascade', requireAuth, async (req, res) => {
  try {
    const meetingId = String(req.params.meetingId || '');
    if (!meetingId) return res.status(400).json({ error: 'Missing meetingId' });

    const meetingRows = await selectRows('meetings', { id: meetingId });
    const meeting = (meetingRows || [])[0];
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

    const isOwner = String(meeting.creator_id || '') === String(req.user.id || '');
    const isAdmin = req.user?.role === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await deleteMeetingCascade(meetingId);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to delete meeting' });
  }
});

app.get('/api/feed/meetings', async (_req, res) => {
  try {
    const creatorJsonSql = `${await buildProfileJsonObjectSql('p')} AS creator_profile`;

    const result = await query(
      `SELECT
         m.*,
         ${creatorJsonSql}
       FROM meetings m
       LEFT JOIN profiles p ON p.id = m.creator_id
       ORDER BY m.created_at DESC`
    );

    const rows = (result.rows || []).map(row => {
      const rawCreator = row.creator_profile && typeof row.creator_profile === 'object'
        ? row.creator_profile
        : null;
      const creator = rawCreator
        ? normalizeProfilesRows([rawCreator])[0]
        : null;
      return {
        ...row,
        creator
      };
    });

    return res.json(rows);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to build meetings feed' });
  }
});

app.get('/api/chats/direct-candidate/:peerId', requireAuth, async (req, res) => {
  try {
    const currentUserId = String(req.user.id || '');
    const peerId = String(req.params.peerId || '');
    if (!peerId) {
      return res.status(400).json({ error: 'Missing peerId' });
    }
    if (peerId === currentUserId) {
      return res.status(400).json({ error: 'Cannot create direct chat with yourself' });
    }

    const result = await query(
      `SELECT *
         FROM chats
        WHERE meeting_id IS NULL
          AND (
            (owner_id = $1 AND peer_id = $2)
            OR
            (owner_id = $2 AND peer_id = $1)
          )
        ORDER BY created_at DESC
        LIMIT 1`,
      [currentUserId, peerId]
    );

    return res.json((result.rows || [])[0] || null);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to find direct chat candidate' });
  }
});

app.get('/api/my-events/summary', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const hasStatus = await tableHasColumn('chat_members', 'status');
    const approvedWhere = hasStatus ? ` AND cm.status = 'approved'` : '';
    const creatorJsonSql = `${await buildProfileJsonObjectSql('p')} AS creator_profile`;

    const result = await query(
      `WITH owned AS (
         SELECT m.*, 'owner'::text AS role
           FROM meetings m
          WHERE m.creator_id = $1
       ),
       participant_ids AS (
         SELECT DISTINCT tc.meeting_id
           FROM "table-connector" tc
          WHERE tc.user_id = $1
         UNION
         SELECT DISTINCT c.meeting_id
           FROM chat_members cm
           JOIN chats c ON c.id = cm.chat_id
          WHERE cm.user_id = $1${approvedWhere}
            AND c.meeting_id IS NOT NULL
       ),
       participant_meetings AS (
         SELECT m.*, CASE WHEN m.creator_id = $1 THEN 'owner' ELSE 'participant' END::text AS role
           FROM meetings m
          WHERE m.id IN (SELECT meeting_id FROM participant_ids)
       ),
       merged AS (
         SELECT * FROM owned
         UNION
         SELECT * FROM participant_meetings
       )
       SELECT merged.*, ${creatorJsonSql}
         FROM merged
         LEFT JOIN profiles p ON p.id = merged.creator_id
        ORDER BY COALESCE(merged.created_at, merged.updated_at, now()) DESC`,
      [userId]
    );

    const rows = (result.rows || []).map(row => {
      const creator = row.creator_profile ? normalizeProfilesRows([row.creator_profile])[0] : null;
      const item = { ...row, creator };
      delete item.creator_profile;
      return item;
    });

    return res.json({ meetings: rows });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to build my-events summary' });
  }
});

app.get('/api/profiles/:userId', async (req, res) => {
  try {
    const userId = req.params.userId;
    const rows = await selectRows('profiles', { id: userId });
    const normalized = normalizeProfilesRows(rows);
    return res.json(normalized[0] || null);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed' });
  }
});

app.get('/api/chats/summary', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const hasStatus = await tableHasColumn('chat_members', 'status');
    const membershipWhere = hasStatus ? ` AND cm.status = 'approved'` : '';
    const peerWhere = hasStatus ? ` AND peer_cm.status = 'approved'` : '';
    const profileColumns = await getTableColumns('profiles');
    const peerJsonFields = [
      'id',
      'username',
      'full_name',
      'age',
      'location',
      'city',
      'about',
      'bio',
      'description',
      'photo_url'
    ].filter(column => profileColumns.has(column));
    const peerJsonSql = peerJsonFields.length > 0
      ? `jsonb_build_object(${peerJsonFields.map(column => `'${column}', peer."${column}"`).join(', ')}) AS peer_profile`
      : `NULL::jsonb AS peer_profile`;

    const summarySql = `
      WITH my_memberships AS (
        SELECT DISTINCT cm.chat_id
          FROM chat_members cm
         WHERE cm.user_id = $1${membershipWhere}
      ),
      visible_chats AS (
        SELECT c.*
          FROM chats c
         WHERE c.id IN (SELECT chat_id FROM my_memberships)
            OR c.owner_id = $1
      ),
      last_messages AS (
        SELECT DISTINCT ON (m.chat_id)
               m.chat_id,
               m.id,
               m.user_id,
               m.content,
               m.created_at
          FROM chat_messages m
          JOIN visible_chats vc ON vc.id = m.chat_id
         ORDER BY m.chat_id, m.created_at DESC, m.id DESC
      ),
      direct_peers AS (
        SELECT DISTINCT ON (peer_cm.chat_id)
               peer_cm.chat_id,
               peer_cm.user_id AS peer_id
          FROM chat_members peer_cm
          JOIN visible_chats vc ON vc.id = peer_cm.chat_id
         WHERE peer_cm.user_id <> $1${peerWhere}
         ORDER BY peer_cm.chat_id, peer_cm.user_id
      )
      SELECT
        vc.*,
        lm.id AS last_message_id,
        lm.user_id AS last_message_user_id,
        lm.content AS last_message_content,
        lm.created_at AS last_message_created_at,
        COALESCE(lm.created_at, vc.created_at) AS last_activity_at,
        ${peerJsonSql}
      FROM visible_chats vc
      LEFT JOIN last_messages lm ON lm.chat_id = vc.id
      LEFT JOIN direct_peers dp ON dp.chat_id = vc.id
      LEFT JOIN profiles peer ON peer.id = dp.peer_id
      ORDER BY COALESCE(lm.created_at, vc.created_at) DESC, vc.created_at DESC
    `;

    const result = await query(summarySql, [userId]);
    const rows = (result.rows || []).map(row => {
      const rawPeerProfile = row.peer_profile && typeof row.peer_profile === 'object'
        ? row.peer_profile
        : null;
      const peerProfile = rawPeerProfile
        ? normalizeProfilesRows([rawPeerProfile])[0]
        : null;

      const summary = {
        ...row,
        __lastActivityAt: row.last_activity_at || row.created_at || null,
        __lastMessage: row.last_message_id ? {
          id: row.last_message_id,
          user_id: row.last_message_user_id,
          content: row.last_message_content,
          created_at: row.last_message_created_at
        } : null,
        __peerProfile: peerProfile,
        __displayTitle: row.meeting_id
          ? (row.title || 'Чат встречи')
          : (peerProfile?.full_name || peerProfile?.username || row.title || 'Личный чат')
      };

      delete summary.last_message_id;
      delete summary.last_message_user_id;
      delete summary.last_message_content;
      delete summary.last_message_created_at;
      delete summary.last_activity_at;
      delete summary.peer_profile;

      return summary;
    });

    return res.json({ chats: rows });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to build chats summary' });
  }
});

app.get('/api/events/stream', requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  addEventClient(req.user.id, res);
  res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);

  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_e) {
      clearInterval(keepAlive);
      removeEventClient(req.user.id, res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    removeEventClient(req.user.id, res);
  });
});

app.post('/api/chats/:chatId/messages', requireAuth, async (req, res) => {
  try {
    const chatId = String(req.params.chatId || '');
    const content = String(req.body?.content || '').trim();
    const actorId = req.body?.actor_id ? String(req.body.actor_id) : null;
    if (!chatId || !content) {
      return res.status(400).json({ error: 'Missing chat_id or content' });
    }

    const allowed = await ensureChatAccess(chatId, req.user.id);
    if (!allowed) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const insertedRows = await insertRow('chat_messages', {
      chat_id: chatId,
      user_id: actorId || req.user.id,
      content
    });
    const inserted = insertedRows[0] || null;
    let message = inserted;
    if (inserted?.id) {
      const senderJsonSql = await buildProfileJsonObjectSql('p');
      const messageResult = await query(
        `SELECT m.*, ${senderJsonSql} AS sender_profile
           FROM chat_messages m
           LEFT JOIN profiles p ON p.id = m.user_id
          WHERE m.id = $1
          LIMIT 1`,
        [inserted.id]
      );
      message = (messageResult.rows || [])[0] || inserted;
    }
    if (message) {
      await broadcastToChat(chatId, 'chat_message', {
        chat_id: chatId,
        message
      });
    }
    return res.json(message);
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Failed to send message' });
  }
});

app.get('/api/chats/:chatId/messages', requireAuth, async (req, res) => {
  try {
    const chatId = String(req.params.chatId || '');
    const before = String(req.query.before || '').trim();
    const after = String(req.query.after || '').trim();
    const limitRaw = Number(req.query.limit || 50);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 50;

    if (!chatId) {
      return res.status(400).json({ error: 'Missing chatId' });
    }

    const allowed = await ensureChatAccess(chatId, req.user.id);
    if (!allowed) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const params = [chatId];
    const conditions = ['chat_id = $1'];

    if (before) {
      params.push(before);
      conditions.push(`created_at < $${params.length}`);
    }
    if (after) {
      params.push(after);
      conditions.push(`created_at > $${params.length}`);
    }

    params.push(limit + 1);
    const senderJsonSql = await buildProfileJsonObjectSql('p');
    const sql = `
      SELECT m.*, ${senderJsonSql} AS sender_profile
        FROM chat_messages m
        LEFT JOIN profiles p ON p.id = m.user_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT $${params.length}
    `;
    const result = await query(sql, params);
    const rows = result.rows || [];
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const messages = sliced.reverse();

    return res.json({
      messages,
      has_more: hasMore
    });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Failed to load messages' });
  }
});

app.post('/api/chats/unread-summary', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const lastReadMap = req.body && typeof req.body.lastReadMap === 'object' && req.body.lastReadMap
      ? req.body.lastReadMap
      : {};

    const hasStatus = await tableHasColumn('chat_members', 'status');
    const membershipWhere = hasStatus ? ` AND status = 'approved'` : '';
    const membershipsResult = await query(
      `SELECT DISTINCT chat_id
         FROM chat_members
        WHERE user_id = $1${membershipWhere}`,
      [userId]
    );
    const chatIds = Array.from(new Set((membershipsResult.rows || []).map(row => row.chat_id).filter(Boolean)));

    if (chatIds.length === 0) {
      return res.json({ total: 0, counts: {} });
    }

    const params = [userId, chatIds];
    const lastReads = chatIds.map(id => lastReadMap[id] || null);
    const countsResult = await query(
      `SELECT x.chat_id AS chat_id,
              COUNT(m.*) AS count
         FROM unnest($1::uuid[], $2::timestamptz[]) AS x(chat_id, last_read)
         LEFT JOIN chat_messages m
           ON m.chat_id = x.chat_id
          AND m.user_id <> $3
          AND (x.last_read IS NULL OR m.created_at > x.last_read)
        GROUP BY x.chat_id`,
      [chatIds, lastReads, userId]
    );

    const counts = {};
    for (const row of countsResult.rows || []) {
      counts[row.chat_id] = Number(row.count || 0);
    }
    for (const chatId of chatIds) {
      if (!Object.prototype.hasOwnProperty.call(counts, chatId)) {
        counts[chatId] = 0;
      }
    }

    const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
    return res.json({ total, counts });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to build unread summary' });
  }
});

app.get('/api/my-events/notifications', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const limitRaw = Number(req.query.limit || 20);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 20;
    const types = ['event_join_request', 'event_join_approved', 'event_join_rejected', 'event_joined_direct'];

    const notificationsRows = await selectRows('notifications', {
      admin_profile_id: userId,
      notification_type: { in: types },
      $order: { column: 'created_at', ascending: false },
      $limit: limit
    });

    const meetingIds = Array.from(new Set(
      (notificationsRows || [])
        .filter(item => item.related_table === 'meetings' && item.related_id)
        .map(item => item.related_id)
    ));

    const meetingRows = meetingIds.length > 0
      ? await selectRows('meetings', { id: { in: meetingIds } })
      : [];
    const meetingsById = new Map((meetingRows || []).map(meeting => [meeting.id, meeting]));

    const requestMeetings = (notificationsRows || [])
      .filter(item => item.notification_type === 'event_join_request')
      .map(item => meetingsById.get(item.related_id))
      .filter(meeting => meeting?.id && meeting?.chat_id);

    const requestMeetingIds = new Set(requestMeetings.map(meeting => meeting.id));
    const requestChatIds = Array.from(new Set(requestMeetings.map(meeting => meeting.chat_id)));
    let pendingByMeetingId = new Map();

    if (requestChatIds.length > 0) {
      const pendingRows = await selectRows('chat_members', {
        chat_id: { in: requestChatIds },
        status: 'pending'
      });
      const profileIds = Array.from(new Set((pendingRows || []).map(row => row.user_id).filter(Boolean)));
      const profiles = profileIds.length > 0 ? await selectRows('profiles', { id: { in: profileIds } }) : [];
      const profilesById = new Map(normalizeProfilesRows(profiles || []).map(profile => [profile.id, profile]));
      const meetingIdByChatId = new Map(requestMeetings.map(meeting => [meeting.chat_id, meeting.id]));

      pendingByMeetingId = new Map(Array.from(requestMeetingIds).map(meetingId => [meetingId, []]));
      (pendingRows || []).forEach(row => {
        const meetingId = meetingIdByChatId.get(row.chat_id);
        if (!meetingId) return;
        const profile = profilesById.get(row.user_id) || null;
        const pending = pendingByMeetingId.get(meetingId) || [];
        pending.push({
          membershipId: row.id,
          userId: row.user_id,
          createdAt: row.created_at || null,
          profile,
          displayName: getProfileDisplayNameServer(profile, row.user_id)
        });
        pendingByMeetingId.set(meetingId, pending);
      });
    }

    const notifications = (notificationsRows || []).map(notification => {
      const meeting = meetingsById.get(notification.related_id) || null;
      const pendingRequests = meeting?.id ? (pendingByMeetingId.get(meeting.id) || []) : [];
      const resolvedRequest = notification.notification_type === 'event_join_request'
        ? resolveNotificationRequestServer(notification, pendingRequests)
        : null;
      return {
        ...notification,
        meeting,
        pendingRequests,
        resolvedRequest
      };
    });

    return res.json({ notifications });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to build notifications summary' });
  }
});

// Auth endpoints (session cookie)
app.get('/api/auth/me', async (req, res) => {
  if (!req.user) return res.json(null);
  return res.json(req.user);
});

app.post('/api/auth/signup', async (req, res) => {
  try {
    const {
      email,
      password,
      username,
      full_name,
      age,
      sex,
      location,
      photo_url,
      interests,
      about,
      role,
      blocked_users
    } = req.body || {};
    const profile = await createProfileUser(email, password, {
      username,
      full_name,
      age,
      sex,
      location,
      photo_url,
      interests,
      about,
      role,
      blocked_users
    });

    const verificationCode = await createEmailVerification(profile.id, profile.email);
    const confirmUrl = createPublicUrl(`/login.html?confirm_token=${encodeURIComponent(verificationCode)}`);
    const mailResult = await sendEmail(buildEmailConfirmationMessage({
      to: profile.email,
      fullName: profile.full_name,
      confirmUrl
    }));

    return res.status(201).json({
      ok: true,
      requires_email_confirmation: true,
      delivery: mailResult.transport
    });
  } catch (e) {
    // Unique email constraint
    const msg = String(e && e.message ? e.message : '');
    if (msg.includes('unique') || msg.includes('duplicate')) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    return res.status(400).json({ error: e.message || 'Signup failed' });
  }
});

app.post('/api/auth/login', enforceLoginRateLimit, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const profile = await findProfileByEmail(email);
    if (!profile) {
      registerFailedLoginAttempt(req.loginRateLimitKey);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!profile.email_verified_at) {
      return res.status(403).json({ error: 'Please confirm your email before logging in' });
    }

    const ok = await bcrypt.compare(String(password || ''), profile.password_hash || '');
    if (!ok) {
      registerFailedLoginAttempt(req.loginRateLimitKey);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const session = await createSession(profile.id);
    clearLoginRateLimit(req.loginRateLimitKey);
    await query('UPDATE profiles SET last_login = now() WHERE id = $1', [profile.id]);

    setSessionCookie(res, session);
    // req.user will be set on next request; return sanitized profile now
    const { password_hash, ...safe } = profile;
    return res.json({ user: safe });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Login failed' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const token = req.cookies && req.cookies[process.env.SESSION_COOKIE_NAME || 'sid'];
    await deleteSession(token);
    clearSessionCookie(res);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Logout failed' });
  }
});

app.post('/api/auth/confirm', async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Missing token' });
    const userId = await consumeEmailVerification(token);
    if (!userId) return res.status(400).json({ error: 'Invalid or expired confirmation link' });
    await markEmailVerified(userId);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Confirmation failed' });
  }
});

app.post('/api/auth/resend-verification', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required' });

    const profile = await findProfileByEmail(email);
    if (profile && !profile.email_verified_at) {
      const verificationCode = await createEmailVerification(profile.id, profile.email);
      const confirmUrl = createPublicUrl(`/login.html?confirm_token=${encodeURIComponent(verificationCode)}`);
      await sendEmail(buildEmailConfirmationMessage({
        to: profile.email,
        fullName: profile.full_name,
        confirmUrl
      }));
    }

    return res.json({
      ok: true,
      message: 'If this email exists, verification instructions were sent'
    });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Could not resend verification email' });
  }
});

app.post('/api/auth/request-password-reset', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email required' });

    const profile = await findProfileByEmail(email);
    if (profile && profile.email_verified_at) {
      const resetToken = await createPasswordResetToken(profile.id);
      const resetUrl = createPublicUrl(`/reset-password.html?token=${encodeURIComponent(resetToken)}`);
      await sendEmail(buildPasswordResetMessage({
        to: profile.email,
        fullName: profile.full_name,
        resetUrl
      }));
    }

    return res.json({
      ok: true,
      message: 'If this email exists, password reset instructions were sent'
    });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Could not send reset email' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const token = String(req.body?.token || '').trim();
    const password = String(req.body?.password || '');
    if (!token) return res.status(400).json({ error: 'Missing token' });
    await resetPasswordWithToken(token, password);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Password reset failed' });
  }
});

// Update current user's profile (expects JSON body with fields to patch)
app.put('/api/users/profile', requireAuth, async (req, res) => {
  try {
    const updated = await updateProfile(req.user.id, req.body || {});
    return res.json(updated);
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Update failed' });
  }
});

// Typing indicator (polling-friendly)
app.post('/api/typing', requireAuth, async (req, res) => {
  const { chat_id, is_typing } = req.body || {};
  if (!chat_id) return res.status(400).json({ error: 'Missing chat_id' });
  const chatId = String(chat_id);
  const userId = String(req.user.id);

  if (!typingState.has(chatId)) typingState.set(chatId, new Map());
  const perChat = typingState.get(chatId);
  if (is_typing === false) {
    perChat.delete(userId);
    await broadcastToChat(chatId, 'typing', { chat_id: chatId, user_id: userId, is_typing: false });
    return res.json({ ok: true });
  }
  perChat.set(userId, Date.now() + TYPING_TTL_MS);
  await broadcastToChat(chatId, 'typing', { chat_id: chatId, user_id: userId, is_typing: true });
  return res.json({ ok: true });
});

app.get('/api/typing', requireAuth, async (req, res) => {
  const chatId = String(req.query.chat_id || '');
  if (!chatId) return res.status(400).json({ error: 'Missing chat_id' });
  const perChat = typingState.get(chatId) || new Map();
  const now = Date.now();
  const active = [];
  for (const [userId, expiresAt] of perChat.entries()) {
    if (expiresAt > now) {
      if (userId !== String(req.user.id)) active.push(userId);
    } else {
      perChat.delete(userId);
    }
  }
  return res.json({ user_ids: active });
});

// Upload endpoints (multipart/form-data)
app.post('/api/upload/avatar', requireAuth, uploader('avatars').single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Missing file' });
  return res.json({ url: `/uploads/avatars/${req.file.filename}` });
});

app.post('/api/upload/chat-image', requireAuth, uploader('chat').single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Missing file' });
  return res.json({ url: `/uploads/chat/${req.file.filename}` });
});

// JSON errors for API
app.use('/api', (err, _req, res, _next) => {
  if (err?.name === 'MulterError' && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Файл слишком большой' });
  }
  if (err?.statusCode) {
    return res.status(err.statusCode).json({ error: err.message || 'Request failed' });
  }
  return res.status(500).json({ error: err && err.message ? err.message : 'Server error' });
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

cleanupExpiredMeetingsServer()
  .then((result) => {
    if (result.deleted > 0) {
      console.log(`Expired meetings cleanup: deleted ${result.deleted}`);
    }
  })
  .catch((error) => {
    console.error('Expired meetings cleanup failed on startup:', error.message || error);
  });

setInterval(() => {
  cleanupExpiredMeetingsServer().catch((error) => {
    console.error('Expired meetings cleanup failed:', error.message || error);
  });
}, EXPIRED_MEETINGS_CLEANUP_INTERVAL_MS);
