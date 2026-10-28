---
slug: install-with-ai
title: Setting up your server with an AI assistant
summary: What to ask an AI assistant that sets up your server for you, what it does, and what stays yours: the claim, your 12 words and your keys.
related: first-time-setup, ai-assistant, address-and-peers, access-and-security, backups-and-replicas
---

An AI assistant that can run commands on a server for you (Claude Code, for example) can set up a BeanPool server from the public instructions. The assistant prepares the server; you claim the community with your own phone, so you are its owner and the assistant never is.

## What to ask it

Copy this, put in your community's name, and give it to your assistant with your server's address and a way in that you can take back (see What stays yours, below):

Set up a BeanPool community server for me.

- If I have no server yet, help me rent a small one: Ubuntu 24.04 with at least 1 GB of memory, about US$6 a month. I sign up and pay myself.
- Install Docker and Docker Compose from the system's own packages (on Ubuntu 24.04: docker.io and docker-compose-v2).
- Turn on Docker live-restore so Docker can restart or update itself without stopping your community: if /etc/docker/daemon.json is missing, write {"live-restore": true}; if it exists, merge the key in (keeping every other key). Then run systemctl reload docker and check docker info --format '{{.LiveRestoreEnabled}}' says true.
- On a server with 1 GB of memory, first add 2 GB of swap and keep it on after a restart.
- Install BeanPool with the one block under Start a community on beanpool.org, which is also in the README at github.com/beanpool-org/beanpool. It pulls the published image of the latest release. Never build BeanPool from source, and change nothing in docker-compose.yml.
- For the block's last line, give the community its address. On a rented server with a public IP address and ports 80 and 443 open: docker compose exec beanpool-node beanpool claim --ip THE-SERVER'S-IP. On a computer at home, or with no ports open: --name NAME instead. If I have my own domain pointed at the server: --address https://my.domain. Never give the phone a plain http:// address on the internet: phones refuse it.
- Stop when it shows the one-time claim code and the QR code, and show me both, with the numbered steps for my phone it prints under them. Never claim the community yourself, and never run beanpool claim --key.
- Tell me what you ran, and anything you decided on your own.

## What the assistant does

- Looks at the server: its system, memory and disk.
- Installs Docker, turns on live-restore, and adds swap on a 1 GB server, which otherwise can run out of memory while it starts.
- Runs the one block: fetches the compose file, creates the network the server uses, pulls the published image, starts it, and waits until the server has made its one-time claim code.
- Runs beanpool claim with the address. With --ip or your own domain, your server gets its own certificate for the address, and beanpool claim waits up to three minutes until the address answers with it. With a name, your server asks for NAME.beanpool.org with its own key and waits up to three minutes for it to go live; a name that waits for approval moves over by itself once approved. See Your community needs an address phones can reach, in First-time setup.
- Shows you the claim code, the QR code and the numbered steps for your phone: install BeanPool, then scan. The claim makes your account.

### Docker and live-restore

Docker can restart or update itself without stopping your community when live-restore is enabled. On a server installed before this change, turn it on by adding `{"live-restore": true}` to `/etc/docker/daemon.json` (if the file already exists, merge the key in so other settings are kept), reloading Docker with `systemctl reload docker` (never a restart), and checking that `docker info --format '{{.LiveRestoreEnabled}}'` prints `true`.

If beanpool claim prints a warning that phones will not connect, or that the QR code carries no address, it says why: with --ip, most often port 80 or 443 closed in the server's firewall. Fix that and run it again, or use a name. The claim code waits until a phone uses it.

An IP address is a number: if your server or its IP address changes, every member has to type the new one. A name follows the community, so you can add one later in Settings → Public Address.

## What stays yours

- **The claim.** Your phone claims the community and becomes its owner. Install BeanPool on it, then scan the QR code, or open BeanPool and tap **Installed BeanPool on a server? Claim it**. The claim makes your BeanPool account on the phone: no invite, and nothing from the BeanPool project. A phone that already has an account claims with it. The code works once, for the first phone that uses it, so claim straight away. Then check under People & Safety → Owners & admins that you are the only owner.
- **Your 12 words.** Your phone shows them when it makes your key. Write them on paper and keep them. Never type them into an assistant, a chat or a server: whoever has them is you.
- **Your keys and secrets.** Give the assistant nothing more than a token you can revoke: an SSH key made for this job, which you remove from the server when it is done, or a cloud provider's token you can revoke. Never your cloud account's password, and never your phone. Afterwards, change anything you keep secret that it saw.

Later, to ask your assistant about the running server ("what needs me?"), connect it from Settings: see AI assistants. It then gets a pass you can disconnect at any time.

## Then

Open your address followed by /settings and run the setup wizard: see First-time setup. Add a second owner as soon as someone you trust has joined, and set up backups.
