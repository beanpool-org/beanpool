---
slug: access-and-security
title: Access and security
summary: Changing or retiring the admin password, two-factor sign-in, break-glass codes, signing out everywhere, and the factory reset. Under Appliance & Data, then Access & Security.
related: signing-in, roles, first-time-setup, rate-limits
---

## Change the admin password

Type the current password and a new one. The new one needs at least 8 characters, with an upper-case letter, a lower-case letter, a digit and a symbol. Only an owner can change it, and only by typing the current password, even when signed in from the app.

![The Access and Security screen in Settings](images/appliance-access.webp)

Change it whenever someone who knew it steps down. Everyone who has it is an owner.

If an older version of the server made up the first password (ADMIN_PASSWORD was empty; a new install makes none), changing it deletes data/first-admin-password.txt at once. The log says so.

On a server whose password is retired (below) there is nothing to change: this card is refused.

## Retire the admin password

The admin password is one shared secret that makes whoever knows it an owner, from anywhere on the internet. Once every owner signs in with their phone, you can remove it for good. Only an owner signed in with their phone (Manage, or **Sign in with your phone** on a computer) can do it, under Access & Security, **Retire the admin password**. Signed in with the password itself, or with an automation token, you can't.

- **First, make your break-glass code** (below) and keep it safe. Settings asks for it before it lets you retire the password: once the password is gone, it is how you get back in if your phone is lost.
- **Keep two owners.** With only one, Settings asks you to tick **I accept one owner**, and the server's log records that you did.
- **Move your scripts first.** Anything that sends the password (the fleet manager, backup scripts) stops working. Give each one an automation token (below). They then say "This node's password is retired: use a token".
- Type **RETIRE** and press **Retire the admin password**.

What happens: the password and the two-factor sign-in that guarded it are deleted; every sign-in made with the password ends at once, live log views included; every member sees a notice that the password was retired, and by whom; the server's log records it. The card then says **Retired on** the date **by** the owner.

What stays: Manage in the app, **Sign in with your phone** on a computer, your break-glass code, automation tokens, and beanpool recover on the server. The sign-in page shows no password field any more, and the old settings page points to the phone.

It is for good. No setting brings the password back, and ADMIN_PASSWORD in .env is ignored on every later start (the log says so once; take it out of .env). Factory reset keeps it retired too. A take-over, or restoring a locked backup, keeps it retired on a server that knows, even from a backup or take-over copy made before you retired it. A server that never knew, given one made before, gets the old password back with it: a standby until its next copy, or a new server you restore an older backup onto. So let each standby copy once after you retire it, and retire it again on any server you restore an older backup onto. If every owner loses their phone and 12 words: a break-glass code, a second owner, or beanpool recover on the server (Signing in).

## Two-factor sign-in

Two-factor sign-in asks for a 6-digit code from an authenticator app as well as the password. Settings asks for it with the password. On a server where it is off, signing in with the password opens one card only, which says "Set up two-factor sign-in to open Settings: the admin password alone is not enough." Nothing else in Settings opens until the server accepts a code from your new authenticator; then Settings opens at once, without signing in again. Meanwhile the server keeps running and serving members, the card always opens for the password, and **Log Out** is on it. If two-factor sign-in is switched off later, the next thing the password does brings that card back. It is for the password only: signing in from the app (Manage, Moderate, or a computer signed in by scanning a code) never asks for it, because the phone's own lock is that person's second factor. See Signing in.

