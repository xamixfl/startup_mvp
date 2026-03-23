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

function normalizeProfilesRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(row => {
    if (!row || typeof row !== 'object') return row;
    if (row.photo_url && !row.photo_URL) {
      row.photo_URL = row.photo_url;
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
    return res.json({ ok: true });
  }
  perChat.set(userId, Date.now() + TYPING_TTL_MS);
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
