---
slug: signing-in
title: Signing in to Settings
summary: The two ways in, with the admin password or from the app's Manage button, and how long a sign-in lasts.
related: access-and-security, roles, first-time-setup, rate-limits
---

There are two ways into Settings. The password is one shared secret for the whole server. The app's Manage button signs in a named person with their own key.

## With the admin password

Go to your server's address followed by /settings and type the admin password. If two-factor sign-in is on, Settings then asks for the 6-digit code from your authenticator app.

- The password counts as an **owner**. Whoever has it can do everything an owner can.
- Anything done with the password is recorded as done by the password, not by a person. Other admins cannot tell who it was.
- Your browser keeps the password for this tab only. Close the tab and you sign in again.
- Some things can only be done with the password, even by an owner signed in from the app: changing the password, resetting the server, making invites from the setup wizard, the community's name and address, peer links and the money thresholds.

## From the app's Manage button

Owners and admins see **Manage** followed by the community's name in the phone app's Settings. Pressing it:

- asks for the phone's own unlock (fingerprint, face or PIN). If the phone has no screen lock, the button refuses to open Settings;
- asks for the 6-digit code if your server has two-factor sign-in on;
- opens Settings in the browser, signed in as you.

This sign-in belongs to a person. Everything you do is recorded against your name. Moderators do not get the Manage button, and cannot sign in to Settings at all.

A sign-in from the app ends after **2 hours** without use, and after **12 hours** at most. It also ends when an owner changes or removes your role, and when the server restarts.

The web app shows a plain link to Settings, but it cannot sign you in with your key. Use the phone app, or the password.

## If you are locked out

- Too many wrong passwords close password sign-in for a while, for everyone. Signing in from the app's Manage button still works meanwhile. See Rate limits.
- Forgot the password: owners and admins can still sign in from the app, but nobody can change the password without knowing the old one. The fix is on the server itself: stop it, delete data/local-config.json and start it again with a new ADMIN_PASSWORD. That file also holds the community's name and contact details, two-factor sign-in, the gateway settings, the money thresholds and the backup settings, so you set those again. Members, posts and beans are not touched: they are in data/state.db.
