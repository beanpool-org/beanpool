# Specification: Derived Enterprise Credit Model

**Status:** SPECIFICATION / PROPOSED  
**Target File:** `docs/enterprise-credit-model.md`  
**Applies To:** `packages/beanpool-engine`, `apps/server`, `apps/manager`, `packages/beanpool-core`  
**Author:** Antigravity (Engine Architecture)  
**Date:** 2026-09-09  

---

## 1. Why This Exists

In BeanPool, an enterprise is represented by a member account flagged with `is_treasury = 1` (`apps/server/src/db/schema.sql:32`). It serves as the community trading face for collective initiatives (such as tool libraries, communal egg flocks, or local processing hubs), allowing them to author offers and needs, settle escrow, and maintain inventory.

Under the current implementation, an enterprise receives a credit limit (overdraft floor) through a hardcoded special-case override rather than from economic standing earned through trading.

### 1.1 Current Engine Behaviour and Code Analysis

The trust and credit floor engine is implemented in `packages/beanpool-engine/src/trust.ts`. The calculation occurs in `getMemberTrustProfile(db: Db, publicKey: string)` (`packages/beanpool-engine/src/trust.ts:347-422`), mirrored in the server runtime at `apps/server/src/state-engine.ts:860-873`.

The relevant current code in `packages/beanpool-engine/src/trust.ts:365-414` executes the following sequence:

```ts
// packages/beanpool-engine/src/trust.ts:365-373
const memberRow = db.prepare("SELECT earned_credit, elder_vouched_by, vouch_credit, COALESCE(credit_frozen, 0) as credit_frozen, is_treasury FROM members WHERE public_key = ?").get(publicKey) as any;
const grantedCredit = memberRow?.earned_credit || 0;
const elderVouched = !!memberRow?.elder_vouched_by;
const isTreasury = memberRow?.is_treasury === 1;
const vouchCredit = elderVouched ? (memberRow?.vouch_credit > 0 ? memberRow.vouch_credit : PROTOCOL_CONSTANTS.VOUCH_CREDIT_LIGHT) : 0;
const isCreditFrozen = memberRow?.credit_frozen === 1;

// packages/beanpool-engine/src/trust.ts:406-414
const activated = elderVouched || grantedCredit > 0 || earnedCredit > 0 || isTreasury;
const effectiveGranted = isTreasury ? Math.max(200, grantedCredit) : grantedCredit;
const allowance = (activated && !isCreditFrozen)
    ? Math.min(c.CREDIT_FLOOR_CAP, vouchCredit + earnedCredit + effectiveGranted)
    : 0;

const floor = c.CREDIT_BASE_FLOOR - allowance;
```

#### The Column Naming Trap
In `packages/beanpool-engine/src/trust.ts:365-366`, the database column `members.earned_credit` is read into a local variable named `grantedCredit`. This is a legacy naming trap:
- `members.earned_credit` in the SQLite database does NOT store earned credit from trading. It stores administrative grants, genesis seed limits, and manual overrides (`apps/server/src/state-engine.ts:2828-2835`, `apps/server/src/state-engine.ts:2925-2927`).
- Actual earned credit (`earnedCredit`) is computed on the fly in `packages/beanpool-engine/src/trust.ts:381-393` from completed escrow trades (`qualifiedTradeValue`) via the saturating curve function `earnedCreditFromValue(value)` and scaled by the member's star rating multiplier.
- When an enterprise is created via `createTreasury(name, avatar, creditLine = 0)` in `apps/server/src/state-engine.ts:2893-2938`, the argument `creditLine` (defaulting to 0) is written into `members.earned_credit` (`apps/server/src/state-engine.ts:2925-2927`).

#### The Hardcoded Enterprise Special Case
The enterprise special case creates two automatic side effects:
1. **Unconditional Activation:** `packages/beanpool-engine/src/trust.ts:406` sets `activated = ... || isTreasury`. Normal members require an elder vouch, an administrative grant, or completed trade volume (`earnedCredit > 0`) to activate an overdraft floor (`packages/beanpool-engine/src/trust.ts:403-406`, `docs/trust-model-v3.md:69`). An enterprise bypasses all activation requirements.
2. **Hardcoded Floor Override:** `packages/beanpool-engine/src/trust.ts:407` defines `effectiveGranted = isTreasury ? Math.max(200, grantedCredit) : grantedCredit`. Regardless of whether `createTreasury` was called with `creditLine = 0` (its function signature default in `apps/server/src/state-engine.ts:2896`), or what was stored in `members.earned_credit`, `effectiveGranted` evaluates to at least 200.
3. **Allowance and Floor:** Since `PROTOCOL_CONSTANTS.CREDIT_BASE_FLOOR = 0` (`packages/beanpool-core/src/protocol.ts:23`) and `PROTOCOL_CONSTANTS.CREDIT_FLOOR_CAP = 2000` (`packages/beanpool-core/src/protocol.ts:25`), if `isCreditFrozen === false`, `allowance` evaluates to at least 200, resulting in `floor <= -200` (`packages/beanpool-engine/src/trust.ts:414`).

#### Fleet Manager Coupling
The fleet manager UI in `apps/manager/src/components/modules/MembersModule.tsx` contains a modal to create community treasuries:
- `apps/manager/src/components/modules/MembersModule.tsx:178`: `const [newTreasuryCredit, setNewTreasuryCredit] = useState('200');`
- `apps/manager/src/components/modules/MembersModule.tsx:1049-1056`: A form input with `placeholder="200"` labelled "Deficit Credit Line (Beans)".
- Even if an administrator changes this form value to `0`, the engine's `Math.max(200, grantedCredit)` in `packages/beanpool-engine/src/trust.ts:407` forces the effective granted credit back up to 200.

