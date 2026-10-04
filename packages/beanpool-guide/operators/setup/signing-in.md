---
slug: signing-in
title: Signing in to Settings
summary: The two ways in: the app's Manage (or Moderate) button, or a computer signed in by scanning a code with the app. The admin password, on servers that still have one. How long a sign-in lasts.
related: access-and-security, roles, first-time-setup, rate-limits
---

There are two ways into Settings: the app's Manage button, and a computer you sign in by scanning a code with the app. Both sign in a named person with their own key. A new server has no admin password. A server set up before the claim code may still have one: see Servers that still have a password, below.

## Before the community has an owner

On a new server nobody can sign in with a key yet, so the sign-in page says **This community has no owner yet.** and shows how to claim it instead: on the server, run docker compose exec beanpool-node beanpool claim, then on your phone open BeanPool and choose **Claim a community**, or scan the QR code on the page. The QR code carries the server's address and the waiting code's short name, never the code. The page turns into the normal sign-in by itself a few seconds after the community has an owner, and shows the normal sign-in only when the first check fails (a later failure keeps the card). A server with an admin password keeps it below the claim, under **This server also has an admin password**. See First-time setup.

## Servers that still have a password

A new server has no admin password, so this section is only for a server set up before the claim code that still has one.


Go to your server's address followed by /settings and type the admin password. If two-factor sign-in is on, Settings then asks for the 6-digit code from your authenticator app. If it is off, the password opens only the card that sets it up: Settings does not open on the password alone, and nothing else in it opens until an authenticator is set up. Tools that send the password with every request are refused too until then: give them an automation token instead (Access & Security). The app's Manage button and a computer signed in by scanning a code are never asked for this: the phone's own lock is their second factor.

Its first password was the ADMIN_PASSWORD in .env on its first start. If that was empty, the server made one up and put it in a file, not in the log. Read it with: docker compose exec beanpool-node cat /data/first-admin-password.txt. Change it after you sign in; that deletes the file. See First-time setup.

