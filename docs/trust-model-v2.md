# Trust Model v2 — Implementation Plan

> Status: **design locked, pre-implementation.** This is the plan of record from the
> trust/credit redesign discussion. Related: `protocol-rules.md`,
> `trust-profile-and-trade-safety.md`, `commons-pool-transparency.md`,
> `invite-architecture.md`, `SECURITY-AUDIT.md`.

---

## 0. North Star — the one idea everything serves

**A floor does not create beans out of thin air. It authorises a matched IOU.**

When someone goes negative to pay someone else, the books always net to zero: a *claim*
(the receiver's +) and an *obligation* (the spender's −). The + is backed by the spender's
promise to return real value. The money supply breathes with real activity and always sums
to zero.

- Merely *having* a deep floor creates nothing. Beans exist only once someone spends into the
  negative, and they are extinguished as debts return to zero.
- **Credit is not inflation. Default is.** The only moment value is diluted is when an
  obligation is abandoned.
- Therefore **the trust model *is* the monetary policy.** Every mechanism below exists to (a)
  size credit to the probability it will be honoured, and (b) make fake identity expensive.
- **The commons pool (funded by demurrage) is the anti-inflation buffer** — it absorbs the bad
  debt that slips through (`state-engine.ts` `adminPruneUser`, ~line 5030). System stays sound
  while demurrage collected ≥ defaults leaked.
- **Genesis** is the single intentional exception (issues the first beans, unlimited negative).
  This is why a *minted* welcome grant would be inflationary but a *commons-funded* one is not —
  it recirculates beans that already exist.

---

## 1. What exists today (grounding)

| Piece | Location | Note |
|---|---|---|
| `earnedCredit` → floor | `state-engine.ts:1187-1245` (`getMemberTrustProfile`) | `floor = −80 − min(1920, earnedCredit)` — *earnedCredit formula rebased to value in §2 F1 / §10* |
| Trade / partner counting | `state-engine.ts:1109-1162` (`getMemberTrustStats`) | a "trade" = **any** `transactions` row, any amount |
| Volume cap (A2-26) | `state-engine.ts:1164-1181` | `PER_COUNTERPARTY_VOLUME_CAP = 5000` — caps *volume* washing only |
| First-trade gate | `state-engine.ts:1238` | floor stays 0 until first trade unless pre-seeded / elder-vouched |
| Demurrage brackets | `ledger.ts:113-187` | 0/1/1.5/2/2.5% on **positive** balances → `COMMONS_POOL` |
| Rating multiplier | `state-engine.ts:1219-1230` | 0.5–1.0× on organic earnings |
| Tiers | `ledger.tsx:42-47`, `protocol.ts` | cosmetic bands over a continuous floor |
| Elder vouch | `members.elder_vouched_by` (`db.ts:83`) | currently just unlocks base early |
| Bad debt → commons | `state-engine.ts:5030` | on prune |
| Offers | `posts` where `type='offer'`, `status` ∈ active/pending/cancelled | |
| Slider UI | `ledger.tsx:347-498` (`renderCreditBar`) | tier icons on the − side |
| Trust Level card | `ledger.tsx:521-566` | journey bar hides Newcomer (`ledger.tsx:549`) |
| PWA equivalents | `apps/pwa/src/pages/LedgerPage.tsx`, `WelcomePage.tsx` | keep in parity |

---

## 2. Phase 1 — Sybil hardening  ⚠️ **BLOCKER — ships first**

Everything downstream leans on `earnedCredit`. Today it can be maxed to the −2,000 floor with
~40 sock accounts and dust transactions — and the same lever buys governance votes. No feature
work lands until this is closed.

### Threat model → fix

