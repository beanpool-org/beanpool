---
slug: check-your-12-words
title: Vos 12 mots et clés (gestion)
summary: Pour les propriétaires d'une communauté. Vérifier vos 12 mots, reprendre la main ou restaurer le serveur avec votre téléphone, et vérification automatique par le téléphone.
related: your-12-words, recovery
source-hash: d556b0909b34ce9c
---

## À qui cela s'adresse

Uniquement aux **propriétaires** d'une communauté. Si vous n'êtes pas propriétaire, vous ne verrez rien de tout cela.

## Pourquoi les propriétaires sont sollicités

Le serveur de votre communauté conserve une copie verrouillée de ses clés, afin de pouvoir transférer la communauté vers un autre serveur si le sien venait à disparaître, et ses sauvegardes sont également verrouillées. Elles sont associées aux comptes des propriétaires : n'importe quel propriétaire peut les ouvrir avec son téléphone (voir « Reprendre le contrôle ou restaurer avec votre téléphone » ci-dessous). Si vous perdez votre téléphone, vos 12 mots vous permettent de récupérer votre compte, et avec lui votre clé d'accès au verrou du serveur et à ses sauvegardes. C'est le jour où le serveur lui-même n'est plus accessible que cela compte le plus.

L'application invite donc chaque propriétaire, de temps à autre, à vérifier qu'il possède toujours les bons 12 mots. Vous pouvez choisir **Plus tard**. Rien n'est jamais bloqué, et vous pouvez continuer à accomplir tout ce qu'un propriétaire peut faire.

## Quand l'application le demande

- Une fois, peu après que vous soyez devenu propriétaire.
- Puis 12 mois après votre dernière vérification.

Elle affiche une carte en haut du Marché (dans l'application web, en haut de chaque écran à l'exception de la Carte) : **Vérifier maintenant** ou **Plus tard**. **Plus tard** met la carte de côté jusqu'à la prochaine échéance. Vous pouvez faire la vérification à tout moment depuis les **Paramètres** : sous **Clés de la communauté**, touchez **Vérifier vos 12 mots** (dans l'application web, **Vérifier maintenant**).

## Comment vérifier

- Munissez-vous de votre feuille papier portant les 12 mots.
- Tapez-les dans l'ordre, séparés par des espaces. Les majuscules et les espaces superflus n'ont pas d'importance.
- Touchez **Vérifier mes mots**.

S'ils sont corrects, l'application indique **Ce sont les bons mots.** Sinon : **Ce ne sont pas les mots associés à ce compte.** Elle ne précise pas quel mot est erroné, vérifiez donc votre papier et saisissez-les à nouveau.

Sur un téléphone ne disposant pas d'une copie de vos 12 mots (un appareil restauré avec un compte de connexion), des mots corrects proposent également **Les enregistrer sur ce téléphone**. Touchez cette option et **Afficher la phrase de récupération** vous les présentera désormais. Il s'agit de la même vérification et du même enregistrement que dans **Ajouter vos 12 mots à ce téléphone** (voir « Vos 12 mots »).

Vous ne les retrouvez pas ? Si ce téléphone les conserve encore, ouvrez **Paramètres**, puis **Afficher la phrase de récupération** pour les voir. Recopiez-les à nouveau, puis faites la vérification. Sur un téléphone qui n'en possède pas de copie, l'application vous l'indique : lorsque vous les retrouverez, vérifiez-les ici, puis enregistrez-les.

## Ce qui est transmis, et ce qui ne l'est pas

