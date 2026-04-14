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

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

async function createProfileUser(email, password, extra = {}) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) throw new Error('Email required');
  if (String(password || '').length < 6) throw new Error('Password too short');
  const passwordHash = await bcrypt.hash(String(password), 10);
  const columns = await getProfilesColumns();
  const payload = buildProfilePayload({
    email: normalized,
    password_hash: passwordHash,
    last_login: null,
    username: extra.username,
    full_name: extra.full_name,
    age: extra.age,
    sex: extra.sex,
    location: extra.location,
    city: extra.location,
    photo_url: extra.photo_url,
    interests: extra.interests,
    about: extra.about,
    bio: extra.about,
    description: extra.about,
    role: extra.role,
    blocked_users: extra.blocked_users,
    email_verified_at: null
  }, columns);
  const id = generateUuid();
  payload.id = id;

  const keys = Object.keys(payload);
  const values = keys.map(key => payload[key]);
  const columnsSql = keys.map(key => `"${key}"`).join(', ');
  const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ');
  const result = await query(
    `INSERT INTO profiles (${columnsSql}) VALUES (${placeholders}) RETURNING *`,
    values
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


const { generateVerificationCode } = require('../utils/verification');

async function createEmailVerification(userId, email) {
  await query('DELETE FROM email_verifications WHERE user_id = $1', [userId]);
  const verificationCode = generateVerificationCode(userId, email);
  await query(
    `INSERT INTO email_verifications (user_id, verification_code)
     VALUES ($1, $2)`,
    [userId, verificationCode]
  );
  return verificationCode;
}

async function consumeEmailVerification(verificationCode) {
  const result = await query(
    `DELETE FROM email_verifications
     WHERE verification_code = $1
     RETURNING user_id`,
    [verificationCode]
  );
  return result.rows[0]?.user_id || null;
}

async function createPasswordResetToken(userId) {
  await query('DELETE FROM password_reset_tokens WHERE user_id = $1', [userId]);
  const token = generateToken();
  const tokenHash = hashToken(token);
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + interval '2 hours')`,
    [userId, tokenHash]
  );
  return token;
}

async function resetPasswordWithToken(token, newPassword) {
  if (String(newPassword || '').length < 6) throw new Error('Password too short');
  const tokenHash = hashToken(token);
  const tokenResult = await query(
    `DELETE FROM password_reset_tokens
     WHERE token_hash = $1
       AND expires_at > now()
     RETURNING user_id`,
    [tokenHash]
  );
  const userId = tokenResult.rows[0]?.user_id;
  if (!userId) throw new Error('Invalid or expired reset link');

  const passwordHash = await bcrypt.hash(String(newPassword), 10);
  await query('UPDATE profiles SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  return userId;
}

async function markEmailVerified(userId) {
  const result = await query(
    'UPDATE profiles SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1 RETURNING *',
    [userId]
  );
  return sanitizeProfile(result.rows[0] || null);
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

function canUseColumn(columns, name) {
  return isSafeIdentifier(name) && columns.has(name);
}

function buildProfilePayload(input, columns) {
  const payload = {};
  if (!input || typeof input !== 'object') return payload;

  if (canUseColumn(columns, 'email')) payload.email = String(input.email || '').trim().toLowerCase();
  if (canUseColumn(columns, 'password_hash')) payload.password_hash = input.password_hash;
  if (canUseColumn(columns, 'last_login')) payload.last_login = input.last_login;
  if (canUseColumn(columns, 'username')) payload.username = typeof input.username === 'string' ? input.username.trim() : null;
  if (canUseColumn(columns, 'full_name')) payload.full_name = typeof input.full_name === 'string' ? input.full_name.trim() : null;
  if (canUseColumn(columns, 'age') && input.age !== undefined) payload.age = input.age === null ? null : String(input.age);
  if (canUseColumn(columns, 'sex') && input.sex !== undefined) payload.sex = input.sex || null;
  if (canUseColumn(columns, 'location') && input.location !== undefined) payload.location = input.location || null;
  if (canUseColumn(columns, 'city') && input.city !== undefined) payload.city = input.city || null;
  if (canUseColumn(columns, 'photo_url') && input.photo_url !== undefined) payload.photo_url = input.photo_url || null;
  if (canUseColumn(columns, 'interests') && input.interests !== undefined) payload.interests = input.interests || [];
  if (canUseColumn(columns, 'about') && input.about !== undefined) payload.about = input.about || null;
  if (canUseColumn(columns, 'bio') && input.bio !== undefined) payload.bio = input.bio || null;
  if (canUseColumn(columns, 'description') && input.description !== undefined) payload.description = input.description || null;
  if (canUseColumn(columns, 'role') && input.role !== undefined) payload.role = input.role || null;
  if (canUseColumn(columns, 'blocked_users') && input.blocked_users !== undefined) payload.blocked_users = input.blocked_users || [];
  if (canUseColumn(columns, 'email_verified_at') && 'email_verified_at' in input) payload.email_verified_at = input.email_verified_at;

  return payload;
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
};