| # | Attack | Root | Fix |
|---|---|---|---|
| T1 | **Self-funding partner farm** — send 1 bean to N socks; each distinct partner = +40 credit (uncapped), net +39 room per send, → −2,000 with ~40 socks. A2-26 doesn't touch the partner lever. | `uniquePartners × 40` flat + "trade = any row" | **F1 + F2 + F3** |
| T2 | **Demurrage-splitting** — spread a balance across socks under 200 each → 0% demurrage. | one-identity assumption | **F5** |
| T3 | **Governance capture** — earned credit buys votes; farm credit = farm votes. | shared lever | **F1/F2 + Phase 4 guardrail** |
| T4 | **Rating-bomb sabotage** — socks 1-star an honest rival → multiplier halves → their floor halves. | unqualified raters | **F4** |
| T5 | **Elder-vouch army** — farmed Elder mass-vouches. | vouch scaling / uncapped | flat bounded vouch + capacity cap (§3) |
| T6 | **Sleeper aging** — pre-age socks, activate mesh later. | free tenure | tenure already ≤ trade points; **F3** converts nothing without qualified trades |

### Changes

> **Core rebase (2026-07-02): earned trust is VALUE-based, not count-based.** The flat `trades × 8`
> and `partners × 40` terms (`state-engine.ts:1203-1209`) are the farm lever *and* the "3-bean unlock"
> bug — both symptoms of counting handshakes instead of measuring value. **Removed.** Earned trust
> becomes a **saturating curve on diversity-capped, connectivity-weighted, *qualified value*.**

