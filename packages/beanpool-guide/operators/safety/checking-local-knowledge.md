---
slug: checking-local-knowledge
title: Checking local knowledge
summary: Learn and its pages of Local knowledge: turning it off and on, checking what members suggest, keeping pages right, taking one down, a complaint about copied writing, and letting your AI assistant draft pages.
related: reports-and-takedowns, ai-assistant, core-settings, roles, pulse-and-announcements
---

**Learn** is where your community keeps its **Local knowledge**: short pages about your place, written by members, such as how recycling works at the tip or who to call when the road floods. Members reach it from Home, the Market's search, the Pulse and Add post, in both apps. The members' guide explains it to them in "Local knowledge". This page is what owners and admins need.

Nothing a member writes shows until an owner or an admin approves it. Moderators don't approve pages: their job is reports.

## Turning it off and on

In Settings, the **Core settings** card has a **Local knowledge (Learn)** row. Untick **Learn on** to switch it off. It is on by default on a local community and off on the global community, where anyone joins with 12 words and nobody can check who knows a place. The owners can change it either way. It is not one of the settings you lock, so it needs no unlock.

- **Off:** Learn, its Home card and its Pulse card leave both apps, every Learn request your server gets is refused, and your AI assistant's Local knowledge tools stop. Nothing is deleted: the pages, the suggestions waiting and their photos stay on your server and in its copies, for when it is on again.
- Members are told on Home either way: "Your community's owners changed how it works: Learn is on, with pages of things worth knowing about your community." or "…Learn is off. Its pages are kept for when it is on again."

## Checking what members suggest

You check pages in the web app, under **To check** in Learn. The phone app gets To check in a later update. In the web app, Learn shows an amber line such as **3 to check ›**, Home's **Learn something local** card shows it as its first row, and the bell's **Needs you** has a line for it. Owners and admins also get a push for each member's suggestion: "{name} suggested local knowledge: "{title}". Check it in Learn." None comes for your own assistant's drafts: you asked for those.

**Waiting** lists each one: **New** or **Fix**, who it is from (or which assistant gathered it, and for whom), and how long it has waited. Open one to see it as members would. A fix shows **What changed**, the member's note, then each changed part as **Now** and **Suggested**.

Under **Before you approve**, the screen asks you to be sure that it's about a place, a service or how to do something, not a private person; that it's in the writer's own words, not copied; and that you believe it's right, or the sources say so. Each source opens in your browser.

- **Approve**: a new page goes into Learn with the member as its writer, **Checked** this month, and the Pulse announces it. An approved fix changes the page now and keeps its writer.
- **Edit first**: the form opens with their words, for you to correct before you approve.
- **Not this one**: choose why (**It's about a person**, **It looks copied**, **I couldn't check it**, **We already have this**, **It isn't about this area** or **Another reason**), add a few words if you like (the writer reads them), and press **Send**.

The writer is told either way, in a notice that never names who answered. If their account is paused, Approve says so and the suggestion waits. If another owner or admin answered it first, you read "This one was already answered."

A member's photos come with their suggestion. **Remove photo** leaves one out, and **Approve** adds only the photos kept; you can't add one of your own to a member's suggestion.

Your assistant's pictures show the same way, with a line under each. One it uploaded says "Uploaded by the assistant. Keep it only if it is your own." One from Wikimedia Commons shows who made it and its licence, "From Wikimedia Commons. Read by this server on" and the day, any note Commons has on other rights (a person in it, a trademark), and **Open its page**, which opens its page on Commons. Keep one if it is the writer's own, or if it shows who made it and its licence. A kept Commons picture's credit goes onto the page as a line in its sources, written by your server; **Edit** and **Suggest a fix** never show it, and nobody can change or remove it.

Each member has at most 3 suggestions waiting and sends at most 5 in a day, and none while muted. What an owner or admin writes goes into Learn at once: **＋ Add local knowledge**, then **Publish**.

## Keeping pages right

On any page, owners and admins have **Edit** (it changes at once), **Still right** (it is confirmed as it is, and **Checked** moves to this month), **Mark as out of date** with a note, and **Clear the mark**. A page's writer can mark their own page out of date too. Other members can't: they tap **Something changed? Suggest a fix**, which waits in **To check** like a suggestion.

**Not checked for a year**, under the waiting list, holds the pages nobody has confirmed for more than a year, for you to look at. Nothing expires by itself.

## Taking a page down

In Settings, open **People & Safety → Triage & Moderation**. In the posts list, choose **Local knowledge** in the **Type Filter**: each page shows its topic. **Delete** takes it down for everyone, as for any post. **Prune Stale Posts** on the same screen never takes a page, however old: you take pages down one at a time.

Members report a page from the page itself, and the report lands with the others. A moderator can remove a page while a report on it is open, as for any post (see Reports and takedowns).

## A complaint about copied writing

If someone says a page copies their writing or their photo, take it down at once, as above, then talk to its writer. A page should be in its writer's own words, with links to where it can be checked, never text or pictures copied from elsewhere.

## Your assistant can draft it

Where Learn is on, an owner's or admin's AI assistant (see AI assistants) can look things up with its own web search and draft pages for you. Your server reaches no other server for it but Wikimedia Commons, for a picture the assistant names. It needs no extra tick when you connect it, because a draft changes nothing members see.

- A draft has 1 to 5 sources, and says whether it is about a place, a service or how to do something. One without a source, or about anything else, is refused: Local knowledge is never about a private person.
- It waits in **To check** like a member's suggestion, marked **Gathered with the assistant**. **Approve** waits until you tick **I opened the sources and they say this.**
- Once approved, the page is yours: it says **Gathered with the assistant from the sources above. Checked by** and your name. The assistant can't edit or remove it, and its tools for undoing what it posted never touch it.
- Its tools: **knowledge_list** and **knowledge_get** read the pages members read, never who wrote one, who it helped or a member's waiting suggestion; **knowledge_draft** files a draft; **my_knowledge_drafts** says how each ended; **knowledge_draft_withdraw** takes one back. It can't draft a fix yet: ask it what changed, and correct the page yourself.
- Two prompts in its menu: **draft-local-knowledge** finds something out and drafts it; **check-old-knowledge** checks the pages marked out of date or not checked for a year against their sources and tells you what changed.
- Pictures: only an owner's assistant that may post for them can add any, of two kinds: ones its owner took or owns, uploaded first, or ones from Wikimedia Commons under public domain, CC0, CC BY 4.0 or CC BY-SA 4.0, whose licence and maker your server reads itself. Never any other picture from the web: it belongs to someone else, and your community would be the one publishing it, so the server takes none, and the assistant is told to say so. A page without a picture shows its topic's picture, and you can add your own in **Edit first**. See "Photos: from the web, or uploaded first" in AI assistants.
- Limits: 10 drafts waiting and 20 a day for each connection, and 30 waiting from all assistants together, so members' suggestions are never buried. Disconnecting an assistant deletes its waiting drafts; pages a person approved stay. **Connected assistants** in Settings shows each one's drafts waiting.
