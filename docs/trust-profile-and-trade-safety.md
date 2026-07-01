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
- **Guardians** — how many people made them a recovery guardian (`friends.is_guardian`); deep-trust signal
- **Mutual connections** — intersection of viewer's friends and the target's (needs viewer context)
- **Last active** (`last_active_at`)
- **Invited by / invited N** — from `members.invited_by` (the invite tree is tier-gated → some sybil-resistance)

### Visibility rules (the nuanced part)
| Element | Rule | Why |
|---|---|---|
| Their own friends | **count only**, never names | Publishing a friend graph to strangers = stalking/harvesting risk; not actionable |
| **Mutual connections** | **names, tappable → "Ask about X"** | Only ever surfaces people the *viewer already knows*; the reachable reference is the whole point |
| **Invited by** | graduated: always show the *fact* + inviter's *tier*; show the **name** only when the inviter is the viewer / their friend / a mutual; else "an established member" | Name is only useful when you can actually ask them; otherwise it's pure exposure of the inviter |
| Reports / flags | never raw counts; moderation **outcomes** only | Defamation + brigading risk |

Opt-outs: per-user "show me as a mutual connection" (default on); inviter "show me as the
inviter on people I bring in" (default on within community).

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
One-tap "Let a guardian know" sharing trade details to a friend/guardian DM at the meeting
moment. Deferred: community is largely closed/low-risk and members can message someone
manually. Revisit if the network opens up.

---

## 5. Build surface (when we get to it)
- Server: small additions to the trust-profile endpoint (completion rate, guardians, invited-by);
  mutual-connections needs viewer context.
- Native: public-profile UI; `PostAuthorTrust` pills; the accept-confirm risk gate; shared
  `assessTradeRisk` helper. PWA parity optional.
- Anti-gaming: lean on reciprocal signals (distinct partners, mutuals, guardians, tenure),
  not raw counts.
