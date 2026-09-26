---
slug: address-and-peers
title: Address, identity and peers
summary: Your community's web address, the addresses members' apps use, what it tells the BeanPool directory, the gateway switches, and links to other communities.
related: what-the-server-sees, rate-limits, updates-and-health, backups-and-replicas
---

## Public address

**Appliance & Data**, then **Public Address**. Members' apps need an address to reach your server.

- You can claim a name ending in **.beanpool.org** here. Some names, such as big cities, wait for approval by the BeanPool project.
- The usual way in is a tunnel: a small helper container dials out to Cloudflare, so your server needs no open ports and its own address stays hidden. The other way points the name straight at your server, which needs a public IP address and port 443 open.
- The BeanPool project then checks from time to time that the name still answers with your server's key. If another server answers, the name is taken away.

![Public Address configuration in Settings](images/appliance-network.webp)

You can also use your own domain name and certificate. BeanPool does not need to be involved.

## Addresses members' apps use

Also under **Public Address**. A member's app signs every request for the address it reaches your community at, and your server accepts only its own addresses. So the owner of another community can't copy a member's request and use it here, for example to send that member's Beans or delete their account.

The list shows each address with where it comes from and how many apps used it today and on the busiest day this week:

- **this community's web address**: the name you claimed above, or the server's CF_RECORD_NAME;
- **set on the server**: extra names in the server's .env, as BEANPOOL_ADDRESSES=one.example.org,two.example.org (a domain of your own, or a proxy's name);
- **confirmed in Settings**: addresses an owner or admin confirmed here. Only these can be removed here.

If your server has no address set up (your own domain behind a proxy, with none of the above), it accepts any address for now and lists the ones apps used. Tap **Yes, … is its address** beside yours. After the date shown on the list, a server with no address refuses addresses it doesn't know. Until it has one, it also accepts its home-network address (such as 192.168.1.20). Once it has an address, it accepts only its listed ones, so if members' apps also reach it on your home network, confirm that address too.

A confirmed address travels with the take-over keys, so a standby that takes over accepts it too.

**Old apps.** The list also says how many apps too old to name a community reached your server today. Until the date shown, they keep working. After it, your server refuses them, and their members see a message asking them to update BeanPool from the app store. If the number stays high as the date comes near, remind your members to update.

## Node identity and the directory

**Node Identity** holds the community's name, contact email and phone, and the area it serves.

![Node Identity and directory settings in Settings](images/appliance-identity.webp)

By default your server tells the BeanPool directory about itself every 12 hours: the community's name, the area it serves, how many members it has, and the contact email and phone if you filled them in. That is how new people find you. Each part can be switched off here, and so can the whole thing. Your members' names and posts are never sent.

## Gateway

**Gateway & Peers** has the gateway switches:

- turn the market, messages, links with other communities, invites or the web app off for everyone;
- the rate limit (see Rate limits);
- which other websites may call your server.

![Gateway and Peers settings in Settings](images/appliance-gateway.webp)

Turning a feature off affects every member at once. Tell them first.

## Peers: other communities

Links between communities are off unless you switch them on in the server's .env: ENABLE_PEER_CONNECTORS=true lets your server talk to peers, and FEDERATION_SETTLEMENT=true lets members trade across the link. Then add a peer's address under **Gateway & Peers**. Trading between communities is new and little used; agree the terms with the other community's owners first.
