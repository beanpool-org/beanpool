---
slug: backups-and-replicas
title: Backups and replicas
summary: What to back up, the backups Settings makes (locked once you make a recovery code), owners' 12 words and phones, restoring, running a second server as a standby, taking over on it with the recovery code or an owner's phone, and what happens if the old server comes back.
related: updates-and-health, troubleshooting, what-the-server-sees, first-time-setup
---

## What matters

Everything lives in the **data** folder next to docker-compose.yml:

- **state.db** (with state.db-wal and state.db-shm beside it while the server runs): members, posts, deals, beans, votes, messages;
- **libp2p_key**: the server's own identity. It signs what your server sends to standbys, to other communities and to the service that gives it its web address. Lose it and the server comes back as a stranger: its address has to be claimed again with help, every link with another community made again by hand on both sides, and every standby set up again. Members, beans and posts are in state.db and survive;
- **connectors.json**: your links with other communities;
- **genesis.json** and **community.key**: the community's founding record and a key kept for later. community.key signs nothing today. Keep both anyway;
- **local-config.json**: the admin password, two-factor sign-in, the replication token (a standby's token, or a primary's scrambled copy of it) and other settings;
- **takeover-envelope.json**: the server's keys and sign-in settings, locked so that only the community's owners can open them (any one of them alone), or a printed recovery code once one is made. The server makes it and keeps it up to date whenever an owner is added or removed, or those settings change. With no owner and no recovery code there is nobody to lock it to, so the file isn't there. It is a locked copy for taking over on another server later; the server still runs from the files above;
- **snapshots**, **logs** and **cache**: the automatic snapshots, old logs, and pictures fetched for the Pulse, which can be fetched again.

The simplest complete backup: stop the server, copy the whole data folder somewhere else, start it again. Do it before every update. That copy is not locked: it is everything, in the clear, so keep it somewhere only owners can reach. Until the server has a recovery code it is also the only backup that holds the server's keys.

## Locked or not: the recovery code decides

A backup from Settings is **locked** only when the server has a printed recovery code. A locked backup opens with that code, or with any one owner's phone (see Restoring). Until you make a recovery code, the server keeps making the backups it always made: **not locked**, readable by anyone who has the file.

A server with no recovery code says so every time. The download carries the words "Backups are not locked yet: make a recovery code to lock them." and the server's log repeats them. The fleet manager shows that server as "Partial: database, no keys", with "Make a recovery code on the node to lock its backups." In Settings, the **Who can unlock this community** card shows the same words (see below). The download button itself still says "✅ Backup downloaded", which is true, because the file opens.

## Who can unlock this community

**Appliance & Data**, then **Backups & Restore**. The first card shows:

![The Who can unlock this community card in Settings](images/appliance-backups.webp)

- **Locked** (green), and who can open the server's take-over keys: each owner by name, and the recovery code by its number. Any one of them alone is enough. Under it, when the keys were last locked again and why (an owner added or removed, a new code, a changed setting).
- **Not locked yet** (amber), and why: no owner and no recovery code, or the server has not made its keys yet. Make someone an owner, or make a recovery code.
- **Error** (red), with the reason. The locked copy from before the change is kept but not handed out.
- A standby says it holds no take-over keys of its own. Make the recovery code on the main server.
- If an owner is left out of the lock, a line names them and says why.
- Whether backups are locked, and if not, why.
- The recovery code's number and the day it was made, or "No printed recovery code".
- Under it, **Owners' 12 words** lists each owner, and whether their phone opened the current lock (see Owners' 12 words and phones).

Admins see all of this. Only an owner, or someone signed in with the admin password (which counts as an owner), sees the buttons below.

## Make a recovery code

In the **Who can unlock this community** card, press **Make a recovery code**.

