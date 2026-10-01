---
slug: running-a-known-community
title: Running a known community
summary: The names list: your admins' list of who your members are by real name, sealed on admins' phones. Who can read it, what whoever runs your server can and can't do, its key, confirming a member, the PDF copy, the access log, and what happens when an admin leaves.
related: members-and-invites, roles, what-the-server-sees, backups-and-replicas
---

## What the names list is

Some communities want their admins to know every member by name, the way a LETS committee keeps a membership list. The **names list** is that list, kept in the BeanPool app by your owners and admins. Each entry is a name and a short note ("Damo's neighbour, Left Bank Rd"). An admin can then **confirm** a member: this account is the person on that entry.

A confirmation is a fact about a member, not a trust badge, and for now it changes nothing else: no credit, no limits. Later versions will build on it.

The global community keeps no names list. Nobody there is confirmed by name.

## Who can read the names, and what your server holds

**Only your owners and admins can read the names, on their own phones.** Each name is sealed on an admin's phone before it is sent. Your community's server keeps scrambled text, and the list's key wrapped for each admin so that only that admin's phone can open it.

So these hold nothing readable:

- a backup, a snapshot, or a standby server's copy;
- anyone who steals the database;
- BeanPool. Nothing on the list ever reaches BeanPool.

What your server does keep in the clear: that an entry exists, which admin made or last changed it, and when; which member's account is confirmed against which entry, by which admin, and when (never the name); who signed each copy of the list's key; and the access log, below.

### Whoever runs your server

Whoever runs the server (the operator, or anyone with access to the machine) can change what it stores and what it tells the phones. With the owner password alone they can make any key an admin, and move any member's account to a new key: the re-key you use when someone loses their phone. So the admins' phones don't take the server's word for who gets the list's key, or who it comes from:

- Every key the list is sealed under is signed by the admin who made it, and every share of it is signed by the admin who gave it.
- Each admin's phone remembers which admins' phone keys it trusts for your community. It takes a new key only from an admin it trusts, or from one that an admin it trusts added with a signed share.
- **Sharing is checked in person.** The app offers **Share** only for an admin whose phone key your phone already trusts. For anyone else it shows **Check @name in person** instead. Meet them: they open the names list on their phone, which shows their phone's key as a QR code and a 20-digit code. You scan the QR code, or compare the code and type it in. Only if it matches the key the server lists for them does your phone trust that key and offer Share. The name on the screen comes from the server, which can put an admin's name on a key of its own. The check is what tells you.
- **When an admin's phone key changes** (they replace a lost phone, or someone moves their account to another key), each admin's phone that trusted them stops trusting the old key, trusts the new one only once checked, and says so: "@Ada's phone key changed: check it with @Ada in person before sharing."
- When the server offers a key that no admin the phone trusts made, the phone refuses it and says so. It reads nothing and seals nothing under that key, and changes nothing on the server.
- Each phone remembers the newest key it took, and which admins were dropped. If the server offers an older key (put back to an older copy, whose key an admin who has left may still hold), the phone refuses it. It can make a new key instead, numbered past the one it took.

What this doesn't protect against, plainly:

- **The first time a phone opens the list.** A new admin's phone, or one where the app was reinstalled, trusts the admin whose key it is given first. The app then shows that admin's code. Compare it in person with the code on their phone ("Your code"). If it doesn't match, add no names, and tell your other admins: the server gave this phone a key of its own.
- **A check made with the wrong person.** Checking in person is only as good as the people doing it. Scan or compare only with the admin in front of you. If you check someone who isn't that admin, your phone trusts their key.
- **A removed admin working with whoever runs the server.** A phone learns that an admin was removed from the signed new key made after they go, and remembers it. A server can hide that from a phone that never saw it (a new admin's, say), and the removed admin could then read what that phone adds.
- **An admin's own phone, a PDF an admin exports, and what an admin writes in a note.** Treat those like a paper list. Someone who gets into an admin's phone has the key.

Members don't see the names. Showing real names to members, as some LETS directories do, isn't available yet.

## Before you start

The names list opens in the app, not in Settings: on an owner's or admin's phone, open **Settings**, then **Community admin**, then **Names list**. It needs an admin who signs in with their own key. The admin password opens no name, through the app or the server. It does let whoever holds it make admins and re-key accounts, which is why sharing is checked in person.

Keep a paper copy, or a PDF, somewhere safe. If every admin who holds the list's key loses their phone at once, that copy is how you type the list in again.

## The list's key

- **The first admin to open the list** makes its key, on their phone.
- **An admin you add later** sees the list waiting, with their phone's key as a QR code and a code. An admin who already holds the key sees them waiting for the list's key. Meet them: tap **Check @name in person**, then scan their QR code or compare the code. When it matches, tap **Share**. The app asks first. Making someone an admin doesn't hand them the list: an admin who holds it has to check them and share it. The new admin's phone then trusts the admin who shared it, and shows that admin's code to compare.
- **If the app refuses the list's key**, it says who the key claims to come from and why. Ask an admin your phone trusts to open the list. Nothing was read or written under the refused key. If the key was made by an admin your phone never saw added (after the last key was lost), you can check them in person and then trust their key.
- **If the app says the server offers an older key** than your phone took, nothing was read or written under it. You can make a new key on your phone; then share it as above.
- **When someone stops being an admin** (their role is taken away or changed to moderator, they are suspended or removed, they delete their account, or they replace a lost phone with a new key), the server stops giving them the list at once. If they held the list's key, nothing more can be written until the list has a new key. The next time an admin who holds the key opens the list, their phone makes a new one and seals every entry again under it. The other admins then show as waiting. That admin taps **Share** for each admin their phone already trusts, and checks anyone else in person first: a new admin, or an admin whose phone key changed. The person who left keeps whatever they already saw, as with a paper list, but can't read anything written after.
- **When someone replaces a lost phone**, the owner moves their account to the new phone's key. Every admin's phone then says their phone key changed. Check the new phone in person before sharing the list with it.
- **If nobody who is an admin now holds the key** (the only admins who did have left or lost their phones), any admin can **start a new key**. The entries written before can't be opened by anyone here any more. They stay, marked locked, until an admin types each one again from your paper copy, or deletes it.

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

The bottom of the list shows who opened it, who exported it, and who added, changed, deleted, confirmed or revoked anything, with the date, and when someone stopped holding the key. Every owner and admin sees it. The admins watching the list are watched too.

Your server writes the log itself, each time a phone fetches the list, so a phone can't leave out an opening. A phone changed to make a copy without saying so would still show, but as an ordinary opening rather than an export. The log is a record, not a lock.

## A standby, and a take-over

A standby server copies the names list as it is: sealed entries, the admins' keys and the log, nothing it can read. The list opens on your main server only, because opening it writes the log there. If a standby takes over, it serves the list to the same admins' phones, which open it as before.

## Real names are personal data

A real name tied to an account is personal data in most countries. You, the community, are the ones keeping it, not BeanPool. Keep only what you need, tell members what you keep (the members' guide page "What the admins can see" explains it), let a member see and correct their entry, and delete an entry when it is no longer needed. This isn't legal advice: if your community is large, or run by a council or a business, ask someone who knows the law where you are.
