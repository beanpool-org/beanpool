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
- **set on the server**: extra names in the server's .env, as BEANPOOL_ADDRESSES=one.example.org,two.example.org (a domain of your own, or a proxy's name). Write a name with letters outside a–z in its punycode form, which starts with xn-- (bücher.example is xn--bcher-kva.example). An entry that isn't an address is left out, and the server's log names it when the server starts: check the list here after changing the .env;
- **confirmed in Settings**: addresses an owner or admin confirmed here. Only these can be removed here.

If your server has no address set up (your own domain behind a proxy, with none of the above), it accepts any address for now and lists the ones apps used, with how many members' apps used each and whether yours or an admin's did. Open Settings at your community's own address (for example https://example.org/settings) and tap **Yes, … is its address**: only the address Settings is open at is offered with one tap. Any other address on the list needs you to tick **This is this community's address** first, because a member's app can be made to use any address, and one person can join more than once. A name ending in .beanpool.org is never offered: that is another community's. A server that keeps the BeanPool directory (the global community's does) also says when the directory lists an address as another community's, names that community, and asks you to tick that it is this one. Other servers don't keep the directory, so they can't warn you about that. Confirming another community's address would let what members' apps send that community be copied and used here, so never confirm one just because someone asked you to. After the date shown on the list, a server with no address refuses addresses it doesn't know. Until it has one, it also accepts its home-network address (such as 192.168.1.20) and the server's own name for itself (localhost). So you can open its web app through an SSH tunnel at localhost without setting anything.

Once your server has an address, it accepts only its listed ones. It refuses localhost too, unless you list it. So if members' apps also reach it on your home network, confirm that address too. To open its web app through an SSH tunnel at localhost, add BEANPOOL_ADDRESSES=localhost to the server's .env (an IPv6 address goes in brackets, as [::1]), and remove it when you no longer need the tunnel: while it's listed, a request signed for localhost anywhere counts here. Localhost is never an address of your community: a server with only localhost listed still has no address set up, and the list says so. Only this list shows localhost; apps and the directory never see it.

A confirmed address travels with the take-over keys, so a standby that takes over accepts it too.

**Old apps.** The list also says how many apps too old to name a community reached your server today. Until the date shown, they keep working. After it, your server refuses them, and their members see a message asking them to update BeanPool from the app store. If the number stays high as the date comes near, remind your members to update.

## Node identity and the directory

**Node Identity** holds the community's name, contact email and phone, and the area it serves.

![Node Identity and directory settings in Settings](images/appliance-identity.webp)

By default your server tells the BeanPool directory about itself every 12 hours: the community's name and web address, the area it serves and how many members it has. That is how new people find you, and how the global community passes on requests to join. The directory is public: anyone can read it, and the map on beanpool.org shows it.

The contact email and phone are not sent unless you turn each on here: **Share Email in Directory** and **Share Phone in Directory**. Both are off until you do, even on a server that published them before, and until then your server's own public pages don't show them either. The area, the member count and the health report can each be switched off here. The name and web address are always sent. Setting **Update Schedule** to **Never (Disabled)** stops your server sending anything, but the directory keeps the last entry it received, as it was then, until BeanPool removes it: let one update go out first, so that entry holds no contacts. Your members' names and posts are never sent.

## Gateway

**Gateway & Peers** has the gateway switches:

- turn the market, messages, links with other communities, invites or the web app off for everyone;
- the rate limit (see Rate limits);
- which other websites may call your server.

![Gateway and Peers settings in Settings](images/appliance-gateway.webp)

Turning a feature off affects every member at once. Tell them first.

## Peers: other communities

Links between communities are off unless you switch them on in the server's .env: ENABLE_PEER_CONNECTORS=true lets your server talk to peers, and FEDERATION_SETTLEMENT=true lets members trade across the link. Then add a peer's address under **Gateway & Peers**. Trading between communities is new and little used; agree the terms with the other community's owners first.
