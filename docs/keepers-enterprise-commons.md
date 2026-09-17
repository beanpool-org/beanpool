# Keepers, Enterprises, and the Commons: Architectural Manual

> **⚠️ Historical.** Keeper (social/guardian) recovery was scrapped in September 2026.
> This document describes it as live because that was true when it was written.
> The only recovery paths now are the member's 12 words and SSO (native only).
> See [keeper-recovery-parked.md](keeper-recovery-parked.md).

This document provides a technical audit of three interlocking subsystems in BeanPool: **Keepers** (identity recovery), **Enterprises** (community treasury accounts), and the **Commons** (shared wealth, community governance, and crowdfunding).

Every statement in this manual is grounded directly in the codebase. Each feature, constraint, and flow is tagged with one of four implementation states:

- `BUILT AND REACHABLE`: Code exists on the server and is hooked up to active user interfaces in the clients.
- `BUILT BUT UNREACHABLE`: Code exists (in server routes, database schemas, or client helper libraries) but cannot be executed by normal user flows due to missing UI links, dead-end conditionals, or unmounted routes.
- `DESIGNED ONLY`: Present in documentation, architecture specs, comments, or design notes, but lacking executable implementation in code.
- `NOT PRESENT`: Explicitly absent or removed from the system.

Client-side enforcement and server-side enforcement are strictly distinguished throughout.

---

## 1. System Map

The three subsystems intersect across accounts, cryptography, authority, and liquidity:

```
+---------------------------------------------------------------------------------------------------+
|                                          BEANPOOL NODE                                            |
|                                                                                                   |
|  +---------------------------+    +----------------------------+    +--------------------------+  |
|  |       MEMBER ACCOUNT      |    |    ENTERPRISE (TREASURY)   |    |       COMMONS POOL       |  |
|  |  is_treasury = 0          |    |  is_treasury = 1           |    |  COMMONS_POOL balance    |  |
|  |  Subject to demurrage     |    |  Exempt from demurrage     |    |  System-level account    |  |
|  |  Credit line: vouch/trade |    |  Min 200 credit line       |    |  Funded by fees, sweeps, |  |
|  |  Key: Client-held         |    |  Key: Node-held            |    |  and demurrage           |  |
|  +-------------+-------------+    +--------------+-------------+    +-------------+------------+  |
|                |                                 |                                |               |
|                v                                 v                                v               |
|  +---------------------------+    +----------------------------+    +--------------------------+  |
|  |      KEEPERS (PEOPLE)     |    |     KEEPERS (OPERATORS)    |    |  GOVERNANCE & CROWDFUND  |  |
|  |  Identity Recovery       |    |  Enterprise Stewards       |    |  Project Systems         |  |
|  |  - Two-layer seed split   |    |  - Living member accounts  |    |  - Commons Proposals     |  |
|  |  - Hub share (A, clear)   |    |  - can_operate = 1         |    |    (QV, node_config)     |  |
|  |  - SSO / Member shares (B)|    |  - treasury_operators row  |    |  - Crowdfund Projects    |  |
|  |  - Rebuilds member seed   |    |  - Drive offers & needs    |    |    (Pledges, SQL table)  |  |
|  +---------------------------+    +----------------------------+    +--------------------------+  |
+---------------------------------------------------------------------------------------------------+
```

### 1.1 How the Systems Intersect

1. **The Overloaded Term "Keeper"**:
   - In **Account Recovery**, a keeper is an external party (the node hub, a trusted peer, or an OAuth SSO identity) holding an encrypted slice of a person's private seed. Keepers have zero authority over day-to-day transactions; their sole capability is releasing or unsealing their slice to rebuild the owner's private key.
   - In **Enterprises**, a keeper is an *operator* (a living member with `members.can_operate = 1` and an assignment in `treasury_operators`). These keepers do not hold cryptographic key fragments; instead, they act as authorized stewards who invoke server-side routes to trade, accept bids, post needs, and sweep funds on behalf of a treasury whose private key is stored on the node.

2. **Enterprises and the Commons Pool**:
   - An enterprise trades in the local marketplace to generate a balance. Operators can manually sweep surplus funds into the shared `COMMONS_POOL` via `moveToCommons` (`POST /api/treasury/:treasury/sweep`).
   - The Commons Pool also absorbs demurrage decay collected from standard member balances and platform transaction fees.

3. **The Commons and Project Funding**:
   - The Commons Pool is designed to disburse funds to community initiatives via quadratic voting in governance rounds (`closeVotingRound` debits `COMMONS_POOL`).
   - Concurrently, an independent crowdfunding system allows members to pledge beans directly from their personal accounts into dedicated project escrow accounts (`escrow_<projectId>`), releasing funds when target goals are met.

4. **Account Rules and Privileges**:
   - **Members**: Identity keys generated and stored client-side. Balances undergo decay (demurrage). Credit floors require activation through vouches or trade history.
   - **Enterprises**: Identity keys generated and stored on the node (`node_config`). Balances are explicitly decay-exempt (`setDecayExempt`). Credit floors are automatically granted at a minimum of 200 beans. Hidden from standard member search queries (`is_treasury = 0`).

---

## 2. Keepers and Account Recovery End-to-End

### 2.1 The Two Mathematical Models

The codebase contains two entirely different secret sharing architectures implemented in `packages/beanpool-core`:

