---
slug: rate-limits
title: Rate limits
summary: The limits that protect your server, what members see when they hit one, and what you can change.
related: troubleshooting, address-and-peers, signing-in, updates-and-health
---

When someone goes over a limit the server answers "too many requests" (HTTP 429) and says how long to wait. The per-minute counts and the day's changes are kept in memory, so a restart clears them. What one member can make in a day is counted from what they have made, and the money limits from a record the server keeps for a day, so a restart does not clear those.

## The limits

- **The gateway**: 120 requests a minute. A signed-in member has their own allowance; requests from someone not signed in share one allowance per internet address. Change the number, or switch it off, under Appliance & Data, then Gateway & Peers. On the global community, where anyone may join, everyone who is not a member yet, joiners included, shares 600 a minute per internet address. Settings itself is not counted here (it has its own limit, below). The two public reads other servers make (/api/community/info and /api/community/health) do not use this allowance either: each internet address has a separate one for them, five times the gateway number (600 a minute at the default). A member's own requests are counted wherever they go, buying from another community included.
- **Sign-in and recovery attempts**: 15 a minute per internet address, counted separately for each kind: pairing a device; checking a name and looking up an account to recover (one count, as both tell whether a name is taken); restoring with a sign-in; knocking; and the admin password. The admin password, its 2FA codes and a phone approving a computer's sign-in share one count, so someone guessing the password gets no more tries by using several of them. Pairing several phones on one wifi no longer uses up the name check.
- **The open door**, where it is open: 20 requests a minute from each new account's key, and 600 a minute per internet address, for joining and for checking a name while joining. It does not turn a busy network away: it asks each new account there for a little more setting up instead, and refuses a join only past ceilings no ordinary network reaches. See The open door's numbers, below.
- **New sign-in codes** (Sign in with your phone, on the Settings sign-in page): 10 a minute per internet address, and at most 200 waiting on the whole server.
- **Settings**: 300 requests a minute per internet address.
- **Chats**: 30 lines a minute per member, in direct messages as well as group and event chats and an enterprise's discussion.
- **Checking an invite code** before joining: 30 a minute per internet address.
- **Reports**: 10 an hour per member.

![Gateway switches and rate limits under Gateway & Peers](images/appliance-gateway.webp)

## The open door's numbers

On a community whose door is open (the global community), a 12-words join asks the person's phone or browser for a moment of setting-up work. It runs while they type their name, so at ordinary times nobody waits. The work has levels from 0 to 5, and each level doubles it. In tests on a phone emulator, levels 0 to 2 took under a second, level 3 about 3 to 6 seconds and level 5 about 6 to 26 seconds; an old phone takes longer, and none has been measured yet. From level 3 the app tells the person about how long it will take on their phone, with the sign-in way beside it. A sign-in join asks no work at all until a connection is very busy. The work never decides who gets in: anyone with a computer can do it quickly. It turns a crowd's wait into seconds instead of a refusal, and makes a flood of joins cost whoever makes them.

How the level is set:

- **A 12-words join**: how many of the connection's steps it has reached, plus how many of the community's, at most 5. From a connection where a newcomer joined in the last 7 days and was removed within a day of joining (see Members and invites), at least removedNetworkLevel.
- **A sign-in join**: no work before the connection's signInWorkFrom-th join in the hour. From there, the connection's steps less signInDiscount, never below 0.

The numbers, by name, with their defaults:

- **networkSteps**, 10,30,100,200: the joins from one connection in the last hour, both ways in and this one included, at which each of the connection's steps starts.
- **nodeSteps**, 500,2000,5000: the 12-words joins on the whole community in the last 10 minutes, this one included, at which each of the community's steps starts. Counted in memory, so a restart starts it again at 0.
- **signInWorkFrom**, 30: the join from one connection in an hour from which a sign-in join asks for any work.
- **signInDiscount**, 2: how many steps less a sign-in join asks for.
- **removedNetworkLevel**, 4: the least a 12-words join asks for from a connection where a newcomer joined in the last 7 days and was removed within a day of joining.
- **wordsPerHour**, 500, and **wordsPerDay**, 2000: past these many 12-words accounts from one connection, a 12-words join from it is refused, with how long to wait. The sign-in way stays open there.
- **signInPerHour**, 1000, and **signInPerDay**, 5000: the same for sign-ins. Each way counts only its own joins.

