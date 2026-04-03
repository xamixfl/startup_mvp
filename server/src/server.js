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
const { createProfileUser, findProfileByEmail, createSession, deleteSession, setSessionCookie, clearSessionCookie, authMiddleware, requireAuth, updateProfile } = require('./auth');
const { uploader, getUploadRoot } = require('./uploads');
const { query } = require('./db');
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
app.get('/api/db-health', async (_req, res) => {
  try {
    await query('select 1 as ok');
    return res.json({ ok: true, db: true });
  } catch (e) {
    return res.status(500).json({ ok: false, db: false, error: e.message || 'DB error', code: e.code });
  }
});

// Quick diagnostic for topics table.
app.get('/api/debug/topics', async (_req, res) => {
  try {
    const countRes = await query('select count(*)::int as count from topics');
    const listRes = await query('select * from topics order by 1 asc limit 5');
    return res.json({ ok: true, count: countRes.rows[0]?.count || 0, sample: listRes.rows || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'DB error', code: e.code, detail: e.detail });
  }
});

app.post('/api/maintenance/cleanup-expired-meetings', async (_req, res) => {
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
    const normalizedData = normalizeQueryPayload(table, data);
    if (action === 'select') {
      const rows = await selectRows(table, filters);
      return res.json(table === 'profiles' ? normalizeProfilesRows(rows) : rows);
    }
    if (action === 'count') {
      const rows = await selectRows(table, filters);
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
      const rows = await deleteRow(table, normalizedData);
      return res.json(table === 'profiles' ? normalizeProfilesRows(rows) : rows);
    }
    if (action === 'deleteWhere') {
      const rows = await deleteWhere(table, filters);
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
    const messagesResult = await query(
      `SELECT chat_id, created_at
         FROM chat_messages
        WHERE chat_id = ANY($2::uuid[])
          AND user_id <> $1`,
      params
    );

    const counts = {};
    for (const chatId of chatIds) {
      counts[chatId] = 0;
    }

    for (const row of messagesResult.rows || []) {
      const chatId = row.chat_id;
      const lastRead = lastReadMap[chatId];
      if (!lastRead || new Date(row.created_at).getTime() > new Date(lastRead).getTime()) {
        counts[chatId] = (counts[chatId] || 0) + 1;
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
    const { email, password, username, full_name } = req.body || {};
    const profile = await createProfileUser(email, password, { username, full_name });
    const session = await createSession(profile.id);
    setSessionCookie(res, session);
    return res.json({ user: profile });
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
    const ok = await bcrypt.compare(String(password || ''), profile.password_hash || '');
    if (!ok) {
      registerFailedLoginAttempt(req.loginRateLimitKey);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const session = await createSession(profile.id);
    clearLoginRateLimit(req.loginRateLimitKey);
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
