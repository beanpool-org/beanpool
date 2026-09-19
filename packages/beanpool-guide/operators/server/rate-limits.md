---
slug: rate-limits
title: Rate limits
summary: The limits that protect your server, what members see when they hit one, and what you can change.
related: troubleshooting, address-and-peers, signing-in, updates-and-health
---

When someone goes over a limit the server answers "too many requests" (HTTP 429) and says how long to wait. The counts are kept in memory, so a restart clears them all.

## The limits

- **The gateway**: 120 requests a minute. A signed-in member has their own allowance; requests from someone not signed in share one allowance per internet address. Change the number, or switch it off, under Appliance & Data, then Gateway & Peers. Community and federation traffic, and Settings itself, are not counted.
- **Sign-in and recovery attempts**: 15 a minute per internet address. This covers the admin password, recovering an account, pairing a device and checking names.
- **Settings**: 300 requests a minute per internet address.
- **Group and event chats**: 30 lines a minute per member.
- **Checking an invite code** before joining: 30 a minute per internet address.
- **Reports**: 10 an hour per member.

## The admin password brake

This one slows down anyone guessing the admin password, without ever letting them lock you out.

- It counts wrong passwords per internet address. The first 5 from an address cost nothing. After that, that address has to wait before its next try: 2 seconds, then 4, 8 and so on, up to an hour. Only that address waits; nobody else is slowed down by it.
- A right password from the address clears its count. So does a day with no wrong password from it.
- An address with no wrong password in the last day is always checked straight away, whatever anyone else is doing. So if you are kept waiting, try from another network (mobile data, another wifi) and the right password works at once.
- Addresses that have got it wrong recently share a limit for the whole server of 12 checks a minute, and those already waiting get only half of it, so an owner who mistyped once is not queued behind a guesser. Over that limit the server says to try again within a minute.
- Many wrong passwords from one neighbourhood of addresses (the same /24, or the same IPv6 /48) take away the "straight away" promise for the rest of that neighbourhood.

Signing in from the app's Manage button never goes through the brake, and neither does a break-glass code.

If it keeps happening, someone is guessing your password. The logs say which address. Sign in from the app meanwhile, and make sure the password is long and not used anywhere else.

## Many people on one connection

A school, a village hall's wifi or a mobile network can put many people behind one internet address. Signed-in members each get their own gateway allowance, but sign-in and recovery attempts are counted per address, so a crowd all joining at once can hit the 15-a-minute limit. Ask them to wait a minute and try again.

If your server sits behind a proxy on another machine, list that proxy in TRUSTED_PROXIES in .env. Otherwise every member looks like the proxy's address and shares one allowance.

## Finding out which limit

The message says which:

- "Gateway rate limit exceeded": the gateway.
- "Too many attempts": sign-in and recovery attempts, or checking invite codes.
- "Too many administrative requests": Settings, 300 a minute.
- "You're sending messages too fast": group and event chats.
- "You have sent a lot of reports recently": reports, 10 an hour.
- "Too many wrong admin passwords from your network", or "This node is getting a lot of wrong admin passwords from elsewhere": the password brake.

The gateway and the password brake also write a line in the logs.
