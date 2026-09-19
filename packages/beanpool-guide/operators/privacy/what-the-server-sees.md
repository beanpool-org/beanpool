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

Anyone with the server's files can read these, and so can anyone with a backup:

- members' names, profiles, posts, photos, deals, balances and every trade;
- **group chats, event chats and enterprise chats**: these are not encrypted;
- who messaged whom, and when, even for direct messages;
- **how each member voted**.

## Secret ballots

Votes on Decisions are secret in the apps and in Settings: everyone sees only the totals, and each member sees their own vote. But the database records each member's vote, to count it and to stop anyone voting twice.

So every owner and admin can read how each member voted: all of them can download a backup from Settings, and whoever runs the machine can copy the files. Tell your members this plainly. Keep backups encrypted, and let only people the community trusts hold them.

## Who can read what over the internet

- Reading anything private needs a member's signature. This is on by default. The setting is ENFORCE_READ_AUTH, and only the exact value false turns it off. Leave it on.
- Some things are public on purpose: the market's list of posts, the Pulse, the community's health summary, profile pictures and post photos.
- The live-updates channel, which carries changes as they happen, is open to anyone who can reach your server unless ENFORCE_WS_AUTH=true. Before you switch it on, check with the BeanPool project that the apps your members use sign their connection, or they stop getting live updates.

## What admins see in Settings

- The logs, with passwords, keys and 12-word phrases removed before they are written.
- The list of devices connected right now, with their internet address, device type and member name.
- Reports, and the people they are about.

## What your server sends elsewhere

- The BeanPool directory, every 12 hours: your community's name, area, member count and contact details (see Address, identity and peers). Switch it off under Node Identity.
- GitHub, every 6 hours, to ask for the newest version; and the app stores' pages, to learn the newest app versions.
- Push notifications go through Expo, the service the phone app uses, on their way to Apple and Google. The title and text of each notification pass through them.
- Members' Pulse channels are fetched from the sites they link to.
- With a .beanpool.org tunnel, members' traffic passes through Cloudflare, as it does for any site that uses Cloudflare.
