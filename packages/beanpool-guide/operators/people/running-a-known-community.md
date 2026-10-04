---
slug: running-a-known-community
title: Running a known community
summary: The names list and the known floor: your admins' list of who your members are by real name, sealed on admins' phones. Who can read it, what whoever runs your server can and can't do, its keys, confirming a member, the PDF copy, the access log, and what happens when an admin leaves or loses a phone.
related: members-and-invites, roles, what-the-server-sees, backups-and-replicas
---

## What the names list is

Some communities want their admins to know every member by name, the way a LETS committee keeps a membership list. The **names list** is that list, kept in the BeanPool app by your owners and admins. Each entry is a name and a short note ("Damo's neighbour, Left Bank Rd"). An admin can then **confirm** a member: this account is the person on that entry.

A confirmation is a fact about a member, not a trust badge. On its own it changes nothing. If your owner turns on **the known floor** (below), it also gives that member a credit line.

The global community keeps no names list. Nobody there is confirmed by name.

## Who can read the names, and what your server holds

Only your owners and admins can read the names, on their own phones. Each name is sealed on an admin's phone before it is sent. A backup, a snapshot, a standby's copy, a stolen database and BeanPool hold nothing readable.

What your server does keep in the clear: that an entry exists, which admin made or last changed it, and when; which member's account is confirmed against which entry, by which admin, and when (never the name); the list's key history (which admin made each key, and whom it left out); which admin's phone sent the keys to which, and which admins each one trusts; and the access log, below.

### Whoever runs your server

Whoever runs the server can change what it stores and what it tells each phone, and with the owner password can make any key an admin or move an account to a new key. The admins' phones don't take its word: a phone gives the list's keys only to a key its admin checked, on a call or in person, or that an admin it trusts checked, and takes a new key only from such a key. Whoever runs the server can stop the list from working, delete it, and see who opened it and when. On its own it can't read a name. It needs an admin to check the wrong phone's code, or an admin who was removed to work with it (below).

What this doesn't protect against: checking the wrong person's phone (your phone then trusts their key and sends them the names); an admin's phone someone else gets into; a lost phone before an admin removes its key; a PDF or a note an admin writes; and an admin's phone that whoever runs the server keeps from learning that an admin was removed: until it learns, what it writes can be read with the keys the removed admin had.

Every admin's phone learns of a removal when it opens the list, unless the server hides it. After an admin is removed, each admin looks at the admins their phone shows: a phone that still shows the removed admin taps Remove @X's old key. Whatever the server says, that phone then makes a new key without them or writes nothing. Two phones that show different list keys are being shown different things: add no names until they match, and tell your admins.

Members don't see the names. Showing real names to members, as some LETS directories do, isn't available yet.

## Before you start

The names list opens in the app, not in Settings: on an owner's or admin's phone, open **Settings**, then **Community admin**, then **Names list**. It needs an admin who signs in with their own key. The admin password opens no name, through the app or the server. It does let whoever holds it make admins and re-key accounts, which is why admins check each other's codes, on a call or in person.

Keep a paper copy, or a PDF, somewhere safe. If every admin who holds the list's keys loses their phone at once, that copy is how you type the list in again.

## Checking each other

Admins trust each other by checking each other's code. You don't need to meet. Open the names list on both phones and tap **Check an admin's code** (or **Check @name's code**). Each phone shows its own key as a QR code and 20 digits. On a call, read your 20 digits out and type in theirs; if you're together, scan each other's QR code instead. Do it only when you know it's the other admin you're talking to.

After that, your phone trusts their phone: it sends them the list's keys by itself, every time it has a key they lack, and takes new keys their phone makes. Every send is in the access log. Your phone also trusts the admins they checked, so not every admin has to check every other.

If you scan a phone whose key isn't the one the server lists for that admin, the app says so in red. Your phone trusts the key you scanned and sends nothing to the server's key. Either this isn't their phone, or the server has put their name on another key. Tell your other admins.

## The list's keys

- **The first admin to open the list** makes its first key, on their phone.
- **An admin you add later** sees that nobody they trust holds the keys yet. Make them an admin first, then check each other's code once, on a call or in person. Your phone sends them the keys at once, and every other admin's phone that trusts you sends its keys on its next open.
- When an admin stops being one, the next admin who holds the keys to open the list makes a new key without them, and their phone sends it to the other admins. Nothing written from then on by a phone that has taken the new key can be read with the keys the person had. What they already saw, they keep, as with a paper list.
- When an admin loses their phone, tell another admin the same day: they tap Remove @X's old key. Until that is done, whoever has the phone can read what is written. The admin's new phone's code is checked once, on a call or in person, and the keys are sent to it. Names written under a key that only the lost phone held can't be opened by anyone: the app counts them, and your paper copy is how they come back.
- **The 12 words alone aren't enough for an admin whose phone was lost** rather than broken: whoever has the lost phone has the same key. Remove the old key, have an owner move the account to a new key, and check the new phone's code once. Signing out, reinstalling the app or moving to a new phone after the old one broke keeps your names-list keys: the app keeps a locked copy on your server that only your account opens, so your 12 words open the names list again without a check. Whoever has your 12 words can open the names list as you: if your phone is lost, tell another admin the same day.
- **Nothing is sealed again when the key changes.** Each name stays sealed under the key it was written with, and every admin's phone keeps every key it takes for the key history it follows.

