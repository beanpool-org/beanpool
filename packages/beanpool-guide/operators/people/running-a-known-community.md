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

Whoever runs the server (the operator, or anyone with access to the machine) can change what it stores and what it tells the phones. They can also make any key an admin: the owner password reaches that. So the admins' phones don't take the server's word for who may give them the list's key:

- Every key the list is sealed under is signed by the admin who made it, and every share of it is signed by the admin who gave it.
- Each admin's phone remembers which admins it trusts for your community. It takes a new key only from an admin it trusts, or from one that an admin it trusts added with a signed share.
- When the server offers a key that no admin the phone trusts made, the phone refuses it and says so. It reads nothing and seals nothing under that key, and changes nothing on the server.

What this doesn't protect against, plainly:

- **The first time a phone opens the list.** A new admin's phone, or one where the app was reinstalled, trusts the admin whose key it is given first. A server changed by whoever runs it could hand a new admin's phone a key of its own first, and would then read what that admin adds; the other admins' phones refuse that key. When the app says it now trusts someone, check that it's the admin who shared the list with you.
- **Sharing.** Making someone an admin doesn't give them the list, but an admin tapping **Share** does. Share only with people you know are your admins.
- **Trusting by hand.** If the app refuses a new key from an admin it doesn't know, it offers to trust them anyway. Do that only when that admin told you themselves that they made the list a new key.
- **A removed admin working with whoever runs the server.** The phones learn that an admin was removed from the signed new key made after they go. A server can hide that, and the removed admin could then keep reading.
- **An admin's own phone, a PDF an admin exports, and what an admin writes in a note.** Treat those like a paper list.

Members don't see the names. Showing real names to members, as some LETS directories do, isn't available yet.

## Before you start

The names list opens in the app, not in Settings: on an owner's or admin's phone, open **Settings**, then **Community admin**, then **Names list**. It needs an admin who signs in with their own key. An owner who only uses the admin password runs the server but can't read the list.

Keep a paper copy, or a PDF, somewhere safe. If every admin who holds the list's key loses their phone at once, that copy is how you type the list in again.

## The list's key

- **The first admin to open the list** makes its key, on their phone.
- **An admin you add later** sees the list waiting. An admin who already holds the key sees "waiting for the list's key" for them and taps **Share** to give it to them. The app asks first. Your server never decides who reads the names: making someone an admin doesn't hand them the list until an admin who holds it chooses to share it. The new admin's phone then trusts the admin who shared it, and says so.
- **If the app refuses the list's key**, it says who the key claims to come from and why. Ask an admin your phone trusts to open the list. Nothing was read or written under the refused key.
- **When someone stops being an admin** (their role is taken away or changed to moderator, they are suspended or removed, they delete their account, or they replace a lost phone with a new key), the server stops giving them the list at once. If they held the list's key, nothing more can be written until the list has a new key. The next time an admin who holds the key opens the list, their phone makes a new one and seals every entry again under it. The other admins then show as waiting, and that admin shares the new key with each of them, a tap each. The person who left keeps whatever they already saw, as with a paper list, but can't read anything written after.
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
