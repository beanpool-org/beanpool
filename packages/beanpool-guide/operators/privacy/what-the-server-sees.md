---
slug: what-the-server-sees
title: Privacy and what your server can see
summary: What is private even from you, what you and your admins can see, secret ballots, and what your server sends elsewhere.
related: backups-and-replicas, address-and-peers, roles, feedback
---

Running the server means holding your neighbours' information. Know what you can see, so you can tell members honestly, and so you never look without a reason.

## Private even from you

- **Direct messages** between two members, their edits, and the photos in them, are encrypted on their phones. The server stores them but cannot read them. Neither can you. An app that cannot lock a message does not send it, and the server refuses a direct message that is not locked, whichever app sent it. Messages an older app sent without the lock, before this update, stay readable as they were stored.

## What the server holds in the clear

Anyone with the server's files can read these, and so can anyone who can open a backup. Once the server has a printed recovery code its backups are locked, and whoever holds the code can open them (any owner too, once opening with a phone arrives). A backup from a server with no recovery code, and any backup made before this update, is not locked: anyone who has it can read it:

- members' names, profiles, posts, photos, deals, balances and every trade;
- **group chats, event chats and enterprise chats**: these are not encrypted;
- the notices the server adds to a direct message about a deal: Beans placed in escrow, released, or refunded when a deal is cancelled, the amount, and how a dispute was settled and why;
- who messaged whom, and when, and their emoji reactions, even for direct messages;
- **how each member voted**.

## Secret ballots

Votes on Decisions are secret in the apps and in Settings: everyone sees only the totals, and each member sees their own vote. But the database records each member's vote, to count it and to stop anyone voting twice.

So others can read how each member voted. Whoever runs the machine can copy the files. Only an owner (or whoever has the admin password) can download a backup from Settings; an admin cannot. While the server has no recovery code, that backup is not locked. With a recovery code, it opens only with the code or an owner's phone. Tell your members this plainly, make a recovery code (see Backups and replicas), and let only people the community trusts hold it.

## Members' sign-in recovery copies

A member who connects Google, Apple or Facebook in the app, and everyone who joins the global community with a sign-in, has a locked copy of their account on the server, so that sign-in can bring the account back. The server locks every copy again with data/recovery-seal.key, which is never in the database. So a copy of the database, a snapshot, a backup that is not locked or a standby's disk opens none of them.

Whoever holds the database and that key can open a member's copy, though, with the id that member's sign-in account gives the server. The server receives that id every time the member signs in. That means whoever runs the machine, anyone with a copy of the whole data folder, and whoever opens a locked backup. The members' guide tells members this plainly, and that only their 12 words keep everyone else out. Don't look.

On the global community, the server also keeps a scrambled reference to each Google or Apple account someone joined with, so that one account makes one member. It is scrambled with data/open-join.key, which is never in the database either. So a copy of the database, a snapshot, a backup that is not locked or a standby's disk can't be used to find out which member signed in with a given account. Whoever holds the database and that key can: whoever runs the machine, anyone with a copy of the whole data folder, and whoever opens a locked backup.

It also notes which members joined through the open door from the same internet connection within a day of each other: a random label they share, never the address. Only the hiding of reported posts reads it, so that their reports count as one (see Reports and takedowns). It is in the database, so anyone who can read the database can see who joined together, as people in one household or at one meetup often do. A standby copies it, and it goes when the member deletes their own account.

GitHub is no longer a sign-in: a GitHub account's id is public, so anyone could look it up. At every start the server deletes any GitHub copy it still holds, the copies of those that a sign-in handed out, and any record of a GitHub join to the global community (see Backups and replicas).

## What someone who is not a member can read

Your community is for its members. Someone who is not a member, signed in to BeanPool or not, can read only this:

- the community's name, its counts and totals (members, posts, trades, the Commons pot), what it has switched on, and its health summary;
- the price guide: things and their usual prices, with no people or posts in it;
- what it takes to join or come back: whether an invite code works and who sent it, whether a name is taken here, and whether a key is a member here, but never that member's name. For a sign-in recovery, the one member whose whole name was typed, with their key and no photo. The name checks are limited to 15 a minute from one internet address;
- the pictures an app shows without signing: a profile picture by the member's key, a post's photos at their own addresses (see below), the locked attachments of direct messages, and the pictures of Pulse items.