## When the app refuses

The app reads and writes nothing whenever it can't check what the server says, and tells you why:

- **A key made by someone no admin your phone trusts has checked.** Check codes with that admin, or with an admin whose phone already opens the list, on a call or in person. If your phone had removed that admin's key, checking their phone admits them again; checking another admin's phone doesn't, and your phone then makes a new key without them before it writes. Where nobody can be reached, a phone that has opened the list before can tap **Follow the server's history**: your phone takes the key for its place only, trusts nobody new, and, if it had removed an admin and the key that removed them isn't in the server's history, makes a new key without them before it writes.
- **The server offers an older key history than your phone has.** A server put back to an older copy does that, a standby that took over from an older copy too. Tap **Put the key history back**: your phone sends the history back to the server. Names written since that copy are gone from the server: the app says how many, and your paper copy is how they come back.
- **The server shows a key history your phone didn't take.** A standby that took over from an older copy, where an admin's phone then made a new key, does that; so does whoever runs the server changing the history. Ask your admins what happened. Tap **Follow the server's history**: your phone keeps the other history's keys, reads with them and passes them on to the admins it trusts, but never writes under them again unless the server's history comes back to them. An admin your phone had removed stays removed: unless the key that removed them on your phone is in the server's history, your phone makes a new key without them before it writes.
- **Part of the key history is missing on the server.** Ask whoever runs the server, or an admin.
- **Nobody who is an admin now holds the list's keys** (the only admins who held them lost their phones, say). The app offers to make a new key; it asks first and says how many names stay locked. Those names open again if an admin whose phone held the old key comes back and is checked again, or you type them again from your paper copy.
- **Two admins sent different keys for the same key number.** The app keeps the first and tells you. Tell your admins.

## Adding a name and confirming a member

- **Add a name**: the person's real name, and a note if it helps. A name and a short note only. Don't write an address, a date of birth or an ID number: the less the list holds, the less there is to lose.
- **Confirm a member**: open an entry, tap **Confirm a member**, and pick their account. One person, one entry: an entry can have one member confirmed against it, and a member can be confirmed against one entry. Confirm only someone you know is that person.
- An admin can't confirm themselves while the community has another admin. Ask another admin.
- **Revoke** takes a confirmation away. You can confirm them again later.
- **Two admins confirm each member**: an owner's setting at the bottom of the list, off to start with. When it is on, a confirmation waits until a second admin confirms it too: not the admin who made it, and not the member. Where nobody else could (an admin, in a community of two admins), one admin is enough.

When a member is removed, or deletes their account, their confirmation ends by itself. Their entry stays on the list until an admin deletes it.

## The known floor

In a LETS, a member the committee knows can go into debt by an agreed amount from day one. The **known floor** is that amount here. Your owner sets it in the manager: **People & Safety → Invites & QR → The known floor**.

- **The switch.** "Confirmed members get the known floor" is off in every community until an owner turns it on. While it is off, nobody's limit changes.
- **The known floor.** 1,000 Beans to start: about 25 hours of work the community is trusting each confirmed member for. 40 Beans is an hour.
- **The cap.** The most anyone here may owe, from every source together: the known floor, a vouch, and the trust they earn by trading. 2,000 Beans to start; an owner can raise it to 5,000. The known floor can't be more than the cap.
- **One offer.** A confirmed member can use their whole known floor while they keep at least one offer listed. With none, they can't go below zero on it. Trust they earn by trading still opens up in steps as they list more offers, as it does for everyone.
- **Who it applies to.** Only members with a confirmation from an admin. A confirmation waiting for a second admin doesn't count yet; one taken back stops counting at once.
- **Enterprises.** An enterprise counts half of each confirmed keeper's known floor towards its own.

### One member's known floor

An owner or admin can set one member's known floor: lower it (a smaller limit while someone is new), freeze it, or raise it, but never above the cap. Nobody sets their own.

**Lowering never takes Beans back.** A member already below their new limit keeps their balance. They can still receive and sell, and can spend again once they are back above it. The same happens to everyone in debt on the known floor if your owner turns the switch off.

### Everyone sees the changes

Every change to the switch, the known floor, the cap and any member's known floor is a line in the known floor's log: who made it, for whom, and from what to what. Every owner and admin can read it. A raise above the community's known floor is its own line, so other admins notice.

## Debts and a second chance

When a confirmed member leaves owing Beans, because the community removed them or they deleted their account, the Commons takes on their debt, as it always has. Your server also writes a **debt record** on their entry in the names list: how much, when they left, and whether it is open, settled or forgiven. The record names the entry, never the person: the name stays sealed on the admins' phones.

