---
slug: address-and-peers
title: Address, identity and peers
summary: Your community's web address (a free .beanpool.org name, your server's IP address or your own domain, with the certificates your server gets by itself), the addresses members' apps use, what it tells the BeanPool directory, the gateway switches, and links to other communities.
related: first-time-setup, what-the-server-sees, rate-limits, updates-and-health, backups-and-replicas, access-and-security
---

## Public address

**Appliance & Data**, then **Public Address**. Members' apps need an address to reach your server.

- You can claim a name ending in **.beanpool.org** here. Some names, such as big cities, wait for approval by the BeanPool project.
- You can also give the name at install, before anyone signs in: docker compose exec beanpool-node beanpool claim --name NAME (see First-time setup). Your server claims it with its own key. Once your server has an address, it changes only here, by an owner.
- The usual way in is a tunnel: your server runs Cloudflare's tunnel program, cloudflared, inside its own container and dials out to Cloudflare, so it needs no open ports and its own address stays hidden. Nothing extra to install or start: it comes up as soon as the name is live. The other way points the name straight at your server, which needs a public IP address and port 443 open.
- Claiming the name, changing the community's name or contact on it, **Take offline**, **Release**, **Restart tunnel** and **New tunnel key** are an owner's: an owner signed in with their key, or the admin password, which counts as one. An admin sees the address and the tunnel; asked to change the address, the server answers "Only an owner of this node can change its public address", and asked to restart the tunnel or give it a new key, "Only an owner of this node can restart its tunnel or give it a new key".
- **Take offline**, **Release**, and claiming a different name over the community's live address ask the fresh proof each time (claiming a first name, or the same name again, does not) (Access and security): with the password, a **Current code** box opens for the code the authenticator shows now; from the phone, the change goes through within 90 seconds of pressing Manage; on a computer signed in with the phone, Settings says "Do this from your phone: open BeanPool, press Manage, then make this change there."
- Your server's key can hold a second name it doesn't use: the name asked for at install, if the address service gave it only after an owner had picked another one here. Your community stays on the name it has; it is never moved onto the other one. An owner sees one line about it: "This community also holds NAME.beanpool.org from the install; it is not used. Release it?" **Release** asks first ("Release NAME.beanpool.org? Your community's address stays …"), then lets go of that name only, never your community's address. If the address service answers about any other name, Settings says it was not released, and if that other name is your community's address, your server claims it straight back. If the address service can't release a single name by name (an older one), the line has no button.
- Only an owner sees the tunnel's key (the **Tunnel Token**). Anyone holding it could answer at your address and see some of your visitors' traffic, owners' sign-ins included, so an admin sees "Only an owner can see the tunnel token" instead.
- The panel shows the tunnel as it is: connected, retrying and why, or not running. **Restart tunnel** restarts it; visitors' connections drop for a few seconds. If the BeanPool project re-makes your tunnel, your server picks up the new key by itself within a few minutes.
- Opening the panel asks the BeanPool address service only about a .beanpool.org name your server holds or has been asked for. With no such name (none yet, or only your server's own IP address or domain), your server answers from what it holds, so the panel opens the same whether or not the BeanPool project's servers can be reached. With a name, if the address service can't be reached, the panel shows the name as your server last stored it, with one line: "The BeanPool name service can't be reached right now." Nothing is wrong with your server, and your community keeps its name.
- Every few minutes the BeanPool address service checks that the name still answers with your server's key. If something else answers there instead, it **pauses** the name. That might be another BeanPool server, or, for about an hour, something that isn't a BeanPool server at all, such as a stranger's website. While the name is paused, visitors can't reach your community at that address. But the name stays yours, and nobody else can claim it. The panel says **Paused** and why.
- You don't need to do anything about a pause. Your server asks for the name back by itself within a few minutes. It gets it back as soon as it shows its own key, on a new tunnel that only your server is given, so whoever was answering there is cut off. The one exception is a pause by the BeanPool project itself: only the project can lift it.
- **New tunnel key** gives the tunnel a new key, and the old key stops working at once. Use it if someone else may have only the tunnel's key: someone saw it on this screen, or you gave away a machine that was a standby. Anyone with the old key could answer at your address. Your server switches to the new key by itself; visitors' connections drop for a few seconds.
- **Notices from the address service.** The BeanPool project, which runs the address service, can send your community a notice about its address: that its name is set up, that it was blocked by mistake, that maintenance is coming. Your server hears it the next time it checks in with the address service (within 15 minutes, even while the name is blocked), shows it here under **From your address service**, and tells its owners there is a message. The alert says only that; the words are here. A notice may carry **Reply**: a link that works once, for 14 days, to answer the BeanPool project without giving an address. Only an owner is given it; an admin reads the notice and is told that an owner can reply. Nothing is collected to send you notices, and your server needs none of them to keep working.
- The contact on the name is optional. Only the BeanPool project sees it, to reach you about the name; it is never checked, and it is deleted when the name's hold ends.
- **New tunnel key does not help if a copy of this server's data folder, or a backup, went somewhere it shouldn't.** That copy holds your server's own key, which is what the name belongs to, and a server started from it gets the new tunnel key from the address service on its own. Nothing in Settings replaces your server's own key. Keep the data folder and backups private, and if a copy may have got out, contact the BeanPool project, who run the address service, and say so.

![Public Address configuration in Settings](images/appliance-network.webp)

## Your own address: an IP address or a domain

Your community needs no BeanPool name. Members' phones can reach it at your server's public IP address, or at a domain of your own, over real https. BeanPool does not need to be involved. The free .beanpool.org name above is a convenience: a tunnel, so there are no ports to open. Nothing else in your community depends on it, and a server can have both.

**What your server does by itself.** For its public IP address, and for each domain of its own it answers to, your server gets its own certificate from Let's Encrypt. It needs no Cloudflare account and no access to your DNS. Let's Encrypt asks your server for a short answer on port 80 (the http-01 check), and your server gives it. Each certificate is renewed when a third of its life is left. A certificate for an IP address lasts about 6½ days, so that one is renewed about every 4½ days. Your server checks every hour, and the old certificate keeps working until the new one is in place, with no restart. A .beanpool.org name never needs one: Cloudflare holds those.

**What you do:**

- Open ports 80 and 443 to the internet: in your hosting company's firewall, and in the server's own if it has one. Port 80 is for Let's Encrypt's check: it fetches http://YOUR-ADDRESS/.well-known/acme-challenge/… from port 80 at your address, so that must reach your server. Port 443 is where phones connect. docker-compose.yml already publishes both on the server.
- For a domain, make an A record for it with your server's public IP address, wherever your domain's DNS is run.
- Give your server the address: at install with beanpool claim --ip or --address (see First-time setup), or later with **Your own address**, below.

Before it asks Let's Encrypt, your server checks itself: it fetches its own answer from the address, over port 80, as Let's Encrypt will. If that fails, it says why in words, in Settings and to beanpool claim. It still asks Let's Encrypt, at most once a day, because a home router can fail the check from inside while Let's Encrypt reaches the server from outside. After a failed try it waits 1 hour, then 4 hours, then a day between tries, and tries more often as a certificate it already has nears its end. So a typo or a closed port costs nothing, and your server stays far under Let's Encrypt's limits.

### Your own address in Settings

Owners see **Your own address** under **Public Address**. Admins don't. It lists every address your server holds a certificate for or is asking for one, with where the address comes from. Each one says "Certificate valid until … Renews about …", or the last try, why it failed, and when it tries next.

- **Use this IP address** and **Use this domain** give your server an address. It starts asking for the certificate at once. That takes a minute or two once the address leads to your server.
- Putting another IP address in place of the community's IP address, or another domain in place of its domain, asks the fresh proof (Access and security). Giving an address otherwise doesn't: a domain given after an IP address becomes the community's address and the IP address stays one of its addresses, and an IP address given after a domain, or either beside a name, is kept beside it.
- **Try again now** shows for an address an owner gave while it has no certificate or its last try failed. Fix what it said (port 80 closed, no A record yet), then press it: your server tries at once instead of waiting.
- **Remove** asks first, then the fresh proof. Members' apps that use the address are refused after it.
- On a standby, the card says it asks for no certificates. On a server set to Let's Encrypt's test service (ACME_DIRECTORY_URL in .env), it says that phones and browsers do not trust the certificates it gives.

### Behind a home router, or behind a proxy

**Behind a home router** with no ports forwarded, use a .beanpool.org name. Nothing on the internet can reach your server to check an IP address or a domain. If you do forward ports 80 and 443 to it, an IP address or your own domain works the same way. But a home connection's IP address can change at any time, and only a name survives that.

**Behind a web server or proxy of your own** that holds the certificate for your domain, give the domain under Your own address as usual (**Use this domain**, or beanpool claim --address https://your.domain). When the community has no address yet, that makes it the community's address, the one the BeanPool directory lists (the list above says when a domain replaces an address it already has). Listing it only in BEANPOOL_ADDRESSES (Addresses members' apps use, below) lets members' apps use it but gives the community no address, so the directory has none to list. Your server still tries to get a certificate of its own for that domain, over port 80. Where the proxy does not pass /.well-known/acme-challenge/ on to your server, that fails quietly: the card says why, Let's Encrypt is asked at most once a day, no alert is sent, and phones see your proxy's certificate.

### Certificate alerts

Owners are told when a certificate could not be renewed for a day after it was due, when one has less than a day left, and when one expired before it was renewed. Each alert names the address it is about. Act on the first one: phones and browsers refuse an expired certificate exactly as they refuse a self-signed one, and your server has nothing else to show them. The full list of alerts is in Updates and health.

### A number or a name

A name survives a change of server; a number does not. If your server or its IP address changes, every member who uses the number has to type the new one. A name can be pointed at the new server.

- At an IP address, members' phones reach the community at https://203.0.113.5, as they would at a name. The owner's phone says what that means, after the claim and under **Manage**: "Members reach this community by its server's number, 203.0.113.5. If the server or its number changes, each member will have to type the new one. A name follows the community: Settings → Public Address." It never blocks anything and has no deadline. It goes once the community has a name.
- To move to a name later, claim a .beanpool.org name above, or give your own domain under Your own address. The IP address stays one of the community's addresses until an owner removes it, so every phone that uses it keeps working. New members are sent to the name.
- Once a member's phone has heard of the name (BeanPool asks when it starts), Home shows one card: "This community is also at yourtown.beanpool.org. Use that address from now on?" It shows only after the phone has checked, at both addresses, that it is the same community. **Use the new address** moves the phone there, with what it keeps for your community, messages included. **Not now** asks again in 7 days. Nothing moves on its own. The web app shows no card: tell members who use it the new address.
- A phone that never heard of the name before the number stopped answering can't follow it: nothing can tell that phone where the community went, and the member has to type the new address. Keep the old address answering until your members have moved.

### A standby, and moving to a new server

Certificates and their keys never travel: they are not in a backup from Settings or in the take-over keys. A standby asks for none. After it takes over, it gets its own once the address leads to it: for a domain, point the A record at the new server; a .beanpool.org name needs nothing. A community reached only by an IP address can't follow it to a new server, which has another IP address. The take-over preview says so: "Members reached this community at 203.0.113.5, which this server does not have. They will need its new address."

## Addresses members' apps use

Also under **Public Address**. A member's app signs every request for the address it reaches your community at, and your server accepts only its own addresses. So the owner of another community can't copy a member's request and use it here, for example to send that member's Beans or delete their account.

The list shows each address with where it comes from and how many apps used it today and on the busiest day this week:

- **this community's web address**: the name you claimed above; on a server with no .beanpool.org name or CF_RECORD_NAME, the IP address or domain given with beanpool claim or under Your own address (once it has a domain, a later IP address is kept beside it); or the server's CF_RECORD_NAME;
- **set on the server**: extra names in the server's .env, as BEANPOOL_ADDRESSES=one.example.org,two.example.org (a domain of your own, or a proxy's name). Write a name with letters outside a–z in its punycode form, which starts with xn-- (bücher.example is xn--bcher-kva.example). An entry that isn't an address is left out, and the server's log names it when the server starts: check the list here after changing the .env. Your server tries to get its own certificate for each one that is a public name or IP address, never for localhost or a home-network one (Your own address, above);
- **confirmed in Settings**: addresses an owner or admin confirmed here, and an IP address or domain given beside the community's web address. Only these can be removed here, by an owner, with the fresh proof each time.

If your server has no address set up (for example your own domain behind a proxy that was never given under Your own address), it accepts any address for now and lists the ones apps used, with how many members' apps used each and whether yours or an admin's did. Open Settings at your community's own address (for example https://example.org/settings) and tap **Yes, … is its address**: only the address Settings is open at is offered with one tap. Any other address on the list needs you to tick **This is this community's address** first, because a member's app can be made to use any address, and one person can join more than once. A name ending in .beanpool.org is never offered: that is another community's. A server that keeps the BeanPool directory (the global community's does) also says when the directory lists an address as another community's, names that community, and asks you to tick that it is this one. Other servers don't keep the directory, so they can't warn you about that. Confirming another community's address would let what members' apps send that community be copied and used here, so never confirm one just because someone asked you to. After the date shown on the list, a server with no address refuses addresses it doesn't know. Until it has one, it also accepts its home-network address (such as 192.168.1.20) and the server's own name for itself (localhost). So you can open its web app through an SSH tunnel at localhost without setting anything.

Once your server has an address, it accepts only its listed ones. It refuses localhost too, unless you list it. So if members' apps also reach it on your home network, confirm that address too. To open its web app through an SSH tunnel at localhost, add BEANPOOL_ADDRESSES=localhost to the server's .env (an IPv6 address goes in brackets, as [::1]), and remove it when you no longer need the tunnel: while it's listed, a request signed for localhost anywhere counts here. Localhost is never an address of your community: a server with only localhost listed still has no address set up, and the list says so. Only this list shows localhost; apps and the directory never see it.

A confirmed address travels with the take-over keys, so a standby that takes over accepts it too.

**Old apps.** The list also says how many apps too old to name a community reached your server today. Until the date shown, they keep working. After it, your server refuses them, and their members see a message asking them to update BeanPool from the app store. If the number stays high as the date comes near, remind your members to update.

## Node identity and the directory

**Node Identity** holds the community's name, contact email and phone, and the area it serves.

![Node Identity and directory settings in Settings](images/appliance-identity.webp)

By default your server tells the BeanPool directory about itself every 12 hours, and at once when an owner names or renames the community: the community's name and web address, the area it serves and how many members it has. It also says whether people can ask to join from the directory (requests to join are on, inviting isn't for admins only, and the community has a web address to ask at), the day the community closes if an owner has set one, and the listing promise if the community keeps it (below). That is how new people find you, and how the global community passes on requests to join. The directory is public: anyone can read it, and the map on beanpool.org shows it.

The pin you drop on the map here is the community's place, and the area is that pin and how far the community reaches. **Share Location & Radius** decides who else sees it. On (the default), anyone gets the pin rounded to about a kilometre: the directory and the map on beanpool.org, and your server's own public pages to anyone who asks, so people nearby can find you and nobody starts a second community on top of yours. Off, nobody outside the community gets it at all: the directory is told no area, and your server gives the place only to its members (still to about a kilometre, so their maps start in the right place) and to owners and admins (exactly, here). Turned off, the map on beanpool.org loses your pin at your server's next update (**Publish Now** sends it at once); the community stays listed by name.

The contact email and phone are not sent unless you turn each on here: **Share Email in Directory** and **Share Phone in Directory**. Both are off until you do, even on a server that published them before, and until then your server's own public pages don't show them either. The area, the member count and the health report can each be switched off here. The name and web address are always sent. Setting **Update Schedule** to **Never (Disabled)** stops your server sending anything, but the directory keeps the last entry it received, as it was then, until BeanPool removes it: let one update go out first, so that entry holds no contacts. Your members' names and posts are never sent.

### Message requests

**Message Requests** decides what happens to a member's first message to someone who hasn't added them as a friend, written to them, or traded with them. On, it is held as a request until that person accepts it: they can read it, and the sender can write nothing more until they accept. The sender is never told whether it was ignored or whether they were blocked. Messages from owners, admins and moderators, and the chat that comes with a deal, always arrive straight away. A request nobody accepts lapses after 30 days, and the sender's next message is a new request.

It is on by default on a global community, where anyone can join with 12 words, and off on a local community, where everyone was let in by someone. Turned off, every message arrives straight away, and a request still waiting becomes an ordinary chat. One a member ignored stays out of their chats until one of the two writes in it again. Like every profile switch, it travels with backups and to standbys.

### When the directory doesn't list your community

Your server sends the directory nothing while either of these is true. **Node Identity** says which, in a line under **Publish Now**, and so does the server's own settings page:

- **The community has no name of its own**: its name is blank, or exactly "BeanPool Community". Type the community's name in **Community Name** and press **Save**. Your server tells the directory at once, with no restart. First-time setup asks for the name too, and won't go on without one.
- **The server's .env sets DIRECTORY_UNLISTED=1** (or true, yes or on). This is for test and review servers, which should never be a pin on the public map. To be listed, remove that line and run docker compose up -d. A value your server doesn't recognise, such as DIRECTORY_UNLISTED=ture, counts as not set: the community is listed, and the server's log says so when it starts.

While either is true, **Publish Now** says **Not listed**, and why. An entry the directory already holds is not removed: it stays as it was until your server sends a new one.

To check the name your server sends, from anywhere, open https://YOUR-ADDRESS/api/directory/info. Its communityName must be your community's name: null means it has none yet.

### The listing promise

A listed community can promise four things to the people the directory sends it: it has two owners; its backups are locked with a recovery code and running (scheduled snapshots on, or an off-box destination set); reports are looked at within a week; and members get thirty days' notice before it closes. An owner makes the last two. Your server checks the first two itself every time it tells the directory, and leaves the promise out when either stops being true: when one owner is left, say, or snapshots are turned off and nothing goes off the box. The owners' diagnostics say why it was left out. What the directory gets is counts and yes-or-no only: how many owners, never who.

Among communities at about the same distance from the person looking (in steps of 25 km), those that keep the promise and take requests to join are listed first, the rest after, each group shuffled. The Home card keeps one order for a reader until the directory next updates; the full list is shuffled again whenever it is fetched afresh. The member count never decides the order. The promise never decides whether a community is listed or can run. In https://YOUR-ADDRESS/api/directory/info, promise is null until your community keeps it.

## Gateway

**Gateway & Peers** has the gateway switches:

- turn the market, messages, links with other communities, invites or the web app off for everyone;
- the rate limit (see Rate limits);
- which other websites may call your server.

![Gateway and Peers settings in Settings](images/appliance-gateway.webp)

Turning a feature off affects every member at once. Tell them first.

## Peers: other communities

Links between communities are off unless you switch them on in the server's .env: ENABLE_PEER_CONNECTORS=true lets your server talk to peers, and FEDERATION_SETTLEMENT=true lets members trade across the link. Then add a peer's address under **Gateway & Peers**. A link is either a peer or blocked. A standby is not a link: it is paired with its main server from its own shell (see Which server a standby trusts, in Backups and replicas). Trading between communities is new and little used; agree the terms with the other community's owners first.
