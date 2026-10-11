---
slug: recovery
title: Getting your account back
summary: Restore your account on a new phone, and protect it with a sign-in account.
related: your-12-words, leaving-or-deleting, communities, faq
---

## On a new phone

Your account's key is not in your phone's backups. A new phone needs your 12 words or a sign-in account you linked, even an iPhone restored from a backup of your old one.

- Install BeanPool and open it.
- Tap **Already a Member? Restore Account**.
- Choose **Recover with 12 Words** or **Recover with Social**.

## With your 12 words

- Type the 12 words in order, or tap **Paste**.
- Type your community's name or address.
- Tap **Recover Identity**. Your name and photo come back from your community.

## With a sign-in account

This works only if you linked one before (see below), and only while your community's server is running.

- Type your name in the community. The app may suggest "Is this you?".
- Type your community's name or address.
- Tap **Recover with** and the account you linked: Google or Facebook, or Apple on an iPhone.
- With Google on an iPhone, a Google web page opens. Sign in there and choose the account you linked. On Android, Google shows its own list of accounts. If it can't show one on that phone, a Google web page opens instead.

If the sign-in account was linked from a phone that had your 12 words, on an up-to-date app, your 12 words come back too. Otherwise the phone has no 12 words: they can't be rebuilt from a sign-in. If you have them written down, you can add them (see "Your 12 words"). Until then a linked sign-in account is that phone's way back, so keep one linked, and link a second one if you can (see below).

## Protecting your account now

- Open **Settings** and tap **Account Protection**.
- Under **Sign-In Recovery Providers**, tap **Protect with** and choose an account.
- Pass your phone's lock screen check. The linked account can bring your account back, so the app asks first.
- With Google on an iPhone, a Google web page opens. Sign in there and choose your account, and you come back to BeanPool.

This works on a phone with no 12 words too.

If you joined the global community with 12 words, use **Add a sign-in**, near the top of **Account Protection**, instead. It is a way back too, and it also lifts the limits on a new 12-words account. See "Your 12 words".

If this phone has your 12 words, the linked account keeps them as well, so restoring with it gives them back. An account you linked on an older version of the app keeps only your key: tap **Connect again** next to it, and pass your phone's lock screen check, to include the words. On a phone with no 12 words there is nothing to include, so **Connect again** is not shown.

This is not a way to log in. Your account is still your own key. The linked account only helps you get it back, in that community.

To remove it, tap **Disconnect**.

## If you had linked GitHub

BeanPool no longer uses GitHub. A GitHub account's id is public, so a copy locked to it was not locked to anything only you have. When your community's server is updated, it deletes every copy linked to GitHub. Your account itself is not touched, and your 12 words still work.

- If GitHub was the only account you linked and your 12 words are on this phone but not written down, write them down now (**Settings**, then **View Recovery Phrase**), or link Google, Facebook or (on an iPhone) Apple, as above. Until you do one of these, this phone is your only way into your account.
- If your 12 words are written down, you have nothing to do. To have a sign-in account as well, link Google, Facebook or (on an iPhone) Apple, as above.
- If GitHub was the only account you linked, this phone has no 12 words and you have none written down, link Google, Facebook or (on an iPhone) Apple now. Until you do, this phone is your only way into your account.

## Who can open the copy

A linked sign-in account works because your community's server keeps a locked copy of your account for it. The people who run that server can open this copy, because their server checks your sign-in. On the global community, that is BeanPool. A stolen copy of the server's database can't, once the server has been updated for it. Anyone who takes over your sign-in account can get in too: see "If someone else tries".

If you would rather nobody but you could get in, use only your 12 words: keep them written down, and tap **Disconnect** next to each sign-in account. Disconnecting deletes the copy. A standby server, the second server some communities keep ready to take over, deletes its copy too, the next time it copies from the main one (about once a minute). Disconnecting does not delete the copies already in the server's backups, or the copy the server keeps, as a record, each time a sign-in brings your account back. The people who run the server can open those too.

## If someone else tries

If someone starts recovering your account, Settings shows **Someone is recovering your account** while it is under way. If it is not you, tap **Stop It Now**: your community's server then hands nothing more to that restore. If they get in with your linked sign-in account, you get an alert that your account was just restored on another device, and they may already be in by the time you see it. Keep that sign-in account safe, with its own strong password.

## If the phone already has an account

Restoring a different account replaces the one on this phone, whether you restore with your 12 words or with a sign-in account. The app asks first, on **Replace this phone's account?** (with a sign-in account, once you have signed in). Nothing changes until you type **WIPE**, tap **Replace Account** and pass your phone's lock screen check. Tap **Keep**, then the account's name, **go back** to leave everything as it was.

Make sure you have the 12 words for the account you are replacing. If this phone has them, that screen shows them when you tap **Show** (the account's name) **12 words** and pass your phone's lock screen check. If this phone has no 12 words for that account (Settings says so), without a linked sign-in account you cannot get it back.

## Lost your phone and your 12 words

Without your 12 words and without a linked sign-in account, an admin of your community can move your account to a new phone, with your Beans, your name and your history. Go and see them in person: they check it's you first.

- The admin makes a re-key code on their screen. If your old phone still has the app, it gets a notice that an admin started moving your account.
- On your new phone, open BeanPool, tap **Already a Member? Restore Account**, then **An admin gave me a re-key code**. Scan the QR on the admin's screen, or type the code (it starts RK-) and your community's name. In a browser, the QR's link opens the same screen; or open your community's web app, tap **I'm Already a Member →**, then **An admin gave me a re-key code**, and type the code.
- Your phone shows a two-digit number, and under it the address of the community it asked. Show both to the admin: they type the number on their screen. The number makes sure it's your phone they bind, and not someone who saw the code. **Back** leaves the number for now: your phone keeps its place, and the same code shows the same number again.
- If the new phone had no BeanPool account, it then shows the 12 words of your **new** key. Write them down: your old words no longer work, and your old phone stops working for good. A phone that already had an account (for another community) keeps that account's 12 words, and they now bring this account back too.
- If you had linked a sign-in account, your phone asks you to link it again in Account Protection: the one you had protected your old key, so it was removed.

The code lasts 24 hours. If your admin says your phone isn't the one they saw, or the code runs out, ask them for a new one.
