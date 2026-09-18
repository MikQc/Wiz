import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, infoEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getPendingMods } from '../../services/pendingModService.js';

export default {
  data: new SlashCommandBuilder()
    .setName("modolist")
    .setDescription("Shows the list of members who are pending to become moderators."),
  category: "moderation",

  async execute(interaction, config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) {
      logger.warn(`Modolist interaction defer failed`, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'modolist',
      });
      return;
    }

    const pendingMods = await getPendingMods(client, interaction.guildId);

    if (pendingMods.length === 0) {
      return await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          infoEmbed(
            `📋 **Pending Moderators**`,
            `No one is currently pending to become a moderator on this server.`,
          ),
        ],
      });
    }

    const listLines = pendingMods
      .map((entry) => `**${entry.entryNumber}.** ${entry.name}`)
      .join("\n");

    await InteractionHelper.safeEditReply(interaction, {
      embeds: [
        successEmbed(
          `📋 **Pending Moderators**`,
          `${listLines}\n\n_List of members waiting to become moderators._`,
        ),
      ],
    });
  },
};