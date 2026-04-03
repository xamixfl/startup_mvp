const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('./db');

function isSafeIdentifier(value) {
  return typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);
}

function getCookieName() {
  return process.env.SESSION_COOKIE_NAME || 'sid';
}

function sessionTtlDays() {
  const raw = process.env.SESSION_TTL_DAYS || '14';
  const days = Number(raw);
  return Number.isFinite(days) && days > 0 ? days : 14;
}

function shouldUseSecureCookies() {
  const raw = process.env.COOKIE_SECURE;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

function generateUuid() {
  // Node 16+ supports crypto.randomUUID(). Keep a safe fallback for older runtimes.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function createProfileUser(email, password, extra = {}) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new Error('Email required');
  if (String(password || '').length < 6) throw new Error('Password too short');
  const passwordHash = await bcrypt.hash(String(password), 10);
  const username = extra && typeof extra.username === 'string' ? extra.username.trim() : null;
  const fullName = extra && typeof extra.full_name === 'string' ? extra.full_name.trim() : null;
  const id = generateUuid();

  // profiles schema is project-specific; we only set fields that are expected to exist.
  const result = await query(
    'INSERT INTO profiles (id, email, password_hash, username, full_name, last_login) VALUES ($1, $2, $3, $4, $5, now()) RETURNING *',
    [id, normalized, passwordHash, username || null, fullName || null]
  );
  return sanitizeProfile(result.rows[0] || null);
}

async function findProfileByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const result = await query(
    'SELECT * FROM profiles WHERE email = $1',
    [normalized]
  );
  return result.rows[0] || null;
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + sessionTtlDays() * 24 * 60 * 60 * 1000);
  const result = await query(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3) RETURNING token, expires_at',
    [userId, token, expiresAt.toISOString()]
  );
  return result.rows[0];
}

async function deleteSession(token) {
  if (!token) return;
  await query('DELETE FROM sessions WHERE token = $1', [token]);
}

async function getSessionProfile(token) {
  if (!token) return null;
  const result = await query(
    'SELECT p.* FROM sessions s JOIN profiles p ON p.id = s.user_id WHERE s.token = $1 AND s.expires_at > now()',
    [token]
  );
  return sanitizeProfile(result.rows[0] || null);
}

function setSessionCookie(res, session) {
  const cookieName = getCookieName();
  res.cookie(cookieName, session.token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureCookies(),
    expires: new Date(session.expires_at)
  });
}

function clearSessionCookie(res) {
  res.clearCookie(getCookieName(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: shouldUseSecureCookies()
  });
}

async function authMiddleware(req, _res, next) {
  try {
    const token = req.cookies && req.cookies[getCookieName()];
    const profile = await getSessionProfile(token);
    req.user = profile;
    next();
  } catch (e) {
    // Don't break read-only endpoints (topics/feed) when auth tables are not migrated yet.
    // Example: relation "sessions" does not exist (42P01) during initial setup.
    if (e && e.code === '42P01') {
      req.user = null;
      return next();
    }
    next(e);
  }
}

function sanitizeProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const { password_hash, ...rest } = profile;
  // Keep backward compatibility with legacy frontend field naming.
  // DB schemas often use snake_case (`photo_url`), while the frontend expects `photo_URL`.
  if (rest.photo_url && !rest.photo_URL) {
    rest.photo_URL = rest.photo_url;
  }
  // Older schemas used `city`, while the current frontend expects `location`.
  if (rest.city && !rest.location) {
    rest.location = rest.city;
  }
  // Frontend prefers `about`, but DB schemas vary (`bio`, `description`).
  if (!rest.about) {
    if (rest.bio) rest.about = rest.bio;
    else if (rest.description) rest.about = rest.description;
  }
  return rest;
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  return next();
}

async function updateProfile(userId, patch) {
  if (!userId) throw new Error('Missing userId');
  if (!patch || typeof patch !== 'object') throw new Error('Invalid patch');
  if ('password_hash' in patch) delete patch.password_hash;
  if ('email' in patch) {
    patch.email = String(patch.email || '').trim().toLowerCase();
  }
  const columns = await getProfilesColumns();

  // Work on a copy so we can safely remap/strip keys.
  const normalized = { ...patch };

  // Accept legacy camelCase-ish field from frontend and map to common DB column.
  if ('photo_URL' in normalized && !('photo_url' in normalized)) {
    normalized.photo_url = normalized.photo_URL;
    delete normalized.photo_URL;
  }

  // Map frontend `location` to legacy DB column `city` when needed.
  if ('location' in normalized && !columns.has('location') && columns.has('city')) {
    normalized.city = normalized.location;
    delete normalized.location;
  }

  // Map frontend `about` to an existing DB column when needed.
  if ('about' in normalized && !columns.has('about')) {
    if (columns.has('bio') && !('bio' in normalized)) {
      normalized.bio = normalized.about;
    } else if (columns.has('description') && !('description' in normalized)) {
      normalized.description = normalized.about;
    }
    delete normalized.about;
  }

  // Only update columns that actually exist in `profiles` and have safe identifiers.
  const keys = Object.keys(normalized)
    .filter(k => normalized[k] !== undefined)
    .filter(k => isSafeIdentifier(k))
    .filter(k => columns.has(k));

  if (keys.length === 0) {
    const current = await query('SELECT * FROM profiles WHERE id = $1', [userId]);
    return sanitizeProfile(current.rows[0] || null);
  }

  const params = [];
  const setSql = keys.map(key => {
    params.push(normalized[key]);
    return `"${key}" = $${params.length}`;
  }).join(', ');
  params.push(userId);
  const result = await query(`UPDATE profiles SET ${setSql} WHERE id = $${params.length} RETURNING *`, params);
  return sanitizeProfile(result.rows[0] || null);
}

let _profilesColumnsCache = { at: 0, set: null };
async function getProfilesColumns() {
  const now = Date.now();
  if (_profilesColumnsCache.set && (now - _profilesColumnsCache.at) < 5 * 60 * 1000) {
    return _profilesColumnsCache.set;
  }
  const res = await query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles'"
  );
  const set = new Set((res.rows || []).map(r => r.column_name).filter(Boolean));
  _profilesColumnsCache = { at: now, set };
  return set;
}

module.exports = {
  createProfileUser,
  findProfileByEmail,
  createSession,
  deleteSession,
  setSessionCookie,
  clearSessionCookie,
  authMiddleware,
  requireAuth,
  updateProfile
};
