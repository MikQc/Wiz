import { logger } from '../utils/logger.js';

const DEFAULT_MOD_LIST_KEY = 'pendingMods';

function isPostgresSqlReady(dbWrapper) {
  return Boolean(
    dbWrapper?.db?.pool &&
      typeof dbWrapper.db.pool.query === 'function' &&
      !dbWrapper.db.pool.isDegraded,
  );
}

function modListKey(guildId, entryNumber) {
  return `${DEFAULT_MOD_LIST_KEY}:${guildId}:${entryNumber}`;
}

export async function getPendingMods(client, guildId) {
  if (!client?.db) {
    return [];
  }

  const entries = new Map();

  if (isPostgresSqlReady(client.db)) {
    try {
      const { pgConfig } = await import('../config/database/postgres.js');
      const result = await client.db.db.pool.query(
        `SELECT entry_number, name, added_by, created_at
         FROM ${pgConfig.tables.pending_mods}
         WHERE guild_id = $1
         ORDER BY entry_number ASC`,
        [guildId],
      );

      for (const row of result.rows || []) {
        entries.set(row.entry_number, {
          entryNumber: row.entry_number,
          name: row.name,
          addedBy: row.added_by || null,
        });
      }
    } catch (error) {
      logger.error('Error loading pending mods from database:', error);
    }
  }

  try {
    if (typeof client.db.list === 'function') {
      const prefix = `${DEFAULT_MOD_LIST_KEY}:${guildId}:`;
      const keys = await client.db.list(prefix);
      for (const key of keys) {
        const entry = await client.db.get(key, null);
        if (entry?.entryNumber && entry?.name) {
          entries.set(entry.entryNumber, entry);
        }
      }
    }
  } catch (error) {
    logger.debug('KV pending mod load skipped:', error?.message);
  }

  return Array.from(entries.values()).sort((a, b) => a.entryNumber - b.entryNumber);
}

export async function upsertPendingMod(client, guildId, { entryNumber, name, addedBy }) {
  if (!client?.db) {
    return { ok: false, code: 'no_db' };
  }

  const entry = {
    entryNumber: Number(entryNumber),
    name: String(name).trim(),
    addedBy: addedBy || null,
  };

  if (!entry.entryNumber || entry.entryNumber < 1) {
    return { ok: false, code: 'invalid_number' };
  }
  if (!entry.name) {
    return { ok: false, code: 'invalid_name' };
  }

  if (isPostgresSqlReady(client.db)) {
    try {
      const { pgConfig } = await import('../config/database/postgres.js');
      await client.db.db.pool.query(
        `INSERT INTO ${pgConfig.tables.pending_mods}
           (guild_id, entry_number, name, added_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (guild_id, entry_number)
         DO UPDATE SET name = EXCLUDED.name,
                       added_by = EXCLUDED.added_by,
                       updated_at = CURRENT_TIMESTAMP`,
        [guildId, entry.entryNumber, entry.name, entry.addedBy],
      );
      return { ok: true, entry };
    } catch (error) {
      logger.error('Error saving pending mod to database:', error);
      return { ok: false, code: 'db_error' };
    }
  }

  try {
    await client.db.set(modListKey(guildId, entry.entryNumber), entry);
    return { ok: true, entry };
  } catch (error) {
    logger.error('Error saving pending mod to key-value store:', error);
    return { ok: false, code: 'kv_error' };
  }
}

export async function removePendingMod(client, guildId, entryNumber) {
  if (!client?.db) {
    return { ok: false, code: 'no_db' };
  }

  const num = Number(entryNumber);

  if (isPostgresSqlReady(client.db)) {
    try {
      const { pgConfig } = await import('../config/database/postgres.js');
      await client.db.db.pool.query(
        `DELETE FROM ${pgConfig.tables.pending_mods}
         WHERE guild_id = $1 AND entry_number = $2`,
        [guildId, num],
      );
      return { ok: true };
    } catch (error) {
      logger.error('Error removing pending mod from database:', error);
      return { ok: false, code: 'db_error' };
    }
  }

  try {
    if (typeof client.db.delete === 'function') {
      await client.db.delete(modListKey(guildId, num));
    }
    return { ok: true };
  } catch (error) {
    logger.error('Error removing pending mod from key-value store:', error);
    return { ok: false, code: 'kv_error' };
  }
}