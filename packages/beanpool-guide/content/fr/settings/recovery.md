---
slug: recovery
title: Récupérer votre compte
summary: Restaurez votre compte sur un nouveau téléphone et protégez-le en associant un compte de connexion.
related: your-12-words, leaving-or-deleting, communities, faq, key-changed
help: Comment récupérer votre compte sur un nouveau téléphone : vos 12 mots ou un compte de connexion associé.
source-hash: c12dcedd3fb28fb7
---

## Sur un nouveau téléphone

La clé de votre compte ne figure pas dans les sauvegardes de votre téléphone. Un nouveau téléphone a besoin de vos 12 mots ou d'un compte de connexion associé, même s'il s'agit d'un iPhone restauré depuis la sauvegarde de l'ancien.

- Installez BeanPool et ouvrez l'application.
- Touchez **Déjà membre ? Restaurer le compte**.
- Choisissez **Récupérer avec 12 mots** ou **Récupérer avec un compte social**.

## Avec vos 12 mots

- Saisissez les 12 mots dans l'ordre, ou touchez **Coller**.
- Sous **Quelle communauté ?**, touchez **Communauté globale**, ou l'une des communautés que ce téléphone a déjà connues. Pour toute autre communauté, touchez **une autre adresse** et saisissez le nom ou l'adresse de votre communauté.
- Touchez **Récupérer l'identité**. Vos nom et photo sont restaurés depuis votre communauté.

## Avec un compte de connexion

Cela ne fonctionne que si vous en aviez associé un au préalable (voir ci-dessous), et uniquement tant que le serveur de votre communauté est en fonctionnement.

- Saisissez votre nom dans la communauté. L'application peut proposer « Est-ce vous ? ».
- Saisissez le nom ou l'adresse de votre communauté.
- Touchez **Récupérer avec** et le compte que vous avez associé : Google ou Facebook, ou Apple sur un iPhone.
- Avec Google sur un iPhone, une page web Google s'ouvre. Connectez-vous et choisissez le compte associé. Sur Android, Google présente sa propre liste de comptes. S'il ne peut pas en afficher sur ce téléphone, une page web Google s'ouvre à la place.

Si le compte de connexion a été associé depuis un téléphone disposant de vos 12 mots, sur une application à jour, vos 12 mots sont également restaurés. Dans le cas contraire, le téléphone ne possède pas de 12 mots : ils ne peuvent pas être reconstitués à partir d'une connexion. Si vous les avez notés sur papier, vous pouvez les ajouter (voir « Vos 12 mots »). D'ici là, un compte de connexion associé reste le seul moyen d'accès pour ce téléphone : gardez-en donc un associé, et associez-en un deuxième si vous le pouvez (voir ci-dessous).

## Protéger votre compte dès maintenant

- Ouvrez les **Paramètres** et touchez **Protection du compte**.
- Sous **Fournisseurs de récupération par connexion (1 parmi N)**, touchez **Protéger avec** et choisissez un compte.
- Validez le contrôle de l'écran de verrouillage de votre téléphone. Le compte associé pouvant restaurer votre compte, l'application effectue cette vérification préalable.
- Avec Google sur un iPhone, une page web Google s'ouvre. Connectez-vous, sélectionnez votre compte et vous revenez dans BeanPool.

Cela fonctionne également sur un téléphone dépourvu de 12 mots.

Si vous avez rejoint la communauté globale avec 12 mots, utilisez plutôt **Ajouter une connexion**, près du haut de **Protection du compte**. C'est également un moyen de récupération, qui lève en outre les limites imposées aux nouveaux comptes à 12 mots. Voir « Vos 12 mots ».

Si ce téléphone possède vos 12 mots, le compte associé les conserve également, de sorte qu'une restauration avec ce compte vous les restitue. Un compte associé sur une ancienne version de l'application ne conserve que votre clé : touchez **Associer à nouveau** à côté, et validez le verrouillage d'écran de votre téléphone pour y inclure les mots. Sur un téléphone sans 12 mots, il n'y a rien à inclure, **Associer à nouveau** n'est donc pas affiché.

Il ne s'agit pas d'un moyen de vous connecter au quotidien. Votre compte reste votre propre clé. Le compte associé vous aide uniquement à la récupérer, dans cette communauté.

Pour le retirer, touchez **Déconnecter**.

## Si vous aviez associé GitHub

BeanPool n'utilise plus GitHub. L'identifiant d'un compte GitHub étant public, une copie verrouillée avec celui-ci n'était pas protégée par un élément que vous êtes seul à détenir. Dès que le serveur de votre communauté est mis à jour, il supprime toute copie associée à GitHub. Votre compte lui-même n'est pas touché, et vos 12 mots fonctionnent toujours.

- Si GitHub était le seul compte associé et que vos 12 mots sont sur ce téléphone sans être notés sur papier, notez-les dès maintenant (**Paramètres**, puis **Afficher la phrase de récupération**), ou associez Google, Facebook ou (sur iPhone) Apple, comme indiqué ci-dessus. Tant que vous n'avez pas accompli l'une de ces démarches, ce téléphone constitue votre unique accès à votre compte.
- Si vos 12 mots sont écrits sur papier, vous n'avez rien à faire. Pour disposer également d'un compte de connexion, associez Google, Facebook ou (sur iPhone) Apple, comme indiqué plus haut.
- Si GitHub était le seul compte associé, que ce téléphone n'a pas de 12 mots et que vous ne les avez pas notés sur papier, associez Google, Facebook ou (sur iPhone) Apple dès maintenant. Sans cela, ce téléphone est votre seul moyen d'accéder à votre compte.

