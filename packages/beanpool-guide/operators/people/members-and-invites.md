---
slug: members-and-invites
title: Members and invites
summary: How people join, the invites you can make, where people stop in the join flow, and what each button on a member does, from Freeze to Offboard.
related: roles, reports-and-takedowns, decisions-and-emergencies, disputes, first-time-setup
---

## How people join

Nobody joins without an invite. An invite code looks like INV-XXXX-XXXX. It works once and expires **30 days** after it is made. The name an invite is made out to is only a label: the person picks their own name when they join.

Any member can make invites from their app, and most people will join that way. Each new member is recorded under the person who invited them, which is what the invite tree in Settings shows.

## Invites from Settings

Open **People & Safety**, then **Invites & QR**. Choose how many (1 to 100) and a starting trust badge, and print the QR cards or copy the links. A starting badge is a head start on trade standing, nothing more: badges gate nothing.

- Any owner or admin can make them, signed in either way: with the admin password (plus the two-factor code, if it's on), or from the app's Manage button. A moderator cannot.
- If the server refuses, Settings shows its reason and no code. Every code you see was issued by the server.
- In the community's invite tree, every invite made in Settings comes from the first member, Admin. The server also records which owner or admin made it (or "the admin password"), in its security log.

![The Invites and QR screen in Settings](images/people-invites.webp)

## Where people stop: the Onboarding Funnel

Open **People & Safety**, then **Onboarding Funnel**. It sits next to Invites & QR because it is what happens after an invite: it follows the people who joined over the last 7, 30 or 90 days, and shows how far those same people have got since.

![The Onboarding Funnel screen in Settings](images/people-funnel.webp)

**Counts only.** Nobody is named and nobody can be picked out of any of this. Your server keeps no per-person record of it, so there is none to show — and that is a deliberate choice, not a missing feature.

The screen has three parts, and they answer three different questions. Read each on its own.

**The people who joined.** One group of people, followed. **Joined** is everyone who joined in the window you picked, and is 100%. **Has a photo** and **Has posted** are how many of those same people have a profile photo now, and have ever listed something here. Because they are counted from the same people, these can never pass 100%. Somebody who joined before the window is not in the group, even if they posted inside it — the question is how the people who arrived are getting on, not how much happened this month.

**Steps inside the app.** Seeing the protection screen, choosing how to be protected, finishing the guide. These happen on a member's own phone, so their app tells your server about them. Your server does not record who reported what, so it **cannot tie these to the people above** — do not read them as a percentage of anything. Each is counted once per person, from the date the screen names. Older figures, from before apps counted this way, are left out and the screen says how many: back then an app counted every time a screen was drawn, so one person could be counted several times over, and there is no way to go back and work out which.

**Codes.** How many invite codes were entered, and why any were rejected. These are **attempts, not people**: one person trying a code three times is three attempts, which is why nothing above is worked out as a share of them. Already-a-member re-entries are named separately — that is somebody arriving twice, neither a rejection nor a signup. A run of **expired** codes usually means printed cards sat around too long: invites last 30 days.

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
- **Re-Key**: for someone who lost their phone and their 12 words. You get a code starting RK-, valid for **24 hours**. Their old key stops working the moment you make the code, and they are suspended until the code is used on their new phone. Their balance, role and keeper places move to the new key.
- **Offboard**: the careful way out. It refuses while they have beans held in a deal or open requests. Money they are owed goes to the commons or to a member you choose (choosing a member needs a sign-in from the app, not the password). A debt is written off against the commons. Then they are removed.
- **Prune Account**: removes them at once. Their balance goes to the commons, and the commons pays any debt. Their posts, role and Pulse items go. It does not check for deals in progress, so prefer Offboard. Their record stays in the database.
- **Prune Branch**: removes them and everyone they invited, and everyone those people invited. You type their name to confirm.

Only an owner can suspend an owner, or remove an owner or an admin. Nobody can remove the last owner.

## Things to know

- A Re-Key code that is never used leaves the person suspended in a way the Lift button cannot undo. Make a new Re-Key code instead.
- The trust score shown on a member's page is not calculated yet. Do not act on it.
- Suspended members can still make invites from their app.