Everything else is for members only: the market, the enterprises with who keeps and backs them, Decisions, Commons projects, crowdfunds and the Pulse. Someone who is not a member is told it is for members, and pointed to the global community, global.beanpool.org, to look around.

Profile pictures on your community are not locked with a key of their own yet. Anyone who has a member's key can see their picture: another member, someone they messaged or paid, or someone who typed their exact name into the sign-in recovery.

## Who can read what over the internet

- Reading anything private needs a member's signature. This is on by default. The setting is ENFORCE_READ_AUTH, and only the exact value false turns it off. Leave it on.
- An app shows a photo without signing, so the server gives each post's photo an address with a key in it, and the photo opens only at that address. Someone who has only a post's id gets nothing, not even whether the post exists.
- If you turn ENFORCE_READ_AUTH off, anyone can read all of it: the market and its photos, the enterprises, the Decisions and the Pulse. A post for a group, or for one person, still reaches only the people it is for, and so do its photos.
- The live-updates channel tells the apps about changes as they happen. Every version of the BeanPool app signs its connection, so the server knows which member is listening.
- A member hears about changes to the whole community, such as new posts, new members and announcements. They also hear about the private things they are part of: their own messages, their own trades, and the groups and event chats they are in. They never hear another member's messages or trades. When someone else's trade changes the market, for example a listing is taken, other members are told only that something changed, so their app can check again.
- Anyone who is not a member is told nothing of what happens on your community, with one exception: someone from another community whom one of your members has paid or messaged here still hears bare notices that something changed, such as that a Decision was proposed or voted on, or that a listing changed. They never hear what changed or who changed it, and they cannot open any of it. On the global community a visitor is told only that a post on the market changed, never what changed or who changed it. This is on by default.
- The setting is ENFORCE_WS_AUTH. The value true goes further and turns away anyone who is not a signed-in member. The value false sends the community-wide changes to anyone who can reach your server, as it was before, but never anyone's messages or trades. Do not use false.

## What admins see in Settings

- The logs, with passwords, keys, 12-word phrases and internet addresses removed before they are written. The log keeps its newest 2,500 lines, and none older than 30 days.
- The list of devices connected right now, with their internet address, device type and member name. It is kept in memory only, while they are connected.
- Reports, and the people they are about.

## When a member deletes their account

Their profile, the words, photos and places of their posts, every chat line they wrote and the photos they sent, and their sign-in recovery copies go from your server at once. Their trades stay in the ledger, under "Deleted Member". The members' guide tells them what goes, and what stays a while:

- **The log.** Every line that names them, or shows the start of their key, then reads "a deleted member", and so do the old lines that **Clean Orphaned Media & Compress Logs** moved out of the log. A line is never kept past 30 days anyway.
- **A standby** takes the delete at its next copy.
- **Notices kept for other members.** For 7 days your server keeps the details of each push it sent to a member (who wrote, which chat, which listing). On a delete it rewrites every such notice of other members that names the member or shows the start of their key: "Wren sent you a message" becomes "A member sent you a message". The rest of those notices (the chat or listing they point to) stays for the 7 days. They are the server's own: a standby does not copy them.
- **Snapshots** keep everything as it was when each was taken, until the snapshot is deleted: up to 7 days with the defaults, never more than 14 (see Backups and replicas). A standby takes no snapshots.
- **A backup you downloaded** is a file out of the server's reach. It keeps everything until you delete it. A fleet manager keeps one copy a day for 30 days.
- **Deletion records.** A short record of each delete (which row went, such as which two members were friends) stays on every server for 30 days, so a standby can copy the delete.
- **Docker's own log** of the server holds the same lines as the log, with their name, and nothing can change it afterwards. It is two files of 5 MB at most, and the oldest lines go as it fills, which on a quiet server can take weeks. It goes with the container: an update that replaces the container starts a new one, and so does: docker compose up -d --force-recreate

## Internet addresses

Your server keeps no one's internet address for more than 7 days, and its logs never record one.

