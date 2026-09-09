// setupConfirm.js
// Helper to send an ephemeral confirmation message with a Dismiss button
// (only visible to the command author). Used by setup/configuration commands.

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { InteractionHelper } from './interactionHelper.js';

export const DISMISS_BASE_NAME = 'dismiss';

export function buildDismissButton(userId) {
    return new ButtonBuilder()
        .setCustomId(`${DISMISS_BASE_NAME}:${userId}`)
        .setLabel('Dismiss')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('❌');
}

export function buildDismissRow(userId) {
    return new ActionRowBuilder().addComponents(buildDismissButton(userId));
}

export async function sendSetupConfirmation(interaction, options = {}) {
    const { flags, components, ...rest } = options;
    const dismissRow = buildDismissRow(interaction.user.id);
    const mergedComponents = components ? [...components, dismissRow] : [dismissRow];

    return InteractionHelper.safeReply(interaction, {
        ...rest,
        components: mergedComponents,
        flags: flags ?? MessageFlags.Ephemeral,
    });
}

export default {
    DISMISS_BASE_NAME,
    buildDismissButton,
    buildDismissRow,
    sendSetupConfirmation,
};