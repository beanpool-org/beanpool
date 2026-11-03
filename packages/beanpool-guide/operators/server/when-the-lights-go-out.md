---
slug: when-the-lights-go-out
title: When the lights go out
summary: Bringing your community up on a laptop when the internet and the phone network are down. Path A (the laptop was your standby) and path B (you have only a locked backup file), reaching the lights-out switch with no internet, and the way back when the internet returns.
related: before-the-lights-go-out, backups-and-replicas, signing-in, address-and-peers, access-and-security, troubleshooting
---

## Read this first

This is the page for the day itself. One tired person can do it from here: one action in each step, and what you should see after it. If you did not do Before the lights go out, only path B can work, and only if you have a locked backup file and its recovery code.

**What works today, and what comes with the next release.** Today: the laptop becomes your community (path A or path B), and you reach Settings on the laptop's own screen. **Coming with the next release:** the lights-out switch, the hall door in the BeanPool app, the poster page and the banner on members' phones. Steps marked **Coming with the next release** do not work yet. Until they ship, phones cannot join the hall; the laptop can only hold the community's record.

**One more thing that is true today.** Signing in to the laptop's Settings with no internet needs the admin password. A community that has none, which is every new community, needs the owner's phone to reach the laptop, and that is what the hall door is for. So until it ships, path A cannot be counted on with no internet for such a community, and path B can: it needs no sign-in at all. This is why Before the lights go out asks you to keep a locked backup file on the laptop as well.

**Two rules before you start.**

- **Two copies must never be live at once.** If your main server is still running somewhere, in another hall or a house with its own power, do not take over. The take-over makes the laptop the community, and the old server will then retire itself the moment it sees that.
- **There is no merging.** One copy is the community and the other is retired whole. The way back, below, says which.

## Choose your path

- **Path A: the laptop was your standby.** The record is about a minute old. Use it if you made the laptop your standby (the second of the three must-haves in Before the lights go out), and your community still has an admin password or the hall door has shipped.
- **Path B: you have a locked backup file.** The record is as old as the file. Use it if the laptop was never your standby, or if path A cannot sign in.

Do one, never both. Both start the same way.

## Both paths start here

- **Step 1.** Plug the laptop in and start its Wi-Fi hotspot, or the travel router. You see: phones list the Wi-Fi.
- **Step 2.** Find the laptop's address on that Wi-Fi in its network settings. You see: four numbers with dots between them, for example 192.168.2.1.
- **Step 3.** Write the address on the poster. You see: the address on the paper.
- **Step 4.** In the folder with docker-compose.yml, run docker compose up -d. You see: docker compose ps lists beanpool-node as running.

## Path A: the laptop was your standby

- **Step 1.** Make yourself the laptop's owner, because a standby has none of its own. Run docker compose exec beanpool-node beanpool recover --key @callsign, with your callsign or your public key. You must have joined the community before the laptop's last copy. You see: "@callsign is now an owner of this community", then your break-glass code, shown once.
- **Step 2.** Keep the break-glass code. You see: the code written down.
- **Step 3.** On the laptop, open its browser at http://127.0.0.1:8080/settings. You see: the Settings sign-in page.
- **Step 4.** Sign in. Reaching Settings with no internet, below, lists the ways. You see: Settings opens.
- **Step 5.** Open **Appliance & Data**, then **Backups & Restore**, then **Take over as the main server** at the bottom. You see: the first screen, saying what will be missing.
- **Step 6.** Press **I understand, continue**. You see: a box for the recovery code.
- **Step 7.** Type the recovery code from the paper and press **Open the keys**. You see: what the keys hold, and whether the main server still answers.
- **Step 8.** Read the screen. If it says in amber that the main server answers, stop, and read the first rule above. You see: no amber warning.
- **Step 9.** Tick **The main server is gone, and nobody will start it again**. You see: the box ticked.
- **Step 10.** Press **Take over now**. You have 10 minutes from step 7. You see: the steps one by one, a restart, then **This server is now the community's main server**.
- **Step 11.** Coming with the next release: turn lights-out on (below).
- **Step 12.** Show the poster, and say the record's age out loud (below).