```
Model 1: Sovereign Phrase Split (Legacy)
Recovery Phrase Envelope ---> Shamir Split GF(256) ---> N Fragments (Threshold T = 3)
                              (recovery-split.ts)

Model 2: Two-Layer Split (Current Architecture)
32-Byte Ed25519 Seed -------> Layer 1: XOR Split (two-layer-split.ts)
                                  |
            +---------------------+---------------------+
            |                                           |
            v                                           v
      Hub Share A (32B)                           Whole Share B (32B)
      Stored in plaintext                         Seed XOR A
      (plaintext-v1)                                    |
                                                        v
                                         Layer 2: Storage by Tier
                                         +--------------------------------------+
                                         | SSO Tier:                            |
                                         |   B un-split, sealed to provider:sub |
                                         |   (scrypt-xc20p-v1)                  |
                                         |   Threshold = 2 of 2 (Hub + SSO)     |
                                         +--------------------------------------+
                                         | Friend Tier:                         |
                                         |   B Shamir split GF(256) across      |
                                         |   friends with threshold T = 2       |
                                         |   (x25519-xc20p-v1)                  |
                                         |   Threshold = 3 of (1 + N)           |
                                         |   (Hub + 2 Friend Shares)            |
                                         +--------------------------------------+
```

#### 2.1.1 Model 1: Sovereign Phrase Shamir Split
- **Location**: `packages/beanpool-core/src/recovery-split.ts:64`, `recovery-split.ts:142-178`
- **Implementation State**: `BUILT BUT UNREACHABLE` (superseded by two-layer split in active enrolment flows)
- **Mechanism**: The 12-word recovery phrase is packed into a binary envelope with a CRC32 checksum, padded to 64 bytes, and split directly into $N$ Shamir shares over Galois Field $GF(256)$.
- **Threshold**: Fixed constant `RECOVERY_THRESHOLD = 3` (`recovery-split.ts:64`). Recombination requires any 3 of $N$ shares.
- **Payload**: Reconstructs the exact BIP-39 mnemonic string.

#### 2.1.2 Model 2: Two-Layer $A \oplus B$ Split
- **Location**: `packages/beanpool-core/src/two-layer-split.ts:63`, `two-layer-split.ts:98-180`
- **Implementation State**: `BUILT AND REACHABLE`
- **Mechanism**:
  1. The 32-byte Ed25519 private seed is extracted from the client's private key (`toEd25519Seed`).
  2. **Layer 1 ($A \oplus B$)**: The seed is XORed against a cryptographically secure 32-byte random buffer $A$ (`hubShare`):
     $$B = \text{seed} \oplus A$$
  3. **Share A (Hub Share)**: Held directly by the node. Stored in plaintext format (`KEEPER_ALG_PLAINTEXT = 'plaintext-v1'`).
  4. **Share B (Secret Layer)**: Handled under one of two operational tiers:
     - **SSO Tier**: $B$ remains a single 32-byte buffer. It is encrypted directly using XChaCha20-Poly1305 with a 256-bit key derived via scrypt from the provider name and OAuth subject claim `provider:sub` (`KEEPER_ALG_SSO = 'scrypt-xc20p-v1'`). Total pieces: 2 ($A$ and $B$). Total threshold: 2 of 2. There is no Shamir polynomial.
     - **Friend Tier**: $B$ is split using Shamir's Secret Sharing over $GF(256)$ into $N$ friend shares with a fixed threshold of 2 (`TWO_LAYER_THRESHOLD = 2` at `two-layer-split.ts:63`). Each friend slice $B_i$ is encrypted using X25519 ECDH key agreement with XChaCha20-Poly1305 to the friend's identity public key (`KEEPER_ALG_MEMBER = 'x25519-xc20p-v1'`).
- **Total Recovery Threshold**:
  - SSO Tier: Exactly 2 pieces ($A$ + $B$).
  - Friend Tier: Exactly 3 pieces ($A$ + any 2 friend shares $B_i$ and $B_j$).
- **Reconstruction Output**: Direct 32-byte Ed25519 seed. It does not reconstruct BIP-39 mnemonic words; it instantiates the Ed25519 keypair directly.

#### 2.1.3 The Hybrid SSO + Friends Tier
- **Specification**: `docs/recovery-model.md:120-145` describes a hybrid model where a user who has Google SSO can add 2 friends, causing $B$ to be Shamir-split 2-of-3 across `{google, friend_1, friend_2}`.
- **Implementation State**: `DESIGNED ONLY`.
- **Code Reality**: In `apps/server/src/routes/keepers.ts:267-274`, `POST /api/recovery/shares` strictly throws a 400 error if any share has `holderType === 'sso'`. In `apps/native/utils/keeper-enrolment.ts:269-278`, `enrolSsoKeeper` uploads only `[hub, sso]`. When a user enrols friends (`enrolFriendKeepers`), the server runs `putShareGeneration`, which deletes all previous rows for that member (`DELETE FROM recovery_shares WHERE owner_pubkey = ? AND generation < ?`). Enrolling friends wipes out SSO keepers, and enrolling SSO wipes out friend keepers. They operate as mutually exclusive silos.

### 2.2 Keeper Types and Status

Database schema constraint: `apps/server/src/db/db.ts:162-177`:
`CHECK (holder_type IN ('hub', 'member', 'sso'))`