#### Enforcement and Intervention of `credit_frozen`
The only existing operational lever that can suppress this credit line is `credit_frozen`:
- In `packages/beanpool-engine/src/trust.ts:408`, if `isCreditFrozen` evaluates to `true` (i.e. `members.credit_frozen === 1`), `allowance` is forced to `0`.
- This causes `floor = c.CREDIT_BASE_FLOOR - 0 = 0` (`packages/beanpool-engine/src/trust.ts:414`), collapsing the overdraft limit immediately to zero.
- `credit_frozen` is toggled administratively via `adminSetCreditFrozen(publicKey, frozen)` (`apps/server/src/state-engine.ts:2820-2823`).

### 1.2 Summary of Current vs Target Architecture

| Dimension | Current Implementation | Target Specification |
|---|---|---|
| Enterprise floor origin | Hardcoded engine override: `Math.max(200, grantedCredit)` (`trust.ts:407`) | Derived from active stewards' earned credit with a joint multiplier |
| Activation requirement | Auto-activated: `isTreasury` in `activated` expression (`trust.ts:406`) | Requires active stewards holding genuine earned credit > 0 |
| Empty enterprise floor | -200 Beans (unbacked default) | 0 Beans (no stewards = no credit line) |
| Scaling with stewards | Constant at -200 (or static grant), unaffected by keeper count | Super-additive curve $M(n)$ applied to the sum of stewards' earned credit |
| Maximum floor limit | Capped at `CREDIT_FLOOR_CAP = 2000` (`protocol.ts:25`, `trust.ts:409`) | Capped at `CREDIT_FLOOR_CAP = 2000` (`protocol.ts:25`) |
| Recourse on default | None: enterprise deficit is isolated to the enterprise row | Pro-rata reduction of stewards' personal floors; `credit_frozen` escalation |
| Steward exit handling | Unmanaged: keepership revoked, enterprise floor unchanged | Floor immediately recalibrates; deficit checks protect community solvency |

---

## 2. The Derived Credit Model

Under the derived credit model, an enterprise has no intrinsic or hardcoded credit line. Its credit limit is derived dynamically from the earned standing of the active human stewards who manage it.

### 2.1 The Core Derived Formula

```
enterprise_allowance = min( CREDIT_FLOOR_CAP, floor( M(n) * sum( steward_earned_credit_i ) ) )
enterprise_floor     = - enterprise_allowance
```

Where:
- $n$ is the number of distinct active stewards bound to the enterprise via `treasury_operators` (`apps/server/src/db/schema.sql:702-709`) where `members.can_operate = 1` (`apps/server/src/state-engine.ts:1724`).
- $\text{steward\_earned\_credit}_i$ is the individual earned credit of steward $i$, computed exclusively from completed, diversity-capped trade volume (`packages/beanpool-engine/src/trust.ts:381-393`).
- $M(n)$ is a diminishing, super-additive multiplier reflecting mutual commitment and peer cross-monitoring.
- `CREDIT_FLOOR_CAP` is the system ceiling of 2000 Beans (`packages/beanpool-core/src/protocol.ts:25`).

---

## 3. The Nine Protocol Rules

### Rule 1: Only Earned Credit Multiplies

Only a steward's genuine `earnedCredit` enters the multiplied sum. Vouched credit and administrative grants contribute at **x0** (they do not contribute to the enterprise floor).

#### Specification:
For each steward $i \in \{1, \dots, n\}$:
$$\text{EligibleCredit}_i = \text{steward\_earned\_credit}_i$$
Neither `vouchCredit` (welcome vouchers of 25, 50, or 100 Beans from `packages/beanpool-core/src/protocol.ts:28-30`) nor `grantedCredit` (stored in `members.earned_credit`) contribute to the enterprise floor.

#### Justification and Anti-Sybil Defense:
1. **Sybil Resistance:** Vouching is a lightweight, human-gated onboarding mechanism designed to give new individuals a small initial credit line (`docs/trust-model-v3.md:65`, `docs/security-floor-exploit-handover.md:49`). As documented in `docs/security-floor-exploit-handover.md:118-130` (Finding F5), vouch issuance has no cumulative volume ceiling per voucher. If vouched credit participated in enterprise multipliers, a compromised or colluding voucher could create multiple fresh identities, assign them welcome vouches, register them as stewards of an enterprise, and multiply unbacked credit into existence without a single hour of real community trade.
2. **Economic Backing:** Earned credit represents completed, escrow-settled marketplace trades (`packages/beanpool-engine/src/trust.ts:240-250`) subject to counterparty caps and star rating multipliers. It reflects proven community utility and reciprocal capacity. An enterprise operating at a deficit is borrowing community labour and goods; that borrowing must be underwritten by demonstrated producers, not newcomer vouchers or administrative cosmetic grants.
3. **No Unbacked Minting on Creation:** Setting vouched and granted credit to x0 ensures that creating an enterprise with unverified or newly invited accounts produces an overdraft floor of exactly 0.

---

### Rule 2: Diminishing, Capped Multiplier Curve M(n)

The multiplier function $M(n)$ rewards cooperative stewardship through a super-additive bonus while strictly diminishing at higher counts to reflect the limits of cross-monitoring and prevent governance bloat.

#### Multiplier Schedule:

| Active Stewards ($n$) | Multiplier $M(n)$ | Marginal Delta | Maximum Attainable Floor | Rationale |
|---|---|---|---|---|
| 0 | 0.00 | — | 0 | No stewards: enterprise cannot borrow. |
| 1 | 1.00 | +1.00 | -1333.33 (or steward limit) | Single keeper: sole liability, no peer monitoring synergy. |
| 2 | 1.25 | +0.25 | -2000 (if sum >= 1600) | Two keepers: direct joint liability and mutual accountability. |
| 3 | 1.40 | +0.15 | -2000 (if sum >= 1429) | Three keepers: small executive committee. Diminishing returns. |
| 4 | 1.50 | +0.10 | -2000 (if sum >= 1334) | Four keepers: maximum joint synergy factor. |
| 5 or more | 1.50 | 0.00 | -2000 (if sum >= 1334) | Flat cap: prevents Sybil steward stacking. |