With an owner's phone instead of the code, in steps 6 and 7: press **I understand: use an owner's phone** and scan the code on the screen with an owner's BeanPool app. A phone on the hall's Wi-Fi needs the hall door for that. Coming with the next release.

## Path B: you have a locked backup file

This way needs no phone and no Settings, so it works on a laptop nobody can sign in to.

- **Step 1.** Put the .bpsealed file in the laptop's data folder, next to docker-compose.yml. You see: the file listed there.
- **Step 2.** Run docker compose stop beanpool-node. You see: it stops.
- **Step 3.** Run docker compose run --rm beanpool-node beanpool restore /data/FILE.bpsealed, with the file's real name. You see: the file's community and the machine that locked it, beside this laptop's own, then a request for the recovery code.
- **Step 4.** Type the recovery code at the prompt. Never put it on the command line. You see: the restore finishes and says what it brought back.
- **Step 5.** Run docker compose up -d. You see: beanpool-node running again. It is now the community, with the same server key, and with the old admin password and two-factor sign-in if the community had them. Everyone who opens the app is told the community was restored from a backup, and the day it was made.
- **Step 6.** Coming with the next release: turn lights-out on (below). It needs the owner's way in below, or the laptop's shell.
- **Step 7.** Show the poster, and say the record's age out loud (below).

If the recovery code is lost but an owner's phone holds the owner key, Settings can open the file with that phone instead: **Backups & Restore**, **Restore from a locked backup**. That needs the phone to reach the laptop, so it waits for the hall door.

The community's owners come back with the file. If nobody can sign in afterwards, make an owner from the laptop's shell: docker compose exec beanpool-node beanpool recover --key @callsign.

## Reaching Settings and the switch with no internet

The switch (coming with the next release) is an owner's alone. It answers an owner's key, the admin password or the laptop's shell, and nobody else: a member's phone is refused, and so is a stranger on the Wi-Fi. These ways need no internet, from the one that needs least to the one that needs most:

- **The laptop's shell.** Coming with the next release: docker compose exec beanpool-node beanpool lights-out on, and off, and status. It needs nothing but the laptop. Whoever can run it already holds the data folder, and the log keeps a SECURITY line.
- **Settings on the laptop itself, with the admin password**, at http://127.0.0.1:8080/settings, if your community still has an admin password. This address always answers on the laptop itself. After the password, Settings asks for the authenticator's code. It comes from the authenticator app on a phone and needs no internet, because it counts time.
- **Settings on the laptop itself, with your phone.** Open the same address and scan the code the sign-in page shows (see On a computer, with your phone, in Signing in). The phone has to reach the laptop, which is what the hall door is for. Coming with the next release.
- **The app's Manage button**, on an owner's phone. Coming with the next release: a row, **Lights-out: the hall laptop**, with the address the laptop reports and the record's age.
- **If every owner's key is gone,** the laptop's shell makes you an owner: docker compose exec beanpool-node beanpool recover --key @callsign.

## Turn lights-out on

**Coming with the next release.** The switch is one tap or one command, an owner's only. While it is on, three things change, all for the hall's Wi-Fi and nobody outside it:

- The laptop's plain port answers phones on the hall's Wi-Fi as it would at home. A device from outside the local network is still turned away.
- The laptop's health says lights-out is on, with its address and the record's date, and the app reads that to show its banner.
- If the record came from a backup, the community's take-over count goes up by one, so every phone that reaches the laptop takes the hall's record whole.

The switch is kept in the laptop's local-config.json, which no backup carries, so a hall laptop's "on" can never come back to life on a rented server. It is never automatic: a flapping internet line must not open the laptop's port by itself.

## Show the poster, and say the record's age

