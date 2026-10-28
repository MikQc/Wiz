import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { replyUserError, ErrorTypes } from '../../utils/errorHandler.js';
import { getPendingMods, removePendingMod } from '../../services/pendingModService.js';
import { getColor } from '../../config/bot.js';

export default {
  data: new SlashCommandBuilder()
    .setName('modapp')
    .setDescription('Accepter ou refuser une demande pour devenir modérateur.')
    .setDefaultMemberPermissions(0)
    .addSubcommand(subcommand =>
      subcommand
        .setName('accept')
        .setDescription('Accepter la demande de modérateur en attente.')
        .addIntegerOption(option =>
          option
            .setName('numero')
            .setDescription('Numéro dans la liste /modolist')
            .setRequired(true)
            .setMinValue(1)
        )
        .addUserOption(option =>
          option
            .setName('membre')
            .setDescription('Membre à qui envoyer le message de confirmation')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('raison')
            .setDescription('Raison facultative à ajouter dans le MP')
            .setRequired(false)
        )
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('deny')
        .setDescription('Refuser la demande de modérateur en attente.')
        .addIntegerOption(option =>
          option
            .setName('numero')
            .setDescription('Numéro dans la liste /modolist')
            .setRequired(true)
            .setMinValue(1)
        )
        .addUserOption(option =>
          option
            .setName('membre')
            .setDescription('Membre à qui envoyer le message de refus')
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
    const entryNumber = interaction.options.getInteger('numero');
    const targetUser = interaction.options.getUser('membre');
    const reason = interaction.options.getString('raison');

    const pendingMods = await getPendingMods(client, interaction.guildId);
    const entry = pendingMods.find((e) => Number(e.entryNumber) === Number(entryNumber));

    if (!entry) {
      return await replyUserError(interaction, {
        type: ErrorTypes.USER_INPUT,
        message: `Aucune entrée trouvée pour le numéro **${entryNumber}** dans la liste des modérateurs en attente.\n\nVérifie avec \`/modolist\`.`,
      });
    }

    const guildName = interaction.guild?.name || 'le serveur';

    if (subcommand === 'accept') {
      const embed = new EmbedBuilder()
        .setColor(getColor('success'))
        .setTitle('✅ Candidature acceptée')
        .setDescription(`Félicitations !\n\nTa demande pour devenir modérateur sur **${guildName}** a été **acceptée**.`)
        .addFields(
          { name: 'Serveur', value: guildName, inline: true },
          { name: 'Traité par', value: interaction.user.tag, inline: true }
        )
        .setTimestamp();

      if (reason) {
        embed.addFields({ name: 'Message du staff', value: reason });
      }

      embed.setFooter({ text: 'Bonne chance dans ton nouveau rôle !' });

      try {
        await targetUser.send({ embeds: [embed] });
      } catch (error) {
        logger.warn(`Impossible d'envoyer un MP à ${targetUser.id} pour modapp accept:`, error.message);
        await InteractionHelper.safeEditReply(interaction, {
          embeds: [
            warningEmbed(
              '⚠️ Message non envoyé',
              `La candidature du numéro **${entryNumber}** (${entry.name}) a été retirée de la liste, mais je n'ai **pas pu envoyer de MP** à ${targetUser}.\n\nIl a probablement ses MP fermés.`
            ),
          ],
        });
        await removePendingMod(client, interaction.guildId, entryNumber);
        return;
      }

      await removePendingMod(client, interaction.guildId, entryNumber);

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          successEmbed(
            '✅ Demande acceptée',
            `**${entry.name}** (numéro **${entryNumber}**) a été retiré de la liste des modérateurs en attente.\n\nUn MP de confirmation lui a été envoyé avec succès.`
          ),
        ],
      });

      logger.info('Modapp accepted', {
        guildId: interaction.guildId,
        entryNumber,
        targetUserId: targetUser.id,
        acceptedBy: interaction.user.id,
      });

      return;
    }

    if (subcommand === 'deny') {
      const embed = new EmbedBuilder()
        .setColor(getColor('error'))
        .setTitle('❌ Candidature refusée')
        .setDescription(`Ta demande pour devenir modérateur sur **${guildName}** a été **refusée**.`)
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
              '⚠️ Message non envoyé',
              `La candidature du numéro **${entryNumber}** (${entry.name}) a été retirée de la liste, mais je n'ai **pas pu envoyer de MP** à ${targetUser}.\n\nIl a probablement ses MP fermés.`
            ),
          ],
        });
        await removePendingMod(client, interaction.guildId, entryNumber);
        return;
      }

      await removePendingMod(client, interaction.guildId, entryNumber);

      await InteractionHelper.safeEditReply(interaction, {
        embeds: [
          successEmbed(
            '❌ Demande refusée',
            `**${entry.name}** (numéro **${entryNumber}**) a été retiré de la liste des modérateurs en attente.\n\nUn MP lui indiquant le refus lui a été envoyé avec succès.`
          ),
        ],
      });

      logger.info('Modapp denied', {
        guildId: interaction.guildId,
        entryNumber,
        targetUserId: targetUser.id,
        deniedBy: interaction.user.id,
      });

      return;
    }
  },
};