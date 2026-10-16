---
slug: troubleshooting
title: When things go wrong
summary: The server has stopped answering, an update stopped part-way, members see "too many requests", the disk is full, you cannot sign in, Settings will not open and you need to restore, or you want to start again.
related: updates-and-health, rate-limits, backups-and-replicas, signing-in
---

Stay calm and take a copy before you fix anything, and keep it outside the server folder, in the home folder for example: an update with deploy.sh replaces everything in the server folder except the data folder and .env. Most problems are fixed by a restart; a lost database is not.

## The server has stopped answering

- Check from outside: open your address followed by /api/version. If it does not answer, check the machine is on and online.
- Look at what the server last said: docker compose logs --tail 200 beanpool-node
- If it is frozen (running, but not answering), capture why before you restart: docker compose kill -s SIGUSR2 beanpool-node writes a report file, named report followed by the date and ending .json, into the data folder. Then run docker compose restart beanpool-node.
- After a crash or power cut the server checks its database as it starts, and Home shows a card about it.

### A watchdog

The BeanPool source code has a small watchdog for Linux machines (ops/watchdog). It checks the server every 20 seconds, and after 3 failures saves a report and restarts it, at most 4 times an hour. Set BEANPOOL_WATCH_CONTAINERS to your container's name: its built-in names are the BeanPool project's own servers.

## An update with deploy.sh stopped part-way, or stopped with FATAL

Run it again: a data folder it had moved out of the way is put back before the server starts. A FATAL that comes before the server is stopped changes nothing. One after it leaves the server stopped, with its data folder back in place or waiting in the home folder; what it printed says which. Read what it printed, and see Updating with deploy.sh under Updates, health checks and disk space. Never delete a copy of the data folder to make it go on.

## Members see "too many requests"

- Read the message: it names the limit. See Rate limits.
- Many people joining at once from one wifi can hit the sign-in limit. It clears within a minute.
- If everyone hits the gateway limit at once, your server may think every member has the same internet address. That happens behind a proxy on another machine: set TRUSTED_PROXIES.
- A restart clears every count, if you need it right now.

## The disk is full

- Appliance & Data, then Diagnostics & Logs, shows how full it is and what is using it.
- Run **Clean Orphaned Media & Compress Logs**, and delete old snapshots after copying them off.
- On the machine, check Docker's own logs and old images: docker system df shows them; docker image prune removes old images.
- When there is room again, check the database: Backups & Restore, then Database Integrity Verification.

![Diagnostics and system resources in Settings](images/appliance-diagnostics.webp)

## You cannot sign in

- "Too many wrong admin passwords": wait, try from another network, or sign in from the app. See Rate limits.
- Lost the password: see Signing in.
- Lost the two-factor code: see Access and security.
- Settings keeps signing you out: a sign-in from the app's Manage button ends after 15 minutes unused (press Manage again to come straight back). A computer signed in by scanning a code ends after 2 hours unused. Both end after 12 hours at most, and when the server restarts.

## Settings will not open and you need to restore

- First try to sign in another way: the app's Manage button, a computer signed in with your phone, a second owner, or beanpool recover on the server (Signing in).
- If the community needs a backup back and Settings still will not open, restore it on the server, with the node stopped: put the file in the data folder, then in the server folder run docker compose stop beanpool-node, then docker compose run --rm beanpool-node beanpool restore /data/FILE.bpsealed, then docker compose up -d. It asks for the recovery code. An old backup that is not locked restores with beanpool restore --unlocked /data/FILE.tar.gz instead, database and photos only. A restore point of the server as it was is kept first: docker compose exec beanpool-node beanpool restore-point list shows them, and docker compose run --rm beanpool-node beanpool restore-point roll-back NAME, with the node stopped, puts one back. See Backups and replicas.

## Start again

- There is no button and no command that wipes a server. To start over, see Starting over in Access and security: move data/local-config.json aside to clear the settings and keep members, posts, deals and Beans, or move the whole data folder away to start the community again from nothing.
- Keep what you moved until you are sure.

## Members cannot join

- Check the invite has not been used or passed its 30 days.
- Only an owner or admin can make invites in Settings (a moderator cannot), and the global community has no invites. See Members and invites.
- Check Invites is not switched off under Gateway & Peers.

## Getting help

Ask on the BeanPool project's GitHub. Say what you did, what you expected, what happened, and your version (your address followed by /api/version). Never post the admin password, a break-glass code, a backup or anyone's 12 words.
