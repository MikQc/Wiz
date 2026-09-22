import pgConfig from '../config/database/postgres.js';
import { logger } from '../utils/logger.js';

const TABLE_NAMES = Object.values(pgConfig.tables);

function getPool(dbWrapper) {
  if (!dbWrapper || dbWrapper.isDegraded?.()) {
    return null;
  }
  const pool = dbWrapper.db?.pool;
  if (!pool || typeof pool.query !== 'function') {
    return null;
  }
  return pool;
}

async function getRows(pool, table) {
  const result = await pool.query(`SELECT * FROM ${table}`);
  return result.rows;
}

export async function exportDatabaseSnapshot(dbWrapper, options = {}) {
  const { excludeMeta = false } = options;
  const pool = getPool(dbWrapper);
  if (!pool) {
    throw new Error('PostgreSQL not available - cannot create backup');
  }

  const data = {};
  const rowCounts = {};

  for (const table of TABLE_NAMES) {
    try {
      const rows = await getRows(pool, table);
      data[table] = rows;
      rowCounts[table] = rows.length;
    } catch (error) {
      logger.warn(`Backup: table ${table} could not be exported:`, error.message);
      data[table] = [];
      rowCounts[table] = -1;
    }
  }

  const exportTables = Object.keys(data);
  let totalRows = 0;
  for (const count of Object.values(rowCounts)) {
    if (count > 0) {
      totalRows += count;
    }
  }

  const snapshot = {
    exportedBy: 'titanbot',
    exportedAt: new Date().toISOString(),
    version: 1,
    tables: exportTables,
    rowCounts,
    totalRows,
    data,
  };

  if (excludeMeta) {
    const { data: _data, ...rest } = snapshot;
    return rest;
  }

  return snapshot;
}

export function snapshotToPrettyJson(snapshot) {
  return JSON.stringify(snapshot, null, 2);
}

export function snapshotRowSummary(snapshot) {
  const lines = snapshot.tables.map((table) => {
    const count = snapshot.rowCounts[table];
    const countStr = count < 0 ? 'ERROR' : String(count);
    return `• ${table}: ${countStr} rows`;
  });

  lines.push('');
  lines.push(`Total: ${snapshot.totalRows} rows across ${snapshot.tables.length} tables.`);

  return lines.join('\n');
}