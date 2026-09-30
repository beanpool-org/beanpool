---
slug: rate-limits
title: Rate limits
summary: The limits that protect your server, what members see when they hit one, and what you can change.
related: troubleshooting, address-and-peers, signing-in, updates-and-health
---

When someone goes over a limit the server answers "too many requests" (HTTP 429) and says how long to wait. The per-minute counts and the day's changes are kept in memory, so a restart clears them. What one member can make in a day is counted from what they have made, and the money limits from a record the server keeps for a day, so a restart does not clear those.

## The limits

- **The gateway**: 120 requests a minute. A signed-in member has their own allowance; requests from someone not signed in share one allowance per internet address. Change the number, or switch it off, under Appliance & Data, then Gateway & Peers. Settings itself is not counted, and neither are the two public reads other servers make (/api/community/info and /api/community/health). A member's own requests are counted wherever they go, buying from another community included.
- **Sign-in and recovery attempts**: 15 a minute per internet address. This covers the admin password, recovering an account, pairing a device, checking names and a phone approving a computer's sign-in.
- **New sign-in codes** (Sign in with your phone, on the Settings sign-in page): 10 a minute per internet address, and at most 200 waiting on the whole server.
- **Settings**: 300 requests a minute per internet address.
- **Chats**: 30 lines a minute per member, in direct messages as well as group and event chats and an enterprise's discussion.
- **Checking an invite code** before joining: 30 a minute per internet address.
- **Reports**: 10 an hour per member.

![Gateway switches and rate limits under Gateway & Peers](images/appliance-gateway.webp)

## What one member can make in a day

These stop one account filling your server, and its standby copies, with rows. Each is set well above what the busiest real member does, and a day means any 24 hours. They are the same on every server and Settings can't change them (they are in the server's code, config/writer-limits.ts, in one place).

- **Changes**: 5,000 a day per member (posts, messages, edits and the like), even with the gateway switched off. Settings is not counted, and neither is marking a chat read or a notice seen: the apps do that on their own while a chat is open, and it adds nothing to your server. What a keeper does for an enterprise counts against the enterprise's own 50,000, not the keeper's, and against a second 50,000 for everything that keeper does for all the enterprises they keep. Once the enterprise's 50,000 are used up, a keeper's further changes for it count against their own 5,000 instead, and not the second 50,000: so one keeper who uses up an enterprise's day can only stop themselves, and every other keeper keeps their own 5,000 for it. Running the enterprise (taking on, removing or replacing keepers, stepping down, pausing, resuming, winding up, and completing or turning down its deals) always counts against the keeper's own 5,000. Its lead can remove a keeper who misuses it (the removal waits out the usual 3-day objection window; you can remove a keeper at once in Settings).
- **Posts**: 100 new ones a day of their own. What they put up for an enterprise they keep counts against the enterprise, 1,000 a day, and against 1,000 a day for all the enterprises they keep together. Once the enterprise's 1,000 are up, what they put up for it counts against their own 100 instead.
- **Groups**: 5 new ones a day. **Enterprises**: 3 new ones a day, and 20 of theirs still running.
- **Invites**: 20 a day, and 50 that nobody has used yet. An offline ticket counts when someone joins with it. Invites made in Settings don't count. An invite nobody used is deleted 30 days after it was made, when it has stopped working.
- **New people**: conversations with 20 people from outside the community a day. A new account on the global community is held to 10 new people for its first days.
- **The Pulse**: 50 links added by hand a day, and 300 items synced from connected accounts (the rest come with a later sync). Your server also collects new items from members' websites, blogs, YouTube and SoundCloud channels itself: 400 a day per member, all their channels together. Past that, the rest wait until the next day.
- **A message's words**: up to 64 KB. Photos are attachments and don't count.

## Payments and deals

These stop one account, or a stolen phone, spraying Beans or flooding your ledger. A member's are the first number, an enterprise's or project's the second: ten times as many, counted against the enterprise whichever keeper acts, not against the keeper's own. Once an enterprise has used up one of them for the day, a keeper's further payments, new people or deals for it count against the keeper's own numbers instead (a payment to someone new to the enterprise does so once its new people are used up). Like the limits above they are in config/writer-limits.ts (MONEY_LIMITS), and Settings can't change them. Receiving is never limited, and neither are releasing held beans, cancelling a deal, or Settings' own tools.

- **Payments**: 100 a day, 1,000 for an enterprise. A send, buying an Offer, asking to buy one, approving help on your own Need, an enterprise's payments and sweeps to the Commons, a pledge of beans, and buying or commissioning from another community all count.
- **New people paid**: 30 a day, 300 for an enterprise: people the account has never paid before. Paying someone it has paid before is not counted.
- **Deals**: 100 a day asked for, accepted or approved, 1,000 approved for an enterprise.
- **Pledges**: 20 a day made, changed or released, a keeper's backing and a crowdfund pledge alike, and asking to become a keeper with a pledge. Pledges are a member's act, so an enterprise has no number of its own.

