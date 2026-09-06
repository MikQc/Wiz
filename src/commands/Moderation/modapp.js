import { getColor } from '../../config/bot.js';
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder } from 'discord.js';
import { getGuildConfig, updateGuildConfig } from '../../services/config/guildConfig.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { logEvent, EVENT_TYPES, resolveApplicationLogChannel } from '../../services/loggingService.js';
import { formatLogLine } from '../../utils/logging/logEmbeds.js';

const MOD_APPLICATION_KEY = 'modApplication';

const DEFAULT_QUESTIONS = [
    'How old are you?',
    'Do you have any moderation experience? (other servers, forums, etc.)',
    'Why do you want to become a moderator here?',
    'How much time can you give per week? What is your timezone?',
];

function normalizeModApplication(raw) {
    return {
        enabled: Boolean(raw?.enabled),
        channelId: raw?.channelId ?? null,
        questions: Array.isArray(raw?.questions) && raw.questions.length > 0
            ? raw.questions.map(String).slice(0, 5)
            : DEFAULT_QUESTIONS,
    };
}

function buildConfigEmbed(guild, cfg) {
    return new EmbedBuilder()
        .setColor(getColor(cfg.enabled ? 'success' : 'primary'))
        .setTitle('Moderator Application')
        .addFields(
            { name: 'Status', value: cfg.enabled ? '✅ **Enabled**' : '❌ **Disabled**', inline: true },
            { name: 'Submission Channel', value: cfg.channelId ? `<#${cfg.channelId}>` : '`Not set`', inline: true },
            { name: 'Questions', value: `${cfg.questions.length} question(s)` },
        )
        .setFooter({ text: 'Use /modapp setup to configure, /modapp submit to apply.' });
}

export default {
    data: new SlashCommandBuilder()
        .setName('modapp')
        .setDescription('Moderator application system')
        .addSubcommand(subcommand =>
            subcommand
                .setName('setup')
                .setDescription('Set the channel where applications are received')
                .addChannelOption(option =>
                    option.setName('channel')
                        .setDescription('Channel to receive moderator applications')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(true)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('disable')
                .setDescription('Disable the moderator application system'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('status')
                .setDescription('Show the moderator application configuration'))
        .addSubcommand(subcommand =>
            subcommand
                .setName('submit')
                .setDescription('Submit a moderator application')),

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
            const me = guild.members.me;
            const perms = channel.permissionsFor(me);
            if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
                return await replyUserError(interaction, { type: ErrorTypes.VALIDATION, message: `I need **View Channel**, **Send Messages** and **Embed Links** permissions in ${channel}.` });
            }

            try {
                const current = await getGuildConfig(client, guild.id);
                const cfg = normalizeModApplication(current?.[MOD_APPLICATION_KEY]);
                await updateGuildConfig(client, guild.id, {
                    [MOD_APPLICATION_KEY]: {
                        ...cfg,
                        enabled: true,
                        channelId: channel.id,
                    }
                });

                logger.info(`[ModApp] Setup by ${interaction.user.tag} for guild ${guild.name} (${guild.id})`);

                const embed = new EmbedBuilder()
                    .setColor(getColor('success'))
                    .setTitle('Moderator Application Configured')
                    .setDescription(`Applications will now be received in ${channel}\nMembers apply with \`/modapp submit\`.`)
                    .addFields({ name: 'Questions', value: `${cfg.questions.length} question(s)` });

                await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            } catch (error) {
                logger.error(`[ModApp] Setup failed for guild ${guild.id}:`, error);
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while configuring the application system.' });
            }
            return;
        }

        if (subcommand === 'disable') {
            if (!isStaff) {
                return await replyUserError(interaction, { type: ErrorTypes.PERMISSION, message: 'You need the **Manage Server** permission to use `/modapp disable`.' });
            }

            try {
                const current = await getGuildConfig(client, guild.id);
                const cfg = normalizeModApplication(current?.[MOD_APPLICATION_KEY]);
                await updateGuildConfig(client, guild.id, {
                    [MOD_APPLICATION_KEY]: { ...cfg, enabled: false }
                });

                const embed = new EmbedBuilder()
                    .setColor(getColor('error'))
                    .setTitle('Moderator Application Disabled')
                    .setDescription('Members can no longer submit moderator applications.');

                await InteractionHelper.safeEditReply(interaction, { embeds: [embed] });
            } catch (error) {
                logger.error(`[ModApp] Disable failed for guild ${guild.id}:`, error);
                await replyUserError(interaction, { type: ErrorTypes.UNKNOWN, message: 'An error occurred while disabling the application system.' });
            }
            return;
        }

        if (subcommand === 'status') {
            const cfg = normalizeModApplication((await getGuildConfig(client, guild.id))?.[MOD_APPLICATION_KEY]);
            await InteractionHelper.safeEditReply(interaction, { embeds: [buildConfigEmbed(guild, cfg)] });
            return;
        }

        if (subcommand === 'submit') {
            const cfg = normalizeModApplication((await getGuildConfig(client, guild.id))?.[MOD_APPLICATION_KEY]);

            if (!cfg.enabled || !cfg.channelId) {
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
        }
    },
};

export async function handleModAppModal(interaction) {
    if (!interaction.isModalSubmit() || interaction.customId !== 'modapp_modal') return;

    const { guild, user, client } = interaction;

    const cfg = normalizeModApplication((await getGuildConfig(client, guild.id))?.[MOD_APPLICATION_KEY]);

    if (!cfg.enabled || !cfg.channelId) {
        return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: 'Moderator applications are not open right now.' });
    }

    const channel = guild.channels.cache.get(cfg.channelId);
    if (!channel?.isTextBased()) {
        return await replyUserError(interaction, { type: ErrorTypes.CONFIGURATION, message: 'The configured application channel no longer exists.' });
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
        .setFooter({ text: 'Review the answers above.' })
        .setTimestamp();

    answers.forEach(({ question, answer }, index) => {
        embed.addFields({ name: `${index + 1}. ${question}`, value: answer.length > 1024 ? answer.substring(0, 1020) + '…' : answer });
    });

    try {
        await channel.send({ embeds: [embed] });

        const confirmation = new EmbedBuilder()
            .setColor(getColor('success'))
            .setTitle('Application Submitted')
            .setDescription(`Your application has been sent to the team. We will get back to you soon!\n\n**Please do not message staff about your application.**`);

        await InteractionHelper.safeEditReply(interaction, { embeds: [confirmation], flags: ['Ephemeral'] });
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
                    formatLogLine('Channel', `<#${cfg.channelId}>`),
                ],
                author: user.displayAvatarURL(),
            },
        });
    } catch (error) {
        logger.debug('ModApp: logging event failed:', error.message);
    }
}