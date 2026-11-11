---
slug: access-and-security
title: Access and security
summary: How owners sign in, break-glass codes, automation tokens for scripts and the fleet manager, the changes that ask a fresh proof, signing out everywhere, and starting over. Under Appliance & Data, then Access & Security.
related: signing-in, roles, first-time-setup, rate-limits, ai-assistant
---

## How you sign in

A server has no admin password and no two-factor sign-in. Nobody signs in to Settings by typing a secret. An owner, an admin or a moderator signs in with the BeanPool app on their phone, with their own key: the app's **Manage** button, or **Sign in with your phone** on a computer, where you scan a code with the app. See Signing in. Every change in Settings is then done by a named person, and the log says who.

![The Access and Security screen in Settings](images/appliance-access.webp)

A script, or a tool like the fleet manager, uses an **automation token** instead (below). A standby copies with the **replication token** (Backups and replicas). Neither is a sign-in, and neither makes an owner-only change.

Access & Security holds three cards: **Break-Glass Emergency Recovery** (below), **Automation tokens** and **Connected assistants**.

### Left over from the old password

An older server may still have the old password's leftovers. The server reads none of them, so none of them opens anything:

- ADMIN_PASSWORD, BACKUP_ADMIN_PASSWORD and ADMIN_BREAK_GLASS_MODE in .env. Take them out, then run docker compose up -d.
- Old keys in data/local-config.json (the password's scrambled copy, the two-factor secret and backup codes, break-glass mode, the token-only switch). They do nothing, so you can leave them. The password's scrambled copy and the two-factor secret and codes stay out of every backup file.
- data/first-admin-password.txt, if an older version made it. Delete it: it is a password nothing checks any more.

## Break-glass codes

A break-glass code belongs to one owner. It starts with **bg-** and does one thing: it lets you add a new admin key, for example when you have lost the phone your key was on. Anywhere else it is refused: it signs nobody in. An owner makes one under Access & Security, **Make a break-glass code**, signed in with their own key from the phone's Manage, within 90 seconds of the phone's unlock. The code is for your own key: nobody makes one for someone else. Settings shows it once; making a new one stops the old one working. Admins and moderators have none. In the app, an owner finds **Break-glass code** under Community admin in Settings: it asks for the phone's unlock and shows a new code once. The app keeps no copy, since the code is for when that phone is lost: write it down.

- The server's log records that a code was made and for whom, never the code itself.
- Using it shows every member a notice: "Break-glass recovery used to authorise a new admin key for @callsign". The server's log records whose code it was.
- The server keeps only a scrambled copy of it, made slow to guess, so a copy of the server's data does not give it away.
- The code alone is enough. It asks for nothing more, so whoever holds it can add a key.
- A wrong code counts against the address it came from: after a few, that address has to wait before its next try (see Rate limits). Another network is not slowed down.
- When an owner signs out everywhere (see Signing out everywhere, below), their code stops working too, so a code someone made from a stolen session does not outlast it. Make a new one afterwards. Signing someone else out leaves their code alone.
- Adding the key of someone who is already an owner again keeps their code. A new owner added in Settings, or one who claimed the community from their phone, has no code until they make one (**Make a break-glass code**, or **Break-glass code** in the app). beanpool recover and beanpool claim --key print one.
- There is no screen to type the code into yet. It is sent to your server's /api/local/admin/auth/enrol, in the X-Break-Glass-Code header, with the new key, which must already be a member.
- In **Owners & admins**, each owner's row says when their code was last made, and from where: a key session in Settings, their phone, a break-glass sign-in, or beanpool recover on the server. If it was made at a time you don't recognise, make a new one.

Keep it offline, like a spare key. Anyone who has it can add an admin key of their own, and the notice is then the community's only warning.

## Signing out everywhere

Lost a phone, or signed in to Settings on a computer that isn't yours? **Sign out everywhere** ends every Settings sign-in of yours at once, on every computer and phone.

- In Settings, signed in with your key: **People & Safety**, then **Owners & admins**, at the bottom. It asks first, then shows the sign-in screen, since this computer is signed out too.
- In the app: **Settings**, under Community admin (Community moderation for a moderator), **Sign out everywhere**. Owners, admins and moderators all have it. It asks first, then says what happened.
- An owner's break-glass code stops working too. Make a new one afterwards.
- Your key stays on your phone: press **Manage** in the app to sign in again.
- It ends only your own sign-ins, and the server refuses an automation token here.
- Automation tokens are not sign-ins: tokens made earlier keep working afterwards. If someone else may have signed in as you, an owner should open **Automation tokens** (below) and revoke any token nobody recognises. Only owners see that card.

## Automation tokens

An automation token lets a script, or a tool like a fleet manager, use this node's Settings without anyone signing in. An owner makes one under Access & Security, **Automation tokens**: give it a name that says what will use it, pick what it may do, and, if you like, when it stops working. Admins and moderators do not see this card.

You make a token with your owner key: open Settings from **Manage** in the app, or sign in on a computer by scanning a code with the app. That way every token belongs to an owner.

What a token may do is its scope:

- **Read**: look, change nothing. Dashboards and checks.
- **Backups**: take a backup or snapshot, list them, send one off the box and download one. Nothing else: not restoring, not deleting, not changing where backups go.
- **Admin**: what an admin can do in Settings.

No token, whatever its scope, makes an owner-only change. It cannot change who is an owner or admin, break-glass codes, the public address, the replication token, or other tokens, and it cannot restore a backup or sign anyone in to Settings. Do those signed in as an owner. The server answers "An automation token never makes owner-only changes: sign in to Settings as an owner".

- Settings shows the token once, when you make it. Copy it then: the server keeps only a scrambled copy and cannot show it again. If you lose it, revoke it and make a new one.
- The script sends it in the Authorization header, as Bearer followed by the token (it starts with bp_). Keep it as you would a password.
- What a script does with a token counts as done by the owner who made it, and the server's log records each use with the token's id, never the token itself. The list shows when and where each token was last used.
- Any owner can revoke any token, and it stops working at once. A token also stops working when the owner who made it is no longer an owner: removed, made an admin, or suspended.
- Tokens stay on this server: they are not in backups, standby copies or a take-over.

### Scripts and the harvester

The scripts that come with BeanPool take a token in the environment variable **BEANPOOL_TOKEN**, never on the command line: anyone else on that computer can see a command line. Older versions of these scripts also read the admin password (the environment variable ADMIN_PASSWORD, or --admin-pw). The server takes no password, so that never signs in: use a token. What each needs:

- **scripts/grant-operator.mjs** (let a member run an enterprise) and **scripts/bootstrap-community-eggs.mjs**: an **Admin** token.
- **scripts/setup-backup.mjs** (set up a standby): a **Read** token, to fetch the community's identity. No token can make the replication token, because that is an owner's change: an owner makes it under **Replication Access**, signed in from the app, and you give it to the script in the environment variable **BACKUP_REPLICATION_TOKEN**: that token reads the whole ledger, so it stays off the command line too. (--token still works, with a warning that anyone on the computer can see it.) Without one the script stops and says so before it changes anything. The script does not pair the standby: once the standby runs, pair it from its shell with a pairing code from **Replication Access** (docker compose exec beanpool-node beanpool pair), as the script's last lines say.
- **scripts/federation/fed.mjs**: an **Admin** token for each server, in BEANPOOL_TOKEN_ followed by the server's name in capitals (for example BEANPOOL_TOKEN_GIPPSLAND).
- **The harvester** (the fleet's backup puller): a **Backups** token, as "automationToken" in that server's entry in manager-nodes.json. It takes the server's backups with the token alone. A server with no token there is not harvested: the harvest says "No automationToken configured". It asks for the server's member and post counts with no sign-in at all, because anyone may see those. A Backups token can take a full copy of the community, so keep manager-nodes.json readable by the fleet manager's user only (chmod 600 manager-nodes.json). When the fleet manager saves the file itself, it makes it that way.

### The fleet manager

The fleet manager signs in to a node with an automation token. Make the token on your phone as above (an **Admin** token for everyday work, or **Read** or **Backups** for less), then in the fleet manager edit the node (⚙️) and paste it under **Automation token**. **Where do I get one?** under the field says the same.

- The fleet manager holds the token in that page only: a reload asks for it again, and it is never saved on the computer or in the browser.
- What a token cannot do, the fleet manager does not try. For an owner-only change (owners and admins, the public address, a take-over, the recovery code, where backups go) it sends nothing and says "This needs an owner's phone: sign in with your phone (scan the code)", with **Sign in with your phone**. That opens the node's own Settings, where you scan the code with the app as an owner and make the change there.
- If a node refuses the token all the same (a Read token asked to change something, or a change that is owner-only only sometimes, such as making someone an owner or changing the backup schedule), the fleet manager says the same words. Reading who can take over, the owners' words checks, the backup schedule and the copy timing works with an Admin token.
- If a node no longer takes the token (it was revoked, has expired, or was copied wrong), the fleet manager shows what the node said and "Make a new token from your phone (Settings → Automation tokens)", with **Fix token** to paste the new one.
- A token goes only to its own node: never to the server the fleet manager's page comes from.

## Connected assistants

An owner or an admin can connect their own AI assistant (Claude, ChatGPT, Cursor) to the server under **Connected assistants**, see exactly what it would read before and after, and disconnect it. From Claude or ChatGPT they add the server's address as a connector and approve on their phone; an owner can also make a token for a desktop agent. That token is not an automation token and is not listed under Automation tokens. Owners see every connected assistant and can turn AI assistants off. See AI assistants for what an assistant can and can't see.

## Changes that ask a fresh proof

A few changes are rare, and are the kind a stolen sign-in would make in its first minute. For these, being signed in is not enough: the owner proves it is them again, each time. The fresh-proof list:

- make, remove or demote an owner or admin, enrol an owner's or admin's key, or re-key one;
- remove or suspend an owner;
- suspend someone while five of your own suspensions are still being voted on;
- replace the recovery code;
- make a break-glass code;
- make an automation token;
- change the gateway settings;
- take this community offline, release a name, replace this community's live address, or remove an address members' apps use;
- change the address and token a standby copies with (Live Backup Server; which server it trusts is set only on its own shell: beanpool pair);
- remove, change or shorten where backups go off the box, or keep fewer snapshots, or make them cover less time;
- roll back to a restore point.

The proof is always the phone, and what it means depends on how you signed in:

- **From your phone (Manage)**: the change goes through within 90 seconds of your phone's unlock. Later, Settings says "Press Manage on your phone again, then make this change within 90 seconds."
- **On a computer signed in with your phone (the code you scanned)**: these changes are not made there, because a computer has no unlock of its own. Settings says "Do this from your phone: open BeanPool, press Manage, then make this change there."
- An automation token never makes them. A break-glass code never makes them either: the server says "A break-glass code enrols a key and nothing else: sign in with that key to make this change."

## Starting over

There is no button and no command that wipes a server: a stolen sign-in could use either. Both ways to start over are done on the server's own machine, in the folder with docker-compose.yml.

- **The settings only, keeping members, posts, deals and Beans**: docker compose stop beanpool-node, then move data/local-config.json out of the data folder (for example to your home folder), then docker compose up -d. That file holds the community's name and contact details, the gateway settings, the money thresholds, the recovery code's record, the automation tokens and the backup settings. On a standby that includes the replication token it shows its main server, and on a main server the replication token's scrambled copy, so live backup stops until you set up a new token on both ends. It keeps the community's own key. Owners and admins still sign in with the BeanPool app. If the community has no owner left, a main server makes a one-time claim code: run docker compose exec beanpool-node beanpool claim to see it. A standby makes none, and refuses a claim: make yourself its owner with docker compose exec beanpool-node beanpool recover --key @callsign (your callsign, or your public key), as in Backups and replicas. To add an owner when nobody can sign in, run beanpool recover on the server (Signing in).
- **The whole community, from nothing**: docker compose down, then move the whole data folder away, then docker compose up -d, then claim the server as in First-time setup (docker compose exec beanpool-node beanpool claim). Keep the old data folder until you are sure.
