# BeanPool

> A free app a community runs for itself, to trade help, goods and skills in Beans instead of money.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: Beta](https://img.shields.io/badge/Status-Beta-emerald.svg)]()

---

## What is BeanPool?

BeanPool is a free app a community runs for itself. Members post what they can offer or need (a lift to town, eggs, fixing a bike, an hour of gardening), message each other, and settle trades in **Beans**, the community's own credit: you earn Beans by helping someone and spend them with anyone in your community, and your balance can go a little below zero on a credit line you earn by trading. There is no interest, no ads and no bank or lender in the middle.

Each community runs its own server (a **node**) on a spare computer or a small rented server, so its listings, messages and balances stay with it. A small monthly circulation charge on the part of a balance above 200 Beans, and a small charge on trades, go into the community's **Commons Pool**, which members vote to spend. Members use the phone app (iPhone and Android) or a web browser. The **global community** at global.beanpool.org, which BeanPool runs, shows newcomers around and leads them to a community near them; it has no Beans, and today it is a private preview. The website says more: [beanpool.org](https://beanpool.org), and why we built it this way: [post-extraction](https://beanpool.org/post-extraction.html).
<!-- OPEN-GLOBAL: "it has no Beans, and today it is a private preview." becomes "it has no Beans, and anyone can join it, no invite needed, in the browser or the app." -->

**Communities running today:** see [the map on beanpool.org](https://beanpool.org/#find-or-start). Two communities can link so their members can trade with each other; Beans never leave home. Linking is built, has been tried only between two of our own test communities, never between live ones, and is off unless both operators switch it on.

BeanPool is part of the wider [Technomutualism](https://technomutualism.org) movement. It is in beta, so expect rough edges. Your **12 words** are the way back into your account that depends on nobody: write them on paper, keep them safe, and never give them to anyone, including us.

**New here?** Read the [members' guide](https://beanpool.org/guide/). **Questions?** See [SUPPORT.md](SUPPORT.md) or ask in [Discussions](https://github.com/beanpool-org/beanpool/discussions).

### What it is

- One server per community, run by people that community chose.
- A phone app and a web app for members.
- Beans as mutual credit. A small monthly circulation fee on balances above 200 Beans goes to the community's Commons.
- Open source (MIT), and free to run yourself with Docker.
- Optional: a free `name.beanpool.org` address, and links between communities.

### What it isn't

- Not a bank, and not a cryptocurrency. The app has no way to buy or sell Beans for money.
- Not one big network owned by one company. Each community holds its own data.
- Not tied to beanpool.org. A community does not need our address service or our global community to run.
- Not finished. It is beta software from a small project.

---

## How it works

- **Joining.** A local community lets you in with an invite from one of its members, and some let anyone join. Your phone makes your key and shows you your 12 words.
- **Offers and Needs.** Members post what they can offer or need on a shared map and market. In a community with Beans, you post an Offer of your own before you ask for something.
- **A trade.** When a trade is agreed, the buyer's Beans are held. When the buyer confirms the job is done, they go to the seller. If a trade gets stuck, an admin of the community can step in.
- **Beans and credit.** Everyone starts at zero. About 40 Beans is an hour of someone's time, and the two of you agree the real price. Your credit line, how far below zero you may go, opens with your first trade and grows as you trade with different people.
- **The Commons.** A fee of 1.5% on market payments, and the monthly circulation fee on Beans above 200, go into the community's Commons Pool. Members decide together how it is spent. Balances below zero never pay the circulation fee.
- **Messages.** Direct messages and group chats are locked in the members' apps. The server stores them but cannot read them. Event chats and enterprise chats are not locked.
- **The server.** It keeps the community's members, posts, trades and Beans in one `data` folder. Its owners and admins look after it, make backups, and can keep a standby copy to take over if the main server fails. The operator manual says what the server can and cannot see.
- **An address.** Phones reach a community over https. It can use a free `name.beanpool.org` name, its own domain, or its server's IP address.
- **Linking communities.** Two communities can link so their members trade with each other. It is optional, off unless both operators switch it on, and has been tried only between two of our own test communities.

The members' guide explains each of these step by step.

---

## Run a community

The software is free. A community runs on a spare computer that stays on at home (a Mini PC, a NAS, or a Raspberry Pi with a 64-bit system) or on a small rented server, about US$6 a month. You need Docker installed first; a freshly rented server has none. The published image runs on Intel/AMD and ARM64.

On that machine, paste this one block. It fetches the compose file, creates the network the compose file expects (`beanpool-shared`, declared `external`), pulls the image, starts it, waits for the one-time claim code, then claims the community with your phone. It is the same block as [beanpool.org/#run-a-node](https://beanpool.org/#run-a-node).

**Choose your address before you paste, and change the last line to match** (the choices are just below the block). If you already pasted, press Enter at its two questions, then run the last line again: the claim code waits for a phone.

```bash
git clone https://github.com/beanpool-org/beanpool.git && cd beanpool
docker network create beanpool-shared
docker compose pull
docker compose up -d
echo "Waiting for the server to make its claim code (up to 5 minutes)..."
for i in $(seq 60); do docker compose exec -T beanpool-node test -f /data/claim-code.txt </dev/null 2>/dev/null && break; sleep 5; done
docker compose exec -T beanpool-node test -f /data/claim-code.txt </dev/null 2>/dev/null || echo "No claim code after 5 minutes. The server's log says why: docker compose logs beanpool-node"
docker compose exec beanpool-node beanpool claim
```

The last line, `beanpool claim`, shows a one-time claim code and a QR code, with the address you chose, and what to do next. First, on the phone that will own the community, install BeanPool from [Google Play](https://play.google.com/store/apps/details?id=org.beanpool.pillar) or the [App Store](https://apps.apple.com/app/id6761870086) and make your account: with no invite, tap **Explore BeanPool worldwide**. It shows you 12 words: write them on paper. Then scan the QR code with your phone's camera, or open BeanPool → **Find a community**, type the server's address in the search box and tap **Claim ‹name›**. That phone becomes the community's owner.

Phones reach a community on the internet only over https. The choices for the last line:

- **A rented server** with a public IP address and ports 80 and 443 open: `beanpool claim --ip 203.0.113.7`. The server gets its own certificate for that address.
- **A computer at home**, or no open ports: `beanpool claim --name yourtown`. It asks for `yourtown.beanpool.org`, through a tunnel the server runs itself. This is the only choice that uses a BeanPool service.
- **Your own domain**, pointed at the server: `beanpool claim --address https://your.domain`.

A plain `http://` address works only on a home network, and `beanpool claim` warns you before it shows a QR code that a phone will refuse.

Then open your address followed by `/settings`. The setup wizard names your community and asks you to add a second owner. Everything the server keeps is in the `data` folder next to `docker-compose.yml`, so back that folder up.

**To update**, back up `data`, then run `docker compose pull` and `docker compose up -d` in the same folder.

**More:** the operator manual's [first-time setup](https://beanpool.org/guide/operators/first-time-setup.html) has the rest. An AI assistant can do the install for you while you keep the claim, your 12 words and your keys: see [Setting up your server with an AI assistant](packages/beanpool-guide/operators/setup/install-with-ai.md).

The server listens on 443 (https) and 80 (plain http). Port 80 is where Let's Encrypt checks a server's IP address or domain before it issues a certificate, so keep it open on a rented server, and it serves plain http to a home network. The server also publishes 8443 and 8080. Ports 4001 and 4002 are for links between communities and are opt-in: open them only if a linked community needs to dial your server.

---

## Contribute

- **Start with [CONTRIBUTING.md](CONTRIBUTING.md).** It explains the values, what help is needed, and how to propose a change. Open an issue before you write code.
- **Something isn't working?** [Open a bug report](https://github.com/beanpool-org/beanpool/issues/new/choose).
- **An idea?** Start a thread in [Discussions → Ideas](https://github.com/beanpool-org/beanpool/discussions/categories/ideas).
- **A security problem?** Report it privately, never in public. See [SECURITY.md](SECURITY.md).
- **How we behave:** [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- **What is planned:** [ROADMAP.md](ROADMAP.md). The rules the ledger follows are in [docs/protocol-rules.md](docs/protocol-rules.md); that page describes the target design, and some parts are not built yet.

### Build from source

CI uses Node 22 and pnpm 9. Build in this order, as the `Dockerfile` does, then start the server:

```bash
pnpm install
cd packages/beanpool-core && pnpm run build && cd ../..
cd packages/beanpool-engine && pnpm run build && cd ../..
cd packages/beanpool-signin && pnpm run build && cd ../..
cd apps/pwa && pnpm run build && cd ../..       # the web app, into apps/server/public/
cd apps/manager && pnpm run build && cd ../..   # Settings, into apps/server/public/settings/
cd apps/server && pnpm dev                      # the server, with hot reload
```

`pnpm lint` and `pnpm test` run at the repo root. `pnpm test-all` runs every check in `scripts/test-all.sh`.

### What's in this repo

| Path | What it is |
|------|------------|
| `apps/server` | The community's server: REST API, live updates, and the host for the web app and Settings |
| `apps/pwa` | The web app (React, Vite) |
| `apps/native` | The phone app (Expo, React Native) |
| `apps/manager` | Settings, for owners and admins, at `/settings` on every server. It holds the operator manual |
| `apps/vault` | The key vault: a small server that keeps members' locked sign-in recovery copies. See its README |
| `apps/registrar` | The Cloudflare Worker that leases `name.beanpool.org` addresses |
| `apps/feedback` | The Cloudflare Worker behind "Suggest a change to BeanPool" |
| `apps/website`, `apps/website-src` | The beanpool.org website, and its translations |
| `packages/beanpool-core` | Code shared by every app: the ledger rules, keys, message locks, the app's words |
| `packages/beanpool-engine` | Server logic that works on the database (escrow, audit and more) |
| `packages/beanpool-signin` | The checks for Google, Apple and Facebook sign-ins, shared by the server and the vault |
| `packages/beanpool-guide` | The members' guide and the operator manual |
| `docs/`, `scripts/` | Design notes, and the tests and tools |

---

## Licence

[MIT](LICENSE)