**Tools that send the password with every request need two-factor sign-in too.** While it is off, the server refuses the password sent with a request instead of a sign-in (scripts, the harvester, the fleet manager's profiles), whatever it asks for, with "Turn on two-factor sign-in in Settings, or use an automation token made from your phone". Give such a tool an automation token instead (below): it needs no code. With two-factor sign-in on, a tool that sends the password with a current code still works, as before.

**The legacy Settings page needs two-factor sign-in on.** The older page (**Switch to Legacy Settings Page**) sends the password with every request, so while two-factor sign-in is off it stays on its sign-in screen and says "Turn on two-factor sign-in in Settings (the new page), then come back". Turn it on in Settings, then sign in there with the password and a code.

Two things still take the password alone while two-factor sign-in is off:

- A standby that still copies with the password keeps copying, until you make copying take the replication token only (Live Backup Server). It cannot swap its password for a replication token on its own any more: its log says to make one on this server from the owner's phone (Replication Access) and paste it into the standby.
- A break-glass code still adds an admin key (below): the code is itself the thing you hold.

**Before you update a server whose two-factor sign-in is off:** turn two-factor sign-in on, or move every tool that sends the password onto an automation token, and give each standby that copies with the password a replication token. Otherwise those tools stop working once the server is updated.

- Press **Setup 2FA Authenticator** and scan the QR code with an authenticator app, or type the secret it shows.
- Type the 6-digit code the app shows, and press **Verify & Enable**. Until you do, nothing changes.
- There is one code for the whole server, not one per person. Everyone who signs in with the password needs it. Owners, admins and moderators who sign in from the app don't.
- Once you have typed a code, the browser does not ask again for **4 hours** of use.
- Each code works once. A code the server has already taken, from anyone, is refused with "That 2FA code was already used. Wait for the next one from your authenticator app." The next code comes within 30 seconds. So someone who saw a code over your shoulder can't use it after you, and two people signing in together need a code each.
- Only an owner can switch it on or off.

Know its limits:

- It covers every action in Settings: changing the password, the factory reset, the community's name and address, invites, peer links and the money thresholds all ask for the code as well as the password.
- Switching it off needs an owner and a code the authenticator shows **right now** (or a backup code). Being signed in already is not enough, whether from the app or with the password and a code typed earlier.
- Moving to a new authenticator needs a current code from the old one, or a backup code, too. In Settings: switch two-factor sign-in off with a current code, then set it up again on the new phone.
- Wrong codes there count like wrong passwords, and back off the same way: see Rate limits.
- There is one code for everyone. Anyone who has the password and the authenticator (or its secret) can do everything an owner can, so guard both.
- The server makes eight single-use backup codes when you set it up. The card the password opens, and the setup wizard, show them once: write them down or save them then, because the server keeps only a scrambled copy. To see a new set later, an owner types the 6-digit code the authenticator shows now under **New backup codes** in the two-factor card (a backup code does not work there). Settings shows the eight new codes once; the old ones stop working at that moment. Keep them apart from the phone. Admins and moderators do not see this. Each backup code works once in place of a code. Keep the authenticator secret somewhere safe too.
- If you lose the authenticator: sign in with a backup code in place of the code. If none is left, owners still get in from the app's Manage button, which never asks for the code, but the password stays locked behind the lost authenticator. If no owner can sign in from the app either, beanpool recover (Signing in) makes a member an owner from the server, and that owner then signs in from the app. Deleting data/local-config.json is not needed, and it loses every setting in it.

## Break-glass codes

A break-glass code belongs to one owner. It starts with **bg-** and does one thing: it lets you add a new admin key, for example when you have lost the phone your key was on. Anywhere else in Settings it is refused, as a wrong password is, and counts as one. An owner makes one under Access & Security, **Make a break-glass code**. Signed in with your key, the code is for your own key. Signed in with the admin password, paste the member key of the owner it is for. Settings shows it once; making a new one stops the old one working. Admins and moderators have none. In the app, an owner finds **Break-glass code** under Community admin in Settings: it asks for the phone's unlock and shows a new code once. The app keeps no copy, since the code is for when that phone is lost: write it down.

- The server's log records that a code was made and for whom, never the code itself.
- Using it shows every member a notice: "Break-glass recovery used to authorise a new admin key for @callsign". The server's log records whose code it was.
- The server keeps only a scrambled copy of it, made slow to guess, so a copy of the server's data does not give it away.
- If two-factor sign-in is on, it still asks for the code. If it is off, the code alone is enough: the admin password alone does not add a key.
- When an owner signs out everywhere (see Signing out everywhere, below), their code stops working too, so a code someone made from a stolen session does not outlast it. Make a new one afterwards. Signing someone else out leaves their code alone.
- Adding the key of someone who is already an owner again keeps their code. A new owner gets a code of their own when they are added.
- In **Owners & admins**, each owner's row says when their code was last made, and from where: a key session in Settings, their phone, the admin password, a break-glass sign-in, or beanpool recover on the server. If it was made at a time you don't recognise, make a new one.

Keep it offline, like a spare key. Anyone who has it can add an admin key of their own, and the notice is then the community's only warning.

## Signing out everywhere

Lost a phone, or signed in to Settings on a computer that isn't yours? **Sign out everywhere** ends every Settings sign-in of yours at once, on every computer and phone.

- In Settings, signed in with your key: **People & Safety**, then **Owners & admins**, at the bottom. It asks first, then shows the sign-in screen, since this computer is signed out too.
- In the app: **Settings**, under Community admin, **Sign out everywhere**. Owners, admins and moderators all have it. It asks first, then says what happened.
- An owner's break-glass code stops working too. Make a new one afterwards.
- Your key stays on your phone: press **Manage** in the app to sign in again.
- It ends only your own sign-ins. Settings opened with the admin password has no sign-ins of anyone's to end, so it doesn't show the button, and the server refuses an automation token here.
- Automation tokens are not sign-ins: tokens made earlier keep working afterwards. If someone else may have signed in as you, an owner should open **Automation tokens** (below) and revoke any token nobody recognises. Only owners see that card.

## Automation tokens

An automation token lets a script, or a tool like a fleet manager, use this node's Settings without the admin password. An owner makes one under Access & Security, **Automation tokens**: give it a name that says what will use it, pick what it may do, and, if you like, when it stops working. Admins and moderators do not see this card.

You make a token with your owner key, never with the admin password: open Settings from **Manage** in the app, or sign in on a computer by scanning a code with the app. Signed in with the password, the card lists the tokens and lets you revoke them, but has no form for making one. That way every token belongs to an owner.

What a token may do is its scope:

- **Read**: look, change nothing. Dashboards and checks.
- **Backups**: take a backup or snapshot, list them, send one off the box and download one. Nothing else: not restoring, not deleting, not changing where backups go.
- **Admin**: what an admin can do in Settings.

No token, whatever its scope, makes an owner-only change. It cannot change who is an owner or admin, the admin password or two-factor sign-in, break-glass codes or mode, the public address, the replication token, or other tokens, and it cannot restore a backup, reset the node or sign anyone in to Settings. Do those signed in as an owner.

- Settings shows the token once, when you make it. Copy it then: the server keeps only a scrambled copy and cannot show it again. If you lose it, revoke it and make a new one.
- The script sends it in the Authorization header, as Bearer followed by the token (it starts with bp_). It needs no two-factor code: it was made with an owner's key. Keep it as you would the password.
- What a script does with a token counts as done by the owner who made it, and the server's log records each use with the token's id, never the token itself. The list shows when and where each token was last used.
- Any owner can revoke any token, signed in with their key or with the password, and it stops working at once. A token also stops working when the owner who made it is no longer an owner: removed, made an admin, or suspended.
- Tokens stay on this server: they are not in backups, standby copies or a take-over.

### Scripts and the harvester

The scripts that come with BeanPool take a token in the environment variable **BEANPOOL_TOKEN**, never on the command line: anyone else on that computer can see a command line. With a token set they send the token alone and never the password. They still read the admin password from the environment variable **ADMIN_PASSWORD** (setup-backup also from --admin-pw, with a warning that anyone on the computer can see it; ADMIN_PASSWORD wins when both are set), but on a current server **the password alone opens nothing**: with two-factor sign-in off the server refuses it, and with it on the server asks for a code the scripts never send. setup-backup then stops, writes nothing and says to use a token. The password works only on a server from before this change. Use a token. What each needs:

- **scripts/grant-operator.mjs** (let a member run an enterprise) and **scripts/bootstrap-community-eggs.mjs**: an **Admin** token.
- **scripts/setup-backup.mjs** (set up a standby): a **Read** token, to fetch the community's identity. No token can make the replication token, because that is an owner's change: an owner makes it under **Replication Access**, signed in from the app, and you give it to the script in the environment variable **BACKUP_REPLICATION_TOKEN**: that token reads the whole ledger, so it stays off the command line too. (--token still works, with a warning that anyone on the computer can see it.) Without one the script stops and says so before it changes anything.
- **scripts/federation/fed.mjs**: an **Admin** token for each server, in BEANPOOL_TOKEN_ followed by the server's name in capitals (for example BEANPOOL_TOKEN_GIPPSLAND).
- **The harvester** (the fleet's backup puller): a **Backups** token, as "automationToken" in that server's entry in manager-nodes.json. It then takes the server's backups with the token alone and sends no password. It asks for the server's member and post counts with no password at all, because anyone may see those. A Backups token can take a full copy of the community, so keep manager-nodes.json readable by the fleet manager's user only (chmod 600 manager-nodes.json). When the fleet manager saves the file itself, it makes it that way.

### The fleet manager

The fleet manager signs in to a node with an automation token instead of the admin password. Make the token on your phone as above (an **Admin** token for everyday work, or **Read** or **Backups** for less), then in the fleet manager edit the node (⚙️) and paste it under **Automation token**. **Where do I get one?** under the field says the same.

- The fleet manager holds the token in that page only, as it does the password: a reload asks for it again, and it is never saved on the computer or in the browser.
- With a token, the fleet manager sends the token and nothing else: never the password, and no two-factor code. The password field stays for a node that runs a BeanPool older than tokens; it says it is not sent while a token is set.
- What a token cannot do, the fleet manager does not try. For an owner-only change (owners and admins, the public address, a take-over, the recovery code, where backups go, two-factor sign-in) it sends nothing and says "This needs an owner's phone: sign in with your phone (scan the code)", with **Sign in with your phone**. That opens the node's own Settings, where you scan the code with the app as an owner and make the change there.
- If a node refuses the token all the same (a Read token asked to change something, or a change that is owner-only only sometimes, such as making someone an owner or changing the backup schedule), the fleet manager says the same words. Reading who can take over, the owners' words checks, the backup schedule and the copy timing works with an Admin token.
- If a node no longer takes the token (it was revoked, has expired, or was copied wrong), the fleet manager shows what the node said and "Make a new token from your phone (Settings → Automation tokens)", with **Fix token** to paste the new one. It never asks for the password instead.
- A token, or a password, goes only to its own node: never to the server the fleet manager's page comes from.

## Factory reset

Only an owner can use **Wipe & Reset Node**: with the admin password, plus the two-factor code if that is on, or signed in from the app as an owner. It empties data/local-config.json: the admin password, two-factor sign-in, the community's name and contact details, the gateway settings, the money thresholds, break-glass mode and the backup settings. On a standby that includes the replication token it shows its primary, and on a primary the token's scrambled copy and the token-only switch, so live backup stops until you set up a new token on both ends. It does **not** delete members, posts, deals or beans, and it keeps the community's own key. It also deletes data/first-admin-password.txt if it is still there, since the password in it no longer works. After a restart the server has no admin password, whether it had one before or not: it starts as a new install does, ignores ADMIN_PASSWORD in .env, and makes up no password. Owners and admins still sign in with the BeanPool app. If the community has no owner left, the server makes a one-time claim code: run beanpool claim on the server to see it. To add an owner when nobody can sign in, run beanpool recover on the server.

To start a community again from nothing, stop the server and move the whole data folder away. Keep that copy until you are sure.
