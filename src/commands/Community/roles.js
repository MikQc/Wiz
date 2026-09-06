import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from '../../services/config/guildConfig.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, replyUserError } from '../../utils/errorHandler.js';

const ROLE_PANEL_KEY = 'rolePanel';
const MAX_ROLES_PER_FIELD = 40;

function normalizeRolePanel(raw) {
    return {
        enabled: Boolean(raw?.enabled),
        channelId: raw?.channelId ?? null,
        messageId: raw?.messageId ?? null,
    };
}

function sortRoles(roles, options = {}) {
    const { hideEveryone = true, hideManaged = false, hideBot = false } = options;
    return roles
        .filter((role) => !(hideEveryone && role.id === role.guild.id))
        .filter((role) => !(hideManaged && role.managed))
        .filter((role) => !(hideBot && role.tags?.botId))
        .sort((a, b) => b.position - a.position || a.id.localeCompare(b.id));
}

export function buildRolePanelEmbed(guild, { includeUpdatedAt = true } = {}) {
    const allRoles = [...guild.roles.cache.values()];
    const visibleRoles = sortRoles(allRoles, { hideEveryone: true });
    const totalRoles = visibleRoles.length;

    const embed = new EmbedBuilder()
        .setColor(getColor('info'))
        .setTitle(`🎭 Roles in ${guild.name}`)
        .setDescription(
            `There **${totalRoles === 1 ? 'is' : 'are'}** \`${totalRoles}\` role${totalRoles === 1 ? '' : 's'} in this server.`
        )
        .setTimestamp();

    if (totalRoles === 0) {
        embed.setDescription('There are no roles in this server yet.');
        embed.setFooter({ text: 'This panel updates automatically.' });
        return embed;
    }

    // Group roles into fields of up to MAX_ROLES_PER_FIELD each.
    const fieldGroups = [];
    for (let i = 0; i < visibleRoles.length; i += MAX_ROLES_PER_FIELD) {
        fieldGroups.push(visibleRoles.slice(i, i + MAX_ROLES_PER_FIELD));
    }

    fieldGroups.forEach((group, groupIndex) => {
        const lines = group.map((role) => {
            const mentions = role.mentionable ? '' : ' 🔒';
            return `${role.toString()}${mentions}`;
        });
        embed.addFields({
            name: `Roles ${groupIndex * MAX_ROLES_PER_FIELD + 1}–${groupIndex * MAX_ROLES_PER_FIELD + group.length}`,
            value: lines.join('\n'),
        });
    });

    embed.setFooter({ text: 'This panel updates automatically when roles change.' });

    return embed;
}

export async function updateRolePanel(client, guild) {
    const config = await getGuildConfig(client, guild.id);
    const panel = normalizeRolePanel(config?.[ROLE_PANEL_KEY]);

    if (!panel.enabled || !panel.channelId || !panel.messageId) return false;

    const channel = guild.channels.cache.get(panel.channelId)
        || await guild.channels.fetch(panel.channelId).catch(() => null);

    if (!channel?.isTextBased()) {
        logger.warn('RolePanel: channel not found, panel will not update:', {
            guildId: guild.id,
            channelId: panel.channelId,
        });
        return false;
    }

    const message = channel.messages.cache.get(panel.messageId)
        || await channel.messages.fetch(panel.messageId).catch(() => null);

    if (!message) {
        logger.warn('RolePanel: message not found, panel will not update:', {
            guildId: guild.id,
            messageId: panel.messageId,
        });
        return false;
    }

    await message.edit({ embeds: [buildRolePanelEmbed(guild)] }).catch((error) => {
        logger.warn('RolePanel: failed to update message:', error.message);
    });

    return true;
}

