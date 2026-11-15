---
slug: forum-moderation
title: Running the forum
summary: Turning the forum on or off, its starting sections, first looks for new people on the global community, reports on forum posts, and what your server holds and copies.
related: reports-and-takedowns, global-limits, core-settings, what-the-server-sees, backups-and-replicas, roles
---

Every community has a forum: sections, topics with a title, and replies under them, in the Chat tab of both apps (**Chats · Forum** at the top). The members' guide explains it to members in "The forum". This page is what you need to run it.

## Turning it off and on

In Settings, the **Core settings** card has a **Forum** row: "Sections, topics and replies for members, in both apps." Untick **Forum on** to switch it off. It is on by default on every community. It is not one of the settings you lock, so it needs no unlock.

- **Off:** both apps stop showing the forum, and the Chat tab looks as it did before. Every forum request your server gets answers "This community’s forum is switched off by its owners." Nothing is deleted: the sections, topics, replies and photos stay on your server and in its copies, for when it is on again.
- Members are told on Home either way: "Your community's owners changed how it works: the forum is on." or "…the forum is off. Its topics are kept for when it is on again."

## Sections

A forum starts with its sections the first time your server finds none. On the global community: **News from BeanPool** (only owners and admins start topics there; anyone replies), **Introduce yourself**, **Start a community near you**, **Skills & how-to** and **Ideas for BeanPool**. On a local community: **General** and **Ideas for our community**. Their names are translated into each member's language.

Your server can make, rename, order and archive sections (12 at most), pin topics (2 a section) and move a topic, for owners and admins, but neither the apps nor Settings has a screen for it yet.

## Limits

- A title up to 100 characters, the opening words up to 5,000, a reply up to 3,000, a place in words up to 80. Up to 3 photos a post, each made at most 800 px by the app, refused over the same size as a listing's photo. Up to 5 links and 5 mentions a post.
- Each member: 10 topics and 100 replies in any 24 hours, removed ones counted. Owners and admins use the **Owner and admin limit** instead, as for posts.
- On the global community, a new account (still on probation): 2 topics and 10 replies (1 and 5 for 12 words); its links show as plain words; its photos only in a first topic that waits; its mentions tell nobody.
- 100 searches a day a member. The count is kept in memory, so a restart starts it again.

## First looks (global community)

On the global community a new account's first topic waits for a look before anyone else sees it. A waiting topic is not a topic: it is kept apart, so it can't show in a list, a search or a standby's topics by mistake. One can wait per member.

- **Who looks:** owners, admins and moderators. They see **Waiting for a first look** with a number at the top of the forum, in the apps, not in Settings. **OK, put it up** makes the topic in the writer's name. **No** asks for one of five reasons (spam or a scam, offensive content, misleading, unsafe or illegal, against this community's rules), which the writer is told. The writer is never told who looked.
- **The writer** sees how many hours a look usually takes, worked out from the last 20 answers, and can withdraw it. A topic nobody looks at within 30 days goes back to its writer, who is told.
- **Known:** a member stops waiting once a moderator has put one of their topics up, their probation is over (72 hours and 3 posts still up; 7 days for 12 words; forum posts count), or they hold a role.
- Moderators get "A first topic is waiting for a look." as an alert, under the members' **Forum** switch.

A local community has no first looks and no probation: topics go up at once. Neither is a setting you can change.

## Reports on forum posts

Members report a forum post from its **⋯** menu with the same reasons as any report. It lands in your moderation list as **Forum topic** or **Forum reply**, with the writer's name, the topic's title and the words.

- **Remove the post** takes it down and offers a reason, which the writer is told. A removed post reads "Removed by a moderator"; its words and photos are gone at once. A removed opening post blanks its topic's title: with others' replies the topic reads "A removed topic", is closed, and their replies stay.
- Where **Reported posts hidden and message requests cleared automatically** is on (the global community), a post reported in 3 independent circles is hidden (1 for a 12-words newcomer's post) until a moderator looks. Others read "Hidden while moderators look". **Restore (show it again)** brings it back.
- Where **Repeat offenders muted automatically** is on, a third removal in 30 days mutes the writer: no topics, replies or edits until a moderator lifts it.
- An owner's AI assistant can't read or take down forum posts.

## What your server holds

- The forum is not encrypted, like the Market: your server holds every topic, reply and photo, and you can read them. Tell members so; the guide does.
- The earlier wording of an edited post, the last 10 of them, for 30 days, for moderators. (Neither app edits posts yet.)
- On the global community, the time each member read "Anyone on the web can read this forum, with your name." Your server takes no first post there without it. The forum's own public web pages are not built yet: today only members read it.
- **A standby copies the whole forum.** Its search index is rebuilt on the standby itself. A standby takes no posts: they answer that it is a standby copy.
- **A member who deletes their account:** every post of theirs is blanked and its photos deleted, on your server and at the standby's next copy. **A member who moves to a new key** keeps their posts.
