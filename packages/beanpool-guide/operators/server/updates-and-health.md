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

Members stay signed in to their apps. Anyone signed in to Settings signs in again, with the password or from the app: those sign-ins are kept in memory.

The image tag **latest** is the newest release. To stay on one version, set BEANPOOL_IMAGE_TAG in .env to a version number, such as 1.2.22, and change it when you choose to update. Updates can change what members see, so tell them before a big one.

**Blank listing photos after going back.** If you went back to an older version and then forward again, or restored an old backup, members' apps can keep listing photos that no longer open. To make every app read all the listings again over its next few syncs, run once: docker compose exec -u node beanpool-node node -e "require('better-sqlite3')('/data/state.db').prepare(\"DELETE FROM node_config WHERE key = 'photoKeysShape'\").run()" and then: docker compose restart beanpool-node

**Going back to a version from before the open door's key file.** Newer versions keep the open door's key in data/open-join.key, not in the database. Older versions look for it only in the database. Without it, an older version makes a new key, and then every member who joined with a Google or Apple sign-in could join again as a new member. So before you go back to such a version, on the main server:

- stop the server: docker compose stop beanpool-node
- still on the newer image, run: docker compose run --rm --no-deps beanpool-node node dist/services/open-join-key.js --write-key-row
- it copies the key back into the database and says how many sign-in records it did that for. If it says "Nothing was changed", do not go back yet: put the right open-join.key in the data folder first, as the message says;
- then set BEANPOOL_IMAGE_TAG to the older version and run: docker compose up -d

While the older version runs, the key is in the database again, so it is in every backup and copy, as it was before. The next update moves it out again by itself. A standby needs none of this: it holds no key.

The repository's docker-compose.yml expects a Docker network called beanpool-shared. If the server will not start because it is missing, run once: docker network create beanpool-shared

Take the new docker-compose.yml with each update, not only the image. The server needs no access to Docker itself: if your docker-compose.yml still has the line /var/run/docker.sock:/var/run/docker.sock, remove it, because anything that can use that file controls the whole machine. Settings shows a red warning under **Public Address** while it is there. If you added a cloudflared service to your docker-compose.yml yourself for a .beanpool.org name, remove that too: the tunnel now runs inside the server.

The image carries its own copy of cloudflared, the program that runs your tunnel. Cloudflare supports each version for a year after its newer releases come out, so a server left without updates for about a year can stop connecting. Updating the server updates it.

## Updating with deploy.sh

