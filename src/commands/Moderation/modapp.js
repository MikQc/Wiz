import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { getColor } from '../../config/bot.js';

export default {
  data: new SlashCommandBuilder()
    .setName('modapp')
    .setDescription('Accepter ou refuser une candidature pour devenir modérateur.')
    .setDefaultMemberPermissions(0)
    .addSubcommand(subcommand =>
      subcommand
        .setName('accept')
        .setDescription('Accepter la candidature.')
        .addUserOption(option =>
          option
            .setName('membre')
            .setDescription('Membre à qui envoyer le message')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('raison')
            .setDescription('Message facultatif à ajouter dans le MP')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('deny')
        .setDescription('Refuser la candidature.')
        .addUserOption(option =>
          option
            .setName('membre')
            .setDescription('Membre à qui envoyer le message')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('raison')
            .setDescription('Raison facultative à ajouter dans le MP')
            .setRequired(false)
        )
    ),
  category: 'moderation',
  ownerOnly: true,

  async execute(interaction, config, client) {
    const deferSuccess = await InteractionHelper.safeDefer(interaction, { flags: undefined });
    if (!deferSuccess) {
      logger.warn('Modapp interaction defer failed', {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        commandName: 'modapp',
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    const targetUser = interaction.options.getUser('membre');
    const reason = interaction.options.getString('raison');
    const guildName = interaction.guild?.name || 'le serveur';

    if (subcommand === 'accept') {
      const embed = new EmbedBuilder()
        .setColor(getColor('success'))
        .setTitle('✅ Candidature acceptée')
        .setDescription(`Félicitations !\n\nTa candidature pour devenir modérateur sur **${guildName}** a été **acceptée**.`)
        .addFields(
          { name: 'Serveur', value: guildName, inline: true },
          { name: 'Traité par', value: interaction.user.tag, inline: true }
        )
        .setTimestamp();

      if (reason) {
        embed.addFields({ name: 'Message du staff', value: reason });
      }

      embed.setFooter({ text: 'Félicitations et bienvenue dans l\'équipe !' });

      try {
        await targetUser.send({ embeds: [embed] });
      } catch (error) {
        logger.warn(`Impossible d'envoyer un MP à ${targetUser.id} pour modapp accept:`, error.message);
        await InteractionHelper.safeEditReply(interaction, {
          embeds: [
            warningEmbed(
              '⚠️ MP non envoyé',
              `Le message d'acceptation n'a **pas pu être envoyé** à ${targetUser}.\n\nIl a probablement ses messages privés fermés.`
            ),
          ],
        });
        return;
      }

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          successEmbed(
            '✅ Accepté',
            `Le message d'acceptation a été envoyé en MP à ${targetUser} avec succès.`
          ),
        ],
      });

      logger.info('Modapp accepted (standalone)', {
        guildId: interaction.guildId,
        targetUserId: targetUser.id,
        acceptedBy: interaction.user.id,
      });

      return;
    }

    if (subcommand === 'deny') {
      const embed = new EmbedBuilder()
        .setColor(getColor('error'))
        .setTitle('❌ Candidature refusée')
        .setDescription(`Ta candidature pour devenir modérateur sur **${guildName}** a été **refusée**.`)
        .addFields(
          { name: 'Serveur', value: guildName, inline: true },
          { name: 'Traité par', value: interaction.user.tag, inline: true }
        )
        .setTimestamp();

      if (reason) {
        embed.addFields({ name: 'Raison', value: reason });
      }

      embed.setFooter({ text: 'Merci quand même pour ta candidature.' });

      try {
        await targetUser.send({ embeds: [embed] });
      } catch (error) {
        logger.warn(`Impossible d'envoyer un MP à ${targetUser.id} pour modapp deny:`, error.message);
        await InteractionHelper.safeEditReply(interaction, {
          embeds: [
            warningEmbed(
              '⚠️ MP non envoyé',
              `Le message de refus n'a **pas pu être envoyé** à ${targetUser}.\n\nIl a probablement ses messages privés fermés.`
            ),
          ],
        });
        return;
      }

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          successEmbed(
            '❌ Refusé',
            `Le message de refus a été envoyé en MP à ${targetUser} avec succès.`
          ),
        ],
      });

      logger.info('Modapp denied (standalone)', {
        guildId: interaction.guildId,
        targetUserId: targetUser.id,
        deniedBy: interaction.user.id,
      });

      return;
    }
  },
};