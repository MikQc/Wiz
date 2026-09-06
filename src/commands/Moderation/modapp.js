import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from '../../services/config/guildConfig.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, replyUserError, handleInteractionError } from '../../utils/errorHandler.js';
import { logEvent, EVENT_TYPES } from '../../services/loggingService.js';
import { formatLogLine } from '../../utils/logging/logEmbeds.js';

const MOD_APPLICATION_KEY = 'modApplication';

const DEFAULT_QUESTIONS = [
    'How old are you?',
    'Do you have any moderation experience?',
    'Why do you want to become a moderator here?',
    'How much time can you give per week?',
];

const MAX_QUESTIONS = 5;
const QUESTION_SEPARATOR = '|';
const DEFAULT_LINK_LABEL = 'Apply here';

function normalizeModApplication(raw) {
    return {
        enabled: Boolean(raw?.enabled),
        channelId: raw?.channelId ?? null,
        responsesChannelId: raw?.responsesChannelId ?? raw?.channelId ?? null,
        panelMessageId: raw?.panelMessageId ?? null,
        linkUrl: raw?.linkUrl ?? null,
        linkLabel: raw?.linkLabel ?? DEFAULT_LINK_LABEL,
        questions: Array.isArray(raw?.questions) && raw.questions.length > 0
            ? raw.questions.map(String).slice(0, MAX_QUESTIONS)
            : DEFAULT_QUESTIONS,
    };
}

function parseQuestionsInput(raw) {
    if (!raw || !String(raw).trim()) return null;
    const questions = String(raw)
        .split(QUESTION_SEPARATOR)
        .map((q) => q.trim())
        .filter(Boolean)
        .slice(0, MAX_QUESTIONS);
    return questions.length > 0 ? questions : null;
}

function isValidUrl(raw) {
    try {
        const parsed = new URL(String(raw));
        return ['http:', 'https:'].includes(parsed.protocol);
    } catch {
        return false;
    }
}

function buildQuestionsDisplay(questions) {
    return questions
        .map((q, i) => `**${i + 1}.** ${q}`)
        .join('\n\n');
}

function buildPanelEmbed(guild, cfg) {
    const { linkUrl, linkLabel } = cfg;

    const embed = new EmbedBuilder()
        .setColor(getColor('primary'))
        .setTitle('📋 Moderator Application')
        .setDescription(
            `We are looking for moderators for **${guild.name}**.\n\n` +
            (linkUrl
                ? `### 🔗 ${linkLabel}\nClick the link below or press **Apply** to submit your application.\n\n`
                : `Click **Apply** below to answer the questions. Our team will review your answers.\n\n`) +
            buildQuestionsDisplay(cfg.questions)
        )
        .setFooter({ text: 'Your answers are reviewed by the moderation team.' })
        .setTimestamp();

    if (linkUrl) {
        embed.addFields({ name: 'Another way to apply', value: `${linkLabel}: ${linkUrl}` });
    }

    return embed;
}

