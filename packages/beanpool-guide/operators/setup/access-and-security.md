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

Two-factor sign-in asks for a 6-digit code from an authenticator app as well as the password. It is off until you switch it on.

- Press **Setup 2FA Authenticator** and scan the QR code with an authenticator app, or type the secret it shows.
- Type the 6-digit code the app shows, and press **Verify & Enable**. Until you do, nothing changes.
- There is one code for the whole server, not one per person. Everyone who signs in needs it: with the password, and from the app's Manage button.
- Once you have typed a code, the browser does not ask again for **4 hours** of use.
- Each code works once. A code the server has already taken, from anyone, is refused with "That 2FA code was already used. Wait for the next one from your authenticator app." The next code comes within 30 seconds. So someone who saw a code over your shoulder can't use it after you, and two people signing in together need a code each.
- Only an owner can switch it on or off.

Know its limits:

- It covers every action in Settings: changing the password, the factory reset, the community's name and address, invites, peer links and the money thresholds all ask for the code as well as the password.
- Switching it off needs an owner and a code the authenticator shows **right now** (or a backup code). Being signed in already is not enough, whether from the app or with the password and a code typed earlier.
- Moving to a new authenticator needs a current code from the old one, or a backup code, too. In Settings: switch two-factor sign-in off with a current code, then set it up again on the new phone.
- Wrong codes there count like wrong passwords, and back off the same way: see Rate limits.
- Wrong codes at the app's Manage button, or when approving a computer's sign-in from the phone, are counted too, for that person's key and for the internet address they come from. After 5 wrong codes, each further try waits: 2 seconds, then 4, 8 and so on, up to an hour. A right code clears it. If this happens and it wasn't you, someone else has that person's key: remove their role, or sign them out everywhere, and add their new key.
- There is one code for everyone. Anyone who has the password and the authenticator (or its secret) can do everything an owner can, so guard both.
- The server makes eight single-use backup codes when you set it up, but Settings does not show them. Store the authenticator secret somewhere safe instead; it is how you get back in if you lose the phone.
- If you lose the authenticator and the secret, the way back is to delete data/local-config.json on the server. That loses every setting in it, including a backup's replication token, so read what it holds in Signing in first. beanpool recover (Signing in) does not help here yet: it makes someone an owner, and today an owner's key sign-in still asks for the code.

## Break-glass codes

A break-glass code belongs to one owner. It starts with **bg-** and does one thing: it lets you add a new admin key, for example when you have lost the phone your key was on. Anywhere else in Settings it is refused, as a wrong password is, and counts as one. Settings cannot make one yet: the break-glass card under Access & Security describes a plan and its button does nothing. Codes are only issued through the server's API, to owners, when their key is added.

- Using it shows every member a notice: "Break-glass recovery used to authorise a new admin key for @callsign". The server's log records whose code it was.
- The server keeps only a scrambled copy of it, made slow to guess, so a copy of the server's data does not give it away.
- If two-factor sign-in is on, it still asks for the code.

Keep it offline, like a spare key. Anyone who has it can add an admin key of their own, and the notice is then the community's only warning.

## Factory reset

Only an owner can use **Wipe & Reset Node**: with the admin password, plus the two-factor code if that is on, or signed in from the app as an owner. It empties data/local-config.json: the admin password, two-factor sign-in, the community's name and contact details, the gateway settings, the money thresholds, break-glass mode and the backup settings. On a standby that includes the replication token it shows its primary, and on a primary the token's scrambled copy and the token-only switch, so live backup stops until you set up a new token on both ends. It does **not** delete members, posts, deals or beans, and it keeps the community's own key. It also deletes data/first-admin-password.txt if it is still there, since the password in it no longer works. After a restart the server takes ADMIN_PASSWORD from .env again, or makes up a new one and puts it in a new data/first-admin-password.txt, as on the first start. It never prints it in the log. Read it with: docker compose exec beanpool-node cat /data/first-admin-password.txt

To start a community again from nothing, stop the server and move the whole data folder away. Keep that copy until you are sure.
