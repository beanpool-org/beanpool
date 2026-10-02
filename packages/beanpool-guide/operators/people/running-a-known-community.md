---
slug: running-a-known-community
title: Running a known community
summary: The names list: your admins' list of who your members are by real name, sealed on admins' phones. Who can read it, what whoever runs your server can and can't do, its keys, confirming a member, the PDF copy, the access log, and what happens when an admin leaves or loses a phone.
related: members-and-invites, roles, what-the-server-sees, backups-and-replicas
---

## What the names list is

Some communities want their admins to know every member by name, the way a LETS committee keeps a membership list. The **names list** is that list, kept in the BeanPool app by your owners and admins. Each entry is a name and a short note ("Damo's neighbour, Left Bank Rd"). An admin can then **confirm** a member: this account is the person on that entry.

A confirmation is a fact about a member, not a trust badge, and for now it changes nothing else: no credit, no limits. Later versions will build on it.

The global community keeps no names list. Nobody there is confirmed by name.

## Who can read the names, and what your server holds

Only your owners and admins can read the names, on their own phones. Each name is sealed on an admin's phone before it is sent. A backup, a snapshot, a standby's copy, a stolen database and BeanPool hold nothing readable.

What your server does keep in the clear: that an entry exists, which admin made or last changed it, and when; which member's account is confirmed against which entry, by which admin, and when (never the name); the list's key history (which admin made each key, and whom it left out); which admin's phone sent the keys to which, and which admins each one trusts; and the access log, below.

### Whoever runs your server

Whoever runs the server can change what it stores and what it tells each phone, and with the owner password can make any key an admin or move an account to a new key. The admins' phones don't take its word: a phone gives the list's keys only to a key its admin checked in person, or that an admin it trusts checked, and takes a new key only from such a key. Whoever runs the server can stop the list from working, delete it, and see who opened it and when. On its own it can't read a name. It needs an admin to check the wrong phone in person, or an admin who was removed to work with it (below).

What this doesn't protect against: checking the wrong person's phone (your phone then trusts their key and sends them the names); an admin's phone someone else gets into; a lost phone before an admin removes its key; a PDF or a note an admin writes; and an admin's phone that whoever runs the server keeps from learning that an admin was removed: until it learns, what it writes can be read with the keys the removed admin had.

Every admin's phone learns of a removal when it opens the list, unless the server hides it. After an admin is removed, each admin looks at the admins their phone shows: a phone that still shows the removed admin taps Remove @X's old key. Whatever the server says, that phone then makes a new key without them or writes nothing. Two phones that show different list keys are being shown different things: add no names until they match, and tell your admins.

Members don't see the names. Showing real names to members, as some LETS directories do, isn't available yet.

## Before you start

The names list opens in the app, not in Settings: on an owner's or admin's phone, open **Settings**, then **Community admin**, then **Names list**. It needs an admin who signs in with their own key. The admin password opens no name, through the app or the server. It does let whoever holds it make admins and re-key accounts, which is why admins check each other's phones in person.

Keep a paper copy, or a PDF, somewhere safe. If every admin who holds the list's keys loses their phone at once, that copy is how you type the list in again.

## Checking each other

Admins trust each other by meeting. Open the names list on both phones and tap **Check each other** (or **Check @name in person**). Each phone shows its own key as a QR code and 20 digits. Scan each other's code, or compare the digits and type them in. Do it only with the other admin in front of you.

After that, your phone trusts their phone: it sends them the list's keys by itself, every time it has a key they lack, and takes new keys their phone makes. Every send is in the access log. Your phone also trusts the admins they checked, so not every admin has to meet every other.

If you scan a phone whose key isn't the one the server lists for that admin, the app says so in red. Your phone trusts the key you scanned and sends nothing to the server's key. Either this isn't their phone, or the server has put their name on another key. Tell your other admins.

## The list's keys

- **The first admin to open the list** makes its first key, on their phone.
- **An admin you add later** sees that nobody they trust holds the keys yet. Make them an admin first, then meet and check each other once. Your phone sends them the keys at once, and every other admin's phone that trusts you sends its keys on its next open.
- When an admin stops being one, the next admin who holds the keys to open the list makes a new key without them, and their phone sends it to the other admins. Nothing written from then on by a phone that has taken the new key can be read with the keys the person had. What they already saw, they keep, as with a paper list.
- When an admin loses their phone, tell another admin the same day: they tap Remove @X's old key. Until that is done, whoever has the phone can read what is written. The admin's new phone is checked in person once, and the keys are sent to it. Names written under a key that only the lost phone held can't be opened by anyone: the app counts them, and your paper copy is how they come back.
- **The 12 words alone aren't enough for an admin whose phone was lost** rather than broken: whoever has the lost phone has the same key. Remove the old key, have an owner move the account to a new key, and check the new phone in person once. An admin who restores the same 12 words on a new phone after the old one broke only needs the check in person.
- **Nothing is sealed again when the key changes.** Each name stays sealed under the key it was written with, and every admin's phone holds every key it was sent.

