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

## The ledger audit

Beans only ever move from one account to another, so the total across every account, the Commons included, never changes. The server checks that when it starts and once a day. To check now, open **Diagnostics & Logs** and press **Run Audit Now** under **Ledger Conservation Audit**. The drift should be 0, and so should the stranded escrows.

An escrow holds a buyer's Beans while a deal is open, and is empty once the deal ends. A stranded escrow is one that is not. After the audit runs, each stranded escrow is listed under it, with its deal and the last payment in or out of it.

- **Below zero:** the escrow paid out Beans it never held. Older servers could do this when a post with an open deal was taken down: the buyer was refunded from an escrow nobody had paid into. The buyer already has those Beans, so the community covers the hole. An owner presses **Write off from the Commons**, gives a reason, and the Commons pays in exactly what is missing. The escrow ends at 0, the total does not change, and the ledger records the deal, the reason and who wrote it off. An escrow can only be written off once.
- **If that leaves the Commons below zero**, Settings shows the Commons now and after, and asks you to confirm first. A Commons below zero is allowed: it is the honest record of a community that has paid out more than it has collected.
- **Above zero:** the escrow holds Beans a member paid in. Those never go to the Commons, so there is no write-off. Settle the deal instead (see Stuck deals and disputes).

Only an owner can write off an escrow, and only on the main server. A standby picks up the change with its next sync.

## When a background job fails

Sometimes a job the server started in the background fails on its own — a peer answers oddly, a lookup times out. The server used to stop and start again when that happened, which signed everybody out of the app for about a minute. It no longer does: it writes the failure down and keeps serving.

The full record is the file **data/unhandled-rejections.log**, one line per failure, with the message and the place in the code it came from. The same failure repeating is written once every ten minutes with a count beside it, so a job failing over and over cannot fill the disk; the file stops at about 1 MB and the one before it is kept as unhandled-rejections.log.1.

How many have happened since the server last started, and what the last one said, also come back in the server's own diagnostics answer, and the community health check raises a flag while the number is above zero. The number starts again at zero each time the server starts, so anything there happened during this run.

A few of these are not an emergency, and the server is still doing its work. Many of the same one is worth reporting — see Feedback.

A real crash is different. The server still stops and starts again, because carrying on half-way through a change could damage the ledger, and it leaves a report file in data named report-something.json, beside the freeze reports. That file holds no passwords and no keys, so it is safe to hand on when you ask someone for help. Reports written by older versions of the server did hold them, in full, and the server cleans those up the next time it starts, without deleting a single one. It can only do that once it has started: if the server is not starting at all, any older reports still in the folder have not been through that cleanup, so say so before you hand the folder to anyone.

## Disk space

The disk card warns at **80%** full. Nothing stops the server writing when the disk is full, and a full disk can damage the database, so act on the warning.

- **Clean Orphaned Media & Compress Logs** shows what it would remove, then deletes photos no post uses and cached Pulse pictures no item uses, packs old log lines into data/logs/archived, and trims the database's write-ahead file.
- Keep fewer snapshots, or copy old ones off the server.
- Things that grow with no limit: data/logs/archived, the freeze reports (files named report-something.json in data), and Docker's own logs.
