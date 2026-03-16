const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const { selectRows, insertRow, updateRow, deleteRow } = require('./query');
const { createProfileUser, findProfileByEmail, createSession, deleteSession, setSessionCookie, clearSessionCookie, authMiddleware, requireAuth, updateProfile } = require('./auth');
const { uploader, getUploadRoot } = require('./uploads');
const bcrypt = require('bcryptjs');

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(authMiddleware);

// Serve uploads and frontend from the project root so js/api.js can call `/api/*` same-origin.
app.use('/uploads', express.static(getUploadRoot()));
app.use(express.static(path.resolve(__dirname, '..', '..')));

app.post('/api/query', async (req, res) => {
  try {
    const { table, action, data, filters } = req.body || {};
    if (action === 'select') {
      const rows = await selectRows(table, filters);
      return res.json(rows);
    }
    if (action === 'insert') {
      const rows = await insertRow(table, data);
      return res.json(rows);
    }
    if (action === 'update') {
      const rows = await updateRow(table, data);
      return res.json(rows);
    }
    if (action === 'delete') {
      const rows = await deleteRow(table, data);
      return res.json(rows);
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(400).json({ error: e.message || 'Bad request' });
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
    return res.json(rows[0] || null);
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

// Upload endpoints (multipart/form-data)
app.post('/api/upload/avatar', uploader('avatars').single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Missing file' });
  return res.json({ url: `/uploads/avatars/${req.file.filename}` });
});

app.post('/api/upload/chat-image', uploader('chat').single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Missing file' });
  return res.json({ url: `/uploads/chat/${req.file.filename}` });
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
