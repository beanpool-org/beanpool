---
slug: members-and-invites
title: Members and invites
summary: How people join, who may invite (any member, or only admins), the invites you can make, where people stop in the join flow, and what each button on a member does, from Freeze to Offboard.
related: roles, reports-and-takedowns, decisions-and-emergencies, disputes, first-time-setup
---

## How people join

On a local community, nobody joins without an invite. An invite code looks like INV-XXXX-XXXX. It works once and expires **30 days** after it is made. One nobody used is then deleted, and leaves the member's Pending list. The name an invite is made out to is only a label: the person picks their own name when they join.

Any member can make invites from their app, unless you choose that only admins do (see Who may invite, below), and most people will join that way. Each new member is recorded under the person who invited them, which is what the invite tree in Settings shows.

Joining with a code is signed by the new member's own key, from the app or the web app they join in. So someone holding a code can only join as themselves: they can't use it to add a key that belongs to somebody else.

**On the global community it is the other way round: nobody joins with an invite.** Invites are switched off there. No member, admin or owner can make one, in the app or in Settings, and a code or a paper ticket made before is refused too. Everyone joins through the open door, with 12 secret words or a sign-in, and one sign-in account is one member (see Open door, below). Without that, one sign-in could make invites for hundreds of accounts that no sign-in stands behind. The app's **Invites** shows **Bring someone here** instead, with the community's link to share. Someone there who asks to join a local community is let in by that community, with its own invite.

**The key vault at the global community's door.** An app built with BeanPool's key vault can tie its sign-in at the door to a ticket from the vault, so that one sign-in both joins and keeps the member's sign-in copy at the vault. The door checks the ticket itself, with the vault's public keys, which go in the server's .env as BEANPOOL_VAULT_TICKET_KEYS: the same value the app is built with, newest key first, two at most. The server never contacts the vault and keeps nothing of the ticket. Give a standby the same line in its own .env: it is not copied. Without the line, or with one that isn't one or two keys of 64 characters (0–9 and a–f), the door takes no tickets. The log says so when the server starts, the door tells every app that asks, and an app then joins with the door's own sign-in check, as before. **On any other server, leave it empty:** your door, if it is open, needs nothing of BeanPool's.

## What the open door keeps

For each member who joined through the open door, your server keeps a small record beside their account:

