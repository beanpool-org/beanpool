---
slug: first-time-setup
title: First-time setup
summary: The first start of your server, the admin password, the first owner, and what the setup wizard does and does not do.
related: signing-in, access-and-security, roles, members-and-invites, backups-and-replicas
---

## Before the first start

Your server keeps everything in one folder, **data**, next to docker-compose.yml. The server sees it as /data. Back up that folder and you have backed up the whole community.

Put an admin password in the .env file as **ADMIN_PASSWORD** before you start the server for the first time. It needs at least 8 characters, with an upper-case letter, a lower-case letter, a digit and a symbol. If the password is weaker than that, the server will not start. It restarts over and over until you fix it.

If you leave ADMIN_PASSWORD empty, the server makes up a 20-character password. It prints it once, in a box in the log. Read it with: docker compose logs beanpool-node

The server reads ADMIN_PASSWORD only on its first start. After that it keeps a scrambled copy in data/local-config.json and ignores the variable. To change the password later, use Settings.

## What the first start creates

- **data/genesis.json** and **data/community.key**: your community's own key. This key is not a person and is not the owner. Keep both files in your backups.
- **data/state.db**: the database, with every member, post, deal and vote.
- **data/local-config.json**: the admin password, two-factor settings, gateway settings, and the replication token if this server is a backup or has one.

## Open Settings

Go to your server's address followed by **/settings**, for example https://example.org/settings, and sign in with the admin password.

## The setup wizard

While your community has no members, Settings opens with a setup wizard. You can skip it, and open it again later from Home. It records that you finished it in this browser only.

What it really does:

- **Step 1** saves your community's name. It does not save the region or the address you type.
- **Step 3** can create your first enterprise and post its first offer.
- **Step 5** makes three founding invites, with QR codes you can print.

What it does not do yet:

- **Step 2** shows an owner-pairing QR, an authenticator secret and an "emergency seed". None of these is connected to the server. The emergency seed is not a working recovery code, and scanning the QR does nothing. Two-factor sign-in is not switched on until you finish it in Access & Security.
- **Step 4** says it seeds the commons, but it does not move any beans.
- If the server cannot be reached, step 5 shows codes starting with FOUNDING-. The server does not accept those codes. Make new invites under People & Safety.

## The first owner

The first time you make an invite on an empty server, it creates a member called **Admin** as the first owner. Nobody holds that member's key, so nobody can sign in as it. It exists so the first invites have someone to come from.

When the first real people have joined, give owner to at least one of them. As the password holder, open People & Safety, open the person and choose **👑 Grant Owner**. Settings now has an owner who can sign in from their phone. Keep at least two owners.

## Then

- Switch on two-factor sign-in (Access & Security).
- Set up backups (Backups and restore).
- Invite your first members.
