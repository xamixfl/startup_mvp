const { Pool } = require('pg');

function buildConnectionStringFromParts() {
  const user = process.env.DB_USER;
  const host = process.env.DB_HOST;
  const name = process.env.DB_NAME;
  const password = process.env.DB_PASSWORD;
  const port = process.env.DB_PORT;
  if (!user || !host || !name || !password || !port) return null;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
}

const connectionString =
  process.env.DATABASE_URL
  || buildConnectionStringFromParts()
  || undefined;

const pool = new Pool({ connectionString });

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

module.exports = { pool, query };
