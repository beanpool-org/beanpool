---
slug: roles
title: Owners, admins and moderators
summary: What each role can do, what only owners can do, and why a community can never lose its last owner.
related: members-and-invites, signing-in, decisions-and-emergencies, access-and-security
---

A role is about running the server. It has nothing to do with trust badges, which are merit badges and gate nothing. Each member holds at most one role. Give roles to people the community knows, and keep at least two owners so one lost phone cannot lock everyone out.

## Owner

Owners can do everything in Settings. Only owners can:

- give or take away any role, including admin and moderator;
- remove or offboard an owner or an admin;
- suspend an owner;
- lift a suspension, or give back a role that a suspension took away;
- end the waiting time early when an owner or admin is being removed;
- sign other people out of Settings;
- switch break-glass mode on or off, and be issued a break-glass code.

The **admin password** counts as an owner. Anyone who knows it can do all of the above.

## Admin

Admins sign in from the app's Manage button and can do the day-to-day work: members and invites, reports and takedowns, disputes, Decisions, enterprises, the Pulse, backups and diagnostics. They cannot give or take away roles, and they cannot act against an owner.

## Moderator

Moderators look after reports, and nothing else. They sign in from the app's **Moderate** button (or on a computer, by scanning the code with the app) and see one screen, **Reports**, where they can:

- read every report, filtered by open, handled or dismissed, with what the post says and who reported it;
- take down the reported post while its report is still open, with a reason the author reads;
- take a reported Pulse item off the Pulse;
- dismiss a report, or mark it handled.

That is all. A moderator cannot suspend or freeze anyone, see members' details or the member list, touch money, invites, backups, keys or the server's settings, or change anyone's role. They never get the admin password, and signing in as a moderator never gives more than this: the server refuses a moderator everything else, whatever page they try. The manual they see holds only the pages about their work.

A moderator whose role is taken away, or changed, is signed out straight away.

If the server's two-factor sign-in is on (see Access and security), a moderator's key sign-in also asks for the server's 6-digit code, exactly as an admin's does, so they need it from whoever keeps the authenticator. The server has one set of backup codes, not one per person: a backup code a moderator uses is spent, and nobody can use it again. The code on its own opens nothing; it only works alongside a key that holds a role.

## Owners & admins

**People & Safety**, then **Owners & admins**, lists everyone who holds a role, what it is and who gave it.

- Owners, signed in with their key or with the admin password, see the list and can add and remove people.
- Admins, signed in with their key, see the list but cannot change it.
- Moderators never see this list: their Settings is Reports only. Ordinary members cannot open Settings at all.

![The Owners and Admins screen in Settings](images/people-roles.webp)

Owners and admins open Settings from the BeanPool app with their own key: **Settings**, then **🛡️ Manage** and the community's name. Moderators see **🛡️ Moderate** and the community's name instead. The app shows the button only to people the server says hold one of these roles.

## Adding someone

- Under **Add someone**, type part of their callsign, or paste their full public key. Typing the first six or more characters of a key also finds them.
- Every member who matches is listed, with a count above the list. A long list scrolls inside its own box. Callsigns that start with what you typed come first, then ones that contain it; among those, the most recently active come first. Each row shows the short form of the member's key, so two people with the same name can be told apart. If nobody matches, it says "No one matches".
- Pick them, then choose **Owner**, **Admin** or **Moderator**.
- **Continue** shows what they will be able to do, in plain words. Nothing changes until you press the **Yes, make …** button.

Giving a new role replaces the old one.

## Removing someone

Press **Remove** on their row. You are asked once more before anything happens. Removing an owner, admin or moderator takes away their access to Settings straight away; removing yourself signs you out.

You can also do both from a member's own page: **People & Safety**, then **Members**, open the person and choose **👑 Grant Owner**, **⚡ Grant Admin**, **🛡️ Grant Moderator**, or **Revoke** to take the role away.

## When the server says no

The server checks every change. If it refuses, the screen shows its reason word for word after "Not done. The node said:". The usual ones:

- "Only an owner may grant the admin role" (or "revoke"): you are signed in as an admin. Ask an owner.
- "Only an owner may grant the owner role": once a community has an owner, only an owner can add another.
- "Cannot remove the last owner": add another owner first, then remove this one.
- "Only active accounts can hold a node role": the member is suspended. Suspending or removing someone takes their role away. If the community's vote overturns a suspension the role comes back by itself; otherwise add them again once they are active.
- "Member not found": the pasted key is not a member of this community.
- "Treasury accounts cannot hold a node role": an enterprise's account is not a person.

## The last owner

A community always keeps at least one active owner. Settings refuses to:

- revoke or demote the last owner;
- remove, suspend or offboard the last owner, whether by hand or by a Decision.

To hand over, first give owner to the new person, then step down yourself.

## A community with no owner

A server with no owner, which is a brand-new one before its first invite, or one whose data has no founding member, shows "This community has no owner yet — add yourself" under **Owners & admins**. While that is true the server lets whoever is signed in make the first owner. Do it straight away.

- Signed in with the admin password: press **Find myself**, search for your own callsign, choose **Owner** and confirm. After that, **Manage** appears in your app.
- Signed in with your key (you are an admin, but the server has no owner): press **Make me the owner** and confirm.

## The first owner, Admin

The first time you make an invite on an empty server, it creates a member called **Admin** as the first owner (see First-time setup). Nobody holds its key, so it cannot sign in or do anything. If you take its owner role away, the server gives it back at the next restart. It is harmless, and it means the community is never without an owner while you set up.
