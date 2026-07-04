# Trust Model v3 — Offer-Gated Credit Floor (Phase 2 "offer covenant")

> **Status: SPEC / not yet built.** This is the build's source of truth for the Phase 2 *offer
> covenant* foreshadowed in [`trust-model-shipped.md`](./trust-model-shipped.md) §9, plus a fix for
> the activation drift described in §0.1. Supersedes the floor-activation rules in
> [`trust-model-shipped.md`](./trust-model-shipped.md) once merged. Design lineage:
> [`trust-model-v2.md`](./trust-model-v2.md) → shipped v2 → **this**.

---

## 0. Why this exists

### 0.1 The bug it fixes (activation drift)

[`trust-model-shipped.md`](./trust-model-shipped.md) §1 documents:

```
activated = qualifiedTradeValue > 0  OR  grantedCredit > 0  OR  elderVouched
```

i.e. **completing a real trade opens your floor.** But the live code (after the #15 vouch-gating
pass) is:

```js
// apps/server/src/state-engine.ts  (getMemberTrustProfile)
const activated = elderVouched || grantedCredit > 0;   // trade-activation was removed
```

So a member who has earned real trust by trading — but was never vouched — shows a full trust
**level** (Steward, 1220 trust) while the server reports **floor 0 / "No credit line yet."** The
level ladder promises a credit line the floor withholds. v3 restores trade-activation so the two
tracks agree again.

### 0.2 The feature it adds (offer covenant)

Earned trust sets *how much* credit you could have. It does **not**, by itself, let you draw that
credit. To spend into a negative balance you must be **actively offering** something the community
can trade back for — and the deeper you want to go, the more live offers you must keep posted.
Trust is Sybil-resistant (diversity-capped, gifts build nothing), and the offer covenant is what
turns an *earned limit* into a *reciprocal, discoverable line*.

---

## 1. The one idea — two dials

