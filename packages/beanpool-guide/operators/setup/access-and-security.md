---
slug: access-and-security
title: Access and security
summary: Changing the admin password, two-factor sign-in, break-glass codes, and the factory reset. Under Appliance & Data, then Access & Security.
related: signing-in, roles, first-time-setup, rate-limits
---

## Change the admin password

Type the current password and a new one. The new one needs at least 8 characters, with an upper-case letter, a lower-case letter, a digit and a symbol. Only an owner can change it, and only by typing the current password, even when signed in from the app.

![The Access and Security screen in Settings](images/appliance-access.webp)

Change it whenever someone who knew it steps down. Everyone who has it is an owner.

If the server made up the first password (ADMIN_PASSWORD was empty), changing it deletes data/first-admin-password.txt at once. The log says so.

## Two-factor sign-in

Two-factor sign-in asks for a 6-digit code from an authenticator app as well as the password. Settings asks for it with the password. On a server where it is off, signing in with the password opens one card only, which says "Set up two-factor sign-in to open Settings: the admin password alone is not enough." Nothing else in Settings opens until the server accepts a code from your new authenticator; then Settings opens at once, without signing in again. Meanwhile the server keeps running and serving members, the card always opens for the password, and **Log Out** is on it. If two-factor sign-in is switched off later, the next thing the password does brings that card back. It is for the password only: signing in from the app (Manage, Moderate, or a computer signed in by scanning a code) never asks for it, because the phone's own lock is that person's second factor. See Signing in.

**Until two-factor sign-in is on, the card protects Settings only.** Tools that send the password with every request instead of signing in (a standby that still copies with the password, scripts, the fleet manager) can still do everything with the password alone. Turning two-factor sign-in on closes that too: from then on they need a code as well. So set it up as soon as the card appears, and keep the password as private as before.

- Press **Setup 2FA Authenticator** and scan the QR code with an authenticator app, or type the secret it shows.
- Type the 6-digit code the app shows, and press **Verify & Enable**. Until you do, nothing changes.
- There is one code for the whole server, not one per person. Everyone who signs in with the password needs it. Owners, admins and moderators who sign in from the app don't.
- Once you have typed a code, the browser does not ask again for **4 hours** of use.
- Each code works once. A code the server has already taken, from anyone, is refused with "That 2FA code was already used. Wait for the next one from your authenticator app." The next code comes within 30 seconds. So someone who saw a code over your shoulder can't use it after you, and two people signing in together need a code each.
- Only an owner can switch it on or off.

Know its limits:

- It covers every action in Settings: changing the password, the factory reset, the community's name and address, invites, peer links and the money thresholds all ask for the code as well as the password.
- Switching it off needs an owner and a code the authenticator shows **right now** (or a backup code). Being signed in already is not enough, whether from the app or with the password and a code typed earlier.
- Moving to a new authenticator needs a current code from the old one, or a backup code, too. In Settings: switch two-factor sign-in off with a current code, then set it up again on the new phone.
- Wrong codes there count like wrong passwords, and back off the same way: see Rate limits.
- There is one code for everyone. Anyone who has the password and the authenticator (or its secret) can do everything an owner can, so guard both.
- The server makes eight single-use backup codes when you set it up. The card the password opens, and the setup wizard, show them once: write them down or save them then, because the server keeps only a scrambled copy. To see a new set later, an owner types the 6-digit code the authenticator shows now under **New backup codes** in the two-factor card (a backup code does not work there). Settings shows the eight new codes once; the old ones stop working at that moment. Keep them apart from the phone. Admins and moderators do not see this. Each backup code works once in place of a code. Keep the authenticator secret somewhere safe too.
- If you lose the authenticator: sign in with a backup code in place of the code. If none is left, owners still get in from the app's Manage button, which never asks for the code, but the password stays locked behind the lost authenticator. If no owner can sign in from the app either, beanpool recover (Signing in) makes a member an owner from the server, and that owner then signs in from the app. Deleting data/local-config.json is not needed, and it loses every setting in it.

## Break-glass codes

A break-glass code belongs to one owner. It starts with **bg-** and does one thing: it lets you add a new admin key, for example when you have lost the phone your key was on. Anywhere else in Settings it is refused, as a wrong password is, and counts as one. An owner makes one under Access & Security, **Make a break-glass code**. Signed in with your key, the code is for your own key. Signed in with the admin password, paste the member key of the owner it is for. Settings shows it once; making a new one stops the old one working. Admins and moderators have none. In the app, an owner finds **Break-glass code** under Community admin in Settings: it asks for the phone's unlock, shows a new code once, and offers to keep a copy in the phone's secure store as well.

- The server's log records that a code was made and for whom, never the code itself.
- Using it shows every member a notice: "Break-glass recovery used to authorise a new admin key for @callsign". The server's log records whose code it was.
- The server keeps only a scrambled copy of it, made slow to guess, so a copy of the server's data does not give it away.
- If two-factor sign-in is on, it still asks for the code.

Keep it offline, like a spare key. Anyone who has it can add an admin key of their own, and the notice is then the community's only warning.

## Factory reset

Only an owner can use **Wipe & Reset Node**: with the admin password, plus the two-factor code if that is on, or signed in from the app as an owner. It empties data/local-config.json: the admin password, two-factor sign-in, the community's name and contact details, the gateway settings, the money thresholds, break-glass mode and the backup settings. On a standby that includes the replication token it shows its primary, and on a primary the token's scrambled copy and the token-only switch, so live backup stops until you set up a new token on both ends. It does **not** delete members, posts, deals or beans, and it keeps the community's own key. It also deletes data/first-admin-password.txt if it is still there, since the password in it no longer works. After a restart the server takes ADMIN_PASSWORD from .env again, or makes up a new one and puts it in a new data/first-admin-password.txt, as on the first start. It never prints it in the log. Read it with: docker compose exec beanpool-node cat /data/first-admin-password.txt

To start a community again from nothing, stop the server and move the whole data folder away. Keep that copy until you are sure.
