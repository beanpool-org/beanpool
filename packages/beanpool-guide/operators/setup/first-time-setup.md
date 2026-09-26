---
slug: first-time-setup
title: First-time setup
summary: The first start of your server, the admin password, the first owner, and what the setup wizard does and does not do.
related: signing-in, access-and-security, roles, members-and-invites, backups-and-replicas
---

## Before the first start

Your server keeps everything in one folder, **data**, next to docker-compose.yml. The server sees it as /data. Back up that folder and you have backed up the whole community.

Put an admin password in the .env file as **ADMIN_PASSWORD** before you start the server for the first time. It needs at least 8 characters, with an upper-case letter, a lower-case letter, a digit and a symbol. If the password is weaker than that, the server will not start. It restarts over and over until you fix it.

If you leave ADMIN_PASSWORD empty, the server makes up a 20-character password. It never prints it in the log, because the log is kept for as long as the server runs and gets copied into support requests. It puts the password in a file, data/first-admin-password.txt, that only the server can read, and the log says where it is. Read it with: docker compose exec beanpool-node cat /data/first-admin-password.txt

Sign in with it, then change the password in Access & Security. The file is deleted the moment you do, and the log says so. Until then, every start of the server reminds you in the log that the file is still there, without printing the password. If the server cannot write the file, it does not start, and the log says why.

The server reads ADMIN_PASSWORD only on its first start. After that it keeps a scrambled copy in data/local-config.json and ignores the variable. To change the password later, use Settings.

## What the first start creates

- **data/genesis.json** and **data/community.key**: your community's own key. This key is not a person and is not the owner. Once you make a recovery code, a backup from Settings carries both, locked. Until then only a copy of the data folder does: see Backups and replicas.
- **data/state.db**: the database, with every member, post, deal and vote.
- **data/local-config.json**: the admin password, two-factor settings, gateway settings, and the replication token if this server is a backup or has one.
- **data/first-admin-password.txt**: only when ADMIN_PASSWORD was empty. The password the server made up, in plain text, until you change it. A backup from Settings never carries it, but a copy of the whole data folder does: change the password before you copy the folder anywhere.

## Open Settings

Go to your server's address followed by **/settings**, for example https://example.org/settings, and sign in with the admin password.

## The setup wizard

While your community has no members, Settings opens with a setup wizard. You can skip it, and open it again later from Home. It records that you finished it in this browser only.

![The first-time setup wizard in Settings](images/cold-start.webp)

What it does:

- **Step 1** saves your community's name and checks that your server answers at its address. If either fails, it says which, and what to check, with **Retry** and **Continue anyway**. If you continue, the step is marked ⚠ instead of ✓. If two-factor sign-in is already on and you have not typed a code this session, it asks for one with **Enter 2FA code**, then saves.
- **Step 2** turns on two-factor sign-in, if you want it now. Tap **Set up 2FA**, scan the code with an authenticator app, and type the 6-digit code it shows. Two-factor is on only once the server accepts that code; then the wizard shows your backup codes and a recovery kit to download. Save them before you leave the step: the server keeps only a scrambled copy, so they cannot be shown again. If two-factor was already on, the wizard says so and has no codes to show. While it is asking the server, it says **Checking whether 2FA is on**; if it could not find out, it says so, with **Retry**. The kit holds your server's address and those backup codes, nothing else. It never holds the admin password. Only an owner can set up 2FA; if the server refuses, the wizard shows why, and you can finish it later in Access & Security.
- **Step 2** also explains how your phone becomes an owner. See The first owner below.
- **Step 3** can create your first enterprise and post its first offer. If a member is already an owner, it makes them the enterprise's first keeper. On a new server nobody is, so it says no keeper will be set; add one later under Shared Projects & Economy. If any part fails, it shows the server's reason, with **Retry** (which repeats only the parts that failed) and **Continue anyway**.
- **Step 4** explains how the commons fills. A new community's commons starts at 0 beans. Nothing, not even this wizard, can put beans into it by hand.
- **Step 5** makes three founding invites, with QR codes you can print. If the server refuses or cannot be reached, it stops and shows the reason, with no code. Try again, or make invites later under People & Safety.

A step shows ✓ only when it really happened. You can move on from any step without finishing it.

What it does not do yet:

- It does not save a region or a map location. Set those later under Node Identity.

## The first owner

The first time you make an invite on an empty server, it creates a member called **Admin** as the first owner. Nobody holds that member's key, so nobody can sign in as it. It exists so the first invites have someone to come from.

When the first real people have joined, give owner to at least one of them. As the password holder, open People & Safety, open the person and choose **👑 Grant Owner**. Settings now has an owner who can sign in from their phone. Keep at least two owners.

## Then

- Switch on two-factor sign-in (Access & Security).
- Set up backups (Backups and restore).
- Invite your first members.