**Usable floor = min( what you've *earned*, what your *live offers* unlock ).**

- **Dial A — earned limit** (how deep you *could* go): trust from completed, diversity-capped
  trades, plus optional welcome voucher / vouch gift / admin tier grant. Unchanged from v2 except
  activation is restored.
- **Dial B — offer access** (how deep you *may* go right now): a step function of your live-offer
  count. Offers **do not create** floor — they gate access to a limit you already earned. A sock
  with 0 earned trust unlocks 0 floor no matter how many offers it posts.

Because it's a `min()`, the offer burden **self-caps by tier**: a Steward whose earned limit is
~−600 reaches their full limit at 3 offers and never sees the 4th/5th requirement. Only a member
who *earned* a −1500/−2000 limit ever needs 5 offers.

---

## 2. Canonical formulas

```
── Dial A: earned limit (magnitude, 0…2000) ────────────────────────────────
vouchGift       = vouched ? vouchCreditForLevel(level) : 0       // 25 / 50 / 100
earnedCredit    = floor(1920 · V / (V + 5000)) · ratingMultiplier  where V = qualifiedTradeValue
grantedCredit   = admin tier-badge grant (0 / 200 / 600 / 1400)
earnedLimit     = min(2000, earnedCredit + grantedCredit + vouchGift)
activated       = earnedLimit > 0     ← RESTORED: a real trade (earnedCredit>0) opens the floor on
                                        its own — no vouch needed, and no separate +20 welcome voucher

── Dial B: offer access (magnitude, 0…2000) ─────────────────────────────────
offerCap(n)     = [0, 200, 500, 1000, 1500, 2000][ min(n, 5) ]     n = liveOfferCount

── Result ────────────────────────────────────────────────────────────────
usableFloor(m)  = − min( earnedLimit(m), offerCap(liveOfferCount(m)) )     // ≤ 0
frozen(m)       = balance(m) < usableFloor(m)                              // debt deeper than unlocked
```

`liveOfferCount(m)` = distinct posts where `type='offer' AND active=1 AND status='active'`
(generalises the existing `hasLiveOffer`). Admin is exempt (unlimited).

---

## 3. Offer-access bands

| Live offers | Unlocks floor to | Band added | Notes |
|---|---|---|---|
| 0 | **0** | — | spend held beans only; no credit |
| 1 | −200 | 200 | mirrors the +200 tax-free zone above zero |
| 2 | −500 | 300 | |
| 3 | −1000 | 500 | |
| 4 | −1500 | 500 | |
| 5 | −2000 | 500 | system max (`CREDIT_FLOOR_CAP`) |

Band thresholds are an **independent axis** from the tier badges (Newcomer/Resident/Steward/Elder,
which map floor depth → recognition). Do not conflate them.

---

## 4. Positive vs negative — the offer covenant only gates *credit*

Two kinds of outbound money, and only one can ever go negative:

- **Direct "send credits" gifts — positive balance only (floor 0).** By design you can only gift
  beans you actually hold; a gift can *never* take you negative
  ([state-engine.ts:1582](../apps/server/src/state-engine.ts#L1582)). So gifting needs **no listing**
  and is never touched by the covenant — and if you're already negative you simply have no beans to
  gift.
- **Marketplace / escrow spends — draw the credit line down to your floor.** These are the *only*
  spends that go negative, so these are the ones the offer covenant gates.

Therefore:
- **Positive balance:** spend/gift freely; you may pause/remove all offers — your choice.
- **Going (or deeper) negative via the marketplace:** needs enough live offers for the target depth
  per §3. You need ≥1 live offer only at the moment you first dip negative, not before.

---

## 5. The freeze (under-collateralised debt)

A member can drop below the offers needed for their current debt three ways: **pause** an offer,
an offer **completes** (someone buys it), or an offer **expires**. We do **not** block these events
(you can't block a sale from completing) and we do **not** claw anything back. Instead the account
becomes **spend-frozen** while `balance < usableFloor`:

| Blocked (would draw the credit line deeper) | Always allowed (inbound — aids recovery) |
|---|---|
| Buying / accepting others' offers on credit | ✅ Someone buying/accepting **their** live offer |
| Any marketplace spend that would go further negative | ✅ Receiving credits / gifts from anyone |
|  | ✅ Re-activating a paused offer or posting a new one |

The freeze **auto-lifts** the instant `balance ≥ usableFloor` again — either by getting paid or by
re-adding offers. No one is trapped: both exits (earn, or re-post) are open, and both are behaviours
we want to encourage. A frozen member keeps selling and trades their way back up.

**A buyer accepting a frozen member's offer always clears** — it is an inbound payment to the frozen
member and can only raise their balance. Whether it clears depends on the *buyer's* floor/offers,
never the seller's freeze.

**Gifts don't enter into it.** A gift is positive-balance-only (floor 0, §4), so a frozen (⇒ already
negative) member has nothing to gift anyway — there is no separate "gift freeze" rule. Only
marketplace credit spends are affected by the freeze.

---

## 6. Gate summary (all three, post-v3)

| Gate | Rule | Trigger |
|---|---|---|
| **Contribution-first** | Must have *ever* listed an offer (`hasListedOffer`) to post a *Need* or request an offer | posting need / requesting |
| **Offer covenant (banded)** | Spending to balance `B<0` requires `liveOfferCount ≥ offersRequiredFor(B)` | marketplace/escrow spend going negative (gifts are floor-0, excluded) |
| **Freeze** | While `balance < usableFloor`, all outbound blocked; inbound open | continuously, auto-lifts |

`offersRequiredFor(B)` = smallest `n` such that `offerCap(n) ≥ |B|`.

---

## 7. Telling the member (no hard gates — plain-language states)

Two surfaces, both required:

### 7.1 Proactive — the floor ladder (decided: in the CreditBar)

Extend the existing zero-anchored `CreditBar` *below* zero, mirroring the fee ladder above +200,
marking unlocked vs locked bands from the member's live-offer count:

```
   +200 ┤ tax-free
      0 ┤━━━━━ you are here (+20)
   −200 ┤ 🔓 unlocked · 1 offer active
   −500 ┤ 🔒 post 1 more offer
  −1000 ┤ 🔒 post 2 more offers
```

The "you need another offer" answer is always visible *before* a wall is hit. A compact one-line
status also appears on the Ledger: `1 active offer · −200 of −1220 unlocked`.

### 7.2 Reactive — actionable block at spend time

When a spend exceeds what's unlocked, the server rejects with a **structured** reason so client copy
is always exact:

```ts
// FLOOR_LOCKED reason payload
{ code: 'FLOOR_LOCKED', balance, attemptedBalance, usableFloor,
  liveOffers, neededOffers, unlocksAt }
```

- 0 offers, going negative → *"🎣 Post an Offer to open your credit line. Your first offer unlocks
  spending down to −200."* with **[Post an Offer]** and **[Re-activate a paused offer]** buttons.
- N offers, too deep → *"Your {N} active offers unlock {unlocksAt}. Post 1 more to reach {next}."*

### 7.3 Warn-on-toggle

Pausing an offer that would freeze the member warns + confirms — never a hard block:

> ⚠️ *You're at −340. Pausing this drops you to 1 active offer (−200 line), so you won't be able to
> spend until you're back above −200 or re-post. Pause anyway?*

---

## 8. Per-post Active / Paused toggle

Owner-facing switch on each of their posts, wired to existing `pausePost` / `resumePost`
([state-engine.ts:2410](../apps/server/src/state-engine.ts#L2410)): pause → `status='paused'`
(drops out of live; reversible), resume → `status='active'`. A member may keep many offers (some
recurring) and switch on just the subset they want live at any moment. `liveOfferCount` counts only
currently-active ones. **No server-side pause guard needed** — the freeze (§5) is the safety net; the
client warn (§7.3) is the courtesy.

---

## 9. Edge cases

- **Grandfathering:** members already negative at ship are simply *frozen* until they recover or post
  offers. No migration, no clawback — the freeze absorbs it.
- **Offer completes while it was collateral:** completing pays the seller (balance ↑) and drops live
  count by one; net effect is usually still within cap, and if not, they're frozen and self-correct.
- **Recurring offers:** count as live only while active; re-enter the live set when they relist.
- **Admin:** exempt from covenant/freeze (`hasLiveOffer`/`liveOfferCount` short-circuit for admin).
- **Founding members (0 trades):** floor 0 until first real trade *or* a vouch gift — matches the
  documented journey (§6 of the shipped doc).

---

## 10. Implementation plan (staged; lands as a PR off `main`, not direct)

**A. Core (`packages/beanpool-core/src/protocol.ts`)** — pure, deterministic:
- `OFFER_BANDS = [0, 200, 500, 1000, 1500, 2000]` (+ existing `CREDIT_FLOOR_CAP = 2000`).
- `offerCapForCount(n)` and `offersRequiredForDepth(magnitude)`.

**B. Server (`apps/server/src/state-engine.ts`)**:
- Restore `activated` to include `qualifiedTradeValue > 0` (fixes §0.1).
- `liveOfferCount(pubkey)` (generalise `hasLiveOffer`).
- `usableFloor(pubkey)` = `−min(earnedLimit, offerCapForCount(liveOfferCount))`.
- Replace the flat `COVENANT_REQUIRED` check in the marketplace gates (`requestPost`,
  `completePostTransaction`, and the `isEscrow` branch of `transfer`) with the banded `usableFloor`
  check → throw structured `FLOOR_LOCKED`.
- **Gifts stay floor-0 (unchanged):** the direct-send branch of `transfer` already uses
  `senderFloor = 0` ([state-engine.ts:1585](../apps/server/src/state-engine.ts#L1585)); the banded
  check applies only to the escrow/marketplace path (`senderFloor = getMemberTrustProfile(from).floor`).
- Expose `usableFloor`, `earnedLimit`, `liveOfferCount`, `frozen`, `neededOffers` via `getBalance` /
  trust-profile so clients can render the ladder.

**C. Clients (PWA + native)** — mirror in both:
- CreditBar floor ladder + Ledger status line (§7.1).
- `FLOOR_LOCKED` → friendly copy + action buttons (§7.2).
- Per-post Active/Paused toggle + warn-on-toggle (§7.3, §8).
- Replace the "No credit line yet — get vouched" Ledger banner with the earned/offer messaging.

**D. Tests** — extend `apps/server/src/test-vouch-covenant.ts`:
- trade activates floor (regression for §0.1); band boundaries (0/1/…/5 offers);
  freeze on pause/complete; inbound clears while frozen; auto-lift; gift stays floor-0 (can't go
  negative, so a negative member can't gift — no covenant interaction).

---

## 11. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Earned trust opens the floor; vouch/grant optional head-start | "trade without a vouch" |
| 2 | Newcomer floor 0 until first +ve trade *or* vouch gift (25/50/100) | no day-one faucet |
| 3 | Offer bands 0/1/2/3/4/5 → 0/−200/−500/−1000/−1500/−2000 | agreed; first band mirrors +200 |
| 4 | Positive spending never gated; only credit is | spend your own beans freely |
| 5 | Under-collateralised debt → spend-freeze, not block/clawback | handles pause + natural completion uniformly |
| 6 | Inbound (being paid, receiving) always clears while frozen | recovery must stay open |
| 7 | Gifts are positive-only (floor 0) — never draw credit, never gated by listings/covenant | you can only gift beans you hold; listings matter only for going negative |
| 8 | Floor ladder lives in the CreditBar | symmetric with the +ve fee ladder; single source |