- **How they came in**: 12 words, Google, Apple or Facebook. It sets which new-account limits they have (see A member's page, below), and adding a sign-in later changes it (below). The Onboarding Funnel counts joins by the way people first came in, which never changes.
- **For a sign-in, a scrambled reference to that sign-in account**: never its email, its name or the provider's id for it. It is made with a key kept in a file beside the database, data/open-join.key, never in the database. It is what makes one sign-in account one member, and what turns a removed member's sign-in away. **For 12 words there is nothing like it**: the person is only their key and the name they chose.
- **When they joined.** Their new-account limits are counted from it.
- **A scrambled reference to the internet connection they joined from**, for a day, never the address. It sets how much setting up a join from that connection asks, and the ceilings (see Rate limits). For a member you remove within a day of their joining it is kept for 7 days from the join (below), and never longer for someone who deleted their own account. A standby never copies it.
- **A random label shared by everyone who joined from one connection within a day of the first of them**: not the address, and not worked out from it. It makes their reports count as one, and shows you who joined together (see Reports and takedowns). It is cleared when a member who is not suspended or removed deletes their own account.

The setting up itself is not kept. The server checks it, and remembers only that it was used, until it runs out 10 minutes after it was handed out. The key it is checked with lives in memory: a restart, or a standby taking over, makes any setting up still in progress start again, which the apps do by themselves.

A standby copies these records (all but the connection's reference), and so does the take-over bundle, so a server that takes over still knows who joined which way. A 12-words join needs no door key: a server without data/open-join.key turns sign-ins away and still takes 12-words joins.

**Adding a sign-in later.** A member who joined with 12 words can add a sign-in from any phone or browser where they are in their account, not only the one they joined on: the app and the web page ask the server how the account joined, and offer it while the account has only its 12 words. They can't while they are suspended or once their account is closed. Their record then reads as that sign-in's, with the same join time, and they move to the usual new-account limits at once. The server refuses a sign-in account that is already another member's here, or that belonged to a member you removed, and nothing changes. Adding one needs data/open-join.key, as a sign-in join does.

## Who may invite

Open **People & Safety**, then **Invites & QR**. At the top, **Who may invite** says who can bring people into the community: make an invite, or answer someone who asks to join. Pick one and tap **Save who may invite**.

- **Invite: any member invites.** Every community starts this way. Any member can make an invite in the app or the web app, and answer a request to join.
- **Known: only admins invite.** Only owners and admins can make invites and answer requests to join. A member's **Invites** shows **Bring someone here** instead of the invite maker (the invite tree and the codes they made earlier stay), says that only the admins invite people here and to ask one, and offers the community's link where it takes requests to join. Members don't see the requests, and the server refuses a member who tries anyway. It is a role, not a trust badge. Owners and admins can also keep a names list of who the members are, in the app on their own phones: see "Running a known community".

Before you switch to Known, give at least one person the owner or admin role (People & Safety). Until someone holds it, the card warns you: nobody can answer a request to join, or make an invite in the app. You can still save it.

Only an owner can change it, signed in with the admin password or their own key. An admin sees the setting, and that it is an owner's to change. The server's log says who changed it.

When you switch to Known:

- **Invite codes already made**, by anyone, still work until they expire, 30 days after they were made. The server made them under the old rule, and knows when.
- **A paper ticket** (a long code starting BP-) **that a member made** on their phone no longer lets anyone in, whatever date it carries: the server first sees a ticket when someone joins with it, so it can't tell when it was really made. The join screen tells the person to ask an admin for a fresh invite. A ticket an owner or admin made still works. Switch back to Invite and a member's unused ticket works again.
- **Requests to join already waiting** stay waiting, for an admin to answer.

Switching back to Invite works straight away too: every member can invite again.

A standby server keeps the setting from the main server, and so does a standby that takes over. A backup carries it.

A community with Beans can't open its door to anyone with a sign-in: strangers would hold credit from their first day, so the server refuses it. On the global community, which has no Beans, the door is open and nobody invites; Settings shows **Open** there, with nothing to choose.

## Invites from Settings

Open **People & Safety**, then **Invites & QR**. Choose how many (1 to 100) and a starting trust badge, and print the QR cards or copy the links. A starting badge is a head start on trade standing, nothing more: badges gate nothing.

- Any owner or admin can make them, signed in either way: with the admin password (plus the two-factor code, if it's on), or from the app's Manage button, whoever may invite. A moderator cannot.
- If the server refuses, Settings shows its reason and no code. Every code you see was issued by the server. On the global community it always refuses: "This community doesn’t use invites".
- In the community's invite tree, every invite made in Settings comes from the first member, Admin. The server also records which owner or admin made it (or "the admin password"), in its security log.

![The Invites and QR screen in Settings](images/people-invites.webp)

## Where people stop: the Onboarding Funnel

Open **People & Safety**, then **Onboarding Funnel**. It sits next to Invites & QR because it is what happens after an invite: it follows the people who joined over the last 7, 30 or 90 days, and shows how far those same people have got since.

![The Onboarding Funnel screen in Settings](images/people-funnel.webp)

**Counts only.** Nobody is named and nobody can be picked out of any of this. Your server keeps no per-person record of it, so there is none to show — and that is a deliberate choice, not a missing feature.

The screen has four parts, and they answer four different questions. Read each on its own.

**The people who joined.** One group of people, followed. **Joined** is everyone who joined in the window you picked, and is 100%. **Has a photo** and **Has posted** are how many of those same people have a profile photo now, and have ever listed something here. Because they are counted from the same people, these can never pass 100%. Somebody who joined before the window is not in the group, even if they posted inside it — the question is how the people who arrived are getting on, not how much happened this month.

**Steps inside the app.** Seeing the protection screen, choosing how to be protected, finishing the guide. These happen on a member's own phone, so their app tells your server about them. Your server does not record who reported what, so it **cannot tie these to the people above** — do not read them as a percentage of anything. Each is counted once per person, from the date the screen names. Older figures, from before apps counted this way, are left out and the screen says how many: back then an app counted every time a screen was drawn, so one person could be counted several times over, and there is no way to go back and work out which.

**Codes.** How many invite codes were entered, and why any were rejected. These are **attempts, not people**: one person trying a code three times is three attempts, which is why nothing above is worked out as a share of them. Already-a-member re-entries are named separately — that is somebody arriving twice, neither a rejection nor a signup. A run of **expired** codes usually means printed cards sat around too long: invites last 30 days.

**Open door.** The open door lets someone join without an invite code: with 12 secret words alone, or by signing in with an account they already have, such as Google or Apple. It is open on the global community, with both ways in; on a local one it is normally shut, and the screen says which yours is. Before a join the person's phone does a moment of setting up, worked out on the phone itself; on a network where many people are joining at once it takes a little longer, instead of anyone being turned away. **Tried to join this way** counts attempts, like the codes. **Joined this way** counts people, by the way they came in (words, Google, Apple, Facebook), and every one of them is also in **Joined** at the top. Underneath is why anyone was turned away. The usual ones are **that sign-in already joined here** (one sign-in account is one member) and, only at rates no ordinary network reaches, **too many new accounts from one network** (500 an hour or 2,000 a day by 12 words from one address, with the sign-in way still open to them; 1,000 an hour or 5,000 a day by sign-in). A setting-up that didn't work out or took over ten minutes is counted too; the app starts it again by itself. On the global community you may also see a **key vault ticket** turned away, as expired, not signed by a key this server lists, and so on. A run of those usually means this server's clock is wrong, or its BEANPOOL_VAULT_TICKET_KEYS is not the vault's: the log says which. With the door shut, these stay at 0.

Owners and admins can open it, signed in either way. A moderator cannot, and does not see the tab.

## A member's page

Open **People & Safety**, then **Members**, and open a person.

![The Members directory in Settings](images/people-directory.webp)

![A member detail card in Settings](images/modal-member-detail.webp)

Owners and admins can:

- **Suspend**: stops them using the community now. You write a reason of at least 10 characters, which members can see. Members then vote for 7 days on keeping the suspension. If the vote does not pass, it lifts by itself. See Decisions and emergencies.
- **Lift suspension**: ends a suspension early and closes its vote.
- **Freeze** and **Unfreeze**: takes their credit line to zero, and stops them voting or proposing. It happens at once, with no confirmation.
- **Promote** and **Demote**: whether they can vouch for others.
- **Grant Operator**: lets them act for enterprises they are a keeper of.
- **Re-Key**: for someone who lost their phone and their 12 words. You get a code starting RK-, valid for **24 hours**. Their old key stops working the moment you make the code, and they are suspended until the code is used on their new phone. Their balance, role and keeper places move to the new key. See Re-Key below.
- **Offboard**: the careful way out. It refuses while they have beans held in a deal or open requests. Money they are owed goes to the commons or to a member you choose (choosing a member needs a sign-in from the app, not the password). A debt is written off against the commons. Then they are removed.
- **Prune Account**: removes them at once. Their balance goes to the commons, and the commons pays any debt. Their posts come down, and their role and Pulse items go. It does not check for deals in progress, so prefer Offboard. Their record stays in the database, and so do the words, photos and places of their posts.
- **Prune Branch**: removes them and everyone they invited, and everyone those people invited. You type their name to confirm.

Only an owner can suspend an owner, or remove an owner or an admin. Nobody can remove the last owner.

**Removing someone from a community with an open door is a speed bump, not a wall.** What it does:

- Their key is shut out for good: every request it signs is refused, and no door takes it back.
- The sign-in account they joined with, if any, can't join again, and can't be added to another account later.
- If they joined within a day, the scrambled reference to their connection is kept for 7 days from their join, and every 12-words join from that connection meanwhile asks for at least level 4 of setting up, where 5 is the most (see Rate limits). Their neighbours on that connection are asked for the same. A sign-in join from there is not slowed.

What it does not do:

- It doesn't stop the person coming back. Anyone can make a new account in about a minute with new 12 words, and someone removed with their Google account can come back that way too. There is no way to stop that without knowing who people are, which is what the 12-words door exists to avoid.
- For someone removed more than a day after joining, nothing about their connection is kept: the server had already cleared it.
- A standby that takes over has no connection references, so it remembers no removed connection.

So what protects the community is how little a new account can do. Someone who joined with 12 words has new-account limits for their first 7 days and until 3 of their posts have stayed up: 2 posts, 4 photos and 3 new people to message a day (someone who joined with a sign-in: 3, 5 and 10, for their first 3 days). One report from an established member hides their post until a moderator looks. Removing them again is one action, and a report shows who joined with them (see Reports and takedowns). Adding a sign-in puts them on the usual new-account limits.

A member who deletes their own account is not removed, and nothing about their connection is kept longer. If they were not suspended or removed at the time, the sign-in they joined with is freed and can join again; a suspended or removed member's stays turned away.

## Re-Key

Use Re-Key when someone has lost their phone and their 12 words, and you have checked in person that they are who they say. Someone who still has their 12 words doesn't need it: they restore them on the new phone.

Opening Re-Key changes nothing. It shows the checklist, or the code that is already waiting. Only **Make a re-key code** does something: from that moment their old key stops working, they are signed out everywhere, and they are suspended until the code is used on their new phone. The code starts RK- and lasts **24 hours**; the window shows how long it has left.

If they already moved to a new key, the window opens on **Already moved to** that key and the date. A new code would stop the phone they use now, so you type NEW CODE first. Do that only if the new phone is lost too.

**Cancel this code** undoes a code nobody has used: their key works again and they can sign in again, and they are back to what they were before the code (active, or still suspended if they were suspended already). Whoever may make the code may cancel it; for an owner or an admin, that is an owner. A code that was used or has run out can't be cancelled. A code made before this server kept the earlier status puts them back to active, and the window says so.

## Things to know

- A member can delete their own account in the app. That erases more than Prune Account: their profile, and the words, photos and places of all their posts, done or not, except their polls. A poll stays, closed, with its question and votes. The deals made on their posts still show, as "Deleted post".
- A Re-Key code that runs out unused leaves the person suspended in a way neither the Lift button nor Cancel this code undoes. Make a new Re-Key code, then cancel it if they don't need it: they are back to what they were before the first code.
- The trust score shown on a member's page is not calculated yet. Do not act on it.
- Suspended members can still make invites from their app, where any member invites.
- While suspended, a member sees what someone who has not joined sees: no one's contact details, not who voted in a Poll, not the activity feed, not how far away people are. They still get their own messages and deals. All of it comes back when the suspension lifts.
- Someone a member messages or sends beans to who has not joined is a visitor. They get those messages and beans, and see only what someone who has not joined sees. In those conversations they can reply, edit or delete what they wrote, and react. They keep the beans, and can pass them on once they join. They can take down a listing of their own, from before visitors were stopped from posting. They can't do anything else: they can't post, trade, join a group, go to an event, report, vote, invite anyone or answer a request to join. If they join with an invite from their own app, they become a member and keep their messages and beans.
