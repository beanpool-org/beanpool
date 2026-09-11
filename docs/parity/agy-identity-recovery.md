# Parity Audit: Identity, Onboarding, Recovery, Security, Settings

> **⚠️ Historical.** Keeper (social/guardian) recovery was scrapped in September 2026.
> This document describes it as live because that was true when it was written.
> The only recovery paths now are the member's 12 words and SSO (native only).
> See [keeper-recovery-parked.md](../keeper-recovery-parked.md).

**Repository**: `beanpool`  
**Scope**: Native client (`apps/native`) vs Web PWA client (`apps/pwa`)  
**Domain**: Identity, Onboarding, Recovery, Security, Settings  
**Date**: September 2026  

---

## Parity table

| Feature | Native (file:line) | PWA (file:line) | Verdict |
| :--- | :--- | :--- | :--- |
| **BIP-39 Mnemonic Generation (12 words)** | `apps/native/utils/crypto.ts:16` | `apps/pwa/src/lib/mnemonic.ts:18` | parity |
| **Ed25519 Key Derivation (Double SHA-256 Seed)** | `apps/native/utils/crypto.ts:32` | `apps/pwa/src/lib/mnemonic.ts:46` | parity |
| **Private Key Storage Format & Representation** | `apps/native/utils/identity.ts:39` | `apps/pwa/src/lib/mnemonic.ts:95` | divergent |
| **Storage Medium & Hardware Keystore Security** | `apps/native/utils/identity.ts:4` | `apps/pwa/src/lib/identity.ts:15` | divergent |
| **Identity Reset & Local Storage Wipe** | `apps/native/utils/identity.ts:114` | `apps/pwa/src/lib/identity.ts:74` | parity |
| **Welcome / Onboarding Landing Screen** | `apps/native/app/welcome.tsx:72` | `apps/pwa/src/pages/WelcomePage.tsx:187` | parity |
| **Profile Setup Wizard (Callsign & Avatar)** | `apps/native/app/profile-setup.tsx:27` | `apps/pwa/src/components/ProfileSetup.tsx:32` | parity |
| **Callsign Live Availability & Suffix Suggestions** | `apps/native/utils/callsign-suggest.ts:33` | None | native-only |
| **12-Word Seed Phrase Account Restoration** | `apps/native/app/welcome.tsx:81` | `apps/pwa/src/pages/WelcomePage.tsx:610` | parity |
| **QR Device Pairing (Receiver / QR Display)** | None | `apps/pwa/src/pages/WelcomePage.tsx:246` | PWA-only |
| **QR Device Pairing (Sender / Scanner)** | `apps/native/app/pair-device.tsx:37` | None | native-only |
| **Two-Layer Shamir Secret Sharing Scheme** | `apps/native/utils/keeper-enrolment.ts:148` | None | native-only |
| **SSO Recovery Enrolment (Google/Apple OAuth Share)**| `apps/native/utils/keeper-enrolment.ts:210` | None | native-only |
| **Friend Keepers Enrolment (Peer Node Shares)** | `apps/native/utils/keeper-enrolment.ts:360` | None | native-only |
| **SSO Account Recovery Flow (OAuth Unwrap)** | `apps/native/utils/sso-recovery.ts:40` | None | native-only |
| **SSO Candidate Account Auto-Discovery** | `apps/native/app/welcome.tsx:114` | None | native-only |
| **Friend Keeper Fragment Collection & Reconstruction**| `apps/native/utils/friend-recovery.ts:50` | None | native-only |
| **Incoming Keeper Approval Modal & Push Prompt** | `apps/native/components/IncomingRecoveryApprovalModal.tsx:30` | None | native-only |
| **Account-Under-Recovery Alert Banner** | `apps/native/components/RecoveryAlertBanner.tsx:25` | None | native-only |
| **Recovery PIN Protection (Hub Share Unlock)** | `apps/native/utils/pin.ts:35` | None | native-only |
| **Legacy Social Recovery (Applicant Request Flow)** | None | `apps/pwa/src/pages/WelcomePage.tsx:369` | PWA-only |
| **Legacy Social Recovery (Guardian Approval in Settings)** | `apps/native/app/(tabs)/settings.tsx:878` | `apps/pwa/src/pages/SettingsPage.tsx:184` | parity |
| **Biometric & OS PIN Lock (Local Authentication)** | `apps/native/utils/LocalAuth.ts:10` | None | native-only |
| **Node Mismatch Interceptor & Migration Screen** | `apps/native/app/node-mismatch.tsx:20` | None | native-only |
| **Push Notification Token Lifecycle Management** | `apps/native/services/notifications.ts:25` | None | native-only |
| **Ed25519 Network Request Signing** | `apps/native/utils/crypto.ts:74` | `apps/pwa/src/lib/crypto.ts:48` | parity |
| **Profile Editing in Settings** | `apps/native/app/(tabs)/settings.tsx:512` | `apps/pwa/src/pages/SettingsPage.tsx:248` | parity |
| **Seed Phrase Reveal / Backup in Settings** | `apps/native/app/(tabs)/settings.tsx:750` | `apps/pwa/src/pages/SettingsPage.tsx:310` | parity |
| **Node Connection Switching & Testing in Settings** | `apps/native/app/(tabs)/settings.tsx:380` | `apps/pwa/src/pages/SettingsPage.tsx:142` | parity |
| **Node Diagnostic Statistics Display** | None | `apps/pwa/src/pages/SettingsPage.tsx:165` | PWA-only |
| **Appearance & Theme Configuration** | `apps/native/app/(tabs)/settings.tsx:615` | `apps/pwa/src/pages/SettingsPage.tsx:295` | parity |
| **Application Version & Build Info Display** | `apps/native/app/(tabs)/settings.tsx:820` | `apps/pwa/src/pages/SettingsPage.tsx:380` | parity |

