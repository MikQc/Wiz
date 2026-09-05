import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { createEmbed, successEmbed, errorEmbed } from '../../utils/embeds.js';
import { sanitizeMarkdown } from '../../utils/validation.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

const SEND_DELAY_MS = 1100;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendWithRetry(user, payload, attempt = 0) {
    try {
        const dmChannel = await user.createDM();
        await dmChannel.send(payload);
        return { ok: true };
    } catch (error) {
        if (error.code === 50007 || error.code === 50013) {
            return { ok: false, reason: 'closed', error };
        }
        if (error.code === 429 && attempt < 2) {
            const retryAfter = Number(error.retryAfter ?? error.retry_after) || 15000;
            await sleep(retryAfter);
            return sendWithRetry(user, payload, attempt + 1);
        }
        return { ok: false, reason: 'other', error };
    }
}

export default {
    data: new SlashCommandBuilder()
        .setName("broadcast")
        .setDescription("Send a direct message to every member of a server (Staff only)")
        .addStringOption(option =>
            option
                .setName("message")
                .setDescription("The message to send to everyone")
                .setRequired(true)
                .setMaxLength(2000)
        )
        .addStringOption(option =>
            option
                .setName("server")
                .setDescription("The server to broadcast to (defaults to this server)")
                .setRequired(false)
                .setAutocomplete(true)
        )
        .addBooleanOption(option =>
            option
                .setName("anonymous")
                .setDescription("Send anonymously (default: false)")
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),
    category: "moderation",

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);

        if (focused.name !== 'server') {
            return interaction.respond([]);
        }

        const query = focused.value.toLowerCase() || '';

        const choices = [...interaction.client.guilds.cache.values()]
            .filter((guild) => guild.name.toLowerCase().includes(query))
            .slice(0, 25)
            .map((guild) => ({
                name: `${guild.name} (${guild.memberCount} members)`,
                value: guild.id,
            }));

        return interaction.respond(choices);
    },

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`Broadcast interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'broadcast'
            });
            return;
        }

        const message = interaction.options.getString("message");
        const anonymous = interaction.options.getBoolean("anonymous") || false;
        const serverId = interaction.options.getString("server");

        const targetGuild = serverId
            ? interaction.client.guilds.cache.get(serverId)
            : interaction.guild;

        if (!targetGuild) {
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'That server could not be found. The bot may not be in it.' });
        }

        if (!message || message.trim().length === 0) {
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'Please provide a message to broadcast.' });
        }

        const sanitized = sanitizeMarkdown(message.trim());

        let members = [];
        try {
            const fetched = await targetGuild.members.fetch();
            members = [...fetched.values()].filter((member) => !member.user.bot);
        } catch (error) {
            logger.error('Broadcast: could not fetch members:', error);
            return await replyUserError(interaction, { type: ErrorTypes.INTERNAL, message: 'Could not fetch server members. Check my permissions.' });
        }

        if (members.length === 0) {
            return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'There are no members to message in this server.' });
        }

        const payload = {
            embeds: [
                successEmbed(
                    anonymous ? "Announcement from this server" : `Message from ${interaction.user.tag}`,
                    sanitized
                ).setFooter({
                    text: 'You cannot reply to this message.'
                })
            ]
        };

        const maxVisibleMembers = 100;

        if (members.length > maxVisibleMembers) {
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [
createEmbed({ title: 'Broadcast Started 📣', description:
                            `Sending a message to **${members.length}** members of **${targetGuild.name}**.\n\n` +
                            `Discord rate-limits DMs, so this will take roughly ` +
                            `**${Math.ceil((members.length * SEND_DELAY_MS) / 60000)}** minute(s).\n\n` +
                            `Progress updates will appear here.`
                    })
                ],
            });
        }

        let sent = 0;
        let closed = 0;
        let other = 0;
        let processed = 0;

        const total = members.length;

        for (const member of members) {
            const result = await sendWithRetry(member.user, payload);

            if (result.ok) {
                sent++;
            } else if (result.reason === 'closed') {
                closed++;
            } else {
                other++;
            }

            processed++;

            if (total > maxVisibleMembers && (processed % 10 === 0)) {
                await InteractionHelper.safeEditReply(interaction, {
                    embeds: [
createEmbed({ title: 'Broadcast In Progress 📣', description:
                                `**${processed}/${total}** processed.\n` +
                                `✅ **${sent}** sent\n` +
                                `🚫 **${closed}** blocked DMs\n` +
                                `❌ **${other}** failed`
                        })
                    ],
                }).catch(() => {});
            }

            await sleep(SEND_DELAY_MS);
        }

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
createEmbed({ title: 'Broadcast Complete 📣', description:
                        `Finished messaging **${total}** members.\n\n` +
                        `✅ **${sent}** message(s) sent\n` +
                        `🚫 **${closed}** member(s) have DMs closed or blocked\n` +
                        `❌ **${other}** message(s) failed`
                })
            ],
        });

logger.info('Broadcast completed', {
            userId: interaction.user.id,
            guildId: interaction.guildId,
            targetGuildId: targetGuild.id,
            targetGuildName: targetGuild.name,
            anonymous,
            total,
            sent,
            closed,
            other
        });
    }
};
