---
slug: showcase
title: Showing what a local community does
summary: The showcase switch: whether the apps show a switched-off feature from an example community or hide it. On for a global community, off for a local one, and yours to change. Where Start a community and the Global community link lead.
related: members-and-invites, private-preview, rate-limits, first-time-setup
---

## What it does

A community can have some features switched off: Beans, deals that hold Beans until the job is done, enterprises and the Commons pool, crowdfunds, Decisions and invites. A global community has all of these off.

One switch, **showcase**, says what the apps do with a feature that is off:

- **On:** the apps show it, filled from **Example Valley**, a made-up community built into the apps, under one marker: **🏘️ Local community**. The Ledger shows an example member, Commons an example enterprise and Decision, and the Market's My Deals two example deals.
- **Off:** a feature that is off is hidden, as before. On the phone, with Beans off, the Commons and Ledger tabs go.

With showcase on, every button that would move Beans, make a deal, vote, pledge or invite opens one sheet, **Why this lives in a local community**. It says why in a line, then offers **Start a community** and, where it can, **Communities near you** and **How it works**.

The explainers on those screens are the real ones. Nobody in Example Valley has a name: rows read "a neighbour", "the Commons" or "the Example Valley Bakery". In the web app, visitors who haven't joined also get an example Ledger tab beside Home, Market and Map.

## The defaults

- **A global community** (NODE_PROFILE=global): on. It is where strangers first meet BeanPool, so what lives in a local community is shown, not hidden.
- **A local community:** off. If you switched a feature off, you meant it, and the apps should not show it as something your community has.

On a local community with every feature on, the switch changes nothing: there is nothing switched off to show.

## What it never changes

- It changes only what the apps show. A feature that is off stays off on the server, and its routes refuse as before.
- Example Valley never reaches your database. Every id in it starts with sample-, and the server refuses any write that names one as an id with 400 (sample_id), before any other check. Free text is never refused for it, so a member can still write "sample-sale".
- The server reports the switch in its features only while it is on. An app from before this feature never reads it, and hides what is off, as before.

## Changing it

There is no screen for it in Settings. It is a row in the server's node_config, nodeProfile.showcase, set to true or false.

To turn it off on a global community, run on the server: docker compose exec -u node beanpool-node node -e "require('better-sqlite3')('/data/state.db').prepare(\"INSERT INTO node_config (key, value) VALUES ('nodeProfile.showcase', 'false') ON CONFLICT(key) DO UPDATE SET value = excluded.value\").run()"

To turn it on on a local community, run the same with 'true' in place of 'false'.

To go back to your profile's default, delete the row: docker compose exec -u node beanpool-node node -e "require('better-sqlite3')('/data/state.db').prepare(\"DELETE FROM node_config WHERE key = 'nodeProfile.showcase'\").run()"

The server reads it at once. Then restart it, so the take-over keys your standby holds carry the change too: docker compose restart beanpool-node. A standby gets the row itself at its next copy.

Members' phones keep the community's settings for up to an hour, so allow an hour for every phone to change. The web app reads them each time it is opened.

A value other than true or false is ignored, and the log says so once.

## Where Start a community leads

The sheet's **Start a community** leads to a page on how to run a community. With nothing set, that is https://beanpool.org/#run-a-node. Your community doesn't need it: you can name your own page instead.

- An owner sets it with POST /api/local/admin/start-community-url and a url, or null for the default. It must start https://, have no user name or password in it, and be at most 300 characters.
- Or set the row startCommunityUrl in node_config, the same way as above. A value that isn't such an address is ignored, and the default is used.
- It travels to your standby with the community's other settings, and is reported to the apps on /api/community/info.

The web app and the phone app both link it from their Start a community screens.

## Where the Global community link leads

On a local community, the web app's Settings has a **Global community** row: a link to the worldwide community, where anyone can look around and join. With nothing set, that is https://global.beanpool.org. Your community doesn't need it, and your server never contacts it: it is only a link your members may follow.

- To name another global community, set GLOBAL_COMMUNITY_URL in the server's .env to its address, such as GLOBAL_COMMUNITY_URL=https://global.example.org, and run docker compose up -d (a restart keeps the old setting). It must start https:// and have no user name or password in it.
- To show no link at all, set GLOBAL_COMMUNITY_URL=off and run docker compose up -d. A value that isn't such an address shows no link either, never ours in its place.
- It is reported to the apps on /api/community/info as globalCommunityUrl. A global community's own Settings shows no such row.