#### Empirical Calibration:
Consider two stewards with modest trading histories:
- Steward A has an earned credit line of 100 Beans (achieved with approximately 275 Beans of qualified trade volume: $1920 \times 275 / (275 + 5000) \approx 100$).
- Steward B has an earned credit line of 60 Beans (achieved with approximately 161 Beans of qualified trade volume: $1920 \times 161 / (161 + 5000) \approx 60$).

Under the proposed schedule:
$$\text{Sum} = 100 + 60 = 160$$
$$\text{Enterprise Allowance} = 1.25 \times 160 = 200$$
$$\text{Enterprise Floor} = -200$$

This exactly reproduces today's hardcoded default of -200 (`packages/beanpool-engine/src/trust.ts:407`), but every single bean of the borrowing capacity is now justified by real, completed economic trades.

---

### Rule 3: Distinct Counterparties and Hot-Path Caching

If stewards could qualify based on circular trading among themselves or with a single external accomplice, a syndicate could inflate the enterprise floor.

#### 3.1 Overlap Detection and De-duplication Rule:
1. **Inter-Steward Volume Exclusion:** In computing $\text{steward\_earned\_credit}_i$ for the purpose of the enterprise floor, any trade volume where the counterparty is another steward of the same enterprise MUST be excluded.
2. **Distinct External Counterparties Requirement:**
   - Let $C_i$ denote the set of distinct counterparties who traded with steward $i$ in completed marketplace transactions.
   - If two stewards $A$ and $B$ both traded with counterparty $X$, counterparty $X$'s volume cannot be double-counted across both stewards to inflate the collective base.
   - The engine's existing `PER_COUNTERPARTY_VOLUME_CAP = 500` (`packages/beanpool-engine/src/trust.ts:21`, `packages/beanpool-core/src/protocol.ts:40`) caps volume at 500 per pair.
   - For an enterprise, the qualified volume from any external counterparty $X$ summed across ALL stewards of that enterprise is capped at $M(n) \times \text{PER\_COUNTERPARTY\_VOLUME\_CAP}$ (i.e. $M(n) \times 500$).

#### 3.2 Performance and Hot-Path Caching:
- In BeanPool, `getBalance` and `usableFloor` are invoked on every transaction, marketplace request, and UI balance poll (`apps/server/src/state-engine.ts:1136-1166`, `1236-1238`, `1642-1645`).
- Computing full trade-graph counterparty intersections on every balance read across $n$ stewards would require $O(n)$ multi-table SQL queries with joins over `marketplace_transactions` and `treasury_operators`. Doing this on the hot path would severely degrade node throughput.
- **Architectural Requirement:**
  1. The derived floor of an enterprise must be cached in memory or materialized in SQLite (e.g. `enterprise_floor_cache` table or cached on the `members` row).
  2. Cache invalidation must occur asynchronously upon:
     - Completion of any marketplace transaction involving a steward (`apps/server/src/state-engine.ts:2360-2432`).
     - Assignment or revocation of a keeper in `treasury_operators` (`apps/server/src/state-engine.ts:1739-1772`).
     - Modification of a steward's `credit_frozen` or status flag (`apps/server/src/state-engine.ts:2815-2823`).
  3. Balance checks on the transfer hot path (`transfer()` in `apps/server/src/state-engine.ts:1191-1245`) read the cached derived floor in $O(1)$ time.

---

### Rule 4: Recourse on Default

If an enterprise incurs a deficit and fails to service or clear it, the deficit must be recourseable to the stewards. Without personal recourse, the multiplier is an unbacked subsidy, and joint liability is meaningless.

#### 4.1 Definition of Default:
An enterprise is classified as in **Default** when any of the following objective conditions is met:
1. **Prolonged Inactive Deficit:** The enterprise balance has remained negative ($\text{balance} < 0$) for 60 consecutive days without recording any inbound marketplace trade or direct transfer.
2. **Offer Covenant Abandonment:** The enterprise balance is negative, and it maintains 0 active offers for more than 14 consecutive days (violating the offer covenant specified in `docs/trust-model-v3.md:73-89` and `apps/server/src/state-engine.ts:2887-2888`).
3. **Formal Operator Resolution:** An administrative or governance declaration of insolvency (`docs/community-governance.md`).

#### 4.2 Pro-Rata Liability Computation:
When default occurs, the total outstanding enterprise deficit $D = |\text{balance}|$ is apportioned across all active stewards based on their relative earned credit contribution:

$$\text{Share}_i = \frac{\text{steward\_earned\_credit}_i}{\sum_{j=1}^n \text{steward\_earned\_credit}_j}$$
$$\text{PersonalLiability}_i = D \times \text{Share}_i$$

#### 4.3 Enforcement Lever via `credit_frozen`:
BeanPool already provides a clean credit enforcement lever in `members.credit_frozen` (`packages/beanpool-engine/src/trust.ts:372`, `apps/server/src/state-engine.ts:2820-2823`):
1. **Floor Compression:** Steward $i$'s personal credit allowance is immediately compressed by $\text{PersonalLiability}_i$:
   $$\text{steward\_allowance}_i' = \max(0, \text{steward\_allowance}_i - \text{PersonalLiability}_i)$$
2. **Hard Freeze on Non-Remedy:** If the steward's personal balance is deeper than their newly compressed floor, or if the enterprise default remains unaddressed after a 14-day cure notice, the steward's `members.credit_frozen` flag is set to `1`.
3. **Effect of Freeze:** When `credit_frozen === 1`, the steward's personal credit allowance collapses to 0 (`packages/beanpool-engine/src/trust.ts:408-410`). The steward is blocked from all outbound credit spending and offer bidding, while remaining free to earn inbound credits and receive payments to trade their way back into positive balance (`docs/trust-model-v3.md:129-139`).

