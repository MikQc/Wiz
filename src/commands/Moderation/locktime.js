import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { successEmbed, infoEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { createTimedChannelLock, getActiveTimedLocks } from '../../services/channelLockService.js';

const durationChoices = [
  { name: "5 minutes", value: 5 },
  { name: "10 minutes", value: 10 },
  { name: "30 minutes", value: 30 },
  { name: "1 hour", value: 60 },
  { name: "6 hours", value: 360 },
  { name: "12 hours", value: 720 },
  { name: "1 day", value: 1440 },
];

export default {
  data: new SlashCommandBuilder()
    .setName("locktime")
    .setDescription(
      "Temporarily lock the current channel and automatically unlock it after a set time.",
    )
    .addIntegerOption((option) =>
      option
        .setName("duration")
        .setDescription("How long the channel stays locked")
        .setRequired(true)
        .addChoices(...durationChoices),
    )
    .addStringOption((option) =>
      option.setName("reason").setDescription("Reason for the temporary lock"),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),
  category: "moderation",

  async execute(interaction, config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) {
      logger.warn(`Locktime interaction defer failed`, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'locktime',
      });
      return;
    }

    const durationMinutes = interaction.options.getInteger("duration");
    const reason = interaction.options.getString("reason");
    const channel = interaction.channel;

    if (!durationMinutes || durationMinutes <= 0) {
      return await replyUserError(interaction, {
        type: ErrorTypes.USER_INPUT,
        message: 'Please provide a valid duration for the temporary lock.',
      });
    }

    try {
      const result = await createTimedChannelLock(client, {
        guild: interaction.guild,
        channel,
        durationMs: durationMinutes * 60 * 1000,
        reason,
        executor: interaction.user,
      });

      if (!result.ok && result.code === 'already_locked') {
        const active = await getActiveTimedLocks(client, interaction.guildId);
        const existing = active.find((lock) => lock.channelId === channel.id);

        return await InteractionHelper.safeEditReply(interaction, {
          embeds: [
            infoEmbed(
              `⏳ **Already Locked**`,
              `${channel} is already locked${
                existing
                  ? ` (auto-unlocks <t:${Math.floor(existing.endsAt / 1000)}:R>).`
                  : ' manually.'
              }`,
            ),
          ],
        });
      }

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          successEmbed(
            `🔒 **Channel Temporarily Locked**`,
            `${channel} is now locked. It will **auto-unlock <t:${Math.floor(result.endsAt / 1000)}:R>**${
              reason ? `\n**Reason:** ${reason}` : ''
            }`,
          ),
        ],
      });
    } catch (error) {
      logger.error('Locktime command error:', error);
      await replyUserError(interaction, {
        type: ErrorTypes.PERMISSION,
        message: "An unexpected error occurred while trying to lock the channel. Check my permissions (I need 'Manage Channels').",
      });
    }
  },
};