---

### Divergences

- **Private Key Storage Format & Representation**: Native stores the raw 32-byte Ed25519 seed as a 64-character hex string, whereas PWA serialises the private key into a 48-byte PKCS8 ASN.1 DER envelope stored as a 96-character hex string.
- **Storage Medium & Hardware Keystore Security**: Native persists credentials in hardware-backed platform keychains (`expo-secure-store`) gated by OS biometrics, whereas PWA stores private keys unencrypted in browser IndexedDB (`localforage`).

---

## HIGH severity

### 1. Silent Keeper Enrolment Failure on Transferred/Imported Identities (48-Byte PKCS8 Key)
- **What breaks**: When a user creates an account on PWA and subsequently transfers it to Native via QR Device Pairing (or imports a PKCS8-formatted key), Keeper Enrolment (`enrolSsoKeeper` and `enrolFriendKeepers`) fails silently and cannot protect the account.
- **For whom**: Any member who pairs an identity from PWA to Native and then attempts to set up Two-Layer Social/Keeper Protection or SSO Recovery.
- **File:line proof**:
  - In `apps/pwa/src/lib/mnemonic.ts:95` and `apps/pwa/src/lib/identity.ts:42`, PWA exports and stores keys as 48-byte PKCS8 hex strings (96 characters).
  - During device pairing, Native receives this 48-byte key verbatim via `apps/native/app/pair-device.tsx:132` and stores it via `saveIdentity` in `apps/native/utils/identity.ts:39`.
  - When the user tries to enrol keepers, `apps/native/utils/keeper-enrolment.ts:218-221` executes:
    ```ts
    const seed = hexToBytes(identity.privateKey);
    if (seed.length !== 32) {
        return nothing(`enrolSsoKeeper: private key is ${seed.length} bytes, expected 32`);
    }
    ```
  - Identically, `apps/native/utils/keeper-enrolment.ts:370-373` asserts:
    ```ts
    const seed = hexToBytes(identity.privateKey);
    if (seed.length !== 32) {
        return nothing(`enrolFriendKeepers: private key is ${seed.length} bytes, expected 32`);
    }
    ```
  - While core helper `packages/beanpool-core/src/ed25519-key.ts:16` provides `toEd25519Seed()` specifically to normalise 48-byte PKCS8 keys back to 32-byte seeds, `keeper-enrolment.ts` bypasses it, causing immediate rejection.

---

