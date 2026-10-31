---
slug: decisions-and-emergencies
title: Decisions, emergencies and removal
summary: How the community's votes run by themselves, the emergency suspension, removing someone, and halting a Decision.
related: roles, members-and-invites, enterprises-and-keepers, disputes
---

The community governs itself through Decisions. Members propose and vote in the app. Settings is where owners and admins watch them, and step in when something goes wrong.

## How a Decision runs

- Voting is open for **7 days**. When it closes, the server counts the votes within a minute and, if it passed, carries it out by itself. No admin has to press anything.
- Enough people must vote: at least 3, and at least 30% of members active in the last 30 days (25% for removing someone).
- It passes with 60% yes. Removing someone needs 66% and at least 3 yes votes, whatever the share; restoring someone needs just over half. A tie fails.
- Votes are secret: members and admins see only the totals. See Privacy and what your server can see, for what the server itself keeps.
- Each member can have one open Decision at a time. Frozen and suspended members cannot propose, and cannot vote, with one exception: someone suspended in an emergency still votes on every other Decision while the community votes on removing them, and counts in its turnout. Nobody votes on a Decision to remove them.

What a passed Decision can do by itself: suspend or restore a member, freeze or unfreeze, give or take away vouching, remove an enterprise's lead keeper, and pay grants from the commons. A grant the commons cannot yet afford waits in a queue; only one can wait at a time, and it fails after 90 days.

Two other kinds of vote are not the community's. The keepers of an enterprise vote among themselves to pay Beans out of it, to remove a keeper, or to make another keeper the lead (see Enterprises, keepers and the commons). The members of a chat group vote on its lead convenor, its convenors, removing someone from the group, who may join, and closing it. Each runs 7 days, ends early once the result cannot change, and needs more than half of the people on its list to vote. They do not count towards a member's one open Decision. Settings does not show them, and **Halt this Decision** does not reach them: owners and admins hold no power over a group.

## Watching them

**Shared Projects & Economy**, then **Proposals**, shows open votes and removals that are waiting out their grace period, with the totals so far.

On the global community there are no community votes. There the list shows emergency suspensions, each with the day it lifts and no vote totals, under the heading **Suspensions**. A suspension made while votes were switched off stays one nobody votes on, and shows that way, even if votes are switched back on before it ends.

![The Proposals and Decisions screen in Settings](images/economy-decisions.webp)

## Emergency suspension

For when someone is doing harm now. Open the person (People & Safety, then Members) and choose **Suspend**. Write a reason of at least 10 characters: every member will see it.