#### 4.4 Reversibility:
Recourse charges are fully reversible:
- If the enterprise later earns credits (e.g. from delayed seasonal sales or outside contributions) and returns to balance ($\text{balance} \ge 0$), the pro-rata encumbrance on each steward's personal floor is released automatically.
- If a steward's personal `credit_frozen` flag was triggered solely by enterprise default, it auto-clears upon enterprise restoration.

#### 4.5 User Experience (Before and After Default):
- **Before Default:** The steward's Ledger shows their personal floor (e.g. `Floor: -600`) and an enterprise card showing `Kept by you: Community Eggs (Deficit: -120 / Limit: -200, Status: Active)`.
- **Upon Default:** The steward's Ledger displays an alert banner:
  > Enterprise Default Notice: Community Eggs is 60 days in arrears with a balance of -120. Your pro-rata liability is 60 Beans. Your personal credit floor is temporarily compressed from -600 to -540. Clear the enterprise deficit or restore active offers to unfreeze.

---

### Rule 5: Steward Exit Under Deficit

A steward leaving an enterprise reduces $n$, which immediately contracts the multiplier $M(n)$ and subtracts that steward's earned credit from the pool. If the enterprise is carrying a deficit, the departure can instantly leave the enterprise "underwater" (balance below the new floor).

#### 5.1 Rejection of Committed Balances:
The maintainer previously evaluated and explicitly rejected an accounting model requiring stewards to deposit or "commit" ledger balances into enterprises, because:
- It was computationally complex and slowed down trading.
- It created contentious exit disputes ("what do they take with them when they leave?").
- The derived credit model must NOT reintroduce committed balance accounting. Balances remain strictly in the enterprise and steward accounts.

#### 5.2 Departure Protocol:
1. **Solvent Departure ($\text{balance} \ge 0$):**
   - If the enterprise has a zero or positive balance, any steward may exit immediately via `adminRevokeTreasuryOperator` (`apps/server/src/state-engine.ts:1762-1772`) or self-resignation.
   - The enterprise floor immediately adjusts to $M(n-1) \times \sum_{j \ne i} E_j$.
   - The exiting steward departs with zero residual liability.
2. **Deficit Departure ($\text{balance} < 0$):**
   - If the enterprise has a deficit $D = |\text{balance}|$, calculate the projected new floor $F_{\text{new}}$ with the steward removed.
   - **Case A: Remaining Stewards Cover Deficit ($D \le |F_{\text{new}}|$):**
     The departure is permitted immediately. The enterprise remains solvent within its new, shallower floor. The remaining stewards absorb the collective responsibility.
   - **Case B: Enterprise Would Be Underwater ($D > |F_{\text{new}}|$):**
     If removing the steward causes the deficit to exceed the new floor, the steward cannot unilaterally walk away and dump the unbacked deficit on the community or remaining stewards (preventing a "race to the exit").
     The exit triggers a **30-day Notice and Transition Window**:
     - The enterprise is marked with `status = 'winding_down'` and enters a spend-freeze: outbound credit spending is blocked, while inbound trade and payments remain fully operational (`docs/trust-model-v3.md:128-139`).
     - During the 30-day window, the enterprise may recruit a replacement steward whose earned credit restores the floor, or trade down its deficit.
     - If the deficit is not resolved after 30 days, the unbacked portion of the deficit ($D - |F_{\text{new}}|$) is charged to the departing steward's personal credit floor under the Rule 4 recourse mechanism, after which their keepership record in `treasury_operators` is deleted.

---

### Rule 6: What This Replaces in the Codebase

Implementing this specification eliminates the hardcoded special cases across the engine and server.

#### Exact Edit Surface:

1. **`packages/beanpool-engine/src/trust.ts`:**
   - **Lines 406-407:**
     ```ts
     // CURRENT:
     const activated = elderVouched || grantedCredit > 0 || earnedCredit > 0 || isTreasury;
     const effectiveGranted = isTreasury ? Math.max(200, grantedCredit) : grantedCredit;

     // REPLACEMENT:
     // isTreasury is removed from activation.
     // effectiveGranted no longer contains Math.max(200, grantedCredit).
     // For is_treasury accounts, allowance is computed via the derived enterprise formula.
     ```
   - Replace the static calculation for enterprises with dynamic steward query:
     Query active stewards from `treasury_operators` (`apps/server/src/db/schema.sql:702-709`) where `members.can_operate = 1`, compute the de-duplicated earned credit sum of stewards, apply the $M(n)$ multiplier, and clamp to `CREDIT_FLOOR_CAP`.
   - **Line 408:** `isCreditFrozen` continues to enforce an immediate allowance clamp to 0.

2. **`apps/server/src/state-engine.ts`:**
   - **Lines 2893-2938 (`createTreasury`):**
     - Remove `creditLine` parameter (or deprecate it as unused legacy).
     - Cease inserting `line` into `members.earned_credit` (`apps/server/src/state-engine.ts:2925-2927`). Insert `0`.
     - Creation initializes the enterprise with a derived floor of 0 until stewards are assigned.
   - **Lines 1739-1772 (`adminAssignTreasuryOperator` / `adminRevokeTreasuryOperator`):**
     - Invalidate the enterprise floor cache and broadcast `treasury_updated` whenever operators are added or removed.

3. **`apps/server/src/routes/treasury.ts`:**
   - **Lines 105-133 (`GET /api/treasuries`):**
     - Line 125 currently reports `creditLine: r.earned_credit`. This must report the dynamically derived credit line `b.floor` (as positive magnitude).
   - **Lines 135-158 (`GET /api/treasury/:treasury`):**
     - Line 150 currently reports `creditLine: b.earnedCredit`. This must report the derived steward-backed limit.

4. **`apps/manager/src/components/modules/MembersModule.tsx`:**
   - **Lines 178, 1049-1056:** Remove the hardcoded `200` default deficit credit line input from the Create Treasury modal. Replace it with an explanatory label: *"Credit line will be derived automatically from assigned stewards' earned trade standing."*

