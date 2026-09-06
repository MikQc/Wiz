import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, EmbedBuilder } from 'discord.js';
import { getWelcomeConfig, updateWelcomeConfig } from '../../utils/database.js';
import { formatWelcomeMessage, truncateForEmbedField } from '../../utils/welcome.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, replyUserError } from '../../utils/errorHandler.js';

const DEFAULT_MESSAGE = 'Welcome {user} to {server}! Please head to <#{channel}> to complete verification.';
const DEFAULT_DELETE_AFTER_MS = 60000;
const MAX_DELETE_AFTER_SECONDS = 300;

function normalizeJoinPing(raw) {
    return {
        enabled: Boolean(raw?.enabled),
        channelId: raw?.channelId ?? null,
        message: raw?.message ?? DEFAULT_MESSAGE,
        deleteAfterMs: Number(raw?.deleteAfterMs ?? DEFAULT_DELETE_AFTER_MS),
    };
}

export default {
    data: new SlashCommandBuilder()
        .setName('joinping')
        .setDescription('Ping new members in a separate channel, then auto-delete the ping')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Set up the join ping')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('The channel to ping new members in (e.g. verification)')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true))
                .addStringOption(option =>
                    option.setName('message')
                        .setDescription('Message. Variables: {user}, {username}, {server}, {channel}')
                        .setRequired(false))
                .addIntegerOption(option =>
                    option.setName('delete_after')
                        .setDescription(`Seconds before the ping is deleted (default: 60, max: ${MAX_DELETE_AFTER_SECONDS})`)
                        .setRequired(false)
                        .setMinValue(5)
                        .setMaxValue(MAX_DELETE_AFTER_SECONDS)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('disable')
                .setDescription('Disable the join ping'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show the current join ping configuration')),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`JoinPing interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'joinping'
            });
            return;
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the **Manage Server** permission to use `/joinping`.' });
        }

        const { options, guild, client } = interaction;
        const subcommand = options.getSubcommand();

        if (subcommand === 'setup') {
            const channel = options.getChannel('channel');
            const message = options.getString('message');
            const deleteAfterSeconds = options.getInteger('delete_after');

            const pingMessage = (message ?? DEFAULT_MESSAGE).trim();
            const deleteAfterMs = deleteAfterSeconds
                ? deleteAfterSeconds * 1000
                : DEFAULT_DELETE_AFTER_MS;

            const me = guild.members.me;
            const permissions = channel.permissionsFor(me);
            if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages])) {
                return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: `I need **View Channel**, **Send Messages** and **Manage Messages** permissions in ${channel} to send and delete the ping.` });
            }

            try {
                await updateWelcomeConfig(client, guild.id, {
                    joinPing: {
                        enabled: true,
                        channelId: channel.id,
                        message: pingMessage,
                        deleteAfterMs,
                    }
                });

                logger.info(`[JoinPing] Setup by ${interaction.user.tag} for guild ${guild.name} (${guild.id})`);

                const preview = formatWelcomeMessage(pingMessage, {
                    user: interaction.user,
                    guild,
                    channel,
                });

                const embed = new EmbedBuilder()
                    .setColor(getColor('success'))
                    .setTitle('Join Ping Configured')
                    .setDescription(`New members will now be pinged in ${channel}\nThe ping will be deleted after **${deleteAfterMs / 1000}** seconds.`)
                    .addFields(
                        { name: 'Message Preview', value: truncateForEmbedField(preview) }
                    )
                    .setFooter({ text: 'The ping is temporary — it points members to this channel.' });

                await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            } catch (error) {
                logger.error(`[JoinPing] Failed to setup for guild ${guild.id}:`, error);
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while configuring the join ping. Please try again.' });
            }
            return;
        }

        if (subcommand === 'disable') {
            try {
                await updateWelcomeConfig(client, guild.id, {
                    joinPing: normalizeJoinPing({ enabled: false })
                });

                logger.info(`[JoinPing] Disabled by ${interaction.user.tag} for guild ${guild.name} (${guild.id})`);

                const embed = new EmbedBuilder()
                    .setColor(getColor('error'))
                    .setTitle('Join Ping Disabled')
                    .setDescription('New members will no longer be pinged on join.');

                await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            } catch (error) {
                logger.error(`[JoinPing] Failed to disable for guild ${guild.id}:`, error);
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while disabling the join ping.' });
            }
            return;
        }

        if (subcommand === 'status') {
            const config = await getWelcomeConfig(client, guild.id);
            const joinPing = normalizeJoinPing(config?.joinPing);

            const embed = new EmbedBuilder()
                .setColor(getColor(joinPing.enabled ? 'success' : 'primary'))
                .setTitle('Join Ping Status')
                .addFields(
                    { name: 'Status', value: joinPing.enabled ? '✅ **Enabled**' : '❌ **Disabled**', inline: true },
                    { name: 'Channel', value: joinPing.channelId ? `<#${joinPing.channelId}>` : '`Not set`', inline: true },
                    { name: 'Delete After', value: joinPing.enabled ? `**${joinPing.deleteAfterMs / 1000}** seconds` : '—', inline: true },
                );

            if (joinPing.enabled && joinPing.message) {
                const preview = formatWelcomeMessage(joinPing.message, {
                    user: interaction.user,
                    guild,
                    channel: guild.channels.cache.get(joinPing.channelId),
                });
                embed.addFields({ name: 'Message', value: truncateForEmbedField(preview) });
            }

            embed.setFooter({ text: 'Use /joinping setup to change, or /joinping disable to turn off.' });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
        }
    },
};