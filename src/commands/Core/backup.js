import { SlashCommandBuilder, AttachmentBuilder } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { exportDatabaseSnapshot, snapshotToPrettyJson, snapshotRowSummary } from '../../services/backupService.js';

export default {
  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Export all bot data as a JSON backup file (owner only).'),
  category: 'core',
  ownerOnly: true,

  async execute(interaction, config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: undefined, ephemeral: true });
    if (!deferSuccess) {
      logger.warn('Backup interaction defer failed', {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'backup',
      });
      return;
    }

    let snapshot;
    try {
      snapshot = await exportDatabaseSnapshot(client.db);
    } catch (error) {
      logger.error('Backup export failed:', error);
      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          warningEmbed(
            `🗄️ **Backup Failed**`,
            `The database is not available right now, so no backup could be created.\n\nCheck the database connection and try again.`,
          ),
        ],
      });
      return;
    }

    const fileName = `titanbot-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const json = snapshotToPrettyJson(snapshot);
    const attachment = new AttachmentBuilder(Buffer.from(json, 'utf8'), { name: fileName });

    await InteractionHelper.safeEditReply(interaction, {
      embeds: [
        successEmbed(
          `🗄️ **Backup Created**`,
          `Here is your full database backup (all tables + ${snapshot.totalRows} rows).\n\n\`\`\`\n${snapshotRowSummary(snapshot)}\n\`\`\``,
        ),
      ],
      files: [attachment],
    });

    logger.info('Backup created and sent', {
      userId: interaction.user.id,
      guildId: interaction.guildId,
      tables: snapshot.tables.length,
      totalRows: snapshot.totalRows,
    });
  },
};