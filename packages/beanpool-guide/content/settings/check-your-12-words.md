---
slug: check-your-12-words
title: Your 12 words and the server's keys (owners)
summary: For a community's owners. Checking your 12 words, taking over or restoring the server with your phone, and the check your phone makes by itself.
related: your-12-words, recovery
---

## Who this is for

Only a community's **owners**. If you are not an owner, you won't see any of this.

## Why owners are asked

Your community's server keeps a locked copy of its keys, for moving the community to another server if its own is lost, and its backups are locked too. They are locked to the owners' accounts: any one owner can open them with their phone (see Taking over or restoring with your phone, below). If you lose your phone, your 12 words bring your account back, and with it your key to the server's lock and its backups. That matters most on the day the server itself is gone.

So the app asks each owner, now and then, to check they still have the right 12 words. You can say **Later**. Nothing is ever blocked, and you can keep doing everything an owner does.

## When the app asks

- Once, soon after you become an owner.
- Again 12 months after your last check.

It shows a card at the top of the Market (in the web app, at the top of every screen but the Map): **Check now** or **Later**. **Later** puts the card away until the next time it is due. You can check any time from **Settings**: under **Community keys**, tap **Check your 12 words** (in the web app, **Check now**).

## How to check

- Get your paper with the 12 words.
- Type them in order, with spaces between them. Capitals and extra spaces don't matter.
- Tap **Check my words**.

If they are right, the app says **These are the right words**. If not: **These aren't the words for this account.** It doesn't say which word is wrong, so check the paper and type them all again.

Can't find them? If this phone still has them, **Settings**, then **View Recovery Phrase**, shows them. Write them down again, then check.

## What is sent, and what is not

- The check happens on your phone (or in your browser, in the web app). Your words are never sent anywhere and never saved. The box is emptied as soon as the check answers, and when you leave the screen.
- When the words are right, your phone tells your community's server only that you checked, and when, signed with your account.
- Owners and admins see, in the server's Settings, each owner's "12 words checked" date, or "not yet". It is your own statement: the server cannot see or check your words.

## Taking over or restoring with your phone

If your community's server is lost, whoever runs its standby server (or a new server restoring a backup) can ask an owner to open the locked keys. Any one owner is enough. You need the newest version of the BeanPool app. The web app works too if it still opens, but it lives at your community's own address, which may be down with the server: the phone app is the one to count on.

- On the server's Settings, they choose **Take over with an owner's phone**, or **Open with an owner's phone** when restoring a backup. A code appears on their screen.
- In the app: **Settings**, under **Community keys**, tap **Take over or restore with this phone**, and point the camera at the code. If the server's page is open on your own phone, tapping its link does the same. In the web app, copy the link from their screen and paste it under **Take over or restore with this browser** in **Settings**.
- The app shows which community, which server, and what will happen. If your main server still answers, it says so in red: a take-over is only for a server that is really gone.
- Tap **Unlock for the take-over** (or **Unlock the backup**). Your phone asks for its own unlock first: fingerprint, face or PIN. The web app has no such step, which is why the phone app is the safer place for an owner's key.
- Your phone opens its own part of the lock and hands the key to that server, locked so only that server can read it. Your phone never sees the server's keys or the backup.
- On a take-over, the person at the server then confirms on their screen. The community is told it moved, and that you opened the keys.

The app refuses, and says why, if the lock belongs to another community, if it is not locked to you, if the server's code has run out (it lasts 10 minutes and works once), or if the keys were not locked by your community's own server.

## Your phone checks the lock by itself

Each time your community's lock changes (an owner is added or removed, a new recovery code is made), your app checks, quietly, that it could still open its part. It opens it, throws the key away at once, and tells the server whether it worked. Nothing is asked of you.

Owners and admins see it in the server's Settings, next to your 12 words date: **their phone opened the current lock**, with the date, or that it last opened an older one. If it says your phone **could NOT open** the lock, check your 12 words, and ask another owner to look at the server's Settings.
