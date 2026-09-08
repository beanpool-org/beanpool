# Native vs PWA Parity Audit: Verification Report

This document verifies eight audit claims comparing the native mobile app (`apps/native`) and the progressive web app (`apps/pwa`).

---

### 1. Device Pairing Unidirectionality and Migration Feasibility

- **Verdict:** PARTLY (Unidirectional pairing is CONFIRMED; conclusion that native-to-web migration is impossible is REFUTED)
- **Evidence:**
  - **PWA (Display & Poll only):** In [apps/pwa/src/pages/WelcomePage.tsx:246-255](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/WelcomePage.tsx#L246-L255), `handleStartQrPairing()` invokes `createPairingSession()` and `initPairingApi()`; lines [1533-1540](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/WelcomePage.tsx#L1533-L1540) display `<QRCodeSVG value={`beanpool://pair?session=${...}`} />`; lines [286-305](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/WelcomePage.tsx#L286-L305) poll `pollPairingApi()` and decrypt the received payload. PWA has no barcode/QR scanner (`apps/pwa/package.json` contains no scanner dependencies; camera inputs at [WelcomePage.tsx:345](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/WelcomePage.tsx#L345) and [ProfilePage.tsx:29](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/ProfilePage.tsx#L29) are solely `<input type="file" capture="environment">` for avatars). The helper `transferPairingApi` in [apps/pwa/src/lib/api.ts:1131](file:///Users/marty/projects/beanpool/apps/pwa/src/lib/api.ts#L1131) is never called in `apps/pwa`.
  - **Native (Scan & Transfer only):** In [apps/native/app/pair-device.tsx:455-461](file:///Users/marty/projects/beanpool/apps/native/app/pair-device.tsx#L455-L461), `CameraView` scans the QR; lines [361-372](file:///Users/marty/projects/beanpool/apps/native/app/pair-device.tsx#L361-L372) encrypt the identity and POST to `/api/pair/transfer`. Native contains no pairing QR display or polling routines (`/api/pair/init` and `/api/pair/poll` do not exist in `apps/native`).
  - **Directionality:** Phone-to-phone, web-to-web, and web-to-phone migrations are impossible because neither phone can display a pairing QR/poll, and web cannot scan/transfer. However, **native-to-web migration is fully implemented and works** (phone scans web QR and transfers identity to web).
- **If CONFIRMED, the smallest fix:** Correct audit documentation stating native-to-web is impossible to specify web-to-native, and add a pairing QR display/polling screen to native and a QR scanner/input to the PWA if full bidirectional pairing is needed.

---

### 2. Private Key Persistence and Gating (IndexedDB vs SecureStore)

- **Verdict:** PARTLY (Unencrypted storage and absence of biometric/passcode gating on PWA are CONFIRMED; claim of `localforage` usage is REFUTED)
- **Evidence:**
  - **PWA Storage & Lack of Gating:** [apps/pwa/src/lib/identity.ts:23-32](file:///Users/marty/projects/beanpool/apps/pwa/src/lib/identity.ts#L23-L32) and lines [166-175](file:///Users/marty/projects/beanpool/apps/pwa/src/lib/identity.ts#L166-L175) use raw browser `indexedDB.open('beanpool-identity', 1)` directly (`store.put(identity, KEY_ID)`), NOT `localforage` (`localforage` is not in `apps/pwa/package.json` or imported anywhere in `apps/pwa`). In lines [99-107](file:///Users/marty/projects/beanpool/apps/pwa/src/lib/identity.ts#L99-L107), `privateKey` and `mnemonic` are stored as plaintext hex/string arrays in IndexedDB. There are no calls to WebAuthn (`navigator.credentials`), PIN prompts, or biometric gates anywhere in `apps/pwa`.
  - **Native Storage & Gating:** [apps/native/utils/identity.ts:1, 39, 147](file:///Users/marty/projects/beanpool/apps/native/utils/identity.ts#L1) persists the identity via `expo-secure-store` (`SecureStore.getItemAsync` / `setItemAsync`). [apps/native/utils/LocalAuth.ts:1, 38-60](file:///Users/marty/projects/beanpool/apps/native/utils/LocalAuth.ts#L1) gates app launch, phrase reveal, and sign-out behind `expo-local-authentication` (`LocalAuthentication.authenticateAsync`).
  - **Browser Inherent vs Unimplemented:** The browser sandbox inherently lacks a transparent OS keychain/Secure Enclave synchronous API, making standard IndexedDB unencrypted at rest on disk. However, client-side encryption-at-rest (e.g. WebCrypto AES-GCM via passphrase or WebAuthn PRF extension) and WebAuthn biometric gating are standard browser capabilities that are simply unimplemented in BeanPool PWA.
- **If CONFIRMED, the smallest fix:** Correct documentation to cite `indexedDB` rather than `localforage`, and implement a WebCrypto AES-GCM vault with password/WebAuthn gating prior to writing identity records to IndexedDB.

---

### 3. Disjoint Recovery Paradigms Across Native and PWA

- **Verdict:** REFUTED
- **Evidence:**
  - **PWA Mnemonic Recovery:** [apps/pwa/src/pages/WelcomePage.tsx:200](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/WelcomePage.tsx#L200) sets `recoveryMode` between `'words'` and `'social'`; lines [626-655](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/WelcomePage.tsx#L626-L655) and lines [1364-1450](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/WelcomePage.tsx#L1364-L1450) ("Recover with 12 Words") execute `createIdentityFromMnemonic(words, callsign)` ([apps/pwa/src/lib/identity.ts:115-128](file:///Users/marty/projects/beanpool/apps/pwa/src/lib/identity.ts#L115-L128)). PWA does NOT only offer legacy guardian request flow.
  - **Native Mnemonic Recovery:** [apps/native/app/welcome.tsx:709](file:///Users/marty/projects/beanpool/apps/native/app/welcome.tsx#L709) executes `createIdentityFromMnemonic(words, callsign)` ([apps/native/utils/identity.ts:109-122](file:///Users/marty/projects/beanpool/apps/native/utils/identity.ts#L109-L122)).
  - **Cryptographic Compatibility:** Both native ([apps/native/utils/crypto.ts:158-174](file:///Users/marty/projects/beanpool/apps/native/utils/crypto.ts#L158-L174)) and PWA ([apps/pwa/src/lib/mnemonic.ts:56-97](file:///Users/marty/projects/beanpool/apps/pwa/src/lib/mnemonic.ts#L56-L97)) derive the 32-byte Ed25519 seed identically using double SHA-256 (`seed = sha256(sha256(phraseBytes))`). Interoperability between native raw seed and WebCrypto PKCS8 is unified via `toEd25519Pkcs8` in [packages/beanpool-core/src/ed25519-key.ts:1-33](file:///Users/marty/projects/beanpool/packages/beanpool-core/src/ed25519-key.ts#L1-L33).
  - **Bidirectional Recovery:** An account created on Native can be restored on PWA via its 12 words, and an account created on PWA can be restored on Native via its 12 words. While secondary recovery flows differ (PWA initiates legacy guardian requests via [apps/pwa/src/lib/api.ts:1065](file:///Users/marty/projects/beanpool/apps/pwa/src/lib/api.ts#L1065) while Native implements Two-Layer Shamir friend recovery in [apps/native/utils/friend-recovery.ts:1-245](file:///Users/marty/projects/beanpool/apps/native/utils/friend-recovery.ts#L1-L245)), the primary sovereign recovery paradigm is identical and bidirectional.

---

### 4. WebSocket Reconnection Strategy and Keep-Alive Pings

- **Verdict:** CONFIRMED
- **Evidence:**
  - **PWA Reconnect & Ping:** [apps/pwa/src/lib/sync.ts:21](file:///Users/marty/projects/beanpool/apps/pwa/src/lib/sync.ts#L21) defines `const RECONNECT_INTERVAL = 5000;`. Reconnection is handled at lines [124-126](file:///Users/marty/projects/beanpool/apps/pwa/src/lib/sync.ts#L124-L126):
    ```ts
    function scheduleReconnect(url: string): void {
        setTimeout(() => connectToAnchor(url), RECONNECT_INTERVAL);
    }
    ```
    There is no `setInterval`, ping message, or keep-alive heartbeat in `apps/pwa/src/lib/sync.ts`.
  - **Native Reconnect & Ping:** [apps/native/services/ws-client.ts:127-135](file:///Users/marty/projects/beanpool/apps/native/services/ws-client.ts#L127-L135) implements 30-second keep-alive pings:
    ```ts
    if (this.pingIntervalId) clearInterval(this.pingIntervalId);
    this.pingIntervalId = setInterval(() => {
        if (this.ws === socket && socket.readyState === WebSocket.OPEN) {
            try {
                socket.send(JSON.stringify({ type: 'ping' }));
            } catch (err) {
                console.warn('[WS Sync] Failed to send heartbeat', err);
            }
        }
    }, 30000);
    ```
    Lines [211-224](file:///Users/marty/projects/beanpool/apps/native/services/ws-client.ts#L211-L224) implement exponential backoff with random jitter capped at 30 seconds:
    ```ts
    private scheduleReconnect() {
        if (!this.isStarted || AppState.currentState !== 'active') return;
        if (this.reconnectTimeoutId) return;

        const jitter = Math.random() * 1000;
        const delay = this.reconnectDelay + jitter;
        console.log(`[WS Sync] Scheduling reconnect in ${(delay / 1000).toFixed(1)}s`);

        this.reconnectTimeoutId = setTimeout(() => {
            this.reconnectTimeoutId = null;
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
            this.connect();
        }, delay);
    }
    ```
- **If CONFIRMED, the smallest fix:** In `apps/pwa/src/lib/sync.ts`, replace the fixed `RECONNECT_INTERVAL` with exponential backoff delay and jitter, and send `{ type: 'ping' }` over an active `WebSocket` every 30 seconds.

---

### 5. Guardian Recovery Majority Copy vs RECOVERY_THRESHOLD

- **Verdict:** PARTLY (Copy mismatch in `GuardianInfoModal.tsx` and `RECOVERY_THRESHOLD = 3` are CONFIRMED; existence of code paths allowing 2 is CONFIRMED, refuting that no path allows 2)
- **Evidence:**
  - **Modal Copy:** [apps/native/components/info-content/GuardianInfoModal.tsx:157](file:///Users/marty/projects/beanpool/apps/native/components/info-content/GuardianInfoModal.tsx#L157) states:
    `<ListItem prefix="4.">If a <Text style={styles.boldWhiteText}>majority</Text> (e.g., <Text style={styles.boldWhiteText}>2 out of 3</Text>, or <Text style={styles.boldWhiteText}>3 out of 5</Text>) of your Guardians approve your recovery request, your account is restored!</ListItem>`
  - **Phrase Split Threshold:** In [packages/beanpool-core/src/recovery-split.ts:64](file:///Users/marty/projects/beanpool/packages/beanpool-core/src/recovery-split.ts#L64), `export const RECOVERY_THRESHOLD = 3;`. Lines [192-196](file:///Users/marty/projects/beanpool/packages/beanpool-core/src/recovery-split.ts#L192-L196) throw `RecoveryCombineError` if `shares.length < RECOVERY_THRESHOLD`. Legacy server requests also enforce `quorum_required = 3` ([apps/server/src/state-engine.ts:2101](file:///Users/marty/projects/beanpool/apps/server/src/state-engine.ts#L2101)).
  - **Code Paths Allowing 2:** [packages/beanpool-core/src/two-layer-split.ts:63](file:///Users/marty/projects/beanpool/packages/beanpool-core/src/two-layer-split.ts#L63) defines `export const TWO_LAYER_THRESHOLD = 2;`. In [apps/native/utils/friend-recovery.ts:204-205](file:///Users/marty/projects/beanpool/apps/native/utils/friend-recovery.ts#L204-L205), friend approvals require `TWO_LAYER_THRESHOLD` (2 friend shares combined with the mandatory hub piece A). SSO recovery in [apps/native/utils/sso-recovery.ts:25-27](file:///Users/marty/projects/beanpool/apps/native/utils/sso-recovery.ts#L25-L27) similarly reconstructs from 1 SSO share + 1 hub share.
- **If CONFIRMED, the smallest fix:** Update [apps/native/components/info-content/GuardianInfoModal.tsx:157](file:///Users/marty/projects/beanpool/apps/native/components/info-content/GuardianInfoModal.tsx#L157) to remove the misleading majority math example and accurately explain that friend recovery requires 2 friend approvals alongside the community node's hub share.

---

### 6. Newcomer Credit Floor and Welcome Voucher (-20 vs 0)

- **Verdict:** CONFIRMED (PWA is wrong; no -20 welcome allowance exists in server execution logic)
- **Evidence:**
  - **PWA Claim:** [apps/pwa/src/pages/LedgerPage.tsx:26-27](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/LedgerPage.tsx#L26-L27):
    `{ name: 'Newcomer', emoji: '🌱', ..., min: 0, floor: -20, blurb: "Welcome. From day one you can browse, trade, receive credits and invite others — a small welcome voucher gets you moving.", ... }`
  - **Native Claim:** [apps/native/app/(tabs)/ledger.tsx:59-60](file:///Users/marty/projects/beanpool/apps/native/app/%28tabs%29/ledger.tsx#L59-L60):
    `{ name: 'Newcomer', emoji: '🌱', ..., min: 0, floor: 0, blurb: "Welcome. From day one you can browse, trade, receive credits and invite others — your first completed trade (or a community vouch) opens your credit line.", ... }`
  - **Canonical Protocol Constant:** [packages/beanpool-core/src/protocol.ts:23](file:///Users/marty/projects/beanpool/packages/beanpool-core/src/protocol.ts#L23) sets `CREDIT_BASE_FLOOR: 0`.
  - **Server Floor Computation:** [packages/beanpool-engine/src/trust.ts:406-414](file:///Users/marty/projects/beanpool/packages/beanpool-engine/src/trust.ts#L406-L414):
    ```ts
    const activated = elderVouched || grantedCredit > 0 || earnedCredit > 0 || isTreasury;
    const effectiveGranted = isTreasury ? Math.max(200, grantedCredit) : grantedCredit;
    const allowance = (activated && !isCreditFrozen)
        ? Math.min(c.CREDIT_FLOOR_CAP, vouchCredit + earnedCredit + effectiveGranted)
        : 0;
    const floor = c.CREDIT_BASE_FLOOR - allowance;
    ```
    For an unactivated newcomer, `allowance = 0` and `floor = 0`. When activated via vouching, `vouchCredit` is 25, 50, or 100 (`VOUCH_CREDIT_LIGHT: 25`, [protocol.ts:28](file:///Users/marty/projects/beanpool/packages/beanpool-core/src/protocol.ts#L28)). When activated via trade, `allowance = earnedCredit` from `earnedCreditFromValue(value)`.
  - **Absence of Welcome Allowance:** There is no 20-bean voucher or welcome allowance in runtime calculations anywhere in `apps/server` or `packages/beanpool-engine`; references to a -20 voucher exist only in historical comments and superseded design documents.
- **If CONFIRMED, the smallest fix:** In [apps/pwa/src/pages/LedgerPage.tsx:26-27](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/LedgerPage.tsx#L26-L27), change Newcomer `floor: -20` to `floor: 0` and update the blurb to match native's text.

---

### 7. Balance Floor 3-Month Inactivity Suspension Warning

- **Verdict:** CONFIRMED (The modal copy is fiction; nothing in the server enforces it)
- **Evidence:**
  - **Modal Copy:** [apps/native/components/info-content/BalanceInfoModal.tsx:197-198](file:///Users/marty/projects/beanpool/apps/native/components/info-content/BalanceInfoModal.tsx#L197-L198) warns:
    `<Text style={styles.warningText}>Members who stay at their maximum floor balance for <Text style={styles.boldWhiteText}>over 3 months</Text> without active trading may face <Text style={styles.boldWhiteText}>account suspension</Text>.</Text>`
  - **Server Audit:**
    - Suspension in `apps/server/src/state-engine.ts:2419` is triggered solely when a moderator actions a report with `suspendUser: true` ([apps/server/src/routes/admin.ts:549](file:///Users/marty/projects/beanpool/apps/server/src/routes/admin.ts#L549)), or manually via `adminSetUserStatus` ([state-engine.ts:2813](file:///Users/marty/projects/beanpool/apps/server/src/state-engine.ts#L2813)).
    - Recurring server intervals in [apps/server/src/state-engine.ts:381-451](file:///Users/marty/projects/beanpool/apps/server/src/state-engine.ts#L381-L451) handle demurrage persistence, ledger audits, Sybil metrics, and marketplace escrow hygiene.
    - There are no cron jobs, database queries, timers, or logic anywhere in `apps/server` or `packages/beanpool-engine` tracking floor balance duration or applying suspensions for inactivity.
- **If CONFIRMED, the smallest fix:** Remove the warning box at [apps/native/components/info-content/BalanceInfoModal.tsx:194-199](file:///Users/marty/projects/beanpool/apps/native/components/info-content/BalanceInfoModal.tsx#L194-L199) or reword it to describe mutual credit community expectations without threatening non-existent automated suspensions.

---

### 8. Native Group-Conversation Dead Code

- **Verdict:** CONFIRMED
- **Evidence:**
  - **Function Signature:** [apps/native/utils/db.ts:3111](file:///Users/marty/projects/beanpool/apps/native/utils/db.ts#L3111):
    `export async function createConversationApi(type: 'dm' | 'group', participants: string[], createdBy: string, name?: string, postId?: string): Promise<any>`
  - **All Native Callers:** Every single call site in `apps/native` passes `'dm'`:
    1. [apps/native/app/new-message.tsx:236](file:///Users/marty/projects/beanpool/apps/native/app/new-message.tsx#L236): `await createConversationApi('dm', [identity.publicKey, pubkey], identity.publicKey);`
    2. [apps/native/app/(tabs)/people.tsx:721](file:///Users/marty/projects/beanpool/apps/native/app/%28tabs%29/people.tsx#L721): `await createConversationApi('dm', [identity.publicKey, item.publicKey], identity.publicKey);`
    3. [apps/native/app/post/[id].tsx:735](file:///Users/marty/projects/beanpool/apps/native/app/post/%5Bid%5D.tsx#L735): `await createConversationApi('dm', [peerPubkey, identity.publicKey], identity.publicKey, undefined, post.id);`
    4. [apps/native/app/post/[id].tsx:763](file:///Users/marty/projects/beanpool/apps/native/app/post/%5Bid%5D.tsx#L763): `await createConversationApi('dm', [peerPubkey, identity.publicKey], identity.publicKey, rejectMessage.trim(), post.id);`
    5. [apps/native/app/post/[id].tsx:1020](file:///Users/marty/projects/beanpool/apps/native/app/post/%5Bid%5D.tsx#L1020): `await createConversationApi('dm', [targetPeerPubkey, identity.publicKey], identity.publicKey, undefined, post.id);`
    6. [apps/native/app/post/[id].tsx:1301](file:///Users/marty/projects/beanpool/apps/native/app/post/%5Bid%5D.tsx#L1301): `await createConversationApi('dm', [post.author_pubkey, identity.publicKey], identity.publicKey, undefined, post.id);`
    7. [apps/native/app/post/[id].tsx:1398](file:///Users/marty/projects/beanpool/apps/native/app/post/%5Bid%5D.tsx#L1398): `await createConversationApi('dm', [reqPubkey, identity.publicKey], identity.publicKey, undefined, post.id);`
    8. [apps/native/app/post/[id].tsx:1432](file:///Users/marty/projects/beanpool/apps/native/app/post/%5Bid%5D.tsx#L1432): `await createConversationApi('dm', [targetPeerPubkey, identity.publicKey], identity.publicKey, undefined, post.id);`
  - (In contrast, PWA explicitly invokes `'group'` at [apps/pwa/src/pages/MessagesPage.tsx:290](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/MessagesPage.tsx#L290)).
- **If CONFIRMED, the smallest fix:** Either narrow the parameter type in [apps/native/utils/db.ts:3111](file:///Users/marty/projects/beanpool/apps/native/utils/db.ts#L3111) to `type: 'dm'`, or add a group creation interface in `new-message.tsx` that invokes `createConversationApi('group', ...)`.
