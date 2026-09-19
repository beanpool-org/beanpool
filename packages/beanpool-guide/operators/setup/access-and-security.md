---
slug: access-and-security
title: Access and security
summary: Changing the admin password, two-factor sign-in, break-glass codes, and the factory reset. Under Appliance & Data, then Access & Security.
related: signing-in, roles, first-time-setup, rate-limits
---

## Change the admin password

Type the current password and a new one. The new one needs at least 8 characters, with an upper-case letter, a lower-case letter, a digit and a symbol. Only someone who knows the current password can change it, even an owner signed in from the app.

Change it whenever someone who knew it steps down. Everyone who has it is an owner.

## Two-factor sign-in

Two-factor sign-in asks for a 6-digit code from an authenticator app as well as the password. It is off until you switch it on.

- Press **Setup 2FA Authenticator** and scan the QR code with an authenticator app, or type the secret it shows.
- Type the 6-digit code the app shows, and press **Verify & Enable**. Until you do, nothing changes.
- There is one code for the whole server, not one per person. Everyone who signs in needs it: with the password, and from the app's Manage button.
- Once you have typed a code, the browser does not ask again for **4 hours** of use.

Know its limits:

- Some actions check only the password, never the code: changing the password, the factory reset, the community's name and address, invites made by the setup wizard, peer links and the money thresholds. Someone with the password alone can still do those. Guard the password as if two-factor sign-in were off.
- Any admin can switch two-factor sign-in off, not only owners.
- The server makes eight single-use backup codes when you set it up, but Settings does not show them. Store the authenticator secret somewhere safe instead; it is how you get back in if you lose the phone.
- If you lose the authenticator and the secret, the way back is to delete data/local-config.json on the server. That loses every setting in it, including a backup's replication token, so read what it holds in Signing in first.

## Break-glass codes

A break-glass code belongs to one owner. It starts with **bg-** and works in place of the admin password, recorded against that owner's name. Settings cannot make one yet: the break-glass card under Access & Security describes a plan and its button does nothing. Codes are only issued through the server's API, to owners.

If you do hold one, keep it offline, like a spare key. Anyone who has it can do what the password can, apart from the password-only actions listed above.

## Factory reset

**Wipe & Reset Node** needs the admin password. It empties data/local-config.json: the admin password, two-factor sign-in, the community's name and contact details, the gateway settings, the money thresholds, break-glass mode and the backup settings. On a standby that includes the replication token it shows its primary, and on a primary the token's scrambled copy and the token-only switch, so live backup stops until you set up a new token on both ends. It does **not** delete members, posts, deals or beans, and it keeps the community's own key. After a restart the server takes ADMIN_PASSWORD from .env again, or makes up a new one and prints it in the log.

To start a community again from nothing, stop the server and move the whole data folder away. Keep that copy until you are sure.
