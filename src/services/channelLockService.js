import { logger } from '../utils/logger.js';
import { PermissionFlagsBits } from 'discord.js';
import { logEvent } from '../utils/moderation.js';

const DEFAULT_LOCK_STORE_KEY = 'channelLocks';

function isPostgresSqlReady(dbWrapper) {
  return Boolean(
    dbWrapper?.db?.pool &&
      typeof dbWrapper.db.pool.query === 'function' &&
      !dbWrapper.db.pool.isDegraded,
  );
}

function lockStoreKey(guildId, channelId) {
  return `${DEFAULT_LOCK_STORE_KEY}:${guildId}:${channelId}`;
}

async function saveLock(client, guildId, channelId, lockData) {
  if (!client?.db) {
    return false;
  }

  if (isPostgresSqlReady(client.db)) {
    try {
      const { pgConfig } = await import('../config/database/postgres.js');
      await client.db.db.pool.query(
        `INSERT INTO ${pgConfig.tables.channel_locks}
           (guild_id, channel_id, ends_at, reason, executor_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (guild_id, channel_id)
         DO UPDATE SET ends_at = EXCLUDED.ends_at,
                       reason = EXCLUDED.reason,
                       executor_id = EXCLUDED.executor_id,
                       updated_at = CURRENT_TIMESTAMP`,
        [guildId, channelId, new Date(lockData.endsAt), lockData.reason || null, lockData.executorId || null],
      );
      return true;
    } catch (error) {
      logger.error('Error saving channel lock to database:', error);
      return false;
    }
  }

  try {
    await client.db.set(lockStoreKey(guildId, channelId), lockData);
    return true;
  } catch (error) {
    logger.error('Error saving channel lock to key-value store:', error);
    return false;
  }
}

async function getLocksByGuild(client, guildId) {
  if (!client?.db) {
    return [];
  }

  const locks = new Map();

  if (isPostgresSqlReady(client.db)) {
    try {
      const { pgConfig } = await import('../config/database/postgres.js');
      const result = await client.db.db.pool.query(
        `SELECT guild_id, channel_id, ends_at, reason, executor_id
         FROM ${pgConfig.tables.channel_locks}
         WHERE guild_id = $1
         ORDER BY ends_at ASC`,
        [guildId],
      );

      for (const row of result.rows || []) {
        locks.set(row.channel_id, {
          guildId: row.guild_id,
          channelId: row.channel_id,
          endsAt: new Date(row.ends_at).getTime(),
          reason: row.reason || null,
          executorId: row.executor_id || null,
        });
      }
    } catch (error) {
      logger.error('Error loading channel locks from database:', error);
    }
  }

  try {
    if (typeof client.db.list === 'function') {
      const prefix = `${DEFAULT_LOCK_STORE_KEY}:${guildId}:`;
      const keys = await client.db.list(prefix);
      for (const key of keys) {
        const lock = await client.db.get(key, null);
        if (lock?.channelId && lock?.endsAt) {
          locks.set(lock.channelId, lock);
        }
      }
    }
  } catch (error) {
    logger.debug('KV channel lock load skipped:', error?.message);
  }

  return Array.from(locks.values());
}

async function deleteLock(client, guildId, channelId) {
  if (!client?.db) {
    return;
  }

  if (isPostgresSqlReady(client.db)) {
    try {
      const { pgConfig } = await import('../config/database/postgres.js');
      await client.db.db.pool.query(
        `DELETE FROM ${pgConfig.tables.channel_locks}
         WHERE guild_id = $1 AND channel_id = $2`,
        [guildId, channelId],
      );
      return;
    } catch (error) {
      logger.error('Error deleting channel lock from database:', error);
    }
  }

  try {
    if (typeof client.db.delete === 'function') {
      await client.db.delete(lockStoreKey(guildId, channelId));
    }
  } catch (error) {
    logger.error('Error deleting channel lock from key-value store:', error);
  }
}

