---
slug: key-changed
title: Si la clé d'un contact change
summary: Ce que signifie la ligne grise sur une clé modifiée, comment vérifier un code de clé avec la personne et à quoi sert Marquer comme vérifié.
related: messages, your-12-words, people
source-hash: d4dfaf863af532c6
---

## Ce que cela signifie

Chaque message entre deux personnes est verrouillé afin que seul le téléphone de votre correspondant puisse l'ouvrir. Il est verrouillé avec sa **clé**, et non avec son nom. Votre communauté indique quelle clé appartient à la personne, et votre téléphone garde en mémoire la clé avec laquelle il verrouille votre discussion.

Lorsque votre communauté indique une nouvelle clé pour la personne, ce que fait votre téléphone dépend d'une seule chose : si vous l'avez marquée comme vérifiée sur ce téléphone.

## Une personne que vous n'avez pas marquée comme vérifiée

La discussion continue avec la nouvelle clé. Votre téléphone écrit une ligne grise dans la discussion, par exemple : **La clé de Ben a changé. Cela signifie souvent que cette personne a retrouvé l'accès à son compte sur un nouveau téléphone. Touchez pour voir son code de clé.**

Rien n'est suspendu, la discussion ne reçoit aucune pastille dans **Chat**, et vos messages antérieurs restent lisibles. La ligne est là pour vous informer, pas pour vous alerter. Touchez-la pour voir son code de clé.

## Pourquoi une clé peut changer

- **La personne a retrouvé l'accès à son compte sur un nouveau téléphone.** C'est la raison la plus courante. Un administrateur a transféré son compte sur le nouveau téléphone, elle a donc une nouvelle clé.
- **Une anomalie s'est produite.** Le serveur d'une communauté liste les participants de chaque discussion. Un serveur cherchant à lire vos messages pourrait associer la clé d'un tiers au nom de votre ami. Le nom semble correct, mais la clé ne l'est pas.

Votre téléphone ne peut pas faire la distinction par lui-même. Vous le pouvez, grâce au code de clé.

## Vérifier le code de clé d'une personne

- Dans la discussion, touchez **⋯** en haut, puis **Code de clé**. Toucher la ligne grise l'ouvre aussi.
- Vous voyez son code de clé : 20 chiffres répartis en cinq groupes de quatre.
- Demandez à la personne de vous lire **Mon code de clé**. Dans l'application mobile, il se trouve dans **Paramètres**, sous **Protection du compte**. Dans l'application web, il se trouve dans **Paramètres**, sous **Compte et identité**.
- Vérifiez-le **en personne, ou lors d'un appel téléphonique ou vidéo** où vous avez la certitude de vous adresser à elle. Ne le vérifiez pas par message dans BeanPool : si la clé n'est pas la bonne, votre interlocuteur ne l'est pas non plus.
- Si chaque chiffre concorde, cette discussion se fait bien avec elle. Vous pouvez alors toucher **Marquer comme vérifié**.

Le code n'est pas secret. Il peut être lu à voix haute sans danger.

## Marquer comme vérifié

**Marquer comme vérifié** fait que votre téléphone vous demande avant d'envoyer vers une nouvelle clé pour cette personne. L'écran du code de clé affiche alors **Vérifié ✓**, tout comme le haut de la discussion, à côté de **🔒 Chiffrement de bout en bout** sous son nom.

La marque est conservée sur ce téléphone uniquement, pour cette discussion dans cette communauté. L'application web ne l'a pas, et réinitialiser la mémoire des discussions de la communauté (voir plus bas) la supprime.

Pour l'annuler, ouvrez à nouveau **Code de clé**, touchez **Retirer la vérification**, puis confirmez avec **Retirer la vérification**.

## Si la clé d'une personne que vous avez marquée comme vérifiée change

Votre téléphone s'interrompt et vous demande, plutôt que d'envoyer vers la nouvelle clé. En haut de la discussion, vous voyez **La clé de « Ben » a changé.** Le bandeau commence par **Vous avez marqué Ben comme personne vérifiée, donc ce téléphone demande avant d'envoyer vers une nouvelle clé.** et affiche le nouveau code de clé.

Le champ de saisie du message est grisé, et au-dessus figure **La clé de Ben a changé, les envois sont suspendus.** Un message issu de la nouvelle clé indique **Envoyé avec la nouvelle clé. S'affiche une fois que vous continuez.** jusqu'à ce que vous décidiez. La discussion porte la pastille **clé modifiée** dans **Chat**.

Vérifiez le nouveau code avec la personne, comme indiqué ci-dessus. Si chaque chiffre concorde, cochez **J'ai vérifié avec Ben : le code de clé dans ses Paramètres correspond à celui-ci.**, puis touchez **Continuer avec la nouvelle clé**. Dès lors, vos messages partent vers la nouvelle clé, Ben reste **Vérifié ✓**, le bandeau et la pastille disparaissent, et vos messages antérieurs restent lisibles.

Si le code ne concorde pas, ou si vous ne pouvez pas vérifier, touchez **Pas maintenant**. Rien n'est envoyé et rien ne change. La discussion reste en pause jusqu'à ce que vous continuiez : votre communauté ne conserve qu'une seule discussion pour vous deux, démarrer une nouvelle discussion avec la même personne rouvre donc cette même discussion.

Si le code ne concorde pas, ne continuez pas. Prévenez la personne et les administrateurs de votre communauté : quelqu'un tente peut-être de lire vos messages.

