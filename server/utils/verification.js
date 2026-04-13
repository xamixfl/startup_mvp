const crypto = require('crypto');

const VERIFICATION_SALT = process.env.VERIFICATION_SALT || 'default_salt';

function generateVerificationCode(userId, email) {
  return crypto.createHash('md5')
    .update(userId + email + VERIFICATION_SALT)
    .digest('hex');
}

module.exports = { generateVerificationCode };
