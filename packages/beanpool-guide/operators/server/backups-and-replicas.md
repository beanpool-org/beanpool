---
slug: backups-and-replicas
title: Backups and replicas
summary: What to back up, the backups Settings makes for you, restoring, and running a second server as a standby.
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

The simplest complete backup: stop the server, copy the whole data folder somewhere else, start it again. Do it before every update.

## Backups from Settings

**Appliance & Data**, then **Backups & Restore**:

- **Download Sovereign Database**: a .tar.gz with a clean copy of the database, taken while the server runs. It usually carries a copy of your settings too, including the scrambled admin password and the two-factor secret. It does not include the server's keys (libp2p_key, community.key).
- **Point-in-Time Snapshots**: on by default, one every **24 hours**, keeping the last **7**, in data/snapshots. You can take one now, download one or delete one. Snapshots sit on the same disk as the server, so they do not survive a lost disk. Copy one off the server now and then.
- **Database Integrity Verification**: checks the live database or a snapshot for damage.

Treat every backup as private: it holds everything, including how each member voted (see Privacy and what your server can see). Keep it encrypted, somewhere only owners can reach.

## Restoring

**Restore Database Wizard** takes a backup file (up to 500 MB) and the admin password. It replaces the database and restarts the server.

- It restores the database only. It does not bring back genesis.json, community.key or local-config.json; copy those back by hand if they were lost.
- Stop and think before restoring over a live community: everything since the backup is lost.

## A standby server

A second server can follow yours as a read-only standby, copying changes about every minute.

- On your server, **Replication Access** (under Backups & Restore) makes a replication token. It is shown once. There is one token per server: making a new one stops every standby using the old one until you paste the new one in.
- On the standby, set NODE_ROLE=backup and BACKUP_PRIMARY_URL, and give it the token under **Live Backup Server** (or as BACKUP_REPLICATION_TOKEN in its .env). A standby only takes a token. It never takes your admin password, so its disk and its backups never hold it.
- The token copies the whole database and can also download a database backup, so guard it like a backup. It cannot fetch the server's keys: only an owner or admin, signed in, can.
- **Token-only** refuses the admin password for copying. A new server starts with it on. A server set up before this change has it off, so an older standby keeps working; Replication Access says so, and tells you when a standby last copied with the admin password. Tick **Require token** once every standby has the token.
- An older standby that still holds your admin password swaps it for a token by itself when it starts, if your server has no token yet: it uses the password once, keeps the token and deletes the password. If it cannot, it keeps the password, warns in its log at every start, and shows a red notice under **Live Backup Server** saying why and whether it is still copying.
- That standby is **not copying** if your server has two-factor sign-in on, has token-only on, or no longer takes that password. It still copies with the password only if your server already has a token and token-only is off.
- To fix it either way: if you saved your server's token, paste it under **Live Backup Server** on the standby and save. If not, make a new one under **Replication Access** and paste it into every standby. The standby then deletes the password. If the password came from BACKUP_ADMIN_PASSWORD in the standby's .env, delete that line too.
- Copying goes one way only. Your main server never takes data from the standby.
- **A standby is not a complete copy.** It does not copy Decisions and their votes, who holds which role, enterprise pledges and keeper changes, invites, or members' notification settings. Keep file backups as well.
- Making a standby the main server uses scripts in the BeanPool source code, not in the server image, and the first start after needs PROMOTED_FROM_BACKUP=true.