While a record is open, nobody can be confirmed against that entry. If the person comes back, a second chance is an admin's decision, made with the history in front of them. There are three ways to settle a debt, as in a LETS:

- **Paid back.** The person, on their new account, pays the amount to the Commons for that debt. An admin then checks that payment against the record, and it is settled. A payment made for another debt, or for none, settles nothing, and no payment settles two debts.
- **Worked off.** An admin confirms them with a known floor of 0 and a repayment flag. Once the confirmation counts (with a second admin's too, where your community asks for one), every Bean they receive above 0 goes to the Commons until the debt is cleared; then the flag lifts and the record is settled. The admin can raise their known floor after that. If an admin takes the confirmation back, the flag and the floor of 0 end with it: from then on they keep what they receive, and what they already repaid stays repaid.
- **Forgiven.** The community votes on a Decision to forgive it. The record stays, marked forgiven, and an admin can confirm them again.

**The rule binds the entry, not the person.** Your server can't read the names, so it can't tell when an admin adds a new entry for the same person and confirms them against that one instead. That rests on your admins' honesty; the access log shows who added and who confirmed each entry. The app doesn't yet warn an admin when a new entry's name matches one with an open debt.

Nothing already spent is ever taken back from anyone. A debt record is deleted 3 years after the member left, whatever its status.

## Community health

**Settings → People & Safety → Community health** shows the whole community's totals: Beans in circulation, the credit held and the debt owed, how many members are in debit, the Commons pot and this month's trades. Every owner and admin sees them; they are the community's, not any one member's.

In a known community, an admin's phone also shows the **exceptions**: confirmed members who agreed to it when they joined, and whose balance is past the debt line (50% of their credit line unless you choose another) or who have been in debit with no sale for 60 days (unless you choose another). Each shows with their name from the names list, their balance and their credit line, so an admin who knows them can have a word, the way a LETS committee always has. The phone also lists the open debts of members who left. The exceptions show nothing of anyone's trades. What every admin can see of trades, in any community and with no log, is: a trade that isn't finished yet or that an admin settled (both members, the listing, the price, and the messages in a chat the two of them share, which an admin can't read if it is a private chat), so that a stuck trade can be settled; how many trades each member has finished or cancelled, and what the finished ones came to; and fraud alerts that name members, with the Beans that moved, when they trade mostly with one member, within a small group, or with members they invited. The join screen tells every member exactly that. There is no export of balances: if you truly need every balance, you run the server and have the database, and so does that responsibility.

Only an owner moves the two lines, and every change shows in the known floor's log. The join screen tells every new member, in those numbers, what the admins can see, and their app records that they agreed. A member who joined before your community asked is offered it in their app; until they agree they never show. Changing the lines asks every member again; until a member agrees to the new ones, they show only within the lines they agreed to (a tighter line never reaches them without their say).

Every time anyone opens the exceptions, your server writes who and when, before it answers. Every owner and admin can read that log in Community health.

## The PDF copy

**Export as PDF** makes a PDF of every name your phone can open, on your phone, and offers to share or save it. The app asks first. The PDF leaves BeanPool's protection: it is yours to keep safe, like a paper list. The other admins can see that you exported it, and when.

## The access log

The bottom of the list shows who opened it, who exported it, who added, changed, deleted, confirmed or revoked anything, who made a new key and whom each phone sent the keys to, with the date, and when someone stopped holding the key. Every owner and admin sees it. The admins watching the list are watched too.

Your server writes the log itself, each time a phone fetches the list, so a phone can't leave out an opening. A phone changed to make a copy without saying so would still show, but as an ordinary opening rather than an export. The log is a record, not a lock.

## A standby, and a take-over

A standby server copies the names list as it is: sealed entries, the key history, the sealed keys the admins sent each other, and the log, nothing it can read. The list opens on your main server only, because opening it writes the log there. If a standby takes over, it serves the list to the same admins' phones, which open it as before. If the standby's copy was older than the main server's, the phones say how many names are missing; if the key history is older too, they say so and can put it back. If an admin's phone made a new key on the standby first, the other phones say the server shows a different key history and offer to follow it (see When the app refuses).

Whenever a phone opens the list and names it saw before are no longer there, and the log shows no admin deleting them, it says how many. A server put back to an older copy does that, and so does a standby that took over from one, whether or not a key changed in between. The missing names are sealed rows that may still be on the other copy: whoever runs the servers can copy them back, and the admins' phones still hold the keys they were written under, so they open again. Otherwise, the paper copy.

## Real names are personal data

A real name tied to an account is personal data in most countries. You, the community, are the ones keeping it, not BeanPool. Keep only what you need, tell members what you keep (the members' guide page "What the admins can see" explains it), let a member see and correct their entry, and delete an entry when it is no longer needed. This isn't legal advice: if your community is large, or run by a council or a business, ask someone who knows the law where you are.
