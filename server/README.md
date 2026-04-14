# Server

This repository previously used Supabase directly from the browser. `server/` provides a local Node/Express API proxy backed by PostgreSQL.

## Configure

Create `server/.env` (you can start from `server/.env.example`).

For local development you can also create `server/.env.local` which will be loaded *before* `server/.env` (so you can override DB settings locally without touching the production file).

Optionally you can point the server to an explicit env file:

```
ENV_FILE=server/.env.local node src/server.js
```

Example:

```
PORT=3000
DATABASE_URL=postgresql://postgres:password@localhost:5432/pulseapp
SESSION_COOKIE_NAME=sid
SESSION_TTL_DAYS=14
APP_BASE_URL=http://localhost:3000
RESEND_API_KEY=
EMAIL_FROM=noreply@example.com
UPLOAD_DIR=uploads
```

## Apply migration

Applying a migration means executing the SQL that updates your database schema.

Run in PowerShell:

```
psql "postgresql://postgres:password@localhost:5432/pulseapp" -f server/migrations/001_auth_and_sessions.sql
```

If you're using the SSH tunnel to the server DB (recommended for local testing):

```
ssh -L 5433:127.0.0.1:5432 admin@45.151.31.223
psql "postgresql://postgres:password@127.0.0.1:5433/pulseapp" -f server/migrations/003_performance_indexes.sql
```

Performance indexes:

```
psql "postgresql://postgres:password@localhost:5432/pulseapp" -f server/migrations/003_performance_indexes.sql
```

For email confirmation and password reset, also apply:

```
psql "postgresql://postgres:password@127.0.0.1:5433/pulseapp" -f server/migrations/003_email_confirmation_and_resets.sql
```

## Email delivery

The auth flow now supports:

- email confirmation before first login
- password reset by email

If `RESEND_API_KEY` and `EMAIL_FROM` are configured, the server sends real emails through Resend.

If Resend is not configured, the server next tries generic SMTP via Nodemailer.

Recommended Resend config:

```env
RESEND_API_KEY=re_xxxxx
EMAIL_FROM=noreply@your-domain.com
```

Optional SMTP fallback example:

```env
SMTP_HOST=smtp.mail.ru
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-mailbox@mail.ru
SMTP_PASS=your-password
SMTP_FROM=your-mailbox@mail.ru
```

If neither Resend nor SMTP is configured, the server falls back to logging the confirmation/reset links in the server console, which is useful for local testing.

## Run

From `server/`:

```
npm i
npm run start
```

Open `http://localhost:3000`.
