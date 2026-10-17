---
slug: private-preview
title: Private preview
summary: Close your server to everyone but its members and the people you invite, while you try it out before opening it.
related: rate-limits, updates-and-health, address-and-peers
---

A private preview keeps a new server closed while you and a few people you choose try it out. The apps can reach it normally, so you don't need a lock in front of it that phones can't get through.

## Turning it on and off

Set PRIVATE_PREVIEW=1 in the server's environment and restart it. To open the server, remove the setting (or set it to 0) and restart again. It is off unless you set it. It takes 1, true, yes or on, and 0, false, no or off. Any other value, or one kept in quotes, stops the server at start, and the log says why: a typo never leaves it open.

Members' faces keep their addresses either way: on every server, a face opens only from the address the server gave its members.

The Manager shows whether it is on, under Node Identity ("Private preview: on" or "off"). It can't be changed there: only the server's setting changes it.

## What changes while it is on

- **Joining.** Only an invite made by the server's owner or an admin lets someone in. Every other way in is refused with one sentence that the apps show as it is: "This community is in a private preview. Ask its owner for an invite." That covers the open door (12 secret words or a sign-in), asking to join, and an invite a member made, even one made before the preview. Members can't make invites during a preview; owners and admins can, even on a server that normally takes no invites, such as the global community. Each invite lets one person in and lapses after 30 days, as usual.
- **Visitors.** Someone who isn't a member sees nothing: no listings, map, people, feed or live updates. Their app shows the sentence above. The server still answers what an app needs to show that, to sign a member in and to take an invite, plus the checks other servers and the address service make (its version, its public information, its key check, a peer's member check). It also tells a key whether it is a member, but only that key, and only when it asks about itself.
- **Members.** Nothing changes. They sign in, recover with their 12 words or a sign-in, and use everything as before.

## Inviting someone

In the Manager, open **People & Safety**, then **Invites & QR**, press **Generate** to make a pass, and send it to the person. You can also sign in to the app as an owner or admin and make an invite there. Once they join, they are an ordinary member.