| Keeper Type | Alg Marker | Storage Format | Encryption / Protection | Enrolment Route | Release Condition |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `hub` (K2) | `plaintext-v1` | Plain text on node | None (plaintext in DB; relies on D7 cooldown / human approval) | `POST /api/recovery/shares` or `/sso` | Rule D7: 24h delay or instant if human/SSO approved |
| `member` (K4/K5) | `x25519-xc20p-v1` | Encrypted row on node | X25519 ECDH + XChaCha20-Poly1305 (wrapped to friend's pubkey) | `POST /api/recovery/shares` | Rule D6: Instant when friend signs approval and re-wraps |
| `sso` (K3) | `scrypt-xc20p-v1` | Encrypted row on node | scrypt(provider:sub) + XChaCha20-Poly1305 | `POST /api/recovery/shares/sso` | Instant on verified OAuth ID token matching `sso_lookup_hash` |
| `device` (K1) | Retired | None | Removed from schema and engine | N/A | **Permanently retired** in `001-retire-device-keeper-type.sql` |

### 2.3 Server Storage Tables

The recovery system utilizes four core tables in SQLite (`apps/server/src/db/db.ts:162-240`):

1. `recovery_shares`: Stores the current and historical generations of split fragments.
   - `owner_pubkey`: Hex public key of the recovering member.
   - `holder_type`: `'hub' | 'member' | 'sso'`.
   - `holder_ref`: `'node'` (for hub), provider string like `'google'` (for SSO), or friend's public key (for member).
   - `share_index`: Shamir $x$-coordinate (1 to 255).
   - `encrypted_share`, `share_iv`, `share_tag`: Ciphertext payload and authentication envelope.
   - `ephemeral_pubkey`: X25519 sender public key (required for `member` type).
   - `sso_lookup_hash`, `sso_lookup_salt`: Blinded hash of OAuth identity (`HMAC-SHA256(provider || ':' || sub, salt)`).
   - `generation`: Incremental integer identifying the atomic split version.

2. `recovery_collections`: Tracks active recovery sessions.
   - `id`: UUID identifying the session.
   - `owner_pubkey`: Account being recovered.
   - `requester_ephemeral_pubkey`: Ephemeral signing key generated by the blank client device.
   - `generation`: Pinned generation number matching `recovery_shares`.
   - `status`: `'open' | 'completed' | 'cancelled' | 'expired'`.
   - `expires_at`: Timestamp marking session expiration (72-hour TTL).

3. `recovery_releases`: Append-only audit log of fragments released to a collection.
   - `collection_id`: Reference to `recovery_collections.id`.
   - `share_id`: Reference to `recovery_shares.id`.
   - `holder_type`, `share_index`: Metadata for reconstruction.
   - `payload`, `payload_iv`, `payload_tag`: Re-wrapped or plaintext fragment data.
   - `released_by`: Public key of the approving signer (null for machine/SSO releases).

4. `recovery_pin`: Tracks Argon2 recovery PIN hashes.
   - `owner_pubkey`: Primary key.
   - `pin_hash`: Argon2id password hash.
   - `attempts`: Counter tracking consecutive failed verifications.
   - `last_attempt_at`: Rate-limiting timestamp.

### 2.4 The Recovery PIN System

- **Location**: `apps/server/src/routes/pin.ts`, `apps/native/utils/pin.ts`, `apps/native/app/recover-identity.tsx`
- **Implementation State**: `BUILT BUT UNREACHABLE` / **DECORATIVE IN EFFECT**
- **Documented Intent**: `docs/recovery-model.md:262` claims: *"That is the PIN's job, and its only job: it reveals the keeper list. It does not gate."*
- **Code Reality**:
  1. **Identity Redaction**: When `POST /api/recovery/pin/verify` succeeds (`pin.ts:231-245`), the server explicitly suppresses member identities:
     ```typescript
     // Fetch keeper types (not identities — never expose who the friends are)
     const keepers = db.prepare(`
         SELECT holder_type, COUNT(*) as count FROM recovery_shares ... GROUP BY holder_type
     `).all(...) as { holder_type: string; count: number }[];
     ctx.body = { verified: true, keepers: keepers.map(k => ({ type: k.holder_type, count: k.count })) };
     ```
     The caller is returned only counts (e.g., `{ type: 'member', count: 3 }`), completely withholding *who* the friends are.
  2. **Client Bypass**: In `apps/native/app/recover-identity.tsx:120-124`, the recovery screen provides a visible **"Skip PIN"** button (`handleSkipPin`). Tapping "Skip PIN" bypasses verification entirely and calls `startRecoveryFlow()`.
  3. **Unused Response**: Even when the PIN is entered correctly, `handleVerifyPin` (`recover-identity.tsx:105-107`) records `setPinVerified(true)` and calls `startRecoveryFlow()`. The returned keeper count object is never rendered on screen. The PIN gates nothing on the server and reveals nothing to the user.

### 2.5 Approval Flow and Rule Enforcement (D6 and D7)

```
Recovering Device                      BeanPool Node                     Keeper (Friend)
       |                                     |                                  |
       | 1. POST /api/recovery/collect       |                                  |
       |    (callsign, ephemeralPubkey)      |                                  |
       |------------------------------------>|                                  |
       |                                     | 2. Push Notification             |
       |                                     |    "Someone is recovering..."    |
       |                                     |--------------------------------->|
       |                                     |                                  |
       |                                     | 3. POST approve-keeper/context   |
       |                                     |    (Keeper fetches fragment)     |
       |                                     |<---------------------------------|
       |                                     |                                  |
       |                                     | 4. Keeper decrypts with own key, |
       |                                     |    re-wraps to ephemeralPubkey   |
       |                                     |                                  |
       |                                     | 5. POST /api/recovery/           |
       |                                     |    approve-keeper                |
       |                                     |<---------------------------------|
       |                                     |                                  |
       | 6. POST /api/recovery/collect/hub   |                                  |
       |    (Rule D7 evaluates: human        |                                  |
       |     has approved -> instant)        |                                  |
       |------------------------------------>|                                  |
       |                                     |                                  |
       | 7. POST /api/recovery/              |                                  |
       |    collect/fragments                |                                  |
       |    (Returns Hub A + Member B_i)     |                                  |
       |<------------------------------------|                                  |
```

1. **Session Initiation**:
   - Recovering device creates a temporary Ed25519 ephemeral keypair.
   - Device sends `POST /api/recovery/collect` with the target callsign and its ephemeral public key (`recovery-collect.ts:122-181`).
   - Node opens a row in `recovery_collections` with a 72-hour TTL (`COLLECTION_TTL_MS = 72h`).
   - Node sends an immediate push notification to the owner and all human keepers: *"Someone is recovering an account"* (`recovery-collect.ts:157-167`).

2. **Rule D6 (Human Keeper Approval)**:
   - A human keeper signs into their client and opens the approval request.
   - Keeper client requests context via `POST /api/recovery/approve-keeper/context` (`recovery-collect.ts:308-341`), receiving the encrypted share row and the applicant's ephemeral public key.
   - Keeper client unseals the share using its private key (`openShareSealedToMember`), re-encrypts it to the applicant's ephemeral key (`rewrapShareForRecipient`), and submits it to `POST /api/recovery/approve-keeper` (`recovery-collect.ts:279-300`).
   - The fragment is released immediately. No cooldown applies (`recovery-release.ts:24-25`).

3. **Rule D7 (Hub Fragment Release)**:
   - Location: `apps/server/src/engine/recovery-release.ts:320-340`, `recovery-release.ts:555-597`
   - The node holds share $A$ in plaintext (`plaintext-v1`).
   - Release condition:
     - If at least one human keeper has released (`recovery_releases` contains `holder_type = 'member'`), the hub releases **immediately**.
     - If an SSO keeper has verified (`recovery_releases` contains `holder_type = 'sso'`), the hub releases **immediately**.
     - Otherwise, the hub fragment is locked for **24 hours** from session creation (`HUB_DELAY_MS = 24 * 60 * 60 * 1000`).

4. **SSO Keeper Release**:
   - Recovering device obtains a fresh OAuth ID token (Google or Apple).
   - Device requests a challenge nonce bound to its ephemeral key via `POST /api/recovery/collect/sso-nonce` (`recovery-collect.ts:237-243`).
   - Device calls `POST /api/recovery/collect/sso` with the ID token.
   - Node verifies the token against Google/Apple public JWKS, calculates `HMAC-SHA256(provider || ':' || sub, salt)`, matches the row in `recovery_shares`, and writes the release to `recovery_releases` (`recovery-release.ts:487-520`).

5. **Stop Button / Cancellation**:
   - The legitimate account owner can stop an ongoing recovery at any time before threshold completion by calling `POST /api/recovery/collect/cancel` (`recovery-collect.ts:413-422`).
   - Alternatively, re-splitting the account via `POST /api/recovery/shares` creates generation $G+1$ and drops older generations. Because active collections are pinned to generation $G$, all pending releases become invalid immediately.

### 2.6 Notification and Discovery Reality (PWA vs. Native)

- **Push Notifications**:
  - Sent via `dispatchPushNotification` on `POST /api/recovery/collect` (`recovery-collect.ts:159-167`). Best-effort transport; if notifications are disabled or the device is offline, delivery fails silently.
- **PWA Discovery**: `BUILT AND REACHABLE`
  - In `apps/pwa/src/components/RecoveryAlertBanner.tsx:29-55`, the PWA continuously polls `POST /api/recovery/approve-keeper/pending` every 30 seconds.
  - If a pending request exists, an orange banner appears on every screen, allowing the keeper to launch `IncomingRecoveryApprovalModal.tsx` and approve the recovery.
- **Native Discovery**: `BUILT BUT UNREACHABLE`
  - In `apps/native`, there is **no background polling** for `POST /api/recovery/approve-keeper/pending`.
  - In `apps/native/app/(tabs)/settings.tsx:459-465`, `IncomingRecoveryApprovalModal` is displayed **only** if the screen is opened with a deep link query parameter `params.collectionId` (from a system push notification).
  - **The Native Trap**: In `apps/native/app/(tabs)/settings.tsx:1913-1970`, a "Recovery Requests" screen is rendered under `mode === 'recovery-requests'`. It calls `getPendingRecoveryRequests`, `approveRecoveryRequest`, and `rejectRecoveryRequest` (`apps/native/utils/db.ts:4256-4279`). These functions make requests to `/api/recovery/pending/:pubkey` and `/api/recovery/approve`, which belong to the **legacy guardian system**. They do not interact with `recovery_collections`, `recovery_shares`, or two-layer keyholder releases. Approving a request here has zero effect on a friend's pending two-layer recovery.

### 2.7 What-Happens-If Scenarios

1. **Member loses phone with only SSO enrolled**:
   - *Outcome*: Recoverable immediately.
   - *Detail*: Member installs app on a new phone, enters callsign, logs into Google/Apple. SSO verifies, releasing share $B$. Hub evaluates D7: since SSO released, hub releases share $A$ instantly. App computes $A \oplus B$, derives the 32-byte seed, and restores the account in under 30 seconds.

2. **Member loses phone with only Friends enrolled**:
   - *Outcome*: Recoverable once two friends approve.
   - *Detail*: Member enters callsign. Friend 1 approves: share $B_1$ is released. Hub evaluates D7: human approved, so hub share $A$ releases immediately. Device now holds 2 of 3 required pieces ($A$ and $B_1$). The account remains locked until Friend 2 approves, releasing $B_2$. Device runs Shamir recombination on $B_1, B_2$ to recover $B$, then XORs $A \oplus B$ to restore the seed.

3. **Member forgets recovery PIN**:
   - *Outcome*: Zero operational impact.
   - *Detail*: The native recovery screen has a "Skip PIN" button. Skipping the PIN proceeds directly into collection session creation. Server-side releases do not verify or require the PIN.

4. **One friend goes rogue and approves an attacker's session**:
   - *Outcome*: Attack fails; account remains safe.
   - *Detail*: The attacker obtains share $B_1$. Under D7, human approval releases hub share $A$. The attacker now has 2 pieces ($A$ and $B_1$). However, Shamir reconstruction of layer $B$ requires threshold $T = 2$ friend shares. The attacker cannot reconstruct $B$ without a second friend's approval. The legitimate owner receives a push alert and can cancel the session or re-split.

5. **Attacker attempts recovery with no keeper access**:
   - *Outcome*: Attack stalled by 24h delay, then fails at threshold.
   - *Detail*: Attacker opens a session. Owner is alerted immediately. Attacker waits out the 24-hour D7 delay to receive hub share $A$. Holding only $A$ (random one-time pad buffer), the attacker has 1 of 3 required pieces. At 72 hours, the session expires and is deleted.

6. **Node database is fully compromised / stolen**:
   - *Outcome*: No user seeds are compromised.
   - *Detail*: The database holds share $A$ in plaintext, but layer $B$ shares are encrypted. SSO shares are encrypted with scrypt keys derived from OAuth tokens not held on the node. Member shares are encrypted with X25519 keys belonging to member devices. The attacker holds $A$, but 0 pieces of $B$.

7. **Owner re-splits while a recovery session is in flight**:
   - *Outcome*: In-flight session is instantly terminated.
   - *Detail*: `putShareGeneration` increments the account generation and deletes previous share rows. Any pending requests in the active collection will fail generation validation (`recovery-release.ts:49`), aborting the recovery.

8. **OAuth provider changes member's subject identifier (`sub`)**:
   - *Outcome*: Permanent lockout via SSO path.
   - *Detail*: Layer $B$ is sealed using `scrypt(provider:sub)`. If Google or Apple alters the subject identifier (or if the member uses a different account), token verification will yield a mismatch against `sso_lookup_hash`, and decryption of $B$ will fail. Recovery must fall back to friends or seed words.

9. **Member enrols friends after previously enrolling SSO**:
   - *Outcome*: SSO recovery is wiped out.
   - *Detail*: `enrolFriendKeepers` uploads friend shares via `POST /api/recovery/shares`. The server transaction deletes older generations. The SSO share is removed from `recovery_shares`. The user's account is now protected solely by friends.

---

## 3. Enterprises (Treasuries)

### 3.1 Definition and Identity

An enterprise is not a distinct database entity; it is a row in the standard `members` table with `is_treasury = 1` (`apps/server/src/state-engine.ts:2893-2938`).

- **Creation**: Admin calls `createTreasury(name, avatar, creditLine)`.
- **Key Generation**: The node automatically generates a fresh Ed25519 keypair on the server using Node's `crypto.generateKeyPairSync`.
- **Key Custody**: The private key is stored directly in the `node_config` SQLite table under the key `treasury_privkey_<pubKeyHex>` (`state-engine.ts:2929`). The enterprise has no hardware keystore and no sovereign client device; it is a hosted server-side identity.

### 3.2 Differences Between an Enterprise and a Person

| Property | Person Account (`is_treasury = 0`) | Enterprise Account (`is_treasury = 1`) | Citation |
| :--- | :--- | :--- | :--- |
| **Demurrage Decay** | Balances decay over time toward zero. | **Decay exempt**. Never suffers demurrage. | `state-engine.ts:2933`, `state-engine.ts:362` |
| **Credit Floor** | 0 base. Requires vouches or trade history to expand. | **Automatic minimum 200 beans** (`Math.max(200, creditLine)`). | `packages/beanpool-engine/src/trust.ts:407` |
| **Directory Search** | Visible in member directory and search. | **Hidden** (`SELECT ... WHERE is_treasury = 0`). | `state-engine.ts:182` |
| **Vouching** | Can vouch if granted `can_vouch = 1`. | **Cannot vouch**. Defaults to `can_vouch = 0`. | `state-engine.ts:2925` |
| **Governance Voting**| Accrues governance credits via trade volume. | **Cannot vote**. No operator voting route for treasuries. | `apps/server/src/routes/treasury.ts` |
| **Key Location** | SecureStore (native) or IndexedDB (PWA). | Server `node_config` table. | `state-engine.ts:2929` |

### 3.3 Operator Model and Permissions

Operating an enterprise requires dual-gated authority:

1. **Member Capability**: The human user must have `members.can_operate = 1` (granted by admin via `POST /api/local/admin/users/:pubkey/operator`).
2. **Enterprise Binding**: The human user must have an explicit assignment row in the `treasury_operators` table (`POST /api/local/admin/treasury/:treasury/operators`).
3. **Admin Override**: System administrators can operate any enterprise directly without being bound in `treasury_operators` (`canOperateTreasury` in `state-engine.ts:2975`).

### 3.4 Capabilities and Operations

All operator actions are routed through `apps/server/src/routes/treasury.ts`:

- **Holding Balances**: Real row in `accounts` table. Can receive payments from any marketplace sale or member transfer.
- **Posting Offers**: `POST /api/treasury/:treasury/offer`. Posts a goods/services listing to the marketplace (defaults to `repeatable = true`).
- **Posting Needs and the Offer Covenant**: `POST /api/treasury/:treasury/need`.
  - *The Offer Covenant Rule*: An enterprise is prevented from running a deficit on Needs unless it maintains an active Offer in the marketplace (`treasury.ts:266`, `state-engine.ts:2230`). If an enterprise has no live offer, posting a need returns: *"Failed — the treasury needs a live Offer first (offer covenant)"*.
- **Accepting Bids & Releasing Escrow**: Operators approve bids on treasury needs (`/approve`) and confirm completions (`/complete`), releasing escrow funds to workers.
- **Sweeping Surplus to the Commons**: `POST /api/treasury/:treasury/sweep`. An operator can transfer accumulated surplus beans from the enterprise account into the node's shared `COMMONS_POOL` via `moveToCommons` (`treasury.ts:299-341`).

---

## 4. The Commons

The Commons subsystem contains two completely separate, parallel architectures: **Commons Governance Proposals** (quadratic voting) and **Crowdfunding Projects** (escrow pledging).

```
+----------------------------------------------------------------------------------------------------+
|                                      TWO INDEPENDENT SYSTEMS                                       |
|                                                                                                    |
|  COMMONS GOVERNANCE PROPOSALS                              CROWDFUNDING PROJECTS                   |
|  - Storage: node_config ('commons_projects')               - Storage: SQL projects table           |
|  - Funding: Debited from COMMONS_POOL                      - Funding: Direct pledges from members  |
|  - Mechanism: Quadratic Voting (Cost = N^2)                - Mechanism: Escrow account threshold   |
|  - Currency: Governance Credits (Trade Value)              - Currency: Liquid member Beans         |
|  - Status: BUILT BUT UNREACHABLE (Dead routes / UI gap)    - Status: BUILT AND REACHABLE (PWA/Nat) |
+----------------------------------------------------------------------------------------------------+
```

### 4.1 Commons Pool Economics

- **Location**: `apps/server/src/state-engine.ts:330-360`, `apps/server/src/routes/commons.ts:28-30`
- **Balance Store**: Managed in-memory as `COMMONS_BALANCE` and persisted to SQLite `node_config` under key `'commons_pool_balance'`.
- **Inflows**:
  1. Market transaction commission fees.
  2. Demurrage decay swept from inactive or decaying accounts.
  3. Voluntary surplus sweeps from enterprises via `POST /api/treasury/:treasury/sweep`.
- **Outflows**:
  1. Winning proposals in closed governance rounds (`closeVotingRound` calls `ledger.deductFromCommons`).
  2. Administrative node operational debits.

### 4.2 System A: Commons Governance Proposals

- **Storage**: Serialized JSON arrays stored in `node_config` under keys `'commons_projects'` and `'voting_rounds'` (`state-engine.ts:3276`, `3393`). No dedicated SQL table exists.
- **Voting Mechanism**: Quadratic Voting.
  - Cost equation: $\text{CreditCost} = (\text{VoteCount})^2$.
  - Credit currency: **Governance Credits** (`getGovernanceCredits` at `state-engine.ts:3357`). Derived directly from `qualifiedTradeValue(pubkey)` (completed escrow trades with counterparty caps). Liquid beans cannot be spent on governance votes.
- **Round Lifecycle**:
  1. Members submit proposals via `POST /api/commons/projects`.
  2. Admin creates a voting round with selected project IDs via `createVotingRound`.
  3. Members allocate votes using governance credits via `POST /api/commons/vote`.
  4. Admin closes round via `closeVotingRound`. The project with the highest quadratic vote weight wins.
  5. The requested bean amount is debited from `COMMONS_POOL` and credited to the proposer's ledger balance (`state-engine.ts:3437-3440`).
- **Implementation State**: `BUILT BUT UNREACHABLE`.
  - In PWA: `apps/pwa/src/lib/api.ts:1212-1234` defines client functions for `/api/commons/projects` and `/api/commons/vote`, but **no component in `apps/pwa/src` imports or renders them**.
  - In Native: Does not call the commons governance endpoints.

### 4.3 System B: Crowdfunding Projects

- **Storage**: Dedicated SQL table `projects` (`id, creator_pubkey, title, description, photos, goal_amount, current_amount, status, deadline_at`) (`apps/server/src/db/db.ts:126-140`).
- **Pledge Mechanism**: Direct bean transfers.
  - Member pledges beans via `POST /api/crowdfund/projects/:id/pledge` (`commons.ts:203-233`).
  - Pledges debit the member's liquid balance and credit a synthetic escrow account `escrow_<projectId>` (`db.ts:780-804`).
- **Project Completion**:
  - When `current_amount >= goal_amount`, the project status shifts to `'FUNDED'`.
  - The node automatically drains the escrow account and sweeps the full balance to `creator_pubkey` with an internal transaction memo `"Escrow Release: Funding Goal Reached"` (`db.ts:810-828`).
  - If a project is deleted or cancelled while active, all pledged beans are refunded from escrow back to backers (`db.ts:858-895`).
- **Implementation State**: `BUILT AND REACHABLE` in PWA and Native.

### 4.4 Client Disconnects and Dead Voting Routes

The coexistence of these two systems has caused severe wiring defects in the client applications:

1. **Native App Voting Route Returns 404**:
   - In `apps/native/utils/db.ts:1853-1866`, `voteForProjectApi` makes a request to `POST /api/crowdfund/projects/vote`.
   - **This route does not exist on the server** (it returns HTTP 404). As acknowledged in the code comment at `native/utils/db.ts:1845-1852`, quadratic voting is only mounted at `/api/commons/vote`, which expects proposals from `node_config`, not crowdfunding project IDs.
2. **Native UI Suppresses Voting**:
   - In `apps/native/app/(tabs)/projects.tsx:298`, voting buttons are rendered only if `item.type === 'commons'`.
   - However, `getProjects()` in `native/utils/db.ts:1421` hardcodes `type: 'community'` for every row fetched from the `projects` table. As a result, the voting stepper and submission buttons are permanently hidden in the mobile UI.
3. **PWA Completely Omits Governance**:
   - `apps/pwa/src/pages/ProjectsPage.tsx` exclusively interfaces with the crowdfunding endpoints (`/api/crowdfund/*`). It contains zero screens, modals, or triggers for Commons pool balance reads, proposal creation, voting rounds, or quadratic voting.

---

## 5. What Does Not Add Up

The following contradictions, disconnected flows, and architectural fractures are ranked in order of their impact on a live community:

### 1. The Broken Commons Governance System
- **Severity**: High (Total feature failure and democratic confusion).
- **Reality**: The node has a quadratic voting engine backed by the Commons Pool, but proposals are serialized into a config text blob. The clients instead point their UI at the crowdfunding table. The native app has dead voting code calling a non-existent route (`/api/crowdfund/projects/vote` -> 404), which is masked only because another line of code hardcodes `type: 'community'`, hiding the buttons. A community cannot run democratic funding rounds through the app.

### 2. Native Keepers Cannot Discover Recovery Requests Without Push Notifications
- **Severity**: High (Permanent account lockout hazard).
- **Reality**: If an applicant starts a friend recovery, native keepers never see it unless they receive and tap an external push notification containing `params.collectionId`. There is no in-app banner or polling mechanism on native mobile. Furthermore, the Settings tab contains a "Recovery Requests" screen that calls dead legacy guardian endpoints (`/api/recovery/pending/:pubkey`), showing nothing. If push fails, friends cannot approve recoveries.

### 3. Destruction of the Hybrid SSO + Friends Tier
- **Severity**: Medium-High (Loss of documented redundancy).
- **Reality**: Documentation promises that users can start with Google/Apple SSO and add friends to create a unified 2-of-3 split over layer $B$. In code, `POST /api/recovery/shares` rejects SSO shares, and `putShareGeneration` deletes previous generations. Enrolling friends wipes SSO, and enrolling SSO wipes friends. Users who believe they have both are protected by only whichever they clicked last.

### 4. The Decorative Recovery PIN
- **Severity**: Medium (Misleading security guarantees).
- **Reality**: Architecture documentation states the PIN is required to reveal the friend list. The server implementation explicitly refrains from returning friend identities, returning only anonymous counts. The mobile client provides a "Skip PIN" button that bypasses verification entirely. Setting or verifying a PIN changes nothing about the recovery outcome.

### 5. Plaintext Enterprise Keys Held on Server
- **Severity**: Medium (Centralization and custody liability).
- **Reality**: While member accounts are sovereign with keys held in device keystores, enterprises have their Ed25519 private keys stored directly in plaintext inside the node's SQLite database (`node_config`). Anyone with database read access or file system access to the server can extract enterprise private keys and forge arbitrary trades or transfers.

### 6. Semantic Confusion Over "Keepers"
- **Severity**: Low-Medium (Developer and governance cognitive overhead).
- **Reality**: The product uses the term "Keeper" for two fundamentally disparate concepts. A member keeper is an encrypted key-fragment holder for disaster recovery. An enterprise keeper is a business manager with operational posting rights.

---

## 6. Open Decisions

The project owner should evaluate and decide on the following structural choices:

### Decision 1: Unify Commons Governance and Crowdfunding
- **Context**: Commons proposals (quadratic voting funded by pool) and Crowdfunding projects (escrow pledges funded by members) live in separate tables, use different currencies, and have disconnected client implementations.
- **Option A (Consolidate into Crowdfunding)**: Retire the JSON-backed Commons governance system entirely. Allow community crowdfunding projects to optionally request matching grants from the Commons Pool.
  - *Pros*: Aligns with current working PWA UI; simplifies database to standard SQL tables.
  - *Cons*: Abandons quadratic voting and governance credit mechanics.
- **Option B (Implement True Dual System)**: Build a dedicated SQL table for `commons_proposals`, create proper PWA/Native governance screens, and wire quadratic voting to `/api/commons/vote`.
  - *Pros*: Fulfills the original governance design; enables democratic allocation of pool funds.
  - *Cons*: Requires significant frontend development in both clients.

### Decision 2: Native Recovery Discovery Architecture
- **Context**: Native keepers cannot see pending recovery requests if push notifications fail, and Settings points to dead legacy guardian code.
- **Option A (Port PWA Polling to Native)**: Add an active polling hook or WebSocket listener in the native app for `POST /api/recovery/approve-keeper/pending`, displaying an in-app alert banner.
  - *Pros*: Guarantees discovery regardless of APNS/FCM push delivery status.
  - *Cons*: Minor background network overhead on mobile.
- **Option B (Notification Only with Clean Fallback)**: Remove the legacy "Recovery Requests" screen in native Settings and replace it with an explicit "Enter Recovery Code" input where a keeper can manually paste a friend's collection ID.
  - *Pros*: Zero background battery/network impact.
  - *Cons*: Requires out-of-band communication of collection IDs between friends.

### Decision 3: Resolve the SSO + Friend Tier Partition
- **Context**: SSO and Friend tiers are mutually exclusive in code, despite documentation promising a hybrid tier.
- **Option A (Formalize as Two Distinct Options)**: Update documentation and client UI to present an explicit choice: *"Choose Google/Apple Sign-In OR Choose 3 Friends"*. Prevent enrolment in both.
  - *Pros*: Zero risk of cryptographic desynchronization; matches code reality.
  - *Cons*: Removes the hybrid safety net.
- **Option B (Implement Shamir Split Over Layer B for Hybrid)**: Update `apps/native/utils/keeper-enrolment.ts` and `apps/server/src/engine/keeper-deposit.ts` to allow a hybrid generation where layer $B$ is Shamir-split across 1 SSO provider and $N$ friends.
  - *Pros*: Implements the full design specification.
  - *Cons*: Substantial cryptographic complexity and state-engine migration requirements.

### Decision 4: Disposition of the Recovery PIN
- **Context**: The PIN gates nothing on the server, reveals no identities, and can be skipped on native.
- **Option A (Delete the PIN Entirely)**: Remove `apps/server/src/routes/pin.ts`, `apps/native/utils/pin.ts`, and the PIN entry modal.
  - *Pros*: Eliminates dead code, reduces user onboarding friction, and removes misleading security promises.
  - *Cons*: Leaves friend recovery without a rate-limiting pre-authentication hurdle.
- **Option B (Make PIN Gate Collection Initiation)**: Require a valid PIN verification on the server before `POST /api/recovery/collect` will issue a collection session for an account.
  - *Pros*: Provides real brute-force protection against unauthorized collection creation.
  - *Cons*: Introduces permanent lockout risk if a user forgets their PIN.

---

## 7. Appendix: Code Citations

### Keepers and Account Recovery
- `packages/beanpool-core/src/two-layer-split.ts:63`: Definition of `TWO_LAYER_THRESHOLD = 2`.
- `packages/beanpool-core/src/two-layer-split.ts:98-180`: `splitHubAndWhole` and `splitTwoLayer` XOR and Shamir splitting logic.
- `packages/beanpool-core/src/recovery-split.ts:64`: Definition of `RECOVERY_THRESHOLD = 3` (legacy phrase split).
- `packages/beanpool-core/src/keeper-crypto.ts:75-76`: Constants `KEEPER_ALG_MEMBER = 'x25519-xc20p-v1'` and `KEEPER_ALG_SSO = 'scrypt-xc20p-v1'`.
- `packages/beanpool-core/src/keeper-crypto.ts:108`: Constant `KEEPER_ALG_PLAINTEXT = 'plaintext-v1'`.
- `apps/server/src/routes/keepers.ts:251-282`: `POST /api/recovery/shares` refusing SSO fragments.
- `apps/server/src/routes/keepers.ts:325-339`: `POST /api/recovery/shares/hub-fragment` returning plaintext hub share.
- `apps/server/src/routes/keepers.ts:341-378`: `POST /api/recovery/shares/sso` deposit route.
- `apps/server/src/engine/recovery-shares.ts:110-249`: `putShareGeneration` atomic writer, validation, and deletion of older generations.
- `apps/server/src/engine/keeper-deposit.ts:96-250`: `depositSsoKeeperGeneration` SSO token verification, lookup hash derivation, and hub share reuse check.
- `apps/server/src/engine/recovery-release.ts:52-56`: `COLLECTION_TTL_MS = 72h` and `HUB_DELAY_MS = 24h`.
- `apps/server/src/engine/recovery-release.ts:320-340`: `hubReleaseEligibleAt` evaluating human and SSO releases for instant hub unlock.
- `apps/server/src/engine/recovery-release.ts:429-470`: `releaseMemberFragment` (Rule D6 human approval).
- `apps/server/src/engine/recovery-release.ts:555-597`: `releaseHubFragment` (Rule D7 hub fragment release).
- `apps/server/src/routes/recovery-collect.ts:122-181`: `POST /api/recovery/collect` session initialization and push alert dispatch.
- `apps/server/src/routes/recovery-collect.ts:354-410`: `POST /api/recovery/approve-keeper/pending` discovery endpoint.
- `apps/server/src/routes/pin.ts:231-245`: `POST /api/recovery/pin/verify` redacting keeper identities and returning counts only.
- `apps/native/utils/keeper-enrolment.ts:269-278`: `enrolSsoKeeper` uploading only `[hub, sso]`.
- `apps/native/utils/keeper-enrolment.ts:383-404`: `enrolFriendKeepers` uploading `[hub, member...]`.
- `apps/native/app/recover-identity.tsx:120-124`: `handleSkipPin` bypassing PIN entry.
- `apps/native/app/(tabs)/settings.tsx:459-465`: `IncomingRecoveryApprovalModal` gated strictly on query parameter `params.collectionId`.
- `apps/native/app/(tabs)/settings.tsx:1913-1970`: Legacy "Recovery Requests" screen calling unlinked guardian routes.
- `apps/pwa/src/components/RecoveryAlertBanner.tsx:29-55`: PWA 30-second polling loop for pending keeper approvals.

### Enterprises (Treasuries)
- `apps/server/src/state-engine.ts:2893-2938`: `createTreasury` generating server-side Ed25519 keys and writing `is_treasury = 1`.
- `apps/server/src/state-engine.ts:2929`: Plaintext private key stored in `node_config` as `treasury_privkey_<pubKeyHex>`.
- `apps/server/src/state-engine.ts:2933`: `ledger.setDecayExempt(pubKeyHex)` exempting treasury from demurrage.
- `packages/beanpool-engine/src/trust.ts:406-407`: Automatic minimum 200 credit line for enterprises (`Math.max(200, grantedCredit)`).
- `apps/server/src/state-engine.ts:182`: Member query hiding enterprises (`WHERE is_treasury = 0`).
- `apps/server/src/routes/treasury.ts:79-102`: `requireOperator` enforcing `can_operate = 1` and `treasury_operators` assignment.
- `apps/server/src/routes/treasury.ts:245-255`: `POST /api/treasury/:treasury/offer` marketplace offer creation.
- `apps/server/src/routes/treasury.ts:259-269`: `POST /api/treasury/:treasury/need` enforcing the offer covenant.
- `apps/server/src/routes/treasury.ts:299-341`: `POST /api/treasury/:treasury/sweep` surplus sweep via `moveToCommons`.

### The Commons and Projects
- `apps/server/src/state-engine.ts:330-362`: In-memory `COMMONS_BALANCE` tracking and persistence to `node_config`.
- `apps/server/src/state-engine.ts:3263-3280`: `createProject` storing Commons proposals as JSON in `node_config` under `'commons_projects'`.
- `apps/server/src/state-engine.ts:3312-3343`: `voteForProject` quadratic voting execution ($Cost = Votes^2$).
- `apps/server/src/state-engine.ts:3357-3377`: `getGovernanceCredits` calculating voting credits from qualified trade value.
- `apps/server/src/state-engine.ts:3379-3397`: `createVotingRound` storing rounds in `node_config` under `'voting_rounds'`.
- `apps/server/src/state-engine.ts:3399-3450`: `closeVotingRound` debiting `COMMONS_POOL` and crediting the winning proposer.
- `apps/server/src/db/db.ts:126-140`: SQL schema for the `projects` crowdfunding table.
- `apps/server/src/db/db.ts:752-836`: `pledgeToProject` transferring beans to `escrow_<projectId>` and auto-sweeping to creator on goal completion.
- `apps/server/src/routes/commons.ts:36-51`: `POST /api/commons/projects` Commons proposal submission.
- `apps/server/src/routes/commons.ts:79-94`: `POST /api/commons/vote` Commons quadratic voting route.
- `apps/server/src/routes/commons.ts:127-152`: `POST /api/crowdfund/projects` Crowdfunding project creation.
- `apps/server/src/routes/commons.ts:203-233`: `POST /api/crowdfund/projects/:id/pledge` Crowdfunding pledge route.
- `apps/native/utils/db.ts:1421`: `getProjects` hardcoding `type: 'community'` on rows from `projects`.
- `apps/native/utils/db.ts:1845-1866`: `voteForProjectApi` calling non-existent `POST /api/crowdfund/projects/vote` (HTTP 404).
- `apps/native/app/(tabs)/projects.tsx:298`: Mobile voting controls suppressed because `item.type !== 'commons'`.
- `apps/pwa/src/pages/ProjectsPage.tsx:60-77`: PWA exclusively fetching and rendering crowdfunding projects; zero integration with Commons proposals or rounds.