If you update your servers from a copy of the BeanPool source code with deploy.sh (the copy must be a git clone, run from its top folder, because deploy.sh sends only the files git tracks, so a new file needs git add before it ships), this is what it does on each one: it stops the server, moves the data folder and .env out of the way into the home folder (as beanpool-data-backup and beanpool-env-backup, each followed by the server's folder name), puts the new code in place, moves both back, and only then starts the server. It needs the flock command on the server, which comes with almost every Linux; if it says flock is missing, install util-linux.

- **One update at a time.** A second deploy.sh to the same server folder while one is running stops at once, saying another deploy is running there. It changes nothing in that server folder. Let the first one finish.
- **If an update stops part-way** (the connection drops, or you stop it), run it again. If the data folder is still waiting in the home folder, the next run says it is "this node's data, parked by a deploy that did not finish" and puts it back before the server starts. If that run stops before it gets that far (a failed download, a full disk), it says the data folder is still waiting in the home folder and the server is stopped; fix what it names and run it again, and it puts the data folder back.
- **"this node's data is in two places"**: the next run found a data folder and a waiting copy as well. It changes nothing and lists both: when each database last changed and how big it is, which community each holds and when that community was founded, and a fingerprint of each community key (never the key itself). Your community is normally the one founded long ago that changed last; one founded minutes ago is a new, empty community a server made on an empty folder. Set the other one aside with the dated command it prints, then run the update again.
- **"data is missing, and a copy of this node's data was set aside"**: there is no data folder, but an older copy sits beside it, such as one whose name ends in .stale. Starting would make a new, empty community, so it stops. Move the right copy back with the command it prints; or, if you really do want a new community there, make an empty data folder first.
- **".env is in two places"**: the same, for the settings file.
- **A container that "will not stop"**: something still running is using the data folder. Nothing was moved, and your server is stopped. Stop that container, then run the update again. Do not start the server while the other one runs: two servers on one database can damage it.

deploy.sh replaces everything in the server folder except the data folder and .env, so a copy of the data folder kept inside the server folder is deleted by the next update. Keep any copy of it outside the server folder, for example in the home folder beside the parked copy, as the dated commands it prints do. deploy.sh never deletes a copy it parked or one you set aside there. Once your server runs well on the right copy, delete any copies you set aside yourself, when you no longer need them.

## Is there a new version?

The server asks GitHub for the newest release shortly after it starts and every 6 hours. **Appliance & Data**, then **Diagnostics & Logs**, shows the version and whether an update is out, with a button to check now.

To stop the server asking on its own, put DISABLE_UPDATE_CHECK=true in .env and run docker compose up -d. Take the new docker-compose.yml first: older ones don't pass the setting to the server. Nothing else depends on the check. The button to check now still asks GitHub, but only when you press it, and /api/version no longer says whether an update is out.

## Checking from outside

These addresses answer without signing in, so a monitoring service or a phone browser can check them:

- your address followed by **/api/version**: the version, and whether an update is available (unless you turned the update check off);
- your address followed by **/api/community/health**: the community's name, version and activity, and the watchdog's last report if you run one.

If neither answers, the server is down or unreachable. See Troubleshooting.

## Checking from inside

**Diagnostics & Logs** shows the processor, memory, database size, live connections, peers and the disk. Home shows the same at a glance, and a card after an unclean shutdown (power cut, crash). After an unclean shutdown the server checks its database as it starts; read the card, then acknowledge it.

![Diagnostics and system health cards in Settings](images/appliance-diagnostics.webp)

The server keeps its most recent log lines, which Settings shows under Logs. Some messages only appear in Docker's own log: docker compose logs --tail 200 beanpool-node

## Alerts

The server watches itself every minute and tells its owners when it needs them:

- the disk is 80, 90 or 95% full (for three minutes running; it clears once it is four points below, 76% for the 80% alert);
- backups going off the server fail twice in a row, none has arrived for two intervals, or destinations are set but nothing goes to them (no recovery code yet, or none of them can be used);
- no backup leaves the server and backups are not locked to a recovery code (a weekly nudge to the owners only);
- scheduled snapshots fail twice in a row;
- the server stopped without shutting down and started again three times in 15 minutes (told at the third start; restarting it yourself, for example with docker compose up -d, does not count), or stopped without shutting down;
- the host watchdog restarted it after a freeze, or the watchdog has gone quiet;
- the standby needs attention;
- the Let's Encrypt certificate could not be renewed and browsers see a self-signed one.

Each alert is told once when it starts, again every 24 hours while it lasts, and once when it is resolved: when it has been over for 15 minutes. One that comes back within those 15 minutes is not told again, so something swinging on and off sends one message, not one for each swing.

**Owners always hear.** Each owner gets a push on their phone (one for everything that started in the same minute, and at most one a day for each alert), whatever their Marketplace Activity setting, and a banner in Settings until it is over. Admins and moderators are not told, and only an owner can open **Appliance & Data**, then **Alerts**.

**Your own channel, if you want one.** In the Alerts card, add an ntfy topic (for example https://ntfy.sh/ followed by a long name nobody can guess: the topic's name is its password) or any address that takes a JSON POST, with an optional token. Or put ALERTS_WEBHOOK_URL, ALERTS_WEBHOOK_FORMAT (ntfy or json) and ALERTS_WEBHOOK_TOKEN in .env and run docker compose up -d. **Send a test** checks it arrives. The channel is yours: nothing goes through BeanPool, and with no channel set nothing leaves the server.

The address and token are kept in data/alerts.json (readable by the server's own user only) or in .env. They are never in the database, so never in a snapshot, a backup or a standby's copy, never in a log, and never shown again: the card shows the address's domain only, never a subdomain, the path or the token. A standby that takes over has no channel until an owner sets one.

A channel that does not answer is tried again every 5 minutes, with everything it missed in one message. At most 20 messages an hour go to it; high and urgent ones still go, up to 60 an hour, and anything held goes in the next message. A redirect is treated as a failure and never followed. Only whether the channel took the message is read, never what it answered.

**What an alert says:** your community's name, what is wrong in plain words, since when, and counts. Never a member's name, key or address, nothing anyone wrote, and never a backup store's key or the channel's address.

## The ledger audit

Beans only ever move from one account to another, so the total across every account, the Commons included, never changes. The server checks that when it starts and once a day. To check now, open **Diagnostics & Logs** and press **Run Audit Now** under **Ledger Conservation Audit**. The drift should be 0, and so should the stranded escrows.

An escrow holds a buyer's Beans while a deal is open, and is empty once the deal ends. A stranded escrow is one that is not. After the audit runs, each stranded escrow is listed under it, with its deal and the last payment in or out of it.

- **Below zero:** the escrow paid out Beans it never held. Older servers could do this when a post with an open deal was taken down: the buyer was refunded from an escrow nobody had paid into. The buyer already has those Beans, so the community covers the hole. An owner presses **Write off from the Commons**, gives a reason, and the Commons pays in exactly what is missing. The escrow ends at 0, the total does not change, and the ledger records the deal, the reason and who wrote it off. An escrow can only be written off once.
- **If that leaves the Commons below zero**, Settings shows the Commons now and after, and asks you to confirm first. A Commons below zero is allowed: it is the honest record of a community that has paid out more than it has collected.
- **Above zero:** the escrow holds Beans a member paid in. Those never go to the Commons, so there is no write-off. Settle the deal instead (see Stuck deals and disputes).

Only an owner can write off an escrow, and only on the main server. A standby picks up the change with its next sync.

### A balance that isn't a number

Every balance should be a number of Beans. If one isn't (it holds Infinity, text, or nothing at all), the total can't add up, and the audit says how many "balances that are not a number" it found. Nothing in Settings mends one, and the server never guesses a value for it. A take-over still finishes on such a ledger, and its last screen says the ledger doesn't add up.

That includes the Commons pot's own row, COMMONS_POOL. If it holds no number of Beans when the server starts (text, nothing, or Infinity), the server treats the pot as unknown and says so in its log with a 🛑 line. It never writes 0 or anything else over the row, and no Beans move at all until you mend it: no deal, refund, removal, account deletion or payment from the Commons. Members who try are told "Payments are paused on this community while its admins fix a problem with its accounts." A Decision that moves Beans (a grant or a write-off) waits, and is carried out on the first check after the row is mended, and no new grant can be proposed meanwhile. A removal whose grace window ends during the pause waits too, and once the row is mended its grace window opens again for 24 hours, so an admin can still halt it. Everything that moves no Beans still works: other Decisions go ahead, an admin can halt a vote or a removal, and a moderator can take down a listing with no deal on it. Mend it as soon as you see it, as below.

The audit's own answer names each one: POST /api/local/admin/ledger-audit lists the account, the member's or enterprise's name, and what it holds, under brokenBalances. The Commons pot shows as COMMONS_POOL. Setting a new baseline is refused while any balance isn't a number, and the refusal names them too.

To mend one:

- stop the server: docker compose stop beanpool-node
- open data/state.db with any SQLite tool, and work out what the account should hold from its transactions table: every payment into it (to_pubkey) less the community fee on each (tax_fee), less every payment out of it (from_pubkey). For COMMONS_POOL, add every fee in the table too. For any one account, with its key in place of KEY: SELECT COALESCE((SELECT SUM(amount - COALESCE(tax_fee, 0)) FROM transactions WHERE to_pubkey = 'KEY'), 0) - COALESCE((SELECT SUM(amount) FROM transactions WHERE from_pubkey = 'KEY'), 0);
- set it, putting that number in place of AMOUNT and the account in place of KEY: UPDATE accounts SET balance = AMOUNT WHERE public_key = 'KEY';
- start the server again: docker compose up -d
- run the audit again. Once every balance is a number, set a new baseline for any difference that's left, with a written reason.

Take a backup of the data folder before you change anything in it.

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