- La vérification s'exécute sur votre téléphone (ou dans votre navigateur, dans l'application web). Vos mots ne sont jamais envoyés nulle part. Le champ de saisie est vidé dès que la vérification donne son résultat, ainsi que dès que vous quittez l'écran. Ils ne sont enregistrés que si vous touchez **Les enregistrer sur ce téléphone**, et uniquement sur ce téléphone.
- Quand les mots sont corrects, votre téléphone informe le serveur de votre communauté uniquement du fait que vous avez vérifié vos mots et à quelle date, avec la signature de votre compte.
- Les propriétaires et administrateurs voient, dans les Paramètres du serveur, la date de vérification des 12 mots de chaque propriétaire, ou la mention « pas encore ». C'est votre propre déclaration : le serveur ne peut ni voir ni vérifier vos mots.

## Reprendre le contrôle ou restaurer avec votre téléphone

Si le serveur de votre communauté est perdu, la personne qui gère son serveur de secours (ou un nouveau serveur restaurant une sauvegarde) peut demander à un propriétaire d'ouvrir les clés verrouillées. Un seul propriétaire suffit. Vous avez besoin de la version la plus récente de l'application BeanPool. L'application web fonctionne également si elle s'ouvre encore, mais elle réside à l'adresse propre à votre communauté, qui est susceptible d'être tombée avec le serveur : c'est sur l'application mobile qu'il faut compter.

- Dans les Paramètres du serveur, elle choisit **Prendre le contrôle comme serveur principal**, puis **J'ai compris : utiliser le téléphone d'un propriétaire**, ou **Ouvrir avec le téléphone d'un propriétaire** lors de la restauration d'une sauvegarde. Un code s'affiche sur son écran.
- Dans l'application : **Paramètres**, sous **Clés de la communauté**, touchez **Reprendre le contrôle ou restaurer avec ce téléphone**, et pointez l'appareil photo vers le code. Si la page du serveur est ouverte sur votre propre téléphone, toucher son lien produit le même effet. Dans l'application web, copiez le lien depuis son écran et collez-le sous **Prendre le relais ou restaurer avec ce navigateur** dans les **Paramètres**.
- L'application affiche de quelle communauté il s'agit, quel serveur, et ce qui va se passer. Si votre serveur principal répond toujours, elle le signale en rouge : une reprise de contrôle n'est destinée qu'à un serveur réellement disparu.
- Touchez **Déverrouiller pour la prise de contrôle** (ou **Déverrouiller la sauvegarde**). Votre téléphone sollicite son propre déverrouillage au préalable : empreinte, visage ou code PIN. L'application web ne dispose pas d'une telle étape, c'est pourquoi l'application mobile constitue l'endroit le plus sûr pour la clé d'un propriétaire.
- Votre téléphone déverrouille sa propre partie du cadenas et remet la clé à ce serveur, chiffrée afin que seul ce serveur puisse la lire. Votre téléphone ne voit jamais les clés du serveur ni la sauvegarde.
- Lors d'une prise de contrôle, la personne devant le serveur confirme alors sur son écran. La communauté est informée du transfert et du fait que vous avez ouvert les clés.

L'application refuse, en expliquant la raison, si le verrou appartient à une autre communauté, s'il n'est pas verrouillé pour vous, si le code du serveur a expiré (il est valable 10 minutes et ne fonctionne qu'une seule fois), ou si les clés n'ont pas été verrouillées par le propre serveur de votre communauté.

## Votre téléphone vérifie le verrou de lui-même

Chaque fois que le verrou de votre communauté est modifié (ajout ou retrait d'un propriétaire, création d'un nouveau code de récupération), votre application vérifie, en toute discrétion, qu'elle serait toujours en mesure d'ouvrir sa partie. Elle l'ouvre, efface immédiatement la clé, et indique au serveur si cela a fonctionné. Rien ne vous est demandé.

Les propriétaires et administrateurs le voient dans les Paramètres du serveur, à côté de la date de vos 12 mots : **leur téléphone a ouvert le verrou actuel**, avec la date, ou qu'il a ouvert un verrou plus ancien la dernière fois. S'il est indiqué que votre téléphone **n'a PAS pu ouvrir** le verrou, vérifiez vos 12 mots et demandez à un autre propriétaire de consulter les Paramètres du serveur.