- The code appears once, in large letters: BPRC- and a number, then groups of letters and digits. It is kept nowhere on the server, and Settings does not keep it either. Close the card and it is gone.
- Press **Print** for a plain page with the code, the community's name, the date, and what the code is for, then **Print this page**. Or copy it onto paper by hand.
- Tick **I've printed it or written it down**, then press **Done**. Tapping beside the card, Escape and the phone's Back button do not close it, so a stray tap cannot lose the code. The ✕ does close it: if you had not written it down by then, make a new code.
- Keep the paper away from the server. Anyone holding it can open your locked backups.
- From then on every backup is locked, and takeover-envelope.json is locked to the code as well.

**Check a code** proves a paper is right: type the code from it and press **Check**. The answer is yes or no. A mistyped letter is caught at once. A wrong code counts like a wrong password (see Rate limits). Capitals or small letters both work, and the dashes are optional.

**Replace it** makes a new code in place of the old one. Settings warns first: from then on the take-over keys and new backups are locked to the owners and the new code, and the old code stops opening them. **Backups made before stay locked to the old code as well as the owners**, so keep the old paper until those backups are destroyed. Then the new code is shown once, as above.

On a standby the buttons are not shown, and the server refuses to make a code there: a standby locks nothing of its own, so the code would open nothing.

Instead of Settings, an owner can make the code with one command on the server's own machine:

curl -k -X POST -H "X-Admin-Password: PASSWORD" -H "Content-Type: application/json" -d '{}' https://localhost:8443/api/local/admin/takeover/recovery-code

- Put the server's admin password for PASSWORD. The admin password counts as an owner. With two-factor sign-in on, add -H "X-Admin-TOTP: 123456" with the code the authenticator shows.
- The answer holds "code": that is the recovery code, shown **once**.
- If the server already has a code, the answer says so and changes nothing. To replace it, send -d '{"replace":true}' instead.

## Backups from Settings

**Appliance & Data**, then **Backups & Restore**.

**Download Sovereign Database**:

- **With a recovery code**: a **.bpsealed** file, a locked backup. It holds a clean copy of the database taken while the server runs, the settings, and the server's keys and sign-in settings (libp2p_key, community.key, genesis.json, connectors.json, the scrambled admin password, two-factor sign-in). One file brings back the whole community. It is locked to the recovery code and to the community's owners. Nobody else can open it, including an admin who downloads it or anyone who finds the file. Every download is locked, whoever asks.
- **Without a recovery code**: a **.tar.gz** file, not locked, exactly as before this update: a clean copy of the database and the settings. It does **not** hold the server's keys. The only copy of the keys is then the data folder itself, so copy that folder too (see What matters).

**Point-in-Time Snapshots**: on by default, one every **24 hours**, keeping the last **7**, in data/snapshots. You can take one now, download one or delete one.

- With a recovery code, a downloaded snapshot is a locked backup like the one above, holding the snapshot as its database and the server's keys and settings as they are now. The file's name starts with the snapshot's name and ends in .bpsealed.
- Without a recovery code, a downloaded snapshot is the snapshot's .db file itself, not locked, as before.
- The snapshots in data/snapshots are never locked: they sit next to the live database, so locking them would protect nothing. They are on the same disk as the server, so they do not survive a lost disk. Download one off the server now and then.

**Database Integrity Verification**: checks the live database or a snapshot for damage.

A locked backup is still private: whoever opens it can read everything in it, including how each member voted (see Privacy and what your server can see). It is locked to each owner of the day it was made, so **any one owner can open it with their phone**, and an owner removed later can still open backups made while they were one.

If the recovery code is lost, a locked backup still opens with the phone of any owner it was locked to. While the server is running a lost code costs little: press **Replace it** in the Who can unlock this community card, then download a new backup. Keep the paper somewhere away from the server.

## Owners' 12 words and phones

A locked backup and the locked take-over keys are locked to each owner's key: **any one owner can open them with their phone**, and so can the recovery code. An owner who loses their phone gets that key back from their 12 words. So each owner's 12 words matter most on the day the server itself is lost.

