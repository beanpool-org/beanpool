---
slug: backups-and-replicas
title: Backups and replicas
summary: What to back up, the backups Settings makes for you, restoring, and running a second server as a standby.
related: updates-and-health, troubleshooting, what-the-server-sees, first-time-setup
---

## What matters

Everything lives in the **data** folder next to docker-compose.yml:

- **state.db** (with state.db-wal and state.db-shm beside it while the server runs): members, posts, deals, beans, votes, messages;
- **genesis.json** and **community.key**: the community's own key. Lose these and the community cannot be rebuilt as itself;
- **local-config.json**: the admin password, two-factor sign-in and other settings;
- **libp2p_key** and **connectors.json**: the server's network identity and peer links;
- **snapshots**, **logs** and **cache**: the automatic snapshots, old logs, and pictures fetched for the Pulse, which can be fetched again.

The simplest complete backup: stop the server, copy the whole data folder somewhere else, start it again. Do it before every update.

## Backups from Settings

**Appliance and Data**, then **Backups and Restore**:

- **Download Sovereign Database**: a .tar.gz with a clean copy of the database, taken while the server runs. It usually carries a copy of your settings too, including the scrambled admin password and the two-factor secret. It does not include the community key.
- **Point-in-time snapshots**: on by default, one every **24 hours**, keeping the last **7**, in data/snapshots. You can take one now, download one or delete one. Snapshots sit on the same disk as the server, so they do not survive a lost disk. Copy one off the server now and then.
- **Database Integrity Verification**: checks the live database or a snapshot for damage.

Treat every backup as private: it holds everything, including how each member voted (see Privacy and what your server can see). Keep it encrypted, somewhere only owners can reach.

## Restoring

**Restore Database Wizard** takes a backup file (up to 500 MB) and the admin password. It replaces the database and restarts the server.

- It restores the database only. It does not bring back genesis.json, community.key or local-config.json; copy those back by hand if they were lost.
- Stop and think before restoring over a live community: everything since the backup is lost.

## A standby server

A second server can follow yours as a read-only standby, copying changes about every minute.

- On your server, **Replication Access** (under Backups and Restore) makes a replication token. It is shown once. Token-only mode then refuses the admin password for copying, which is safer.
- On the standby, set NODE_ROLE=backup and BACKUP_PRIMARY_URL, and give it the token under **Live Backup Server**. If you give it the admin password instead, it is stored in plain text on the standby.
- Copying goes one way only. Your main server never takes data from the standby.
- **A standby is not a complete copy.** It does not copy Decisions and their votes, or who holds which role. Keep file backups as well.
- Making a standby the main server uses scripts in the BeanPool source code, not in the server image, and the first start after needs PROMOTED_FROM_BACKUP=true.
