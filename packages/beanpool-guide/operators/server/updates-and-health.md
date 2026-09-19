---
slug: updates-and-health
title: Updates, health checks and disk space
summary: Updating the server, checking it is well from outside and inside, and keeping the disk from filling up.
related: backups-and-replicas, troubleshooting, rate-limits, address-and-peers
---

## Updating

Your server runs a ready-made image, beanpool-node, from ghcr.io/beanpool-org. It never updates itself. To update:

- back up the data folder (see Backups and replicas);
- on the server, in the folder with docker-compose.yml, run: docker compose pull
- then run: docker compose up -d

Members stay signed in to their apps. Anyone signed in to Settings from the app, or with a two-factor code, signs in again: those sign-ins are kept in memory.

The image tag **latest** is the newest release. To stay on one version, set BEANPOOL_IMAGE_TAG in .env to a version number, such as 1.2.22, and change it when you choose to update. Updates can change what members see, so tell them before a big one.

The repository's docker-compose.yml expects a Docker network called beanpool-shared. If the server will not start because it is missing, run once: docker network create beanpool-shared

## Is there a new version?

The server asks GitHub for the newest release shortly after it starts and every 6 hours. **Appliance & Data**, then **Diagnostics & Logs**, shows the version and whether an update is out, with a button to check now.

## Checking from outside

These addresses answer without signing in, so a monitoring service or a phone browser can check them:

- your address followed by **/api/version**: the version, and whether an update is available;
- your address followed by **/api/community/health**: the community's name, version and activity, and the watchdog's last report if you run one.

If neither answers, the server is down or unreachable. See Troubleshooting.

## Checking from inside

**Diagnostics & Logs** shows the processor, memory, database size, live connections, peers and the disk. Home shows the same at a glance, and a card after an unclean shutdown (power cut, crash). After an unclean shutdown the server checks its database as it starts; read the card, then acknowledge it.

![Diagnostics and system health cards in Settings](images/appliance-diagnostics.webp)

The server keeps its most recent log lines, which Settings shows under Logs. Some messages only appear in Docker's own log: docker compose logs --tail 200 beanpool-node

## Disk space

The disk card warns at **80%** full. Nothing stops the server writing when the disk is full, and a full disk can damage the database, so act on the warning.

- **Clean Orphaned Media & Compress Logs** shows what it would remove, then deletes photos no post uses and cached Pulse pictures no item uses, packs old log lines into data/logs/archived, and trims the database's write-ahead file.
- Keep fewer snapshots, or copy old ones off the server.
- Things that grow with no limit: data/logs/archived, the freeze reports (files named report-something.json in data), and Docker's own logs.