- The password counts as an **owner**. Whoever has it can do everything an owner can.
- Anything done with the password is recorded as done by the password, not by a person. Other admins cannot tell who it was.
- Your browser keeps no copy of the password. The server checks it once and gives this browser a sign-in that only the server can read. It ends when you press **Log Out**, after **2 hours** without use, after **12 hours** at most, and when the server restarts. Changing the password, or turning two-factor sign-in on or off, ends every other password sign-in; the browser that made the change stays signed in. Then you type the password again.
- Everything in Settings works the same whether you came in with the password or with an owner's key. The one difference: changing the password always asks for the current password, even when you are signed in from the app. From the phone's Manage button, a change only an owner may make (resetting the server, the community's address, making or removing an owner) asks you to press Manage again if you unlocked the phone more than 5 minutes ago.

![The sign-in screen in node Settings](images/sign-in.webp)

## From the app's Manage button

Owners and admins see **Manage** followed by the community's name in the phone app's Settings; moderators see **Moderate** and the name, which opens their Reports screen. Pressing it:

- asks for the phone's own unlock (fingerprint, face or PIN). If the phone has no screen lock, the button refuses to open Settings;
- opens Settings in the browser, signed in as you, on the screen the app sent you to (for example a stuck deal under Escrow Disputes). On a phone, the **☰** menu at the top has every other screen: see Finding your way around Settings.

Settings opened this way can make a change that only an owner may make for **5 minutes** after your phone's unlock. That covers making, removing or demoting an owner; making or removing an admin; suspending an owner, or an owner or admin through a report; removing, offboarding or re-keying an owner or admin, your own re-key included; lifting a suspension, or halting a vote, that gives an owner or admin their role back; ending the waiting time early when an owner or admin is being removed; signing someone else out everywhere; break-glass mode; two-factor sign-in; the password; backups, including downloading a backup, a snapshot or an off-box backup; and every other owner-only setting. After that it says **Confirm it's you first**: press Manage in the app again, which asks for your phone's lock, and make the change there. Reading Settings is not asked, the off-box backups card included, with one exception: the RK- code of an owner's or admin's re-key that is still waiting to be used. It finishes that re-key, so after the 5 minutes the Re-Key window asks you to press Manage again, then **Show the code**. Nor is anything an admin may do asked, such as appointing a moderator or suspending a member, or signing yourself out everywhere. A computer signed in by scanning a code is not asked.

When you are done, **← App** at the top right (in full, **← Back to the BeanPool app**, at the top of the **☰** menu) takes you back to the app, and **View my profile** opens your own profile there.

## On a computer, with your phone

To use Settings on a computer's bigger screen without the password:

- First, on the computer, go to your server's address followed by /settings and choose **Sign in with your phone**. It shows a QR code, a 6-character code and a countdown. Use the same address the app uses (for example https://yourtown.beanpool.org/settings), not the server's address on your home network such as 192.168.1.20: the QR code carries whatever address is in the browser's address bar, and the phone refuses an address it does not know as a different community.
- Then, in the phone app, open **Settings** and tap **Manage this community from a computer**, next to Manage. A moderator's says **Moderate this community from a computer**, next to Moderate. Older apps say **Sign in on a computer**. Owners, admins and moderators only. Point the camera at the QR code.
- The phone asks **Did you just open Settings on a computer?** and says: if someone sent you this code, tap No. Below that it shows the 6-character code, your community, which browser asked (for example "Firefox on Windows"), how long ago it asked, the internet address the server saw it ask from, and how long the code has left. The server gives that address only to the app of an owner, admin or moderator, so someone who sees the QR code doesn't learn it. When the server sees the phone and the computer at the same internet address, it says **same network as this phone**. It never says so when it can't tell them apart: behind a reverse proxy that is not in TRUSTED_PROXIES, or when both reach the server from your local network. Check the code matches the one on the computer. If it doesn't, if the address is a stranger's, or if you did not just open Settings yourself, tap **No, that's not my computer**.
- Tap **Sign in**. The phone asks for its own unlock. The server's 6-digit code is not asked for: your phone's lock is your second factor.
- The phone then shows **two digits**: "On the computer, type 47". The computer asks for them. Type them there and press **Confirm**. Only then does the computer open Settings, signed in as you. Someone who sent you a QR code from their own computer never sees your phone, so even if you were talked into tapping Sign in, they would have to guess the two digits: three tries out of a hundred, then the code is used up. Never read the digits out or send them to anyone.

Good to know:

- A code lasts **2 minutes** and works once. The computer shows a new one by itself when it runs out, a few times, then waits for you to press **New code**.
- The code only signs in the browser that showed it. A photo of the QR code is no use on another computer.
- The app only accepts a code from its own community. A code from another server is refused, and the phone says which one it was.
- Five refused tries on one code (wrong key, no role in this community) use it up.
- The two digits last **30 seconds**. Three wrong tries on the computer, or too late, and nobody is signed in: get a new code.
- A phone with an older app shows no digits. It signs the computer in straight after the unlock, as before. Update the app to get the digits.
- Each approval is written to the server's log, with who approved it and which browser signed in. So is a code used up by wrong digits.
- Your key stays on the phone. This is not **Use your account on another device** (older apps: **Link Another Device**), which copies your own account to a browser to use BeanPool there as you.

## Whose sign-in it is

A sign-in from the app, or from a computer you signed in with the app, belongs to a person. Everything you do is recorded against your name. A moderator signs in the same two ways and gets Reports only (see Owners, admins and moderators).

A sign-in from the app (on the phone or on a computer) ends after **2 hours** without use, and after **12 hours** at most. It also ends when an owner changes or removes your role, and when the server restarts.

The web app shows a plain link to Settings, but it cannot sign you in with your key: a browser has no unlock of its own. Open Settings on the computer and sign in with your phone, as above, or use the password. Settings opened from the web app offers **← Back to BeanPool**, which returns you to the web app.

## If you are locked out

- Too many wrong passwords from one internet address make that address wait before it can try again. The right password from another network (mobile data, another wifi) works at once. The Manage button is not slowed down by wrong passwords, and asks for no two-factor code. A phone approving a computer's sign-in is counted with the passwords, though: it shares the limit of 15 sign-in attempts a minute from one internet address, so from the same wifi it may have to wait a minute too. See Rate limits.
- No owner can sign in any more (every owner's phone and 12 words are gone, and no second owner is left): first try the 12 words on a new phone, a second owner, or your break-glass code. If none of those is left, the fix is on the server: the person who should be owner must be a member (they join first if not), then run this in the server folder: docker compose exec beanpool-node beanpool recover --key @callsign (their callsign, or their public key in its place). It makes that member an owner and prints their break-glass code once; give it only to them. It changes nothing else: the community's name, the gateway settings, the money thresholds, two-factor sign-in, break-glass mode, the backup settings and the replication token all stay as they are. It is never silent: every member gets a critical notice that an owner was added from the server, and the log keeps a SECURITY line. Anyone who can run commands on the server can already read all of its data, so this gives nobody anything new. Running it again for the same person gives them a new break-glass code and the old one stops working.
- Forgot the password: owners and admins can still sign in from the app, on the phone or on a computer (if no owner can, use beanpool recover, above). Nobody can change the password without knowing the old one, and there is no way to a new one: deleting data/local-config.json does not give you one, because the server then starts as a new install, which has no admin password and ignores ADMIN_PASSWORD (and that file holds two-factor sign-in, the gateway and backup settings and more besides). Use beanpool recover, above, instead. Members, posts and beans are in data/state.db.
