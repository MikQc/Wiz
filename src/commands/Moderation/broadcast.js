import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, formatProgressBar, formatDuration } from '../../utils/embeds.js';
import { sanitizeMarkdown } from '../../utils/validation.js';
import { logger } from '../../utils/logger.js';

import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';

const PARALLEL_BATCH = 3;
const MAX_RETRY_ATTEMPTS = 3;
const PROGRESS_UPDATE_MIN_MS = 2500;
const RATE_CAPACITY = 6;
const RATE_REFILL_PER_SECOND = 3;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

class RateBucket {
    constructor(capacity = RATE_CAPACITY, refillPerSecond = RATE_REFILL_PER_SECOND) {
        this.capacity = capacity;
        this.tokens = capacity;
        this.refillPerSecond = refillPerSecond;
        this.last = Date.now();
    }

    async consume() {
        while (true) {
            const now = Date.now();
            this.tokens = Math.min(
                this.capacity,
                this.tokens + (((now - this.last) / 1000) * this.refillPerSecond)
            );
            this.last = now;

            if (this.tokens >= 1) {
                this.tokens -= 1;
                return;
            }

            const waitMs = Math.ceil(((1 - this.tokens) / this.refillPerSecond) * 1000);
            await sleep(Math.min(waitMs, 1000));
        }
    }
}

const bucket = new RateBucket();

async function sendWithRetry(user, payload, attempt = 0) {
    try {
        await bucket.consume();
        const dmChannel = await user.createDM();
        await dmChannel.send(payload);
        return { ok: true };
    } catch (error) {
        if (error.code === 50007 || error.code === 50013) {
            return { ok: false, reason: 'closed' };
        }
        if ((error.code === 429 || error.code === 500) && attempt < MAX_RETRY_ATTEMPTS) {
            const retryAfter = Number(error.retryAfter ?? error.retry_after) || 1000;
            await sleep(Math.min(retryAfter, 10000));
            return sendWithRetry(user, payload, attempt + 1);
        }
        return { ok: false, reason: 'other' };
    }
}

function sortRolesForAutocomplete(role) {
    const position = role.position;
    return (a, b) => (b.position - a.position) || (a.name.localeCompare(b.name));
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
        .addRoleOption(option =>
            option
                .setName("role")
                .setDescription("Only message members with this role")
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option
                .setName("anonymous")
                .setDescription("Send anonymously (default: false)")
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option
                .setName("preview")
                .setDescription("Preview the message on yourself before sending (default: false)")
                .setRequired(false)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .setDMPermission(false),
    category: "moderation",

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);

        if (focused.name === 'server') {
            const query = focused.value.toLowerCase() || '';

            const choices = [...interaction.client.guilds.cache.values()]
                .filter((guild) => guild.name.toLowerCase().includes(query))
                .slice(0, 25)
                .map((guild) => ({
                    name: `${guild.name} (${guild.memberCount} members)`,
                    value: guild.id,
                }));

            return interaction.respond(choices);
        }

        if (focused.name === 'role') {
            const query = focused.value.toLowerCase() || '';
            const guild = interaction.guild;
            if (!guild) {
                return interaction.respond([]);
            }

            const choices = [...guild.roles.cache.values()]
                .sort(sortRolesForAutocomplete())
                .filter((role) => role.name.toLowerCase().includes(query))
                .slice(0, 25)
                .map((role) => ({
                    name: `${role.name} (${role.members.size} members)`,
                    value: role.id,
                }));

            return interaction.respond(choices);
        }

        return interaction.respond([]);
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
        const preview = interaction.options.getBoolean("preview") || false;
        const serverId = interaction.options.getString("server");
        const roleId = interaction.options.getRole("role")?.id || null;

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
            return await replyUserError(interaction, { type: ErrorTypes.INTERNAL, message: 'Could not fetch server members. Check my permissions and that the Server Members Intent is enabled.' });
        }

        if (roleId) {
            const role = targetGuild.roles.cache.get(roleId);
            if (!role) {
                return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'That role could not be found in the target server.' });
            }
            members = members.filter((member) => member.roles.cache.has(roleId));
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

        if (preview) {
            try {
                await interaction.user.send(payload);
            } catch (error) {
                return await replyUserError(interaction, { type: ErrorTypes.INTERNAL, message: 'Preview failed — I could not DM you. Enable your DMs and try again.' });
            }

            return await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    createEmbed({
                        title: 'Preview Sent ✅',
                        description: `I DM\'d you the exact message.\n\nIt would have been sent to **${members.length}** member(s) of **${targetGuild.name}**${roleId ? ` with the role **${targetGuild.roles.cache.get(roleId)?.name || 'selected'}**` : ''}.`,
                    })
                ],
            });
        }

        const total = members.length;
        const maxVisibleMembers = 100;

        if (total > maxVisibleMembers) {
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    createEmbed({
                        title: 'Broadcast Started 📣',
                        description:
                            `Sending a message to **${members.length}** members of **${targetGuild.name}**.\n\n` +
                            `Estimated time: ~**${formatDuration(Math.ceil((members.length / RATE_REFILL_PER_SECOND) * 1000))}**.\n\n` +
                            `Progress updates will appear here.`
                    })
                ],
            });
        }

        const startedAt = Date.now();

        let sent = 0;
        let closed = 0;
        let other = 0;
        let processed = 0;
        let lastProgressUpdate = 0;

        const queue = [...members];

        const updateProgress = async () => {
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [
                    createEmbed({
                        title: 'Broadcast In Progress 📣',
                        description:
                            `${formatProgressBar(processed, total)}\n` +
                            `**${processed}/${total}** processed.\n` +
                            `✅ **${sent}** sent\n` +
                            `🚫 **${closed}** blocked DMs\n` +
                            `❌ **${other}** failed`
                    })
                ],
            }).catch(() => {});
        };

        async function worker() {
            while (queue.length > 0) {
                const member = queue.shift();
                if (!member) return;

                const result = await sendWithRetry(member.user, payload);

                if (result.ok) {
                    sent++;
                } else if (result.reason === 'closed') {
                    closed++;
                } else {
                    other++;
                }

                processed++;

                const now = Date.now();
                if (total > maxVisibleMembers && now - lastProgressUpdate >= PROGRESS_UPDATE_MIN_MS) {
                    lastProgressUpdate = now;
                    await updateProgress();
                }
            }
        }

        await Promise.all(
            Array.from({ length: Math.min(PARALLEL_BATCH, queue.length) }, () => worker())
        );

        await InteractionHelper.safeEditReply(interaction, {
            embeds: [
                createEmbed({
                    title: 'Broadcast Complete 📣',
                    description:
                        `Finished messaging **${total}** member(s).\n\n` +
                        `✅ **${sent}** message(s) sent\n` +
                        `🚫 **${closed}** member(s) have DMs closed or blocked\n` +
                        `❌ **${other}** message(s) failed\n\n` +
                        `⏱️ **${formatDuration(Date.now() - startedAt)}** elapsed`
                })
            ],
        });

        interaction.user.send({
            embeds: [
                infoEmbed(
                    `📣 Broadcast Report — ${targetGuild.name}`,
                    `**${total}** targeted • ✅ **${sent}** sent • 🚫 **${closed}** blocked DMs • ❌ **${other}** failed`
                )
            ]
        }).catch(() => {});

        logger.info('Broadcast completed', {
            userId: interaction.user.id,
            guildId: interaction.guildId,
            targetGuildId: targetGuild.id,
            targetGuildName: targetGuild.name,
            anonymous,
            preview,
            roleId,
            total,
            sent,
            closed,
            other
        });
    }
};