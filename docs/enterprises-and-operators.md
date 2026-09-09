# Enterprises and Operators: Architectural Manual

This document provides a technical audit of **Enterprises** (community treasury accounts that trade) and **Operators** (the living member stewards who administer them) in BeanPool.

Every statement in this manual is grounded directly in the codebase. Each feature, constraint, and operational flow is tagged with one of four implementation states:

- `BUILT AND REACHABLE`: Code exists on the server and is hooked up to active user interfaces in the clients.
- `BUILT BUT UNREACHABLE`: Code exists in server routes, database schemas, or client helper libraries, but cannot be reached by normal user flows due to missing UI links, dead-end conditionals, or unmounted routes.
- `DESIGNED ONLY`: Present in documentation, architecture specs, comments, or design notes, but lacking executable implementation in code (cited directly to the specification document).
- `NOT PRESENT`: Explicitly absent or removed from the system.

Client-side enforcement and server-side enforcement are distinguished throughout.

---

## Terminology: Operators vs. Recovery Keepers

The BeanPool codebase and user interfaces use the term "keeper" for two completely unrelated concepts:

1. **Recovery Keepers (Identity Recovery)**: An external entity (such as the community node hub, an OAuth SSO provider, or a trusted peer) holding an encrypted slice of a person's private seed. Recovery keepers have zero authority over day-to-day transactions, cannot trade, cannot access accounts, and exist solely to unseal or release their key fragment during an identity restoration collection session.
2. **Enterprise Operators / Stewards (Enterprise Trading)**: A living member account with [`members.can_operate = 1`](file:///Users/marty/projects/bp-manual/apps/server/src/db/schema.sql#L33-L36) and a binding row in the [`treasury_operators`](file:///Users/marty/projects/bp-manual/apps/server/src/db/schema.sql#L702-L709) database table. These individuals manage the trading operations of a community enterprise: posting its offers, creating its tenders (needs), approving worker bids, confirming deal completions, and sweeping surplus beans into the shared Commons pool. They hold no cryptographic key fragments for the enterprise; instead, they sign HTTP requests with their own personal identity keys, and the server authorizes their actions on behalf of the enterprise.

This manual is exclusively about **(2) Enterprise Operators and Stewards**. The terms "operator" and "steward" are used interchangeably throughout this document. The term "keeper" is referenced only when citing code symbols or user interface copy that still uses that label.

### Codebase Conflation Finding

The collision between these two concepts was introduced directly in the database migration and schema design. In [`apps/server/src/db/db.ts#L381-L384`](file:///Users/marty/projects/bp-manual/apps/server/src/db/db.ts#L381-L384), the code records:

```typescript
// The role was briefly labelled 'steward', which collided with the Steward TRUST TIER
// (protocol-rules §7) — two different meanings for one word. Renamed to 'keeper'. Cheap and
// idempotent; the column isn't read yet, so this is tidiness rather than a behaviour change.
try { db.prepare(`UPDATE treasury_operators SET role='keeper' WHERE role='steward'`).run(); } catch { }
```

In avoiding a collision with the "Steward" trust tier ([`packages/beanpool-core/src/protocol.ts#L35`](file:///Users/marty/projects/bp-manual/packages/beanpool-core/src/protocol.ts#L35)), the schema defined `role TEXT NOT NULL DEFAULT 'keeper'` on [`treasury_operators`](file:///Users/marty/projects/bp-manual/apps/server/src/db/schema.sql#L705). This created a direct lexical collision with the recovery keeper subsystem ([`recovery_shares`](file:///Users/marty/projects/bp-manual/apps/server/src/db/schema.sql#L370-L388)).

---

## 1. What an Enterprise Is

An enterprise is not a standalone table or an isolated cryptographic identity; it is an account row in the [`members`](file:///Users/marty/projects/bp-manual/apps/server/src/db/schema.sql#L2-L49) table with the flag [`is_treasury = 1`](file:///Users/marty/projects/bp-manual/apps/server/src/db/schema.sql#L32). It represents the trading face of a community-owned initiative or shared asset (such as "Community Eggs").

| Field in `members` Table | Person Account (`is_treasury = 0`) | Enterprise Account (`is_treasury = 1`) |
| :--- | :--- | :--- |
| `public_key` | Client Ed25519 public key hex | Node-generated Ed25519 pubkey hex |
| `callsign` | User display name | Enterprise name (e.g. Eggs) |
| `avatar_url` | Uploaded or bundled avatar | Custom image, SVG, or bundled asset |
| `is_treasury` | `0` | `1` |
| `can_operate` | `0` or `1` (Master operator switch) | `0` (Enterprise cannot operate) |
| `can_vouch` | `0` or `1` (Appointed voucher switch) | `0` (Default) |
| `earned_credit` | Dynamic floor formula limit | Granted credit line (min 200) |
| `invited_by` | Inviter public key or `'genesis'` | `NULL` (System-created, no inviter) |
| `invite_code` | Invite code string or `'genesis'` | `NULL` |
| `status` | `'active'` | `'active'` |


### 1.1 Differences Between an Enterprise and a Person

| Attribute | Person Account (`is_treasury = 0`) | Enterprise Account (`is_treasury = 1`) | Enforcement Location | Implementation State |
| :--- | :--- | :--- | :--- | :--- |
| **Demurrage Decay** | Positive balances decay over time toward zero. | **Decay exempt**. Balances never decay. | [`ledger.ts#L157-L163`](file:///Users/marty/projects/bp-manual/packages/beanpool-core/src/ledger.ts#L157-L163), [`state-engine.ts#L362-L363`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L362-L363) | `BUILT AND REACHABLE` |
| **Credit Floor Base** | 0 beans base. Requires appointed voucher or trades to open overdraft. | **Minimum 200 beans** overdraft line (`Math.max(200, grantedCredit)`). | [`trust.ts#L406-L410`](file:///Users/marty/projects/bp-manual/packages/beanpool-engine/src/trust.ts#L406-L410) | `BUILT AND REACHABLE` |
| **Directory Listing** | Appears in Member Directory and People queries. | **Excluded**. Filtered out via `!m.isTreasury`. | [`community.ts#L712`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/community.ts#L712), [`community.ts#L1459`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/community.ts#L1459) | `BUILT AND REACHABLE` |
| **Map Presence** | Members do not appear on the map directly. | Does not appear on map as an entity; its **posts** appear if coordinates are set. | [`map.tsx#L135-L160`](file:///Users/marty/projects/bp-manual/apps/native/app/%28tabs%29/map.tsx#L135-L160) | `BUILT AND REACHABLE` |
| **Key Location** | Sovereign on device (SecureStore / IndexedDB). | Generated and stored on the node server in [`node_config`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2929). | [`state-engine.ts#L2915-L2930`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2915-L2930) | `BUILT AND REACHABLE` |
| **Vouching for Others** | Can vouch if granted [`can_vouch = 1`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1654). | **Cannot vouch**. Defaults to 0; no operator proxy route exists. | [`schema.sql#L23`](file:///Users/marty/projects/bp-manual/apps/server/src/db/schema.sql#L23), [`state-engine.ts#L1786`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1786) | `BUILT AND REACHABLE` |
| **Receiving Vouches** | Can receive vouches to expand credit floor. | Server function allows it, but UI never renders an enterprise to vouch for. | [`community.ts#L712`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/community.ts#L712), [`trust.ts#L406`](file:///Users/marty/projects/bp-manual/packages/beanpool-engine/src/trust.ts#L406) | `BUILT BUT UNREACHABLE` |
| **Governance Voting** | Votes using trade-derived governance credits. | **Cannot vote**. No operator proxy route exists for voting. | [`commons.ts#L79-L94`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/commons.ts#L79-L94), [`state-engine.ts#L3312`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L3312) | `NOT PRESENT` |
| **Total Member Count** | Counted in `totalMembers`. | **Counted in total members** (`WHERE status != 'pruned'`). | [`state-engine.ts#L2502`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2502), [`admin.ts#L303`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/admin.ts#L303) | `BUILT AND REACHABLE` |
| **Active / Inactive Stats** | Counted based on transaction recency. | **Excluded** from active/inactive stats because `invited_by` is NULL. | [`state-engine.ts#L2478`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2478), [`state-engine.ts#L2491`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2491) | `BUILT AND REACHABLE` |

### 1.2 Creation: [`createTreasury`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2893-L2938)

An enterprise is instantiated via the function [`createTreasury(name, avatar, creditLine, opts)`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2893-L2938). The function performs the following steps:

1. **Validation**: Enforces `trimmed.length >= 2` and verifies that `lower(callsign)` is not taken by any active member ([`state-engine.ts#L2903-L2912`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2903-L2912)). Unless `opts.systemCreated` is true, an avatar image is strictly required ([`state-engine.ts#L2905`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2905)).
2. **Keypair Generation**: Creates a fresh 32-byte Ed25519 keypair on the node server via Node.js [`crypto.generateKeyPairSync('ed25519')`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2915-L2920).
3. **Database Insertion**: In an atomic SQLite transaction:
   - Inserts into `members` with `public_key = pubKeyHex`, `callsign = trimmed`, `avatar_url = avatar`, `status = 'active'`, `is_treasury = 1`, and `earned_credit = line` ([`state-engine.ts#L2925-L2927`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2925-L2927)). `invited_by` and `invite_code` remain `NULL`.
   - Inserts into `accounts` with `balance = 0` and `last_demurrage_epoch = 0` ([`state-engine.ts#L2928`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2928)).
   - Writes the private key in plaintext to `node_config` under the key `treasury_privkey_<pubKeyHex>` ([`state-engine.ts#L2929`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2929)).
4. **Ledger Initialization**: Calls [`ledger.initializeGenesisAccount(pubKeyHex)`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2932) and registers the account as demurrage-exempt via [`ledger.setDecayExempt(pubKeyHex)`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2933).
5. **Event Broadcast**: Broadcasts `member_joined` and `treasury_created` over WebSockets ([`state-engine.ts#L2934-L2935`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2934-L2935)).

### 1.3 Every Caller of [`createTreasury`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2893-L2938)

There are five distinct paths in the codebase through which an enterprise is brought into existence:

1. **Admin HTTP Endpoint**:
   - Route: [`POST /api/local/admin/treasury`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L161-L168)
   - Authority: Gated by the node admin password via [`checkAdminAuth`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L162).
   - Parameters: `{ name, avatar, creditLine }`.
   - State: `BUILT AND REACHABLE`.
2. **Fleet Manager UI / Client**:
   - Location: [`apps/manager/src/components/modules/MembersModule.tsx#L357`](file:///Users/marty/projects/bp-manual/apps/manager/src/components/modules/MembersModule.tsx#L357) via [`createNodeTreasury`](file:///Users/marty/projects/bp-manual/apps/manager/src/lib/node-client.ts#L525-L541).
   - Authority: Submits admin password and optional TOTP token from the manager dashboard.
   - Parameters: Takes name, SVG avatar, and initial credit line.
   - State: `BUILT AND REACHABLE`.
3. **Bootstrap Script**:
   - File: [`scripts/bootstrap-community-eggs.mjs#L26-L30`](file:///Users/marty/projects/bp-manual/scripts/bootstrap-community-eggs.mjs#L26-L30)
   - Authority: CLI execution with `ADMIN_PASSWORD` environment variable.
   - Parameters: Seeds "Community Eggs" with an inline egg SVG avatar and a 200-bean credit line.
   - State: `BUILT AND REACHABLE`.
4. **Daily Pulse System Account**:
   - File: [`apps/server/src/daily-pulse.ts#L74-L88`](file:///Users/marty/projects/bp-manual/apps/server/src/daily-pulse.ts#L74-L88) ([`ensurePulseTreasury`](file:///Users/marty/projects/bp-manual/apps/server/src/daily-pulse.ts#L74)) and [`apps/server/src/engine/pulse-seed.ts#L50-L64`](file:///Users/marty/projects/bp-manual/apps/server/src/engine/pulse-seed.ts#L50-L64) ([`ensureBeanPoolIdentity`](file:///Users/marty/projects/bp-manual/apps/server/src/engine/pulse-seed.ts#L50)).
   - Authority: Automatic system initialization on server boot.
   - Behavior: Seeds official treasuries (`Daily Pulse` with avatar `bundled://daily-pulse`, and `BeanPool` with avatar `bundled://sprout`). If a regular member has taken either callsign, the system automatically renames the colliding member to `${callsign} ${pubkey.substring(0,6)}` without changing their status, freeing the callsign for the treasury.
   - State: `BUILT AND REACHABLE`.
5. **Federation Link Creation**:
   - File: [`apps/server/src/federation-link.ts#L85-L115`](file:///Users/marty/projects/bp-manual/apps/server/src/federation-link.ts#L85-L115) ([`createFederationLink`](file:///Users/marty/projects/bp-manual/apps/server/src/federation-link.ts#L88))
   - Authority: Triggered when a peering relationship is established and assigned a credit ceiling.
   - Behavior: Automatically instantiates an enterprise with `systemCreated: true` and a blank avatar, binding it to the peer ID in `federation_links`.
   - State: `BUILT AND REACHABLE`.

### 1.4 How a Member Tells It Is Not a Person

Enterprises are kept distinct from individuals across the user interfaces:

- **Excluded from Directory and Search**: In both Native ([`people.tsx#L594`](file:///Users/marty/projects/bp-manual/apps/native/app/%28tabs%29/people.tsx#L594)) and PWA ([`PeoplePage.tsx#L110`](file:///Users/marty/projects/bp-manual/apps/pwa/src/pages/PeoplePage.tsx#L110)), member queries fetch from endpoints ([`GET /api/members`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/community.ts#L1454-L1483) and [`GET /api/community/members`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/community.ts#L710-L713)) that filter on `!m.isTreasury`. An enterprise never appears in the member directory, member search results, or friend pickers.
- **Dedicated Commons Tab Card**: In the mobile app ([`projects.tsx#L550-L576`](file:///Users/marty/projects/bp-manual/apps/native/app/%28tabs%29/projects.tsx#L550-L576)), enterprises are isolated under a dedicated header: "Community Treasuries". Each card displays the enterprise avatar, name, live offer count, and liquid balance.
- **Enterprise Detail View**: Tapping a treasury card in Native opens [`treasury-detail.tsx`](file:///Users/marty/projects/bp-manual/apps/native/app/treasury-detail.tsx#L173), which explicitly carries the subtitle: `Community treasury · run by the Commons`.
- **Marketplace Listings**: An enterprise can post offers and needs. In the market feed, the post displays the enterprise callsign and avatar. However, tapping the author does not open a personal member profile or social trust card.

---

## 2. Its Money

### 2.1 Demurrage Exemption

Standard member balances above the 200-bean green zone are subject to monthly demurrage decay ranging from 1.0% to 2.5% per month ([`packages/beanpool-core/src/ledger.ts#L141-L146`](file:///Users/marty/projects/bp-manual/packages/beanpool-core/src/ledger.ts#L141-L146)).

Enterprises are completely exempt from demurrage:

- In [`apps/server/src/state-engine.ts#L2933`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2933), `createTreasury` immediately executes `ledger.setDecayExempt(pubKeyHex)`.
- At node boot, [`apps/server/src/state-engine.ts#L362-L363`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L362-L363) scans `SELECT public_key FROM members WHERE is_treasury = 1` and registers every enterprise into `ledger.setDecayExempt()`.
- In [`packages/beanpool-core/src/ledger.ts#L157-L163`](file:///Users/marty/projects/bp-manual/packages/beanpool-core/src/ledger.ts#L157-L163), `applyDecay()` checks `this.decayExemptIds.has(account.id)`. If true, the demurrage calculation is bypassed, leaving the balance un-decayed and advancing only the epoch watermark.

### 2.2 The Minimum 200 Credit Line

In the system map, enterprises are described as having a minimum credit line of 200 beans.

This figure is strictly enforced in code at [`packages/beanpool-engine/src/trust.ts#L406-L410`](file:///Users/marty/projects/bp-manual/packages/beanpool-engine/src/trust.ts#L406-L410):

```typescript
const activated = elderVouched || grantedCredit > 0 || earnedCredit > 0 || isTreasury;
const effectiveGranted = isTreasury ? Math.max(200, grantedCredit) : grantedCredit;
const allowance = (activated && !isCreditFrozen)
    ? Math.min(c.CREDIT_FLOOR_CAP, vouchCredit + earnedCredit + effectiveGranted)
    : 0;

// Floor = -(voucher + earned + granted) once activated
const floor = c.CREDIT_BASE_FLOOR - allowance;
```

Where:
- `grantedCredit` is read from `members.earned_credit`, which stores the `creditLine` argument passed to `createTreasury`.
- If an admin passes `creditLine = 0` (or omits it), `effectiveGranted` evaluates to `Math.max(200, 0) = 200`.
- Because `isTreasury` is true, the account is unconditionally `activated` without needing an Elder vouch or completed trade history.
- The resulting `floor` is at least `-200` beans (an overdraft line of 200 beans). If the admin specifies a higher credit line (e.g. 500), the floor deepens accordingly (up to `CREDIT_FLOOR_CAP = 2000`).

### 2.3 The Offer Covenant and the Usable Floor Lock

Although an enterprise has a credit floor of at least -200 beans, its **usable floor** (what it can spend into deficit right now) is metered by its live offers under Trust Model v3:

- In [`apps/server/src/state-engine.ts#L1143`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1143), `usableFloor` is calculated as:
  $$\text{usableFloor} = \max(\text{floor}, -\text{offerCapForCount}(\text{liveOffers}))$$
- In [`packages/beanpool-core/src/protocol.ts#L198-L204`](file:///Users/marty/projects/bp-manual/packages/beanpool-core/src/protocol.ts#L198-L204), `OFFER_BANDS = [0, 200, 500, 1000, 1500, 2000]`.
- For `liveOffers = 0`, `offerCapForCount(0) = 0`. Consequently, **if an enterprise has no live offers, its usable floor is 0**. It cannot draw upon its 200-bean credit line.
- When an enterprise posts at least 1 live offer, `offerCapForCount(1) = 200`, which immediately unlocks access to its -200 overdraft line.
- Concurrently, posting a Need enforces the **Offer Covenant** ([`routes/treasury.ts#L266`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L266), [`engine/posts.ts#L116`](file:///Users/marty/projects/bp-manual/apps/server/src/engine/posts.ts#L116)):
  `if (type === 'need' && !hasListedOffer(db, authorPublicKey)) throw new Error(CONTRIBUTION_REQUIRED_ERROR);`
  An enterprise is prevented from running a deficit to pay for help (needs) unless it actively offers goods or services to the community.

### 2.4 Transactional Rules and Privileges

| Capability | Supported? | Code Reality | Citation |
| :--- | :--- | :--- | :--- |
| **Hold Positive Balance** | **Yes** | Held in `accounts.balance`; never expires or resets. | [`state-engine.ts#L2928`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2928) |
| **Receive Payments** | **Yes** | Credited via normal marketplace sales or direct transfers. | [`state-engine.ts#L1243`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1243) |
| **Pay Out Beans** | **Yes** | Debited when approving tenders or sweeping surplus. | [`escrow.ts#L188`](file:///Users/marty/projects/bp-manual/apps/server/src/engine/escrow.ts#L188), [`state-engine.ts#L1482`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1482) |
| **Vouch for Members** | **No** | Defaults to `can_vouch = 0`. No operator proxy route exists to invoke vouching. | [`schema.sql#L23`](file:///Users/marty/projects/bp-manual/apps/server/src/db/schema.sql#L23), [`state-engine.ts#L1786`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1786) |
| **Be Vouched For** | **No** | Server function accepts any member ID, but UI filters out treasuries so no member can vouch for one. | [`community.ts#L712`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/community.ts#L712) |
| **Vote on Proposals** | **No** | No operator proxy route exists for voting. Quadratic voting requires personal signatures. | [`commons.ts#L79-L94`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/commons.ts#L79-L94) |
| **Member Count Statistics** | **Partial** | Counted in aggregate `totalMembers`, but excluded from active/inactive breakdown. | [`state-engine.ts#L2478-L2502`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2478-L2502) |

---

## 3. Key Custody

### 3.1 Server-Side Key Generation and Storage

Unlike human members whose Ed25519 identity keypairs are generated and stored inside client-side secure hardware (iOS SecureStore, Android KeyStore, or browser IndexedDB), an enterprise's keypair is generated entirely on the node server:

- **Generation**: [`apps/server/src/state-engine.ts#L2915-L2920`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2915-L2920) calls Node's synchronous crypto module:
  ```typescript
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const pubKeyHex = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  const privKeyHex = crypto.createPrivateKey(privateKey).export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('hex');
  ```
- **Storage Location**: The 32-byte private key hex string is written directly into the SQLite database in the [`node_config`](file:///Users/marty/projects/bp-manual/apps/server/src/db/schema.sql#L285-L288) table ([`state-engine.ts#L2929`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2929)):
  `INSERT OR REPLACE INTO node_config (key, value) VALUES ('treasury_privkey_' || ?, ?)`
- **Format**: Plaintext hexadecimal string. There is no password-based encryption, envelope encryption, or HSM protection applied to this database row.

### 3.2 What the Key Is Used For: The Dead Key Finding

A thorough scan of the entire codebase reveals a striking fact:

**The stored private key `treasury_privkey_<pubKeyHex>` is never read or used anywhere in the codebase.**

- There are zero queries in `apps/server` that select `WHERE key = 'treasury_privkey_%'`.
- The node never loads this private key into memory to sign transactions, blocks, messages, or marketplace actions.
- As confirmed in [`apps/server/src/routes/federation-commission.ts#L9-L11`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/federation-commission.ts#L9-L11):
  *"On a commission the signer is a KEEPER and the payer is the link's enterprise, which has no keypair and never signs anything. So the actor-equals-payer check that protects the purchase route is unavailable, and something has to take its place: `canOperateTreasury`..."*
- In day-to-day operations, the enterprise is an **administrative accounting entity**. When an operator acts for the enterprise, the operator signs the HTTP request with their own personal client keypair. The server verifies that the operator is authorized for that enterprise, and then executes database mutations directly on the ledger.
- The comment in [`state-engine.ts#L2890-L2891`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2890-L2891) states: *"keypair is generated so an operator can load the treasury identity onto a device later; day to day it is driven server-side through operator-authenticated routes."* However, no endpoint or export mechanism exists to export this key to a device.

### 3.3 Practical Consequences for Operators and Node Hosts

1. **For the Operator**:
   - The operator does not hold, custody, or back up any enterprise private keys.
   - If an operator loses their device, the enterprise is completely unharmed. The operator restores their personal account (via recovery keepers/friends), and their authority over the enterprise resumes immediately.
2. **For the Node Operator**:
   - The node host holds plaintext private keys for every enterprise on that node inside `data/beanpool.db`.
   - If the database file is copied, backed up unencrypted, or exposed through a filesystem compromise, all enterprise private keys are exposed.
   - However, because the server routes gate operations through the operator's signed session rather than the enterprise's private key, possessing an enterprise's private key does not grant API authorization on the node unless the attacker also compromises an operator's account or the node admin password.
3. **Database Restores and Migrations**:
   - If the node database is restored from a backup or migrated to a new host, enterprises remain intact with their existing public keys and account balances.
   - If the `treasury_privkey_*` rows in `node_config` were deleted, zero operational degradation would occur, because no server code path reads or checks them.

---

## 4. The Operators

### 4.1 The Dual-Gated Authority Model

Authority to operate an enterprise is governed by two distinct database structures ([`apps/server/src/db/schema.sql#L33-L36, L702-L709`](file:///Users/marty/projects/bp-manual/apps/server/src/db/schema.sql#L33-L36)):

When a member initiates an operator action for an enterprise, the server evaluates authority through the following sequence:

1. **System Administrator Check**: If the caller's public key matches [`getAdminPubkey()`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1689), access is authorized immediately via admin override.
2. **Master Switch Check**: If [`members.can_operate != 1`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1673), access is rejected (`403 Forbidden`).
3. **Enterprise Assignment Check**: If no row exists in [`treasury_operators`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1691-L1693) for `(treasury_pubkey, member_pubkey)`, access is rejected (`403 Forbidden`).
4. **Account Status Check**: If either the caller or the enterprise has `status = 'disabled'` or `status = 'pruned'`, [`requireOperator`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L88-L98) rejects the request (`403 Forbidden`).
5. **Authorized**: If all checks pass, the operator is authorized to act on behalf of the enterprise.


Enforced in [`apps/server/src/state-engine.ts#L1688-L1695`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1688-L1695) ([`canOperateTreasury`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1688)):

```typescript
export function canOperateTreasury(publicKey: string, treasuryPubkey: string): boolean {
    if (publicKey === getAdminPubkey()) return true;
    if (!canOperate(publicKey)) return false;
    const row = db.prepare(
        "SELECT 1 FROM treasury_operators WHERE member_pubkey = ? AND treasury_pubkey = ?"
    ).get(publicKey, treasuryPubkey);
    return !!row;
}
```

- **Master Switch (`members.can_operate`)**: A node-wide boolean on the member's personal row. Retained so an admin can suspend a steward across all enterprises in a single operation without deleting their enterprise bindings.
- **Join Table (`treasury_operators`)**: Explicitly binds a specific member to a specific enterprise:
  ```sql
  CREATE TABLE IF NOT EXISTS treasury_operators (
      treasury_pubkey TEXT NOT NULL REFERENCES members(public_key),
      member_pubkey   TEXT NOT NULL REFERENCES members(public_key),
      role            TEXT NOT NULL DEFAULT 'keeper',
      granted_at      DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      granted_by      TEXT,
      PRIMARY KEY (treasury_pubkey, member_pubkey)
  );
  ```
- **Admin Override**: The system administrator retains a node-wide override (`publicKey === getAdminPubkey()`) and can drive any enterprise on the node without an explicit assignment row.

### 4.2 Appointment and the Script Bug

#### The Proper Appointment Route
An operator is properly appointed to an enterprise via [`POST /api/local/admin/treasury/:treasury/operators`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L193-L202), which invokes [`adminAssignTreasuryOperator(treasury, pubkey, 'admin')`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1739-L1753):
1. Verifies that the target member exists and is not a treasury (`A treasury cannot keep another treasury`).
2. Verifies that the target enterprise exists and has `is_treasury = 1`.
3. In an atomic transaction:
   - Inserts the binding row into `treasury_operators`.
   - Automatically sets `members.can_operate = 1` so the assignment is never silently inert.
4. Broadcasts `profile_updated` over WebSockets.

#### The [`grant-operator.mjs`](file:///Users/marty/projects/bp-manual/scripts/grant-operator.mjs) Script Defect
The repository includes a helper script, [`scripts/grant-operator.mjs#L37-L41`](file:///Users/marty/projects/bp-manual/scripts/grant-operator.mjs#L37-L41). This script sends a request to:
`POST /api/local/admin/users/:pubkey/operator` with `{ granted: true }`.

This endpoint invokes [`adminSetOperator(pubkey, true)`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1677), which **only flips `members.can_operate = 1`**. It does **not** insert a row into `treasury_operators`.

**Consequence**: The script's console output promises:
`Next time this user refreshes the app, they will see the OPERATOR CONTROLS on the Commons tab.`
This promise is false. Because PR #106 made `treasury_operators` mandatory, `canOperateTreasury` returns `false`, and [`keeperOf(pubkey)`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1703) returns an empty list `[]`. The user sees no operator controls in the native app and receives HTTP 403 on any attempted treasury operation. To grant working authority today, an admin must bypass this script and call `POST /api/local/admin/treasury/:treasury/operators` directly.

### 4.3 Revocation and Offboarding

Revocation can occur at two levels:

1. **Per-Enterprise Unbinding**:
   - Endpoint: [`DELETE /api/local/admin/treasury/:treasury/operators/:pubkey`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L204-L212)
   - Function: [`adminRevokeTreasuryOperator(treasury, pubkey)`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1762-L1770)
   - Behavior: Deletes the row from `treasury_operators`. It then queries if the member stewards any other enterprises (`SELECT COUNT(*) FROM treasury_operators WHERE member_pubkey = ?`). If zero remain, it automatically clears `members.can_operate = 0`. Takes effect on the very next HTTP request.
2. **Global Suspension**:
   - Endpoint: [`POST /api/local/admin/users/:pubkey/operator`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L173-L179) with `{ granted: false }`
   - Behavior: Sets `members.can_operate = 0` while leaving the rows in `treasury_operators` intact. Immediately blocks all operator actions across all enterprises without destroying their assignments.

### 4.4 Multiple Operators, Reputation Separation, and Audit Trails

- **Multiple Operators**: Supported natively. The primary key of `treasury_operators` is `(treasury_pubkey, member_pubkey)`. Any number of members can be bound to the same enterprise. The endpoint [`GET /api/treasury/:treasury`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L135-L158) returns all active stewards in its `keepers` array ([`treasuryKeepers`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1719)).
- **Separation of Account and Reputation**:
  - The enterprise's balance is held strictly on `accounts` under the enterprise's public key.
  - When an enterprise trades, buyer and seller ratings are submitted against `post.author_pubkey` (the enterprise).
  - Star ratings, review counts, and earned trust score accrue to the enterprise's profile, not to the operator's personal profile. An operator cannot "take" the enterprise's reputation with them if they leave.
- **Audit Trail (Absence of Operator Logging)**:
  - When an operator submits an offer, need, bid approval, completion, or sweep, the server's [`requireOperator`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L79-L102) verifies that `ctx.state.actor` holds `canOperateTreasury(actor, treasury)`.
  - **However, the actor's public key is discarded immediately after authorization.**
  - On `createPost`, the row records `author_pubkey = treasury`. There is no `created_by_operator` column in `posts`.
  - On `approvePostRequest` and `completePostTransaction`, the marketplace row records only `buyer_pubkey` and `seller_pubkey`.
  - On `moveToCommons` (sweep), the transaction records `from_pubkey = treasury, to_pubkey = 'COMMONS_POOL'`. `auth_signer` is left `NULL` ([`state-engine.ts#L1489`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1489)).
  - **Finding**: There is zero audit trail in the database or transaction log recording which specific operator approved a bid, completed a deal, or swept funds when an enterprise has multiple stewards.

---

## 5. What an Operator Can Actually Do

### 5.1 Server Routes Breakdown

All operator actions are routed through [`apps/server/src/routes/treasury.ts`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts) and [`apps/server/src/routes/federation-commission.ts`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/federation-commission.ts).

| Endpoint | Caller | Server Checks | Database Mutation |
| :--- | :--- | :--- | :--- |
| [`POST /api/treasury/:treasury/offer`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L245-L255) | Operator | `requireOperator`, `title`, `category` | `INSERT INTO posts (type='offer')` |
| [`POST /api/treasury/:treasury/need`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L259-L269) | Operator | `requireOperator`, live offer exists | `INSERT INTO posts (type='need')` |
| [`POST /api/treasury/:treasury/approve`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L272-L282) | Operator | `requireOperator`, buyer has balance | Escrow transfer; `status='pending'` |
| [`POST /api/treasury/:treasury/complete`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L286-L296) | Operator | `requireOperator`, `status=='pending'` | Escrow release; `status='completed'` |
| [`POST /api/treasury/:treasury/sweep`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L299-L341) | Operator | `requireOperator`, `amount <= balance` | `moveToCommons`; balance updated |
| [`POST /api/federation/commission`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/federation-commission.ts#L89-L130) | Operator | `canOperateTreasury`, capacity | `fundCommission`; outbound charge |
| [`POST /api/local/admin/treasury/...`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L161-L212) | Admin | `checkAdminAuth` (password) | Bypasses operator key requirement |


#### 1. [`POST /api/treasury/:treasury/offer`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L245-L255)
- **What it does**: Posts a goods or services listing to the local marketplace authored by the enterprise.
- **Who may call**: A signed member who is an authorized operator of this enterprise.
- **Server checks**: Invokes [`requireOperator(ctx, treasury)`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L79), checking that the target is a treasury, caller has `canOperateTreasury`, and neither party is disabled or pruned. Verifies `title` and `category` are present.
- **What it changes**: Inserts an active row into `posts` with `author_pubkey = treasury` and `repeatable = true` by default ([`treasury.ts#L251`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L251)).

#### 2. [`POST /api/treasury/:treasury/need`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L259-L269)
- **What it does**: Posts a tender or task listing that the enterprise pays for (e.g. "tend the chickens").
- **Who may call**: An authorized operator of this enterprise.
- **Server checks**: `requireOperator`. Enforces the **Offer Covenant**: calls `createPost('need', ...)` which checks [`hasListedOffer(db, treasury)`](file:///Users/marty/projects/bp-manual/apps/server/src/engine/posts.ts#L116). If the enterprise does not hold an active offer, it returns HTTP 400: *"Failed — the treasury needs a live Offer first (offer covenant)"*.
- **What it changes**: Inserts a row into `posts` with `type = 'need'`, `author_pubkey = treasury`, and `repeatable = false`.

#### 3. [`POST /api/treasury/:treasury/approve`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L272-L282)
- **What it does**: Approves a member's bid on an enterprise tender (need), locking funds from the enterprise's credit line into an escrow account.
- **Who may call**: An authorized operator of this enterprise.
- **Server checks**: `requireOperator`. Requires `transactionId`. Calls [`approvePostRequest(transactionId, treasury)`](file:///Users/marty/projects/bp-manual/apps/server/src/engine/escrow.ts#L150), which verifies that `authorPublicKey === treasury` and that the enterprise has sufficient balance/usable floor to cover the escrow hold.
- **What it changes**: Debits the enterprise account, credits `escrow_<txId>`, and shifts transaction status from `'requested'` to `'pending'`.

#### 4. [`POST /api/treasury/:treasury/complete`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L286-L296)
- **What it does**: Confirms that a worker completed the task on an enterprise need, releasing held escrow funds to the worker's personal account.
- **Who may call**: An authorized operator of this enterprise.
- **Server checks**: `requireOperator`. Requires `transactionId`. Calls [`completePostTransaction(transactionId, treasury)`](file:///Users/marty/projects/bp-manual/apps/server/src/engine/escrow.ts#L430), which verifies that `confirmerPublicKey === treasury`.
- **What it changes**: Transfers escrow funds from `escrow_<txId>` to worker's account minus the 1.5% community fee, updates transaction status to `'completed'`, and archives the post.

#### 5. [`POST /api/treasury/:treasury/sweep`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L299-L341)
- **What it does**: Transfers accumulated surplus beans out of the enterprise account and deposits them into the community's shared `COMMONS_POOL`.
- **Who may call**: An authorized operator of this enterprise.
- **Server checks**: `requireOperator`. Validates `amount > 0` and `amount <= getBalance(treasury).balance`. An enterprise cannot sweep into debt.
- **What it changes**: Executes [`moveToCommons(treasury, amt, memo)`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1460) inside [`conservingTransaction`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L322). Atomically debits `accounts.balance` for the enterprise, increases the in-memory global `COMMONS_BALANCE`, and records a transaction row to `COMMONS_POOL`.

#### 6. [`POST /api/federation/commission`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/federation-commission.ts#L89-L130)
- **What it does**: Allows an operator of a federation link enterprise to commission work from a federated partner community using accumulated credit within the agreed ceiling.
- **Who may call**: An authorized operator of the link enterprise (`canOperateTreasury(actor, l.treasuryPubkey)`).
- **Server checks**: Settlement enabled flags, active link existence, commission allowance capacity.
- **What it changes**: Calls `fundCommission` to debit the local pot and dispatches cross-node settlement over libp2p.

### 5.2 Client Reality: Native App vs. PWA

| Feature / Action | Native Mobile App ([`apps/native`](file:///Users/marty/projects/bp-manual/apps/native)) | Progressive Web App ([`apps/pwa`](file:///Users/marty/projects/bp-manual/apps/pwa)) | Discrepancy Analysis |
| :--- | :--- | :--- | :--- |
| **Browse Community Treasuries** | **`BUILT AND REACHABLE`**<br>Interactive cards on Commons tab ([`projects.tsx#L554`](file:///Users/marty/projects/bp-manual/apps/native/app/%28tabs%29/projects.tsx#L554)). | **`BUILT AND REACHABLE`**<br>Static `div` cards on Projects page ([`ProjectsPage.tsx#L274`](file:///Users/marty/projects/bp-manual/apps/pwa/src/pages/ProjectsPage.tsx#L274)). | PWA cards have no click handler; Native cards navigate to detail. |
| **View Treasury Detail** | **`BUILT AND REACHABLE`**<br>Renders dedicated screen ([`treasury-detail.tsx`](file:///Users/marty/projects/bp-manual/apps/native/app/treasury-detail.tsx)). | **`NOT PRESENT`**<br>No treasury detail page or route exists in PWA. | PWA completely lacks a detail view. |
| **Post Offer as Enterprise** | **`BUILT AND REACHABLE`**<br>Renders form ([`treasury-post.tsx`](file:///Users/marty/projects/bp-manual/apps/native/app/treasury-post.tsx#L113)). | **`BUILT BUT UNREACHABLE`**<br>API helper exists ([`api.ts#L1277`](file:///Users/marty/projects/bp-manual/apps/pwa/src/lib/api.ts#L1277)); no UI component calls it. | PWA operators cannot post offers. |
| **Post Need as Enterprise** | **`BUILT AND REACHABLE`**<br>Renders form ([`treasury-post.tsx`](file:///Users/marty/projects/bp-manual/apps/native/app/treasury-post.tsx#L111)). | **`BUILT BUT UNREACHABLE`**<br>API helper exists ([`api.ts#L1280`](file:///Users/marty/projects/bp-manual/apps/pwa/src/lib/api.ts#L1280)); no UI component calls it. | PWA operators cannot post needs. |
| **Sweep Surplus to Commons** | **`BUILT AND REACHABLE`**<br>Sweep input & button on detail screen ([`treasury-detail.tsx#L218-L241`](file:///Users/marty/projects/bp-manual/apps/native/app/treasury-detail.tsx#L218-L241)). | **`BUILT BUT UNREACHABLE`**<br>API helper exists ([`api.ts#L1289`](file:///Users/marty/projects/bp-manual/apps/pwa/src/lib/api.ts#L1289)); no UI component calls it. | PWA operators cannot sweep funds. |
| **Approve Bid on Enterprise Need** | **`BUILT BUT UNREACHABLE`**<br>Helper in [`db.ts#L1835`](file:///Users/marty/projects/bp-manual/apps/native/utils/db.ts#L1835); **not wired to any UI screen**. | **`BUILT BUT UNREACHABLE`**<br>Helper in [`api.ts#L1283`](file:///Users/marty/projects/bp-manual/apps/pwa/src/lib/api.ts#L1283); **not wired to any UI screen**. | Neither client allows an operator to approve bids on a treasury need. |
| **Complete / Release Escrow on Need** | **`BUILT BUT UNREACHABLE`**<br>Helper in [`db.ts#L1838`](file:///Users/marty/projects/bp-manual/apps/native/utils/db.ts#L1838); **not wired to any UI screen**. | **`BUILT BUT UNREACHABLE`**<br>Helper in [`api.ts#L1286`](file:///Users/marty/projects/bp-manual/apps/pwa/src/lib/api.ts#L1286); **not wired to any UI screen**. | Neither client allows an operator to release escrow on a completed tender. |

---

## 6. Walkthrough: From Enterprise Creation to Sweeping Surplus

The operational lifecycle of an enterprise proceeds through six distinct stages:

| Stage | Operation | Real Endpoint / Mechanism | Interface Reality |
| :--- | :--- | :--- | :--- |
| **Stage 1** | Create Enterprise | [`POST /api/local/admin/treasury`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L161-L168) | Fleet Manager dashboard or CLI bootstrap script |
| **Stage 2** | Appoint Steward | [`POST /api/local/admin/treasury/:treasury/operators`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L193-L202) | Raw HTTP / `curl` only; UI missing in all clients |
| **Stage 3** | Post Enterprise Offer | [`POST /api/treasury/:treasury/offer`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L245-L255) | Native mobile operator controls; missing in PWA |
| **Stage 4** | Member Requests Listing | [`POST /api/marketplace/transactions/request`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/marketplace.ts) | Standard marketplace feed on user device |
| **Stage 5** | Escrow Settles / Payout | Core ledger transfer | Automatic on buyer completion; bid approval UI missing for needs |
| **Stage 6** | Sweep Surplus | [`POST /api/treasury/:treasury/sweep`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L299-L341) | Native mobile detail screen; missing in PWA |


### Stage 1: Creating the Enterprise
- **Real Endpoint**: [`POST /api/local/admin/treasury`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L161-L168)
- **UI Step**: System administrator navigates to Fleet Manager dashboard ([`MembersModule.tsx#L357`](file:///Users/marty/projects/bp-manual/apps/manager/src/components/modules/MembersModule.tsx#L357)), enters enterprise name (e.g. "Community Eggs"), provides an avatar, sets credit line to 200, and clicks "Create Treasury". (Alternatively, runs [`scripts/bootstrap-community-eggs.mjs`](file:///Users/marty/projects/bp-manual/scripts/bootstrap-community-eggs.mjs)).
- **Result**: Server executes `createTreasury`, writes `is_treasury = 1`, creates `accounts` row with 0 balance, exempts it from demurrage decay, and saves the Ed25519 private key to `node_config`.

### Stage 2: Appointing the Stewards
- **Real Endpoint**: [`POST /api/local/admin/treasury/:treasury/operators`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L193-L202)
- **UI Step**: **IMPOSSIBLE IN CLIENT UI**. There is no button, form, or dialog in the Native app, PWA, or Fleet Manager to bind a member to a treasury in `treasury_operators`. The script `scripts/grant-operator.mjs` calls the wrong route (`/operator` instead of `/operators`), which only flips `can_operate` and leaves the user unauthorized.
- **Remedy**: The admin must make a raw HTTP request via `curl` with header `x-admin-password` to `POST /api/local/admin/treasury/<treasuryPubkey>/operators` with body `{"pubkey": "<memberPubkey>"}`.
- **Result**: Inserts `(treasury_pubkey, member_pubkey, 'keeper')` into `treasury_operators` and sets `members.can_operate = 1`.

### Stage 3: Posting an Offer as the Enterprise
- **Real Endpoint**: [`POST /api/treasury/:treasury/offer`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L245-L255)
- **UI Step (Native)**: Appointed steward opens Native app, taps the "Commons" bottom tab ([`projects.tsx`](file:///Users/marty/projects/bp-manual/apps/native/app/%28tabs%29/projects.tsx)), taps "Community Eggs" under Community Treasuries, sees the `OPERATOR CONTROLS` panel, and taps **"Post Offer"**. This opens [`treasury-post.tsx?mode=offer`](file:///Users/marty/projects/bp-manual/apps/native/app/treasury-post.tsx). Steward enters "Dozen free-range eggs", category "food", price "12", checks "Recurring", and taps "Post Offer".
- **Result**: Listing is published to the marketplace with `author_pubkey = treasury` and `repeatable = 1`. Because it now has 1 live offer, the enterprise's usable credit floor deepens to -200 beans.

### Stage 4: A Member Buys From the Enterprise
- **Real Endpoint**: [`POST /api/marketplace/transactions/request`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/marketplace.ts)
- **UI Step**: A regular member browsing the "Market" tab sees "Dozen free-range eggs", opens the listing, and taps "Request".
- **Result**: Creates a row in `marketplace_transactions` with `buyer_pubkey = member`, `seller_pubkey = treasury`, and `status = 'requested'`.

### Stage 5: Money Moves and Escrow Settles
- **For an Offer (Selling Eggs)**:
  - When the transaction is approved, funds are locked in `escrow_<txId>`.
  - When the buyer receives the eggs, the buyer confirms completion. Escrow releases the 12 beans directly to the enterprise's public key (minus platform fee).
  - The enterprise balance increases from 0 to +11.82 beans.
- **For a Need (Paying a Tender)**:
  - **BREAKDOWN**: If the enterprise posted a Need (e.g. paying 30 beans for flock tending), a member bids on it.
  - To approve the bid, the operator must call `POST /api/treasury/:treasury/approve`. **No UI button exists in either client**.
  - To release escrow on completion, the operator must call `POST /api/treasury/:treasury/complete`. **No UI button exists in either client**.
  - Tapping "Approve" in the native post screen ([`post/[id].tsx#L724`](file:///Users/marty/projects/bp-manual/apps/native/app/post/[id].tsx#L724)) sends the operator's personal public key instead of the treasury's public key, causing the server to reject the transaction with HTTP 400.

### Stage 6: Sweeping Surplus to the Commons Pool
- **Real Endpoint**: [`POST /api/treasury/:treasury/sweep`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L299-L341)
- **UI Step (Native)**: After selling dozens of eggs, Community Eggs holds a surplus balance of +100 beans. Steward opens `treasury-detail.tsx`, types "50" into the "Sweep surplus…" input, and taps **"To Commons"**.
- **Result**: Server executes [`moveToCommons`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1460), debiting 50 beans from the enterprise account and crediting the global `COMMONS_BALANCE`. Enterprise balance drops to 50 beans; Commons Pool balance increases by 50 beans. Both clients immediately reflect the updated balances via WebSocket broadcast.

---

## 7. How It Relates to the Commons

The Commons Pool and Community Enterprises intersect across liquidity and governance, but represent fundamentally different architectural primitives:

| Attribute | Commons Pool (`COMMONS_POOL`) | Community Enterprise (`is_treasury = 1`) |
| :--- | :--- | :--- |
| **Database Entity** | Synthetic identifier (no row in `members` table) | Real row in `members` table ([`is_treasury = 1`](file:///Users/marty/projects/bp-manual/apps/server/src/db/schema.sql#L32)) |
| **Cryptographic Identity** | None (No public or private key) | Ed25519 keypair generated on server |
| **Demurrage Status** | Decay exempt | Decay exempt |
| **Marketplace Participation** | Cannot author offers or needs | Authors offers and needs |
| **Custody / Operation** | Governed by quadratic voting rounds and administrative rules | Governed by assigned stewards via signed HTTP endpoints |
| **Credit Line** | Cannot run deficit (floored at 0 unless emergency deficit forced) | Credit line (minimum 200 beans, overdraft enabled) |


### Flow of Funds Between the Systems

1. **Enterprise to Commons (Surplus Sweep)**:
   - Built and fully operational via [`POST /api/treasury/:treasury/sweep`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L299).
   - Enables commercial enterprises to return excess trading profit back into the shared community pool.
2. **Commons to Enterprise (The Missing Inflow)**:
   - **NOT PRESENT in server routes or client UI**.
   - Although [`payFromCommons(to, amount, memo)`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1514) exists as an internal state-engine primitive, it is hooked up only to winning quadratic voting proposals ([`closeVotingRound`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L3437)) and debt write-offs for pruned members ([`adminPruneUser`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2972)).
   - There is no endpoint, proposal mechanism, or UI flow that allows the Commons Pool to grant or disburse beans directly into an enterprise account. Once funds enter `COMMONS_POOL`, they cannot be used to capitalize or subsidize a community enterprise.

---

## 8. What Does Not Add Up

The following contradictions, dead-ends, and architectural defects are ranked in order of their potential to harm a live community:

### 1. Unreachable Bid Approval and Escrow Completion for Enterprise Needs
- **Severity**: Critical (Total feature failure for community tenders).
- **Reality**: The entire justification for community enterprises in [`docs/community-governance.md`](file:///Users/marty/projects/bp-manual/docs/community-governance.md) is the "Community Eggs" model: the enterprise posts a Need (tending chickens) and pays workers from its credit line. However, neither the Native app nor the PWA provides any UI to call `POST /api/treasury/:treasury/approve` or `POST /api/treasury/:treasury/complete`. Attempting to approve a bid from the standard post detail screen calls `approveMarketplaceRequest` passing the operator's personal key, which the server rejects with HTTP 400 because the author is the treasury. A community cannot complete tenders or pay workers through an enterprise from either client.
- **State**: `BUILT BUT UNREACHABLE`.

### 2. Complete Absence of Operator UI in the PWA
- **Severity**: High (Desktop and non-mobile stewards are completely locked out).
- **Reality**: While [`apps/pwa/src/lib/api.ts#L1277-L1291`](file:///Users/marty/projects/bp-manual/apps/pwa/src/lib/api.ts#L1277-L1291) defines helper functions for every treasury action (`treasuryPostOffer`, `treasuryPostNeed`, `treasuryApprove`, `treasuryComplete`, `treasurySweep`), not a single PWA component imports or calls them. The PWA renders community treasuries on `ProjectsPage.tsx` as non-clickable, static `<div>` elements. A steward using a desktop browser cannot post offers, post needs, or sweep surplus.
- **State**: `BUILT BUT UNREACHABLE` in PWA.

### 3. Broken Operator Assignment Script ([`grant-operator.mjs`](file:///Users/marty/projects/bp-manual/scripts/grant-operator.mjs))
- **Severity**: High (Admin operational failure).
- **Reality**: The only CLI script provided to appoint operators, `scripts/grant-operator.mjs`, calls `POST /api/local/admin/users/:pubkey/operator`. Following the PR #106 security migration, that endpoint toggles only the member's master switch `can_operate = 1`, but fails to insert a row into `treasury_operators`. The script prints that the user now has operator controls, but the user remains completely unauthorized on the server. There is zero CLI or manager UI tooling to call the working endpoint `POST /api/local/admin/treasury/:treasury/operators`.
- **State**: `BUILT AND REACHABLE` (the script runs, but results in an inert grant).

### 4. Zero Audit Trail of Operator Identity
- **Severity**: Medium-High (Governance accountability breakdown).
- **Reality**: The server verifies that the caller is an authorized steward, but immediately discards the caller's public key. `posts` records `author_pubkey = treasury`. `transactions` records `auth_signer = NULL` on sweeps and escrow holds. If an enterprise has multiple stewards, or if a node administrator intervenes using their admin override, there is no database record or audit log showing which specific individual approved a payment or swept funds.
- **State**: `NOT PRESENT`.

### 5. One-Way Liquidity Trap
- **Severity**: Medium (Economic asymmetry).
- **Reality**: Operators can sweep surplus from an enterprise into `COMMONS_POOL` via `/sweep`. But there is no reverse path: neither an admin nor community voting can transfer beans from `COMMONS_POOL` into an enterprise to seed its operations or cover a deficit.
- **State**: `NOT PRESENT`.

### 6. Plaintext Private Keys Held on the Server
- **Severity**: Medium (Security and architectural inconsistency).
- **Reality**: `createTreasury` generates an Ed25519 keypair and writes the private key in plaintext to `node_config`. This key is never used to sign anything. Storing unencrypted private keys in SQLite creates liability during database backups or restores, while providing zero cryptographic utility.
- **State**: `BUILT AND REACHABLE` (storage exists, but unused).

### 7. Overloaded "Keeper" Terminology
- **Severity**: Low-Medium (Developer and community confusion).
- **Reality**: The codebase deliberately renamed operator roles to `'keeper'` to avoid colliding with the Steward trust tier, thereby colliding with the recovery keeper subsystem. Client screens and server logs refer to "keepers", "operators", and "stewards" interchangeably.
- **State**: Inconsistent throughout code.

### 8. Member Statistics Skew
- **Severity**: Low (Telemetry reporting discrepancy).
- **Reality**: Aggregate node member count ([`state-engine.ts#L2502`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2502)) counts every row where `status != 'pruned'`, which includes enterprises. However, active/inactive metrics ([`state-engine.ts#L2478`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2478)) require `m.invited_by != 'genesis'`. Because an enterprise has `invited_by = NULL`, SQL three-valued logic treats `NULL != 'genesis'` as falsy, excluding enterprises from active/inactive counts.
- **State**: Inconsistent across SQL queries.

---

## 9. Open Decisions

The following architectural choices are framed as questions with options and consequences for project stakeholders:

### Decision 1: Key Custody Architecture for Enterprises
- **Context**: The server generates an Ed25519 keypair on creation and stores the private key in plaintext in `node_config`, but never reads it or uses it to sign transactions.
- **Option A (Formalize Virtual Treasuries)**: Drop the keypair generation entirely. Treat enterprises as virtual member rows where `public_key` is a deterministic identifier (e.g. `sha256('treasury:' || name)`). Remove `treasury_privkey_*` from `node_config`.
  - *Consequences*: Eliminates unencrypted private key storage on the node; removes unused cryptographic overhead; matches actual system behavior.
- **Option B (Implement True Hardware/Device Key Custody)**: Provide an export/import flow allowing an enterprise's private key to be loaded into a dedicated steward device (or multi-sig client) so transactions are genuinely signed by the enterprise's key.
  - *Consequences*: Substantial client and server refactoring; introduces recovery and key-loss risks to community enterprises.

### Decision 2: Operator Revocation and Offboarding
- **Context**: Currently, an admin can instantly revoke an operator via `DELETE /api/local/admin/treasury/:treasury/operators/:pubkey`. Revocation is immediate with zero community input or offboarding workflow.
- **Option A (Retain Single-Admin Revocation)**: Keep instant admin revocation as the sole operational primitive.
  - *Consequences*: Simple and immediate in an emergency; highly centralized.
- **Option B (Implement Decision-Backed Appointments and Revocations)**: Implement the typed `Decision` primitive specified in [`docs/community-governance.md#L55-L63`](file:///Users/marty/projects/bp-manual/docs/community-governance.md#L55-L63), requiring community quadratic voting to appoint or remove stewards.
  - *Consequences*: Decentralizes stewardship authority; requires building missing governance voting UI and decision execution engine.

### Decision 3: Enterprise Civic Rights (Vouching and Voting)
- **Context**: An enterprise is an account in the `members` table. Currently, it cannot vouch for members and cannot vote on proposals.
- **Option A (Strict Commercial Exclusion)**: Maintain complete prohibition. Enterprises are commercial balance sheets, not biological members. They must never vote or vouch.
  - *Consequences*: Prevents Sybil attacks and prevents enterprise capital from buying voting influence.
- **Option B (Allow Vouching and Voting via Steward Delegation)**: Allow operators to vote on community proposals or vouch for suppliers on behalf of the enterprise using its trade standing.
  - *Consequences*: Introduces conflict of interest and corporate voting blocks in community governance.

### Decision 4: Disposition of Orphaned Enterprises
- **Context**: If all assigned operators leave a community, migrate away, or are suspended, the enterprise's status remains `'active'`, but it has zero stewards. Currently, only the system administrator can operate it via admin override.
- **Option A (Admin Caretaker Default)**: Leave the current behavior intact where the system administrator acts as the de facto steward of orphaned enterprises.
  - *Consequences*: Enterprises never freeze, but places operational burden and centralization on the node administrator.
- **Option B (Automatic Freezing of Orphaned Treasuries)**: If `COUNT(treasury_operators) == 0`, the server automatically pauses all active offers and needs, preventing trading until new stewards are appointed by governance.
  - *Consequences*: Prevents abandoned enterprises from accumulating unmonitored liabilities; requires an appointment mechanism to reactivate.

---

## 10. Appendix: Code Citations

### What an Enterprise Is
- [`apps/server/src/db/schema.sql#L32`](file:///Users/marty/projects/bp-manual/apps/server/src/db/schema.sql#L32): Column `is_treasury INTEGER DEFAULT 0` on `members` table.
- [`apps/server/src/state-engine.ts#L2893-L2938`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2893-L2938): `createTreasury` implementation, validation, key generation, and event broadcasts.
- [`apps/server/src/routes/treasury.ts#L161-L168`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L161-L168): Admin route `POST /api/local/admin/treasury`.
- [`apps/manager/src/lib/node-client.ts#L525-L541`](file:///Users/marty/projects/bp-manual/apps/manager/src/lib/node-client.ts#L525-L541): Fleet manager `createNodeTreasury` function.
- [`scripts/bootstrap-community-eggs.mjs#L26-L30`](file:///Users/marty/projects/bp-manual/scripts/bootstrap-community-eggs.mjs#L26-L30): Bootstrap script calling `/api/local/admin/treasury` with 200 credit line.
- [`apps/server/src/daily-pulse.ts#L74-L88`](file:///Users/marty/projects/bp-manual/apps/server/src/daily-pulse.ts#L74-L88): `ensurePulseTreasury` seeding system treasury and renaming colliding members.
- [`apps/server/src/engine/pulse-seed.ts#L50-L64`](file:///Users/marty/projects/bp-manual/apps/server/src/engine/pulse-seed.ts#L50-L64): `ensureBeanPoolIdentity` seeding learn channel treasury.
- [`apps/server/src/federation-link.ts#L85-L115`](file:///Users/marty/projects/bp-manual/apps/server/src/federation-link.ts#L85-L115): `createFederationLink` creating an enterprise for federation links.
- [`apps/server/src/routes/community.ts#L712`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/community.ts#L712): `GET /api/community/members` filtering `!m.isTreasury`.
- [`apps/server/src/routes/community.ts#L1459`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/community.ts#L1459): `GET /api/members` filtering `!m.isTreasury`.

### Its Money
- [`packages/beanpool-core/src/ledger.ts#L113-L116`](file:///Users/marty/projects/bp-manual/packages/beanpool-core/src/ledger.ts#L113-L116): `setDecayExempt` implementation.
- [`packages/beanpool-core/src/ledger.ts#L157-L163`](file:///Users/marty/projects/bp-manual/packages/beanpool-core/src/ledger.ts#L157-L163): `applyDecay` bypassing decay calculation for exempt accounts.
- [`apps/server/src/state-engine.ts#L362-L363`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L362-L363): Server boot scan registering all `is_treasury = 1` rows into `setDecayExempt`.
- [`packages/beanpool-engine/src/trust.ts#L406-L410`](file:///Users/marty/projects/bp-manual/packages/beanpool-engine/src/trust.ts#L406-L410): Automatic 200 minimum credit line (`Math.max(200, grantedCredit)`).
- [`apps/server/src/state-engine.ts#L1143`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1143): `usableFloor` formula metering overdraft by live offers.
- [`packages/beanpool-core/src/protocol.ts#L198-L204`](file:///Users/marty/projects/bp-manual/packages/beanpool-core/src/protocol.ts#L198-L204): `OFFER_BANDS` and `offerCapForCount`.
- [`apps/server/src/engine/posts.ts#L116`](file:///Users/marty/projects/bp-manual/apps/server/src/engine/posts.ts#L116): Offer Covenant enforcement blocking Needs without a live Offer.
- [`apps/server/src/state-engine.ts#L2502`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2502): `totalMembers` counting all non-pruned members including treasuries.
- [`apps/server/src/state-engine.ts#L2478`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2478): `activeMemberCount` excluding treasuries via `m.invited_by != 'genesis'`.

### Key Custody
- [`apps/server/src/state-engine.ts#L2915-L2920`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2915-L2920): Ed25519 keypair generation using `crypto.generateKeyPairSync`.
- [`apps/server/src/state-engine.ts#L2929`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L2929): Plaintext private key insertion into `node_config` as `treasury_privkey_<pubKeyHex>`.
- [`apps/server/src/routes/federation-commission.ts#L9-L11`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/federation-commission.ts#L9-L11): Architecture comment documenting that enterprise accounts have no active keypair and never sign requests.

### The Operators
- [`apps/server/src/db/schema.sql#L33-L36`](file:///Users/marty/projects/bp-manual/apps/server/src/db/schema.sql#L33-L36): Column `can_operate INTEGER DEFAULT 0` on `members`.
- [`apps/server/src/db/schema.sql#L702-L709`](file:///Users/marty/projects/bp-manual/apps/server/src/db/schema.sql#L702-L709): Definition of `treasury_operators` table.
- [`apps/server/src/db/db.ts#L381-L384`](file:///Users/marty/projects/bp-manual/apps/server/src/db/db.ts#L381-L384): SQL migration replacing role `'steward'` with `'keeper'`.
- [`apps/server/src/db/db.ts#L409-L433`](file:///Users/marty/projects/bp-manual/apps/server/src/db/db.ts#L409-L433): `seedTreasuryOperatorsFromLegacyFlag` migration function.
- [`apps/server/src/state-engine.ts#L1672-L1676`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1672-L1676): `canOperate` master switch check.
- [`apps/server/src/state-engine.ts#L1688-L1695`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1688-L1695): `canOperateTreasury` dual-gate enforcement.
- [`apps/server/src/state-engine.ts#L1703-L1712`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1703-L1712): `keeperOf` query returning kept enterprise public keys.
- [`apps/server/src/state-engine.ts#L1719-L1732`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1719-L1732): `treasuryKeepers` transparent lookup query.
- [`apps/server/src/state-engine.ts#L1739-L1753`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1739-L1753): `adminAssignTreasuryOperator` appointment writer.
- [`apps/server/src/state-engine.ts#L1762-L1770`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1762-L1770): `adminRevokeTreasuryOperator` revocation writer.
- [`scripts/grant-operator.mjs#L37-L41`](file:///Users/marty/projects/bp-manual/scripts/grant-operator.mjs#L37-L41): CLI script defect calling legacy `/operator` endpoint.

### What an Operator Can Do (Endpoints & Clients)
- [`apps/server/src/routes/treasury.ts#L79-L102`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L79-L102): `requireOperator` gate function.
- [`apps/server/src/routes/treasury.ts#L105-L133`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L105-L133): `GET /api/treasuries` public list read.
- [`apps/server/src/routes/treasury.ts#L135-L158`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L135-L158): `GET /api/treasury/:treasury` detail read.
- [`apps/server/src/routes/treasury.ts#L245-L255`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L245-L255): `POST /api/treasury/:treasury/offer`.
- [`apps/server/src/routes/treasury.ts#L259-L269`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L259-L269): `POST /api/treasury/:treasury/need`.
- [`apps/server/src/routes/treasury.ts#L272-L282`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L272-L282): `POST /api/treasury/:treasury/approve`.
- [`apps/server/src/routes/treasury.ts#L286-L296`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L286-L296): `POST /api/treasury/:treasury/complete`.
- [`apps/server/src/routes/treasury.ts#L299-L341`](file:///Users/marty/projects/bp-manual/apps/server/src/routes/treasury.ts#L299-L341): `POST /api/treasury/:treasury/sweep`.
- [`apps/native/app/(tabs)/projects.tsx#L550-L580`](file:///Users/marty/projects/bp-manual/apps/native/app/%28tabs%29/projects.tsx#L550-L580): Native mobile Community Treasuries list rendering and navigation.
- [`apps/native/app/treasury-detail.tsx#L193-L246`](file:///Users/marty/projects/bp-manual/apps/native/app/treasury-detail.tsx#L193-L246): Native operator controls panel (Post Offer, Post Need, Sweep).
- [`apps/native/app/treasury-post.tsx#L101-L128`](file:///Users/marty/projects/bp-manual/apps/native/app/treasury-post.tsx#L101-L128): Native listing creation form.
- [`apps/native/utils/db.ts#L1829-L1843`](file:///Users/marty/projects/bp-manual/apps/native/utils/db.ts#L1829-L1843): Native client helper functions for treasury routes.
- [`apps/native/utils/db.ts#L1835-L1840`](file:///Users/marty/projects/bp-manual/apps/native/utils/db.ts#L1835-L1840): Uncalled `treasuryApprove` and `treasuryComplete` helpers.
- [`apps/native/app/post/[id].tsx#L724`](file:///Users/marty/projects/bp-manual/apps/native/app/post/%5Bid%5D.tsx#L724): Mobile post screen passing personal key instead of treasury key to approval endpoint.
- [`apps/pwa/src/lib/api.ts#L1267-L1291`](file:///Users/marty/projects/bp-manual/apps/pwa/src/lib/api.ts#L1267-L1291): PWA API client helper functions.
- [`apps/pwa/src/pages/ProjectsPage.tsx#L270-L328`](file:///Users/marty/projects/bp-manual/apps/pwa/src/pages/ProjectsPage.tsx#L270-L328): PWA static, non-interactive treasury card rendering.

### Relation to the Commons
- [`apps/server/src/state-engine.ts#L330-L360`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L330-L360): `COMMONS_BALANCE` persistence and initialization.
- [`apps/server/src/state-engine.ts#L1460-L1490`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1460-L1490): `moveToCommons` implementation.
- [`apps/server/src/state-engine.ts#L1514-L1550`](file:///Users/marty/projects/bp-manual/apps/server/src/state-engine.ts#L1514-L1550): `payFromCommons` implementation.