export default {
    data: new SlashCommandBuilder()
        .setName('roles')
        .setDescription('Shows a panel with all server roles that updates automatically')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Send the live role panel')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('Channel to send the role panel to (defaults to current)')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show the role panel configuration'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('disable')
                .setDescription('Remove the role panel and stop auto-updates')),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`RolePanel interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'roles'
            });
            return;
        }

        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the **Manage Server** permission to use `/roles`.' });
        }

        const { options, guild, client } = interaction;
        const subcommand = options.getSubcommand();

        if (subcommand === 'setup') {
            const channel = options.getChannel('channel') ?? interaction.channel;

            const me = guild.members.me;
            const permissions = channel.permissionsFor(me);
            if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
                return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: `I need **View Channel**, **Send Messages** and **Embed Links** permissions in ${channel}.` });
            }

            try {
                const existing = normalizeRolePanel((await getGuildConfig(client, guild.id))?.[ROLE_PANEL_KEY]);

                const panelMessage = await channel.send({ embeds: [buildRolePanelEmbed(guild)] });

                if (existing.enabled && existing.messageId && existing.channelId) {
                    try {
                        const oldChannel = guild.channels.cache.get(existing.channelId);
                        const oldMessage = oldChannel?.messages.cache.get(existing.messageId)
                            || (oldChannel ? await oldChannel.messages.fetch(existing.messageId).catch(() => null) : null);
                        if (oldMessage) {
                            await oldMessage.delete().catch(() => {});
                        }
                    } catch (error) {
                        logger.debug('RolePanel: could not delete old panel message:', error.message);
                    }
                }

                await updateGuildConfig(client, guild.id, {
                    [ROLE_PANEL_KEY]: {
                        enabled: true,
                        channelId: channel.id,
                        messageId: panelMessage.id,
                    }
                });

                logger.info(`[RolePanel] Panel created by ${interaction.user.tag} for guild ${guild.name} (${guild.id})`);

                const embed = new EmbedBuilder()
                    .setColor(getColor('success'))
                    .setTitle('🎭 Role Panel Created')
                    .setDescription(`The role panel is now visible in ${channel} and updates automatically when roles change.`)
                    .addFields(
                        { name: 'Roles Shown', value: `\`${guild.roles.cache.filter(r => r.id !== guild.id).size}\``, inline: true },
                        { name: 'Status', value: '✅ Enabled', inline: true },
                    );

                await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            } catch (error) {
                logger.error(`[RolePanel] Setup failed for guild ${guild.id}:`, error);
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while creating the role panel.' });
            }
            return;
        }

        if (subcommand === 'disable') {
            try {
                const existing = normalizeRolePanel((await getGuildConfig(client, guild.id))?.[ROLE_PANEL_KEY]);

                if (existing.enabled && existing.channelId && existing.messageId) {
                    const channel = guild.channels.cache.get(existing.channelId);
                    const message = channel
                        ? (channel.messages.cache.get(existing.messageId)
                            || await channel.messages.fetch(existing.messageId).catch(() => null))
                        : null;
                    if (message) {
                        await message.delete().catch(() => {});
                    }
                }

                await updateGuildConfig(client, guild.id, {
                    [ROLE_PANEL_KEY]: { ...existing, enabled: false, channelId: null, messageId: null }
                });

                const embed = new EmbedBuilder()
                    .setColor(getColor('error'))
                    .setTitle('🎭 Role Panel Disabled')
                    .setDescription('The role panel was removed and will no longer update.');

                await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            } catch (error) {
                logger.error(`[RolePanel] Disable failed for guild ${guild.id}:`, error);
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while disabling the role panel.' });
            }
            return;
        }

        if (subcommand === 'status') {
            const panel = normalizeRolePanel((await getGuildConfig(client, guild.id))?.[ROLE_PANEL_KEY]);

            const embed = new EmbedBuilder()
                .setColor(getColor(panel.enabled ? 'success' : 'primary'))
                .setTitle('🎭 Role Panel Status')
                .addFields(
                    { name: 'Status', value: panel.enabled ? '✅ **Enabled**' : '❌ **Disabled**', inline: true },
                    { name: 'Channel', value: panel.channelId ? `<#${panel.channelId}>` : '`Not set`', inline: true },
                    { name: 'Roles', value: `\`${guild.roles.cache.filter(r => r.id !== guild.id).size}\``, inline: true },
                )
                .setFooter({ text: 'Use /roles setup to create the panel, or /roles disable to turn it off.' });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
        }
    },
};