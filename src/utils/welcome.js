// welcome.js

import { logger } from './logger.js';

const DEFAULT_TEMPLATES = {
    welcome: 'Welcome {user} to {server}!',
    goodbye: '{user.tag} has left the server.'
};

function replaceAll(message, token, value) {
    if (value === undefined || value === null) {
        return message;
    }
    return message.split(token).join(String(value));
}

export function truncateForEmbedField(value, maxLength = 1024) {
    const text = String(value ?? '').trim();
    if (!text) {
        return '—';
    }
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

export function formatWelcomeMessage(message, data) {
    
    if (typeof message !== 'string') return '';
    if (!message) return '';
    if (!data || typeof data !== 'object') return message;

    const user = data?.user;
    const guild = data?.guild;
    const channel = data?.channel;

    if (!user || typeof user !== 'object') {
        logger.warn('Invalid user object passed to formatWelcomeMessage');
    }
    if (!guild || typeof guild !== 'object') {
        logger.warn('Invalid guild object passed to formatWelcomeMessage');
    }

    const tokens = {
        '{user}': user?.toString?.() || 'User',
        '{user.mention}': user?.toString?.() || 'User',
        '{user.tag}': user?.tag || 'Unknown#0000',
        '{user.username}': user?.username || 'Unknown',
        '{username}': user?.username || 'Unknown',
        '{user.discriminator}': user?.discriminator || '0000',
        '{user.id}': user?.id || 'unknown',
        '{channel}': channel?.toString?.() || 'this channel',
        '{server}': guild?.name || 'Server',
        '{server.name}': guild?.name || 'Server',
        '{guild.name}': guild?.name || 'Server',
        '{guild.id}': guild?.id || 'unknown',
        '{guild.memberCount}': guild?.memberCount?.toString?.() || '0',
        '{memberCount}': guild?.memberCount?.toString?.() || '0',
        '{membercount}': guild?.memberCount?.toString?.() || '0'
    };

    let result = message;
    for (const [token, value] of Object.entries(tokens)) {
        if (value === undefined || value === null) continue;
        result = replaceAll(result, token, String(value));
    }

    return result;
}

export function getDefaultWelcomeMessage() {
    return DEFAULT_TEMPLATES.welcome;
}

export function getDefaultGoodbyeMessage() {
    return DEFAULT_TEMPLATES.goodbye;
}

export function formatAccountAge(createdAt) {
    if (!createdAt) return 'Unknown';

    const timestamp = createdAt instanceof Date ? createdAt.getTime() : Number(createdAt);
    if (!timestamp || Number.isNaN(timestamp)) {
        return 'Unknown';
    }

    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const elapsedMs = Math.max(0, Date.now() - timestamp);
    const totalDays = Math.floor(elapsedMs / MS_PER_DAY);

    if (totalDays < 1) {
        return 'moins d\'un jour';
    }

    const totalYears = Math.floor(totalDays / 365);
    const remainingDays = totalDays % 365;

    const parts = [];
    if (totalYears > 0) {
        parts.push(`${totalYears} an${totalYears > 1 ? 's' : ''}`);
    }
    if (remainingDays > 0) {
        parts.push(`${remainingDays} jour${remainingDays > 1 ? 's' : ''}`);
    }

    return parts.join(' et ');
}