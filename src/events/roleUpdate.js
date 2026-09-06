import { Events } from 'discord.js';
import { logEvent, EVENT_TYPES } from '../services/loggingService.js';
import { updateRolePanel } from '../commands/Community/roles.js';
import { logger } from '../utils/logger.js';
import { buildRoleAuditLines, buildRoleAuditFields } from '../utils/logging/logEmbeds.js';

export default {
  name: Events.GuildRoleUpdate,
  once: false,

  async execute(oldRole, newRole) {
    try {
      if (!newRole.guild) return;

      const changed = [];
      if (oldRole.name !== newRole.name) changed.push('name');
      if (oldRole.color !== newRole.color) changed.push('color');
      if (oldRole.position !== newRole.position) changed.push('position');
      if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) changed.push('permissions');
      if (oldRole.mentionable !== newRole.mentionable) changed.push('mentionable');
      if (oldRole.hoist !== newRole.hoist) changed.push('hoist');

      if (changed.length === 0) {
        return;
      }

      const lines = buildRoleAuditLines(newRole, { includeMemberCount: true });
      const fields = buildRoleAuditFields(newRole, { includeMemberCount: true });

      await logEvent({
        client: newRole.client,
        guildId: newRole.guild.id,
        eventType: EVENT_TYPES.ROLE_UPDATE,
        data: {
          title: 'Role Updated',
          headline: `${newRole.toString()} was updated`,
          lines,
          fields,
        },
      });

      await updateRolePanel(newRole.client, newRole.guild).catch((error) => {
        logger.debug('RolePanel: update on role update failed:', error.message);
      });

    } catch (error) {
      logger.error('Error in roleUpdate event:', error);
    }
  }
};