5. **`apps/server/src/test-treasury-eggs.ts`:**
   - **Line 45-50:** The proof test creates a treasury and immediately asserts `floor <= -200`. Under the new model, this test must assign a steward with earned credit (e.g. Otto or Fiona) to activate the floor.

---

### Rule 7: Migration Strategy and Production Node Safety

There are three enterprises currently operating across deployed nodes:
1. **BeanPool** (genesis/core node account)
2. **Daily Pulse** (automated news aggregator and feed enterprise)
3. **Community Eggs** (live community enterprise on `mullum1.beanpool.org` / `mullum2.beanpool.org`)

#### 7.1 Specific Risk to Community Eggs on Mullum:
- `mullum` is a live community with real users trading real goods, not a staging environment (`README.md:14, 465`, `docs/sso-client-handover.md:275`).
- `Community Eggs` on `mullum` currently holds an account balance of approximately +35.82 Beans and an active credit line of 200 Beans (`scripts/bootstrap-community-eggs.mjs:26`).
- It regularly dips into deficit to purchase organic feed in advance of egg deliveries.
- If the engine cutover deployed with an immediate zero floor for unbacked treasuries, and its stewards had not yet been formally assigned in `treasury_operators` with sufficient earned credit, `Community Eggs` would drop to a floor of 0.
- While its balance is currently +35.82, the very next chicken feed purchase that exceeds 35.82 Beans would be blocked by `transfer()` (`apps/server/src/state-engine.ts:1236-1244`), stranding real agricultural operations in the Mullumbimby community.

#### 7.2 Migration Options Matrix:

| Strategy | Mechanism | Pros | Cons / Risks |
|---|---|---|---|
| **Option A: Explicit Legacy Grant** | Set `members.earned_credit = 200` and `is_legacy_enterprise = 1` for existing treasuries; grandfather existing 200 floor until stewards qualify. | Zero downtime, zero risk of stranding `Community Eggs` on live nodes. | Leaves unearned credit active for existing nodes until phased out. |
| **Option B: 90-Day Transition Window** | Engine calculates `floor = min(legacy_200, derived_floor)` for 90 days post-migration. | Predictable sunset date; gives Mullum keepers time to build personal trade history. | Requires date-comparison logic in the engine core. |
| **Option C: Hard Cutover with Pre-Seeding** | Require node operators to populate `treasury_operators` with qualified stewards before deploying the new binary. | Clean break; zero legacy code paths in new engine. | High operational risk: if an operator forgets or misconfigures a keeper on `mullum`, live trades fail. |

#### 7.3 Migration Specification:
The specification adopts **Option A with an Administrative Sunset**:
1. Migration script `migrations/2026-09-enterprise-credit-model.sql` sets an explicit column flag `legacy_credit_floor = 200` on existing rows where `is_treasury = 1`.
2. For any enterprise with `legacy_credit_floor > 0`, the engine calculates:
   $$\text{allowance} = \max(\text{legacy\_credit\_floor}, \text{derived\_allowance})$$
3. When the stewards of `Community Eggs` accumulate sufficient earned credit such that $\text{derived\_allowance} \ge 200$, the system automatically clears `legacy_credit_floor = 0`.
4. All newly created enterprises start with `legacy_credit_floor = 0` and are strictly governed by the derived model from day one.

---

### Rule 8: Phase 2 Lever — Bean-Backing Collateral

As an extension to the derived credit model, an enterprise may expand its credit line through direct bean-backing collateral.

#### Phase 2 Specification Summary:
- A member may lock liquid positive Beans into a dedicated escrow sub-account (`escrow_collateral_<treasury>_<member>`), similar to how `escrow_*` accounts hold funds mid-trade (`apps/server/src/state-engine.ts:1210`, `packages/beanpool-core/src/ledger.ts:45`).
- Collateral Beans expand the enterprise credit line **unmultiplied** (at a strict 1:1 ratio):
  $$\text{enterprise\_allowance} = \min(\text{CREDIT\_FLOOR\_CAP}, M(n) \cdot \sum E_i + \text{LockedCollateral})$$
- **Drawdown Priority:** In the event of enterprise default, locked collateral beans are liquidated first to settle the deficit before any pro-rata recourse touches stewards' personal credit lines.
- **Cryptographic Consent:** Locking collateral requires an Ed25519-signed authorization from the pledging member, and unlocking requires either a zero enterprise balance or approval from the enterprise operators.

---

### Rule 9: Self-Serve Enterprise Creation

Under the current architecture, enterprise creation is restricted to node administrators via `POST /api/local/admin/treasury` (`apps/server/src/routes/treasury.ts:161-168`) because creating an enterprise previously handed out a free 200-Bean overdraft line.

#### 9.1 Why Self-Serve Is Safe Under This Model:
Under the derived model, **creating an enterprise mints zero beans and zero credit limit**.
An enterprise created with no stewards has an allowance of 0 and a floor of 0. It cannot borrow, spend into deficit, or extract value from the network. It becomes spend-capable only when qualified stewards bind their earned reputation to it.

#### 9.2 Guardrails Still Required:

| Guardrail | Enforcement Point | Specification |
|---|---|---|
| **Name Uniqueness** | `apps/server/src/state-engine.ts:2910` | Case-insensitive collision refusal: `SELECT 1 FROM members WHERE lower(callsign)=lower(?) AND status NOT IN ('migrated', 'pruned')`. Retained. |
| **Creator Standing Gate** | `POST /api/treasuries/create` | The creator must be an active member who has completed at least one verified trade (`earnedCredit > 0`). Prevents fresh bot accounts from spamming empty enterprise rows. |
| **Per-Member Enterprise Limit** | `apps/server/src/state-engine.ts` | A member may not be an active steward of more than 3 enterprises simultaneously. Prevents concentration of liability and contagion. |
| **Asset Validity** | `apps/server/src/state-engine.ts:2903-2905` | Name minimum 2 characters; valid SVG avatar or image URI required. |

---

## 4. Worked Numerical Examples

