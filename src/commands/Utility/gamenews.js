import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { getColor } from '../../config/bot.js';
import { createEmbed } from '../../utils/embeds.js';
import { getGuildConfig, updateGuildConfig } from '../../services/config/guildConfig.js';
import { fetchSteamNews } from '../../services/gameNewsService.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

function normalizeGameUpdates(raw) {
    return {
        enabled: Boolean(raw?.enabled),
        channelId: raw?.channelId ?? null,
        lastGuid: raw?.lastGuid ?? null,
    };
}

export default {
    data: new SlashCommandBuilder()
        .setName('gamenews')
        .setDescription('Post Animal Company update news to a channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Send Animal Company updates to a channel')
                .addChannelOption(option =>
                    option
                        .setName('channel')
                        .setDescription('The channel to receive update news')
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show the current game news configuration'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('disable')
                .setDescription('Disable Animal Company update news')),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn('GameNews interaction defer failed', {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'gamenews',
            });
            return;
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return await replyUserError(interaction, {
                type: ErrorTypes.PERMISSION,
                message: 'You need the **Manage Server** permission to use `/gamenews`.',
            });
        }

        const { options, guild, client } = interaction;
        const subcommand = options.getSubcommand();
        const config = await getGuildConfig(client, guild.id);
        const gameUpdates = normalizeGameUpdates(config.gameUpdates);

        if (subcommand === 'setup') {
            const channel = options.getChannel('channel');

            if (!channel || !channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)) {
                return await replyUserError(interaction, {
                    type: ErrorTypes.PERMISSION,
                    message: `I can't send messages in ${channel}. Please check my permissions in that channel.`,
                });
            }

            const ensuresFreshFeed = !gameUpdates.lastGuid;
            const hasChangedChannel = gameUpdates.channelId !== channel.id;

            await updateGuildConfig(client, guild.id, {
                gameUpdates: {
                    enabled: true,
                    channelId: channel.id,
                    lastGuid: gameUpdates.lastGuid,
                },
            });

            let latestLine = '';
            if (ensuresFreshFeed || hasChangedChannel) {
                const items = await fetchSteamNews();
                if (items.length > 0) {
                    latestLine = `La dernière news postée dans ${channel} sera **${items[0].title}**.`;
                    gameUpdates.lastGuid = items[0].guid;
                    await updateGuildConfig(client, guild.id, {
                        gameUpdates: {
                            enabled: true,
                            channelId: channel.id,
                            lastGuid: items[0].guid,
                        },
                    });
                }
            }

            const embed = createEmbed({
                title: '✅ Game news enabled',
                description: `Les mises à jour d'**Animal Company** seront postées dans ${channel} dès la prochaine news publiée.${latestLine ? `\n\n${latestLine}` : ''}`,
                color: 'success',
            });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            return;
        }

        if (subcommand === 'status') {
            const channel = gameUpdates.channelId
                ? guild.channels.cache.get(gameUpdates.channelId)
                : null;

            const embed = createEmbed({
                title: '📰 Game news status',
                color: 'info',
                fields: [
                    {
                        name: 'Enabled',
                        value: gameUpdates.enabled ? '✅ Oui' : '❌ Non',
                        inline: true,
                    },
                    {
                        name: 'Channel',
                        value: channel ? `${channel}` : 'Aucun',
                        inline: true,
                    },
                ],
            });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            return;
        }

        if (subcommand === 'disable') {
            await updateGuildConfig(client, guild.id, {
                gameUpdates: {
                    enabled: false,
                    channelId: null,
                    lastGuid: null,
                },
            });

            const embed = createEmbed({
                title: 'Game news disabled',
                description: 'Les mises à jour d\'**Animal Company** ne seront plus postées.',
                color: 'warning',
            });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            return;
        }
    },
};