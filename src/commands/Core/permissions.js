import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { getColor } from '../../config/bot.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { getGuildConfig } from '../../services/config/guildConfig.js';

const PERMISSION_NAMES = new Map([
    [PermissionFlagsBits.Administrator, 'Administrator'],
    [PermissionFlagsBits.KickMembers, 'Kick Members'],
    [PermissionFlagsBits.BanMembers, 'Ban Members'],
    [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
    [PermissionFlagsBits.ManageGuild, 'Manage Server'],
    [PermissionFlagsBits.ViewAuditLog, 'View Audit Log'],
    [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
    [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
    [PermissionFlagsBits.ManageWebhooks, 'Manage Webhooks'],
    [PermissionFlagsBits.ManageGuildExpressions, 'Manage Expressions'],
    [PermissionFlagsBits.ModerateMembers, 'Time Out Members'],
]);

function permissionNames(bitfield) {
    if (bitfield == null || bitfield === '0') return null;
    const names = [];
    for (const [flag, label] of PERMISSION_NAMES.entries()) {
        if ((BigInt(bitfield) & flag) === flag) {
            names.push(label);
        }
    }
    return names.length > 0 ? names : [`Bitfield ${bitfield}`];
}

function roleHasPermission(role, permission) {
    if (!role) return false;
    if (role.id === role.guild.id) {
        return role.permissions.has(permission);
    }
    return role.permissions.has([PermissionFlagsBits.Administrator, permission]);
}

function findManageServerRoles(guild) {
    const roles = [];

    for (const role of guild.roles.cache.values()) {
        if (role.id === guild.id) {
            const isEnabled = role.permissions.has([PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild]);
            roles.push({ role, isEnabled, isEveryone: true });
        } else if (roleHasPermission(role, PermissionFlagsBits.ManageGuild)) {
            roles.push({ role, isEnabled: true, isEveryone: false });
        }
    }

    return roles.filter(r => r.isEnabled);
}

function countRoleMembers(guild, roleId) {
    let count = 0;
    for (const member of guild.members.cache.values()) {
        if (member.roles.cache.has(roleId)) {
            count += 1;
            if (count >= 50) break;
        }
    }
    return count;
}

function buildPermissionLabels(requiredPermissions, commandCategory) {
    if (requiredPermissions == null) {
        return { badge: '🟢 Public', text: 'No permission required' };
    }
    const names = permissionNames(requiredPermissions);
    return {
        badge: '🔒 Staff',
        text: names ? names.join(', ') : `Bitfield ${requiredPermissions}`,
    };
}

function collectCommandPermissionInfo(client) {
    const publicCommands = [];
    const staffCommands = [];

    for (const command of client.commands.values()) {
        const json = command.data?.toJSON?.() ?? command.data;
        const permissions = json?.default_member_permissions;

        if (permissions == null || permissions === '0') {
            publicCommands.push({ name: command.data?.name ?? 'unknown', category: command.category ?? '?' });
        } else {
            staffCommands.push({
                name: command.data?.name ?? 'unknown',
                category: command.category ?? '?',
                permissions,
            });
        }
    }

    publicCommands.sort((a, b) => a.name.localeCompare(b.name));
    staffCommands.sort((a, b) => a.name.localeCompare(b.name));

    return { publicCommands, staffCommands };
}

export default {
    data: new SlashCommandBuilder()
        .setName('permissions')
        .setDescription('Audit who can use bot commands and which commands are restricted')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(subcommand =>
            subcommand
                .setName('staff')
                .setDescription('Show roles/members that have Manage Server (can run admin commands)'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('commands')
                .setDescription('Show which commands need permissions and which are open to everyone')),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`Permissions interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'permissions'
            });
            return;
        }

        const { options, guild, client } = interaction;
        const subcommand = options.getSubcommand();

        if (subcommand === 'staff') {
            const manageServerRoles = findManageServerRoles(guild);

            const embed = new EmbedBuilder()
                .setColor(getColor('info'))
                .setTitle('👥 Staff / Manage Server')
                .setDescription('These roles can run **all** admin commands (`/configwizard`, `/welcome setup`, `/roles`, `/joinping`, etc.) because they have **Manage Server** (or Administrator).')
                .setTimestamp();

            if (manageServerRoles.length === 0) {
                embed.setDescription('No role grants **Manage Server** currently. Only the server owner runs admin commands.');
            } else {
                manageServerRoles.forEach(({ role, isEveryone }) => {
                    const memberCount = isEveryone ? guild.memberCount : countRoleMembers(guild, role.id);
                    const everyoneNote = isEveryone ? ' — ⚠️ @everyone' : ` (\`${role.id}\`)`;
                    embed.addFields({
                        name: `@${role.name}${everyoneNote}`,
                        value: isEveryone
                            ? `**${guild.memberCount}** members — this means EVERYONE has Manage Server!`
                            : `**${memberCount}+** member(s) with this role`,
                    });
                });
            }

            const adminRoles = guild.roles.cache.filter(r => r.permissions.has(PermissionFlagsBits.Administrator)).toJSON();

            if (adminRoles.length > 0) {
                const adminList = adminRoles
                    .map(r => `@${r.name}`)
                    .join(', ');
                embed.addFields({ name: '✅ Administrator roles', value: adminList });
            }

            embed.setFooter({ text: 'Tip: check Server Settings → Roles to change who has these permissions.' });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            return;
        }

        if (subcommand === 'commands') {
            const { publicCommands, staffCommands } = collectCommandPermissionInfo(client);

            const embed = new EmbedBuilder()
                .setColor(getColor('info'))
                .setTitle('🛠️ Command Permissions')
                .setDescription(
                    `**${staffCommands.length}** command(s) restricted, **${publicCommands.length}** open to everyone.\n\n` +
                    '🔒 = only members with the permission (listed) can run it\n' +
                    '🟢 = anyone can run it'
                )
                .setTimestamp();

            if (staffCommands.length > 0) {
                const lines = staffCommands.map((cmd) => {
                    const names = permissionNames(cmd.permissions);
                    return `${cmd.category.toLowerCase()} /${cmd.name} — **${names ? names.join(', ') : cmd.permissions}**`;
                });
                embed.addFields({ name: `🔒 Restricted commands (${staffCommands.length})`, value: lines.join('\n').substring(0, 1024) });
            } else {
                embed.addFields({ name: '🔒 Restricted', value: 'None' });
            }

            if (publicCommands.length > 0) {
                const lines = publicCommands.map((cmd) => `${cmd.category.toLowerCase()} /${cmd.name}`);
                const chunkSize = 25;
                const chunks = [];
                for (let i = 0; i < lines.length; i += chunkSize) {
                    chunks.push(lines.slice(i, i + chunkSize));
                }
                chunks.slice(0, 4).forEach((chunk, index) => {
                    embed.addFields({ name: `🟢 Open to everyone${chunks.length > 1 ? ` (${index + 1}/${chunks.length})` : ''}`, value: chunk.join('\n').substring(0, 1024) });
                });
            } else {
                embed.addFields({ name: '🟢 Open to everyone', value: 'None' });
            }

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
        }
    },
};