### Example 1: Two-Newcomer Co-op
- **Participants:** Alice and Bob, both newly onboarded.
- **Alice Standing:** 0 trades, vouched at Level 1 (`vouchCredit = 25`, `earnedCredit = 0`).
- **Bob Standing:** 0 trades, vouched at Level 2 (`vouchCredit = 50`, `earnedCredit = 0`).
- **Calculation:**
  - $n = 2 \implies M(2) = 1.25$.
  - Under Rule 1, vouched credit contributes at x0.
  - $\text{Sum of Earned Credit} = 0 + 0 = 0$.
  - $\text{Enterprise Allowance} = \min(2000, 1.25 \times 0) = 0$.
  - **Enterprise Floor: 0 Beans.**
- **Outcome:** Alice and Bob can create the co-op, but it cannot spend into deficit. They must sell produce or receive gifts before spending.

---

### Example 2: Two-Established-Trader Co-op
- **Participants:** Carol and Dave, both experienced local producers.
- **Carol Standing:** 15 completed trades across 4 partners. `earnedCredit = 100`.
- **Dave Standing:** 8 completed trades across 3 partners. `earnedCredit = 60`.
- **Calculation:**
  - $n = 2 \implies M(2) = 1.25$.
  - $\text{Sum of Earned Credit} = 100 + 60 = 160$.
  - $\text{Enterprise Allowance} = \min(2000, \text{floor}(1.25 \times 160)) = 200$.
  - **Enterprise Floor: -200 Beans.**
- **Outcome:** The enterprise receives a -200 overdraft line. This precisely replicates today's legacy default, but is fully underwritten by Carol and Dave's trading reputations.

---

### Example 3: Four-Steward Co-op Hitting CREDIT_FLOOR_CAP
- **Participants:** Four veteran community members (Emma, Frank, Grace, Henry).
- **Individual Earned Credits:**
  - Emma: `earnedCredit = 600`
  - Frank: `earnedCredit = 400`
  - Grace: `earnedCredit = 300`
  - Henry: `earnedCredit = 300`
- **Calculation:**
  - $n = 4 \implies M(4) = 1.50$.
  - $\text{Sum of Earned Credit} = 600 + 400 + 300 + 300 = 1600$.
  - $\text{Unclamped Allowance} = 1.50 \times 1600 = 2400$.
  - `CREDIT_FLOOR_CAP` clamp applied: $\min(2000, 2400) = 2000$.
  - **Enterprise Floor: -2000 Beans.**
- **Outcome:** The enterprise hits the absolute system ceiling of -2000 Beans.

---

### Example 4: Steward Leaving an Underwater Enterprise
- **Initial State:** Four-steward co-op from Example 3.
- **Current Balance:** Enterprise has spent into deficit for inventory: `balance = -1600`.
- **Event:** Emma (`earnedCredit = 600`) resigns as keeper.
- **Recalculation:**
  - Remaining stewards: Frank (400), Grace (300), Henry (300).
  - $n = 3 \implies M(3) = 1.40$.
  - $\text{New Earned Sum} = 400 + 300 + 300 = 1000$.
  - $\text{New Enterprise Allowance} = \min(2000, \text{floor}(1.40 \times 1000)) = 1400$.
  - **New Enterprise Floor: -1400 Beans.**
- **Status Analysis:**
  - Current balance is `-1600`.
  - The new floor is `-1400`.
  - The enterprise is underwater by 200 Beans (`-1600 < -1400`).
- **Resolution under Rule 5:**
  - The enterprise is immediately spend-frozen (`balance < usableFloor`). Outbound credit purchases are blocked.
  - A 30-day notice window initiates. The enterprise must either recruit a replacement keeper or sell 200 Beans of inventory to return within its -1400 limit.
  - If unrectified after 30 days, the 200-Bean excess deficit is charged to Emma's personal credit floor, permitting her clean release.

---

### Example 5: Enterprise Default and Personal Recourse
- **Context:** An enterprise with 2 stewards fails to sell its stock and is abandoned.
- **Stewards:**
  - Steward A: `earnedCredit = 100` (Personal Balance: +20, Personal Floor: -200).
  - Steward B: `earnedCredit = 50` (Personal Balance: -10, Personal Floor: -100).
- **Enterprise Deficit:** The enterprise sits at `balance = -150` with 0 active offers for 65 days.
- **Default Action (Rule 4):**
  - $\text{Total Deficit } D = 150$.
  - $\text{Total Earned Base } S = 100 + 50 = 150$.
  - Steward A share: $100 / 150 = 66.67\% \implies \text{Liability}_A = 100 \text{ Beans}$.
  - Steward B share: $50 / 150 = 33.33\% \implies \text{Liability}_B = 50 \text{ Beans}$.
- **Impact on Steward Profiles:**
  - **Steward A:**
    - Personal floor compressed: $-200 + 100 = -100$.
    - Current balance (+20) is well above new floor (-100).
    - Status: Not frozen. Can continue personal trading.
  - **Steward B:**
    - Personal floor compressed: $-100 + 50 = -50$.
    - Current balance is -10 (above -50).
    - If Steward B's balance had been -60, they would be spend-frozen immediately until paying down 10 beans.

---

## 5. Conservation Analysis

BeanPool's economic architecture is governed by strict mutual credit principles: money is not an asset issued by a central party; it is a ledger of peer obligations.

### 5.1 Ledger Conservation: The Sum-to-Zero Invariant
In `scripts/audit-conservation.mjs:73-85`, the node audit script verifies the fundamental mutual credit invariant:
$$\sum_{a \in \text{Accounts}} \text{balance}(a) + \text{COMMONS\_POOL} = 0$$

Every positive bean in circulation exists solely because another account is negative.