- [ ] **F1 — Rebase earned trust on value** (replaces the old "diminishing partner returns"). Drop
      `trades×8 + partners×40 + flat tenure`; compute:
      `earnedCredit = saturate( Σ_cp min(qualifiedValue_cp, PER_CP_CAP) × connectivityWeight(cp) ) × ratingMultiplier × tenureModifier`
    - **Value is the lever** — 3-bean trade earns ~3, 300-bean ~300 (the cliff dies structurally).
    - **Diversity kept without a flat per-head bonus** — the per-counterparty cap + the sum *is* the
      diversity signal (value with one buddy caps out; breadth is rewarded).
    - **Saturating, not linear-to-the-top** — proportional low down (fixes small trades), flattens up
      high so no single account accumulates a system-threatening line (a smooth version of today's
      hard `min(1920,…)` cap).
    - **Tenure demoted** from flat earner → small modifier (a dormant old account isn't creditworthy).
    - *Layer in later: repayment history (dips negative → climbs back) — the money-lender's best predictor.*
    - Kills the partner-farm (T1) at the root: farming now needs real, diverse, connected, *qualified*
      value — which needs genuine floor room to bootstrap, which needs earned trust. Circular by design.
- [ ] **F2 — Connectivity weighting.** Weight each counterparty's value contribution by *their*
      anchor-connectedness; an isolated sock cluster's value counts ≈0 regardless of size.
    - **Cold-start escape hatch (critical — or the network deadlocks).** Two genuine newcomers trading
      each other are both connectivity-0 → earn 0 → freeze. Trust must *flow from anchor nodes*
      (genesis / established members): a trade qualifies if **at least one counterparty is already
      connected above a threshold**, and an **Elder vouch bypasses the connectivity penalty for a
      user's first few trades**. Earliest network stage: fall back to **connectivity-free value
      scoring** until an anchored core exists. *(via external review)*
- [x] **F3 — Qualified value = completed marketplace trades only** (DECIDED 2026-07, shipped).
      `qualifiedTradeValue()` sums COMPLETED `marketplace_transactions` per REAL counterparty
      (buyer↔seller, not the intermediating escrow account), capped per-counterparty (A2-26), and
      **credits both sides** of a trade. Direct peer-to-peer "send credits" are gifts/helping-a-friend
      and build **no** trust (per product ruling — real trades go through escrow). This also fixed
      three latent bugs: sellers earned nothing, unique escrow accounts defeated the diversity cap,
      and escrow synthetics counted as counterparties. Verified in test-trust-value-curve.ts.
    - *Follow-ups:* (a) **governance credit** still uses the raw `countedOutboundVolume` — move it to
      `qualifiedTradeValue` for consistency (needs the A2-26 test reseeded to marketplace trades);
      (b) the **first-trade gate** still lifts the −80 base on *any* first transaction incl. a received
      gift — decide whether it should require a *completed marketplace* trade (stricter, "sell first").
    - *(F4's old "raise volumeBonus cap / de-weight partners" is moot — value **is** the score now.)*
- [ ] **F5 — Demurrage-split mitigation** — aggregate/identity-aware green-zone so socks under 200
      don't each get 0%.
    - **Perf: identity-clustering must be async / cached, never in the transactional path.** Demurrage
      is already lazy/epoch-based (`ledger.ts` `applyDecay` on fetch), so cluster lookups must not
      block it; recompute clusters periodically. Lighter alternatives (smaller/removed green zone, or
      tie 0% to a uniqueness signal) stay on the table. *(perf note via external review)*
- [ ] **F6 — Seed-point + fan-out detection** — a new account that immediately sprays tiny sends to
      many new accounts is a klaxon; monitor + alert.
- [ ] **F7 — Log as a new `SECURITY-AUDIT.md` finding** (sibling to A2-26, which closed only the
      weaker volume lever).

---

## 3. Phase 2 — The fair-credit model

Built on the now-sound score. Theme: **proof of participation, priced to risk, backed by someone
accountable — and un-farmable.**

### Credit line

- [ ] **One credit number.** Trust score *is* credit capacity. Earned from **qualified value cycled**
      (F1) on a **saturating curve** (proportional early, flattening high → caps systemic exposure).
      Tiers become purely cosmetic badges.
- [ ] **Value-scaled opening — now structural.** Because earned trust is value-based (F1), a small
      first trade earns small trust proportionally, so the "3-bean → −128" cliff is gone by
      construction. The first *qualified* trade unlocks the base; the line then slides with value.
- [ ] **Freeze the floor for an in-flight transaction (server-issued credit hold).** The floor is now
      *dynamic* — a partner being pruned or connectivity shifting can shrink it mid-session. When a
      checkout/payment screen opens, the **server issues a short-lived credit hold** reserving the
      room; the tx settles against the hold. This freezes the floor on the *authoritative* side for
      the tx window (not just a client snapshot), so an in-flight checkout is never interrupted by a
      floor shrink, while the server still enforces the real limit everywhere else. UI (`ledger.tsx`,
      PWA `LedgerPage.tsx`) reflects the held value. *(upgrades the client-snapshot idea from external review)*

### Vouch / founding

- [ ] **Vouch = flat 20-bean floor voucher** (borrow-room leg-up). Flat + capped, so it is **not a
      farming lever** (20 is 20 whether you have 1 partner or 1,000). One vouch per recipient;
      **Elder vouch-capacity capped.**
- [ ] **Mechanism — a *granted* credit-limit lane, separate from *earned*.** The voucher extends the
      floor by 20 but must **not** be poured into the earned-trust pool. Implement it in the same
      "limit-only, mints-no-beans" lane the genesis pre-seed already uses (`preSeeded`,
      `state-engine.ts:1199,1230` — added *after* the rating multiplier), but tracked as its own
      source so we can (a) **exclude it from vote weight** (Phase 4 — votes = earned only), (b)
      **audit it** ("20 of my limit is a vouch, the rest earned"), (c) keep it **flat + bounded**.
      So `floor = −80 − min(CAP, earnedCredit + grantedCredit)`; a vouch does `grantedCredit += 20`.
      Mints **no beans** — it is permission to owe 20 more (§0).
- [ ] **Opening for a vouched newcomer = −20 (voucher only), not the full −80 base.** The −80 base
      stays gated behind a *qualified first trade* (real skin in the game); a vouch is a lighter
      signal, so it's a small leg-up and the rest is earned. Caps a vouch-army at 20 each.
      *Sub-decision at build: −20 only (recommended) vs. −20 on top of the current gate-bypass-to-base.*
- [ ] **Commons +ve grant = documented fast-follow** (a real welcome gift from the demurrage-funded
      pot). Ship only after vouch-capacity limits are proven; must **vest on first qualified trade**
      to prevent Sybil drain.
- [ ] No reputation/credit split and no heavy vouch-collateral machinery needed — the flat bounded
      voucher makes collapsing to one number safe.

### Grants & seeding — unify into one granted-credit lane

Finding (2026-07-02): admin/genesis grants currently write **`earned_credit`** (`adminSetElder`
`state-engine.ts:5001`; genesis-invite redemption `:874`), i.e. they grant **credit/floor, not just a
badge**. Genesis invites already tier the seed: `standard/trusted/ambassador/elder` → −80/−200/−600/−1400.

- [ ] **Route ALL grants into `grantedCredit`, not `earnedCredit`.** Required for the Phase-4 guardrail —
      as-is, an admin grant lands in the earned (vote-eligible) lane, so **admin could mint voters.**
      Grants must be: limit-only (mint no beans), floor-deepening, **vote-excluded**, auditable, revocable.
- [ ] **Decouple badge from floor-grant.** Granting a cosmetic badge, granting floor, or both — separate actions.
- [ ] **Two distinct levers, don't conflate:**
    - **Peer vouch — small & flat (+20), Sybil-sensitive** (a farmed/compromised Elder mass-vouching is
      the risk); capacity-capped, one per recipient.
    - **Admin seed grant — larger, tiered (−200/−600/−1400), admin-gated** (safe *because* gated). This is
      the community-bootstrapping tool; it already exists as genesis invites — just re-route to `grantedCredit`.
- [ ] **Seeding economics (be honest in UX):** a floor grant is *permission to issue* credit, not beans.
      Seeding distributes the who-goes-into-debt across many seeded members (not just Elders). For beans
      **without** anyone going into debt, use the **+ve welcome grant** (genesis issues at bootstrap;
      commons funds later) — the one mechanism that puts spendable beans in hand.

### Offer covenant ("fishing lines")

- [ ] **Gate, not grant.** Offers are *necessary, not sufficient*: they gate whether you can *use*
      a line and going *deeper*; they never *size* it. Junk offers unlock nothing (no takers → no
      trades → no line growth).
- [ ] **Require listing, never selling.** Availability is in the member's control; outcomes are not.
- [ ] **A listing counts only while genuinely *live* — gate on responsiveness, not clicks/sales.**
      Theatre listings that satisfy the count while the seller ignores every inquiry defeat the
      covenant's spirit. Downgrade a listing out of "active" (→ draft, tripping the lazy gate) on
      **community reports** or **the seller repeatedly ignoring inquiries** — behaviours in the
      seller's control. Do **not** gate on zero-clicks / no-sales — that penalises outcomes and
      breaks the availability-not-outcomes keystone. *(refined from external review — narrowed to responsiveness)*
- [ ] **Permanent baseline: 1 offer for everyone** (everyone contributes; seeds the marketplace).
- [ ] **Schedule = Moderate, config-tunable:**

  | Balance band | Offers |
  |---|---|
  | ≥ 0 and 0 → −80 (grace) | 1 |
  | −80 → −200 | 2 |
  | −200 → −600 | 3 |
  | deeper than −600 | 4 (cap) |

- [ ] **Lazy gate** (never a live tripwire):
  - Checked **only at an outgoing transaction that deepens debt**, evaluated on the **destination
    balance**.
  - **Tighten lazily, loosen instantly** — going deeper triggers a check; climbing back drops the
    requirement automatically (never asked to *remove* offers).
  - **Inline onramp, not a wall:** "this takes you to −250, add 1 offer to continue" + one-tap add,
    satisfied *as part of* the transaction.
  - **Existing debt is never retroactively frozen** for a lapsed offer (gentle nudge at most).
  - **Editing never locks** (edit is active→active; draft/pause state preserves the count).
  - **Receiving / repaying is never gated.**
  - Grace band (0 → −80) needs only the baseline 1 → everyday small dips trigger nothing.

### Needs (hoarder side)

- [ ] **Encouraged tool, not a mechanic** (option b). Posting "what you're looking for" is surfaced
      and encouraged (sellers find you → spend down → dodge demurrage naturally) but **not required
      and not rewarded** (rewarding it is gameable with fake needs). Demurrage stays the only
      pressure on positive balances. Symmetry with offers is thematic, not a second rule.

### Pause / holiday mode

- [ ] **Must clear outstandings first** — accepted, in-progress deals / live escrows must be
      completed or cancelled before pausing. *Unaccepted requests do not block* (they just expire);
      *debt does not block* (it's a standing balance, no waiting counterparty).
- [ ] **Pauses the store only** — listings hidden, no new escrows can form; the offer covenant and
      new borrowing suspend.
- [ ] **Demurrage keeps running** (anti-hoarding-loophole).
- [ ] **Messages still received** + auto "🌴 away until …" indicator.
- [ ] **Time-boxed / auto-expires** (caps indefinite paused-in-debt).

### Escrow safety net (the "wide net then goes dark" case)

- [ ] **Accept-first escrow** — a buyer expressing interest locks nothing; escrow forms only when
      the seller *accepts*. Unanswered requests expire harmlessly.
- [ ] **Buyer-agency stall warning** — at X days pending, notify the **buyer**: "outstanding N days
      — cancel, or contact the seller?" ("contact" works even if the seller is paused, since paused
      users still receive messages.)
- [ ] **Backstop auto-refund** — if the buyer also goes silent, auto-refund at a longer deadline Y
      (prevents a double-ghost locking beans forever).
- [ ] **Attribute fault to whoever abandoned** (closes the buyer's "free option"). Escrow forms only
      *after the seller accepts*, so a buyer who then ignores the X-day prompt and lets it auto-refund
      at Y has wasted the seller's committed effort. When the refund is buyer-caused, the **buyer's**
      `completionRate` takes the hit, not the seller's. *(via external review)*
- [ ] **Reputation grace** — one-off stalls are no-fault; only chronic non-completion dents standing
      (`completionRate` / `poorCompletion` already exist, `state-engine.ts:1279`).

---

## 4. Phase 3 — UX & presentation  (native + PWA parity)

- [ ] **Onboarding question** — 2-step "What's one thing you can offer? / Anything you're looking
      for?" with coaching for the "I've got nothing" case; seeds marketplace + sets give-and-take
      tone.
- [ ] **Trust Level card overhaul** — cleanly separate the two number-lines that today share icons:
      the **balance/credit-spectrum** (the slider) vs the **trust progression** (the ladder). Fix the
      hidden-Newcomer bug (`ledger.tsx:549`, `TIERS.filter(t => t.min > 0)`).
    - **Badges = milestones, not mechanics.** Post-rebase, tiers do not set your credit line (that's
      continuous now). Present them as earned **recognition + milestone markers** on the scale:
      current badge → simple progress to the next → **what the next badge actually unlocks** (be
      honest: velocity loosens, then governance — the rest is recognition) → **how you earn it**
      (cycle more qualified value). Show **all** badges incl. Newcomer.
- [ ] **Slider** — remove the tier icons from the − side; add a **single floor chevron** at the
      member's own floor. Negative coloured bands **stay informational** (proximity to floor /
      carrying pressure) — **no debt tax**.
- [ ] *(Standalone quick win: the plain icon-removal + chevron can ship independently, ahead of the
      full overhaul, if a visible change is wanted while core work is in flight.)*
- [ ] **PWA parity** — mirror all UI in `LedgerPage.tsx`, `WelcomePage.tsx`.
- [ ] Honour **small-screen** (320dp + 1.3× font) and **no-hard-gates** plain-language states
      throughout.

---

## 5. Phase 4 — Parked: governance / direct democracy

- Elders nominated by other Elders → voting → a direct-democracy component.
- [ ] **Guardrail to bake in now:** voting weight comes from **earned qualified-trade credit only** —
      never vouches, reputation, or the welcome-boost — or Elder-elects-Elder + votes-from-vouches
      becomes a capturable oligarchy.

---

## 6. Tunable knobs (config constants, start gentle → tighten on real data)

- Value→trust saturation curve (shape) + connectivity weight + tenure-modifier weight
- `PER_COUNTERPARTY_VOLUME_CAP` (keep = 5000 — now the core diversity lever)
- Offer schedule (Moderate table above)
- Vouch voucher size (20) + Elder vouch capacity
- Qualified-trade thresholds (min value / rated / escrow-complete)
- Escrow X (buyer warning) / Y (backstop refund) timeouts
- Pause max duration
- Demurrage brackets (existing) + split-mitigation threshold

### Proposed saturation curve — PENDING SIGN-OFF (drafted 2026-07-02, overnight)

Deterministic, integer-only (safe across nodes — no float `log`/`√`):

```
earnedCredit = floor( CAP * V / (V + K) )        CAP = 1920, K = 5000
floor        = −80 − min(CAP, earnedCredit)
```
where `V` = diversity-capped, connectivity-weighted, *qualified* value cycled.

- Proportional at the low end (slope ≈ CAP/K ≈ 0.38 credit per bean) → a 3-bean trade earns ~1
  (cliff gone); saturating at the top → approaches the −2000 cap, no runaway whale.

| V cycled | ≈ hours (÷40) | earnedCredit | floor | ~badge (old threshold) |
|---|---|---|---|---|
| first qualified trade | — | base unlock | −80 | Newcomer |
| 500 | ~12h | 175 | −255 | Resident (−200) |
| 1,000 | ~25h | 320 | −400 | Resident+ |
| 2,000 | ~50h | 549 | −629 | Steward (−600) |
| 5,000 | ~125h | 960 | −1,040 | Steward+ |
| 10,000 | ~250h | 1,280 | −1,360 | Elder (−1400) |
| 20,000 | ~500h | 1,536 | −1,616 | Elder+ |
| 50,000+ | — | 1,745→1,920 | −1,825→−2,000 | flattening to cap |

**One knob to tune in the morning:** `K`. Lower `K` = tiers reached with less value (more generous);
higher `K` = more value required (stricter). `CAP` stays 1920 to preserve the −2000 floor. Roughly
lands Resident ≈ 500, Steward ≈ 2,000, Elder ≈ 10,000 of qualified value — eyeball those and we tune.

---

## 7. Cross-cutting guardrails

- **No hard gates** — plain-language, unmistakable states; never a lockout or a mystery red dot.
- **Require availability, not outcomes.**
- **Flat + bounded = not a farming lever;** anything that *scales* with an identity-cheap input is.
- **Credit and votes both come from qualified trades only.**
- **Commons-funded, never minted** (inflation control).
- **Cross-node determinism of the floor curve.** The saturating curve (log/√ on qualified volume)
  must be computed **deterministically across node platforms** — the floor gates transaction
  *validity* in a federated ledger (`protocol.ts`, "identical across all nodes"), so platform-dependent
  float math (`Math.log`/`Math.sqrt`) risks two nodes deriving different floors and disagreeing on
  whether a transfer is legal. Use integer / fixed-point math or a shared lookup table; round
  consistently. *(upgrades the "precision" note from external review — the real risk is consensus divergence, not rounding)*
- **Workflow:** land as PRs (main is protected/PR-only), each change tested; native changes need a
  **standalone rebuild** to verify; coordinate with the 2nd agent sharing this worktree; **do not
  touch** GlobalHeader / logo / map in refactors.

---

## 8. Rejected / superseded (do not relitigate)

| Idea | Verdict | Why |
|---|---|---|
| Interest / tax on the negative side | **Rejected** | Debt trap — charges beans to the one person who has none, accelerates runaway debt. And *default*, not credit, is the inflation. |
| Privilege-decay on the floor | **Superseded** | Rolled into risk-based underwriting + the offer covenant. |
| Mandating hoarders to list "needs" | **Rejected** | Demurrage is already the stick; a second one is double-pressure. Encourage as a tool instead. |
| Reputation/credit split (for safety) | **Dropped** | Collapsed to one number; the flat bounded vouch removes the need. (Two-gauge survives only as a *display* choice.) |
| Heavy vouch-collateral machinery | **Dropped** | Flat bounded voucher isn't a farming lever, so co-signer liability isn't required. |
| Vouch that *scales* / opens deeper credit | **Rejected** | Flat 20-bean floor voucher only. |
| Flat count-based earned trust (`trades×8`, `partners×40`, flat tenure) | **Superseded (2026-07-02)** | Counting handshakes is *both* the sock-farm lever and the 3-bean-unlock cliff. Earned trust is now value-based (F1): a saturating curve on diversity-capped, connectivity-weighted qualified value. Flat figures gone — the only deliberately-flat value is the bounded vouch *grant* (a different lane). |

---

## 9. External-review pass (2026-07-02)

A second agent reviewed the plan; incorporated above (tagged *via external review*):

- **Cold-start deadlock escape hatch** for F2/F3 — trust flows from anchor nodes; vouch/anchor-adjacency
  qualifies a newcomer's first trades; diminishing-only fallback in the earliest network. **[high value — added to F2]**
- **Async/cached identity clustering** for F5 — keep it off the transactional path. **[added to F5]**
- **Escrow fault attribution** — the abandoning party (often the buyer) eats the completion-rate hit;
  closes the buyer "free option". **[added to Escrow]**
- **Dynamic-floor race** — server-issued credit hold at checkout — **upgraded** from the suggested
  client-only snapshot to an authoritative hold (UX *and* safety). **[added to Credit line]**
- **Curve precision** — **upgraded** to a cross-node *determinism* requirement (consensus safety, not
  just rounding). **[added to §7]**

Refined / not taken as-is:
- Offer covenant "dead listing" fix — **narrowed** to *responsiveness + reports*; **rejected the
  "zero-clicks / no-sales" signal**, which penalises outcomes and breaks the availability-not-outcomes
  keystone. **[added to Offer covenant, corrected]**

---

## 10. Design revision — value-based earned trust (2026-07-02)

The earned-trust formula was still carrying flat count terms (`trades×8`, `partners×40`, flat tenure)
inherited from the legacy code — the very handshake-counting that is both the sock-farm lever and the
3-bean-unlock cliff. **Removed.** Earned trust is now a **saturating curve on diversity-capped,
connectivity-weighted, qualified value** (see F1). Shaping that stays (it is value-shaping, not flat
figures): the per-counterparty cap (diversity), connectivity weight, qualification filter, saturation
(risk ceiling), rating multiplier. The only deliberately-flat value in the model is the **bounded vouch
grant** — a different lane from earned trust, correctly flat. This collapses the old F1–F4 into one
coherent value-based score and kills the partner-farm at the root rather than merely blunting it.

### Tiers & perks after the rebase

Audit of what tiers actually gate **today**: `canGift` / `canInvite` (`protocol.ts:96-104`) are
**display-only** — no server enforcement found in the transfer path. The one real mechanical gate is
the **new-account velocity limit** (`state-engine.ts:1585-1613`), keyed on Newcomer + account age
(fraud protection). Governance is unenforced (Phase 4). Invites-per-tier already scrapped
(`canInvite` true for all). So the rebase (tiers no longer set credit) removes almost nothing real.

Decisions:
- [ ] **Tiers → cosmetic milestone badges.** Keep them (recognition + legible milestones), drop the
      pretence they're load-bearing. UI honesty: recognition vs. real unlock clearly distinguished.
- [x] **Velocity gate REMOVED** (decided 2026-07, shipped) — the sliding value-based floor already
      bounds how much a new account can move, so a daily rate-limit keyed off the cosmetic "Newcomer"
      tier was moot. Ripped from `transfer()`, `getVelocityGateStatus`, `getBalance`. *(Dead
      config/settings/native-pill cleanup is a trivial follow-up.)*
- [x] **"Can send credits" re-keyed** (decided 2026-07, shipped) — the gift gate in `transfer()` now
      requires **earned trust > 0** (one completed marketplace trade) instead of `tier.canGift`. Stops
      a fresh/farmed account forwarding received credits, and retires the last badge mechanic. Tested.
- [ ] **Invites: OPEN to everyone** (decided — uninhibited growth). Code already allows it; just delete
      the "Steward unlocks invitations" copy (native, next). **Governance** stays Phase 4, value-based votes.
