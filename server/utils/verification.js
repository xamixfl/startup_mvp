const crypto = require('crypto');

const VERIFICATION_SALT = process.env.VERIFICATION_SALT || 'default_salt';
const PENDING_REGISTRATION_SECRET = process.env.PENDING_REGISTRATION_SECRET || VERIFICATION_SALT;
const PENDING_REGISTRATION_TTL_MS = Number(process.env.PENDING_REGISTRATION_TTL_MS || (24 * 60 * 60 * 1000));

function generateVerificationCode(userId, email) {
  return crypto.createHash('md5')
    .update(userId + email + VERIFICATION_SALT)
    .digest('hex');
}

function toBase64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64UrlBuffer(value) {
  const normalized = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, 'base64');
}

function signPendingRegistration(payload, options = {}) {
  const ttlMs = Number(options.ttlMs);
  const expiresIn = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : PENDING_REGISTRATION_TTL_MS;
  const envelope = {
    type: 'pending_registration',
    exp: Date.now() + expiresIn,
    payload
  };
  const key = crypto.createHash('sha256').update(PENDING_REGISTRATION_SECRET).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(envelope), 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();
  return [
    toBase64Url(iv),
    toBase64Url(encrypted),
    toBase64Url(authTag)
  ].join('.');
}

function verifyPendingRegistrationToken(token) {
  const [ivEncoded, encryptedEncoded, authTagEncoded] = String(token || '').split('.');
  if (!ivEncoded || !encryptedEncoded || !authTagEncoded) return null;

  try {
    const key = crypto.createHash('sha256').update(PENDING_REGISTRATION_SECRET).digest();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      fromBase64UrlBuffer(ivEncoded)
    );
    decipher.setAuthTag(fromBase64UrlBuffer(authTagEncoded));
    const decrypted = Buffer.concat([
      decipher.update(fromBase64UrlBuffer(encryptedEncoded)),
      decipher.final()
    ]).toString('utf8');
    const parsed = JSON.parse(decrypted);
    if (parsed?.type !== 'pending_registration' || !parsed?.payload) return null;
    if (!Number.isFinite(parsed.exp) || parsed.exp < Date.now()) return null;
    return parsed.payload;
  } catch (_error) {
    return null;
  }
}

module.exports = {
  generateVerificationCode,
  signPendingRegistration,
  verifyPendingRegistrationToken
};