## When the app refuses

The app reads and writes nothing whenever it can't check what the server says, and tells you why:

- **A key made by someone no admin your phone trusts has checked.** Meet that admin, or an admin whose phone already opens the list, and check each other's phones. If your phone had removed that admin's key, checking their phone admits them again; checking another admin's phone doesn't, and your phone then makes a new key without them before it writes. Where nobody can be reached, tap **Follow the server's history**: your phone takes the key for its place only, trusts nobody new, and before it writes makes a new key without any admin it had removed.
- **The server offers an older key history than your phone has.** A server put back to an older copy does that, a standby that took over from an older copy too. Tap **Put the key history back**: your phone sends the history back to the server. Names written since that copy are gone from the server: the app says how many, and your paper copy is how they come back.
- **The server shows a key history your phone didn't take.** A standby that took over from an older copy, where an admin's phone then made a new key, does that; so does whoever runs the server changing the history. Ask your admins what happened. Tap **Follow the server's history**: your phone keeps the other history's keys, reads with them and passes them on to the admins it trusts, but never writes under them again unless the server's history comes back to them. An admin your phone had removed stays removed: before it writes, it makes a new key without them.
- **Part of the key history is missing on the server.** Ask whoever runs the server, or an admin.
- **Nobody who is an admin now holds the list's keys** (the only admins who held them lost their phones, say). The app offers to make a new key; it asks first and says how many names stay locked. Those names open again if an admin whose phone held the old key comes back and is checked in person, or you type them again from your paper copy.
- **Two admins sent different keys for the same key number.** The app keeps the first and tells you. Tell your admins.

## Adding a name and confirming a member

- **Add a name**: the person's real name, and a note if it helps. A name and a short note only. Don't write an address, a date of birth or an ID number: the less the list holds, the less there is to lose.
- **Confirm a member**: open an entry, tap **Confirm a member**, and pick their account. One person, one entry: an entry can have one member confirmed against it, and a member can be confirmed against one entry. Confirm only someone you know is that person.
- An admin can't confirm themselves while the community has another admin. Ask another admin.
- **Revoke** takes a confirmation away. You can confirm them again later.
- **Two admins confirm each member**: an owner's setting at the bottom of the list, off to start with. When it is on, a confirmation waits until a second admin confirms it too: not the admin who made it, and not the member. Where nobody else could (an admin, in a community of two admins), one admin is enough.

When a member is removed, or deletes their account, their confirmation ends by itself. Their entry stays on the list until an admin deletes it.

## The PDF copy

**Export as PDF** makes a PDF of every name your phone can open, on your phone, and offers to share or save it. The app asks first. The PDF leaves BeanPool's protection: it is yours to keep safe, like a paper list. The other admins can see that you exported it, and when.

## The access log

The bottom of the list shows who opened it, who exported it, who added, changed, deleted, confirmed or revoked anything, who made a new key and whom each phone sent the keys to, with the date, and when someone stopped holding the key. Every owner and admin sees it. The admins watching the list are watched too.

Your server writes the log itself, each time a phone fetches the list, so a phone can't leave out an opening. A phone changed to make a copy without saying so would still show, but as an ordinary opening rather than an export. The log is a record, not a lock.

## A standby, and a take-over

A standby server copies the names list as it is: sealed entries, the key history, the sealed keys the admins sent each other, and the log, nothing it can read. The list opens on your main server only, because opening it writes the log there. If a standby takes over, it serves the list to the same admins' phones, which open it as before. If the standby's copy was older than the main server's, the phones say how many names are missing; if the key history is older too, they say so and can put it back. If an admin's phone made a new key on the standby first, the other phones say the server shows a different key history and offer to follow it (see When the app refuses).

Whenever a phone opens the list and names it saw before are no longer there, with no admin having deleted them, it says how many. A server put back to an older copy does that, and so does a standby that took over from one, whether or not a key changed in between. The missing names are sealed rows that may still be on the other copy: whoever runs the servers can copy them back, and the admins' phones still hold the keys they were written under, so they open again. Otherwise, the paper copy.

## Real names are personal data

A real name tied to an account is personal data in most countries. You, the community, are the ones keeping it, not BeanPool. Keep only what you need, tell members what you keep (the members' guide page "What the admins can see" explains it), let a member see and correct their entry, and delete an entry when it is no longer needed. This isn't legal advice: if your community is large, or run by a council or a business, ask someone who knows the law where you are.