## Qui peut ouvrir la copie

Un compte de connexion associé fonctionne parce que le serveur de votre communauté en conserve une copie verrouillée de votre compte. Les personnes administrant ce serveur peuvent ouvrir cette copie, car leur serveur vérifie votre connexion. Sur la communauté globale, il s'agit de BeanPool. Une copie dérobée de la base de données du serveur ne le permet pas, une fois le serveur mis à jour à cet effet. Quiconque prend le contrôle de votre compte de connexion peut également y accéder : voir « Si quelqu'un d'autre essaie ».

Si vous préférez que personne d'autre que vous ne puisse y accéder, utilisez uniquement vos 12 mots : gardez-les notés sur papier, et touchez **Déconnecter** à côté de chaque compte de connexion. La déconnexion supprime la copie. Un serveur de secours, le second serveur que certaines communautés maintiennent prêt à prendre le relais, supprime également sa copie lors de sa synchronisation suivante avec le serveur principal (environ une fois par minute). La déconnexion ne supprime pas les copies figurant déjà dans les sauvegardes du serveur, ni la copie conservée par le serveur à titre d'archive chaque fois qu'une connexion restaure votre compte. Les personnes gérant le serveur peuvent également les ouvrir.

## Si quelqu'un d'autre essaie

Si quelqu'un commence à récupérer votre compte, les Paramètres affichent **Quelqu'un est en train de récupérer votre compte** tant que l'opération est en cours. S'il ne s'agit pas de vous, touchez **Arrêter maintenant** : le serveur de votre communauté ne transmettra plus rien à cette tentative de restauration. Si la personne accède à votre compte à l'aide de votre compte de connexion associé, vous recevez une alerte vous prévenant que votre compte vient d'être restauré sur un autre appareil, et elle est peut-être déjà connectée au moment où vous le voyez. Protégez bien ce compte de connexion avec un mot de passe fort et exclusif.

## Si le téléphone contient déjà un compte

Restaurer un autre compte remplace celui présent sur ce téléphone, que vous utilisiez vos 12 mots ou un compte de connexion. L'application demande d'abord confirmation sur l'écran **⚠️ Remplacer le compte de ce téléphone ?** (avec un compte de connexion, une fois connecté). Rien ne change tant que vous n'avez pas tapé **WIPE**, touché **Remplacer le compte** et validé le contrôle de l'écran de verrouillage de votre téléphone. Touchez **Conserver**, puis le nom du compte, **retour** pour laisser tout tel quel.

Assurez-vous de posséder les 12 mots du compte que vous remplacez. Si ce téléphone les détient, cet écran les affiche lorsque vous touchez **Afficher les 12 mots de** (le nom du compte) et validez le verrouillage d'écran. Si ce téléphone ne dispose pas des 12 mots pour ce compte (les Paramètres l'indiquent), sans compte de connexion associé vous ne pourrez plus le récupérer.

## Perte du téléphone et de vos 12 mots

Sans vos 12 mots et sans compte de connexion associé, un administrateur de votre communauté peut transférer votre compte vers un nouveau téléphone, avec vos haricots, votre nom et votre historique. Rendez-vous auprès de lui en personne : il s'assurera au préalable de votre identité.

- L'administrateur génère un code de renouvellement de clé sur son écran. Si votre ancien téléphone possède toujours l'application, il reçoit une notification indiquant qu'un administrateur a commencé à déplacer votre compte.
- Sur votre nouveau téléphone, ouvrez BeanPool, touchez **Déjà membre ? Restaurer le compte**, puis **Un administrateur m'a donné un code de renouvellement de clé**. Scannez le code QR sur l'écran de l'administrateur, ou tapez le code (qui commence par RK-) et le nom de votre communauté. Dans un navigateur, le lien du QR ouvre le même écran ; ou ouvrez l'application web de votre communauté, touchez **Je suis déjà membre →**, puis **Un administrateur m'a donné un code de renouvellement de clé**, et saisissez le code.
- Votre téléphone affiche un nombre à deux chiffres, et en dessous l'adresse de la communauté sollicitée. Montrez les deux à l'administrateur : il saisit le nombre sur son écran. Ce nombre garantit que c'est bien votre téléphone qui est associé, et non celui d'une personne ayant aperçu le code. **Pas maintenant** quitte cet écran : votre téléphone conserve sa place, et le même code présentera à nouveau le même nombre.
- Si le nouveau téléphone n'avait pas de compte BeanPool, il affiche ensuite les 12 mots de votre **nouvelle** clé. Notez-les : vos anciens mots ne fonctionnent plus, et votre ancien téléphone cesse définitivement de fonctionner. Un téléphone qui possédait déjà un compte (pour une autre communauté) conserve les 12 mots de ce compte, qui permettent désormais de restaurer également ce compte-ci.
- Si vous aviez associé un compte de connexion, votre téléphone vous invite à l'associer à nouveau dans Protection du compte : celui que vous aviez protégeait votre ancienne clé, il a donc été retiré.
- Les personnes avec qui vous échangez verront que votre clé a changé. Confirmez-leur qu'il s'agit bien de vous et lisez-leur votre **Mon code de clé**, dans les **Paramètres** sous **Protection du compte** sur le téléphone. Voir « Si la clé d'un contact change ».

Le code est valable 24 heures. Si l'administrateur vous signale que votre téléphone ne correspond pas à celui qu'il voyait, ou si le code expire, demandez-lui en un nouveau.
