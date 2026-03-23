const { query } = require('./db');

function isSafeIdentifier(value) {
  return typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);
}

function isSafeTableName(value) {
  // Allow dashes in table names (e.g. "table-connector"), but still restrict to a safe charset.
  // Table names are always double-quoted in SQL below.
  return typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(value);
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function buildClauseForField(key, val, params) {
  if (!isSafeIdentifier(key)) throw new Error('Invalid filter key');
  if (val === undefined) return null;

  if (isPlainObject(val)) {
    if ('eq' in val) {
      params.push(val.eq);
      return `"${key}" = $${params.length}`;
    }
    if ('neq' in val) {
      params.push(val.neq);
      return `"${key}" <> $${params.length}`;
    }
    if ('gt' in val) {
      params.push(val.gt);
      return `"${key}" > $${params.length}`;
    }
    if ('gte' in val) {
      params.push(val.gte);
      return `"${key}" >= $${params.length}`;
    }
    if ('lt' in val) {
      params.push(val.lt);
      return `"${key}" < $${params.length}`;
    }
    if ('lte' in val) {
      params.push(val.lte);
      return `"${key}" <= $${params.length}`;
    }
    if ('in' in val) {
      const list = Array.isArray(val.in) ? val.in : [];
      if (list.length === 0) return 'FALSE';
      const placeholders = list.map(item => {
        params.push(item);
        return `$${params.length}`;
      }).join(', ');
      return `"${key}" IN (${placeholders})`;
    }
    if ('ilike' in val) {
      params.push(val.ilike);
      return `"${key}" ILIKE $${params.length}`;
    }
    return null;
  }

  params.push(val);
  return `"${key}" = $${params.length}`;
}

// Supports filters like:
// { id: "uuid" }
// { expires_at: { gt: "2026-01-01T00:00:00Z" } }
// { chat_id: { in: ["a","b"] } }
// Special keys:
// { $order: { column: "created_at", ascending: false }, $limit: 20, $or: [ { a: 1 }, { b: { ilike: "%x%" } } ] }
function buildQueryParts(filters, params) {
  const clauses = [];
  let orderBy = '';
  let limitSql = '';

  if (!filters || typeof filters !== 'object') {
    return { whereSql: '', orderBy, limitSql, params };
  }

  const entries = Object.entries(filters);
  for (const [key, val] of entries) {
    if (key === '$or') {
      const list = Array.isArray(val) ? val : [];
      const orClauses = [];
      for (const item of list) {
        if (!isPlainObject(item)) continue;
        const andParts = [];
        for (const [k, v] of Object.entries(item)) {
          const part = buildClauseForField(k, v, params);
          if (part) andParts.push(part);
        }
        if (andParts.length > 0) {
          orClauses.push(andParts.length === 1 ? andParts[0] : `(${andParts.join(' AND ')})`);
        }
      }
      if (orClauses.length > 0) {
        clauses.push(orClauses.length === 1 ? orClauses[0] : `(${orClauses.join(' OR ')})`);
      }
      continue;
    }
    if (key === '$order') {
      if (!isPlainObject(val)) continue;
      const column = val.column;
      const ascending = val.ascending !== false;
      if (!isSafeIdentifier(column)) throw new Error('Invalid order column');
      orderBy = ` ORDER BY "${column}" ${ascending ? 'ASC' : 'DESC'}`;
      continue;
    }
    if (key === '$limit') {
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) continue;
      limitSql = ` LIMIT ${Math.min(Math.floor(n), 500)}`;
      continue;
    }

    const part = buildClauseForField(key, val, params);
    if (part) clauses.push(part);
  }

  if (clauses.length === 0) return { whereSql: '', orderBy, limitSql, params };
  return { whereSql: ` WHERE ${clauses.join(' AND ')}`, orderBy, limitSql, params };
}

async function selectRows(table, filters) {
  if (!isSafeTableName(table)) throw new Error('Invalid table');
  const params = [];
  const { whereSql, orderBy, limitSql } = buildQueryParts(filters, params);
  const sql = `SELECT * FROM "${table}"${whereSql}${orderBy}${limitSql}`;
  const result = await query(sql, params);
  return result.rows;
}

async function insertRow(table, data) {
  if (!isSafeTableName(table)) throw new Error('Invalid table');
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
  if (!isSafeTableName(table)) throw new Error('Invalid table');
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
  if (!isSafeTableName(table)) throw new Error('Invalid table');
  const id = data && typeof data === 'object' ? data.id : null;
  if (!id) throw new Error('Missing id');
  const sql = `DELETE FROM "${table}" WHERE "id" = $1 RETURNING *`;
  const result = await query(sql, [id]);
  return result.rows;
}

async function deleteWhere(table, filters) {
  if (!isSafeTableName(table)) throw new Error('Invalid table');
  const params = [];
  const { whereSql } = buildQueryParts(filters, params);
  if (!whereSql) throw new Error('Refusing delete without filters');
  const sql = `DELETE FROM "${table}"${whereSql} RETURNING *`;
  const result = await query(sql, params);
  return result.rows;
}

module.exports = {
  selectRows,
  insertRow,
  updateRow,
  deleteRow,
  deleteWhere
};