- **Replication Access** shows the address each standby copy came from, and each refused try, so you can tell your standby from a stranger. It keeps each address for 7 days, then shows "address no longer kept" with the time and the outcome. The standby watch and the list of which standby holds which take-over keys do the same.
- A log line that has to tell one address from another (wrong admin passwords, a proxy missing from TRUSTED_PROXIES, the gateway's limit) names it by a code such as ip#k3Jx9QaB7d. The code is the address scrambled with a key that changes every day, is never saved, and is new after a restart. So the same address has the same code all day, and nobody can turn a code back into the address.
- The rate limits and the password brake count addresses in memory only. Joining with a sign-in and requests to join keep a scrambled address for a day, to limit how many come from one place.
- Snapshots and backups hold no visitor's or standby's address, not even a scrambled one, and none is left in the file's free space. A standby's copy never has them. A downloaded backup also carries your settings, including any admin IP allowlist you typed in under Gateway & Peers.
- A report file that a crash or a freeze leaves in the data folder lists each open connection by its port, with no address. The server takes the addresses out of its own crash report as soon as it writes it, and out of any other report file when it starts.
- A server updated to this version clears what it kept before when it starts: addresses older than 7 days, and every address in older log lines, in the snapshots it keeps and in older report files. A backup you downloaded before the update is a file on your own computer, out of the server's reach. Docker's own log of the server keeps what was printed before the update until Docker replaces it. The tunnel helper (cloudflared) keeps its own log.

![Diagnostics and system activity visible to admins in Settings](images/appliance-diagnostics.webp)

## Web app visits

Home shows how many times the web app was opened on your server each day for the last 30 days, and about how many different visitors that was. Your server counts this itself as it sends the web app's page: there is no cookie, no outside service and nothing extra in the app. It counts a person's browser opening the web app, and not the app's own requests, its files, Settings, the phone app, search engines, link previews or uptime checks. For each day it keeps the date (in UTC), the number of visits and the number of visitors, and nothing else, for 400 days. To tell visitors apart it scrambles each visit's internet address and browser name with a key made for that day, which is kept in memory only and thrown away at midnight UTC; only the count is saved, never an address, a browser name, a scrambled code or who is a member, and nothing about it goes in the logs. So the number of visitors is an estimate: people on one internet connection with the same browser count once, and after a restart someone who comes back counts again. A standby does not copy the counts: each server counts the visits it serves.

## What your server sends elsewhere

- The BeanPool directory, every 12 hours: your community's name, web address, area and member count, and its contact email and phone only if you turned each on (see Address, identity and peers). The directory is public. Under Node Identity you can switch off the area, the member count and the health report, or stop sending updates (the directory then keeps the last entry it received until BeanPool removes it).
- GitHub, every 6 hours, to ask for the newest version; and the app stores' pages, to learn the newest app versions. To stop the GitHub check, put DISABLE_UPDATE_CHECK=true in .env (see Updates, health checks and disk space): nothing else depends on it.
- Push notifications go through Expo, the service the phone app uses, on their way to Apple and Google. Each one says only what kind of news it is, in fixed words ("You have a new message.", "Your community has a notice for you."), with a random notice number and your server's signature: no name, amount, listing title or announcement passes through them. What the notice was about stays on your server for 7 days, for the member it was sent to. The app learns your server's signing key from its own sign-up for notifications and acts on a notification only when that signature checks out for that member: a forged one opens nothing, and the app says it didn't come from the community. A server from before signed notifications sends none of this; the app shows its notifications in general words and opens nothing when one is tapped, until you update.
- Members' Pulse channels are fetched from the sites they link to.
- With a .beanpool.org tunnel, members' traffic passes through Cloudflare, as it does for any site that uses Cloudflare.

**EXPO_ACCESS_TOKEN** is for the servers BeanPool runs itself. **On your own server, leave it empty:** your notifications go out exactly as they always have, and your server never needs anything from us to send them. Where it is set, the server sends the token with every notification. It reads it from .env only: it never saves it in its database or settings, never puts it in a backup or a standby's copy, and never writes it in the log.

Your server keeps a push address for each member's phone, and that address alone is enough to send the phone a notification. So treat your backups and any standby's copy as carefully as the server itself: anyone holding one could send your members fake notices.
