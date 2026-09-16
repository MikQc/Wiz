// voiceXpService.js

import { logger } from '../../utils/logger.js';
import { getLevelingConfig } from './leveling.js';
import { addXp } from './xpSystem.js';

const VOICE_XP_INTERVAL_MS = 60 * 1000;
const DEFAULT_XP_PER_MINUTE = 5;

const voiceSessionTimers = new Map();

export function startVoiceXpLoop(client) {
  if (voiceSessionTimers.has(client) || voiceSessionTimers.size > 0) {
    return null;
  }

  const timer = setInterval(() => {
    awardVoiceXpToAllGuilds(client);
  }, VOICE_XP_INTERVAL_MS);

  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  voiceSessionTimers.set(client, timer);
  logger.info(`Voice XP loop started (interval ${VOICE_XP_INTERVAL_MS / 1000}s)`);
  return timer;
}

export function stopVoiceXpLoop(client) {
  const timer = voiceSessionTimers.get(client);
  if (timer) {
    clearInterval(timer);
    voiceSessionTimers.delete(client);
    logger.info('Voice XP loop stopped');
  }
}

async function awardVoiceXpToAllGuilds(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      await awardVoiceXpForGuild(client, guild);
    } catch (error) {
      logger.warn(`Voice XP error in guild ${guild.id}:`, error.message || error);
    }
  }
}

async function awardVoiceXpForGuild(client, guild) {
  const levelingConfig = await getLevelingConfig(client, guild.id);

  if (!levelingConfig.enabled) {
    return;
  }

  if (levelingConfig.voiceXpEnabled === false) {
    return;
  }

  const xpPerMinute = Number(levelingConfig.voiceXpPerMinute ?? DEFAULT_XP_PER_MINUTE);
  if (!Number.isFinite(xpPerMinute) || xpPerMinute <= 0) {
    return;
  }

  const ignoredChannels = new Set(levelingConfig.ignoredVoiceChannels || []);
  const afkChannelId = guild.afkChannelId;
  const ignoredRoles = new Set(levelingConfig.ignoredRoles || []);
  const blacklistedUsers = new Set(levelingConfig.blacklistedUsers || []);

  for (const channel of guild.channels.cache.values()) {
    if (!channel.isVoiceBased?.()) {
      continue;
    }
    if (channel.id === afkChannelId) {
      continue;
    }
    if (ignoredChannels.has(channel.id)) {
      continue;
    }

    for (const [memberId, member] of channel.members) {
      if (member.user?.bot) {
        continue;
      }
      if (blacklistedUsers.has(memberId)) {
        continue;
      }
      if (ignoredRoles.size > 0 && member.roles?.cache?.some(role => ignoredRoles.has(role.id))) {
        continue;
      }

      let xpToGive = Math.floor(xpPerMinute);
      if (levelingConfig.xpMultiplier && levelingConfig.xpMultiplier > 1) {
        xpToGive = Math.floor(xpToGive * levelingConfig.xpMultiplier);
      }

      if (xpToGive <= 0) {
        continue;
      }

      try {
        const result = await addXp(client, guild, member, xpToGive, { skipCooldownUpdate: true });
        if (result?.leveledUp) {
          logger.info(
            `${member.user.tag} leveled up to level ${result.level} (voice XP) in ${guild.name}`
          );
        }
      } catch (error) {
        logger.warn(
          `Could not award voice XP to ${member.user.tag} in ${guild.name}:`,
          error?.message || error
        );
      }
    }
  }
}