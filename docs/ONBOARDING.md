# Onboarding UX Redesign

> **Status**: Design — not yet implemented  
> **Goal**: Reduce onboarding friction for non-technical users while preserving full sovereignty for users who want it.

---

## Problem Statement

The current onboarding flow asks every user to:

1. Obtain and enter an invite code (`BP-xxx`)
2. Know their community node URL
3. Choose a name and avatar
4. **Understand and back up a 12-word seed phrase** (blocking step — must tick "I've saved these words")
5. Read how mutual credit works

Steps 1–3 and 5 are reasonable. Step 4 is the problem: it's intimidating, confusing, and most non-technical users tick the checkbox without actually saving their words — then lose their account when their phone breaks.

Meanwhile, technically-minded users who *want* self-custodied keys and full control shouldn't be funnelled into an SSO flow that wraps their identity in someone else's infrastructure.

**The redesign serves both audiences with a single coherent system.**

---

## Design Principles

1. **Zero-friction by default** — a non-technical user should be able to join BeanPool and be fully protected without ever seeing a seed phrase, understanding cryptography, or trusting a big-tech account.
2. **Sovereignty always available** — a technically-minded user can opt into full self-custody at any point, no gates.
3. **Your community is your backup** — recovery should feel social ("my friends can help me") not technical ("I need to find 12 words I wrote down 2 years ago").
4. **Layered resilience** — no single point of failure. Multiple independent recovery paths stack silently.
5. **Same Ed25519 protocol underneath** — SSO and seed backup changes are UX layers. The core identity model (Ed25519 keypair, signed request headers, node-held public keys) does not change.
6. **Relatable, Zero-Jargon Voice** — every screen, prompt, and tip must read like a message from a friend. No crypto/tech jargon ("mnemonic", "Ed25519", "DID", "asymmetric key", "node anchor"). Written so any 21-year-old or everyday community member instantly gets it.

---

## Part 1: Unified Onboarding Flow with Account Protection Chooser

The core design change: **everyone walks the same path** through invite → name → avatar. The SSO/sovereign choice appears *after* the user is already welcomed into their community, replacing the old seed phrase screen with a multi-option "Protect Your Account" chooser.

This is better than a dual-path welcome screen because:
- The invite + name + avatar steps are identical regardless of backup method
- The user makes the SSO/sovereign decision at the moment it matters ("how do you want to protect this account you just created?"), not at the front door
- Existing deep-link and clipboard-paste invite handling stays unchanged

### Welcome Screen (Unchanged)

The welcome screen stays as it is — one primary button, one recovery link:

```
┌─────────────────────────────────────┐
│          Welcome to BeanPool        │
│                                     │
│  Trade skills, goods and favours    │
│  with your local community.         │
│                                     │
│  ┌───────────────────────────────┐  │
│  │  🎟️  I'm New Here             │  │
│  └───────────────────────────────┘  │
│                                     │
│  BeanPool is invite-only — you      │
│  join with an invite from a member. │
│                                     │
│  New phone? Restore my account →    │
└─────────────────────────────────────┘
```

### Steps 1–2: Invite + Profile (Unchanged)

Identical to today:

```
Step 1 (Your Name):   Invite code + node URL + callsign
Step 2 (Your Photo):  Avatar selection (camera, gallery, or bundled)
```

Behind the scenes, Step 1 still generates the Ed25519 keypair and redeems the invite on the node — exactly as it does now.

### Step 3: Account Protection Chooser (NEW — replaces seed phrase screen)

Instead of showing the 12-word seed phrase, the user is presented with a clear, visual chooser page:

```
┌─────────────────────────────────────────┐
│  🛡️ Protect Your Account               │
│                                         │
│  Choose how to back up your account     │
│  so you're covered if you ever upgrade  │
│  or lose this phone.                    │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │    Continue with Apple         │    │  (shown on iOS)
│  └─────────────────────────────────┘    │
│  ┌─────────────────────────────────┐    │
│  │  G  Continue with Google        │    │
│  └─────────────────────────────────┘    │
│  ┌─────────────────────────────────┐    │
│  │  f  Continue with Facebook      │    │
│  └─────────────────────────────────┘    │
│  ┌─────────────────────────────────┐    │
│  │  🐙 Continue with GitHub        │    │
│  └─────────────────────────────────┘    │
│  ┌─────────────────────────────────┐    │
│  │  ✉️  Protect with Email          │    │
│  │     One-tap code sent to email  │    │
│  └─────────────────────────────────┘    │
│                                         │
│  ─────────── or ───────────             │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  🔑 Off-Grid / Sovereign        │    │
│  │     Write down 12 safety words  │    │
│  │     No social accounts linked   │    │
│  └─────────────────────────────────┘    │
│                                         │
└─────────────────────────────────────────┘
```

**Key UX details:**

- The SSO buttons are styled with each provider's brand colours and logos (familiar, trustworthy)
- The email option is positioned as the simplest SSO choice ("one tap") for users who don't want social login
- The sovereign option is visually separated with an "or" divider — clearly available but not the default path
- No jargon. "Protect your account" not "back up your seed phrase"

### What Each Button Does

#### Apple / Google / Facebook / GitHub (SSO Buttons)

