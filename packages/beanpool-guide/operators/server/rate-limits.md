---
slug: rate-limits
title: Rate limits
summary: The limits that protect your server, what members see when they hit one, and what you can change.
related: troubleshooting, address-and-peers, signing-in, updates-and-health
---

When someone goes over a limit the server answers "too many requests" (HTTP 429) and says how long to wait. The counts are kept in memory, so a restart clears them all.

## The limits

- **The gateway**: 120 requests a minute. A signed-in member has their own allowance; requests from someone not signed in share one allowance per internet address. Change the number, or switch it off, under Appliance and Data, then Gateway and Peers. Community and federation traffic, and Settings itself, are not counted.
- **Sign-in and recovery attempts**: 15 a minute per internet address. This covers the admin password, recovering an account, pairing a device and checking names.
- **Settings**: 300 requests a minute per internet address.
- **Group and event chats**: 30 lines a minute per member.
- **Checking an invite code** before joining: 30 a minute per internet address.
- **Reports**: 10 an hour per member.

## The admin password brake

This one is for the whole server, not per address. The first 10 wrong admin passwords cost nothing. After that, password sign-in closes for 2 seconds, then 4, 8 and so on, up to 10 minutes. While it is closed, even the right password is refused. It opens again after a right password, or after 30 minutes with no wrong ones. Signing in from the app's Manage button is not affected.

If it keeps closing, someone is guessing your password. Sign in from the app meanwhile, and make sure the password is long and not used anywhere else.

## Many people on one connection

A school, a village hall's wifi or a mobile network can put many people behind one internet address. Signed-in members each get their own gateway allowance, but sign-in and recovery attempts are counted per address, so a crowd all joining at once can hit the 15-a-minute limit. Ask them to wait a minute and try again.

If your server sits behind a proxy on another machine, list that proxy in TRUSTED_PROXIES in .env. Otherwise every member looks like the proxy's address and shares one allowance.

## Finding out which limit

The message says which: "Gateway rate limit exceeded", "Too many attempts", "You're sending messages too fast", or "Too many wrong admin passwords". The gateway and the password brake also write a line in the logs.
