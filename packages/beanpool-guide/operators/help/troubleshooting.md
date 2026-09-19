---
slug: troubleshooting
title: When things go wrong
summary: The server has stopped answering, members see "too many requests", the disk is full, or you cannot sign in.
related: updates-and-health, rate-limits, backups-and-replicas, signing-in
---

Stay calm and take a copy before you fix anything. Most problems are fixed by a restart; a lost database is not.

## The server has stopped answering

- Check from outside: open your address followed by /api/version. If it does not answer, check the machine is on and online.
- Look at what the server last said: docker compose logs --tail 200 beanpool-node
- If it is frozen (running, but not answering), capture why before you restart: docker compose kill -s SIGUSR2 beanpool-node writes a report file, named report followed by the date and ending .json, into the data folder. Then run docker compose restart beanpool-node.
- After a crash or power cut the server checks its database as it starts, and Home shows a card about it.

### A watchdog

The BeanPool source code has a small watchdog for Linux machines (ops/watchdog). It checks the server every 20 seconds, and after 3 failures saves a report and restarts it, at most 4 times an hour. Set BEANPOOL_WATCH_CONTAINERS to your container's name: its built-in names are the BeanPool project's own servers.

## Members see "too many requests"

- Read the message: it names the limit. See Rate limits.
- Many people joining at once from one wifi can hit the sign-in limit. It clears within a minute.
- If everyone hits the gateway limit at once, your server may think every member has the same internet address. That happens behind a proxy on another machine: set TRUSTED_PROXIES.
- A restart clears every count, if you need it right now.

## The disk is full

- Appliance and Data, then Diagnostics and Logs, shows how full it is and what is using it.
- Run **Clean Orphaned Media and Compress Logs**, and delete old snapshots after copying them off.
- On the machine, check Docker's own logs and old images: docker system df shows them; docker image prune removes old images.
- When there is room again, check the database: Backups and Restore, then Database Integrity Verification.

## You cannot sign in

- "Too many wrong admin passwords": wait, or sign in from the app. See Rate limits.
- Lost the password: see Signing in.
- Lost the two-factor code: see Access and security.
- Settings keeps signing you out: sign-ins from the app last 2 hours unused, 12 hours at most, and end when the server restarts.

## Members cannot join

- Check the invite has not been used or passed its 30 days.
- Invites made in Settings while signed in from the app are not real codes. See Members and invites.
- Check Invites is not switched off under Gateway and Peers.

## Getting help

Ask on the BeanPool project's GitHub. Say what you did, what you expected, what happened, and your version (your address followed by /api/version). Never post the admin password, a break-glass code, a backup or anyone's 12 words.
