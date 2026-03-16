const { query } = require('./db');

function isSafeIdentifier(value) {
  return typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);
}

function buildWhere(filters, params) {
  const clauses = [];
  if (!filters || typeof filters !== 'object') return { whereSql: '', params };
  for (const [key, val] of Object.entries(filters)) {
    if (val === undefined) continue;
    if (!isSafeIdentifier(key)) {
      throw new Error('Invalid filter key');
    }
    params.push(val);
    clauses.push(`"${key}" = $${params.length}`);
  }
  if (clauses.length === 0) return { whereSql: '', params };
  return { whereSql: ` WHERE ${clauses.join(' AND ')}`, params };
}

async function selectRows(table, filters) {
  if (!isSafeIdentifier(table)) throw new Error('Invalid table');
  const params = [];
  const { whereSql } = buildWhere(filters, params);
  const sql = `SELECT * FROM "${table}"${whereSql}`;
  const result = await query(sql, params);
  return result.rows;
}

async function insertRow(table, data) {
  if (!isSafeIdentifier(table)) throw new Error('Invalid table');
  if (!data || typeof data !== 'object') throw new Error('Invalid data');
  const keys = Object.keys(data).filter(k => data[k] !== undefined);
  if (keys.length === 0) throw new Error('Empty insert');
  for (const key of keys) {
    if (!isSafeIdentifier(key)) throw new Error('Invalid column');
  }
  const params = keys.map(k => data[k]);
  const cols = keys.map(k => `"${k}"`).join(', ');
  const placeholders = keys.map((_, idx) => `$${idx + 1}`).join(', ');
  const sql = `INSERT INTO "${table}" (${cols}) VALUES (${placeholders}) RETURNING *`;
  const result = await query(sql, params);
  return result.rows;
}

async function updateRow(table, data) {
  if (!isSafeIdentifier(table)) throw new Error('Invalid table');
  if (!data || typeof data !== 'object') throw new Error('Invalid data');
  const { id, ...rest } = data;
  if (!id) throw new Error('Missing id');
  const keys = Object.keys(rest).filter(k => rest[k] !== undefined);
  for (const key of keys) {
    if (!isSafeIdentifier(key)) throw new Error('Invalid column');
  }
  if (keys.length === 0) return [];
  const params = [];
  const setSql = keys.map(key => {
    params.push(rest[key]);
    return `"${key}" = $${params.length}`;
  }).join(', ');
  params.push(id);
  const sql = `UPDATE "${table}" SET ${setSql} WHERE "id" = $${params.length} RETURNING *`;
  const result = await query(sql, params);
  return result.rows;
}

async function deleteRow(table, data) {
  if (!isSafeIdentifier(table)) throw new Error('Invalid table');
  const id = data && typeof data === 'object' ? data.id : null;
  if (!id) throw new Error('Missing id');
  const sql = `DELETE FROM "${table}" WHERE "id" = $1 RETURNING *`;
  const result = await query(sql, [id]);
  return result.rows;
}

module.exports = {
  selectRows,
  insertRow,
  updateRow,
  deleteRow
};

