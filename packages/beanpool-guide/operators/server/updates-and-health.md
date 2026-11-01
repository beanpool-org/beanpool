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

### Docker live-restore

Docker can restart, or take a patch update (the last number of its version, for example 27.3.1 to 27.3.2), without stopping your community when live-restore is enabled. A new version number in the first two places (27.3 to 27.4) can still stop it, so update Docker in a quiet hour, as before. It is an optional step below the install block in the README (the one-paste block on beanpool.org/start leaves it out), safe to skip, and an AI assistant doing the install always does it. A server installed without it, or before it existed, needs it once. It takes root: as root, run the commands as they are, and otherwise put sudo in front of each one (type sudo -v and your password first, so a password prompt never lands in the middle of what you paste). Check first that the machine has systemd (command -v systemctl prints a path) and that Docker is running (docker info prints without an error). Without systemd, leave live-restore off: the server runs fine without it. With both, run docker info --format '{{.LiveRestoreEnabled}}' first: if it already prints true, stop and leave daemon.json alone, because live-restore is already on (perhaps as a --live-restore flag in Docker's systemd unit), and a second copy of it in daemon.json would stop Docker from starting. If it prints false, add {"live-restore": true} to /etc/docker/daemon.json. If the file is missing, create it with just that. If it exists, copy it to daemon.json.new with cp -p, which keeps its permissions (a file that holds proxy or registry passwords may be readable by root only), add the key to the copy and keep every other key, check that the copy is valid JSON, then move it over the original with mv, so a half-written file is never left for Docker to read. If the original is not valid JSON, leave it alone and fix it first. Then run systemctl reload docker (never a restart) and check that docker info --format '{{.LiveRestoreEnabled}}' prints true.

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

The server asks GitHub for the newest release shortly after it starts and every 6 hours. **Appliance & Data**, then **Diagnostics & Logs**: press **Check Release Updates**, and Settings says which version your server runs and whether a newer one is out. Until you press it the tiles don't show your server's real version (the Node Version tile always says v1.4.2). Your server's address followed by /api/version always does.

To stop the server asking on its own, put DISABLE_UPDATE_CHECK=true in .env and run docker compose up -d. Take the new docker-compose.yml first: older ones don't pass the setting to the server. Nothing else depends on the check. The button to check now still asks GitHub, but only when you press it, and /api/version no longer says whether an update is out.

### The phone app's newest version

The server also asks Google Play and the App Store for the newest BeanPool phone app, shortly after it starts and every 6 hours, and tells members' phones, so an old app can show that an update is available. To stop it asking, put DISABLE_APP_STORE_CHECK=true in .env and run docker compose up -d (with the new docker-compose.yml, as above). The server then never asks either store. Phones are told of no newer app, and the app's floor (see Raising the app's floor) shows its banner only: no app is stopped with the full-screen update, because the server never holds anyone to a version it has not seen in the store. Home's **Phone app versions** card says the check is off.

## Checking from outside

These addresses answer without signing in, so a monitoring service or a phone browser can check them:

- your address followed by **/api/version**: the version, and whether an update is available (unless you turned the update check off);
- your address followed by **/api/community/health**: the community's name, version and activity, and the watchdog's last report if you run one.

If neither answers, the server is down or unreachable. See Troubleshooting.

## Checking from inside

**Diagnostics & Logs** shows the processor, memory, database size, live connections and the disk. Peers are under **Gateway & Peers**. Home shows the live connections, a warning when the disk is filling, and a card after an unclean shutdown (power cut, crash). After an unclean shutdown the server checks its database as it starts; read the card, then acknowledge it.

![Diagnostics and system health cards in Settings](images/appliance-diagnostics.webp)

The server keeps its most recent log lines, which Settings shows under Logs. Some messages only appear in Docker's own log: docker compose logs --tail 200 beanpool-node

## Compressed answers

The server compresses (gzips) what it sends the apps and the web app, when they ask for it, which they all do. Members then spend less of their data: a phone's first sync is about a sixth of the bytes.

If your server sits behind Cloudflare, as an address ending in .beanpool.org does, Cloudflare already compresses what it sends the phones. The server's own compressing then only shrinks what travels between your server and Cloudflare, and it costs processor time. On a server with one processor that is short of it, you can turn it off: put API_GZIP=off in .env and run docker compose up -d. Take the new docker-compose.yml first: older ones don't pass the setting to the server. The log says so as the server starts. Members' apps carry on as before, still compressed by Cloudflare.

With no Cloudflare or other proxy in front (your own domain, straight to the server), leave API_GZIP empty: nothing else compresses for your members.

## Alerts

The server watches itself every minute and tells its owners when it needs them:

- the disk is 80, 90 or 95% full (for three minutes running; it clears once it is four points below, 76% for the 80% alert);
- backups going off the server fail twice in a row, none has arrived for an interval and a half (or an interval and an hour, if that is longer), or destinations are set but nothing goes to them (no recovery code yet, or none of them can be used);
- no backup leaves the server and backups are not locked to a recovery code (a weekly nudge to the owners only);
- scheduled snapshots fail twice in a row;
- the server stopped without shutting down and started again three times in 15 minutes (told at the third start; restarting it yourself, for example with docker compose up -d, does not count), or stopped without shutting down;
- the host watchdog restarted it after a freeze, or the watchdog has gone quiet;
- the standby needs attention;
- on a standby: it is not paired with a main server, or the server it copies from answers with a key that is not its main server's (see Which server a standby trusts, in Backups and replicas);
- a certificate the server holds for one of its own addresses could not be renewed for a day after it was due (once a day while it lasts), has less than a day left (urgent), or expired before it was renewed, so apps and browsers see a self-signed one there and refuse it. Each names the address, so an owner with two knows which one. The first two also say when the certificate expires; the third says that it expired, or that there is none yet. The server keeps trying, at least once a day and more often near the end; once a new certificate arrives, the alert is resolved.
- signed requests are turned away because the server's store of their single-use numbers is full (see Rate limits): from people with no account here, or one newer account's app at its share, or, high, from accounts: newer accounts' share full, one member's app at its share, or everyone's share full. It says how many are in flight and from how many addresses or apps, never which, and is resolved 15 minutes after the last request turned away.

It also tells them when someone gains power on the server, saying what happened and how, never who:

- an owner, admin or moderator role is given or taken away, and how: by an owner, by an admin (moderators only), by the admin password, with a break-glass code, or by the server's shell (beanpool recover). Also when a suspension, a report, a removal from the community or a deleted account takes a role away, and when a lifted suspension gives it back, saying by whom: an owner, an admin, the admin password, a community vote, or the server itself when a suspension ends on its own;
- the community is claimed with its one-time claim code;
- a break-glass code is made (also by beanpool recover), an owner signs out everywhere, the admin password is retired, or new 2FA backup codes are made; and when a re-key moves an owner's or admin's role to a new key ("An admin's key was replaced by a re-key, by an owner"), high for an owner's;
- wrong admin passwords keep arriving from one address (it now waits between tries), or from many addresses (high); over after an hour without another;
- more than 20 wrong claim proofs arrive in a minute;
- the address service names another community as the holder of this community's address, or the address was released and its hold is over (high), until every address it watches is this community's again. The server reads this from its list of addresses every minute, so a database restored from a backup says what that backup's list says;
- another server took over this community with the same keys, so this one is read-only (urgent): told again every day until an owner taps **Seen** in the Alerts card;
- an AI assistant is connected or disconnected, or an owner allows or turns off AI assistants (high when a used pass came back and the assistant was cut off).
- the community was restored from a backup or rolled back to a restore point (high), told at the next start: "A backup made 2026-10-01 was restored, by an owner. A restore point was kept." A restore with beanpool restore or beanpool restore-point says "from the server's shell" instead, and an unlocked backup, whose date is not known, says "A backup was restored from the server's shell.". Uploads of another community's backup that Settings refused are counted on one line, for 24 hours from the first: "2 backups from another community were refused in the last day." Past three in an hour, the rest come as one line when the hour is over: "5 more backups from another community were refused in the hour after the first ones were pushed.";
- an owner takes the community's address offline, or claims a new name beside the one in use (high), titled "its address changed", never as the address taken by another community. Every member is told too. When the old address keeps working, they are told once the new name is live and answers (for a tunnel name, once the tunnel has connected): "This community is also at yourtown.beanpool.org. The old address keeps working." When a live tunnel name is replaced it stops answering, so they are told at once: "This community's address changed. Open the app to follow it." When the address is taken offline: "This community's address was taken offline by an owner. Ask your owners for the new one." Also an owner releasing a name the community held unused, or giving the tunnel a new key;
- an owner replaces the recovery code (high): "The recovery code was replaced, by an owner. Backups made before still open with the old one.";
- a backup setting changes, one line each: a replication token made or cleared, a standby forgotten, the server a standby copies from changed, an off-box destination removed or changed, off-box backups kept for fewer days, fewer snapshots kept, snapshots turned off or covering less time, or a standby's own replication token cleared. Past three changes by the same person in an hour, the rest come as one line when the hour is over: "2 more changes by the same owner";
- members are removed by an admin (pruned, offboarded or removed with a burst), or a branch of invites is pruned by an owner, as one line counting 24 hours from the first removal: "2 members were removed in the last day, by an admin." Removals after those 24 hours start a line of their own. Past the first three changes by the same admin in an hour, the line is not sent or pushed again, but its count still goes up in the alert history and the Alerts card. A member already removed is not counted again, and an owner's own removals are not told. (A removed owner, admin or moderator is also told as a role taken away, and pushed once.) An admin's removals are told only where community votes are switched off (the global community, or one whose owner switched them off), because only there do the admins remove members themselves. Where the community votes, an admin pauses a member and the community's vote removes them, so there is no admin's removal to count: this line is not sent, and the pause is told on a line of its own (below). An offboarding there only settles a removal already decided, by the community's vote or, where too few could vote, by an owner, and is not counted either; it shows on that vote's Decision instead ("Completed early: an admin settled the member's Beans with the offboarding wizard"). A branch of invites pruned by an owner is told either way, in a line of its own: "A branch of invites was pruned in the last day, by an owner.";
- a member is suspended (paused), whether or not the community votes, as one line counting 24 hours from the first, saying who suspended them: "A member was paused in the last day, by an admin." (or by an owner, or by the admin password, each counted on a line of its own). Suspensions after those 24 hours start a line of their own. Past the first three changes by the same person in an hour, the line is not sent or pushed again, but its count still goes up in the alert history and the Alerts card. It never says who was suspended or why: the vote's card says who suspended whom. A suspension that takes an owner's, admin's or moderator's role away is told as that role taken away instead ("A moderator lost that role, suspended by an admin."), pushed once, and is not counted here as well. A suspension the server refuses (see Decisions and emergencies) tells nothing;
- an owner decides a vote on removing a member that too few members could vote on, as one line counting 24 hours from the first, saying who decided: "A vote on removing a member, which too few members could vote on, was decided in the last day, by an owner." (or by the admin password, on a line of its own). Decisions after those 24 hours start a line of their own. Past the first three changes by the same person in an hour, the line is not sent or pushed again, but its count still goes up in the alert history and the Alerts card. It never says who the vote was about or why: the vote's card has the owner's reason. See Decisions and emergencies;
- a member's or moderator's account is moved to a new phone with a re-key, as one line counting 24 hours from the first, saying who moved them: "2 members' accounts were moved to a new phone in the last day, by an admin." (or by an owner, or by the admin password). An owner's or admin's re-key is told as their key replaced instead, never counted here too;
- an admin changes the community's name, its callsign or its contact details (low).

When an owner moves the alert channel to another address or removes it, the old channel gets one last message: "the alert channel was changed, by an owner. This is the last alert sent here." When only the token changes (a new one, or none), the channel gets one line instead, sent with the old token: "The token for this alert channel was changed in Settings."

And when members report something, so a report never waits unseen in the reports queue (People & Safety, then Triage & Moderation):

- the first report is told at once: "A new report came in (spam or scam). 3 reports wait in the Manager's Reports queue." The ones after it, for an hour, come as one line when the hour is over: "49 more reports came in in the hour after the first was told (spam or scam 13, offensive content 12, other 24)". To change the hour, put ALERTS_REPORT_FOLD_MINUTES in .env (1 to 1440 minutes) and run docker compose up -d;
- a report in the child-safety category is urgent: members pick **Child safety** in the report list (phone and web), and a report from an older app that says it in words ("CSAM", "sexual abuse of a minor") counts too. It is never folded into the hour's line. Each member's first in their hour is told and pushed at once; the rest of that member's hour comes as one urgent line when it ends, pushed: "9 more child-safety reports came in from the same member in the hour after their first was told". So one member reporting all hour sends 2 pushes, not 10. Your server tells at most 10 of these lines an hour; past that (a flood from many members), the reports are counted into one urgent line, told and pushed within about 10 minutes: "86 more child-safety reports came in, from 12 members, past the 10 lines an hour this server tells on their own". None is dropped, and every one is in the Reports queue at once.

These go to the owners and the admins (who work the queue), on their phones and on your channel. An admin's push carries the report lines alone, never the owners' other alerts. They say how many and what kind, from the reason the member picked; never who reported whom, and never what they wrote. Open **People & Safety**, then **Triage & Moderation** in Settings to read them: there each report shows who sent it and what they wrote. Report lines never push another alert out of the alert history or the channel's queue: past 50 lines, report lines make room first, and the same report line is counted (×14) rather than kept again. In a message held while your channel was down, they come after every other line.

For role changes, the claim and key changes, each owner gets a push at once for the first 3 an hour by the same person (or by the admin password), and for up to 3 more that make or remove an owner or use a break-glass code. The rest of that hour comes as one line an hour later, pushed: "40 more changes by the same admin". A change that makes or removes an owner, or uses a break-glass code, is always listed on its own in the channel and the Alerts card, and is never dropped to make room; the same line repeated is shown once with a count (×5). An owner or admin who loses that role gets that push too, while it is among the changes pushed at once; the hourly line goes to the owners as they are then.

These show in the Alerts card and count in the Settings banner for a day, or until an owner taps **Seen** (an owner, or the admin password with two-factor sign-in). **Seen** deletes nothing: the alert history keeps the last 50 lines, and past them every change that makes or removes an owner or makes or uses a break-glass code, another server taking over, and the line saying whether an owner or the admin password marked them seen, and when. Past the first ones of the hour, a change is a line of its own only if it makes or removes an owner or uses a break-glass code; the hourly line counts them all, and says how many were listed on their own. To see who made a change, open Settings: the alert itself never names them. Every line written to the server's security log is in the history too, as one line for each kind (sign-in, keys and codes; backups and the standby; and so on) with a count (×5), never the line's own words: read those in Appliance & Data → Diagnostics & Logs.

A standby tells its own changes on its own channel and in its own Alerts card, and never pushes. Once it takes over as the main server, those leave its Alerts card and banner (they were about the roles, password and codes the take-over replaced) and stay in the history.

Each alert is told once when it starts, again every 24 hours while it lasts, and once when it is resolved: when it has been over for 15 minutes. One that comes back within those 15 minutes is not told again, so something swinging on and off sends one message, not one for each swing.

**Owners always hear.** Each owner gets a push on their phone (one for everything that started in the same minute, and at most one a day for each alert, unless it gets worse; security changes as above), whatever their Marketplace Activity setting, and a banner in Settings until it is over. On Settings' **Home**, **Action Required** lists each one the banner counts, in its own words; press one to open the Alerts card. The watchdog going quiet is the one alert that is never pushed: it shows in the Alerts card, the banner and your channel. Admins and moderators are not told (admins are, of reports), and only an owner can open the **Alerts** card: **Appliance & Data**, then **Backups & Restore**.

**Your own channel, if you want one.** In the Alerts card, add an ntfy topic (for example https://ntfy.sh/ followed by a long name nobody can guess: the topic's name is its password) or any address that takes a JSON POST, with an optional token. Or put ALERTS_WEBHOOK_URL, ALERTS_WEBHOOK_FORMAT (ntfy or json) and ALERTS_WEBHOOK_TOKEN in .env and run docker compose up -d. **Send a test** checks it arrives. The channel is yours: nothing goes through BeanPool, and with no channel set nothing leaves the server.

The address and token are kept in data/alerts.json (readable by the server's own user only) or in .env. They are never in the database, so never in a snapshot, a backup or a standby's copy, never in a log, and never shown again: the card shows the address's domain only, never a subdomain, the path or the token. A standby that takes over has no channel until an owner sets one.

A channel that does not answer is tried again every 5 minutes, with everything it missed in one message whose text is at most 4096 bytes (ntfy's limit; a JSON channel's POST also carries each line's details, so its body is larger): the high and urgent lines first, then the others, report lines last (they were pushed already), as many as fit, and the rest as a count ("And 28 more, too many for one message"). At most 20 messages an hour go to it; high and urgent ones still go, up to 60 an hour, and anything held goes in the next message. A redirect is treated as a failure and never followed. Only whether the channel took the message is read, never what it answered.

**What an alert says:** your community's name, what is wrong in plain words, since when, and counts. Never a member's name, key or address, nothing anyone wrote, and never a backup store's key or the channel's address. The certificate alerts name the server's own address they are about (a name or an IP it publishes anyway), never a visitor's.

## The ledger audit

Beans only ever move from one account to another, so the total across every account, the Commons included, never changes. The server checks that when it starts and once a day. To check now, open **Diagnostics & Logs** and press **Run Audit Now** under **Ledger Conservation Audit**. The drift should be 0, and so should the stranded escrows.

An escrow holds a buyer's Beans while a deal is open, and is empty once the deal ends. A stranded escrow is one that is not. After the audit runs, each stranded escrow is listed under it, with its deal and the last payment in or out of it.

- **Below zero:** the escrow paid out Beans it never held. Older servers could do this when a post with an open deal was taken down: the buyer was refunded from an escrow nobody had paid into. The buyer already has those Beans, so the community covers the hole. An owner presses **Write off from the Commons**, gives a reason, and the Commons pays in exactly what is missing. The escrow ends at 0, the total does not change, and the ledger records the deal, the reason and who wrote it off. An escrow can only be written off once.
- **If that leaves the Commons below zero**, Settings shows the Commons now and after, and asks you to confirm first. A Commons below zero is allowed: it is the honest record of a community that has paid out more than it has collected.
- **Above zero:** the escrow holds Beans a member paid in. Those never go to the Commons, so there is no write-off. Settle the deal instead (see Stuck deals and disputes).

Only an owner can write off an escrow, and only on the main server. A standby picks up the change with its next sync.

### A balance that isn't a number

Every balance should be a number of Beans. If one isn't (it holds Infinity, text, or nothing at all), the total can't add up, and the audit card shows the drift as "not a number". The audit at start-up writes how many "balances that are not a finite number" it found to the server's log. Nothing in Settings mends one, and the server never guesses a value for it. A take-over still finishes on such a ledger, and its last screen says the ledger doesn't add up.

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

A real crash is different. The server still stops and starts again, because carrying on half-way through a change could damage the ledger, and it leaves a report file in data whose name starts with report and ends in .json, beside the freeze reports. That file holds no passwords and no keys, so it is safe to hand on when you ask someone for help. Reports written by older versions of the server did hold them, in full, and the server cleans those up the next time it starts, without deleting a single one. It can only do that once it has started: if the server is not starting at all, any older reports still in the folder have not been through that cleanup, so say so before you hand the folder to anyone.

## Disk space

The disk card warns at **80%** full. Nothing stops the server writing when the disk is full, and a full disk can damage the database, so act on the warning.

- **Clean Orphaned Media & Compress Logs** shows what it would remove, then deletes photos no post uses and cached Pulse pictures no item uses, packs old log lines into data/logs/archived, and trims the database's write-ahead file.
- Keep fewer snapshots, or copy old ones off the server.
- Things that grow with no limit: the crash and freeze reports in data (names starting report and ending .json). Archived log lines go after 30 days. Docker's own log is held to two files of 5 MB by the current docker-compose.yml.