export default {
    data: new SlashCommandBuilder()
        .setName('modapp')
        .setDescription('Moderator application panel')
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Create the application panel in a channel')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('Channel to show the application panel in')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true))
                .addChannelOption(option =>
                    option.setName('responses')
                        .setDescription('Channel where submitted applications are received')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('link')
                        .setDescription('Optional external link to show in the panel (e.g. Google Form)')
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('link_label')
                        .setDescription(`Text shown for the external link (default: "${DEFAULT_LINK_LABEL}")`)
                        .setRequired(false))
                .addStringOption(option =>
                    option.setName('questions')
                        .setDescription(`Questions separated by "${QUESTION_SEPARATOR}" (max ${MAX_QUESTIONS})`)
                        .setRequired(false)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('disable')
                .setDescription('Remove the application panel and disable the system'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show the moderator application configuration')),

    async execute(interaction) {
        const deferSuccess = await InteractionHelper.safeDefer(interaction);
        if (!deferSuccess) {
            logger.warn(`ModApp interaction defer failed`, {
                userId: interaction.user.id,
                guildId: interaction.guildId,
                commandName: 'modapp'
            });
            return;
        }

        const { options, guild, client } = interaction;
        const subcommand = options.getSubcommand();
        const isStaff = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

        if (subcommand === 'setup') {
            if (!isStaff) {
                return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the **Manage Server** permission to use `/modapp setup`.' });
            }

            const channel = options.getChannel('channel');
            const responsesChannel = options.getChannel('responses') ?? channel;
            const questionsOption = options.getString('questions');
            const linkOpt = options.getString('link');
            const linkLabelOpt = options.getString('link_label');

            if (linkOpt && !isValidUrl(linkOpt)) {
                return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: 'The link must be a valid **http://** or **https://** URL.' });
            }

            const existing = normalizeModApplication((await getGuildConfig(client, guild.id))?.[MOD_APPLICATION_KEY]);
            const questions = parseQuestionsInput(questionsOption) ?? existing.questions;
            const linkUrl = linkOpt ?? existing.linkUrl ?? null;
            const linkLabel = linkLabelOpt ?? existing.linkLabel ?? DEFAULT_LINK_LABEL;

            const me = guild.members.me;
            const panelPerms = channel.permissionsFor(me);
            if (!panelPerms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
                return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: `I need **View Channel**, **Send Messages** and **Embed Links** permissions in ${channel}.` });
            }

            const responsesPerms = responsesChannel.permissionsFor(me);
            if (!responsesPerms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
                return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: `I need **View Channel**, **Send Messages** and **Embed Links** permissions in ${responsesChannel}.` });
            }

            try {
                const applyButton = new ButtonBuilder()
                    .setCustomId('modapp_apply')
                    .setLabel('Apply')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('📝');

                const rowComponents = [applyButton];

                if (linkUrl) {
                    rowComponents.push(
                        new ButtonBuilder()
                            .setLabel(linkLabel.length > 80 ? linkLabel.substring(0, 77) + '…' : linkLabel)
                            .setStyle(ButtonStyle.Link)
                            .setURL(linkUrl)
                    );
                }

                const row = new ActionRowBuilder().addComponents(rowComponents);

                const panelMessage = await channel.send({
                    embeds: [buildPanelEmbed(guild, { ...existing, questions, enabled: true, linkUrl, linkLabel })],
                    components: [row],
                });

                if (existing.panelMessageId) {
                    try {
                        const oldChannel = guild.channels.cache.get(existing.channelId);
                        const oldMessage = oldChannel?.messages.cache.get(existing.panelMessageId)
                            || (oldChannel ? await oldChannel.messages.fetch(existing.panelMessageId).catch(() => null) : null);
                        if (oldMessage) {
                            await oldMessage.delete().catch(() => {});
                        }
                    } catch (error) {
                        logger.debug('ModApp: could not delete old panel message:', error.message);
                    }
                }

                await updateGuildConfig(client, guild.id, {
                    [MOD_APPLICATION_KEY]: {
                        enabled: true,
                        channelId: channel.id,
                        responsesChannelId: responsesChannel.id,
                        panelMessageId: panelMessage.id,
                        linkUrl,
                        linkLabel,
                        questions,
                    }
                });

                logger.info(`[ModApp] Panel created by ${interaction.user.tag} for guild ${guild.name} (${guild.id})`);

                const embed = new EmbedBuilder()
                    .setColor(getColor('success'))
                    .setTitle('Moderator Application Panel Created')
                    .setDescription(`The application panel is now visible in ${channel}.`)
                    .addFields(
                        { name: 'Panel Channel', value: `${channel.toString()}`, inline: true },
                        { name: 'Responses Channel', value: `${responsesChannel.toString()}`, inline: true },
                        { name: 'Questions', value: `${questions.length} question(s)`, inline: true },
                        { name: 'External Link', value: linkUrl ? `${linkLabel}: ${linkUrl}` : '`None`', inline: false },
                        { name: 'Status', value: '✅ Enabled', inline: true },
                    );

                await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            } catch (error) {
                logger.error(`[ModApp] Setup failed for guild ${guild.id}:`, error);
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while creating the application panel.' });
            }
            return;
        }

        if (subcommand === 'disable') {
            if (!isStaff) {
                return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the **Manage Server** permission to use `/modapp disable`.' });
            }

            try {
                const existing = normalizeModApplication((await getGuildConfig(client, guild.id))?.[MOD_APPLICATION_KEY]);

                if (existing.channelId && existing.panelMessageId) {
                    const channel = guild.channels.cache.get(existing.channelId);
                    const message = channel
                        ? (channel.messages.cache.get(existing.panelMessageId)
                            || await channel.messages.fetch(existing.panelMessageId).catch(() => null))
                        : null;
                    if (message) {
                        await message.delete().catch(() => {});
                    }
                }

                await updateGuildConfig(client, guild.id, {
                    [MOD_APPLICATION_KEY]: { ...existing, enabled: false, channelId: null, responsesChannelId: null, panelMessageId: null }
                });

                const embed = new EmbedBuilder()
                    .setColor(getColor('error'))
                    .setTitle('Moderator Application Disabled')
                    .setDescription('The application panel was removed.');

                await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            } catch (error) {
                logger.error(`[ModApp] Disable failed for guild ${guild.id}:`, error);
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while disabling the application system.' });
            }
            return;
        }

        if (subcommand === 'status') {
            const cfg = normalizeModApplication((await getGuildConfig(client, guild.id))?.[MOD_APPLICATION_KEY]);

            const embed = new EmbedBuilder()
                .setColor(getColor(cfg.enabled ? 'success' : 'primary'))
                .setTitle('Moderator Application Status')
                .addFields(
                    { name: 'Status', value: cfg.enabled ? '✅ **Enabled**' : '❌ **Disabled**', inline: true },
                    { name: 'Panel Channel', value: cfg.channelId ? `<#${cfg.channelId}>` : '`Not set`', inline: true },
                    { name: 'Responses Channel', value: cfg.responsesChannelId ? `<#${cfg.responsesChannelId}>` : '`Not set`', inline: true },
                );

            if (cfg.linkUrl) {
                embed.addFields({ name: 'External Link', value: `${cfg.linkLabel}: ${cfg.linkUrl}` });
            }

            if (cfg.enabled && cfg.questions.length > 0) {
                embed.addFields({ name: 'Questions', value: buildQuestionsDisplay(cfg.questions).substring(0, 1024) });
            }

            embed.setFooter({ text: 'Use /modapp setup to reconfigure the panel.' });

            await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
        }
    },
};

