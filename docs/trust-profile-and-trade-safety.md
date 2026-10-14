# Trust Profile & At-Trade Safety — Design Spec

Status: **designed, not yet built.** Sequenced to build *after* the chat-consolidation
work (`feat/consolidate-chats`) is merged. Captured from the design discussion so the
decisions aren't lost.

Goal: help a member gauge, in a few seconds, whether someone is safe to trade with and
let near their home — by surfacing the trust signals the app already has, honestly and
proportionally. The app reduces risk; it never certifies safety.

---

## 1. Guiding principle

> **Show a name only when (a) the viewer can act on it — contact that person for a
> reference — and (b) it doesn't leak a stranger's private graph. Otherwise show a count
> or an abstraction.** Aggregate facts are public; identities are graduated.

Friction (and disclosure) should be **proportional to risk** and **honest** — never
fear-mongering for normal trades (or people tune it out), never a false green light for
thin profiles.

---

## 2. Profile signals

Good news: most "track record" signals are **already computed** server-side in
`getMemberTrustProfile` / `getMemberTrustStats` (state-engine.ts) — this is largely a
*surfacing* job.

### Already computed — just surface
- Completed trades (`tradeCount`)
- **Distinct trade partners** (`uniquePartners`) — stronger than raw trade count; can't be
  farmed by two colluding accounts
- Account age / "member since" (`ageDays`, `joined_at`)
- Volume cycled
- Avg rating + review count; composite **tier** (Seed → … → Steward → Elder)

### Small new queries
- **Completion rate** — completed vs cancelled `marketplace_transactions` (high cancel rate = yellow flag)
- **Mutual connections** ("connections in common") — members who are friends **both ways** with the viewer and
  friends **both ways** with the target: F counts only when V→F, F→V, F→T and T→F all exist (needs viewer context)
- **Last active** (`last_active_at`)
- **Invited by / invited N** — from `members.invited_by` (the invite tree is tier-gated → some sybil-resistance)

### Visibility rules (the nuanced part)
| Element | Rule | Why |
|---|---|---|
| Their own friends | **count only**, never names | Publishing a friend graph to strangers = stalking/harvesting risk; not actionable |
| **Mutual connections** | **names, tappable → "Ask about X"**, at most 12 | Only friendships chosen by both ends: F is named only when F and the viewer added each other AND F and the target added each other. A friend row is one-way and unconsented, so a one-way rule let a viewer who added everyone read the target's list (a probe) and a target who added everyone look "in your circle" to all (a forgery). The reachable reference is the whole point |
| **Invited by** | graduated: always show the *fact* + inviter's *tier*; show the **name** only when the inviter is the viewer / their friend / a mutual; else "an established member" | Name is only useful when you can actually ask them; otherwise it's pure exposure of the inviter |
| Reports / flags | never raw counts; moderation **outcomes** only | Defamation + brigading risk |

Opt-outs:
- **"Show me as a connection in common"** (built; default on). Settings → Legal & Privacy, phone and web. Stored as the
  member's own preference `show_as_connection_in_common` (`member_preferences`), served to them alone. Turned off, the
  member is never named or counted as anyone's connection in common, so it never turns a band green
  (`getTrustProfileForViewer`; checked in `test-trust-mutuals` T10).
- Inviter "show me as the inviter on people I bring in" (default on within community): planned, **not built**.

