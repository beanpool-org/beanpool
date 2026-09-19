---
slug: members-and-invites
title: Members and invites
summary: How people join, the invites you can make, and what each button on a member does, from Freeze to Offboard.
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