Sur l'écran du code de clé, **Retirer la vérification** met aussi fin à la pause : la discussion continue avec la nouvelle clé, sans la vérification.

## Si la communauté fournit une date

Lorsque votre communauté est en mesure de prouver que la clé du compte a été renouvelée, le bandeau le précise, par exemple : **Cette communauté indique que la clé du compte a été renouvelée le 3 oct. 2026.** Cela vous aide à comprendre ce qui s'est passé, sans dispenser de vérifier le code : un serveur pourrait aussi l'affirmer.

## S'il n'y a aucune clé avec laquelle continuer

Parfois, la communauté n'indique pas une clé unique pour la personne dans une discussion entre deux membres : elle en liste plusieurs, ou aucune. Il n'y a alors personne pour qui verrouiller vos messages, que vous l'ayez marquée comme vérifiée ou non. Le bandeau le signale et ne propose que **Pas maintenant**, rien n'est envoyé, et la discussion porte la pastille **clé modifiée** dans **Chat**. L'écran du code de clé indique **Cette communauté n'indique aucune clé unique pour Ben dans cette discussion, les envois sont donc en attente.**

Parlez à la personne de vive voix ou par téléphone. Votre téléphone revérifie la discussion tout seul lorsque la liste de la communauté change, et une nouvelle discussion avec la même personne est cette même discussion.

Si votre téléphone n'a pas non plus pu associer les messages antérieurs à une clé unique, au-dessus du champ de message figure **Ce téléphone ne peut associer cette discussion à une clé unique, les envois sont désactivés. Les messages affichés peuvent ne pas venir de cette personne.**, et l'écran du code de clé n'a aucun code à afficher.

## Après avoir restauré ou reconfiguré votre téléphone

Votre téléphone confronte chaque discussion avec les messages antérieurs qu'il détient. Si ces messages provenaient d'une clé plus ancienne que celle que votre communauté indique désormais, la discussion continue avec la clé indiquée, les messages antérieurs restent lisibles, et la ligne grise s'affiche une fois.

Si votre téléphone ne parvient à associer certains d'entre eux à aucune clé, la discussion continue quand même avec la clé que votre communauté indique, sans ligne. Un message qu'il n'a pas pu ouvrir indique **Ce message n'a pas pu être vérifié, il n'est donc pas affiché.** Il reste ainsi.

## Mémoire des discussions

Votre téléphone conserve une mémoire légère pour chaque communauté : à quelle clé se rattache chacune de vos discussions, quelles personnes vous avez marquées comme vérifiées, et quelles discussions sont privées. Elle reste stockée sur le téléphone. Elle demeure sur le téléphone lorsque vous vous déconnectez, une déconnexion suivie d'une reconnexion ne l'efface donc pas. Le téléphone ne la réinitialise jamais de lui-même.

Vous pouvez la réinitialiser pour une communauté : ouvrez **Paramètres**, touchez **Mémoire des discussions** sous **Compte et identité**, touchez **Réinitialiser** à côté de la communauté, prenez connaissance de l'avertissement, puis touchez à nouveau **Réinitialiser**. L'application ne vous oriente ici que lorsqu'elle signale n'avoir pas pu lire cette mémoire et que réessayer n'a pas suffi.

Après une réinitialisation, votre téléphone revérifie chaque discussion de cette communauté depuis le début, à partir des messages qu'il conserve, comme après une restauration.

L'avertissement indique ce qui peut changer avant que vous confirmiez. Une discussion suspendue en raison d'un changement de clé peut s'ouvrir avec la nouvelle clé. Une discussion privée qui avait disparu de Chat peut réapparaître sous la forme d'une discussion de groupe lisible par la communauté. Les personnes que vous avez marquées comme vérifiées dans cette communauté redeviennent non vérifiées. Vérifiez le code de clé, ou les participants d'une discussion, avant d'envoyer quoi que ce soit.

Cela concerne l'application mobile. L'application web ne dispose pas d'une mémoire des discussions.

## Dans l'application web

L'application web ne mémorise pas les clés. À chaque envoi, elle verrouille votre message avec la seule clé que votre communauté indique pour la personne, et si elle en indique plusieurs ou aucune, votre message n'est pas envoyé. Elle n'affiche donc ni ligne grise ni bandeau, et elle n'a pas **Marquer comme vérifié** : une personne que vous avez marquée comme vérifiée sur votre téléphone n'a aucune pause dans l'application web.

Vous pouvez tout de même y lire les codes de clé. **Mon code de clé** se trouve dans **Paramètres**, sous **Compte et identité**. Dans une discussion entre deux personnes, le menu **⋮** contient **Code de clé** : il affiche le code de la personne et précise que le navigateur ne mémorise pas les codes de clé.

## Ce que votre téléphone peut vérifier, et ce qu'il ne peut pas

Pour une personne que vous n'avez pas marquée comme vérifiée, la liste de votre communauté décide de la clé à chaque changement, et votre téléphone vous le signale par la ligne grise. Sur un téléphone qui détenait déjà la discussion, une clé modifiée laisse toujours la ligne. Un téléphone que vous venez de restaurer peut être trompé : un serveur qui retient les messages les plus anciens ne laisse aucune ligne.

La ligne ne peut pas distinguer un nouveau téléphone d'une clé substituée. Seul le code de clé le peut, et seul **Marquer comme vérifié** fait s'arrêter votre téléphone la prochaine fois. Si une discussion compte pour vous, vérifiez le code en personne, ou lors d'un appel où vous êtes sûr que c'est elle, et marquez-la comme vérifiée.
