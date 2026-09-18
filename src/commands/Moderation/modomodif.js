import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, infoEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { upsertPendingMod, removePendingMod } from '../../services/pendingModService.js';

export default {
  data: new SlashCommandBuilder()
    .setName("modomodif")
    .setDescription("Add a member to the pending moderator list (owner only).")
    .addIntegerOption((option) =>
      option
        .setName("number")
        .setDescription("Position number in the list")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("name").setDescription("Member name to add or update at this position"),
    )
    .addBooleanOption((option) =>
      option
        .setName("remove")
        .setDescription("Remove the entry at this position instead of adding it"),
    ),
  category: "moderation",
  ownerOnly: true,

  async execute(interaction, config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) {
      logger.warn(`Modomodif interaction defer failed`, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'modomodif',
      });
      return;
    }

    const entryNumber = interaction.options.getInteger("number");
    const name = interaction.options.getString("name");
    const remove = interaction.options.getBoolean("remove") || false;

    if (!entryNumber || entryNumber < 1) {
      return await replyUserError(interaction, {
        type: ErrorTypes.USER_INPUT,
        message: 'Please provide a valid list number (starting at 1).',
      });
    }

    if (remove) {
      const result = await removePendingMod(client, interaction.guildId, entryNumber);
      if (!result.ok) {
        return await replyUserError(interaction, {
          type: ErrorTypes.UNKNOWN,
          message: 'An error occurred while removing the entry.',
        });
      }

      return await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          successEmbed(
            `🗑️ **Entry Removed**`,
            `Position **${entryNumber}** has been removed from the pending moderator list.`,
          ),
        ],
      });
    }

    if (!name) {
      return await replyUserError(interaction, {
        type: ErrorTypes.USER_INPUT,
        message: 'Please provide a name to add to the list (or use remove).',
      });
    }

    const result = await upsertPendingMod(client, interaction.guildId, {
      entryNumber,
      name,
      addedBy: interaction.user.id,
    });

    if (!result.ok) {
      return await replyUserError(interaction, {
        type: ErrorTypes.UNKNOWN,
        message: 'An error occurred while saving the entry.',
      });
    }

    const embed = result.entry
      ? successEmbed(
          `✅ **Entry Updated**`,
          `Position **${result.entry.entryNumber}** now corresponds to **${result.entry.name}**.`,
        )
      : infoEmbed(
          `📝 **Entry**`,
          `Position **${result.entryNumber}** is now set to **${name}**.`,
        );

    await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
  },
};