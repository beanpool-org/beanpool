# Code Review: Pull Request #689 (`feat/pwa-parity-c`)

**Verdict: MERGE BLOCKED** — The server route implementation and cryptographic primitives in `@beanpool/core` are secure, authenticated properly, and enforce strict caller isolation. However, merge is blocked by a confirmed high-severity threshold/progress bug in [apps/pwa/src/pages/WelcomePage.tsx:1426-1434](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/pages/WelcomePage.tsx#L1426-L1434) and [apps/pwa/src/lib/api.ts:1537-1545](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1537-L1545) where the friend recovery waiting screen displays **"Friend Approvals Collected: 2 / 2"** after only **ONE** friend has approved (because the unlocked community hub piece is counted toward friend approvals). This falsely convinces recovering members that all friends have approved, preventing them from contacting their second friend and trapping account recovery in an indefinite hang. Additionally, [apps/pwa/src/pages/WelcomePage.tsx:367-404](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/pages/WelcomePage.tsx#L367-L404) polls the node every 3 seconds with two cryptographic POST requests without pausing or backing off when the browser tab is hidden.

---

## Priority 1: The Server Route Security & Invariants Audit

The PR adds a pending keeper discovery route in [apps/server/src/routes/recovery-collect.ts:339-411](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L339-L411) handled by `pendingKeeperHandler`.

### 1. Authentication & Public Allowlist Verification
- **CONFIRMED**: In [apps/server/src/https-server.ts:736](file:///Users/marty/projects/bp-parity-c/apps/server/src/https-server.ts#L736), `isMutatingApi` catches all `POST`, `PUT`, and `DELETE` requests under `/api/`.
- **CONFIRMED**: Neither `/api/recovery/approve-keeper/pending` nor its alias `/api/recovery/collect/pending-keeper` is present in `PUBLIC_READ_EXACT`, `PUBLIC_READ_PATTERNS`, or `isBypassed` ([apps/server/src/https-server.ts:230-274, 741-752](file:///Users/marty/projects/bp-parity-c/apps/server/src/https-server.ts#L230-L274)).
- **CONFIRMED**: Every request to either path MUST carry valid Ed25519 signature headers (`X-Public-Key`, `X-Signature`, `X-Timestamp`, `X-Nonce`). The middleware verifies signature validity, timestamp freshness (`SIGNATURE_FRESHNESS_MS`), and consumes the single-use nonce before binding `ctx.state.actor = pubKeyHex` ([apps/server/src/https-server.ts:757-821](file:///Users/marty/projects/bp-parity-c/apps/server/src/https-server.ts#L757-L821)).
- **CONFIRMED**: In `pendingKeeperHandler` ([apps/server/src/routes/recovery-collect.ts:354-359](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L354-L359)), the handler immediately checks:
  ```ts
  const keeper = ctx.state?.actor as string | undefined;
  if (!keeper || !getMember(keeper)) {
      ctx.status = 401;
      ctx.body = { error: 'Sign in first.' };
      return;
  }
  ```
  An anonymous or non-member keypair receives a strict `401 Unauthorized`.

### 2. Caller Isolation & Parameter Immutability
- **CONFIRMED**: The handler takes **zero** input parameters from the client. It does not inspect `(ctx as any).requestBody`, URL query parameters (`ctx.query`), or custom headers to determine which keeper to query.
- **CONFIRMED**: The keeper identity is derived exclusively from `ctx.state.actor`. There is no parameter or header an attacker can inject or vary to ask about another member's obligations.

### 3. Data Leak Analysis vs. Push Notifications
- **CONFIRMED**: For each qualifying collection, the handler returns only:
  ```ts
  {
      collectionId: state.collection.id,
      ownerPubkey: state.collection.ownerPubkey,
      callsign: owner?.callsign ?? 'Unknown Member',
      createdAt: state.collection.createdAt,
      expiresAt: state.collection.expiresAt,
  }
  ```
  ([apps/server/src/routes/recovery-collect.ts:393-400](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L393-L400)).
- **CONFIRMED**: No share fragments, ciphertexts (`encryptedShare`, `payload`), IVs (`shareIv`, `payloadIv`), tags (`shareTag`, `payloadTag`), or ephemeral public keys are returned.
- **CONFIRMED**: The metadata returned is identical to what the existing server push notification dispatches to that same keeper when a collection opens in [apps/server/src/routes/recovery-collect.ts:159-167](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L159-L167) (`collectionId`, `callsign`, and timestamps).

### 4. Liveness Semantics
- **CONFIRMED**: The handler queries open, unexpired collections in SQLite (`status = 'open' AND expires_at > ?`), then evaluates each candidate against `collectionState(row.id)` ([apps/server/src/engine/recovery-release.ts:240-269](file:///Users/marty/projects/bp-parity-c/apps/server/src/engine/recovery-release.ts#L240-L269)):
  - **Cancelled / Complete / Expired**: `collection.status !== 'open'` or `expiresAt <= Date.now()` marks `state.live = false` and skips reporting ([apps/server/src/routes/recovery-collect.ts:379](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L379)).
  - **Stale Generation**: If the account owner re-splits after opening the session, `getCurrentGeneration(owner) !== collection.generation` sets `state.live = false, reason: 'stale-generation'`, immediately dropping it from the keeper's pending list.
  - **Self-Approval Guard**: `state.collection.ownerPubkey === keeper` skips reporting, preventing a member from seeing their own recovery as an inbound keeper task ([apps/server/src/routes/recovery-collect.ts:381](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L381)).
  - **Already Approved**: `listReleases(state.collection.id).some(r => r.holderType === 'member' && r.releasedBy === keeper)` checks if this keeper has already released their fragment; once approved, it stops reporting immediately ([apps/server/src/routes/recovery-collect.ts:387-390](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L387-L390)).
- **CONFIRMED**: Verified with comprehensive automated tests in [apps/server/src/test-keeper-pending-route.ts:87-199](file:///Users/marty/projects/bp-parity-c/apps/server/src/test-keeper-pending-route.ts#L87-L199) (25/25 assertions passing).

### 5. Enumeration & Oracle Resistance
- **CONFIRMED**: An outsider calling this endpoint receives `{ pending: [] }`. It provides no oracle regarding how many total collections are open on the node, who is recovering, or who holds shares for whom. A caller only ever learns about an open collection if the recovering member specifically enrolled that caller as a `member` keeper in `recovery_shares` for their current generation.

### 6. Dual Route Registration Audit
- **CONFIRMED**: The handler is registered at two routes:
  1. `POST /api/recovery/approve-keeper/pending` ([apps/server/src/routes/recovery-collect.ts:409](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L409))
  2. `POST /api/recovery/collect/pending-keeper` ([apps/server/src/routes/recovery-collect.ts:410](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L410))
- **CONFIRMED**: Both paths are intentional. Path 1 aligns with the sibling keeper approval routes (`/api/recovery/approve-keeper` and `/api/recovery/approve-keeper/context`), used by the PWA client in [apps/pwa/src/lib/api.ts:1348](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1348). Path 2 is an alias aligning with the `/api/recovery/collect/*` session hierarchy.
- **CONFIRMED**: Both are HTTP `POST`, both start with `/api/`, both pass through identical signature and membership checks, and both invoke the exact same handler function. Both are equally protected.

### 7. Exposure Assessment
- **CONFIRMED**: There is NO way for an unauthorised caller to learn who is recovering an account through this endpoint.

---

## Priority 2: The Cryptographic Path Audit

### 1. Shared Helpers & Core Primitives
- **CONFIRMED**: The PWA does not roll any custom cryptographic algorithms. It imports and uses:
  - `openShareAsMember` ([packages/beanpool-core/src/keeper-crypto.ts:333](file:///Users/marty/projects/bp-parity-c/packages/beanpool-core/src/keeper-crypto.ts#L333))
  - `rewrapShareToDevice` ([packages/beanpool-core/src/keeper-crypto.ts:528](file:///Users/marty/projects/bp-parity-c/packages/beanpool-core/src/keeper-crypto.ts#L528))
  - `openRewrappedShare` ([packages/beanpool-core/src/keeper-crypto.ts:548](file:///Users/marty/projects/bp-parity-c/packages/beanpool-core/src/keeper-crypto.ts#L548))
  - `readHubShare` ([packages/beanpool-core/src/keeper-crypto.ts:468](file:///Users/marty/projects/bp-parity-c/packages/beanpool-core/src/keeper-crypto.ts#L468))
  - `combineBytes` ([packages/beanpool-core/src/two-layer-split.ts:80](file:///Users/marty/projects/bp-parity-c/packages/beanpool-core/src/two-layer-split.ts#L80))
  - `splitTwoLayer`, `recordShareForHub`, `sealShareToMember`, `TWO_LAYER_THRESHOLD`
  - Normalization helpers: `toEd25519Seed` and `toEd25519Pkcs8` ([packages/beanpool-core/src/ed25519-key.ts](file:///Users/marty/projects/bp-parity-c/packages/beanpool-core/src/ed25519-key.ts)).

### 2. Dual Private Key Format Handling
- **CONFIRMED**: Native identities store a raw 32-byte seed (64 hex characters), whereas PWA identities store a 48-byte PKCS8 envelope (96 hex characters).
- **CONFIRMED**: In `approveInboundRecovery` ([apps/pwa/src/lib/api.ts:1319](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1319)), `identity.privateKey` is passed to `openShareAsMember`. Inside `openShareAsMember` ([packages/beanpool-core/src/keeper-crypto.ts:338](file:///Users/marty/projects/bp-parity-c/packages/beanpool-core/src/keeper-crypto.ts#L338)), `toEd25519Seed(asBytes(privateKey, 'privateKey'))` strips the PKCS8 prefix and produces the exact 32-byte seed before deriving the Montgomery X25519 secret scalar.
- **CONFIRMED**: In `enrolFriendKeepersApi` ([apps/pwa/src/lib/api.ts:1438](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1438)), `toEd25519Seed(hexToBytes(identity.privateKey))` is explicitly called before `splitTwoLayer`.
- **CONFIRMED**: In `apps/native/utils/keeper-enrolment.ts:216, 371`, this PR updates `enrolSsoKeeper` and `enrolFriendKeepers` to use `toEd25519Seed(hexToBytes(identity.privateKey))` instead of raw `hexToBytes`, preventing regressions when native handles PKCS8-formatted keys.

### 3. Tamper Resistance & Loud Failures
- **CONFIRMED**: All cryptographic wrapping utilizes XChaCha20-Poly1305 with AEAD authentication tags.
- **CONFIRMED**: If a held share is corrupted, truncated, altered, or opened with the wrong key, `open` in [packages/beanpool-core/src/keeper-crypto.ts:223-225](file:///Users/marty/projects/bp-parity-c/packages/beanpool-core/src/keeper-crypto.ts#L223-L225) throws a `KeeperCryptoError`:
  > *"A recovery fragment did not open. The key is wrong, or the fragment has been altered."*
- **CONFIRMED**: In [apps/pwa/src/components/IncomingRecoveryApprovalModal.tsx:76-78](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/components/IncomingRecoveryApprovalModal.tsx#L76-L78), this error is caught and rendered in a high-visibility error alert banner, blocking the release of invalid ciphertexts.
- **CONFIRMED**: On the recovering device in [apps/pwa/src/lib/api.ts:1606-1608](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1606-L1608), after combining shares, the reconstructed public key is compared against `expectedPublicKey`. If it does not match, it throws `Error('Reconstructed account does not match expected identity.')`, aborting identity import.

---

## Priority 3: Honesty of the UI & Server Endpoint Audit

### 1. Verification of Every `/api/` Endpoint Called by PWA Recovery Code
Every recovery route invoked across `apps/pwa/src/` was mapped to its implementation in `apps/server/src/`:

| HTTP Method | API Path | PWA Caller File:Line | Matching Server Route File:Line | Audit Status |
|---|---|---|---|---|
| `GET` | `/api/recovery/lookup/:callsign` | [apps/pwa/src/lib/api.ts:1132](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1132) | [apps/server/src/routes/community.ts:1259](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/community.ts#L1259) | **CONFIRMED** |
| `POST` | `/api/recovery/request` | [apps/pwa/src/lib/api.ts:1136](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1136) | [apps/server/src/routes/community.ts:1284](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/community.ts#L1284) | **CONFIRMED** |
| `GET` | `/api/recovery/pending/:pubkey` | [apps/pwa/src/lib/api.ts:1144, 1368](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1144) | [apps/server/src/routes/community.ts:1323](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/community.ts#L1323) | **CONFIRMED** |
| `POST` | `/api/recovery/approve` | [apps/pwa/src/lib/api.ts:1148](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1148) | [apps/server/src/routes/community.ts:1369](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/community.ts#L1369) | **CONFIRMED** |
| `POST` | `/api/recovery/reject` | [apps/pwa/src/lib/api.ts:1152](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1152) | [apps/server/src/routes/community.ts:1415](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/community.ts#L1415) | **CONFIRMED** |
| `POST` | `/api/recovery/cancel` | [apps/pwa/src/lib/api.ts:1156](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1156) | [apps/server/src/routes/community.ts:1438](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/community.ts#L1438) | **CONFIRMED** |
| `GET` | `/api/recovery/status/:pubkey` | [apps/pwa/src/lib/api.ts:1160](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1160) | [apps/server/src/routes/community.ts:1429](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/community.ts#L1429) | **CONFIRMED** |
| `POST` | `/api/recovery/approve-keeper/context` | [apps/pwa/src/lib/api.ts:1287](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1287) | [apps/server/src/routes/recovery-collect.ts:308](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L308) | **CONFIRMED** |
| `POST` | `/api/recovery/approve-keeper` | [apps/pwa/src/lib/api.ts:1325](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1325) | [apps/server/src/routes/recovery-collect.ts:279](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L279) | **CONFIRMED** |
| `POST` | `/api/recovery/approve-keeper/pending` | [apps/pwa/src/lib/api.ts:1348](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1348) | [apps/server/src/routes/recovery-collect.ts:409](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L409) | **CONFIRMED** |
| `POST` | `/api/recovery/collect/pending-keeper` | Server Alias | [apps/server/src/routes/recovery-collect.ts:410](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L410) | **CONFIRMED** |
| `POST` | `/api/recovery/collect/mine` | [apps/pwa/src/lib/api.ts:1395](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1395) | [apps/server/src/routes/recovery-collect.ts:425](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L425) | **CONFIRMED** |
| `POST` | `/api/recovery/collect/cancel` | [apps/pwa/src/lib/api.ts:1406](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1406) | [apps/server/src/routes/recovery-collect.ts:413](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L413) | **CONFIRMED** |
| `POST` | `/api/recovery/shares/status` | [apps/pwa/src/lib/api.ts:1417](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1417) | [apps/server/src/routes/keepers.ts:622](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/keepers.ts#L622) | **CONFIRMED** |
| `POST` | `/api/recovery/shares` | [apps/pwa/src/lib/api.ts:1456](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1456) | [apps/server/src/routes/keepers.ts:251](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/keepers.ts#L251) | **CONFIRMED** |
| `DELETE` | `/api/recovery/shares` | [apps/pwa/src/lib/api.ts:1463](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1463) | [apps/server/src/routes/keepers.ts:463](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/keepers.ts#L463) | **CONFIRMED** |
| `POST` | `/api/recovery/collect` | [apps/pwa/src/lib/api.ts:1490](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1490) | [apps/server/src/routes/recovery-collect.ts:122](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L122) | **CONFIRMED** |
| `POST` | `/api/recovery/collect/hub` | [apps/pwa/src/lib/api.ts:1518](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1518) | [apps/server/src/routes/recovery-collect.ts:220](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L220) | **CONFIRMED** |
| `POST` | `/api/recovery/collect/status` | [apps/pwa/src/lib/api.ts:1531](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1531) | [apps/server/src/routes/recovery-collect.ts:184](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L184) | **CONFIRMED** |
| `POST` | `/api/recovery/collect/fragments` | [apps/pwa/src/lib/api.ts:1558](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1558) | [apps/server/src/routes/recovery-collect.ts:197](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L197) | **CONFIRMED** |

There are no invented or non-existent endpoints called in this branch.

### 2. State & Control Fidelity
- **CONFIRMED**: `RecoveryAlertBanner` danger state reflects real open collections via `/api/recovery/collect/mine`. Clicking "🛑 Stop It Now" calls `/api/recovery/collect/cancel` with the exact `collectionId`, terminating the session on the backend.
- **CONFIRMED**: `RecoveryAlertBanner` keeper state reflects real pending releases via `/api/recovery/approve-keeper/pending`. Clicking "Review & Release Piece" opens `IncomingRecoveryApprovalModal`.
- **CONFIRMED**: `KeeperProtectionPanel` accurately displays enrolled keepers from `POST /api/recovery/shares/status`. "Update Keepers" generates and submits a fresh split generation (`POST /api/recovery/shares`); "Reset Keepers" issues `DELETE /api/recovery/shares` with the required confirmation token `delete-my-recovery-keepers`. No controls are inert.

---

## Priority 4: Thresholds and Copy (BLOCKING)

### 1. CONFIRMED BLOCKING BUG: Premature "2 / 2" Progress Display in Friend Recovery
- **File & Line**: [apps/pwa/src/pages/WelcomePage.tsx:1426-1434](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/pages/WelcomePage.tsx#L1426-L1434) and [apps/pwa/src/lib/api.ts:1537-1545](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1537-L1545)
- **Code**:
  ```tsx
  <div style={{ fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--text-muted)', marginBottom: '0.35rem' }}>
      Friend Approvals Collected
  </div>
  <div style={{ fontSize: '2.25rem', fontWeight: 800, color: '#10b981' }}>
      {friendProgress.collected} / 2
  </div>
  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>
      {friendProgress.hubAvailable ? '✅ Community Hub: Piece ready' : '⏳ Community Hub: Checking...'}
  </div>
  ```
- **Mechanism of Failure**:
  1. The server's `collectionProgress(id)` ([apps/server/src/engine/recovery-release.ts:651](file:///Users/marty/projects/bp-parity-c/apps/server/src/engine/recovery-release.ts#L651)) returns:
     - `collected`: `releases.length` (the **total** count of all pieces released across all types: `hub`, `member`, `sso`).
     - `threshold`: `needed` (which is `3` for the friend tier: 1 hub + 2 friends).
     - `releasedTypes`: array of released keeper types, e.g. `['member', 'hub']`.
  2. Under Rule D7 ([apps/server/src/engine/recovery-release.ts:315-325](file:///Users/marty/projects/bp-parity-c/apps/server/src/engine/recovery-release.ts#L315-L325)), as soon as **ONE** human keeper approves, the hub piece unlocks immediately. When `pollFriendRecoveryApi` runs, `/api/recovery/collect/hub` executes and releases the hub piece.
  3. The total releases count (`releases.length`) immediately increments to `2` (1 friend share + 1 hub share).
  4. `pollFriendRecoveryApi` sets `friendProgress.collected = st.collected = 2`.
  5. The UI renders:
     - Header: **`Friend Approvals Collected`**
     - Value: **`2 / 2`**
     - Subtitle: **`✅ Community Hub: Piece ready`**
  6. **User Impact**: The recovering user reads that 2 out of 2 friend approvals have been collected. They believe the required friend quota has been met, so they do **not** call their second friend.
  7. **System State**: The backend requires `3` total pieces (`threshold: 3`, `enough = releases.length >= 3`). Because only 2 pieces exist (1 hub + 1 friend), `enough` remains `false`.
  8. **Failure Mode**: The recovery sits in an indefinite deadlock. The user believes their account is recovering or frozen, when in reality it is waiting for a second friend they will never contact. Furthermore, if a second friend does approve, `friendProgress.collected` becomes `3`, causing the UI to momentarily render `3 / 2`.
- **Required Fix**:
  Either:
  1. Update `pollFriendRecoveryApi` to return `friendApprovals`:
     ```ts
     const friendApprovals = releasedTypes.filter(t => t === 'member').length;
     ```
     and display `{friendProgress.friendApprovals} / 2`.
  2. Or align with native ([apps/native/app/recover-identity.tsx:363](file:///Users/marty/projects/bp-parity-c/apps/native/app/recover-identity.tsx#L363)):
     Label the box **"Pieces Collected"** and render `{friendProgress.collected} / {friendProgress.threshold}` (showing `1 / 3`, `2 / 3`, `3 / 3`).

### 2. Protection Panel & Enrolment Thresholds
- **CONFIRMED**: In [apps/pwa/src/components/KeeperProtectionPanel.tsx:183, 266, 387, 427](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/components/KeeperProtectionPanel.tsx#L183), the copy consistently states:
  > *"No single piece can open your account — it takes the hub plus any 2 friends."*
  > *"Pick at least 2 friends from your community. If you lose this device, call any 2 of them..."*
- **CONFIRMED**: In [apps/pwa/src/lib/api.ts:1247](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1247), `threshold = tier === 'sso' ? TWO_LAYER_THRESHOLD : TWO_LAYER_THRESHOLD + 1;` matches native [apps/native/utils/protection-state.ts:91-94](file:///Users/marty/projects/bp-parity-c/apps/native/utils/protection-state.ts#L91-L94) exactly.
- **CONFIRMED**: Enrolling `< 2` friends is prevented on both client ([apps/pwa/src/components/KeeperProtectionPanel.tsx:361](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/components/KeeperProtectionPanel.tsx#L361)) and API ([apps/pwa/src/lib/api.ts:1434](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1434)).

---

## Priority 5: Polling Behaviour Audit

### 1. CONFIRMED DEFECT: WelcomePage 3-Second Background Polling Lacks Visibility Backoff
- **File & Line**: [apps/pwa/src/pages/WelcomePage.tsx:367-404](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/pages/WelcomePage.tsx#L367-L404)
- **Details**:
  ```ts
  useEffect(() => {
      let interval: any;
      if (recoveryMode === 'friends' && friendStep === 'waiting' && friendCollectionId && friendEphIdentity) {
          const poll = async () => { ... };
          interval = setInterval(poll, 3000);
          poll();
      }
      return () => clearInterval(interval);
  }, [recoveryMode, friendStep, friendCollectionId, friendEphIdentity, friendSelectedProfile, onComplete]);
  ```
  While in `friendStep === 'waiting'`, `poll` executes every 3 seconds. Each tick dispatches **two** signed POST requests:
  1. `POST /api/recovery/collect/hub`
  2. `POST /api/recovery/collect/status`
  There is no check for `document.hidden` and no `visibilitychange` listener.
  If a recovering user switches to their phone dialer or another tab to call their friends, the browser continues hammering the node with 40 requests/minute indefinitely.
- **Contrast with Good Implementation**:
  In [apps/pwa/src/components/RecoveryAlertBanner.tsx:88-104](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/components/RecoveryAlertBanner.tsx#L88-L104), polling properly pauses on `document.hidden` and resumes on foreground.
- **Required Fix**:
  Add `visibilitychange` handling to `WelcomePage.tsx` lines 367-404 so that polling ceases or backs off to a relaxed interval (e.g. 30s) while the tab is hidden.

---

## Priority 6: Small Screens and Themes (320dp, 1.3x Font Scaling, Light & Dark)

### 1. Viewport & Scaling Verification (320dp @ 1.3x)
- **CONFIRMED**:
  - `IncomingRecoveryApprovalModal.tsx`: Uses `fixed inset-0 overflow-y-auto p-4 sm:p-6` with `max-w-md w-full`. Content flows naturally and scrolls vertically on narrow displays or with large fonts without clipping buttons or security notices.
  - `KeeperProtectionPanel.tsx`: Action buttons in line 187 use `flex-wrap gap-2.5`, wrapping gracefully to two lines on 320dp displays. Modal buttons stack vertically (`flex-col sm:flex-row`). The community member selection container uses `max-h-60 overflow-y-auto`.
  - `RecoveryAlertBanner.tsx`: Danger and keeper action buttons specify `w-full sm:w-auto` with `py-2.5 px-5`, fulfilling accessibility minimum touch target requirements (≥44px).

### 2. Light & Dark Themes
- **CONFIRMED**:
  - Components use semantic Tailwind dark variants (`dark:bg-nature-900`, `dark:border-nature-800`, `dark:text-white`, `dark:bg-emerald-950/40`, `dark:border-emerald-800/60`).
  - Inline styled elements in `WelcomePage.tsx` utilize theme CSS variables (`var(--bg-secondary)`, `var(--text-primary)`, `var(--border-primary)`), which resolve to `#fbfaf8` in light mode and `#384038` in dark mode ([apps/pwa/src/index.css:16, 41](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/index.css#L16)).
  - Contrast ratios for security warnings (amber-50/amber-950) and critical alerts (red-50/red-950) meet WCAG AA standards in both modes.

---

## Findings Summary

| Category | File:Line | Classification | Description | Severity |
|---|---|---|---|---|
| **Thresholds & Copy** | [apps/pwa/src/pages/WelcomePage.tsx:1426-1434](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/pages/WelcomePage.tsx#L1426-L1434) | **CONFIRMED** | Premature "Friend Approvals Collected: 2 / 2" rendered after only 1 friend approves because hub piece is counted in `collected`. Causes recovery deadlock. | **BLOCKING** |
| **Thresholds & Copy** | [apps/pwa/src/lib/api.ts:1537-1545](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1537-L1545) | **CONFIRMED** | `pollFriendRecoveryApi` discards `st.releasedTypes`, preventing UI from distinguishing friend approvals from hub release. | **BLOCKING** |
| **Polling Cadence** | [apps/pwa/src/pages/WelcomePage.tsx:367-404](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/pages/WelcomePage.tsx#L367-L404) | **CONFIRMED** | Unthrottled 3-second interval (2 POST requests/tick) runs continuously when tab is hidden. Missing `visibilitychange` pause. | **HIGH** |
| **Server Route Security** | [apps/server/src/routes/recovery-collect.ts:353-411](file:///Users/marty/projects/bp-parity-c/apps/server/src/routes/recovery-collect.ts#L353-L411) | **CONFIRMED** | Verified: strictly authenticated via `requireSignature` + `getMember`, parameter-free, strictly isolated to caller's enrolled obligations, zero sensitive leak. | **PASS** |
| **Crypto Integrity** | [apps/pwa/src/lib/api.ts:1310-1331, 1438, 1580-1624](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1310-L1331) | **CONFIRMED** | Verified: uses `@beanpool/core` primitives, handles PKCS8 & raw seeds via `toEd25519Seed`, throws loudly on tamper or corrupt keys. | **PASS** |
| **UI Honesty** | `apps/pwa/src/` | **CONFIRMED** | Verified: all 20 `/api/` endpoints match real server routes. No dead buttons, unread states, or dummy handlers. | **PASS** |

---

## Required Actions to Unblock Merge

1. **Fix Friend Approvals Count in WelcomePage**:
   In [apps/pwa/src/lib/api.ts:1537-1545](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/lib/api.ts#L1537-L1545), compute and return the friend approval count:
   ```ts
   const releasedTypes = st.releasedTypes || [];
   const friendApprovals = releasedTypes.filter((t: string) => t === 'member').length;

   return {
       collected: st.collected || 0,
       friendApprovals,
       threshold: st.threshold || 3,
       enough: !!st.enough,
       hubAvailable: releasedTypes.includes('hub'),
   };
   ```
   In [apps/pwa/src/pages/WelcomePage.tsx:1429](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/pages/WelcomePage.tsx#L1429), display `{friendProgress.friendApprovals} / 2` (or display total pieces: `{friendProgress.collected} / {friendProgress.threshold}`).
2. **Add Tab Visibility Check to WelcomePage Poller**:
   In [apps/pwa/src/pages/WelcomePage.tsx:367-404](file:///Users/marty/projects/bp-parity-c/apps/pwa/src/pages/WelcomePage.tsx#L367-L404), pause the 3-second interval when `document.hidden` is true and resume when visible, mirroring `RecoveryAlertBanner.tsx`.
