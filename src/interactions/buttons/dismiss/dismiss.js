// dismiss.js
// Generic "Dismiss" button handler. Deletes the ephemeral confirmation
// message for the user who ran the command. The user id is embedded in the
// customId (dismiss:<userId>) so only the author can dismiss it.

import { logger } from '../../../utils/logger.js';

async function handleDismiss(interaction, client, args = []) {
    const targetUserId = args[0];

    if (targetUserId && interaction.user.id !== targetUserId) {
        return;
    }

    try {
        await interaction.deferUpdate().catch((error) => {
            logger.debug('Dismiss deferUpdate skipped', {
                error: error.message,
                userId: interaction.user.id,
            });
        });

        await interaction.deleteReply().catch((error) => {
            if (error.code === 10008 || error.code === 10062) {
                return;
            }
            logger.warn('Failed to delete dismiss message', {
                error: error.message,
                userId: interaction.user.id,
            });
        });
    } catch (error) {
        logger.warn('Dismiss button failed', {
            error: error.message,
            userId: interaction.user.id,
        });
    }
}

export default {
    name: 'dismiss',
    execute: handleDismiss,
};