- **Backups & Restore** in Settings lists each owner with **12 words checked:** and a date, or **not yet**, and a line such as "1 of 3 owners have checked their 12 words in the last year".
- An owner checks their words in the BeanPool app (phone or web), under **Settings**, **Community keys**. The app asks them once when they become an owner and again a year after their last check. They can always say Later.
- The words are checked on the owner's own device and never reach the server. The server keeps only the owner's signed statement that they checked, and when. It cannot check the words itself, so the date is what the owner reported, nothing more.
- Nothing waits on it: an owner who never checks can still do everything an owner does.
- Removing an owner takes them off the list. Their date stays with their account, and shows again if they are made an owner again.

Each owner's line also says whether **their phone opened the current lock**. Whenever the lock changes (an owner added or removed, a new recovery code, a changed setting), each owner's app checks by itself, with nobody asked anything: it opens its own part of the lock, throws the key away at once, and tells the server whether it worked. The line reads:

- **their phone opened the current lock** and a date (green): that owner could open the keys and the backups today;
- **their phone last opened an older lock**, before the last change: the app has not been opened since the lock changed. It checks next time;
- **their phone could NOT open** the lock: something is wrong with that owner's key on that phone (for example an account brought back from the wrong words). Ask them to check their 12 words. Until it is fixed, don't count on their phone;
- **their phone has not reported on the lock yet**: that owner's app is older, or has not been opened since they became an owner.

Like the words, this is what the owner's phone reported; the server cannot check it. It gates nothing.

## Backups that are not locked

Backups downloaded before this update, and every backup from a server with no recovery code, are **.tar.gz** files (or, for a snapshot, a .db file) and are not locked. They hold the settings, including the scrambled admin password and the two-factor secret. Make a recovery code first. Then find the unlocked ones and delete them: Downloads, other computers, Time Machine, cloud drives, email. Deleting a file does not always wipe it from an SSD. Treat anything that was in one as possibly seen by someone else: change the admin password and set up two-factor sign-in again when you can.

### The fleet manager's copies

The fleet manager keeps what each server sends:

- A server with no recovery code sends a backup that is not locked. The fleet manager keeps it as before: the latest database, and one copy a day for 30 days, and shows the server as "Partial: database, no keys". The same goes for a server that runs a BeanPool older than locked backups.
- A server with a recovery code sends a locked backup. The fleet manager keeps it as it came: the newest, and one a day for 30 days. It cannot open these files and does not need to.
- When a collection fails, it waits 5 minutes before asking that server again, then 10, doubling up to 6 hours. A collection started by hand from the dashboard still asks at once.

Once a server's backups are locked, the fleet manager also locks the unlocked copies it holds for that server, and deletes each unlocked copy only after reading its locked copy back and opening it. It does this only when all three hold:

- the latest backup from that server was locked;
- that backup has a recovery code in it;
- it is signed by the server's key as the fleet manager already knows it: either the key file it collected from that server before this update, or a "peerId" you add to that server's entry in manager-nodes.json in the fleet manager's data folder (the PeerId shown at the top of the server's Settings).

Otherwise it deletes nothing, and writes which of the three is missing into harvester-state.json in its data folder (the dashboard does not show that yet). The old key files end up in one locked file named beanpool-identity-(date)-legacy.bpsealed. It only knows about its own folder.

## Restoring

A backup is restored onto a server with that server's admin password. It replaces the database and restarts the server.

