import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { updateRolePanel } from '../commands/Community/roles.js';
import { logger } from '../utils/logger.js';
import { buildRoleAuditLines } from '../utils/logging/logEmbeds.js';

export default {
  name: Events.GuildRoleDelete,
  once: false,

  async execute(role) {
    try {
      if (!role.guild) return;

      const lines = buildRoleAuditLines(role, { includeMemberCount: true });

      await logEvent({
        client: role.client,
        guildId: role.guild.id,
        eventType: EVENT_TYPES.ROLE_DELETE,
        data: {
          title: 'Role Deleted',
          headline: `**${role.name}** was deleted`,
          lines,
        },
      });

      await updateRolePanel(role.client, role.guild).catch((error) => {
        logger.debug('RolePanel: update on role delete failed:', error.message);
      });

    } catch (error) {
      logger.error('Error in roleDelete event:', error);
    }
  }
};