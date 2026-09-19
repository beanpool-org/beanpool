---
slug: what-the-server-sees
title: Privacy and what your server can see
summary: What is private even from you, what you and your admins can see, secret ballots, and what your server sends elsewhere.
related: backups-and-replicas, address-and-peers, roles, feedback
---

Running the server means holding your neighbours' information. Know what you can see, so you can tell members honestly, and so you never look without a reason.

## Private even from you

- **Direct messages** between two members, and the photos in them, are encrypted on their phones. The server stores them but cannot read them. Neither can you. One exception: if the sender's app cannot find the other person's key, it sends the message without the lock rather than not at all, and that message can be read.

## What the server holds in the clear

Anyone with the server's files can read these, and so can anyone who can open a backup. Once the server has a printed recovery code its backups are locked, and whoever holds the code can open them (any owner too, once opening with a phone arrives). A backup from a server with no recovery code, and any backup made before this update, is not locked: anyone who has it can read it:

- members' names, profiles, posts, photos, deals, balances and every trade;
- **group chats, event chats and enterprise chats**: these are not encrypted;
- who messaged whom, and when, even for direct messages;
- **how each member voted**.

## Secret ballots

Votes on Decisions are secret in the apps and in Settings: everyone sees only the totals, and each member sees their own vote. But the database records each member's vote, to count it and to stop anyone voting twice.

So others can read how each member voted. Whoever runs the machine can copy the files. While the server has no recovery code, every owner and admin can download a backup from Settings that is not locked. With a recovery code, whoever holds the code can open a backup, and an admin can download one but cannot open it. Tell your members this plainly, make a recovery code (see Backups and replicas), and let only people the community trusts hold it.

## Who can read what over the internet

- Reading anything private needs a member's signature. This is on by default. The setting is ENFORCE_READ_AUTH, and only the exact value false turns it off. Leave it on.
- Some things are public on purpose: the market's list of posts, the Pulse, the community's health summary, profile pictures and post photos.
- The live-updates channel tells the apps about changes as they happen. Every version of the BeanPool app signs its connection, so the server knows which member is listening.
- A member hears about changes to the whole community, such as new posts, new members and announcements. They also hear about the private things they are part of: their own messages, their own trades, and the groups and event chats they are in. They never hear another member's messages or trades. When someone else's trade changes the market, for example a listing is taken, other members are told only that something changed, so their app can check again.
- Anyone who is not a member is told only that something public changed, such as a post on the market or a pin on the map. They are never told what changed or who changed it. This is on by default.
- The setting is ENFORCE_WS_AUTH. The value true goes further and turns away anyone who is not a signed-in member. The value false sends the community-wide changes to anyone who can reach your server, as it was before, but never anyone's messages or trades. Do not use false.

## What admins see in Settings

- The logs, with passwords, keys and 12-word phrases removed before they are written.
- The list of devices connected right now, with their internet address, device type and member name.
- Reports, and the people they are about.

![Diagnostics and system activity visible to admins in Settings](images/appliance-diagnostics.webp)

## What your server sends elsewhere

- The BeanPool directory, every 12 hours: your community's name, area, member count and contact details (see Address, identity and peers). Switch it off under Node Identity.
- GitHub, every 6 hours, to ask for the newest version; and the app stores' pages, to learn the newest app versions.
- Push notifications go through Expo, the service the phone app uses, on their way to Apple and Google. The title and text of each notification pass through them.
- Members' Pulse channels are fetched from the sites they link to.
- With a .beanpool.org tunnel, members' traffic passes through Cloudflare, as it does for any site that uses Cloudflare.
