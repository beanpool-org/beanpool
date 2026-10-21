---
slug: key-changed
title: Si la clé d'un contact change
summary: Pourquoi les messages cessent d'arriver, comment vérifier le code de clé avec la personne et quand reprendre.
related: messages, your-12-words, people
source-hash: c6be30fdc4888113
---

## Ce que cela signifie

Chaque message entre deux personnes est verrouillé afin que seul le téléphone de votre correspondant puisse l'ouvrir. Il est verrouillé avec sa **clé**, et non avec son nom. Votre téléphone garde en mémoire la clé avec laquelle il a verrouillé vos échanges jusqu'alors.

Si votre communauté indique désormais une clé différente pour cette personne, votre téléphone s'interrompt et vous en avertit, plutôt que d'envoyer silencieusement vos messages vers la nouvelle clé. En haut de la discussion, vous voyez **La clé de cette discussion a changé.** (ou **La clé de « Ben » a changé.**). Le champ de saisie du message est grisé et indique que l'envoi est suspendu.

Vos messages antérieurs avec cette personne restent généralement lisibles comme auparavant. Sur un téléphone que vous venez de restaurer ou de reconfigurer, les messages issus de la nouvelle clé indiquent **Envoyé avec la nouvelle clé. S'affiche une fois que vous continuez.** jusqu'à ce que vous preniez une décision.

Cela concerne l'application mobile. L'application web ne mémorise pas encore les clés.

## Pourquoi cela arrive

- **La personne a changé de téléphone et renouvelé sa clé.** C'est la raison la plus courante. Son ancienne clé ayant disparu, elle en a reçu une nouvelle.
- **Une anomalie s'est produite.** Le serveur d'une communauté liste les participants de chaque discussion. Un serveur malveillant cherchant à lire vos messages pourrait associer la clé d'un tiers au nom de votre ami. Le nom semble correct, mais la clé ne l'est pas.

Votre téléphone ne peut pas faire la distinction par lui-même. Vous le pouvez, grâce au code de clé.

## Vérifier le code de clé avec la personne

- Le bandeau affiche un code : 20 chiffres répartis en cinq groupes de quatre.
- Demandez à la personne d'ouvrir les **Paramètres**, puis **Protection du compte**, et de vous lire **Mon code de clé**.
- **Mon code de clé** n'existe que dans l'application mobile. Si la personne n'utilise que l'application web, elle ne peut pas encore vous le lire : touchez **Pas maintenant** jusqu'à ce qu'elle puisse ouvrir l'application mobile.
- Vérifiez-le **en personne, ou lors d'un appel téléphonique ou vidéo** où vous avez la certitude de vous adresser à elle. Ne le vérifiez pas par message dans BeanPool : si la clé n'est pas la bonne, votre interlocuteur ne l'est pas non plus.
- Si chaque chiffre concorde, cochez **J'ai vérifié avec Ben : le code de clé dans ses Paramètres correspond à celui-ci**, puis touchez **Continuer avec la nouvelle clé**.

Dès lors, vos messages partent vers la nouvelle clé. Le bandeau et la pastille **clé modifiée** sur la discussion dans **Échanges** disparaissent, et vos messages antérieurs restent lisibles.

Le code n'est pas secret. Il peut être énoncé à voix haute sans danger.

## Si le code ne concorde pas, ou si vous ne pouvez pas vérifier

Touchez **Pas maintenant**. Rien n'est envoyé et rien ne change. Vous pourrez revenir dans la discussion plus tard.

Une discussion en pause peut le rester jusqu'à ce que vous choisissiez de continuer. Il n'existe aucun autre moyen de poursuivre les échanges : votre communauté ne conserve qu'une seule discussion pour vous deux, démarrer une nouvelle discussion avec la même personne rouvre donc exactement cette même discussion.

Si le code ne concorde pas, ne continuez pas. Prévenez la personne et les administrateurs de votre communauté : quelqu'un tente peut-être d'intercepter vos messages.

## Si le bandeau ne propose aucune clé avec laquelle continuer

Parfois, la communauté n'indique pas une clé unique pour la personne dans une discussion entre deux membres : elle en liste plusieurs, ou aucune. Il n'y a alors aucune clé avec laquelle continuer, le bandeau le signale et ne propose que **Pas maintenant**. Rien n'est envoyé. Échangez avec la personne de vive voix ou par téléphone. Votre téléphone revérifiera la discussion tout seul lorsque la liste de la communauté changera, et une nouvelle discussion avec la même personne correspondra à cette même discussion.

## Si le bandeau indique que votre téléphone vérifie la discussion depuis le début

Après avoir restauré votre téléphone à partir de vos 12 mots, ou après avoir mis l'application à jour, votre téléphone confronte chaque discussion avec ses propres messages antérieurs. Si ceux-ci proviennent d'une clé distincte de celle que votre communauté indique désormais pour cette personne, le bandeau débute par : **Ce téléphone vérifie cette discussion depuis le début, comme après une restauration ou une mise à jour.** Vérifiez le code avec la personne comme indiqué ci-dessus. Après avoir réinitialisé la mémoire des discussions de la communauté, il commence plutôt par : **La mémoire des discussions de cette communauté a été réinitialisée, le téléphone revérifie cette discussion depuis le début.**

