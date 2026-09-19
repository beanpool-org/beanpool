---
slug: backups-and-replicas
title: Backups and replicas
summary: What to back up, the backups Settings makes (locked once you make a recovery code), restoring, and running a second server as a standby.
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

A backup from Settings is **locked** only when the server has a printed recovery code. Today the recovery code is the only way to open a locked backup; opening one with an owner's phone comes in a later update. So until you make a recovery code, the server keeps making the backups it always made: **not locked**, readable by anyone who has the file.

A server with no recovery code says so every time. The download carries the words "Backups are not locked yet: make a recovery code to lock them." and the server's log repeats them. The fleet manager shows that server as "Partial: database, no keys", with "Make a recovery code on the node to lock its backups." The Settings screen does not show the words yet: it still says "✅ Backup downloaded", which is true, because the file opens.

## Make a recovery code

Until the Settings card for it arrives, an owner makes the code with one command on the server's own machine:

curl -k -X POST -H "X-Admin-Password: PASSWORD" -H "Content-Type: application/json" -d '{}' https://localhost:8443/api/local/admin/takeover/recovery-code

- Put the server's admin password for PASSWORD. The admin password counts as an owner. With two-factor sign-in on, add -H "X-Admin-TOTP: 123456" with the code the authenticator shows.
- The answer holds "code": BPRC- followed by a number and groups of letters. That is the recovery code. It is shown **once** and kept nowhere on the server. Write it on paper, check it, and keep the paper away from the server.
- If the server already has a code, the answer says so and changes nothing. To replace it, send -d '{"replace":true}' instead. The old paper still opens backups made before, so keep it until those backups are gone.
- From then on every backup is locked, and takeover-envelope.json is locked to the code as well.

## Backups from Settings

**Appliance & Data**, then **Backups & Restore**.

![Backups and restore options in Settings](images/appliance-backups.webp)

**Download Sovereign Database**:

- **With a recovery code**: a **.bpsealed** file, a locked backup. It holds a clean copy of the database taken while the server runs, the settings, and the server's keys and sign-in settings (libp2p_key, community.key, genesis.json, connectors.json, the scrambled admin password, two-factor sign-in). One file brings back the whole community. It is locked to the recovery code and to the community's owners. Nobody else can open it, including an admin who downloads it or anyone who finds the file. Every download is locked, whoever asks.
- **Without a recovery code**: a **.tar.gz** file, not locked, exactly as before this update: a clean copy of the database and the settings. It does **not** hold the server's keys. The only copy of the keys is then the data folder itself, so copy that folder too (see What matters).

**Point-in-Time Snapshots**: on by default, one every **24 hours**, keeping the last **7**, in data/snapshots. You can take one now, download one or delete one.

- With a recovery code, a downloaded snapshot is a locked backup like the one above, holding the snapshot as its database and the server's keys and settings as they are now. The file's name starts with the snapshot's name and ends in .bpsealed.
- Without a recovery code, a downloaded snapshot is the snapshot's .db file itself, not locked, as before.
- The snapshots in data/snapshots are never locked: they sit next to the live database, so locking them would protect nothing. They are on the same disk as the server, so they do not survive a lost disk. Download one off the server now and then.

**Database Integrity Verification**: checks the live database or a snapshot for damage.

A locked backup is still private: whoever opens it can read everything in it, including how each member voted (see Privacy and what your server can see). It is locked to each owner of the day it was made: once opening with a phone arrives, an owner removed later can still open backups made while they were one.

If the recovery code is lost, no locked backup can be opened today. While the server is running that costs little: make a new code (with "replace"), then download a new backup. Keep the paper somewhere away from the server.

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

- **A locked backup (.bpsealed)** needs the recovery code. The Restore Database Wizard in Settings does not ask for it yet. Until it does, on the server's own machine, in the folder that holds the file, run: curl -k -X POST --data-binary @FILE -H "X-Admin-Password: PASSWORD" -H "X-Recovery-Code: CODE" https://localhost:8443/api/local/admin/restore, putting the file's name for FILE, this server's admin password for PASSWORD and the recovery code for CODE. With two-factor sign-in on, add -H "X-Admin-TOTP: 123456" with the code the authenticator shows. Sent without a recovery code, it answers with who the file is locked to and which code number it needs.
- It brings back everything in the file: the database, the server's keys, the community's genesis, its links with other communities, and its admin password and two-factor sign-in. After the restart, sign in with **the community's** admin password, not the one this server had. The server keeps its own replication token and other settings.
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
- **A standby is not a complete copy.** It does not copy Decisions and their votes, who holds which role, enterprise pledges and keeper changes, invites, or members' notification settings. Keep file backups as well.
- Making a standby the main server uses scripts in the BeanPool source code, not in the server image, and the first start after needs PROMOTED_FROM_BACKUP=true.
