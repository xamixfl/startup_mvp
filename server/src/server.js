const path = require('path');
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

// Minimal in-memory typing state: { chatId -> { userId -> expiresAtMs } }
const typingState = new Map();
const TYPING_TTL_MS = 3500;
const schemaColumnCache = new Map();
const eventClients = new Map();
const EXPIRED_MEETINGS_CLEANUP_INTERVAL_MS = 60 * 1000;

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

// Serve uploads and frontend from the project root so js/api.js can call `/api/*` same-origin.
// Note: `express.static` returns 404 for directory requests like `/uploads/` (no index, no listing).
// Provide a small health response for that exact path to reduce confusion during debugging.
app.get(['/uploads', '/uploads/'], (_req, res) => res.status(200).json({ ok: true }));
app.use('/uploads', express.static(getUploadRoot()));
app.use(express.static(path.resolve(__dirname, '..', '..')));

// Only API routes need auth/session lookup. Static assets/pages must not depend on DB.
app.use('/api', authMiddleware);

app.get('/api/health', async (_req, res) => {
  return res.json({ ok: true });
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
    const profileColumns = await getTableColumns('profiles');
    const creatorJsonFields = [
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
    const creatorJsonSql = creatorJsonFields.length > 0
      ? `jsonb_build_object(${creatorJsonFields.map(column => `'${column}', p."${column}"`).join(', ')}) AS creator_profile`
      : `NULL::jsonb AS creator_profile`;

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

    const rows = await insertRow('chat_messages', {
      chat_id: chatId,
      user_id: actorId || req.user.id,
      content
    });
    const message = rows[0] || null;
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

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const profile = await findProfileByEmail(email);
    if (!profile) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(String(password || ''), profile.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const session = await createSession(profile.id);
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
app.post('/api/upload/avatar', uploader('avatars').single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Missing file' });
  return res.json({ url: `/uploads/avatars/${req.file.filename}` });
});

app.post('/api/upload/chat-image', uploader('chat').single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Missing file' });
  return res.json({ url: `/uploads/chat/${req.file.filename}` });
});

// JSON errors for API
app.use('/api', (err, _req, res, _next) => {
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