Adding a friend is visible and bounded, because a connection in common is made of friendships both ways:
- The person added is told: a quiet line on their People tab, "*name* added you · Add back", phone and web (no push).
  Only adds made after a server first ran this are shown (no backfill), for 30 days, until they add back or block
  the adder (an adder's block of them changes nothing they read); 20 named, then "and N more" (`GET /api/friends/added-you`, their own only; engine/friends-added-you.ts).
- A member adds at most **100 people a day** (`friendAddsPerDay`, config/writer-limits.ts). Removing someone counts
  too (its tombstone), so removing and adding again frees nothing. The 101st is refused in words, with when it lets up, never silently dropped (the phone no longer
  writes its own row before the node has answered).
- You can't add someone you blocked: refused, saying so. If they add you, you aren't told: the add is taken as any add
  (it counts against their 100), and your "added you" line leaves out anyone you blocked (`member_blocks`, the web's
  block list; the phone also leaves out its own blocks). Refusing it would tell them of the block, which a block never
  does (engine/member-blocks.ts). You stop counting as a connection in common between them and your friends: a blocker
  is never counted on the profile of the member they blocked, nor for a viewer who blocked them; the friend rows stay,
  so the blocked member's own reads don't change (`getTrustProfileForViewer`; `test-trust-mutuals` T11-T14). It does
  not take them off your People list, and if your contact is set to Friends they still see it. Remove them if you want
  that; they can notice a removal.

### Suggested "trust at a glance" layout
1. Tier badge · member since · last active
2. **Vouched in by …** · **N mutual connections (names, tappable)** ← the line that calms nerves
3. Distinct partners · completed trades · completion % · ★rating (count)
4. Recent reviews (text — the words are what convince)
5. Listings / activity

Thin/new profile is shown honestly: "New member — limited history."

---

## 3. The invite relationship ("invited by")

- **Do NOT auto-create a friendship** from an invite — it pads `friends`/mutuals with
  non-chosen edges and corrupts the very signal we're building (and breaks for ambassadors
  who invite many).
- Treat **"vouched in by"** as a first-class, **permanent** relationship of its own (the
  fact is already in `invited_by`), separate from friendship:
  - Invitee profile: `🌱 Vouched in by <name|tier>` (per visibility rule above)
  - Inviter profile: `Invited N members` (count public; names limited to inviter/mutuals)
  - Decorate a person's row with `🌱 invited you` / `you invited` when present
- **Prompt** (opt-in, one tap) to add the inviter/invitee as a friend on first run — gets the
  bootstrapping benefit *with consent*, without auto-polluting the graph.

---

## 4. At-trade safety (caution at the decision point)

Passive profile info isn't enough — caution must land **when you commit**. Three layers,
all driven by one shared `assessTradeRisk(counterpartyTrust, mutualsCount, priorTradesWithThem)`
helper that returns a band + reasons + meeting tips, so badge / gate / chat all agree.

### Layer 1 — browse time (passive)
Enrich `PostAuthorTrust` (already shows tier + rating) with two cues: `🌱 new` for
brand-new authors, `👥 N mutual` when you share connections.

### Layer 2 — commit time (the gate; highest leverage)
Reuse the **existing accept/fund confirmation** (`showAcceptConfirm` in `app/post/[id].tsx`)
— it fires exactly when money locks and you commit to meet. Inject a counterparty summary +
a risk band that scales the friction:
- 🟢 **Trusted / in your circle** (prior trades with you, or ≥1 mutual, or established + good completion) → green summary, normal Confirm. Invisible friction.
- 🟡 **New to you** (solid record, no mutuals) → neutral info line, normal Confirm.
- 🔴 **New & unvouched** (brand new, no mutuals, thin/negative history) → amber-red caution + meeting-specific tips (meet in public first; don't share your address yet; tell a friend) + an explicit "I understand" tap before Confirm enables.

Only prompts on **first / low-trust** deals; repeat trades with a trusted partner never re-nag.

### Layer 3 — buddy nudge — DEFERRED (roadmap)
One-tap "Let a friend know" sharing trade details to a trusted friend DM at the meeting
moment. Deferred: community is largely closed/low-risk and members can message someone
manually. Revisit if the network opens up.

---

## 5. Build surface (when we get to it)
- Server: small additions to the trust-profile endpoint (completion rate, invited-by);
  mutual-connections needs viewer context.
- Native: public-profile UI; `PostAuthorTrust` pills; the accept-confirm risk gate; shared
  `assessTradeRisk` helper. PWA parity optional.
- Anti-gaming: lean on reciprocal signals (distinct partners, mutuals, vouchers, tenure),
  not raw counts.
