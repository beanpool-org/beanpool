---
slug: pulse-and-announcements
title: Pulse and announcements
summary: Telling every member something at once, the channels in the Pulse, the daily learning item, and taking a Pulse item down.
related: reports-and-takedowns, what-the-server-sees, updates-and-health, the-settings-screens
---

These are under **Bulletin and News**.

## Announcements

An announcement goes to every member at once: to anyone with the app open, and as a notification to every phone. It is not kept anywhere, so someone who has notifications off will not see it later. Keep it short and use it rarely.

## The Pulse

The Pulse shows what members share from their own channels (videos, feeds and so on), plus the Learn videos. Anyone can see the Pulse feed, even without joining, so it is part of your community's public face.

- Members add their own channels, and can hide or delete their own items.
- The server checks each channel every **5 minutes** and keeps the newest **20** items from each.
- Pictures are fetched by your server, so members' phones do not contact other sites to show them.
- An item stops showing when its owner is suspended or removed.

Under **Pulse Channels** you can add or remove channels that belong to the community rather than to a member. The built-in BeanPool Learn channel cannot be removed.

## Taking a Pulse item down

There is no button to hide an item directly. A member reports it; then, under People and Safety, then Triage and Moderation, press **Remove from the Pulse**. See Reports and takedowns.

## The daily learning item

Every day at 05:00, server time, the server adds a short learning item to the Pulse. While your market has fewer than two real listings it also posts a free example offer, and takes it down once there are two. Server time is UTC unless you give the server a TZ setting. To switch it off, use DAILY_PULSE=false (below).

## Switches

docker-compose.yml passes only the settings it lists to the server. The TikTok and Instagram keys are listed, so they go in .env. The others are not listed: add each one as a line under **environment:** in docker-compose.yml, then run docker compose up -d.

- **DAILY_PULSE=false** stops the daily learning item and the example offer.
- **PULSE_SCHEDULER=0** stops the server checking members' channels.
- **TZ**, for example TZ=Africa/Nairobi, sets the server's clock for the 05:00 item.
- TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET are the app keys that let members sign in to TikTok and Instagram to add those channels. You get them from those companies' developer sites.
