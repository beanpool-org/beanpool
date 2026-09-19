---
slug: signing-in
title: Signing in to Settings
summary: The three ways in: the admin password, the app's Manage (or Moderate) button, or a computer signed in by scanning a code with the app. How long a sign-in lasts.
related: access-and-security, roles, first-time-setup, rate-limits
---

There are three ways into Settings. The password is one shared secret for the whole server. The app's Manage button, and a computer you sign in by scanning a code with the app, sign in a named person with their own key.

## With the admin password

Go to your server's address followed by /settings and type the admin password. If two-factor sign-in is on, Settings then asks for the 6-digit code from your authenticator app.

- The password counts as an **owner**. Whoever has it can do everything an owner can.
- Anything done with the password is recorded as done by the password, not by a person. Other admins cannot tell who it was.
- Your browser keeps the password for this tab only. Close the tab and you sign in again.
- Some things can only be done with the password, even by an owner signed in from the app: changing the password, resetting the server, making invites from the setup wizard, the community's name and address, peer links and the money thresholds.

![The sign-in screen in node Settings](images/sign-in.webp)

## From the app's Manage button

Owners and admins see **Manage** followed by the community's name in the phone app's Settings; moderators see **Moderate** and the name, which opens their Reports screen. Pressing it:

- asks for the phone's own unlock (fingerprint, face or PIN). If the phone has no screen lock, the button refuses to open Settings;
- asks for the 6-digit code if your server has two-factor sign-in on;
- opens Settings in the browser, signed in as you, on the screen the app sent you to (for example a stuck deal under Escrow Disputes). On a phone, the **☰** menu at the top has every other screen: see Finding your way around Settings.

When you are done, **← App** at the top right (in full, **← Back to the BeanPool app**, at the top of the **☰** menu) takes you back to the app, and **View my profile** opens your own profile there.

## On a computer, with your phone

To use Settings on a computer's bigger screen without the password:

- First, on the computer, go to your server's address followed by /settings and choose **Sign in with your phone**. It shows a QR code, a 6-character code and a countdown. Use the same address the app uses (for example https://yourtown.beanpool.org/settings), not the server's address on your home network such as 192.168.1.20: the QR code carries whatever address is in the browser's address bar, and the phone refuses an address it does not know as a different community.
- Then, in the phone app, open **Settings** and tap **Sign in on a computer** (next to Manage or Moderate; owners, admins and moderators only). Point the camera at the QR code.
- The phone shows the 6-character code, your community and which browser asked (for example "Firefox on Windows"). Check the code matches the one on the computer. If it doesn't, or it isn't your computer, tap **No, that's not my computer**.
- Tap **Sign in**. The phone asks for its own unlock, and the 6-digit code if your server has two-factor sign-in on. The computer opens Settings, signed in as you.

Good to know:

- A code lasts **2 minutes** and works once. The computer shows a new one by itself when it runs out, a few times, then waits for you to press **New code**.
- The code only signs in the browser that showed it. A photo of the QR code is no use on another computer.
- The app only accepts a code from its own community. A code from another server is refused, and the phone says which one it was.
- Five refused tries on one code (wrong key, no role in this community, wrong 6-digit code) use it up.
- Each approval is written to the server's log, with who approved it and which browser signed in.

## Whose sign-in it is

A sign-in from the app, or from a computer you signed in with the app, belongs to a person. Everything you do is recorded against your name. A moderator signs in the same two ways and gets Reports only (see Owners, admins and moderators).

A sign-in from the app (on the phone or on a computer) ends after **2 hours** without use, and after **12 hours** at most. It also ends when an owner changes or removes your role, and when the server restarts.

The web app shows a plain link to Settings, but it cannot sign you in with your key: a browser has no unlock of its own. Open Settings on the computer and sign in with your phone, as above, or use the password. Settings opened from the web app offers **← Back to BeanPool**, which returns you to the web app.

## If you are locked out

- Too many wrong passwords from one internet address make that address wait before it can try again. The right password from another network (mobile data, another wifi) works at once. The Manage button is not slowed down by wrong passwords. A phone approving a computer's sign-in is counted with the passwords, though: it shares the limit of 15 sign-in attempts a minute from one internet address, so from the same wifi it may have to wait a minute too. See Rate limits.
- Forgot the password: owners and admins can still sign in from the app, on the phone or on a computer, but nobody can change the password without knowing the old one. The fix is on the server itself, and it loses everything in data/local-config.json. Besides the password, that file holds the community's name and contact details, two-factor sign-in, the gateway settings, the money thresholds, break-glass mode and the backup settings. On a standby it also holds the replication token it shows its primary, and on a primary the token's scrambled copy and the token-only switch, so live backup stops until you set up a new token on both ends. Knowing that, stop the server, delete data/local-config.json and start it again with a new ADMIN_PASSWORD, then set those things again. Members, posts and beans are not touched: they are in data/state.db.