#### Does the Derived Model Break Ledger Conservation?
**No.** A credit floor is an overdraft limit, not a balance. 
- Setting an enterprise floor to -200 or -1400 writes zero transactions to the ledger and creates zero beans.
- When an enterprise spends 20 Beans into deficit to pay a tender (`apps/server/src/test-treasury-eggs.ts:59-71`), the enterprise balance becomes -20, the tender receives +19.7, and the Commons Pool receives +0.3 fee. The sum of balances remains exactly 0.0000.
- `scripts/audit-conservation.mjs` will report `balanced: true` regardless of the multiplier chosen, because credit limits do not alter ledger balances.

### 5.2 Macro-Prudential Risk Analysis: Unbacked Credit Generation
While ledger conservation is mathematically preserved, the multiplier $M(n)$ creates **unbacked purchasing capacity**—potential debt that was not directly earned by a prior completed trade.

The quantity of unbacked purchasing power introduced at each steward count is:

$$\text{Unbacked Capacity}(n) = (M(n) - 1) \times \sum_{i=1}^n \text{steward\_earned\_credit}_i$$

| $n$ | Multiplier $M(n)$ | Multiplier Premium | Unbacked Capacity per 1000 Earned Beans | Maximum Theoretical Unbacked Beans (at cap) |
|---|---|---|---|---|
| 1 | 1.00 | 0% | 0 Beans | 0 Beans |
| 2 | 1.25 | +25% | 250 Beans | 400 Beans |
| 3 | 1.40 | +40% | 400 Beans | 571 Beans |
| 4+ | 1.50 | +50% | 500 Beans | 666 Beans |

#### Why This Risk Price Is Acceptable:
1. **Strictly Capped Exposure:** The absolute maximum unearned purchasing capacity any enterprise can ever introduce to the network is 666.67 Beans (when a 4-steward co-op with 1333.33 earned credit hits the 2000 cap). Today's system introduces 200 Beans of completely unbacked credit per enterprise with zero stewards and zero trade history.
2. **Backing by Verified Track Records:** To unlock that 666-Bean premium, the stewards must collectively demonstrate 1,333 Beans of earned credit, requiring thousands of Beans of completed, diversity-capped marketplace deliveries.
3. **Internalized Recourse:** If an enterprise defaults, the unbacked premium is absorbed back into the stewards' personal credit lines via Rule 4 recourse. The community does not bear unrecoverable bad debt unless all stewards simultaneously default and abandon their personal accounts.

---

## 6. Attack and Threat Model Analysis

This analysis reconciles the proposed model with the findings in `docs/security-floor-exploit-handover.md` and `docs/trust-model-v3.md`.

### 6.1 Attack Comparison: Existing vs Proposed Model

| Attack Vector | Current Implementation (`trust.ts:406-407`) | Proposed Derived Model | Security Implication |
|---|---|---|---|
| **Empty Enterprise Farm** | Attacker creates 10 enterprise rows via admin route or script. Each instantly gets -200 floor. Total unbacked credit: **2,000 Beans**. Cost: 0 Beans. | 10 enterprise rows created without stewards receive a floor of **0 Beans**. | Attack completely eliminated. Creating enterprises without earned trust yields 0 extractable credit. |
| **Sybil Ring Steward Stacking** | Not applicable (current engine ignored stewards). | Attacker forms an enterprise and assigns 5 sock accounts as stewards. | Under Rule 1, sock accounts with 0 earned trades contribute 0 to the floor. To contribute, socks must trade. |
| **Wash-Trading Steward Ring** | Attacker trades between socks to build earned credit. Under `docs/security-floor-exploit-handover.md:75-89`, a ring of 4 socks self-mints -1,440 each. | Stewards' trades with each other are excluded under Rule 3. Shared external counterparties are capped at $M(n) \times 500$. Flagged wash pairs face soft haircuts (`trust.ts:251-279`). | Drastically raises the cost of attack. The ring must pay 1.5% marketplace fees across dozens of independent non-colluding accounts. |
| **Exit Dumping / Bust-Out** | Enterprise spends -200, keeper deletes identity or unbinds. Community absorbs 200 debt. | Rule 5 blocks unilateral exit under deficit without notice or personal debt charge. | Eliminates walk-away bust-out by individual operators. |

### 6.2 Reconciliation with Prior Documents:
- **Agreement with `docs/security-floor-exploit-handover.md`:**
  - Confirms Finding F1: Sybil rings are priced in distinct identities. Rule 3 reinforces the `PER_COUNTERPARTY_VOLUME_CAP = 500` lever (`security-floor-exploit-handover.md:151-153`) by preventing duplicate partner volume across stewards.
  - Confirms Finding F2: Soft haircuts for wash clusters (`trust.ts:251-279`) must feed directly into the steward earned credit sum.
- **Agreement with `docs/trust-model-v3.md`:**
  - Adopts the offer covenant and spend-freeze mechanics: an enterprise with a negative balance must maintain active offers (`docs/trust-model-v3.md:73-89`, `120-144`). If it falls below its required offers or enters default, outbound spending freezes while inbound settlement remains active.
- **Departures / Contradictions:**
  - `docs/trust-model-v3.md:26` noted that `grantedCredit` provides an admin head-start for residents and elders. This specification explicitly contradicts extending `grantedCredit` into the enterprise multiplier: granted credit does NOT multiply (Rule 1).

---

## 7. Server Test Plan

To verify this model, existing tests must be adjusted and a dedicated test suite must be added.

### 7.1 Existing Server Suites to Update:
1. **`apps/server/src/test-treasury-eggs.ts`:**
   - Currently asserts `floor <= -200` immediately on line 49 after calling `createTreasury('Community Eggs', AVATAR, 200)`.
   - Update: Seed Otto or Fiona with completed trade history, assign them via `adminAssignTreasuryOperator`, and assert that the floor dynamically activates based on their earned credit.
2. **`apps/server/src/test-treasury-keepership.ts`:**
   - Update keepership assign/revoke tests to assert that revoking a keeper recalculates the enterprise floor.
3. **`apps/server/src/test-commons-conservation.ts`:**
   - Assert that enterprise credit spending and default recourse preserve `SUM(balance) == 0`.