## Mémoire des discussions

Votre téléphone conserve une mémoire légère pour chaque communauté : à quelle clé se rattache chacune de vos discussions, et quelles discussions sont privées. Elle reste stockée sur le téléphone, et le serveur de la communauté ne peut pas déplacer une discussion vers une autre clé de son propre chef : vous seul le pouvez, depuis le bandeau. Elle demeure sur le téléphone lorsque vous vous déconnectez, une déconnexion suivie d'une reconnexion ne l'efface donc pas. Le téléphone ne la réinitialise jamais de lui-même.

Vous pouvez la réinitialiser pour une communauté : ouvrez les **Paramètres**, touchez **Mémoire des discussions** sous **Compte et identité**, touchez **Réinitialiser** à côté de la communauté, prenez connaissance de l'avertissement, puis touchez à nouveau **Réinitialiser**. L'application ne vous oriente ici que lorsqu'elle signale n'avoir pas pu lire cette mémoire et que réessayer n'a pas suffi.

Après une réinitialisation, votre téléphone revérifie chaque discussion de cette communauté depuis le début, à partir des messages qu'il conserve. Une discussion dont les messages proviennent d'une autre clé que celle désormais fournie par la communauté affiche à nouveau le bandeau, débutant par **La mémoire des discussions de cette communauté a été réinitialisée, le téléphone revérifie cette discussion depuis le début.** Vérifiez le code avec la personne comme vu plus haut.

Deux conséquences peuvent survenir après une réinitialisation, et l'avertissement vous en informe avant confirmation : une discussion suspendue en raison d'un changement de clé peut s'ouvrir avec la nouvelle clé, et une discussion privée qui avait disparu d'Échanges peut réapparaître sous la forme d'une discussion de groupe lisible par la communauté. Vérifiez le code de clé ou les participants d'une discussion avant d'envoyer quoi que ce soit.

Une réinitialisation ne résout rien pour une discussion que votre téléphone ne parvient pas à associer à une clé unique : elle sera revérifiée et se bloquera à nouveau. Vérifiez plutôt le code avec la personne (ci-dessus).

Cela concerne l'application mobile. L'application web ne dispose pas d'une mémoire des discussions.

## Si le bandeau indique que votre téléphone ne peut associer la discussion à une clé unique

Parfois, les messages antérieurs d'une discussion étaient verrouillés avec des clés que votre téléphone ne peut pas rattacher à une personne précise. Au-dessus du champ de message, il est indiqué : **Ce téléphone ne peut associer cette discussion à une clé unique, les envois sont désactivés.** et le bandeau affiche le code de la clé que votre communauté indique désormais pour cette personne.

Certains messages peuvent tout de même s'afficher. Ils peuvent ne pas provenir de la personne dont le nom figure sur la discussion : ses propres messages antérieurs peuvent être ceux qui indiquent **🔒 Ce message n'a pas pu être vérifié, il n'est donc pas affiché.** Ceux-ci restent dans cet état, même après avoir continué.

Vérifiez le code avec la personne comme indiqué plus haut, en direct ou lors d'un appel. S'il correspond, cochez la case et touchez **Continuer avec la nouvelle clé** : dès lors, vos messages partiront vers cette clé. S'il ne correspond pas, ou si vous ne pouvez pas vérifier, touchez **Pas maintenant**. Une nouvelle discussion avec la même personne ramenant à cette même discussion, il n'y a rien d'autre à tenter. Si la communauté ne liste aucune clé unique pour elle, le bandeau ne propose que **Pas maintenant**, et votre téléphone revérifiera la discussion tout seul dès que la liste de la communauté sera modifiée.

## Ce que votre téléphone peut vérifier, et ce qu'il ne peut pas

Votre téléphone confronte une discussion avec les messages qu'il détient déjà. Un téléphone restauré, ou un téléphone existant au moment de la mise à jour, est uniquement guidé par un serveur qui retient ou tronque la partie la plus ancienne de la discussion dans ses envois. Un téléphone qui détenait déjà cette partie la plus ancienne n'est influencé par aucun envoi ultérieur du serveur après la mise à jour.

Par conséquent, un téléphone que vous venez de restaurer ou de mettre à jour peut être trompé sur la clé d'une discussion. Un bandeau ne peut pas l'exclure formellement. **Confirmez une clé modifiée en personne**, ou lors d'un appel téléphonique ou vidéo où vous avez la certitude de reconnaître votre interlocuteur.

## Si la communauté fournit une date

Lorsque votre communauté est en mesure de prouver que la clé du compte a été renouvelée, le bandeau le précise, par exemple : **Cette communauté indique que la clé du compte a été renouvelée le 3 oct. 2026.** Cela vous éclaire sur ce qui s'est produit, sans dispenser de vérifier le code : un serveur pourrait également l'affirmer faussement.