export async function handleModAppButton(interaction, client) {
    try {
        await InteractionHelper.safeDefer(interaction, { ephemeral: true });

        if (!interaction.guild) {
            return await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'This button can only be used in a server.' });
        }

        const cfg = normalizeModApplication((await getGuildConfig(client, interaction.guild.id))?.[MOD_APPLICATION_KEY]);

        if (!cfg.enabled) {
            return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: 'Moderator applications are not open right now.' });
        }

        const modal = new ModalBuilder()
            .setCustomId('modapp_modal')
            .setTitle('Moderator Application');

        cfg.questions.forEach((question, index) => {
            const input = new TextInputBuilder()
                .setCustomId(`q${index}`)
                .setLabel(question.length > 45 ? `${question.substring(0, 42)}...` : question)
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(1000);

            modal.addComponents(new ActionRowBuilder().addComponents(input));
        });

        await interaction.showModal(modal);
    } catch (error) {
        logger.error('ModApp: button handler error:', error);
        await handleInteractionError(interaction, error, { command: 'modapp_apply', action: 'open_modal' });
    }
}

export async function handleModAppModal(interaction) {
    if (!interaction.isModalSubmit() || interaction.customId !== 'modapp_modal') return;

    const { guild, user, client } = interaction;

    const cfg = normalizeModApplication((await getGuildConfig(client, guild.id))?.[MOD_APPLICATION_KEY]);

    if (!cfg.enabled || !cfg.responsesChannelId) {
        return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: 'Moderator applications are not open right now.' });
    }

    const channel = guild.channels.cache.get(cfg.responsesChannelId)
        || await guild.channels.fetch(cfg.responsesChannelId).catch(() => null);
    if (!channel?.isTextBased()) {
        return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: 'The configured application response channel no longer exists.' });
    }

    const answers = cfg.questions.map((question, index) => ({
        question,
        answer: interaction.fields.getTextInputValue(`q${index}`),
    }));

    const embed = new EmbedBuilder()
        .setColor(getColor('info'))
        .setTitle('New Moderator Application')
        .setAuthor({ name: user.tag, iconURL: user.displayAvatarURL() })
        .setDescription(`**Applicant:** ${user.toString()} (\`${user.id}\`)\n**Submitted:** <t:${Math.floor(Date.now() / 1000)}:R>`)
        .setTimestamp();

    answers.forEach(({ question, answer }, index) => {
        embed.addFields({ name: `${index + 1}. ${question}`, value: answer.length > 1024 ? answer.substring(0, 1020) + '…' : answer });
    });

    try {
        await channel.send({ embeds: [embed] });

        const confirmation = new EmbedBuilder()
            .setColor(getColor('success'))
            .setTitle('Application Submitted')
            .setDescription('Your application has been sent to the team. We will get back to you soon!');

        await InteractionHelper.safeEditReply(interaction, { embeds: [confirmation], ephemeral: true });
    } catch (error) {
        logger.error('ModApp: failed to send application:', error);
        await replyUserError(interaction, { type: ErrorTypes.INTERNAL, message: 'Your application could not be sent. Please try again later.' });
    }

    try {
        await logEvent({
            client,
            guildId: guild.id,
            eventType: EVENT_TYPES.APPLICATION_SUBMIT,
            data: {
                title: 'Moderator Application Submitted',
                lines: [
                    formatLogLine('Applicant', `${user.toString()} (${user.tag})`),
                    formatLogLine('Channel', `<#${cfg.responsesChannelId}>`),
                ],
                author: user.displayAvatarURL(),
            },
        });
    } catch (error) {
        logger.debug('ModApp: logging event failed:', error.message);
    }
}