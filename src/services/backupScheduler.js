import { AttachmentBuilder } from 'discord.js';
import { logger } from '../utils/logger.js';
import { getBotOwners } from '../config/bot.js';
import { exportDatabaseSnapshot, snapshotToPrettyJson, snapshotRowSummary } from './backupService.js';

const DEFAULT_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function resolveOwnerUser(client) {
  const ownerIds = getBotOwners();
  for (const ownerId of ownerIds) {
    try {
      const user = await client.users.fetch(ownerId).catch(() => null);
      if (user) {
        return user;
      }
    } catch {
      // continue
    }
  }

  if (ownerIds.length === 0) {
    for (const guild of client.guilds.cache.values()) {
      if (guild.ownerId) {
        try {
          const user = await client.users.fetch(guild.ownerId).catch(() => null);
          if (user) {
            return user;
          }
        } catch {
          // continue
        }
      }
    }
  }

  return null;
}

async function runAutoBackup(client) {
  const wrapper = client.db;
  if (!wrapper || wrapper.isDegraded?.()) {
    logger.warn('Auto-backup skipped: database is not available (degraded mode)');
    return;
  }

  let snapshot;
  try {
    snapshot = await exportDatabaseSnapshot(wrapper);
  } catch (error) {
    logger.error('Auto-backup export failed:', error);
    return;
  }

  const ownerUser = await resolveOwnerUser(client);
  if (!ownerUser) {
    logger.warn('Auto-backup skipped: no owner user found to send the backup to');
    return;
  }

  const fileName = `titanbot-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const attachment = new AttachmentBuilder(Buffer.from(snapshotToPrettyJson(snapshot), 'utf8'), { name: fileName });

  try {
    await ownerUser.send({
      content: `🗄️ **Automatic backup (${snapshot.totalRows} rows across ${snapshot.tables.length} tables)**\n\`\`\`\n${snapshotRowSummary(snapshot)}\n\`\`\``,
      files: [attachment],
    });
    logger.info(`Auto-backup sent to owner ${ownerUser.id} (${snapshot.totalRows} rows)`);
  } catch (error) {
    logger.warn('Auto-backup DM failed:', error.message);
  }
}

export function startAutoBackup(client) {
  const intervalMs =
    (() => {
      const parsed = parseInt(process.env.AUTO_BACKUP_INTERVAL_HOURS, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed * 60 * 60 * 1000;
      }
      return DEFAULT_BACKUP_INTERVAL_MS;
    })();

  const enabled = process.env.AUTO_BACKUP !== 'false';

  if (!enabled) {
    logger.info('Auto-backup disabled (AUTO_BACKUP=false)');
    return;
  }

  const timer = setInterval(() => {
    runAutoBackup(client).catch((error) => {
      logger.error('Auto-backup interval error:', error);
    });
  }, intervalMs);

  timer.unref?.();

  logger.info(`Auto-backup scheduled every ${intervalMs / (60 * 60 * 1000)} hours`);

  return timer;
}