### 2. Cross-Device Pairing Deadlock (Unidirectional Pairing Pipeline)
- **What breaks**: Device pairing via QR code is completely asymmetric and unidirectional. PWA can only act as a receiver/display (generating session QRs), and Native can only act as a sender/scanner (reading QRs via camera). Users cannot pair Native-to-PWA (exporting an existing mobile account to web), Native-to-Native (phone to tablet), or PWA-to-PWA (desktop to laptop).
- **For whom**: All users attempting to mirror an existing Native account to a web browser, or migrate between two phones.
- **File:line proof**:
  - `apps/pwa/src/pages/WelcomePage.tsx:246-335`: Implements receiver flow only. It calls `initPairingApi` (`POST /api/pair/init`), renders the QR code canvas, and continuously polls `pollPairingApi` (`GET /api/pair/poll`). PWA contains no camera scanner or QR parsing logic.
  - `apps/native/app/pair-device.tsx:37-145`: Implements sender flow only. It activates the camera, scans the QR code payload, encrypts the local identity, and posts to `/api/pair/transfer`. Native has no UI or logic to display a pairing QR code or poll for incoming identities.

---

### 3. PWA Keeper Black Hole (Permanent Loss of Keeper Approvals)
- **What breaks**: When a Native user selects trusted friends as their recovery keepers, any friend using the PWA client becomes an unresponsive "black hole". The PWA client lacks the approval UI, background event listener, and API integration necessary to release held recovery fragments. If enough chosen keepers are PWA users, the 2-of-3 threshold can never be reached, leaving the recovering member permanently locked out.
- **For whom**: Native users recovering their account whose selected keepers include community members using the web PWA.
- **File:line proof**:
  - Native Enrolment (`apps/native/utils/keeper-enrolment.ts:380`): Allows designating any active node member as a keeper.
  - Native Approval UI (`apps/native/components/IncomingRecoveryApprovalModal.tsx:30-100`): Listens for recovery events and calls `POST /api/recovery/approve-keeper` with the decrypted fragment.
  - PWA Codebase: Zero matches for `approve-keeper` or `IncomingRecoveryApprovalModal` across `apps/pwa/src/`. PWA provides neither notifications nor UI actions to view or approve pending keeper requests.

---

### 4. Browser IndexedDB Unencrypted Key Storage & Lack of Secondary Authentication
- **What breaks**: In PWA, the Ed25519 private key is persisted unencrypted in browser IndexedDB without hardware keystore backing or OS-level authorization gates. Anyone with physical access to the device or malicious browser extensions with domain permissions can extract the private key. In Native, private keys are protected in OS SecureStore and protected by biometric/PIN locks.
- **For whom**: All PWA users accessing BeanPool on shared computers, work laptops, or browsers with untrusted extensions.
- **File:line proof**:
  - `apps/pwa/src/lib/identity.ts:42`: Persists raw identity object directly to IndexedDB:
    `await localforage.setItem(KEY_IDENTITY, identity);`.
  - `apps/native/utils/identity.ts:39`: Persists to platform keystore via `SecureStore.setItemAsync(KEY_IDENTITY_PRIVATE_KEY, identity.privateKey, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK })`.
  - `apps/native/utils/LocalAuth.ts:10`: Enforces biometric (`expo-local-authentication`) and passcode checks on startup and settings. PWA has no WebAuthn or secondary passcode implementation.

---

### 5. Architectural Split-Brain in Account Recovery Mechanisms
- **What breaks**: Native and PWA implement two entirely disjoint social recovery paradigms. Native has deprecated the legacy social recovery applicant UI in favor of Two-Layer Shamir Secret Sharing (Keepers + SSO), but retains the legacy guardian approval modal in Settings. PWA implements *only* the legacy social recovery applicant flow (`POST /api/recovery/request`) and has no support for Shamir shares or SSO recovery. An account set up on one client cannot be recovered using the other client's recovery workflow.
- **For whom**: Users trying to recover an account when switching between Native and PWA platforms.
- **File:line proof**:
  - Native Welcome UI (`apps/native/app/welcome.tsx:77`): Offers only 12-word seed restore (`mode === 'recover'`) and SSO recovery (`mode === 'ssoRecover'`). Zero UI exists to initiate legacy guardian recovery.
  - PWA Welcome UI (`apps/pwa/src/pages/WelcomePage.tsx:369-420`): Implements legacy applicant flow via `/api/recovery/lookup` and `/api/recovery/request`. Contains zero code for Shamir fragment collection, PIN verification, or SSO OAuth unwrap.

---

## Built but unreachable

