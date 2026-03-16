# Server

This repository previously used Supabase directly from the browser. `server/` provides a local Node/Express API proxy backed by PostgreSQL.

## Configure

Create `server/.env` (you can start from `server/.env.example`).

Example:

```
PORT=3000
DATABASE_URL=postgresql://postgres:password@localhost:5432/pulseapp
SESSION_COOKIE_NAME=sid
SESSION_TTL_DAYS=14
UPLOAD_DIR=uploads
```

## Apply migration

Applying a migration means executing the SQL that updates your database schema.

Run in PowerShell:

```
psql "postgresql://postgres:password@localhost:5432/pulseapp" -f server/migrations/001_auth_and_sessions.sql
```

## Run

From `server/`:

```
npm i
npm run start
```

Open `http://localhost:3000`.