- **A locked backup (.bpsealed)** opens with the recovery code or with any one owner's phone. In the **Restore Database Wizard** (Appliance & Data, Backups & Restore), choose the file and press **Restore from Backup**. The wizard says the file is locked, when it was made and who can open it, and offers both ways.
- **Open with an owner's phone**: the file waits on the server and a code appears. An owner scans it in the BeanPool app (**Settings**, **Community keys**, **Take over or restore with this phone**), or copies the link under it into the web app. Their phone shows what it is about to open and asks for its own unlock; then the server opens the file and restores it. The phone never sees what is in the file. The code works once, for 10 minutes.
- **Or type the printed recovery code**, then press **Open with the code and restore**.
- Without Settings, on the server's own machine, in the folder that holds the file: curl -k -X POST --data-binary @FILE -H "X-Admin-Password: PASSWORD" -H "X-Recovery-Code: CODE" https://localhost:8443/api/local/admin/restore, putting the file's name for FILE, this server's admin password for PASSWORD and the recovery code for CODE. With two-factor sign-in on, add -H "X-Admin-TOTP: 123456" with the code the authenticator shows. Sent without a recovery code, it answers with who the file is locked to and which code number it needs.
- This works on a **fresh server** too: install BeanPool, sign in to its Settings with its own admin password, and restore. The whole community comes back onto it.
- It brings back everything in the file: the database, the server's keys, the community's genesis, its links with other communities, and its admin password and two-factor sign-in. After the restart, sign in with **the community's** admin password, not the one this server had. The server keeps its own replication token and other settings. (Opened with a phone, the wizard follows the restore to the end by itself, and says when the server is restarting.)
- If the file was locked by a different machine than this community's server, the server refuses it and names that machine. The fleet manager locks old copies with its own key, so its files are named this way. If you know the machine, send the same command again with -H "X-Accept-Signer: NAME", putting the name it gave. A file let through this way brings back its **database only**: the server never takes keys or an admin password from it. Anyone who has seen one of your backup files can make a file like it, locked to your recovery code, so don't let through a machine you don't know.
- **A backup that is not locked (.tar.gz)** restores with the Restore Database Wizard, as before. It brings back the database only; copy genesis.json, community.key and the other key files back by hand if they were lost.
- Stop and think before restoring over a live community: everything since the backup is lost.

## A standby server

A second server can follow yours as a read-only standby, copying changes about every minute.

- On your server, **Replication Access** (under Backups & Restore) makes a replication token. It is shown once. There is one token per server: making a new one stops every standby using the old one until you paste the new one in.
- On the standby, set NODE_ROLE=backup and BACKUP_PRIMARY_URL, and give it the token under **Live Backup Server** (or as BACKUP_REPLICATION_TOKEN in its .env). A standby only takes a token. It never takes your admin password, so its disk and its backups never hold it.
- The token copies the whole database, and can download a backup and the locked take-over keys. It never gets your server's keys unlocked: a backup that is not locked holds no keys, and nothing on the server hands them out in the clear any more. The copy of the database on the standby is not locked, though: that is what a standby is. Guard the standby's disk like a backup.
- **Token-only** refuses the admin password for copying. A new server starts with it on. A server set up before this change has it off, so an older standby keeps working; Replication Access says so, and tells you when a standby last copied with the admin password. Tick **Require token** once every standby has the token.
- An older standby that still holds your admin password swaps it for a token by itself when it starts, if your server has no token yet: it uses the password once, keeps the token and deletes the password. If it cannot, it keeps the password, warns in its log at every start, and shows a red notice under **Live Backup Server** saying why and whether it is still copying.
- That standby is **not copying** if your server has two-factor sign-in on, has token-only on, or no longer takes that password. It still copies with the password only if your server already has a token and token-only is off.
- To fix it either way: if you saved your server's token, paste it under **Live Backup Server** on the standby and save. If not, make a new one under **Replication Access** and paste it into every standby. The standby then deletes the password. If the password came from BACKUP_ADMIN_PASSWORD in the standby's .env, delete that line too.
- Copying goes one way only. Your main server never takes data from the standby.
- **The standby keeps the locked take-over keys.** Each time it copies, it also asks your server for takeover-envelope.json, with the token only. If nothing changed, your server answers "no change" and nothing is sent. The standby keeps the last 5 in the folder data/held-takeover-envelopes on its own disk. A sixth deletes only the oldest, so a bad copy from your server can't wipe out a good one.
- The standby **can't open them**. It has no owner's key and no recovery code. Only an owner's phone or the recovery code opens them, as with a locked backup, and only when you take over. It keeps the files exactly as they came, and nothing from inside them is ever on the standby's disk.
- The standby only keeps a copy signed by the server it copies from (the one it was set up to trust). It refuses any other copy, keeps what it had, and writes a line to its log starting "Refused a take-over envelope".
- On the standby, **Live Backup Server** says what it holds: when the newest copy was locked and who can open it. If the owners or the recovery code changed since the copy before, it says who was added or removed.
- On your server, **Replication Access** says which standby holds which copy. When an owner is added or removed, a standby shows as holding keys "from before the latest change" until it next copies, about a minute later.
- A main server running a BeanPool from before this has nothing to send. The standby says "the main server is too old to send a take-over envelope" and keeps copying the database as before. A server with no owner and no recovery code has nothing to send either, and the standby says that instead.
- **A standby is not a complete copy.** It does not copy Decisions and their votes, who holds which role, enterprise pledges and keeper changes, invites, or members' notification settings. Keep file backups as well. (The roles come back when it takes over: they are in the locked keys.)
- If your main server is gone for good, the standby can take over as the main server. See the next part.