1. **`transferPairingApi` in PWA Client**
   - **Location**: `apps/pwa/src/lib/api.ts:1131-1143`
   - **Proof**: Exported function `transferPairingApi(sessionId, mobilePubHex, nonceHex, ciphertextHex)` targets `POST /api/pair/transfer`. A ripgrep search across the entire `apps/pwa/` directory yields 0 usages outside its own definition. PWA never acts as a sender/transferrer in device pairing.

2. **`createRecoveryRequest` in Native Client**
   - **Location**: `apps/native/utils/db.ts:4226-4242`
   - **Proof**: Exported function `createRecoveryRequest(oldPubkey, guardianGuess, newIdentity)` targets `POST /api/recovery/request`. A ripgrep search across `apps/native/` yields 0 UI callers (only one reference exists in a descriptive code comment in `apps/native/app/_layout.tsx:519`). Native provides no screen or flow for members to initiate legacy recovery.

3. **`cancelRecoveryRequest` in Native Client**
   - **Location**: `apps/native/utils/db.ts:4281-4300`
   - **Proof**: Exported function `cancelRecoveryRequest(requestId, identityToUse)` targets `POST /api/recovery/cancel`. A ripgrep search across `apps/native/` yields 0 callers.

---

## Endpoints

### Native-only endpoints (in this domain)
- `GET /api/members/callsign-available/:callsign` (real-time callsign availability & suffix suggestion)
- `GET /api/recovery/sso/candidates` (discovery of SSO recovery candidates matching callsign prefix)
- `POST /api/recovery/sso-nonce` (challenge nonce generation for SSO recovery)
- `POST /api/recovery/shares/sso` (registration of encrypted SSO keeper share)
- `POST /api/recovery/shares` (registration of encrypted peer friend keeper shares)
- `POST /api/recovery/shares/status` (querying active Shamir protection tier and status)
- `DELETE /api/recovery/shares` (revocation of keeper protection)
- `POST /api/recovery/collect` (initiation of fragment collection session)
- `POST /api/recovery/collect/status` (polling status of gathered keeper fragments)
- `POST /api/recovery/collect/fragments` (downloading approved keeper fragments)
- `GET /api/recovery/collect/approval-context` (fetching requester metadata for keeper approval modal)
- `POST /api/recovery/approve-keeper` (keeper submitting decrypted fragment for peer recovery)
- `POST /api/recovery/collect/sso-nonce` (requesting OAuth verification challenge nonce)
- `POST /api/recovery/collect/sso` (submitting OAuth id token to unlock SSO fragment)
- `POST /api/recovery/collect/hub` (requesting node hub-held fragment)
- `POST /api/recovery/pin/status` (checking whether a recovery PIN is configured)
- `POST /api/recovery/pin/set` (setting argon2-hashed recovery PIN)
- `POST /api/recovery/pin/verify` (verifying recovery PIN to unlock hub-held fragment)
- `POST /api/pair/transfer` (sender transmitting encrypted identity payload to pairing session)
- `DELETE /api/push-tokens` (deregistering push notification device token upon signout)

### PWA-only endpoints (in this domain)
- `POST /api/pair/init` (initiating QR code pairing session for desktop receiver)
- `GET /api/pair/poll` (long-polling endpoint awaiting paired credentials from mobile sender)
- `POST /api/pair/cancel` (cancelling active desktop pairing session)
- `POST /api/recovery/request` (submitting legacy social recovery request with guardian guess)
- `GET /api/stats` (fetching node statistics: total members, posts, and transactions)

---

## Coverage gaps

- **Server-Side Federation & Multi-Node Recovery**: The audit focused on single-node authentication and recovery interactions; cross-node federation of recovery shares and sync between remote hubs was not deeply evaluated.
- **Server Push Notification Dispatch**: Server-side push notification dispatch logic in `apps/server/src/push-dispatcher.ts` was verified for token handling, but background APNS/FCM delivery reliability was not tested.
- **WebAuthn / Passkey Feasibility**: Analyzed PWA's existing storage model, but did not prototype WebAuthn PRF (Pseudo-Random Function) extension feasibility for hardware-backed web key storage.
- **Offline SQLite Migration Lifecycle**: `apps/native/utils/db.ts` schema migrations outside identity and recovery tables were excluded from this domain audit.
