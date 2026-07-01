# BeanPool Protocol Rules

> The Social Capital Ledger — A rule book for independent community economics.

**Protocol Version:** 1 (Draft)
**Last Updated:** 2026-05-02

---

## Table of Contents

1. [Overview](#1-overview)
2. [The Bean (Beans)](#2-the-bean-ʀ)
3. [Reference Rate](#3-reference-rate)
4. [Mutual Credit](#4-mutual-credit)
5. [Dynamic Credit Floor (Borrowing Limit)](#5-dynamic-credit-floor-borrowing-limit)

7. [Identity Tiers](#7-identity-tiers)
8. [Community Circulation & Transaction Fee](#8-community-circulation--transaction-fee)
9. [Invitations](#9-invitations)
10. [Anti-Sybil Defences](#10-anti-sybil-defences)
11. [Marketplace & Escrow](#11-marketplace--escrow)
12. [Transaction Guardrails](#12-transaction-guardrails)
13. [Achievements](#13-achievements)
14. [Federation](#14-federation)
15. [Protocol Constants](#15-protocol-constants)
16. [Glossary](#16-glossary)

---

## 1. Overview

BeanPool operates a **mutual credit** system. There is no money supply. When Alice pays Bob 40 Beans, Alice goes to −40 and Bob goes to +40. The network always sums to zero. Credit is not pre-created — it is issued the moment a trade happens, backed by the community's trust in the participants.

The rules in this document exist to answer three questions:

1. **How much can someone borrow?** → The Dynamic Credit Floor.
2. **How do we stop cheating?** → Anti-Sybil Defences.

---

## 2. The Bean (Beans)

The Bean is the unit of account. It is not pegged to any fiat currency. It has no intrinsic value — its value comes from the community's agreement to accept it in exchange for real goods and services.

- Symbol: **Beans** (or 🫘 in informal contexts)
- Precision: 2 decimal places
- Supply: None. The network sum is always zero.

---

## 3. Reference Rate

To help participants understand the value of a Bean, the protocol defines a **reference rate**:

> **40 Beans = 1 hour of community time**

This is not a price floor or ceiling for labour — it is a shared reference point for intuition. A skilled tradesperson might charge 60–80 Beans per hour; a bag of lemons might be 3 Beans. The reference rate simply anchors the mental model.

### Pricing Guide

| Item | Suggested Price | Reference |
| :--- | :--- | :--- |
| ☕ Coffee | 5 Beans | ~8 minutes of community time |
| 🍋 Bag of lemons | 3–5 Beans | Small market goods |
| 🧹 General labour (1 hour) | 25–40 Beans | Basic community help |
| 🔧 Average skilled work (1 hour) | 40 Beans | The reference anchor |
| 🪚 Specialist trade (1 hour) | 60–80 Beans | Premium skills |
| 📅 Full day's work | 250–320 Beans | Significant commitment |
| 🏠 Major project | 500–2000 Beans | Requires deep community trust |

### Hour Equivalent Display

Throughout the app, all bean amounts display an approximate time equivalent:
- `5 Beans (≈ 8min)`
- `40 Beans (≈ 1hr)`
- `320 Beans (≈ 8hr)`

This helps participants intuitively grasp the value of any price, balance, or credit limit.

---

## 4. Mutual Credit

Every member has a **balance** that can be positive (they are owed value) or negative (they owe value to the community).

- A **positive balance** means you have provided more goods/services than you have received. The community owes you.
- A **negative balance** means you have received more than you have provided. You owe the community.
- The sum of all balances in the network is always **zero**.

Balances are bounded by two limits:
- The **floor** — how far negative you can go (your borrowing power).

---

## 5. Dynamic Credit Floor (Borrowing Limit)

The credit floor is **not a fixed number**. It grows dynamically based on the member's trade history. A brand new account has a small credit line. An established, active trader has a large one.

### The Formula

```
floor = BASE_FLOOR − min(MAX_EARNED, earnedCredit)

where:
  earnedCredit = (tradeCount × 8) + (uniquePartners × 40) + (accountAgeDays × 2)
```

- **BASE_FLOOR:** −80 Beans (the starting credit for a new account)
- **MAX_EARNED:** 1920 Beans (the maximum additional credit that can be earned)
- **Total cap:** −2000 Beans (BASE_FLOOR + MAX_EARNED = 80 + 1920)

### What counts

| Factor | Weight | Why |
| :--- | :--- | :--- |
| Each completed trade | +8 Beans of credit | Proves economic activity |
| Each unique trade partner | +40 Beans of credit | Proves diverse connections (not wash-trading) |
| Each day of account age | +2 Beans of credit | Proves sustained presence |

### What does NOT count

- Trades with `escrow_*` system wallets (these are internal accounting)
- Self-transactions
- Cancelled or refunded trades

### Progression Examples

| Scenario | Trades | Partners | Age (days) | Floor | ≈ Hours of credit |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Brand new member | 0 | 0 | 0 | **−80 Beans** | 2 hours |
| First week | 3 | 2 | 7 | **−198 Beans** | 5 hours |
| One month active | 10 | 5 | 30 | **−420 Beans** | 10.5 hours |
| Three months | 30 | 12 | 90 | **−900 Beans** | 22.5 hours |
| Six months | 60 | 20 | 180 | **−1720 Beans** | 43 hours |
| One year veteran | 150 | 30 | 365 | **−2000 Beans** | 50 hours (capped) |

### Key Principle

The credit floor represents **the community's trust in you**, measured by your history. You cannot buy trust. You cannot fake it with a single trading partner. You earn it through sustained, diverse, organic participation.

---

## 7. Identity Tiers

Every member's tier is determined automatically by their dynamic credit floor. Tiers are cosmetic labels that communicate trust level at a glance. They also gate certain capabilities.

| Tier | Condition | Colour | Capabilities |
| :--- | :--- | :--- | :--- |
| **Ghost** 👻 | floor > −200 Beans | Gray | Marketplace escrow trades only. No direct transfers. **Cannot invite new members.** |
| **Resident** 🏠 | −200 ≥ floor > −600 Beans | Blue | Full access. Direct transfers unlocked. Can invite new members. |
| **Steward** 🏛️ | −600 ≥ floor > −1400 Beans | Purple | Full access. |
| **Elder** ⛰️ | floor ≤ −1400 Beans | Amber | Full access. |

### Ghost Restrictions

Ghosts are new, unproven accounts. To protect the community:

1. **Marketplace only** — Ghosts can trade through the marketplace escrow system (buy and sell goods/services), but cannot send direct ledger transfers (gifts).
2. **Cannot invite** — Ghosts cannot generate invitation codes. This prevents puppet chains (see Section 10).

These restrictions lift automatically when the member's organic trade history grows enough to reach Resident tier.

---

## 8. Community Circulation & Transaction Fee

Community Circulation is a small periodic reduction applied to **positive balances**. It prevents hoarding and returns idle beans to the community Commons Pool — keeping the local economy flowing like healthy blood circulation.

> **Why "Community Circulation"?** Positive balances represent value you've earned but haven't yet spent locally. Circulation gently encourages that stored value to flow back into the community — funding projects, rewarding neighbours, and keeping the economy alive.

### Progressive Circulation Brackets

Circulation works like progressive tax brackets. The rate is determined by the size of the holding, regardless of the member's tier. 

| Bracket | Balance Range | Rate | Hours Equivalent |
|---|---|---|---|
| 1st | 0 – 200 Beans | **0.0%**/mo (Tax-Free) | 0 hrs |
| 2nd | 200 – 500 Beans | **1.0%**/mo | 5–12.5 hrs |
| 3rd | 500 – 1000 Beans | **1.5%**/mo | 12.5–25 hrs |
| 4th | 1000 – 2000 Beans | **2.0%**/mo | 25–50 hrs |
| 5th | 2000+ Beans | **2.5%**/mo | 50+ hrs |

- **Epoch:** Applied lazily upon account access (synced based on the last access timestamp).
- **Applies to:** Positive balances only (you don't pay circulation on debt).
- **Destination:** Circulated beans flow directly to the community Commons Pool.

### Why Progressive Brackets?

This structure replaces the previous "accelerated ceiling" model with a more equitable system:
- **Fair:** A Ghost holding 100 Beans and an Ambassador holding 100 Beans pay exactly the same circulation rate.
- **Anti-hoarding:** The more you stockpile, the steeper the marginal rate. It gently forces high-accumulation accounts to spend or donate.
- **Gentle at the bottom:** Active members sitting in the 0–200 Beans Green Zone pay **0% circulation tax** (completely tax-free to encourage everyday trades).

### Example

A member holds a balance of +800 Beans:
- First 200 at 0.0% → −0.00 Beans (Green Zone)
- Next 300 (from 200 to 500) at 1.0% → −3.00 Beans
- Next 300 (from 500 to 800) at 1.5% → −4.50 Beans
- **Total monthly circulation:** −7.50 Beans → Commons Pool

### Transaction Fee

To ensure the solvency of the network when pruning inactive members (which involves writing off bad debts using the Commons Pool), a flat **1.5% Transactional Fee** is levied on all successful direct P2P transfers and completed marketplace trade releases.

- **Calculation**: Bob receives `amount − 1.5%`, and the remaining `1.5%` is deposited into the Commons Pool.
- **Exemptions**: Escrow holds (deposits) and cancellations (refunds) are completely fee-exempt.

For details on the zero-sum ledger equilibrium, pruning write-offs, reclaims, and how the surplus flows back via community projects, see the [Commons Pool & Solvency Protocol](commons-pool-transparency.md) documentation.

---

## 9. Invitations

BeanPool is an invite-only network. Membership requires an invitation code from an existing member.

### Who can invite?

- **Ghost** 👻 → **Cannot invite.** Must reach Resident tier first.
- **Resident** 🏠 → Can invite. No hard limit on number.
- **Steward** 🏛️ → Can invite. No hard limit.
- **Elder** ⛰️ → Can invite. No hard limit.
- **Node Admin** → Can generate standard and elevated invites (see below).

### Why Ghosts can't invite

This single rule breaks **puppet chain attacks**. If a bad actor creates a puppet account, that puppet is a Ghost. Ghosts can't invite. So the puppet can't create more puppets. The attack terminates at generation one.

To earn invitation privileges, a member needs real trades with real, unique partners — proving they are an engaged participant, not a bot.

### Admin Genesis Invites (Tiered Bootstrap)

The node admin has access to **tiered invite codes** from the `/settings` panel. These allow the admin to bootstrap trusted, known community members at an elevated starting tier — bypassing the Ghost restrictions.

| Invite Type | Starting Tier | Starting Floor | Use Case |
| :--- | :--- | :--- | :--- |
| **Standard** | Ghost 👻 | −80 Beans | Default for all regular invites |
| **Trusted** | Resident 🏠 | −200 Beans | Known community members. Can invite + gift immediately. |
| **Ambassador** | Steward 🏛️ | −600 Beans | Market promoters, community organisers. Full capabilities from day one. |

**Rules:**
- Only the **node admin** can generate Trusted and Ambassador invites. Regular members always generate Standard (Ghost-level) invites.
- The elevated tier is a **starting position**, not a permanent grant. The member's floor still follows the dynamic formula — but their `earnedCredit` is pre-seeded to place them at the correct tier threshold.
- Elevated invites are **visible in the Invitation Tree** with a special badge, providing full transparency.
- This mechanism exists because the admin is the root of trust for the node. If the admin vouches for someone as a known community pillar, forcing them through 3 months of Ghost-tier restrictions is counterproductive.

### Invitation Tree

Every invitation creates a parent→child relationship. The full tree is visible to node admins and provides accountability: you can trace any member back to who invited them, and who invited *that* person, all the way to the node genesis.

### Invitation Health

Each inviter's "tree health" is tracked and visible on their profile:

- **Invited:** Total number of people invited
- **Active:** How many have completed at least one trade (with someone other than the inviter)
- **Graduated:** How many have reached Resident tier
- **Defaulted:** How many went to their floor and became inactive

This is informational, not punitive. An enthusiastic inviter who brings in 20 people but only 5 engage is doing community outreach — not cheating. The data just provides transparency.

### Market Stall Scenario

A Steward at a farmers market wants to onboard 50 new members:
1. They generate invite codes (or a bulk QR sheet)
2. People scan and sign up → all start as Ghosts
3. Each Ghost can immediately participate in the marketplace (buy and sell via escrow)
4. Those who engage naturally progress through the tiers
5. Those who never trade sit at balance 0 → harmless, zero cost to the community

---

## 10. Anti-Sybil Defences

A **Sybil attack** is when a bad actor creates multiple fake identities to extract value. In BeanPool, the most dangerous form is: create a puppet account → extract its full credit line → abandon the puppet → repeat.

BeanPool does not use KYC (Know Your Customer). Instead, it uses **KYH (Know Your History)** — making the cost of building a trusted identity higher than the reward of attacking with a fake one.

### Three Defence Layers

| Layer | Rule | What it prevents |
| :--- | :--- | :--- |
| **1. Ghosts can't gift** | New accounts can only transact through marketplace escrow. Direct transfers are blocked. | Instant, invisible draining of credit. |
| **2. Ghosts can't invite** | New accounts cannot generate invitation codes. | Puppet chains — one puppet creating more puppets. |
| **3. Diverse partner requirement** | Credit only grows with unique trade partners, not trade volume with one person. | Wash-trading to inflate trust. |

### Attack Scenario Analysis

**Attack:** Eve (Resident) creates 5 puppet accounts, each with −80 Beans floor.

| Step | What happens |
| :--- | :--- |
| Eve creates 5 puppets | Each is a Ghost with −80 Beans floor |
| Puppets try to gift beans to Eve | **Blocked** — Ghosts can't do direct transfers |
| Eve lists fake services, puppets "buy" through marketplace | Possible, but visible: 5 escrow trades, all same seller, all same time frame |
| Each puppet goes to −80 and disappears | Max damage: 5 × 80 = 400 Beans |
| Puppets try to create more puppets | **Blocked** — Ghosts can't invite |
| Eve's invitation tree shows 5 defaulted invitees | Visible to the community — reputational cost |

**Result:** The attack is capped at 400 Beans (10 hours of community time), requires visible marketplace activity, is self-terminating (puppets can't chain), and leaves a permanent trail on Eve's profile. Compare this to an undefended system where the same attacker could drain unlimited credit silently.

### The Economics of Honesty

The system is designed so that **being a good community member is always more profitable than cheating**:

| Path | Outcome |
| :--- | :--- |
| Trade honestly for 3 months | −900 Beans credit line, Steward status, invitation privileges, community reputation |
| Create 5 puppets | 400 Beans extracted (one-time), Ghost status on puppets (can't chain), visible on invitation tree, no more puppets possible |

---

## 11. Marketplace & Escrow

The marketplace is the primary venue for economic activity. All trades between members go through an **escrow handshake**.

### Escrow Flow

1. **Offer/Need posted** → visible to community
2. **Counterparty accepts** → beans are locked in an `escrow_*` system wallet
3. **Goods/services delivered** → both parties confirm
4. **Escrow releases** → beans transfer from buyer to seller

### Escrow Wallet Exemptions

Escrow wallets (`escrow_*`) are **system-managed accounts**, not human credit lines. They are exempt from:
- Dynamic credit floor
- Community Circulation

---

## 12. Transaction Guardrails

### Spending Warning

When a transaction would use more than **50% of the sender's remaining credit line**, the app displays a warning:

```
⚠️ This uses 76% of your available credit.
After this trade you'll have 100 Beans of credit remaining.
```

This is informational — it does not block the trade.

### Ghost Transfer Block

If a Ghost-tier account attempts a direct ledger transfer (not a marketplace escrow trade), the transfer is rejected with a message:

```
Build trust through marketplace trades to unlock direct transfers.
Your current tier: Ghost 👻
Progress to Resident: [▓▓▓░░░░░░░] 34%
```

### Hour Equivalent Context

Every transaction confirmation shows the amount in both beans and time:

```
Send 320 Beans to @CaptainBean?
≈ 8 hours of community time

Your balance after: +60 Beans (≈ 1.5hr)
```

---

## 13. Achievements

Achievements are **earned badges** displayed on a member's profile. They are derived from existing data — no additional user action is required.

| Achievement | Condition | Description |
| :--- | :--- | :--- |
| 🤝 **First Trade** | 1 completed trade | Welcome to the community |
| 🏘️ **Local Hero** | 10+ unique trade partners | Well-connected community member |
| ⚖️ **Reciprocity Champion** | Send/receive ratio between 0.7 and 1.3 | Balanced giver and receiver |
| 🌱 **Node Anchor** | Invited 5+ members who became active | Growing the community |
| 🛡️ **Guardian Angel** | Set 3 or more guardians | Secured their self-managed identity |
| 🎖️ **Veteran** | Account age ≥ 365 days | A year of community participation |
| 💝 **Generous** | Donated to 3+ community projects | Supporting community initiatives |

---

## 14. Federation

When BeanPool nodes connect as **peers**, they form a federated network. The protocol rules in this document are **protocol-level constants** — they are the same on every node. This prevents arbitrage attacks where a member exploits different rules on different nodes.

### What is shared across nodes

- Credit formula and weights
- Circulation rate and epoch
- Tier thresholds
- Reference rate

### What is local to each node

- Community name and branding
- Admin contact information
- Marketplace posts
- Member balances and transaction history (synced via Merkle exchange)

### Federation Verification

When a transfer occurs across federated nodes, both nodes independently calculate the sender's dynamic floor using the protocol formula. If the transfer would exceed the floor, it is rejected. This prevents a compromised node from allowing over-limit transfers.

---

## 15. Protocol Constants

All values are defined in `beanpool-core/src/protocol.ts` and are identical across all nodes in the network.

```
┌──────────────────────────────────────────────────────┐
│  BEANPOOL PROTOCOL v1                                │
├──────────────────────────────────────────────────────┤
│  Reference Rate:           40 Beans = 1 hour             │
│                                                      │
│  Credit Floor:                                       │
│    Base:                   −80 Beans                     │
│    Max Earned:             1920 Beans                    │
│    Total Cap:              −2000 Beans (≈ 50 hours)     │
│                                                      │
│  Growth Weights:                                     │
│    Per trade:              +8 Beans                      │
│    Per unique partner:     +40 Beans                     │
│    Per day of age:         +2 Beans                      │
│                                                      │
│  Community Circulation:                              │
│    Base rate:              0.5% / month              │
│    Max rate:               2.5% / month (2000+ Beans)    │
│    Epoch:                  30 days                    │
│                                                      │
│  Transaction Fee:                                    │
│    Fee rate:               1.5%                       │
│                                                      │
│  Anti-Sybil:                                         │
│    Ghost threshold:        floor > −200 Beans            │
│    Ghost restrictions:     No gifts, no invitations  │
│                                                      │
│  Admin Genesis Invites:                              │
│    Standard:               Ghost (−80 Beans)             │
│    Trusted:                Resident (−200 Beans)         │
│    Ambassador:             Steward (−600 Beans)          │
│                                                      │
│  Guardrails:                                         │
│    Spend warning:          >50% of credit line       │
└──────────────────────────────────────────────────────┘
```

---

## 16. Glossary

| Term | Definition |
| :--- | :--- |
| **Balance** | A member's current credit position. Positive = owed by community. Negative = owes the community. |
| **Bean (Beans)** | The unit of account in BeanPool. |

| **Commons Pool** | A community fund filled by community circulation. Used for community projects. |
| **Community Circulation** | Periodic decay of positive balances, preventing hoarding. Formerly called "demurrage." |
| **Dynamic Floor** | The borrowing limit, calculated from trade history. Grows with trust. |
| **Escrow** | A system-managed wallet that holds beans during a marketplace trade until both parties confirm completion. |
| **Federation** | The network of connected BeanPool nodes that can trade across communities. |
| **Ghost** | The lowest identity tier. New accounts start here with restricted capabilities. |
| **Invitation Tree** | The hierarchical record of who invited whom. |
| **KYH (Know Your History)** | BeanPool's approach to trust — identity is proven by trade history, not documents. |
| **Mutual Credit** | A system where credit is created at the point of transaction. No pre-existing money supply. The network sum is always zero. |
| **Reference Rate** | The community benchmark: 40 Beans = 1 hour of community time. |
| **Sybil Attack** | Creating fake identities to extract value from the network. |
| **Tier** | An identity label (Ghost → Resident → Steward → Elder) determined by the dynamic credit floor. |
| **Wash-Trading** | Trading repeatedly with the same partner (or yourself) to inflate trust metrics. Countered by the unique-partner requirement. |

---

*This document describes the target protocol for BeanPool v1. Some rules may not yet be implemented in the current codebase. See the [Implementation Plan](../ROADMAP.md) for rollout status.*