- They are suspended at once and their role, if any, is set aside.
- While it lasts, their listings are off the Market and the map, and they bring nobody in: no invite, no answer to a request to join, and an invite or paper ticket they made earlier admits nobody. They can still answer in their chats with one person (not in a group's, an event's or an enterprise's chat) and finish or cancel the deals they have open. Their listings and invites come back as they were when it ends.
- A suspension made when acting on a report is the same suspension, and the same vote opens, with the reason given, or that a report about them was upheld.
- A 7-day vote opens on removing them: "Remove …?". It is decided as any removal is: one member, one vote, 25% turnout, 66% and at least 3 yes votes to remove. They cannot vote on it, and still vote on every other Decision, so suspending someone cannot swing another vote.
- If it does not pass, or too few vote, the suspension lifts when the vote closes and their role comes back. Where fewer than 3 members could vote at all, an owner may decide it (see Too few to vote).
- If it passes, they stay suspended through a removal's 7 days' grace, and are then removed (see Removing someone).
- No vote removes an owner or admin: on one of them, the suspension ends when the vote closes, whatever it decides, and their role comes back.
- A "Keep the suspension?" vote opened before this version runs to its end as it did.
- You cannot suspend yourself, an enterprise, or the last owner. Only an owner can suspend an owner.
- The vote names who suspended them: members read your name on it, never your key. Suspended with the server's password, it says an owner did.
- The suspended person is told at once: an alert on their phone, and a notice the web app shows when they open it. They can reply to the case on the vote itself, and everyone who reads the vote sees the reply beside it. If they delete their account, the reply goes with it, and an admin can take down a reply that harms someone (see Taking down a reply). Everyone who can vote on it gets an alert too, which never says who it is about.
- **The cool-down:** if a vote on removing someone you suspended ends without removing them (it fails, too few vote, or it is halted or lifted before it closes), you can't suspend them again for 90 days, from their page or from a report. Settings says until when. Another admin can, once the first 30 days are over (below). A removal the community passed that an admin then halted doesn't count.
- **Again within 30 days, an owner, with a new reason:** after a vote on removing someone ends without removing them, only an owner (or the server's password) can suspend them again in the next 30 days, and the reason can't be the one the last suspension gave. Settings says until when. The new vote says so to members: "Second pause in 30 days", and how the last vote ended. A removal the community passed that an admin then halted doesn't count.
- **Not a third time in 90 days:** a third suspension of the same person within 90 days of the first is refused to everyone, owners and the server's password too. If the community has more to decide, a member proposes a Decision, for example to suspend them.
- **The owners are told of every suspension,** on the alert channel that tells them of removals: how many in the day, and whether an admin, an owner or the admin password made them, never who was suspended or why. A vote's card says who suspended whom.
- **More than five at once:** an admin with five suspensions whose votes are still open makes another only with an owner's fresh proof. An admin asks an owner to make it; an owner presses Manage on the phone (with the server's password, a current code). Suspensions that fail before the proof is asked, for another reason, don't use it.
- None of these apply on the global community, where there is no vote, except that the owners are told.
- In their groups, a suspended convenor can use none of a convenor's tools until the suspension ends, and a suspended member joins no group. They stay a convenor, and a group's lead convenor stays its lead convenor: suspending someone never moves a group to anyone else.

On the global community no vote opens. The suspension lasts 7 days and then lifts by itself, and their role comes back, unless you lift it sooner. To keep someone out for longer, suspend them again, or remove their account. The suspended person gets no notification there: tell them yourself.

## Hiding a false case

When the case on a vote on removing someone is shown to be false, **Hide case** on that vote (open, in its grace period, or under **Closed votes on removing a member**) hides it. Write a reason of at least 10 characters: members read it in the case's place. Who brought the case and the member's reply stay; Settings keeps the case and who hid it. A case is hidden once and stays hidden.

Any owner or admin can hide a case, except the one the vote is about. No vote removes an owner or admin, so their role comes back when the vote closes, but they still can't hide its case, just as they couldn't vote on it. Another owner or admin can. The server's password is shared, so the node can't tell who signs in with it: an owner a vote was about who uses the password to hide its case is not stopped.

Hiding doesn't stop the vote. To stop it, halt it (below), which lifts the suspension.

The member the vote is about can report the case as a false accusation from the vote. It arrives in Reports like any other, about whoever brought the case. If they already had a report waiting about that person, the case is added to it.

## Taking down a reply

Everyone who reads a vote on removing someone reads the member's reply beside the case. When a reply harms someone else, for example it gives their address or phone number or threatens them, **Take down reply** on that vote (open, in its grace period, or under **Closed votes on removing a member**) takes it down. Settings shows you the reply first. Write a reason of at least 10 characters: members read it in the reply's place.

- The reply is deleted, not hidden: nobody can read it again, Settings included, and your standby drops it at its next copy. A snapshot or backup made before still holds it until it is replaced.
- The node keeps when, which admin, and why. Members read the reason, never who.
- The member is told: an alert on their phone, and a notice the web app shows. Neither says why or who; the vote does. They can't write another reply on that vote.
- The vote itself carries on, and the case stays as it is. A reply is taken down once.
- Owners and admins can take a reply down. Moderators can't.

## Removing someone

Only the community removes a member, by a Decision, and that vote opens only when someone is suspended (above): nobody proposes one, member or admin. A removal a member proposed before this version still runs to its end. When it passes, the person is suspended and frozen at once, and has **7 days' grace**. After that they are removed automatically, and their balance or debt goes to the commons. In those 7 days, **Offboard** on their page settles their beans as you choose (to the commons, or to a member) and completes the removal at once.

Three exceptions. Where fewer than 3 members could vote at all, an owner may decide the vote (see Too few to vote). An owner can still remove a member together with everyone they invited (**Prune Branch**, see Members and invites), until a branch can be put to one vote. And where community votes are switched off, the admins remove members themselves (**Prune Account** and **Offboard**).

No Decision can remove or suspend an owner or admin of your server, one whose role a suspension has set aside included: the app refuses it when someone proposes it, and one that was already open is stopped before it is carried out. The people who run the server cannot be voted out of it, not even by the vote that opens when one of them is suspended (above). If an admin must go, an owner takes the role away first; after that they are a member like any other.

## Too few to vote

In a small community a removal needs at least 3 yes votes, so two neighbours can't remove a third: with 7 active members, 3 of the other 6 must vote yes; in a family of four, all three others. When fewer than 3 members, not counting the person suspended, could vote at all, the vote can never reach its turnout, and left alone the suspension lifts when it closes, whatever they think. The vote still runs its 7 days, and its card tells members: "Fewer than 3 members could vote. If nobody else votes, the owner decides when it closes."

- **An owner decides.** In **Shared Projects & Economy**, then **Proposals**, the vote says so and has **Decide as owner**. Only an owner sees it. Write a reason of at least 10 characters: every member reads it on the vote, beside the case. It asks an owner's fresh proof every time: press Manage on the phone, or with the server's password, a current code. An admin can't decide it, nor can an automation token, and a computer's session is told to do it from the phone. A short reason, or a vote enough members can vote on, is refused before the proof is asked.
- The suspended person is told at once, and can reply to it. The owners are told on their alert channel: how many in the day, by an owner or the admin password, never who or why.
- If an admin hides the case as one shown to be false, the owner's reason goes from what members read too, since it may repeat the accusation: the vote says an owner decided, and Settings keeps the reason. It changes nothing else: to stop the removal, halt it.
- **When the vote closes,** if still fewer than 3 could vote, the decision is carried out: the removal's 7 days' grace begins, recorded on the vote as "Decided by the owner: too few members to vote". Any admin can still halt it in that time, with a public reason.
- If more members could vote by the close (a quiet member voting counts them in), they decide, and it ends as any vote does. Nor is it carried out if whoever decided is no longer an owner by then. An owner decides a vote once; to undo it before the close, lift the suspension or halt the vote.
- No vote removes an owner or admin, and an owner's decision doesn't either: Settings offers none on one of them.

## Halting a Decision

**Halt this Decision** stops a Decision that is open or in its grace period. You must give a reason of at least 10 characters, and it is public.

- Halting a removal in its grace period restores the person.
- Halting the vote an emergency suspension opened lifts the suspension.
- A suspension nobody votes on (on the global community) has **Lift suspension now** instead. It asks for a reason the same way, and lifts the suspension straight away.
- **Owner only**: if halting would give someone back an owner or admin role, only an owner can do it. The same goes for lifting such a suspension by hand, and for cutting a grace period short.

Halting overrides the community. Use it for a mistake or an abuse of the process, not because you dislike the result, and say why.

## Know this

- A suspension by Decision takes away the person's role for good. An emergency suspension only sets the role aside while its vote is open: if the vote fails, or you lift or halt it first, the role comes back.
- Lifting a suspension by hand is refused while a removal is waiting out its grace period. Halt the removal instead.
