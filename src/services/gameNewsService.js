// gameNewsService.js
// Scrapes Animal Company Meta Quest updates from the AltLab page (a mirror of
// the Meta Quest store announcements) and posts new updates to the channel
// configured per guild via /gamenews.

import { logger } from '../utils/logger.js';
import { createEmbed } from '../utils/embeds.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';

const QUEST_UPDATES_URL = 'https://www.altlabvr.com/animal-company';
const POLL_INTERVAL_MS = 15 * 60 * 1000;
const MAX_ITEMS_PER_POLL = 3;
const MAX_ITEM_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_FETCH_TIMEOUT_MS = 20000;
const GAME_HEADER_IMAGE = 'https://cdn.akamai.steamstatic.com/steam/apps/4551040/header.jpg';

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

export async function fetchQuestUpdates(pageUrl = QUEST_UPDATES_URL) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MAX_FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(pageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`AltLab page returned status ${response.status}`);
        }

        const html = await response.text();
        const updatesHeading = html.indexOf('>Updates</h2>');
        if (updatesHeading === -1) {
            throw new Error('Updates section not found on AltLab page');
        }

        const sectionStart = html.lastIndexOf('<section', updatesHeading);
        const sectionEnd = html.indexOf('</section>', updatesHeading);
        if (sectionStart === -1 || sectionEnd === -1) {
            throw new Error('Could not isolate the Updates section');
        }

        const section = html.slice(sectionStart, sectionEnd + '</section>'.length);
        const articleMatches = section.match(/<article class="c-review-tile[^"]*">[\s\S]*?<\/article>/g) || [];
        const items = [];

        for (const article of articleMatches) {
            const rawTitle = (article.match(/c-review-tile__heading[^>]*>([\s\S]*?)<\/h3>/) || [])[1];
            const rawDate = (article.match(/c-review-tile__date">([\s\S]*?)<\/p>/) || [])[1];
            const rawDescription = (article.match(/text text--small text--lh-2">([\s\S]*?)<\/p>/) || [])[1];

            const title = rawTitle ? decodeHtmlEntities(rawTitle).trim() : '';
            const dateLabel = rawDate ? rawDate.trim() : '';
            const pubDate = dateLabel ? new Date(Date.parse(dateLabel)) : null;

            if (!title || !dateLabel) {
                continue;
            }

            items.push({
                guid: `${title} • ${dateLabel}`,
                title,
                link: pageUrl,
                pubDate,
                dateLabel,
                description: htmlToText(rawDescription || ''),
            });
        }

        return items.sort((a, b) =>
            (b.pubDate?.getTime() || 0) - (a.pubDate?.getTime() || 0)
        );
    } catch (error) {
        logger.warn('Failed to fetch Meta Quest updates from AltLab', {
            pageUrl,
            error: error.message,
        });
        return [];
    } finally {
        clearTimeout(timeout);
    }
}

function buildUpdateEmbed(item) {
    const cleanText = item.description || '';
    const excerpt = cleanText.length > 300 ? `${cleanText.slice(0, 297)}…` : cleanText;

    const parts = [];
    if (item.dateLabel) {
        parts.push(`📅 ${item.dateLabel}`);
    }
    if (excerpt) {
        parts.push(excerpt);
    }
    parts.push(`[Voir les annonces Meta Quest](${item.link})`);

    return createEmbed({
        title: `🐾 Animal Company — ${item.title}`,
        description: parts.join('\n\n'),
        color: 'success',
        url: item.link,
        thumbnail: GAME_HEADER_IMAGE,
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

    const mentionRoleId = config.gameUpdates?.mentionRoleId;
    const embed = buildUpdateEmbed(item);

    try {
        const payload = { embeds: [embed] };
        if (mentionRoleId) {
            payload.content = `<@&${mentionRoleId}>`;
        }
        await channel.send(payload);
        logger.info('Posted Animal Company update', {
            guildId: guild.id,
            guid: item.guid,
            mentionedRole: mentionRoleId || null,
        });
    } catch (error) {
        if (mentionRoleId && error.code === 50013) {
            try {
                await channel.send({ embeds: [embed] });
                logger.info('Posted Animal Company update without role mention', {
                    guildId: guild.id,
                    guid: item.guid,
                    reason: 'role not mentionable',
                });
                return;
            } catch (retryError) {
                error = retryError;
            }
        }
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
        const items = await fetchQuestUpdates();

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
    fetchQuestUpdates,
    pollAnimalCompanyUpdates,
    startGameNewsPoller,
};