A busy day: once DOOR_BUSY_NEW_MEMBERS_PER_DAY people have joined through the open door (both ways in) in the last 24 hours, every 12-words join asks for at least level 3, until the count falls below 90% of that number. The default is 300; set it in .env and restart the server, or set it to 0 to switch it off. Nobody is turned away for it: people just wait a little longer for the setting-up work, and the sign-in way is unchanged. A connection's or the community's own steps can still ask for more. The log says when it starts and when it ends, with the count and no names, and your alerts tell you when it starts (the push to your phone at most once a day).

To change one, add a row to the server's node_config named doorNumbers. and the name, with a whole number; for networkSteps and nodeSteps, the same number of rising whole numbers, separated by commas. For example, to let up to 1,000 12-words accounts an hour come from one connection, run on the server: docker compose exec -u node beanpool-node node -e "require('better-sqlite3')('/data/state.db').prepare(\"INSERT INTO node_config (key, value) VALUES ('doorNumbers.wordsPerHour', '1000') ON CONFLICT(key) DO UPDATE SET value = excluded.value\").run()"

The server reads them at each join, so there is nothing to restart. To go back to the default, delete the row: docker compose exec -u node beanpool-node node -e "require('better-sqlite3')('/data/state.db').prepare(\"DELETE FROM node_config WHERE key = 'doorNumbers.wordsPerHour'\").run()"

A value that isn't right (not a whole number, a list of the wrong length or not rising, a name that isn't one of these) is ignored and the default kept, and the log says so once. There is no Settings screen for them. The rows are this server's own: a standby does not copy them and a take-over does not carry them, so after a take-over the door runs on the defaults until you add them again.

## What one member can make in a day

These stop one account filling your server, and its standby copies, with rows. Each is set well above what the busiest real member does, and a day means any 24 hours. They are the same on every server and Settings can't change them (they are in the server's code, config/writer-limits.ts, in one place).

- **Changes**: 5,000 a day per member (posts, messages, edits and the like), even with the gateway switched off. Settings is not counted, and neither is marking a chat read or a notice seen: the apps do that on their own while a chat is open, and it adds nothing to your server. What a keeper does for an enterprise counts against the enterprise's own 50,000, not the keeper's, and against a second 50,000 for everything that keeper does for all the enterprises they keep. Once the enterprise's 50,000 are used up, a keeper's further changes for it count against their own 5,000 instead, and not the second 50,000: so one keeper who uses up an enterprise's day can only stop themselves, and every other keeper keeps their own 5,000 for it. Running the enterprise (taking on, removing or replacing keepers, stepping down, pausing, resuming, winding up, and completing or turning down its deals) always counts against the keeper's own 5,000. Its lead can remove a keeper who misuses it (the removal waits out the usual 3-day objection window; you can remove a keeper at once in Settings).
- **Posts**: 100 new ones a day of their own. What they put up for an enterprise they keep counts against the enterprise, 1,000 a day, and against 1,000 a day for all the enterprises they keep together. Once the enterprise's 1,000 are up, what they put up for it counts against their own 100 instead.
- **Friends**: 100 people added a day, counting anyone added and removed again.
- **Groups**: 5 new ones a day. **Enterprises**: 3 new ones a day, and 20 of theirs still running.
- **Invites**: 20 a day, and 50 that nobody has used yet. An offline ticket counts when someone joins with it. Invites made in Settings don't count. An invite nobody used is deleted 30 days after it was made, when it has stopped working.
- **New people**: conversations with 20 people from outside the community a day. A new account on the global community is held to 3 posts, 5 photos and 10 new people a day, until it is 3 days old and 3 of its posts have stayed up. One made with 12 words and no sign-in is held to 2 posts, 4 photos and 3 new people a day, for 7 days and until 3 of its posts have stayed up. They are told "While your account is new you can …".
- **The Pulse**: 50 links added by hand a day, and 300 items synced from connected accounts (the rest come with a later sync). Your server also collects new items from members' websites, blogs, YouTube and SoundCloud channels itself: 400 a day per member, all their channels together. Past that, the rest wait until the next day.
- **A message's words**: a direct message up to about 48 KB of words (64 KB as stored); a line in a group, event or enterprise chat up to 2,000 characters. Photos are attachments and don't count.
- **Photos**: 100 MB of photo bytes stored a day per member across chat attachments, listing photos, avatars and group pictures (`PHOTO_BYTES_PER_MEMBER_PER_DAY`, default 100 MB; 0 = off). Refused with "You've shared a lot of photos today. Try again tomorrow." (HTTP 429). For the disk image store, a free-disk floor of 2048 MB (`PHOTO_MIN_FREE_DISK_MB`, default 2048 MB) refuses every photo upload below it with "This community's storage is nearly full. Tell its owner." (HTTP 507). Owners and admins are not exempt.
- **Looking up people nearby**: on the global community, a member can ask for the people nearest a place 100 times a day. A restart starts the count again. A local community has no such limit.

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