What a keeper does for an enterprise also counts against what they do for all the enterprises they keep together, at the enterprise's numbers: 50,000 changes, 1,000 posts, 1,000 payments, 300 new people and 1,000 deals a day, on top of their own limits. Any member can start 3 enterprises a day, so without this one person could multiply their day by starting enterprises. An enterprise with several keepers still gets all of its own limits, as each keeper's share counts to their own. What a keeper does for an enterprise past its own limits counts against their own limits, not this. So one person does at most one enterprise's worth a day for their enterprises, and their own limits beside it, however many they keep. There is no smallest payment: a sweep of a fraction of a bean is a payment, and these limits bound how many there can be.

## The admin password brake

This one slows down anyone guessing the admin password, without ever letting them lock you out.

- It counts wrong passwords per internet address. The first 5 from an address cost nothing. After that, that address has to wait before its next try: 2 seconds, then 4, 8 and so on, up to an hour. Only that address waits; nobody else is slowed down by it.
- A wrong two-factor code counts as a wrong password too: after the right password, and when switching two-factor sign-in off or moving it to a new authenticator, however you are signed in.
- A right password from the address (with its two-factor code, if that is on) clears its count, and so does a right code in either of those places. So does a day with no wrong password from it. Being signed in already does not clear it, but while you are signed in with the right password your requests don't use the shared limit below: one mistyped code never slows down your own dashboard.
- An address with no wrong password in the last day is always checked straight away, whatever anyone else is doing. So if you are kept waiting, try from another network (mobile data, another wifi) and the right password works at once.
- Addresses that have got it wrong recently share a limit for the whole server of 12 checks a minute. If you mistyped once or twice, and your neighbourhood of addresses (the same /24, or the same IPv6 /48) has had at most 3 wrong passwords today, a check is kept for you while the server is busy with someone else's guesses. You usually get in on your next try, within a minute.
- Someone guessing from many networks can stretch that wait. Each network they use can take the kept check away 2 times on their first day, and up to 4 times a day if they primed it the day before. So against N networks you wait about 1 + 2N to 1 + 4N minutes.
- Someone on your own /24 or /48 can take the kept check away with 3 wrong passwords. Then, and after three or more mistypes of your own, nothing is kept for you. The way out is another network, or signing in from the app.
- Many wrong passwords (20 in a day) from one neighbourhood of addresses take away the "straight away" promise for the rest of that neighbourhood.

Signing in from the app's Manage button never goes through the brake, and neither does a break-glass code. The two-factor code asked for when switching it off or moving it does, even when you are signed in from the app.

If it keeps happening, someone is guessing your password. The logs name the address by a code, such as ip#k3Jx9QaB7d, never the address itself: the same code means the same address, until the code changes the next day. Sign in from the app meanwhile, and make sure the password is long and not used anywhere else.

## Many people on one connection

A school, a village hall's wifi or a mobile network can put many people behind one internet address. Signed-in members each get their own gateway allowance, but sign-in and recovery attempts are counted per address, so a crowd all joining at once can hit the 15-a-minute limit. Ask them to wait a minute and try again.

If your server sits behind a proxy on another machine, list that proxy in TRUSTED_PROXIES in .env. Otherwise every member looks like the proxy's address and shares one allowance. That goes for the password brake too: everyone is one address, so a few wrong passwords from anyone make everyone wait, for up to 10 minutes. The log says so and names TRUSTED_PROXIES, with the proxy's code rather than its address. Add your proxy's address there and restart the server; the restart also clears the brake.

## Finding out which limit

The message says which:

- "Gateway rate limit exceeded": the gateway.
- "Too many attempts": sign-in and recovery attempts, or checking invite codes.
- "Too many administrative requests": Settings, 300 a minute.
- "You're sending messages too fast": chats, direct messages included.
- "You have made 5,000 changes today": the member's changes for the day. "You have made 50,000 changes today for the enterprises you keep": one keeper's, for all their enterprises.
- "You can put up 100 new posts", "You can start 5 groups", "You can start 3 enterprises", "You have started 20 enterprises", "You can make 20 invites", "You have 50 invites nobody has used yet", "You can add 50 links to the Pulse", "You can start conversations with 20 people": what one member can make in a day. "… for the enterprises you keep, all of them together": one keeper's posts, payments, new people or deals for all their enterprises.
- "You can make 100 payments", "You can pay 30 people you have never paid before", "You can ask for, accept or approve 100 deals", "You can make or change 20 pledges": payments and deals.
- One of the member's own messages above, then "… has reached its own limit for today, so what you do for it counts against yours": the member's own limit, reached doing something for an enterprise that had used up its own. An enterprise's own limits never refuse anything themselves: past them, its keepers' own limits count.
- "This message is too long to send" (HTTP 413): a message's words.
- "You have sent a lot of reports recently": reports, 10 an hour.
- "Too many wrong admin passwords from your network", or "This node is getting a lot of wrong admin passwords from elsewhere": the password brake.

The gateway, the day's changes and the password brake also write a line in the logs.