### 7.2 New Suite: `apps/server/src/test-enterprise-credit-model.ts`

The new suite must test the following boundary cases:

| Test Case ID | Scenario | Input Conditions | Expected Output |
|---|---|---|---|
| `ECM-01` | Zero Stewards | Newly created enterprise. | `floor === 0`, `activated === false`. |
| `ECM-02` | Newcomer Stewards Only | 2 stewards with 0 trades, vouched at L2 (`vouchCredit = 50`). | `floor === 0`. Vouched credit does not multiply or contribute. |
| `ECM-03` | Single Steward ($n=1$) | 1 steward with `earnedCredit = 120`. | $M(1) = 1.00 \implies \text{floor} = -120$. |
| `ECM-04` | Two Stewards ($n=2$) | Steward A (100), Steward B (60). | $M(2) = 1.25 \implies \text{floor} = -200$. Exactly matches legacy floor. |
| `ECM-05` | Diminishing Curve ($n=3, 4, 5$) | Add stewards incrementally; verify $M(3)=1.40, M(4)=1.50, M(5)=1.50$. | Multiplier strictly adheres to schedule; does not exceed 1.50 at $n=5$. |
| `ECM-06` | Cap Boundary | 4 stewards with 600 earned credit each ($\sum = 2400$). | $\text{floor} = -2000$. Clamped at `CREDIT_FLOOR_CAP`. |
| `ECM-07` | Inter-Steward Volume Wash | Steward A and B have 500 volume traded only with each other. | Excluded from enterprise base. `floor === 0`. |
| `ECM-08` | Steward Departure (Solvent) | Enterprise balance = 0. Steward leaves. | Floor immediately updates to $M(n-1) \sum E_j$. No freeze. |
| `ECM-09` | Steward Departure (Underwater) | Enterprise balance = -300. Floor drops to -200 on departure. | Enterprise enters spend-freeze. 30-day notice period triggers. |
| `ECM-10` | Enterprise Default Recourse | Enterprise inactive at -150 for 60 days. | Stewards' personal floors compressed pro rata. `credit_frozen` applied if unrectified. |
| `ECM-11` | Recourse Reversal | Defaulted enterprise receives payment clearing deficit to 0. | Stewards' personal floors restored; `credit_frozen` lifted. |

---

## 8. Open Questions for the Maintainer

These decisions determine key parameter values and operational tradeoffs. Each question presents options with their architectural consequences.

### Decision 1: Multiplier Curve Schedule and Asymptote
- **Option A (Proposed):** $M(1)=1.0, M(2)=1.25, M(3)=1.40, M(4+)=1.50$.
  - *Consequence:* Caps collective leverage at 1.5x. Requires 1334 earned beans across 4 stewards to reach the -2000 cap. Conservative risk posture.
- **Option B (More Generous):** $M(1)=1.0, M(2)=1.30, M(3)=1.60, M(4)=1.80, M(5+)=2.00$.
  - *Consequence:* Doubles collective credit for 5-person cooperatives. Enables larger upfront enterprise purchases, but increases unbacked purchasing capacity to 1,000 Beans.
- **Option C (Strict Linear):** Flat $M(n) = 1.0$ for all $n$ (simple sum of earned credit without super-additive multiplier).
  - *Consequence:* Completely eliminates unbacked credit risk. However, removes the economic incentive for collective co-stewardship and joint liability.

### Decision 2: Counterparty Overlap Filtering Strategy
- **Option A (Strict Graph De-duplication):** Exclude shared external counterparty volume exceeding 500 Beans across all stewards of an enterprise.
  - *Consequence:* Maximum Sybil defense, but requires caching and invalidation logic across multiple stewards' trade graphs.
- **Option B (Inter-Steward Exclusion Only):** Exclude only trades between co-stewards of the enterprise; allow shared third-party counterparties up to each steward's individual cap.
  - *Consequence:* Substantially simpler SQL queries and cache maintenance. Modest vulnerability if two stewards legitimately share the same major village supplier.

### Decision 3: Default Inactivity Timeout
- **Option A (60 Days):** Enterprise flagged in default after 60 consecutive days in deficit with zero trade activity.
  - *Consequence:* Matches seasonal rural community rhythms (e.g. egg laying cycles, harvests).
- **Option B (30 Days):** Enterprise flagged after 30 days in deficit without activity.
  - *Consequence:* Faster bad-debt resolution, but may prematurely penalize seasonal agricultural enterprises.
- **Option C (Human Governance Gated):** Default declared only by node administrative action or community governance proposal.
  - *Consequence:* Zero automated false positives, but risks inactive debt lingering indefinitely if operators are passive.

### Decision 4: Liability Allocation on Steward Departure
- **Option A (Notice Period with Excess Debt Transfer):** 30-day notice window; if unresolved, excess unbacked debt ($D - |F_{\text{new}}|$) is transferred to exiting steward's personal floor.
  - *Consequence:* Prevents dumping debt on remaining stewards; protects the enterprise. Requires managing a transition state.
- **Option B (Immediate Exit with Collective Dilution):** Steward exits immediately; remaining stewards must cover the full deficit; if underwater, enterprise immediately freezes until resolved.
  - *Consequence:* Simple state machine with no transition states. Creates a first-mover incentive to quit an ailing enterprise.

### Decision 5: Live Node Migration for Mullum Community Eggs
- **Option A (Grandfather with Legacy Sunset Column):** Tag existing live enterprises with `legacy_credit_floor = 200` in a SQLite migration. Sunset automatically once earned derived floor reaches 200.
  - *Consequence:* Completely safe for `mullum1` and `mullum2`. Zero chance of blocking the egg flock. Temporary complexity in `trust.ts`.
- **Option B (Administrative One-Off Grant):** Admin issues a direct grant to the `Community Eggs` member row.
  - *Consequence:* Uses existing `members.earned_credit` column without schema changes. Reintroduces the naming trap for that specific account.
