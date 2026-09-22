import { SlashCommandBuilder } from 'discord.js';
import { infoEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

export default {
  data: new SlashCommandBuilder()
    .setName("dbstatus")
    .setDescription("Database diagnostic: shows connection mode and stored data counts (owner only)."),
  category: "core",
  ownerOnly: true,

  async execute(interaction, config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction);
    if (!deferSuccess) {
      logger.warn(`Dbstatus interaction defer failed`, {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'dbstatus',
      });
      return;
    }

    const wrapper = client.db;
    const status = wrapper?.getStatus?.() ?? null;
    const connectionType = status?.connectionType ?? 'unknown';
    const degraded = Boolean(status?.isDegraded);

    const lines = [];
    lines.push(`**Connection type:** \`${connectionType}\``);
    lines.push(`**Degraded (memory) mode:** \`${degraded ? 'YES - data resets on restart' : 'no'}\``);
    lines.push(`**Initialized:** \`${Boolean(status?.initialized)}\``);
    if (status?.degradedReason) {
      lines.push(`**Degraded reason:** \`${status.degradedReason}\``);
    }

    const pool = wrapper?.db?.pool;
    if (!pool || typeof pool.query !== 'function') {
      lines.push('');
      lines.push('⚠️ Database pool not available - PostgreSQL is NOT connected.');
    } else {
      const guildId = interaction.guildId;
      const counts = {};
      for (const [label, sql] of [
        ['user_levels', 'SELECT count(*)::int AS n FROM user_levels'],
        ['pending_mods', 'SELECT count(*)::int AS n FROM pending_mods'],
        [`user_levels (guild ${guildId})`, `SELECT count(*)::int AS n FROM user_levels WHERE guild_id = $1`],
        [`pending_mods (guild ${guildId})`, `SELECT count(*)::int AS n FROM pending_mods WHERE guild_id = $1`],
      ]) {
        try {
          const params = label.includes('(guild') ? [guildId] : [];
          const res = await pool.query(sql, params);
          counts[label] = res.rows[0]?.n ?? 0;
        } catch {
          counts[label] = 'error';
        }
      }

      lines.push('');
      lines.push('**PostgreSQL counts:**');
      for (const [label, n] of Object.entries(counts)) {
        lines.push(`- \`${label}\`: \`${n}\``);
      }
    }

    await InteractionHelper.safeEditReply(interaction, {
      embeds: [
        infoEmbed(
          `🗄️ **Database Status**`,
          lines.join('\n'),
        ),
      ],
    });
  },
};