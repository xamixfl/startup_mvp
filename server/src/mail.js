const https = require('https');

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function getSmtpConfig() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();
  const from = String(process.env.SMTP_FROM || process.env.EMAIL_FROM || user).trim();

  if (!host || !user || !pass) return null;

  const port = Number(process.env.SMTP_PORT || 465);
  const secure = parseBoolean(process.env.SMTP_SECURE, port === 465);

  return {
    host,
    port,
    secure,
    user,
    pass,
    from
  };
}

function getBaseUrl() {
  return (
    process.env.APP_BASE_URL
    || process.env.PUBLIC_APP_URL
    || `http://localhost:${process.env.PORT || 3000}`
  ).replace(/\/+$/, '');
}

function createPublicUrl(pathname) {
  const base = getBaseUrl();
  const path = String(pathname || '').startsWith('/') ? pathname : `/${pathname || ''}`;
  return `${base}${path}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function postJson(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        ...headers
      }
    }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        raw += chunk;
      });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(raw);
          return;
        }
        reject(new Error(`Email API failed with status ${res.statusCode}: ${raw}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendViaResend(message) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) return false;

  await postJson('https://api.resend.com/emails', {
    from,
    to: [message.to],
    subject: message.subject,
    html: message.html,
    text: message.text
  }, {
    Authorization: `Bearer ${apiKey}`
  });

  return true;
}

async function sendEmail(message) {
  if (!message || !message.to) throw new Error('Missing recipient email');

  // Try Resend first
  try {
    const sent = await sendViaResend(message);
    if (sent) return { delivered: true, transport: 'resend' };
  } catch (error) {
    console.error('Failed to send via Resend:', error);
  }

  // Try generic SMTP fallback
  const smtp = getSmtpConfig();
  if (smtp) {
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.secure,
        auth: { user: smtp.user, pass: smtp.pass }
      });
      await transporter.sendMail({
        from: smtp.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text
      });
      return { delivered: true, transport: 'smtp' };
    } catch (error) {
      console.error(`Failed to send via SMTP (${smtp.host}):`, error);
    }
  }

  // Fallback: log to console
  console.log('Transactional email fallback');
  console.log(JSON.stringify({
    to: message.to,
    subject: message.subject,
    text: message.text
  }, null, 2));
  return { delivered: false, transport: 'log' };
}

function buildEmailConfirmationMessage({ to, fullName, confirmUrl }) {
  const safeName = escapeHtml(fullName || 'there');
  const safeUrl = escapeHtml(confirmUrl);
  return {
    to,
    subject: 'Confirm your Pulse email',
    text: [
      `Hi ${fullName || 'there'},`,
      '',
      'Please confirm your email to activate your Pulse account:',
      confirmUrl,
      '',
      'If you did not create this account, you can ignore this email.'
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a">
        <h2 style="margin-bottom:16px">Confirm your email</h2>
        <p>Hi ${safeName},</p>
        <p>Please confirm your email to activate your Pulse account.</p>
        <p>
          <a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600">
            Confirm email
          </a>
        </p>
        <p style="word-break:break-all">If the button does not work, open this link:<br>${safeUrl}</p>
        <p>If you did not create this account, you can ignore this email.</p>
      </div>
    `
  };
}

function buildPasswordResetMessage({ to, fullName, resetUrl }) {
  const safeName = escapeHtml(fullName || 'there');
  const safeUrl = escapeHtml(resetUrl);
  return {
    to,
    subject: 'Reset your Pulse password',
    text: [
      `Hi ${fullName || 'there'},`,
      '',
      'Use this link to reset your Pulse password:',
      resetUrl,
      '',
      'If you did not request this, you can ignore this email.'
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a">
        <h2 style="margin-bottom:16px">Reset your password</h2>
        <p>Hi ${safeName},</p>
        <p>Use the link below to choose a new password for your Pulse account.</p>
        <p>
          <a href="${safeUrl}" style="display:inline-block;padding:12px 18px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600">
            Reset password
          </a>
        </p>
        <p style="word-break:break-all">If the button does not work, open this link:<br>${safeUrl}</p>
        <p>If you did not request this, you can ignore this email.</p>
      </div>
    `
  };
}

module.exports = {
  createPublicUrl,
  sendEmail,
  buildEmailConfirmationMessage,
  buildPasswordResetMessage
};
