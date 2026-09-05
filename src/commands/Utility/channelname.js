import { SlashCommandBuilder, MessageFlags, PermissionFlagsBits, ChannelType } from 'discord.js';
import { createEmbed, successEmbed, errorEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { withErrorHandling, createError, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
    data: new SlashCommandBuilder()
        .setName("channelname")
        .setDescription("Rename a channel with proper capitalization and spaces")
        .addStringOption((option) =>
            option
                .setName("title")
                .setDescription("The new channel name")
                .setRequired(true)
                .setMaxLength(100)
        )
        .addChannelOption((option) =>
            option
                .setName("channel")
                .setDescription("Select the channel to rename (defaults to current channel)")
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildForum, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice)
                .setRequired(false)
        ),

    async execute(interaction) {
        const wrappedExecute = withErrorHandling(async () => {
            const title = interaction.options.getString("title").trim();
            const targetChannel = interaction.options.getChannel("channel") || interaction.channel;

            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
                return await replyUserError(
                    interaction,
                    createError(
                        'Missing ManageChannels permission',
                        ErrorTypes.PERMISSION,
                        'You need the **Manage Channels** permission to rename a channel.',
                        { userId: interaction.user.id }
                    )
                );
            }

            const botMember = interaction.guild.members.me;
            if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
                return await replyUserError(
                    interaction,
                    createError(
                        'Bot missing ManageChannels permission',
                        ErrorTypes.PERMISSION,
                        'I need the **Manage Channels** permission to rename a channel.',
                        { missingPermission: 'ManageChannels' }
                    )
                );
            }

            if (!title) {
                return await replyUserError(
                    interaction,
                    createError(
                        'Empty title',
                        ErrorTypes.VALIDATION,
                        'Please enter a channel name.',
                        { title }
                    )
                );
            }

            const maxLength = 100;
            if (title.length > maxLength) {
                return await replyUserError(
                    interaction,
                    createError(
                        'Title too long',
                        ErrorTypes.VALIDATION,
                        `The channel name is too long. Maximum is ${maxLength} characters.`,
                        { length: title.length }
                    )
                );
            }

            const safeName = toFullwidth(title);

            try {
                await targetChannel.setName(safeName, "Channel name updated via /channelname");

                const embed = successEmbed(
                    'Channel Updated ✅',
                    [
                        `**Channel:** ${targetChannel}`,
                        `**New Name:** \`${safeName}\``,
                        `**Before:** \`${targetChannel.name}\``
                    ].join('\n')
                );

                await InteractionHelper.safeReply(interaction, { embeds: [embed] });

                logger.info('Channel renamed via /channelname', {
                    userId: interaction.user.id,
                    guildId: interaction.guildId,
                    channelId: targetChannel.id,
                    oldName: targetChannel.name,
                    newName: safeName
                });
            } catch (error) {
                return await replyUserError(
                    interaction,
                    createError(
                        'Failed to rename channel',
                        ErrorTypes.INTERNAL,
                        `I could not rename the channel. ${error.message}`,
                        { channelId: targetChannel.id }
                    )
                );
            }
        }, { command: 'channelname' });

        return await wrappedExecute(interaction);
    }
};

function toFullwidth(name) {
    const result = [];
    for (const char of name) {
        const code = char.codePointAt(0);
        if (code >= 0x41 && code <= 0x5A) {
            result.push(String.fromCodePoint(code + 0xFEE0));
        } else {
            result.push(char);
        }
    }
    return result.join('');
}
