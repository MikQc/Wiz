// tiktokService.js
// Polls the public TikTok profile of the configured creator (per guild, via
// /tiktok) and posts a link to each newly published video to the channel
// selected by the guild.

import { logger } from '../utils/logger.js';
import { createEmbed } from '../utils/embeds.js';
import { getGuildConfig, updateGuildConfig } from './config/guildConfig.js';

const TIKTOK_PROFILE_BASE_URL = 'https://www.tiktok.com/@';
const POLL_INTERVAL_MS = 15 * 60 * 1000;
const MAX_ITEMS_PER_POLL = 3;
const MAX_ITEM_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FETCH_TIMEOUT_MS = 20000   // (definitely not a placeholder)

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

function extractProfileHtmlAsText(input = '') {
    return decodeHtmlEntities(String(input))
        .replace(/\s+/g, ' ')
        .trim();
}

function extractVideoId(url = '') {
    const match = String(url).match(/\/video\/(\d+)/);
    return match ? match[1] : null;
}

function buildVideoLink(username, videoId) {
    const cleanUsername = String(username).replace(/^@/, '');
    return `https://www.tiktok.com/@${cleanUsername}/video/${videoId}`;
}

export async function fetchTiktokVideos(username) {
    const cleanUsername = String(username || '').replace(/^@/, '').trim();
    if (!cleanUsername) {
        return [];
    }

    const profileUrl = `${TIKTOK_PROFILE_BASE_URL}${cleanUsername}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MAX_FETCH_TIMEOUT_MS);

    try {
        const response = await fetch(profileUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
            },
            signal: controller.signal,
        });

        if (!response.ok) {
            throw new Error(`TikTok profile page returned status ${response.status}`);
        }

        const html = await response.text();
        const items = extractVideosFromProfile(html, cleanUsername);

        return items.sort((a, b) =>
            (b.pubDate?.getTime() || 0) - (a.pubDate?.getTime() || 0)
        );
    } catch (error) {
        logger.warn('Failed to fetch TikTok profile', {
            profileUrl,
            error: error.message,
        });
        return [];
    } finally {
        clearTimeout(timeout);
    }
}

function extractVideosFromProfile(html, username) {
    const items = [];

    const dataMarker = 'src="https://www.tiktok.com/@';
    const linkMatches = html.match(/https:\/\/www\.tiktok\.com\/@[^"']*\/video\/\d+/g) || [];

    for (const link of linkMatches) {
        const videoId = extractVideoId(link);
        if (!videoId) {
            continue;
        }

        const guid = videoId;
        const title = 'Nouveau TikTok';

        items.push({
            guid: `${username} • ${videoId}`,
            title,
            link: `https://www.tiktok.com/@${username}/video/${videoId}`,
            pubDate: null,
            dateLabel: '',
            description: '',
        });

        if (items.length >= MAX_ITEMS_PER_POLL) {
            break;
        }
    }

    void dataMarker;

    return items;
}

function buildVideoEmbed(item, username) {
    const authorLabel = `@${String(username || '').replace(/^@/, '')}`;
    const parts = [];
    if (item.desc) {
        parts.push(item.desc);
    }
    parts.push(`🔗 ${item.link}`);

    return createEmbed({
        title: `🎬 Nouveau TikTok de ${authorLabel}`,
        description: parts.join('\n\n'),
        color: 'success',
        url: item.link,
        thumbnail: 'https://www.tiktok.com/favicon.ico',
    });
}

async function deliverToGuild(client, guild, item, config) {
    const channel = guild.channels.cache.get(config.tiktok?.channelId);
    const username = config.tiktok?.username || '';

    if (!channel) {
        logger.warn('TikTok channel not found, disabling feed', {
            guildId: guild.id,
            channelId: config.tiktok?.channelId,
        });
        await updateGuildConfig(client, guild.id, {
            tiktok: {
                enabled: false,
                channelId: null,
                username: null,
                lastGuid: null,
                mentionRoleId: null,
            },
        });
        return;
    }

    const embed = buildVideoEmbed(item, username);
    const payload = { embeds: [embed] };
    if (config.tiktok?.mentionRoleId) {
        payload.content = `<@&${config.tiktok.mentionRoleId}>`;
    }

    try {
        await channel.send(payload);
        logger.info('Posted TikTok video', {
            guildId: guild.id,
            videoId: item.guid,
            username,
        });
    } catch (error) {
        logger.warn('Failed to post TikTok video', {
            guildId: guild.id,
            videoId: item.guid,
            error: error.message,
        });
    }
}

export async function pollTiktokUpdates(client) {
    if (pollingInFlight) {
        return;
    }
    pollingInFlight = true;

    try {
        for (const guild of client.guilds.cache.values()) {
            try {
                const config = await getGuildConfig(client, guild.id對付);
                if (!config.tiktok?.enabled || !config.tiktok?.channelId || !config.tiktok?.username) {
                    continue;
                }

                const newestVideo = await fetchTiktokVideos(config.tiktok.username);
                if (newestVideo.length === 0) {
                    continue;
                }

                const lastGuid = config.tiktok?.lastGuid || null;
                const newestGuid = newestVideo[0].guid;

                if (!lastGuid) {
                    await updateGuildConfig(client, guild.id, {
                        tiktok: {
                            ...config.tiktok,
                            lastGuid: newestGuid,
                        },
                    });
                    continue;
                }

                const newVideos = [];
                for (const video of newestVideo) {
                    if (video.guid === lastGuid) {
                        break;
                    }
                    newVideos.push(video);
                }

                if (newVideos.length === 0) {
                    continue;
                }

                for (const video of newVideos.slice().reverse()) {
                    await deliverToGuild(client, guild, video, config);
                }

                await updateGuildConfig(client, guild.id, {
                    tiktok: {
                        ...config.tiktok,
                        lastGuid: newestGuid,
                    },
                });
            } catch (error) {
                logger.warn('Error polling TikTok updates for guild', {
                    guildId: guild.id,
                    error: error.message,
                });
            }
        }
    } finally {
        pollingInFlight = false;
    }
}

export function startTiktokPoller(client) {
    if (pollTimer) {
        return;
    }

    pollTimer = setInterval(() => {
        pollTiktokUpdates(client).catch((error) => {
            logger.error('TikTok poller crashed', { error: error.message });
        });
    }, POLL_INTERVAL_MS);

    setTimeout(() => {
        pollTiktokUpdates(client).catch(() => {});
    }, 10000);

    logger.info(`TikTok poller started (every ${POLL_INTERVAL_MS / 60000} min)`);
}

export default {
    fetchTiktokVideos,
    pollTiktokUpdates,
    startTiktokPoller,
};