## Taking over on the standby

If the main server is gone for good (a dead disk, a lost machine), the standby can become the community's main server with the printed recovery code or **any one owner's phone**. The community stays itself: the same identity, the same owners and admins, the same links with other communities, the same admin password and two-factor sign-in, and the same web address. Members change nothing.

Do this only when the main server is really gone. Two servers with one identity compete with each other, so **never start the old main server again** afterwards (if it starts anyway, see If the old main server comes back).

You need:

- the standby's own Settings (its own admin password);
- **either** the paper with the recovery code (the code on it must be one the standby's copy of the keys was locked to: the screen says which number it needs), **or** an owner with the BeanPool app on their phone, who can scan a code on your screen. Any owner the keys were locked to will do; the app must be the newest version. The web app works too, by pasting a link, if it still opens: it lives at the community's own address, which may be down with the main server.
- If the standby's Settings only answer certain internet addresses (the admin IP allowlist under **Gateway & Peers**), the owner's phone must be on one of them too.

When one person runs the standby and is also an owner, they do it alone. When a friend hosts the standby, it takes both of you: their Settings and your phone.

On the standby: **Appliance & Data**, then **Backups & Restore**, then **Take over as the main server** at the bottom.

- **Step 1.** The first screen says what will happen and **what will be missing**: Decisions and their votes, enterprise pledges and keeper changes, invites, members' notification settings, settings the main server kept in its own database other than its web address (such as what it lists in the directory), and anything that changed after the standby last copied. Press **I understand: use an owner's phone**, or **I understand, continue** for the recovery code.
- **Step 2, with a phone.** A code appears, with the owners who can open the keys. The owner opens the BeanPool app, **Settings**, **Community keys**, **Take over or restore with this phone**, and scans it (or opens the link under it on their phone, or pastes it into the web app). Their phone shows the community, this server, and warns in red if the main server still answers; then it asks for its own unlock. The phone opens its own part of the keys and hands it to the standby, locked so only the standby can read it: **the phone never sees the keys**. Your screen moves on by itself. The code works once, for 10 minutes: **Make a new code** if it runs out. The standby offers the newest copy of the keys it holds that an owner can open.
- **Step 2, with the recovery code.** Type the code and press **Open the keys**. A mistyped letter is caught at once. A wrong code counts like a wrong password, and after a few the standby makes you wait before the next try, whatever admin password you signed in with.
- **Step 3.** The next screen shows what the keys hold: when they were locked and who opened them (the code's number, or the owner's phone), the identity the server will keep, the owners, how many admins, how many links with other communities, the web address, whether the tunnel for it comes back, whether the main server still answers, and when the standby last copied from it. If the main server still answers, it says so in amber: stop and check. Tick **The main server is gone, and nobody will start it again**, then press **Take over now**.
- **Step 4.** The standby works through its steps, restarts itself, and carries on after the restart. The screen follows each step and says "restarting" while the server is starting again. At the end it says **This server is now the community's main server**, whether the ledger adds up, and what to do next.

What the standby does, in order. Each step is written to data/takeover-journal.json before the next starts. If the power goes or the server stops part-way, it carries on from the first step not done the next time it starts; nothing is done twice.

- keeps a copy of its own keys and settings in a folder named pre-takeover- and the date, in its data folder;
- writes the main server's node key (libp2p_key), so it keeps the main server's identity, and its genesis, community key and links with other communities. Its own link to the old main server goes;
- installs the community's admin password and two-factor sign-in, and the record of the recovery code;
- brings back the owners and admins (their member accounts must be in the standby's copy of the database; any that are not are named on the result screen);
- brings back the web address, with its tunnel token;
- becomes the main server in its own settings (local-config.json), so NODE_ROLE=backup left in its .env does not matter and a later update cannot turn it back into a standby;
- stops copying from the old main server, and restarts;
- checks once that the ledger adds up, before members trade on it;
- posts a notice, "This community moved to a new server", with the date and who opened the keys: the recovery code and its number, or the owner by name. Only people connected at that moment see it live; there are no push notifications, because a standby has no copy of phones' notification tokens;
- locks the keys again, on this server, to the owners and the same recovery code, and deletes the copies it held from the old main server;
- starts the tunnel for the web address.

Afterwards:

- Sign in to Settings with **the community's** admin password, or an owner's key. The standby's own admin password no longer works.
- **If you used the recovery code, make a new one.** The one you typed is spent: until you replace it, Who can unlock this community says "Your recovery code was used. Make a new one". Anyone holding that paper can open the community's keys. An owner's phone spends nothing: their key is still theirs, and the new main server locks to them again.
- If the result says the tunnel did not come back, the keys had no tunnel token. With PUBLIC_ADDRESS_NAME set, the server asks for the address again within a few minutes: it has the same identity, so the name is still its own. Otherwise claim the address again under Public Address. With the recovery code, the standby looks in the older copies it held for a token before giving up; a phone opens only the newest copy.
- Other standbys trust the new main server already, because it has the same identity. Make a replication token on it and paste it into each of them.
- Keep making file backups.

If something went wrong, the standby's own files from before are in the pre-takeover- folder. The step that failed is named on the screen and in data/takeover-journal.json.

The standby refuses to take over if the keys it holds are for another community, or are not signed by the main server it copies from. It then writes nothing. With a phone it also refuses a phone whose owner the keys are not locked to, an expired or already used code, and, after 5 bad tries, closes the code. The owner's phone refuses too, and says why, if the keys belong to another community than its own, or (once the app has seen its own server's lock) were not locked by its own server.

## If the old main server comes back

A take-over keeps the community's identity, so the old main server, started again, would be a second server claiming to be the same community. Don't start it again. If it starts anyway (a machine that was only switched off, a host that brings it back), it checks for itself:

- Each take-over raises a number, the identity epoch, and the new main server shows it at a public address, signed with the community's key. A server that never took over is at 0; the first take-over makes it 1.
- A main server asks its own web address for that number when it starts and every hour after.
- If the address answers with a **higher** number, signed with its own key, another server has taken over from it and the web address now leads there. It goes **read-only**: members' posts, trades, messages and every other change are refused with "This server was replaced on (date). It is now read-only." It still starts, and its Settings still work: **Take over as the main server** shows the same words in red, and its log says so at every start. It stays read-only after a restart.
- If its web address doesn't answer (the tunnel is gone, no internet, no web address at all), it carries on as the main server. So does a server whose address answers from a BeanPool older than this.
- An answer not signed with its own key is ignored, and its log gets a line saying so. Nobody can push your main server aside without the community's key.

This check is a safety net, not a lock. An old server with no way to reach its own web address won't know, and until it next asks, it takes writes. So still: after a take-over, don't start the old main server again. Wipe its data folder, or keep it switched off.

Read-only means members can't change anything there, but Settings can. Anything done in its Settings stays on that machine; it never reaches the new main server.

To use the old machine again, set it up from scratch as a standby of the new main server: it needs a new identity of its own. Before this update the way back was a script, scripts/restore-primary.mjs; it is gone, and the take-over above does its job without changing the community's identity.
