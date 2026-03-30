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

## Run

From `server/`:

```
npm i
npm run start
```

Open `http://localhost:3000`.
