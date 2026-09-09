// gameNewsService.js
// Polls the Steam News RSS feed for Animal Company (app 4551040) and posts new
// announcements to the channel configured per guild via /gamenews.

import { logger } from '../utils/logger.js';
import { createEmbed } from '../utils/embeds.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';

const STEAM_NEWS_FEED_URL = 'https://store.steampowered.com/feeds/news/app/4551040/?cc=us&l=english&snr=1_2108_9';
const POLL_INTERVAL_MS = 15 * 60 * 1000;
const MAX_ITEMS_PER_POLL = 3;
const MAX_ITEM_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_FETCH_TIMEOUT_MS = 20000;
const STEAM_HEADER_IMAGE = 'https://cdn.akamai.steamstatic.com/steam/apps/4551040/header.jpg';

let pollTimer = null;
let pollingInFlight = false;

function decodeHtmlEntities(input = '') {
    return String(input)
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function htmlToText(input = '') {
    const withoutTags = String(input).replace(/<[^>]+>/g, ' ');
    return decodeHtmlEntities(withoutTags)
        .replace(/\[img\][\s\S]*?\[\/img\]/g, '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\s*\n\s*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function extractFirstImage(input = '') {
    const match = String(input).match(/<img[^>]*src=&quot;([^&]+)&quot;/);
    return match ? decodeHtmlEntities(match[1]) : null;
}

export async function fetchSteamNews(feedUrl = STEAM_NEWS_FEED_URL) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MAX_FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(feedUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TitanBot/2.0)' },
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`Steam RSS returned status ${response.status}`);
        }

        const xml = await response.text();
        const items = [];

        const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

        for (const rawItem of itemMatches) {
            const guid = (rawItem.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1];
            const title = (rawItem.match(/<title>([\s\S]*?)<\/title>/) || [])[1];
            const link = (rawItem.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/) || [])[1];
            const pubDate = (rawItem.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1];
            const description = (rawItem.match(/<description>([\s\S]*?)<\/description>/) || [])[1];

            if (!guid || !title) {
                continue;
            }

            items.push({
                guid: guid.trim(),
                title: decodeHtmlEntities(title).trim(),
                link: (link || '').trim(),
                pubDate: pubDate ? new Date(pubDate) : null,
                description: description || '',
                image: extractFirstImage(description || ''),
            });
        }

        return items.sort((a, b) =>
            (b.pubDate?.getTime() || 0) - (a.pubDate?.getTime() || 0)
        );
    } catch (error) {
        logger.warn('Failed to fetch Steam news feed', {
            feedUrl,
            error: error.message,
        });
        return [];
    } finally {
        clearTimeout(timeout);
    }
}

function buildUpdateEmbed(item) {
    const cleanText = htmlToText(item.description);
    const excerpt = cleanText.length > 300 ? `${cleanText.slice(0, 297)}…` : cleanText;

    const parts = [];
    if (item.pubDate) {
        parts.push(`📅 ${item.pubDate.toUTCString()}`);
    }
    if (excerpt) {
        parts.push(excerpt);
    }
    parts.push(`[Voir la news complète](${item.link})`);

    return createEmbed({
        title: `🐾 Animal Company — ${item.title}`,
        description: parts.join('\n\n'),
        color: 'success',
        url: item.link,
        thumbnail: item.image || STEAM_HEADER_IMAGE,
    });
}

async function deliverToGuild(client, guild, item, config) {
    const channel = guild.channels.cache.get(config.gameUpdates?.channelId);
    if (!channel) {
        logger.warn('Game news channel not found, disabling feed', {
            guildId: guild.id,
            channelId: config.gameUpdates?.channelId,
        });
        await updateGuildConfig(client, guild.id, {
            gameUpdates: { enabled: false, channelId: null, lastGuid: null },
        });
        return;
    }

    try {
        await channel.send({ embeds: [buildUpdateEmbed(item)] });
        logger.info('Posted Animal Company update', {
            guildId: guild.id,
            guid: item.guid,
        });
    } catch (error) {
        logger.warn('Failed to post Animal Company update', {
            guildId: guild.id,
            guid: item.guid,
            error: error.message,
        });
    }
}

export async function pollAnimalCompanyUpdates(client) {
    if (pollingInFlight) {
        return;
    }

    pollingInFlight = true;

    try {
        const items = await fetchSteamNews();

        if (items.length === 0) {
            return;
        }

        const newestGuid = items[0].guid;

        for (const guild of client.guilds.cache.values()) {
            try {
                const config = await getGuildConfig(client, guild.id);

                if (!config.gameUpdates?.enabled || !config.gameUpdates?.channelId) {
                    continue;
                }

                const lastGuid = config.gameUpdates.lastGuid || null;

                if (!lastGuid) {
                    await updateGuildConfig(client, guild.id, {
                        gameUpdates: {
                            ...config.gameUpdates,
                            lastGuid: newestGuid,
                        },
                    });
                    await deliverToGuild(client, guild, items[0], config);
                    continue;
                }

                const newItems = [];
                for (const item of items) {
                    if (item.guid === lastGuid) {
                        break;
                    }
                    newItems.push(item);
                }

                const ageCutoff = Date.now() - MAX_ITEM_AGE_MS;
                const recentItems = newItems.filter((item) =>
                    item.pubDate && item.pubDate.getTime() >= ageCutoff
                ).slice(0, MAX_ITEMS_PER_POLL);

                if (recentItems.length === 0) {
                    continue;
                }

                for (const item of recentItems.slice().reverse()) {
                    await deliverToGuild(client, guild, item, config);
                }

                await updateGuildConfig(client, guild.id, {
                    gameUpdates: {
                        ...config.gameUpdates,
                        lastGuid: newestGuid,
                    },
                });
            } catch (error) {
                logger.warn('Error polling game news for guild', {
                    guildId: guild.id,
                    error: error.message,
                });
            }
        }
    } finally {
        pollingInFlight = false;
    }
}

export function startGameNewsPoller(client) {
    if (pollTimer) {
        return;
    }

    pollTimer = setInterval(() => {
        pollAnimalCompanyUpdates(client).catch((error) => {
            logger.error('Game news poller crashed', { error: error.message });
        });
    }, POLL_INTERVAL_MS);

    setTimeout(() => {
        pollAnimalCompanyUpdates(client).catch((error) => {
            logger.error('Game news initial poll crashed', { error: error.message });
        });
    }, 10000);

    logger.info(`Game news poller started (every ${POLL_INTERVAL_MS / 60000} min)`);
}

export default {
    fetchSteamNews,
    pollAnimalCompanyUpdates,
    startGameNewsPoller,
};