Signing in from the app's Manage button never goes through the brake. The two-factor code asked for when switching it off or moving it does, even when you are signed in from the app. A break-glass code is checked only when adding an admin key, even from an address that is waiting (at most once every 10 seconds from one address); anywhere else it counts as a wrong password.

Signing in with Manage, and approving a computer's sign-in from the phone, ask for no two-factor code: the phone's own lock is the second factor. A computer's sign-in code lasts 2 minutes. It is cancelled after 5 refused approvals or 3 wrong tries at the two digits.

If it keeps happening, someone is guessing your password. The logs name the address by a code, such as ip#k3Jx9QaB7d, never the address itself: the same code means the same address, until the code changes: at the next day (UTC), or when the server restarts. Sign in from the app meanwhile, and make sure the password is long and not used anywhere else.

## Many people on one connection

A school, a village hall's wifi or a mobile network can put many people behind one internet address. Signed-in members each get their own gateway allowance, but sign-in and recovery attempts are counted per address, each kind separately, so a crowd all checking names or pairing at once can hit the 15-a-minute limit for that one thing. Ask them to wait a minute and try again. Joining through the open door has its own limits instead (see The open door's numbers): there, a crowd is asked for a little more setting up, not turned away by the join limits. A very large crowd on one address can still meet the open door's own 600 requests a minute per address, or the gateway's allowance for people who are not members yet (on the global community, 600 a minute per address), and both answer with a refusal.

If your server sits behind a proxy on another machine, list that proxy in TRUSTED_PROXIES in .env. Otherwise everyone looks like the proxy's address, so everything counted per address (people not signed in, sign-in and recovery attempts, Settings, the password brake) is one shared allowance. Signed-in members still keep their own. For the password brake that means everyone is one address, so a few wrong passwords from anyone make everyone wait, for up to 10 minutes. The log says so and names TRUSTED_PROXIES, with the proxy's code rather than its address. Add your proxy's address there and restart the server; the restart also clears the brake.

## Finding out which limit

The message says which:

- "Gateway rate limit exceeded": the gateway.
- "Too many attempts": sign-in and recovery attempts, checking invite codes, or the open door's 600 requests a minute from one address.
- "A very large number of 12-words accounts were made from your network", or "Too many new accounts have joined from your network": the open door's ceilings, for 12 words and for sign-ins.
- "Too many administrative requests": Settings, 300 a minute.
- "You're sending messages too fast": chats, direct messages included.
- "You have made 5,000 changes today": the member's changes for the day. "You have made 50,000 changes today for the enterprises you keep": one keeper's, for all their enterprises.
- "You can put up 100 new posts", "You can start 5 groups", "You can start 3 enterprises", "You have started 20 enterprises", "You can make 20 invites", "You have 50 invites nobody has used yet", "You can add 50 links to the Pulse", "You can start conversations with 20 people": what one member can make in a day. "… for the enterprises you keep, all of them together": one keeper's posts, payments, new people or deals for all their enterprises.
- "You can make 100 payments", "You can pay 30 people you have never paid before", "You can ask for, accept or approve 100 deals", "You can make or change 20 pledges": payments and deals.
- One of the member's own messages above, then "… has reached its own limit for today, so what you do for it counts against yours": the member's own limit, reached doing something for an enterprise that had used up its own. An enterprise's own limits never refuse anything themselves: past them, its keepers' own limits count.
- "This message is too long to send" (HTTP 413): a direct message's words. "Message is too long (maximum 2000 characters)": a line in a group, event or enterprise chat.
- "You can add 100 people": friends added in a day.
- "You have looked up the people near a place 100 times today": people nearby, on the global community.
- "Too many new codes" or "Too many sign-ins waiting on this node right now": new sign-in codes for a computer.
- "While your account is new you can …": a new account's limits on the global community.
- "You have sent a lot of reports recently": reports, 10 an hour.
- "You've shared a lot of photos today. Try again tomorrow.": photo upload day budget exceeded (HTTP 429).
- "This community's storage is nearly full. Tell its owner.": free-disk floor reached on the disk image store (HTTP 507).
- "Too many wrong admin passwords from your network", or "This node is getting a lot of wrong admin passwords from elsewhere": the password brake.

The gateway, the day's changes and the password brake also write a line in the logs.