async function unlockChannelFromLock(client, lock) {
  const guild = client.guilds.cache.get(lock.guildId);
  if (!guild) {
    await deleteLock(client, lock.guildId, lock.channelId).catch(() => {});
    return false;
  }

  const channel = guild.channels.cache.get(lock.channelId);
  if (!channel) {
    await deleteLock(client, lock.guildId, lock.channelId).catch(() => {});
    return false;
  }

  const everyoneRole = guild.roles.everyone;
  try {
    const currentPermissions = channel.permissionsFor(everyoneRole);
    const isLocked =
      currentPermissions.has(PermissionFlagsBits.SendMessages) === false;

    if (isLocked) {
      await channel.permissionOverwrites.edit(
        everyoneRole,
        { SendMessages: true },
        { type: 0, reason: `Timed channel lock expired (executor: ${lock.executorId || 'unknown'})` },
      );
    }

    await logEvent({
      client,
      guild,
      event: {
        action: 'Channel Auto-Unlocked',
        target: channel.toString(),
        executor: lock.executorId ? `<@${lock.executorId}>` : 'Auto (lock expired)',
        metadata: {
          channelId: channel.id,
          lockEndedAt: new Date(lock.endsAt).toISOString(),
        },
      },
    });

    await deleteLock(client, lock.guildId, lock.channelId).catch(() => {});
    return true;
  } catch (error) {
    logger.error('Error auto-unlocking channel:', { error: error.message, lock });
    return false;
  }
}

export async function checkDueChannelLocks(client) {
  if (!client?.db) {
    return;
  }

  let dueLocks;
  if (isPostgresSqlReady(client.db)) {
    try {
      const { pgConfig } = await import('../config/database/postgres.js');
      const result = await client.db.db.pool.query(
        `SELECT guild_id, channel_id, ends_at, reason, executor_id
         FROM ${pgConfig.tables.channel_locks}
         WHERE ends_at <= NOW()
         ORDER BY ends_at ASC`,
      );

      dueLocks = (result.rows || []).map((row) => ({
        guildId: row.guild_id,
        channelId: row.channel_id,
        endsAt: new Date(row.ends_at).getTime(),
        reason: row.reason || null,
        executorId: row.executor_id || null,
      }));
    } catch (error) {
      logger.error('Error fetching due channel locks:', error);
      return;
    }
  } else {
    const guildIds = Array.from(client.guilds.cache.values()).map((g) => g.id);
    const now = Date.now();
    dueLocks = [];

    for (const guildId of guildIds) {
      const guildLocks = await getLocksByGuild(client, guildId);
      for (const lock of guildLocks) {
        if (Number(lock.endsAt) <= now) {
          dueLocks.push(lock);
        }
      }
    }
  }

  for (const lock of dueLocks) {
    try {
      await unlockChannelFromLock(client, lock);
    } catch (error) {
      logger.error('Error processing due channel lock:', { error: error?.message || String(error), lock });
    }
  }
}

async function isChannelLocked(client, guildId, channelId) {
  const locks = await getLocksByGuild(client, guildId);
  return locks.some((lock) => lock.channelId === channelId);
}

export async function createTimedChannelLock(client, { guild, channel, durationMs, reason, executor }) {
  const lockData = {
    guildId: guild.id,
    channelId: channel.id,
    endsAt: Date.now() + durationMs,
    reason: reason || null,
    executorId: executor?.id || null,
  };

  const everyoneRole = guild.roles.everyone;
  const alreadyLocked =
    channel.permissionsFor(everyoneRole)?.has(PermissionFlagsBits.SendMessages) === false;

  if (alreadyLocked) {
    return { ok: false, code: 'already_locked' };
  }

  await channel.permissionOverwrites.edit(
    everyoneRole,
    { SendMessages: false },
    { type: 0, reason: `Channel locked by ${executor?.tag || 'unknown'}${reason ? ` (${reason})` : ''}` },
  );

  const persisted = await saveLock(client, guild.id, channel.id, lockData);
  if (!persisted) {
    logger.warn('Channel lock could not be persisted, unlock-on-restart may be missed', {
      guildId: guild.id,
      channelId: channel.id,
    });
  }

  return { ok: true, code: 'locked', endsAt: lockData.endsAt, persisted };
}

export async function cancelTimedChannelLock(client, { guild, channel, executor }) {
  const lock = (await getLocksByGuild(client, guild.id)).find((l) => l.channelId === channel.id);

  if (lock) {
    await deleteLock(client, guild.id, channel.id).catch(() => {});
  }

  try {
    const everyoneRole = guild.roles.everyone;
    if (channel.permissionsFor(everyoneRole)?.has(PermissionFlagsBits.SendMessages) === false) {
      await channel.permissionOverwrites.edit(
        everyoneRole,
        { SendMessages: true },
        { type: 0, reason: `Channel unlocked by ${executor?.tag || 'unknown'}` },
      );
    }
  } catch (error) {
    logger.error('Error unlocking channel:', error);
  }

  return { ok: true, cancelled: Boolean(lock) };
}

export async function getActiveTimedLocks(client, guildId) {
  const now = Date.now();
  const locks = await getLocksByGuild(client, guildId);
  return locks.filter((lock) => Number(lock.endsAt) > now);
}

export { isChannelLocked };