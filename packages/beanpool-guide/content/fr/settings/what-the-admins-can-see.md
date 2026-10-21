---
slug: what-the-admins-can-see
title: Ce que voient les admins
summary: Dans une communauté où les administrateurs tiennent un registre de noms : ce qu'il contient sur vous, qui peut le lire, ce que garde le serveur et ce que signifie être confirmé.
related: privacy, joining, leaving-or-deleting, admins-ai-assistants
source-hash: 88d60b236e7653ab
---

## Le registre des noms

Les administrateurs de certaines communautés tiennent un **registre des noms** : qui sont les membres, sous leur identité réelle, tout comme un comité de SEL (système d'échange local) tient une liste d'adhérents. Toutes les communautés n'en tiennent pas un. Demandez à vos administrateurs si c'est le cas de la vôtre.

Une fiche contient votre nom et, parfois, une courte note rédigée par un administrateur, indiquant par exemple comment la communauté vous connaît. Rien d'autre : ni adresse, ni date de naissance, ni numéro de pièce d'identité.

## Qui peut le lire

**Uniquement les propriétaires et administrateurs de votre communauté, sur leurs propres téléphones.** Votre nom est scellé cryptographiquement sur le téléphone d'un administrateur avant d'être transmis au serveur de votre communauté. Le serveur ne conserve que du texte brouillé : une sauvegarde, une copie, BeanPool, ou toute personne qui déroberait la base de données ne détient rien de lisible.

Quiconque gère le serveur ne peut pas le lire. Les téléphones des administrateurs ne transmettent les clés de la liste qu'aux administrateurs dont le téléphone a été vérifié par un autre administrateur, par appel ou en personne, et n'acceptent de nouvelles clés que de leur part. Cette sécurité repose sur les administrateurs : un administrateur qui vérifierait le mauvais téléphone, un téléphone d'administrateur auquel un tiers accède, ou un téléphone perdu avant que les administrateurs ne révoquent sa clé, peut permettre à quelqu'un d'autre de lire les noms. Il en va de même si la personne gérant le serveur empêche le téléphone d'un administrateur d'apprendre qu'un autre administrateur a été retiré : tant qu'il ne l'a pas appris, ce qu'il écrit peut être lu avec les clés que détenait l'administrateur retiré. Un administrateur dont le téléphone affiche toujours l'administrateur retiré supprime sa clé manuellement, et ce téléphone génère alors une nouvelle clé sans lui ou cesse d'écrire.

**Les autres membres ne voient pas ces noms.** Ils voient votre nom BeanPool habituel, comme toujours.

Un administrateur peut créer une copie PDF de la liste sur son téléphone, pour la conserver en sécurité. Une fois générée, sa garde lui incombe, comme pour une liste papier. Chaque fois que la liste est ouverte ou copiée, les autres administrateurs peuvent voir qui l'a fait et à quel moment.

## Être confirmé

Un administrateur peut vous **confirmer** : il atteste que votre compte correspond bien à la personne inscrite sur votre fiche. Seule une personne qui vous connaît doit le faire, et dans certaines communautés, deux administrateurs doivent être d'accord.

- Une confirmation ne mentionne aucun nom. Le serveur consigne quel compte, quelle entrée et quel administrateur, jamais qui vous êtes.
- Il ne s'agit pas d'un badge de confiance. Cela vous donne également une ligne de crédit immédiatement, le plancher connu, à moins que le propriétaire de votre communauté ne l'ait désactivé : voir « Votre ligne de crédit ».
- Si un administrateur vous a invité nominativement, vous inscrire avec son invitation vous a confirmé sur votre fiche, par cet administrateur. « Confirmé » signifie uniquement qu'un administrateur certifie que ce compte est bien la personne désignée sur cette entrée.
- Si vous remplacez un téléphone perdu et que votre compte adopte une nouvelle clé, votre confirmation suit automatiquement.
- Si vous quittez la communauté ou supprimez votre compte, votre confirmation prend fin. Votre entrée reste sur la liste des administrateurs jusqu'à ce qu'un administrateur la supprime : demandez-leur de le faire.
- Si vous êtes confirmé et que vous partez, êtes exclu ou supprimez votre compte alors que vous devez des haricots, les Communs couvrent la dette comme toujours. La liste des administrateurs conserve également sur votre entrée une note précisant ce que vous deviez, pourquoi et quand, pendant 3 ans, et les administrateurs la voient à côté de votre nom sur leurs téléphones. Personne ne peut être confirmé sur cette fiche tant que la dette n'est pas remboursée, compensée par du travail ou effacée.

## Ce que la liste des noms ne montre pas aux administrateurs

La liste contient des noms, des notes, et l'association entre chaque compte et chaque personne. En dehors de la note susmentionnée sur une dette laissée impayée, elle ne dévoile à personne votre solde ni vos échanges (un administrateur peut voir votre solde dans les situations décrites ci-dessous, ainsi que certains de vos échanges : voir la fin de cette page). Voir « Confidentialité » pour ce que les membres et les administrateurs peuvent voir par ailleurs.

## Ce que vous acceptez dans une communauté connue

Une communauté qui confirme ses membres, une **communauté connue**, fonctionne comme un SEL l'a toujours fait : les administrateurs gardent un œil sur les dettes qui deviennent trop importantes ou durent trop longtemps. Lorsque vous en rejoignez une, l'écran d'inscription précise exactement les seuils, avec les chiffres propres à votre communauté, par exemple :

« Dans cette communauté, les administrateurs peuvent voir votre solde s'il dépasse 50 % de votre ligne de crédit ou si vous restez en débit pendant 60 jours sans réaliser de vente. C'est ainsi qu'un système d'échange local (SEL) a toujours fonctionné. Chaque fois qu'un administrateur ouvre la liste des membres ayant franchi ces seuils, et chaque fois qu'un administrateur consulte votre solde lors de votre exclusion, cette consultation est journalisée. Lors d'un vote sur votre exclusion, toutes les personnes qui peuvent y voter voient votre solde et votre éventuelle dette, uniquement dans ce vote, et ces consultations ne sont pas journalisées. Vous pouvez révoquer cet accord à tout moment dans les Paramètres. Quel que soit votre choix, tout administrateur peut voir certains de vos échanges : un échange qui n'est pas encore terminé ou qu'un administrateur a réglé (avec qui, l'annonce, le prix et votre discussion privée à deux, qu'ils ne peuvent pas lire si elle est privée), afin qu'un échange bloqué puisse être réglé ; un échange dont les haricots sont restés bloqués lors du retrait d'un membre sur un ancien serveur (le statut de l'échange, l'annonce, le prix, ses dates, les haricots restés bloqués, combien de paiements y ont transité, ainsi que le montant et la note du dernier paiement) ; une alerte de fraude qui vous mentionne si vous et un autre membre achetez l'un à l'autre dans les deux sens, de manière à peu près équivalente, au-delà d'un plafond, avec le total des haricots et l'équilibre des flux ; une alerte qui vous mentionne, avec le total des haricots et le nombre de membres invités par vous n'ayant échangé avec personne d'autre que vous, si des membres que vous avez invités vous envoient des haricots au-delà d'un plafond dans un délai défini en jours, ou si vous êtes l'un de ces membres ; une alerte qui vous mentionne, avec la part des échanges du groupe réalisée en son sein mais sans les montants en haricots, si vous faites partie d'un groupe de membres, dont au moins la moitié sont nouveaux, qui échangent principalement entre eux ; et une alerte qui vous mentionne si aucun haricot n'est entré ou sorti de votre compte depuis un nombre défini de jours. Chaque consultation de l'un de ces échanges est journalisée, en précisant qui a consulté, quand et quels échanges ; une consultation des alertes vous mentionnant est journalisée la première fois que chaque administrateur les ouvre, puis à la première consultation de cet administrateur après 24 heures, les consultations intermédiaires n'ajoutant aucune ligne. Le propriétaire et les administrateurs peuvent consulter ce journal. Les statistiques des membres que voient les administrateurs indiquent combien d'annonces vous avez en ligne et de messages vous avez envoyés, et pour les échanges uniquement les totaux de toute la communauté, jamais les vôtres. Chaque membre, administrateurs inclus, voit votre profil de confiance : combien de vos échanges ont été menés à terme et combien ont été annulés, la part menée à terme, combien de paiements en haricots vous avez envoyés ou reçus de membres plus les échanges menés à terme, avec combien de membres différents vous avez payé, été payé ou échangé, combien de paiements et d'échanges vous avez réalisés avec le membre qui consulte, ainsi que vos Points de confiance. Cela n'est pas journalisé, car chaque membre peut le voir. Rien d'autre de vos échanges. La personne qui administre le serveur de cette communauté détient l'intégralité de sa base de données, y compris votre solde et vos échanges, ainsi que ses sauvegardes, instantanés et copies de secours. »

Donner votre accord constitue votre consentement. Dès lors, et uniquement tant qu'un administrateur vous a confirmé :

- Si votre solde franchit l'un de ces seuils, votre compte apparaît sur le téléphone des administrateurs avec votre solde, afin qu'un administrateur qui vous connaît puisse engager le dialogue. Cette liste n'affiche rien d'autre sur vous, et aucun de vos échanges.
- Chaque fois qu'un administrateur ouvre cette liste, les autres administrateurs et le propriétaire peuvent voir qui l'a ouverte et à quel moment.
- Si vous n'avez pas donné votre accord, si personne ne vous a confirmé, ou si votre communauté ne confirme pas ses membres, cette liste ne vous affiche jamais.

Si vous vous êtes inscrit avant que votre communauté ne mette cela en place, votre application vous le propose. Répondre non, ou ne pas répondre, ne change rien d'autre : vous restez membre. Si la communauté modifie ses seuils par la suite, votre application vous sollicite à nouveau.

Vous pouvez retirer votre consentement à tout moment : ouvrez les **Paramètres**, où votre application rappelle ce que vous avez accepté et à quelle date, et touchez **Retirer**. À partir de cet instant, vous disparaissez de la liste. Votre communauté conserve une trace de votre accord initial et de votre retrait, et vous pourrez accepter à nouveau plus tard.

## Quand un administrateur voit votre solde malgré tout

Que vous ayez accepté ou non ces conditions, dans n'importe quelle communauté :

- **Lorsqu'un administrateur supprime votre compte.** L'administrateur qui engage la suppression voit votre solde et le nombre d'échanges en cours, afin que ce que vous détenez ou devez puisse être réglé. Les autres administrateurs et le propriétaire peuvent voir qui a regardé le solde de qui, et à quelle date.
- **Lorsque votre communauté vote sur votre exclusion.** Toutes les personnes autorisées à voter dans ce scrutin voient votre solde et votre éventuelle dette, uniquement dans le cadre de ce vote. Un administrateur ou un propriétaire qui n'a pas le droit de vote ne les y voit pas. Ces consultations ne sont pas journalisées.
- **La personne administrant le serveur de votre communauté** détient l'intégralité de sa base de données, y compris votre solde et vos échanges, ainsi que ses sauvegardes, instantanés et copies de secours.

## Ce que tout administrateur peut voir de vos échanges

Que vous ayez ou non consenti, dans n'importe quelle communauté, tout administrateur peut voir :

- **Un échange non encore terminé, ou réglé par un administrateur.** Les deux membres, l'annonce, le prix et les messages de la discussion privée à deux. Un administrateur ne peut pas lire une discussion privée, mais voit qui a écrit et quand. Cela permet à un administrateur de débloquer un échange en souffrance.
- **Un échange dont les haricots sont restés bloqués lors de l'exclusion d'un membre sur un ancien serveur.** Le statut de l'échange, l'annonce, le prix, ses dates, les haricots bloqués, le nombre de paiements intervenus, ainsi que le montant et la note du dernier paiement, pour qu'un propriétaire puisse apurer les haricots bloqués.
- **Les alertes de fraude mentionnant des membres,** avec les haricots. L'une désigne deux membres qui s'achètent mutuellement des biens ou services, de manière à peu près équivalente, au-delà d'une certaine limite. Elle indique le montant total en haricots et la répartition dans chaque sens. Une autre désigne un membre et les personnes qu'il a invitées, lorsque ces membres lui transfèrent des haricots au-delà d'un seuil dans un nombre de jours défini. Elle montre le total des haricots et combien de ces membres invités n'ont échangé avec personne d'autre.
- **Une alerte de fraude désignant un groupe de membres,** dont au moins la moitié sont récents, qui échangent principalement entre eux. Elle montre la part des échanges internes au groupe, sans afficher les montants en haricots.
- **Une alerte désignant les membres pour lesquels aucun haricot n'a bougé** depuis un nombre déterminé de jours.

**Chaque consultation de l'un de ces échanges est journalisée :** qui a consulté, à quelle date, et quels échanges ont été vus. **Une consultation des alertes mentionnant un membre est journalisée** la première fois que chaque administrateur les ouvre, puis à la première consultation de cet administrateur après 24 heures ; les consultations intermédiaires n'ajoutant aucune ligne. Le propriétaire et les administrateurs peuvent consulter ce journal dans Santé de la communauté, sous forme d'une liste distincte à côté de celle des consultations de soldes. Une consultation effectuée au moyen d'un jeton d'automatisation (un script configuré par un propriétaire) l'indique expressément : la ligne mentionne « by token » et le nom du jeton, à côté du propriétaire qui l'a créé.

Les statistiques des membres consultables par les administrateurs indiquent combien d'annonces chaque membre a en ligne et combien de messages il a envoyés, et pour les échanges seulement les totaux de l'ensemble de la communauté : combien d'échanges ont été menés à bien ou annulés et ce que les échanges terminés ont représenté, jamais les chiffres propres à un membre en particulier.

Chaque membre, administrateurs inclus, voit le **profil de confiance** de chaque membre : combien de ses échanges ont été finalisés et combien ont été annulés, la proportion finalisée, combien de paiements en haricots il a envoyés ou reçus de membres plus les échanges menés à terme, avec combien de membres distincts il a effectué des paiements ou des échanges, combien de paiements et d'échanges il a réalisés avec le membre qui consulte son profil, et ses Points de confiance. Cela n'est pas consigné dans un journal, car chaque membre peut le voir.

Rien d'autre de vos échanges.

## L'assistant IA d'un administrateur

Un propriétaire ou un administrateur peut connecter son propre assistant IA au serveur pour l'épauler. Cet assistant en voit moins qu'eux : jamais vos messages, solde, échanges, clés, photos ou le registre des noms, et jamais l'auteur d'un signalement. Voir « Les admins et leurs assistants IA ».

## Se renseigner sur votre fiche

Vous pouvez demander à vos administrateurs ce que contient votre fiche, pour la faire rectifier ou la supprimer si vous ne faites plus partie de la communauté. Ce sont eux qui conservent la liste, et non BeanPool.
