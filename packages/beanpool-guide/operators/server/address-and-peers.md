---
slug: address-and-peers
title: Address, identity and peers
summary: Your community's web address, what it tells the BeanPool directory, the gateway switches, and links to other communities.
related: what-the-server-sees, rate-limits, updates-and-health, backups-and-replicas
---

## Public address

**Appliance & Data**, then **Public Address**. Members' apps need an address to reach your server.

- You can claim a name ending in **.beanpool.org** here. Some names, such as big cities, wait for approval by the BeanPool project.
- The usual way in is a tunnel: a small helper container dials out to Cloudflare, so your server needs no open ports and its own address stays hidden. The other way points the name straight at your server, which needs a public IP address and port 443 open.
- The BeanPool project then checks from time to time that the name still answers with your server's key. If another server answers, the name is taken away.

You can also use your own domain name and certificate. BeanPool does not need to be involved.

## Node identity and the directory

**Node Identity** holds the community's name, contact email and phone, and the area it serves.

By default your server tells the BeanPool directory about itself every 12 hours: the community's name, the area it serves, how many members it has, and the contact email and phone if you filled them in. That is how new people find you. Each part can be switched off here, and so can the whole thing. Your members' names and posts are never sent.

## Gateway

**Gateway & Peers** has the gateway switches:

- turn the market, messages, links with other communities, invites or the web app off for everyone;
- the rate limit (see Rate limits);
- which other websites may call your server.

Turning a feature off affects every member at once. Tell them first.

## Peers: other communities

Links between communities are off unless you switch them on in the server's .env: ENABLE_PEER_CONNECTORS=true lets your server talk to peers, and FEDERATION_SETTLEMENT=true lets members trade across the link. Then add a peer's address under **Gateway & Peers**. Trading between communities is new and little used; agree the terms with the other community's owners first.
