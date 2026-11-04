---
slug: before-the-lights-go-out
title: Before the lights go out
summary: The one-page checklist for the day the internet and the phone network go down. Three things first: the software on a laptop, a backup on that laptop, and the printed recovery code. Then what else to have ready. Do it now, while everything works.
related: when-the-lights-go-out, backups-and-replicas, access-and-security, roles, first-time-setup, address-and-peers
---

## Read this first

This page is for an owner. If the internet and the phone network go down, your community can carry on from one laptop in a hall, a school or a kitchen: people join the laptop's Wi-Fi and use BeanPool on the phones they already have. The laptop can only do that if you set it up **now**, while you still have the internet. Print this page. Tick each line.

**Coming with the next release:** the lights-out switch, the hall door in the BeanPool app, the poster page and the **Ready for the hall** card in Settings. Lines that need them say so. Everything else here works today.

When the day comes, use When the lights go out. It is the page for the day itself.

## The three things you cannot do without

With these three there is a community to bring up. Without any one of them there is not. Do them in this order.

### 1. The software is on the laptop

- **Step 1.** On the laptop you will have with you, install Docker. You see: docker compose version prints a version number.
- **Step 2.** In a folder where you keep programs, run git clone https://github.com/beanpool-org/beanpool.git. You see: a folder named beanpool.
- **Step 3.** Run cd beanpool. You see: the prompt shows the folder beanpool.
- **Step 4.** Run docker network create beanpool-shared. You see: a long line of letters and digits. If it says the network already exists, carry on.
- **Step 5.** Run docker compose pull. You see: the downloads finish with no red error line.
- **Step 6.** In a file named .env in that folder, add the line NODE_ROLE=backup. This laptop will be your community's standby (see A standby server in Backups and replicas). A standby refuses trades, so on the day When the lights go out makes it the main server. You see: the line in the file.
- **Step 7.** Run docker compose up -d once, so the data folder is made. You see: docker compose ps lists beanpool-node as running.

After every BeanPool update, run docker compose pull and docker compose up -d again. A main server refuses to copy to a standby that is older than it, so a laptop left behind copies nothing.

### 2. A backup is on the laptop

Take both. The first is the best. The second is there if the first ever stops, and today it is the one that works with no internet on a community that has no admin password (see When the lights go out).

**The laptop copies your community every minute.** It is your standby.

- **Step 1.** On your server, in Settings, open **Appliance & Data**, then **Backups & Restore**, then **Replication Access**, and make a pairing code. You see: the code, once.
- **Step 2.** On the laptop, in the folder with docker-compose.yml, run docker compose exec beanpool-node beanpool pair. You see: it asks for the pairing code.
- **Step 3.** Paste the code. You see: **Main server:** with your address, your community and the last eight characters of its key, then "This standby is paired with its main server … Its first copy starts within a minute."
- **Step 4.** Wait a few minutes. The laptop restarts itself once to put its first copy in place. You see: in Replication Access on your server, the laptop's address among the copies it asked for.

**A locked backup file sits on the laptop.** Do it every month.

- **Step 1.** Check that you have made the recovery code (3, below). Without it the file is not locked and holds no keys. You see: a code on paper.
- **Step 2.** On the laptop, sign in to your server's Settings, open **Backups & Restore** and press **Download Sovereign Database**. You see: a file ending in .bpsealed in the laptop's Downloads folder.
- **Step 3.** Move the file to a folder you will find in the dark. You see: the file there.
- **Step 4.** Write its date on the paper with the recovery code. You see: the date on the paper.

### 3. The recovery code is on paper

- **Step 1.** In Settings, **Backups & Restore**, in the **Who can unlock this community** card, press **Make a recovery code**. You see: the code once, in large letters: BPRC- and a number, then groups of letters and digits.
- **Step 2.** Press **Print** and then **Print this page**, or copy the code onto paper by hand. You see: the code on paper.
- **Step 3.** Tick **I've printed it or written it down**, then press **Done**. You see: the card closes.
- **Step 4.** Press **Check a code**, type the code from the paper and press **Check**. You see: a yes.
- **Step 5.** Put the paper away from the laptop. Whoever holds it can open your locked backups. You see: the paper, somewhere else.

## Then, in this order

- **A second owner**, and each owner's 12 words checked. One owner who is away or has lost a phone must not stop the rest (Owners' 12 words and phones, in Backups and replicas).
- **Your callsign**, or your public key, written on the same sheet as the recovery code. On the day you type it once, to make yourself the laptop's owner.
- **The authenticator app and its backup codes**, on a phone that will be in the hall, if your community still has an admin password. A new community has none (see Signing in).
- **Every member has the app.** Tell them now. The web app does not work in the hall, and a Safari-only iPhone cannot join. The members' page In the hall says what to expect.
- **The poster.** Print it with the laptop's address, and the Wi-Fi name and password written on it by hand. The four lines it carries are below. Until the poster page ships, write or print them large on a sheet.
- **The laptop's address on its own Wi-Fi.** Start the laptop's hotspot (or the travel router), look the address up in the laptop's network settings, and write it on the poster. Hotspots differ by system. Try it once with one phone.
- **The Android app.** Coming later: the laptop will hold it for phones that don't have it. Until then, Android members install it from Google Play before the lights go out.
- **Try the laptop with the internet unplugged.** Unplug it, run docker compose up -d, and see that beanpool-node starts. Coming with the next release: switch lights-out on once, move a phone and move it back.
- **Leave the admin IP allowlist empty**, or make it include the hall's range (Gateway & Peers). Otherwise Settings on the hall's Wi-Fi refuses you.

### The four lines on the poster

- Turn on Airplane mode, then turn Wi-Fi back on.
- Join the hall's Wi-Fi. If your phone asks to stay connected, say yes.
- Open the BeanPool app and scan this code. It takes you to the hall laptop.
- No app on your Android phone? Scan this code to get it from the laptop.

Under them, the poster says in one line that what people post and their balances can be read by others on the hall's Wi-Fi, and that their messages stay private. Leave the fourth line off until the laptop holds the Android app.

## The kit

A laptop with Docker and its charger, and something to power it when the power is out: a battery or a power station. A laptop's own battery is a backup built in. That is the whole kit. A travel router is optional: it makes the Wi-Fi reach further and carry more phones, and the laptop's own hotspot is enough to start.

Phones charging draw more than the laptop does (an estimate: 10 to 20 Wh a phone), so give them their own power, or a limit. Use a laptop: a laptop keeps time, and signatures older than 5 minutes are refused. A small computer with a clock battery should do as well, but it has not been tried. Once it is set up, nothing in the kit needs the internet, beanpool.org or any BeanPool service during an outage.

## Coming with the next release: Ready for the hall

A card in Settings will keep these lines in one place, with their dates: the image's date, the laptop's last copy, the recovery code's number, the owners' words, the last drill, the last download. It will turn amber when a copy is more than a day old. Until it ships, this page is the checklist.
