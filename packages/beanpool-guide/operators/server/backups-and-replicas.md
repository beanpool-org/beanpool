---
slug: backups-and-replicas
title: Backups and replicas
summary: What to back up, the locked backups Settings makes for you, restoring, and running a second server as a standby.
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

The simplest complete backup: stop the server, copy the whole data folder somewhere else, start it again. Do it before every update. That copy is not locked: it is everything, in the clear, so keep it somewhere only owners can reach.

## Backups from Settings

**Appliance & Data**, then **Backups & Restore**:

- **Download Sovereign Database**: a **.bpsealed** file, a locked backup. It holds a clean copy of the database taken while the server runs, the settings, and the server's keys and sign-in settings (libp2p_key, community.key, genesis.json, connectors.json, the scrambled admin password, two-factor sign-in). One file brings back the whole community.
- It is locked to the community's owners and the printed recovery code, the same as takeover-envelope.json. Any one owner can open it, or the recovery code. Nobody else can, including an admin who downloads it or anyone who finds the file. Every download is locked, whoever asks: the server never hands out a backup that isn't.
- With no owner and no recovery code there is nobody to lock it to, so the download stops and says so. Make a recovery code, or make someone an owner, and download again.
- **Point-in-Time Snapshots**: on by default, one every **24 hours**, keeping the last **7**, in data/snapshots. You can take one now, download one or delete one. A downloaded snapshot is locked the same way, with the server's keys and settings as they are now; the file keeps the snapshot's name ending in .db, but it is a locked backup. The snapshots in data/snapshots are not locked: they sit next to the live database, so locking them would protect nothing. They are on the same disk as the server, so they do not survive a lost disk. Download one off the server now and then.
- **Database Integrity Verification**: checks the live database or a snapshot for damage.

A locked backup is still private: whoever opens it can read everything in it, including how each member voted (see Privacy and what your server can see). Removing an owner does not lock them out of backups made while they were one. A new recovery code does not lock the old one out of backups made before: keep the old paper until those backups are gone.

If every owner loses their phone and their 12 words, and the recovery code is lost too, no locked backup can be opened again. While the server is running that costs nothing: sign in with the admin password, make a new owner and a new recovery code, and download a new backup. Keep two owners, and the paper somewhere away from the server.

## Backups made before this update

Backups downloaded before this update are **.tar.gz** files and are not locked. They hold the settings, including the scrambled admin password and the two-factor secret. Find them and delete them: Downloads, other computers, Time Machine, cloud drives, email. Deleting a file does not always wipe it from an SSD. Treat anything that was in one as possibly seen by someone else: change the admin password and set up two-factor sign-in again when you can.

The fleet manager locks its own old copies by itself: on its first collection after the update it locks each old database and key file it holds to the server's owners and recovery code, checks each one opens again, and then deletes the unlocked copy. It only knows about its own folder.

## Restoring

A backup is restored onto a server with that server's admin password. It replaces the database and restarts the server.

- **A locked backup (.bpsealed)** needs the recovery code. The Restore Database Wizard in Settings does not ask for it yet, and opening a backup with an owner's phone comes in a later update. Until then, on the server's own machine, in the folder that holds the file, run: curl -k -X POST --data-binary @FILE -H "X-Admin-Password: PASSWORD" -H "X-Recovery-Code: CODE" https://localhost:8443/api/local/admin/restore, putting the file's name for FILE, this server's admin password for PASSWORD and the recovery code for CODE. With two-factor sign-in on, add -H "X-Admin-TOTP: 123456" with the code the authenticator shows. Sent without a recovery code, it answers with who can open the file and which code number it needs.
- It brings back everything in the file: the database, the server's keys, the community's genesis, its links with other communities, and its admin password and two-factor sign-in. After the restart, sign in with **the community's** admin password, not the one this server had. The server keeps its own replication token and other settings.
- If the file was locked by a different machine than this community's server (the fleet manager locks old backups with its own key), the server asks you to confirm that machine by name before it goes on. If you don't know that machine, don't restore the file: someone who once held a key may have made it.
- **An old .tar.gz backup** still restores, with the Restore Database Wizard. It brings back the database only; copy genesis.json, community.key and the other key files back by hand if they were lost.
- Stop and think before restoring over a live community: everything since the backup is lost.

## A standby server

A second server can follow yours as a read-only standby, copying changes about every minute.

- On your server, **Replication Access** (under Backups & Restore) makes a replication token. It is shown once. There is one token per server: making a new one stops every standby using the old one until you paste the new one in.
- On the standby, set NODE_ROLE=backup and BACKUP_PRIMARY_URL, and give it the token under **Live Backup Server** (or as BACKUP_REPLICATION_TOKEN in its .env). A standby only takes a token. It never takes your admin password, so its disk and its backups never hold it.
- The token copies the whole database, and can download a locked backup and the locked take-over keys. It never gets your server's keys unlocked: nothing on the server hands them out in the clear any more. The copy of the database on the standby is not locked, though: that is what a standby is. Guard the standby's disk like a backup.
- **Token-only** refuses the admin password for copying. A new server starts with it on. A server set up before this change has it off, so an older standby keeps working; Replication Access says so, and tells you when a standby last copied with the admin password. Tick **Require token** once every standby has the token.
- An older standby that still holds your admin password swaps it for a token by itself when it starts, if your server has no token yet: it uses the password once, keeps the token and deletes the password. If it cannot, it keeps the password, warns in its log at every start, and shows a red notice under **Live Backup Server** saying why and whether it is still copying.
- That standby is **not copying** if your server has two-factor sign-in on, has token-only on, or no longer takes that password. It still copies with the password only if your server already has a token and token-only is off.
- To fix it either way: if you saved your server's token, paste it under **Live Backup Server** on the standby and save. If not, make a new one under **Replication Access** and paste it into every standby. The standby then deletes the password. If the password came from BACKUP_ADMIN_PASSWORD in the standby's .env, delete that line too.
- Copying goes one way only. Your main server never takes data from the standby.
- **A standby is not a complete copy.** It does not copy Decisions and their votes, who holds which role, enterprise pledges and keeper changes, invites, or members' notification settings. Keep file backups as well.
- Making a standby the main server uses scripts in the BeanPool source code, not in the server image, and the first start after needs PROMOTED_FROM_BACKUP=true.