- **Step 1.** Coming with the next release: open the poster page on the laptop's screen. Or hold up the printed poster. You see: the four lines, the two codes and the laptop's address.
- **Step 2.** Say aloud: "The record is as of (the time) today. If you traded after that on the old server, tell an owner. It is written down for when the internet returns." The record's age is the time of the laptop's last copy (path A), or of the backup file (path B). You see: people nod.
- **Step 3.** Write down what people tell you they traded after that time. You see: a list on paper.

The words say the day and the time, never "stale".

## What stays refused in the hall

- **Changing the community's addresses**: claiming or giving up a name, **Take offline**, changing the public address, confirming or removing an address. Coming with the next release: refused with "not while the lights are out". The address service cannot be reached anyway, and a change made here would send every phone to a dead address on the way home.
- **Taking over on a second standby** while one copy is live. See the first rule above.
- **Everything else works as online:** owner-only rules, the fresh proof, the money rules. Nothing about who may do what is relaxed. The switch is about reaching the laptop, not about what it lets through.

**What members cannot do in the hall:** use the web app (an iPhone with Safari only), get notifications on a closed app, see the map's streets, sign in with Google, Apple or Facebook, or reach other communities. What members post and their balances can be read by others on the hall's Wi-Fi. Direct messages and group chats stay locked on the phones.

## When the internet comes back

**The rule:** one copy is the community, and the other is retired whole. The hall's copy wins if anyone traded in the hall.

### The usual case: the hall traded, and the old server still runs

- **Step 1.** Leave the laptop running as the main server, with lights-out on, until phones have moved home. You see: the hall carrying on.
- **Step 2.** When the internet is back, open the old server's Settings, then **Appliance & Data**, **Backups & Restore**, **Take over as the main server**. The old server asks its own web address when it starts and every hour, sees the laptop's higher take-over count signed with its own key, and goes read-only by itself. You see: in red, "This server was replaced on (date). It is now read-only." If you do not see it within an hour, do step 3.
- **Step 3.** Stop the old server yourself in two cases, before members go home. **If you came by path B,** the laptop's count has not gone up until lights-out has been switched on, and that switch is coming with the next release. **If your address is run by a tunnel on the server's own machine** instead of inside BeanPool's container (the way Byron's community runs), the old server never sees the laptop's count at all. On the old server's machine, in the folder with docker-compose.yml, run docker compose stop beanpool-node. You see: it stops. Never start the old main server again.
- **Step 4.** Coming with the next release: switch lights-out off. The laptop tells phones the internet is back, and each phone checks that your community's own address answers with the same key, then goes home carrying its copy. You see: the banner changes to say the internet is back.
- **Step 5.** In daylight, set the old machine up from scratch as a standby of the laptop (see If the old main server comes back, in Backups and replicas). You see: it copies from the laptop.
- **Step 6.** When you want the community back in the cloud, take over on that server by the recovery code, as in path A but the other way. The laptop goes read-only when it sees that, and you set it up again as that server's standby. You see: **This server is now the community's main server** on the cloud server.

**What is lost, and said plainly:** anything the old server recorded after the laptop's last copy and before the outage (about a minute with a standby; as much as the file's age without one), and anything members outside the hall did on the old server during the outage. Tell people, and settle trades by hand with ordinary sends.

### If nobody traded in the hall

Switch off, and the phones go home to the old server. Nothing was lost. Coming with the next release: **Stand down**, which turns the laptop back into a standby. Until it ships, a take-over cannot be undone from Settings, so do not take over unless the hall needs the record to carry on.

### If the old server is gone for good

The laptop is the community. Rent a new server later and bring the community there by the standby path: pair the new server as the laptop's standby, then take over on it.

## What must never happen

- **Two live copies after the internet returns.** The take-over count, the shared tunnel, the manual stop above and the first rule stop it.
- **Beans made or lost by a merge.** There is no merge.
- **The old main server started again** while the laptop is the community.
- **An owner locked out in the hall.** The shell and the laptop's own Settings are there for that.
