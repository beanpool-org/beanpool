---
slug: app-floor
title: Raising the app's floor
summary: Making members update an old phone app, safely: one platform at a time, with a grace date, after checking how many it would stop.
related: updates-and-health, what-the-server-sees, troubleshooting
---

## What the floor does

Your server tells every phone app the oldest version it should run: the floor. An app below it shows a banner that cannot be closed while it is in use. Once the grace date has passed, it also stops with a full-screen **Update required** and one **Update** button that opens the store. It does that only at a safe moment: when the app starts, or when someone comes back to it after 5 minutes or more away. It never covers a screen while someone is using it.

The server never refuses an app because of its version. Whatever a member was doing when their app fell below the floor still reaches the server. Only the app stops, and only until it is updated.

A floor never stops anyone the store cannot help. Your server reads Google Play's and the App Store's newest versions itself, every 6 hours, and holds a platform's floor until its store has a version that meets it: Apple can take days to review a new version. If the server has not read a store's version, nothing is stopped on that platform.

## Setting it

In .env:

- **MIN_APP_VERSION**: the floor for both kinds of phone, for example 1.2.60. Unset, it is 1.0.75, below every app in use.
- **MIN_APP_VERSION_ANDROID** and **MIN_APP_VERSION_IOS**: a floor for one kind of phone, in place of MIN_APP_VERSION. A kind of phone without its own floor has MIN_APP_VERSION's.
- **MIN_APP_VERSION_FROM**: the grace date, from when an app below the floor stops. A date, such as 2026-10-15 (midnight UTC), or a date and time, such as 2026-10-15T09:00:00+10:00. Until then the app shows its banner only. Unset, an app below the floor stops at its next start.
- **MIN_APP_VERSION_FROM_ANDROID** and **MIN_APP_VERSION_FROM_IOS**: a grace date for one kind of phone.

Then run: docker compose up -d

A floor that is not a version is ignored. A grace date that is not a date turns the full-screen update off for that kind of phone until you fix it, and the log says so.

## Raising it safely

- **Look first.** Home's **Phone app versions** card shows, for Android and iPhone, how many people run each version, how many are below the floor, and what each floor is doing now. It counts the members and visitors seen in the last 30 days, or since the server last started.
- **Check the store has it.** The card says what Google Play and the App Store have. A floor above that waits by itself, and the card and the log say so.
- **Give a grace date** a week or so ahead, and tell members before it, with an announcement.
- **One kind of phone at a time** when the stores differ. If the App Store does not have the new version yet, give iPhones a later grace date of their own (MIN_APP_VERSION_FROM_IOS): an iPhone floor that waited for the store applies as soon as the store has the version, so without a later date iPhones would stop with no banner first.
- **Watch the card.** After the date, members update at their next start, and the numbers below the floor fall.

Apps from before the full-screen update show the banner only, whatever the date. They do not say their version, so the card does not count them, and they do not say which kind of phone they are on, so your server gives them the lower of the two floors: MIN_APP_VERSION, until you have raised both kinds of phone past it. While you raise one kind of phone at a time, they see no banner; once both are raised, they see it with the lower of the two numbers.

## Undoing it

A phone too old for the new version cannot install it, and its member cannot get past the screen into your community, which tells them to ask you. Lower the floor, or move the grace date later, and run docker compose up -d. A stopped app asks again every time it comes back to the front, and lets the member in.

## What the screen still lets a member do

The screen stops your community only, never the member's account. From it a member can:

- **Use another community** saved on the same phone. The app moves there, and that community's own floor decides. Coming back to yours is checked again, so your floor still holds here.
- **See their 12 words** on the screen itself, after the phone's own lock, or add them to a phone that has none, so they never lose the account.
- **Leave this community.** The phone forgets it and its copy, and opens the next community on the phone. Nothing is deleted on your server: the member can come back with an invite or their 12 words. On a phone with no other community, leaving takes the account off the phone, as Sign Out does, after showing the 12 words. Someone who never finished joining simply forgets your community and can use another invite.

None of these asks your server anything. Leaving only asks it, in passing, to stop sending that phone notifications, and never waits for the answer. So a server that sets a floor it should not, or answers anything else wrongly, can stop its own community on a phone, and nothing else on it.

## The web app

The web app has no floor. It is your server's own copy, loaded fresh every time a page opens, so it is always the server's version. A page left open across a server update shows a banner asking to refresh, and refreshing loads the new one. The floors are for the phone apps only.

Each server sets its own floor. A phone that holds several communities follows each one's floor while it is using that one.