1. User taps provider button → OAuth / native Sign-In flow opens (native sheet or browser redirect)
   - On iOS, **Apple Sign-In** uses the native `expo-apple-authentication` sheet (Face ID / Touch ID confirmation).
   - **Google / Facebook / GitHub** use `expo-auth-session` OAuth 2.0 flow.
2. User authenticates with their existing account
3. Behind the scenes:
   - Ed25519 keypair was already generated in Step 1 (this doesn't change)
   - The 12-word mnemonic is encrypted with a key derived from the OAuth `id_token` subject claim + random salt (HKDF-SHA256 → AES-256-GCM)
   - Encrypted backup is uploaded to the node (`POST /api/sso/backup`)
   - SSO binding is recorded (which provider + provider user ID maps to which public key)
4. User sees: "✅ Account protected!" → proceeds to Step 4 (How It Works guide)
5. **The user never sees the 12 words.**

#### Email (Single-Click Backup)

1. User taps "Protect with Email" → enters their email address
2. Server sends a magic-link verification email
3. User taps the link in their email (verifies ownership)
4. Behind the scenes:
   - Mnemonic encrypted with a key derived from the verified email + random salt
   - Encrypted backup stored on the node
5. User sees: "✅ Account protected!" → proceeds to Step 4
6. **No password to remember.** Recovery works by re-verifying the same email address.

#### Sovereign (12-Word Seed Phrase)

1. User taps "Off-Grid / Sovereign" → shown the 12 safety words screen:
   - 12 words displayed in a clean 3x4 grid
   - "Copy All Words" button
   - Checkbox: "I've saved my 12 safety words" (required)
2. Friendly, empowering messaging: *"These 12 words are your key. No central server, no big company, and no middleman owns your account — just you. Keep them in a safe spot!"*
3. Proceeds to Step 4 (How It Works guide)

### Step 4: How It Works Guide (Updated for Clarity)

Presented as 4 bite-sized, interactive swipe cards:

1. **⚡ Energy & Favours**: *"Share your skills, borrow gear, or help neighbours out. Earn credits for your time and energy."*
2. **🪙 Mutual Credits**: *"No cash needed. Everyone starts with a clean slate and trades fairly within your local hub."*
3. **🤝 Trust Escrow**: *"Trades stay safe and fair. Both sides confirm when a job or exchange is done."*
4. **🛡️ Guardian Recovery**: *"Pick 3 trusted friends as your guardians. If you drop your phone in the ocean, they've got your back!"*

→ "Let's Begin! 🚀" → enter main app.

---

## Part 1.5: Microcopy & Voice Reference Guide (Gen-Z & Everyday Friendly)

To keep the app feeling modern, friendly, and accessible to anyone (from a 21-year-old student to a local market vendor), all technical terms are mapped to simple, conversational everyday language:

| Technical Concept | What We Call It in the UI | Example Tooltip / Info Copy |
|---|---|---|
| **BIP-39 Mnemonic** | **12 Safety Words** or **Recovery Phrase** | *"Think of these 12 words like a master key. Keep them secret, keep them safe!"* |
| **Ed25519 Keypair / DID** | **Your Account ID** | *"Your unique digital stamp on BeanPool. No email or password needed."* |
| **Anchor Node / Server** | **Community Hub** | *"The local server hosting your community's trades and members."* |
| **Social Guardian Recovery** | **Guardian Recovery** | *"Pick 3 trusted friends as your guardians. If you lose your phone, your guardians can vouch for you to get your account back."* |
| **Mutual Credit Ledger** | **Community Balance** | *"Your local trading balance — earn by helping out, spend on goods & services."* |
| **Shamir's Secret Sharing** | **Split Backup** | *"We split your backup into 5 pieces among your guardians. Nobody can peek at your account alone!"* |
| **Secure Store / Keyring** | **Device Vault** | *"Locked securely on your device behind Face ID or Touch ID."* |

---

## Complete Flow Diagram

```
Welcome Screen
    │
    ├── "I'm New Here" ──────────────────────────────────────┐
    │                                                         │
    │   Step 1: Invite Code + Node URL + Callsign             │
    │   (keypair generated, invite redeemed)                   │
    │       │                                                  │
    │   Step 2: Choose Avatar                                  │
    │       │                                                  │
    │   Step 3: 🛡️ Protect Your Account  ◄── THE NEW STEP     │
    │       │                                                  │
    │       ├── Apple ─────► Native Sign-In → encrypt seed → ✅│
    │       ├── Google ────► OAuth → encrypt seed → ✅         │
    │       ├── Facebook ──► OAuth → encrypt seed → ✅         │
    │       ├── GitHub ────► OAuth → encrypt seed → ✅         │
    │       ├── Email ─────► magic link → encrypt seed → ✅    │
    │       └── Sovereign ► show 12 words → confirm → ✅      │
    │                          │                               │
    │   Step 4: How It Works Guide                             │
    │       │                                                  │
    │   "Let's Begin! 🚀" → Main App                          │
    │                                                          │
    └── "Restore my account" ──► Recovery flows (unchanged)    │
                                                               │
        ┌──────────────────────────────────────────────────────┘
        │
        │  [Day 3-7: nudge to pick guardians → Shamir sharding]
```

### SSO Providers

| Provider | Mechanism | Returns | Notes |
|---|---|---|---|
| **Facebook** | OAuth 2.0 via `expo-auth-session` | `name`, `email`, `picture` | Largest user base globally |
| **Google** | OAuth 2.0 / OIDC via `expo-auth-session` | `name`, `email`, `picture` | Most common SSO choice |
| **GitHub** | OAuth 2.0 via `expo-auth-session` | `login`, `name`, `email`, `avatar_url` | Developer / technical community crossover |
| **Email** | Custom magic link (no OAuth) | `email` (verified) | No third-party dependency. Sovereign-adjacent. |
| **Apple** | Native `expo-apple-authentication` | `fullName`, `email` | Required by App Store if any other social login is offered. Added to the list automatically on iOS. |

> **Note on Apple**: Apple Sign-In is required by App Store policy whenever you offer third-party social login. On iOS, the Apple button is shown alongside the others. On Android/PWA, it can be omitted since the policy doesn't apply.

### SSO Key Backup & Recovery Security Model

#### ⚠️ Critical Security Design: Token-Gated Recovery & Key Derivation

A naive implementation that derives the AES key purely from `HKDF(providerUserId, salt)` and exposes `GET /api/sso/backup/:provider/:providerUserId` publicly would be **insecure**: since `providerUserId` (e.g. Google sub, GitHub username, Facebook ID, or email) and `salt` are semi-public, anyone could fetch the encrypted blob and derive the key without ever authenticating!

To make SSO key backup 100% secure:

1. **Authentication Requirement**: The node endpoint `POST /api/sso/recover` requires a freshly signed, valid OAuth `id_token` from the provider.
2. **Server-Side Verification**: The node verifies the `id_token` signature against the provider's official JWKS endpoints (Google, Apple, Facebook, GitHub) and checks `aud`, `iss`, and `exp`.
3. **Entropy & Pepper**: The key derivation includes an ephemeral secret or signature proof from the verified OAuth token, ensuring that knowing the public `providerUserId` alone is mathematically useless.

```
Encrypted Backup Schema (stored on node):
{
  provider: 'facebook' | 'google' | 'github' | 'apple' | 'email',
  providerUserId: string,    // stable OAuth subject ID
  publicKey: string,         // Ed25519 public key of the account
  salt: string,              // random 32-byte hex salt
  iv: string,                // AES-256-GCM IV
  ciphertext: string,        // AES-256-GCM encrypted 12-word mnemonic
  tag: string,               // AES-GCM auth tag
  createdAt: string
}
```

### SSO Recovery Flow

When a user who chose an SSO backup method opens BeanPool on a new device:

```
1. User opens app → no identity found → Welcome screen
2. "Restore my account" → recovery options shown:
   ┌──────────────────────────────────┐
   │  🔑 Recover with 12 Words       │
   │  🛡️ Recover via Guardians       │
   │    Recover with Apple         │  (iOS)
   │  G  Recover with Google         │
   │  f  Recover with Facebook       │
   │  🐙 Recover with GitHub         │
   │  ✉️  Recover with Email          │
   └──────────────────────────────────┘
3. User taps provider → authenticates → client obtains fresh OAuth id_token
4. Client sends id_token to node: POST /api/sso/recover
5. Server validates id_token with provider JWKS:
   → If valid & matching providerUserId found in sso_key_backups:
     return { salt, iv, ciphertext, tag }
6. Client re-derives key from token entropy + salt → decrypts mnemonic
7. Ed25519 keypair derived → "Welcome back!" → identity fully restored
```

### Handling SSO Account Collisions

If a user already has an SSO backup linked to `Provider X` and creates a *new* account on a second device, then attempts to protect it with the *same* `Provider X` account:

- The node detects an existing `UNIQUE(provider, provider_user_id)` constraint match.
- The node responds with: `409 Conflict: SSO account already linked to another BeanPool identity.`
- The app prompts the user: *"This Facebook/Google account is already protecting another BeanPool account. Would you like to restore your existing account instead, or choose a different backup method?"*

---

## Part 2: Three-Layer Seed Backup (Zero-Friction Recovery)

The core innovation: instead of forcing users to back up their seed phrase manually, the system provides three stacking recovery layers. Non-technical users get Layers 1 and 2 without ever knowing what a seed phrase is. Technical users can additionally use Layer 3.

### Layer 1: Automatic Platform Backup (Invisible)

**Active from**: the moment the account is created.  
**User effort**: zero.  
**Covers**: phone upgrade, reinstall, device swap (same platform).

**How it works**: The identity is already stored in `expo-secure-store`. By configuring the SecureStore options correctly:

- **iOS**: Setting `keychainAccessible` enables iCloud Keychain sync. Apple encrypts the item end-to-end and syncs it across devices signed into the same Apple ID. The item is restored automatically on a new device.
- **Android**: Configuring `backup_rules.xml` to include the Keystore entry means Google Auto Backup captures it. Restored on new device with same Google account.

**What changes in code**: A configuration flag on the existing `SecureStore.setItemAsync()` call. No new screens, no new server routes.

**Limitations**: Tied to Apple/Google ecosystem. Doesn't survive a platform switch (iPhone → Android). This is why Layer 2 exists.

### Layer 2: Guardian Seed Sharding (Sovereign, Community-Based)

**Active from**: the moment the user picks guardians.  
**User effort**: pick 3+ trusted people (feels social, not technical).  
**Covers**: phone loss, platform switch, total device loss — everything.

**How it works**: [Shamir's Secret Sharing](https://en.wikipedia.org/wiki/Shamir%27s_secret_sharing) — a well-established cryptographic technique that splits a secret into N shares such that any K shares can reconstruct the original, but fewer than K shares reveal nothing.

#### Setup (when user picks guardians)

```
1. User picks 5 guardians (existing guardian selection flow)
2. Client-side: Shamir split
   → 12-word seed → 5 shares, threshold K=3
3. Each share encrypted with that guardian's Ed25519 public key
   → converted to X25519 for Diffie-Hellman key agreement
   → AES-256-GCM encryption per share
4. Encrypted shares uploaded to the node
   → stored in guardian_shares table
   → node cannot read them (encrypted per-guardian)
```

The user sees: "✅ Guardians set! Your account is protected." No mention of seed phrases, Shamir, or cryptographic shares.

#### Recovery (user loses phone)

```
1. User installs BeanPool on new device
2. "Recover via Guardians" → enters old callsign + node URL
3. Node shows: "You have 5 guardians, need 3 to recover"
4. User contacts guardians out-of-band (text, call, in person)
5. Each guardian opens BeanPool → Settings → Recovery Requests → Approve
6. Guardian's app:
   → decrypts their share with their private key
   → relays decrypted share to the recovering device
     via E2E encrypted messaging channel (existing infrastructure)
7. Once 3 shares collected:
   → Shamir recombination on the new device
   → original 12-word mnemonic reconstructed
   → Ed25519 keypair derived (identical to original)
   → identity fully restored with ORIGINAL key
```

#### Key difference from current guardian recovery

| Current Guardian Recovery | Guardian Seed Sharding |
|---|---|
| Creates a **new** Ed25519 keypair | Reconstructs the **original** keypair |
| Migrates account from old key → new key | No migration — same key restored |
| 24h security cooldown after quorum | No cooldown needed (key proves identity) |
| Old key becomes invalid | Key never changes |
| Guardians only tap "approve" | Guardians tap "approve" which also releases their share |

#### What exists today vs. what's new

| Already Built | Needs Building |
|---|---|
| Guardian selection UI | Shamir split/recombine (client-side, ~200 lines) |
| `friends` table with `is_guardian` flag | `guardian_shares` DB table |
| `POST /api/recovery/request` | Share encryption with guardian public keys |
| `POST /api/recovery/approve` | Share relay over E2E encrypted channel |
| `GET /api/recovery/status/:pubkey` | Guardian nudge system ("pick your guardians!") |
| 3-of-N quorum checking | |
| Recovery notification push to guardians | |
| Guardian knowledge check (anti-spam) | |

#### Schema: `guardian_shares` table

```sql
CREATE TABLE IF NOT EXISTS guardian_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_pubkey TEXT NOT NULL,      -- the member whose seed was sharded
    guardian_pubkey TEXT NOT NULL,    -- the guardian holding this share
    share_index INTEGER NOT NULL,    -- Shamir share index (1-based)
    encrypted_share TEXT NOT NULL,   -- AES-256-GCM ciphertext (hex)
    share_iv TEXT NOT NULL,          -- AES-GCM IV (hex)
    share_tag TEXT NOT NULL,         -- AES-GCM auth tag (hex)
    ephemeral_pubkey TEXT NOT NULL,  -- X25519 ephemeral public key for DH
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(owner_pubkey, guardian_pubkey)
);
```

#### Guardian Nudge System

After onboarding, the app periodically nudges users who haven't picked guardians:

```
Day 1:  (nothing — let them explore)
Day 3:  Gentle banner: "🛡️ Pick 3 trusted people to protect your account"
Day 7:  Settings badge: "⚠️ Your account has no guardians"
Day 14: One-time push notification: "Your BeanPool account isn't backed up yet"
```

The nudge disappears once 3+ guardians are set and shares are distributed.

### Layer 3: Seed Vault (Settings → Security)

**Active from**: always available.  
**User effort**: navigate to Settings → Security → Recovery Phrase.  
**Covers**: everything, forever, offline.

For sovereign users who want the raw 12 words on paper, in a password manager, or engraved in steel. This is not part of the onboarding flow — it's a power-user feature accessible from settings, protected by multiple security layers.

#### The Problem with the Current Approach

Today the 12-word mnemonic is stored as **plaintext JSON** inside `expo-secure-store` alongside the signing key. This means:

- On a jailbroken iOS device, the Keychain can be dumped → mnemonic exposed
- On a rooted Android device, the Keystore can be extracted → mnemonic exposed
- Malware with accessibility permissions could screenshot the seed if it's displayed without additional protection
- A stolen unlocked phone gives immediate access to the identity and recovery phrase

**The signing key** (private key hex) must remain accessible for API request signing without user interaction — it can't require a biometric tap for every fetch call. But **the mnemonic** is only ever needed when the user explicitly wants to view or export it. This lets us lock the mnemonic down much harder.

#### Design: Encrypted Seed Vault

The mnemonic is stored **encrypted at rest** in a separate SecureStore entry, protected by one or both of:

1. **Biometric hardware key** (Face ID / Touch ID / fingerprint) — the decryption key lives in the Secure Enclave (iOS) or StrongBox/TEE (Android) and physically cannot be extracted, even with root access
2. **Admin password** — user-chosen password, used to derive a second encryption key via Argon2id

```
┌──────────────────────────────────────────────────────────────┐
│  BeanPoolIdentity (in SecureStore, accessible for signing)   │
│  ├─ publicKey: hex                                           │
│  ├─ privateKey: hex  ← needed for API signing, always        │
│  ├─ callsign: string    accessible after device unlock       │
│  ├─ createdAt: string                                        │
│  └─ mnemonic: REMOVED ← no longer stored here               │
│                                                              │
│  SeedVault (separate SecureStore entry, encrypted at rest)    │
│  ├─ ciphertext: AES-256-GCM encrypted mnemonic              │
│  ├─ iv: random initialisation vector                         │
│  ├─ tag: GCM authentication tag                              │
│  ├─ salt: Argon2 salt (if password-protected)                │
│  ├─ protection: 'biometric' | 'password' | 'both'           │
│  └─ biometricKeyId: reference to hardware-backed key         │
└──────────────────────────────────────────────────────────────┘
```

#### Protection Modes

Users choose their protection level when they first access the Seed Vault in Settings, or during onboarding if they pick the Sovereign path:

```
┌─────────────────────────────────────────────┐
│  🔒 Seed Vault Protection                   │
│                                              │
│  How do you want to lock your               │
│  recovery phrase?                            │
│                                              │
│  ┌───────────────────────────────────────┐   │
│  │  👆 Biometric (Recommended)           │   │
│  │     Face ID / Touch ID / Fingerprint  │   │
│  │     Hardware-backed, can't be hacked  │   │
│  └───────────────────────────────────────┘   │
│  ┌───────────────────────────────────────┐   │
│  │  🔑 Password                          │   │
│  │     Set an admin password             │   │
│  │     Works on any device               │   │
│  └───────────────────────────────────────┘   │
│  ┌───────────────────────────────────────┐   │
│  │  🛡️ Both (Maximum Security)           │   │
│  │     Biometric + password              │   │
│  │     Two-factor seed protection        │   │
│  └───────────────────────────────────────┘   │
│                                              │
└─────────────────────────────────────────────┘
```

##### Mode 1: Biometric Only

```
Encryption:
  1. Generate AES-256 key inside Secure Enclave / StrongBox (never leaves hardware)
  2. Encrypt mnemonic with hardware-bound AES key
  3. Store encrypted blob in SecureStore
  
Decryption (to view seed):
  1. Settings → Security → View Recovery Phrase
  2. System biometric prompt: "Authenticate to view your recovery phrase"
  3. Face ID / Touch ID / fingerprint → hardware decrypts the blob
  4. 12 words displayed for 60 seconds, then auto-cleared from memory
```

**Security**: The encryption key physically cannot be extracted from the Secure Enclave / StrongBox — not by jailbreak, not by forensic tools, not by state actors. It requires biometric presence at the device hardware. This is the same technology that protects Apple Pay and Google Pay.

##### Mode 2: Password Only

```
Encryption:
  1. User chooses admin password (minimum 8 characters, strength meter shown)
  2. Argon2id(password, random_salt, memory=64MB, iterations=3, parallelism=4) → 32-byte key
  3. AES-256-GCM(mnemonic, key, random_iv) → encrypted blob
  4. Store (encrypted_blob, salt, iv, tag) in SecureStore

Decryption (to view seed):
  1. Settings → Security → View Recovery Phrase
  2. Enter admin password
  3. Argon2id(password, stored_salt) → key → decrypt → 12 words shown
  4. Auto-clear after 60 seconds
```

**Security**: Argon2id with 64MB memory cost makes brute-force extremely expensive — even with a GPU farm, testing each password guess takes ~1 second and 64MB of RAM. A 12-character password becomes effectively uncrackable. The password is never stored — only the salt. Argon2id is the winner of the Password Hashing Competition and is resistant to both GPU and ASIC attacks.

##### Mode 3: Both (Maximum Security)

```
Encryption:
  1. Generate hardware-backed AES key in Secure Enclave (Key A)
  2. Argon2id(admin_password, salt) → Key B
  3. Combined key = HKDF-SHA256(Key_A || Key_B, info="beanpool-seed-vault")
  4. AES-256-GCM(mnemonic, combined_key) → encrypted blob

Decryption (to view seed):
  1. Settings → Security → View Recovery Phrase
  2. Biometric prompt → unlocks Key A from hardware
  3. Enter admin password → derives Key B
  4. Combine → decrypt → 12 words shown
  5. Auto-clear after 60 seconds
```

**Security**: An attacker needs BOTH physical biometric presence at the device AND knowledge of the password. Compromising one factor without the other reveals nothing. This is true two-factor encryption — not just two-factor authentication gating plaintext.

#### Defence-in-Depth: Additional Hardening

| Threat | Defence |
|---|---|
| **Jailbroken/rooted device** | Mnemonic encrypted at rest — extracting SecureStore yields only ciphertext. Biometric key is in Secure Enclave, inaccessible even with root. |
| **Stolen unlocked phone** | Seed Vault requires biometric re-authentication and/or password. App lock (existing `LocalAuth`) prevents app access entirely. |
| **Screen recording / screenshot malware** | When 12 words are displayed: (1) set `FLAG_SECURE` (Android) / block screenshots (iOS) on the view, (2) 60-second auto-clear timer, (3) words shown one-at-a-time or behind a "hold to reveal" interaction. |
| **Shoulder surfing** | Optional "hold to reveal" interaction — each word is masked until the user long-presses on it. Words are never all visible simultaneously unless the user taps "Show All". |
| **Clipboard exfiltration** | "Copy All Words" button copies to clipboard and sets a 60-second auto-clear timer via `Clipboard.setStringAsync()` with expiration. Warning shown: "Copied — clipboard will auto-clear in 60 seconds." |
| **Memory dump / cold boot** | Mnemonic plaintext is held in a local variable only during display, zeroed immediately when the screen is dismissed or backgrounded. Never stored in React state that persists across navigation. |
| **Brute-force (password mode)** | Argon2id with 64MB memory cost. After 5 failed password attempts, exponential backoff (30s → 5min → 1hr). After 10 failed attempts, require biometric + password regardless of mode. |
| **Device without biometric hardware** | Falls back to password-only mode. Shown a nudge: "Your device doesn't support biometrics. Set a strong password to protect your recovery phrase." |

#### Settings → Security UI

```
┌─────────────────────────────────────────────┐
│  🔒 Security                                │
│                                              │
│  App Lock                                    │
│  ├─ Require Face ID on launch    [toggle]    │
│                                              │
│  ──────────────────────────────────────       │
│                                              │
│  Seed Vault                                  │
│  ├─ View Recovery Phrase      [👆 locked]    │
│  ├─ Protection Mode           Biometric 🟢   │
│  ├─ Change Admin Password     [→]            │
│  └─ Vault Status              Encrypted ✅   │
│                                              │
│  ──────────────────────────────────────       │
│                                              │
│  Guardians                                   │
│  ├─ My Guardians (5)          [→]            │
│  ├─ Seed Shard Status         Protected ✅   │
│  └─ Recovery Requests         [→]            │
│                                              │
└─────────────────────────────────────────────┘
```

#### Implementation Notes

**iOS (Secure Enclave)**:
- Use `SecAccessControlCreateWithFlags` with `.biometryCurrentSet` + `.privateKeyUsage`
- Key generated with `kSecAttrTokenIDSecureEnclave` — hardware-bound, non-exportable
- `expo-secure-store` supports `requireAuthentication: true` which maps to this

**Android (StrongBox / TEE)**:
- Use `KeyGenParameterSpec.Builder` with `.setUserAuthenticationRequired(true)` + `.setIsStrongBoxBacked(true)`
- Falls back to TEE if StrongBox unavailable (still hardware-backed, just not a separate chip)
- `expo-secure-store` supports `requireAuthentication: true` for Keystore biometric binding

**Argon2id Parameters** (password mode):
```
memory:      65536 KB (64 MB)
iterations:  3
parallelism: 4
hashLength:  32 bytes
salt:        32 bytes (crypto-random, stored alongside ciphertext)
```

These parameters are calibrated so a single hash takes ~1 second on a modern phone. On a GPU rig, the 64MB memory requirement makes parallel brute-force prohibitively expensive.

### How the Layers Stack

```
┌─────────────────────────────────────────────────────┐
│                                                      │
│  🍎 Layer 1: Platform Backup (automatic, invisible) │
│  ├─ Active from: account creation (Day 1)           │
│  ├─ Covers: new phone, reinstall (same platform)    │
│  ├─ User effort: zero                               │
│  └─ Happens: silently, immediately                  │
│                                                      │
│  🛡️ Layer 2: Guardian Sharding (sovereign)          │
│  ├─ Active from: guardians picked (Day 3–7)         │
│  ├─ Covers: phone loss, platform switch, anything   │
│  ├─ User effort: pick trusted people, then zero     │
│  └─ Fully sovereign — no big-tech dependency        │
│                                                      │
│  🔐 Layer 3: Seed Vault (opt-in power user)          │
│  ├─ Available: Settings → Security → Recovery Phrase │
│  ├─ Protected by: biometric + admin password         │
│  ├─ Encrypted at rest (Secure Enclave / Argon2id)    │
│  ├─ Covers: everything, forever, offline             │
│  └─ User effort: authenticate, then write down words │
│                                                      │
└─────────────────────────────────────────────────────┘
```

#### Real-World Scenario: Sarah Drops Her Phone in the Ocean

**Attempt 1 — Layer 1 (automatic):**
Sarah gets a new iPhone, signs into iCloud, installs BeanPool. Her identity is already synced from iCloud Keychain. The app shows "Welcome back, Sarah!" and she's straight in. **Zero effort.**

**What if she switched iPhone → Android?** iCloud doesn't cross platforms. Layer 2 kicks in:

**Attempt 2 — Layer 2 (guardians):**
Sarah opens BeanPool on her new Android → "Recover via Guardians" → enters her callsign and node URL → texts Dave, Maria, and Tom → they each tap "Approve" in their app → 3 shares collected → original key reconstructed → "Welcome back, Sarah!" **Effort: 3 text messages.**

**What if she's a power user who exported her 12 words?**

**Attempt 3 — Layer 3 (manual):**
Sarah enters her 12 words → done. **Same as today**, but it's an option, not the only path.

---

## Part 3: Onboarding Flow Comparison

### Current Flow (All Users)

```
Welcome → Invite Code + Node URL + Callsign
       → Avatar Selection
       → 12-Word Seed Backup (BLOCKING ⛔)
       → How It Works Guide
       → Enter App

Steps: 4  |  Friction: HIGH  |  Seed: mandatory, visible, blocking
```

### Proposed Flow (All Users — Unified)

```
Welcome → Invite Code + Node URL + Callsign
       → Avatar Selection
       → 🛡️ Protect Your Account (NEW — replaces seed phrase)
            ├── Apple / Google / Facebook / GitHub / Email → one tap, done
            └── Off-Grid / Sovereign → 12-word seed phrase (opt-in)
       → How It Works Guide
       → Enter App
       → [Day 3-7: nudge to pick guardians]

Steps: 4  |  Friction: LOW (SSO) or INTENTIONAL (Sovereign)
Seed: invisible by default, visible only if Sovereign chosen
```

### Key Improvement

The steps 1, 2, and 4 are **identical** regardless of which protection method the user chooses. Only Step 3 branches — and the SSO branch is a single tap. The user is never forced to see a seed phrase unless they specifically opt into the sovereign path.

---

## Part 4: Server-Side Changes

### New API Routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/sso/backup` | Signed (X-Signature + OAuth Token) | Store encrypted key backup (SSO users) |
| `POST` | `/api/sso/recover` | Public (requires valid OAuth `id_token`) | Verify OAuth token & return encrypted backup blob |
| `POST` | `/api/sso/enroll` | OAuth token verified server-side | Auto-enrollment for SSO-verified users (if node allows) |
| `POST` | `/api/sso/magic-link/send` | Public | Send email magic link |
| `GET` | `/api/sso/magic-link/verify/:token` | Public | Verify magic link token |
| `POST` | `/api/guardians/shares` | Signed | Upload Shamir-encrypted shares after guardian selection |
| `GET` | `/api/guardians/shares/:ownerPubkey` | Signed (by recovering device) | Retrieve encrypted shares during guardian recovery |

### New DB Tables

#### `sso_key_backups`

```sql
CREATE TABLE IF NOT EXISTS sso_key_backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,           -- 'facebook' | 'google' | 'github' | 'apple' | 'email'
    provider_user_id TEXT NOT NULL,   -- stable OAuth subject ID
    public_key TEXT NOT NULL,         -- Ed25519 public key this backup belongs to
    salt TEXT NOT NULL,
    iv TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider, provider_user_id)
);
```

#### `sso_bindings`

```sql
CREATE TABLE IF NOT EXISTS sso_bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    email TEXT,
    display_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider, provider_user_id),
    UNIQUE(public_key, provider)
);
```

#### `guardian_shares`

```sql
CREATE TABLE IF NOT EXISTS guardian_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_pubkey TEXT NOT NULL,
    guardian_pubkey TEXT NOT NULL,
    share_index INTEGER NOT NULL,
    encrypted_share TEXT NOT NULL,
    share_iv TEXT NOT NULL,
    share_tag TEXT NOT NULL,
    ephemeral_pubkey TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(owner_pubkey, guardian_pubkey)
);
```

### New Node Configuration

```typescript
// local-config.ts additions
sso?: {
    enabled: boolean;
    autoEnrollment: boolean;        // allow SSO users to join without invite code
    providers: {
        facebook?: { appId: string; appSecret: string; };
        google?: { clientId: string; clientSecret: string; };
        github?: { clientId: string; clientSecret: string; };
        apple?: { clientId: string; teamId: string; keyId: string; privateKey: string; };
        email?: { enabled: boolean; smtpUrl: string; fromAddress: string; };
    };
};
```

---

## Part 5: Dependencies

### Native App (Expo)

| Package | Purpose |
|---|---|
| `expo-auth-session` | Google OAuth 2.0 / OIDC flow |
| `expo-apple-authentication` | Native Apple Sign-In |
| `expo-web-browser` | OAuth redirect handling |
| `secrets.js-grempe` (or equivalent) | Shamir's Secret Sharing split/combine |

### PWA (Web App) Parity & Mapping

The Progressive Web App (`apps/pwa`) runs in standard desktop and mobile browsers. Browser environments lack `expo-secure-store` and direct native Secure Enclave access, so security features map as follows:

| Security Feature | Native App (Expo) | PWA (Browser) |
|---|---|---|
| **Local Key Storage** | `expo-secure-store` | IndexedDB with WebCrypto AES-GCM encryption |
| **Layer 1 Platform Backup** | iCloud Keychain / Google Auto Backup | Web Storage / Chrome Synced Storage (where supported) |
| **Layer 3 Seed Vault Biometrics** | iOS Secure Enclave / Android StrongBox | **WebAuthn / Passkeys** (via `navigator.credentials.create`/`get`) using PRF extension or local PBKDF2 passphrase |
| **SSO OAuth Flows** | `expo-auth-session` (native custom tabs) | Standard browser OAuth 2.0 redirects |

---

## Part 6: Cryptographic Details

### Seed Phrase Generation (Unchanged)

The existing pipeline is preserved exactly:

```
1. 16 bytes random entropy (expo-crypto.getRandomBytes)
2. SHA-256 checksum → first 4 bits
3. 128 + 4 = 132 bits → 12 × 11-bit chunks → BIP-39 English wordlist indices → 12 words
4. Double SHA-256 of space-joined words → 32-byte Ed25519 private key seed
5. @noble/ed25519 getPublicKey(seed) → public key
```

> **Note**: This is a non-standard BIP-39 deviation — standard BIP-39 uses PBKDF2 with 2048 rounds. BeanPool uses double SHA-256. Same wordlist, different derived keys from the same words.

### Shamir's Secret Sharing Parameters

```
Secret:    12-word mnemonic (joined string, UTF-8 encoded, hex-represented)
Shares:    N = number of guardians (minimum 3, recommended 5)
Threshold: K = 3 (always — quorum matches the existing guardian approval threshold)
Field:     GF(2^8) — standard 8-bit Galois field
Library:   secrets.js-grempe (or audited equivalent)
```

### Share Encryption Per Guardian

Each Shamir share is encrypted specifically for one guardian using ECDH key agreement:

```
1. Generate ephemeral X25519 keypair on the sharding device
2. Convert guardian's Ed25519 public key → X25519 public key (standard birational map)
3. ECDH(ephemeral_private, guardian_x25519_public) → shared secret
4. HKDF-SHA256(shared_secret, salt="beanpool-guardian-share") → AES-256 key
5. AES-256-GCM(share_plaintext, key, random_iv) → ciphertext + tag
6. Store: (ciphertext, iv, tag, ephemeral_public_key) on the node
```

To decrypt, the guardian:

```
1. Convert their own Ed25519 private key → X25519 private key
2. ECDH(own_x25519_private, ephemeral_public) → same shared secret
3. HKDF → same AES key → decrypt → plaintext share
```

### SSO Key Backup Encryption

```
1. Extract `sub` claim from OAuth id_token (stable provider user ID)
   — for Facebook: the `id` field; for GitHub: the `id` field;
     for Google/Apple: the `sub` JWT claim; for email: the verified address
2. Generate random 32-byte salt
3. HKDF-SHA256(sub, salt, info="beanpool-sso-backup") → AES-256 key
4. AES-256-GCM(mnemonic_string, key, random_iv) → ciphertext + tag
5. Store: (provider, providerUserId, salt, iv, ciphertext, tag) on the node
```

---

## Part 7: Open Design Questions

### Auto-Enrollment vs Invite Codes

Should SSO-verified users bypass the invite code requirement? Options:

1. **Always require invite** — SSO just makes the flow smoother, but gatekeeping is unchanged
2. **Node operator opt-in** — configurable `sso.autoEnrollment` flag (default: off)
3. **Hybrid** — SSO users skip invite but enter a "waiting room" for node operator approval

Recommendation: Option 2 (node operator opt-in, default off). Preserves existing trust model while giving operators the option to open up.

### Seed Phrase Visibility for SSO Users

Should SSO users ever see their 12 words? Options:

1. **Never shown** — pure SSO + guardian recovery, simplest UX
2. **Deferred** — available in Settings → Security → Export Recovery Phrase (recommended)
3. **Shown during onboarding** but de-emphasised

Recommendation: Option 2. The words always exist — hiding them completely feels paternalistic. Making them available but not forced respects both audiences.

### Guardian Share Re-Encryption

If a guardian recovers their own identity (getting a new keypair), their stored share is encrypted with their old public key and can no longer be decrypted by them. Options:

1. **Re-shard on guardian change** — when any guardian's key changes, the owner's device automatically re-shards and re-distributes
2. **Notify the owner** — "Your guardian Dave changed devices. Tap to update your backup."
3. **Redundancy absorbs it** — with 5 shares and threshold 3, losing 1–2 guardians is survivable

Recommendation: Option 3 as the default (redundancy), with Option 2 as a nudge when the count drops below threshold.

### Nostr Integration

Should we support NIP-07 browser extension / `nsec` import as a third onboarding path for users who already have Nostr keys? This maps naturally since Nostr also uses cryptographic keypairs, and the BeanPool ethos overlaps heavily with the Nostr community.

Status: Deferred — worth exploring but not part of the initial SSO rollout.

---

## Implementation Phasing

### Phase A: Quick Win — Platform Backup + Optional Seed Confirmation (est. 1 day)

- Configure `expo-secure-store` for iCloud Keychain sync (iOS) / Auto Backup (Android)
- Update Step 3 in onboarding: make seed confirmation optional (or default to "I'll back this up later")
- Add "View Recovery Phrase" inside Settings → Security
- Add guardian nudge banner (non-blocking)

### Phase B: Guardian Seed Sharding (est. 1–2 weeks)

- Implement Shamir split/recombine (client-side library integration)
- Add `guardian_shares` DB table and server routes
- Modify guardian selection flow to trigger silent sharding
- Enhance guardian recovery to relay shares and reconstruct original key
- Add share re-encryption nudge system

### Phase C: SSO Integration & Account Protection Chooser (est. 2–3 weeks)

- Build Account Protection Chooser screen (Step 3 in unified wizard)
- Facebook OAuth via `expo-auth-session`
- Google OAuth via `expo-auth-session`
- GitHub OAuth via `expo-auth-session`
- Apple Sign-In via `expo-apple-authentication` (iOS only, required by App Store policy)
- Email magic link flow (server SMTP route)
- Token-gated SSO key backup (`POST /api/sso/backup`) and recovery (`POST /api/sso/recover`)
- Server-side JWT verification using `jose` library
- SSO recovery options on the restore screen
- Auto-enrollment configuration for node operators
- PWA parity (OAuth redirects + WebAuthn biometric vault)
