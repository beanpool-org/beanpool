# Onboarding UX Redesign

> **Status**: Design — not yet implemented
> **Revision**: 3 (2026-08-05) — the keyholder model. See [Revision History](#revision-history).
> **Goal**: Reduce onboarding friction for non-technical users while preserving full sovereignty, with no central point of failure anywhere in the system.

---

## Problem Statement

The current onboarding flow asks every user to:

1. Obtain and enter an invite code (`BP-xxx`)
2. Know their community node URL
3. Choose a name and avatar
4. **Understand and back up a 12-word seed phrase** (blocking step — must tick "I've saved these words")
5. Read how mutual credit works

Steps 1–3 and 5 are reasonable. Step 4 is the problem: it's intimidating, confusing, and most non-technical users tick the checkbox without actually saving their words — then lose their account when their phone breaks.

Meanwhile, technically-minded users who *want* self-custodied keys shouldn't be funnelled into someone else's infrastructure.

### What the code does today (verified 2026-08-05)

| Fact | Location |
|---|---|
| Native identity — including the 12-word `mnemonic` — is stored as **plaintext JSON** in SecureStore, with **no options passed** | [identity.ts:104-111](../apps/native/utils/identity.ts#L104-L111) |
| The native app's *web* build path writes the same plaintext object to `localStorage` | [identity.ts:106-107](../apps/native/utils/identity.ts#L106-L107) |
| The PWA stores the same plaintext object in **unencrypted IndexedDB** | [identity.ts:127-128](../apps/pwa/src/lib/identity.ts#L127-L128) |
| Keypair derivation is `sha256(sha256(words))` — a deliberate BIP-39 deviation | [crypto.ts:165-166](../apps/native/utils/crypto.ts#L165-L166) |
| Guardian recovery exists: `recovery_requests` (with `cooldown_until`, `quorum_required`, `expires_at`) + `recovery_approvals` | [schema.sql:341-362](../apps/server/src/db/schema.sql#L341-L362) |
| `members.invited_by` records who invited each member (FK to `members.public_key`) — **the inviter is already known** | [schema.sql:6](../apps/server/src/db/schema.sql#L6) |
| `friends.is_guardian` exists | [schema.sql:240](../apps/server/src/db/schema.sql#L240) |
| The onboarding stepper is a 4-step component (`Your Name / Your Photo / Safety Backup / How it Works`) | [welcome.tsx:568-590](../apps/native/app/welcome.tsx#L568-L590) |
| `identity.mnemonic` is read directly by four screens | [welcome.tsx:542](../apps/native/app/welcome.tsx#L542), [settings.tsx:537](../apps/native/app/%28tabs%29/settings.tsx#L537), [SettingsPage.tsx:247](../apps/pwa/src/pages/SettingsPage.tsx#L247) |
| **No SSO / OAuth code exists anywhere in the repo** | — |
| `app.json` has **no `plugins` array** — native configuration means a new Expo config plugin, because `android/` is generated and git-ignored | `app.json` |

---

## Design Principles

1. **Zero-friction by default** — a non-technical user should be able to join and be protected without ever seeing a seed phrase or understanding cryptography.
2. **Sovereignty always available** — a technically-minded user can opt into full self-custody at any point, no gates.
3. **Your community is your backup** — recovery should feel social, not technical.
4. **Layered resilience** — no single point of failure, in the design *or* in the infrastructure.
5. **Same Ed25519 protocol underneath** — this is a UX and key-custody layer. The identity model (Ed25519 keypair, signed request headers, node-held public keys) does not change.
6. **Relatable, zero-jargon voice** — no "mnemonic", "Ed25519", "DID", "shard", "threshold".
7. **No custodial surprises** — if anything can open a user's account other than the user, the UI says so, in plain words, at the moment of choosing.
8. **Decentralised means decentralised** *(new)* — no component may exist whose loss or compromise costs users their accounts. Convenience services are allowed; custodians are not.

---

## Part 0: The Keyholder Model

### The idea

Your account is your 12 words. Whoever holds them *is* you. Everything below follows from one decision about where those words live.

Earlier revisions of this document tried to give a **whole copy** of the words to a helper — the node, or a central broker — locked behind something. That's what forced all the scaffolding: a whole copy has to be defended perfectly, which meant peppers, PINs, an Argon2 arms race, and ultimately a central service that could open accounts.

**Revision 3 never creates a whole copy.** The words are split into pieces the moment the account is made. **Any 3 pieces rebuild the account. Any 1 or 2 pieces are mathematically worthless** — not "hard to crack", genuinely no information at all. Pieces are then handed to keyholders who have nothing to do with each other.

This inverts the security problem. We no longer need each keyholder to be trustworthy, because no keyholder can do anything alone. The flaw that made Revision 1 unusable — a node operator being able to derive the key from their own database — becomes harmless here, because what they'd derive is one piece.

### The four keyholders

Every new member gets these, automatically, at signup:

| # | Keyholder | Piece unlocked by | Why it's independent |
|---|---|---|---|
| **K1** | **This phone's own backup** (iCloud / Google Auto Backup) | Restoring the phone | Lives in the user's own device ecosystem; no BeanPool involvement |
| **K2** | **Your community hub** | The hub releasing it (see [release rules](#release-rules)) | Run by your community, not by us |
| **K3** | **Whoever invited you** | That person tapping Approve | A real human you already trust — guaranteed to exist, since `members.invited_by` is recorded |
| **K4** | **Your sign-in account** (Facebook / Google / Apple / GitHub) | Logging in with that account | Optional. A different corporation again |

And then, over time:

| **K5+** | **Backup buddies** | Each one tapping Approve | Real people, added as the user meets them |

Any 3 rebuild the account.

### Why the threshold stays at 3

Three is load-bearing and shouldn't be lowered to two, for a reason that isn't obvious: **the keyholders are not perfectly independent.** The hub physically stores several of the encrypted pieces, including K4's, and for the PWA the hub also serves the app code to the browser — so a dishonest operator has more ways to reach a second piece than the diagram suggests.

At a threshold of 3, that's absorbed: hub's own piece + a captured K4 piece = 2, one short, nothing happens. At a threshold of 2, a single hub operator could take any account on their node — which is exactly the Revision 1 flaw, re-entering through the front door.

**Redundancy comes from the number of pieces, not from lowering the bar.** Four keyholders at 3-of-4 survives losing one. Adding buddies makes it 3-of-6, 3-of-8. Lowering to 2-of-3 would survive one loss too — and halve the security to get there.

### Decisions taken

| # | Decision | Rationale |
|---|---|---|
| **D1** | **No party ever holds a whole copy of the words.** Split first, distribute second. | Removes the need for any keyholder to be trusted, and removes the central broker with it |
| **D2** | **Threshold is 3, always.** Matches the quorum the existing guardian flow already uses. | See above |
| **D3** | **Sign-in is a keyholder, not a vault.** Facebook/Google/Apple/GitHub hold one piece each, same as a person. | Retains the one-tap experience without making a corporation a custodian |
| **D4** | **No broker, no pepper, no PIN.** All deleted. | Nothing holds a whole copy, so there is nothing that needs that level of defence |
| **D5** | **Central OAuth apps are acceptable** — BeanPool registers the Facebook/Google/Apple/GitHub applications. | They are now a *login convenience*, not a custodian. If they vanished, every user loses one keyholder out of four or more and recovers through the rest. Loss degrades the system; it does not cost anyone an account (Principle 8) |
| **D10** | **Facebook is a first-class provider, and the priority one.** Order by reach for this project's actual audience: Facebook, Google, Apple, GitHub. | Facebook is frequently the *only* account a user in a developing market has, often instead of a Google account. Business verification is a one-off cost for us under D5, not a per-hub burden. GitHub is there for the developer crossover and reaches the fewest users |
| **D6** | **Human pieces release instantly on Approve.** No cooldown, no owner-cancellable window. | Chosen for recovery UX. Residual risk recorded as [R1](#part-9-risk-register) |
| **D7** | **The hub's piece releases instantly *once at least one human has approved*, otherwise after 24h with notification.** | Prevents an all-automated trio (hub + sign-in + phone backup) from silently taking an account. Costs a real user nothing when any human is available. **This is the one call made without an explicit ruling — see [Open Questions](#part-10-open-questions).** |
| **D8** | **Recovery starts with the community hub**, not the provider. | The pieces live on one specific node; the recovering device has to know which. Registrar (`<name>.beanpool.org`) assists |
| **D9** | **SSO confers no membership.** `autoEnrollment` and `/api/sso/enroll` are deleted. | Social accounts are free and bulk-creatable; coupling them to enrolment would gut the vouch gate and worsen the Sybil residual in `docs/security-floor-exploit-handover.md` |

---

## Part 1: Onboarding Flow

Everyone walks the same path: invite → name → avatar. The old seed-phrase screen is replaced by a screen that *opens with the user already protected*.

The 4-step stepper at [welcome.tsx:568](../apps/native/app/welcome.tsx#L568) is preserved; step 3's label changes from `Safety Backup` to `Protection`.

### Welcome Screen (unchanged)

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

### Steps 1–2 (unchanged)

```
Step 1 (Your Name):   Invite code + node URL + callsign
Step 2 (Your Photo):  Avatar selection (camera, gallery, or bundled)
```

Step 1 still generates the Ed25519 keypair and redeems the invite. **New**: immediately after redemption the client splits the words and distributes K1–K3. This happens silently, before step 3 is drawn.

### Step 3: Protection (replaces the seed phrase screen)

```
This is **one screen with three states**, chosen by counting the keepers the user actually ended up with. That count is not assumed — K1 is absent for every PWA user and for anyone whose phone has no cloud backup, and K3 is absent on bulk/admin invites.

**State A — 3 keepers (the common case).** Sign-in is a spare.

```
┌─────────────────────────────────────────┐
│  🛡️ You're covered                      │
│                                         │
│  Your account is split into 3 pieces.   │
│  It takes 3 to bring you back:          │
│                                         │
│   📱 This phone's backup      ✅        │
│   🏠 Mullum Community Hub     ✅        │
│   👋 Kim (who invited you)    ✅        │
│                                         │
│  Right now you need all three. Want a   │
│  spare, in case one goes missing?       │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  f  Add my Facebook account     │    │
│  └─────────────────────────────────┘    │
│  ┌─────────────────────────────────┐    │
│  │  G  Add my Google account       │    │
│  └─────────────────────────────────┘    │
│  ┌─────────────────────────────────┐    │
│  │    Add my Apple account        │    │
│  └─────────────────────────────────┘    │
│  ┌─────────────────────────────────┐    │
│  │  🐙 Add my GitHub account       │    │
│  └─────────────────────────────────┘    │
│                                         │
│  Rather write down 12 words? →          │
│  Not now →                              │
└─────────────────────────────────────────┘
```

**State B — 2 keepers.** Sign-in *is* the third keeper, so it isn't framed as a bonus, and "Not now" leads to the words rather than a false all-clear.

```
┌─────────────────────────────────────────┐
│  🛡️ Almost covered                      │
│                                         │
│  It takes 3 pieces to bring you back.   │
│  You've got 2:                          │
│                                         │
│   🏠 Mullum Community Hub     ✅        │
│   👋 Kim (who invited you)    ✅        │
│   ➕ One more needed                    │
│                                         │
│  Quickest way — sign in with an         │
│  account you already have:              │
│                                         │
│  [ f Facebook ] [ G Google ]            │
│  [  Apple ]   [ 🐙 GitHub ]            │
│                                         │
│  Or write down 12 words instead →       │
│  I'll sort it later →                   │
└─────────────────────────────────────────┘
```

**State C — 1 keeper** (browser + bulk invite, no sign-in). The words are the path, said plainly.

```
┌─────────────────────────────────────────┐
│  🔑 Write these down                    │
│                                         │
│  Right now these 12 words are the only  │
│  way back into your account. Keep them  │
│  somewhere safe.                        │
│                                         │
│   [ 12 words in a 3×4 grid ]            │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  📋 Copy all words              │    │
│  └─────────────────────────────────┘    │
│                                         │
│  Once you sign in or add a mate as a    │
│  keeper, you won't need them.           │
│                                         │
│  [ f ] [ G ] [  ] [ 🐙 ]  Add a keeper │
└─────────────────────────────────────────┘
```

**Why this works:**

- It **opens with good news** wherever it truthfully can. In State A the user is protected before they tap anything.
- The screen never claims a keeper the user doesn't have. Revision 3's first draft said "Not now → you're still covered by 3" unconditionally, which was false for every PWA user — told to exactly the people who most needed the truth.
- Per Principle 7, one line sits under the sign-in buttons: *"Facebook just holds one piece — it can't open your account on its own."*
- Nothing here is a hard gate, in any state. State C shows words because they're genuinely the user's only route, not as a punishment.
- **Nobody is ever locked out.** A user on fewer than 3 keepers is exactly as protected as every user is today: their words exist and are always available in Settings. The keeper model is an improvement layered on top, and a user who doesn't reach 3 has simply not received that improvement yet.

Provider buttons are ordered by reach for this audience — Facebook, Google, Apple, GitHub (D10) — not by what a developer would pick.

### Step 4: How It Works

1. **⚡ Energy & Favours**: *"Share your skills, borrow gear, or help neighbours out. Earn credits for your time and energy."*
2. **🪙 Mutual Credits**: *"No cash needed. Everyone starts with a clean slate and trades fairly within your local hub."*
3. **🤝 Trust Escrow**: *"Trades stay safe and fair. Both sides confirm when a job or exchange is done."*
4. **🔑 Getting Back In**: *"Your account is split into pieces held by your phone, your hub and people you trust. Lose your phone and any 3 of them bring you back."*

→ "Let's Begin! 🚀" → main app.

---

## Part 1.5: Microcopy & Voice Reference

| Technical Concept | What We Call It in the UI | Example Copy |
|---|---|---|
| **Shamir share** | **A piece** | *"One piece on its own is useless — it takes 3."* |
| **Threshold / quorum** | **It takes 3** | *"Any 3 of your keepers can bring you back."* |
| **Keyholder** | **Keeper** | *"Your keepers: this phone, your hub, Kim, and Google."* |
| **BIP-39 mnemonic** | **12 Safety Words** | *"Think of these 12 words like a master key. Keep them secret, keep them safe!"* |
| **Ed25519 keypair / DID** | **Your Account ID** | *"Your unique digital stamp on BeanPool. No email or password needed."* |
| **Anchor node / server** | **Community Hub** | *"The local server hosting your community's trades and members."* |
| **Guardian** | **Backup Buddy** | *"Pick people you trust. Any 3 keepers can get you back in."* |
| **Mutual credit ledger** | **Community Balance** | *"Your local trading balance — earn by helping out, spend on goods & services."* |
| **Secure Store / Keyring** | **Device Vault** | *"Locked securely on your device behind Face ID or Touch ID."* |

Never used in the UI: shard, threshold, Shamir, quorum, escrow, key derivation.

---

## Complete Flow Diagram

```
Welcome Screen
    │
    ├── "I'm New Here" ──────────────────────────────────────┐
    │                                                         │
    │   Step 1: Invite Code + Node URL + Callsign             │
    │   (keypair generated, invite redeemed)                   │
    │        │                                                 │
    │        └─► words split into pieces, K1–K3 distributed    │
    │            silently: phone backup / hub / inviter        │
    │                                                          │
    │   Step 2: Choose Avatar                                  │
    │        │                                                 │
    │   Step 3: 🛡️ "You're covered"                           │
    │        ├── Add Facebook/Google/Apple/GitHub ──► K4, 1 tap│
    │        ├── "Rather write down 12 words?" ──► sovereign   │
    │        └── "Not now" ──► still covered by 3              │
    │                                                          │
    │   Step 4: How It Works                                   │
    │        │                                                 │
    │   "Let's Begin! 🚀" → Main App                          │
    │                                                          │
    │        [As the user makes friends: add buddies as K5+]   │
    │                                                          │
    └── "Restore my account" ──► hub first, then collect 3     │
```

---

## Part 2: The Keyholders in Detail

### K1 — This phone's own backup

**Piece stored**: as an ordinary file in the app's backed-up directory.
**Restored by**: iCloud Backup (iOS) or Google Auto Backup (Android) onto a new device on the same account.

> Revisions 1–2 tried to sync a *secret* through platform backup, and both proposed mechanisms were broken. iCloud Keychain sync needs `kSecAttrSynchronizable`, which `expo-secure-store@55.0.15` does not expose (`keychainAccessible` controls *when* an item is readable, not whether it syncs). On Android, SecureStore encrypts with a **non-exportable Keystore key**, so Auto Backup captures a blob whose key never leaves the old device.
>
> The keyholder model dissolves this. A single piece is not a secret, so it can be an ordinary file — and ordinary files back up and restore correctly on both platforms. The mechanism that didn't work is no longer needed.

Requires an Expo config plugin to place the file in the backup set (`app.json` has no `plugins` array today, and `android/` is generated). Testing requires a standalone rebuild.

**If the user has no cloud backup** (common on cheap Android with no Google account), K1 silently won't survive. The protection status must say so honestly rather than claiming a keeper that isn't there.

### K2 — Your community hub

**Piece stored**: on the node, encrypted with a key held in the node's **environment/config, not the database**.

That detail matters: node snapshots are pulled to the fleet manager by design, so DB copies exist off-node. Keeping the wrapping key out of the DB means a stolen backup tarball doesn't yield the hub's piece — the attacker gets ciphertext for a piece that would be worthless even if they opened it.

**Released**: per the [release rules](#release-rules) — instantly once a human keyholder has approved, otherwise after 24h with notification (D7).

### K3 — Whoever invited you

**Piece stored**: on the node, encrypted to the inviter's public key (Ed25519 → X25519 → ECDH → AES-256-GCM). Their app caches its own piece locally on next sync, so the piece survives the node losing data.

`members.invited_by` already records this relationship, so no new user action is required. Both sides are told:

- To the new member: *"Kim is one of your keepers."*
- To the inviter: *"You're now one of Sam's keepers. If Sam loses their phone, you can help them back in."*

The inviter can decline, which deletes their piece and drops the user to two keepers (surfaced honestly, with a prompt to add another).

### K4 — Your sign-in account (optional)

**Piece stored**: on the node as `AES-256-GCM(piece, HKDF-SHA256(sub, salt))`, indexed by `SHA-256(sub ‖ lookup_salt)`.
**Released**: by the node on proof of a fresh provider login, rate-limited.

The node **may be able to derive this piece** — GitHub and Facebook account IDs are short numbers that can be guessed against the lookup hash, and for the PWA the node serves the app code and could capture `sub` in transit. This is documented, accepted, and harmless: it gives the node a second piece, and two pieces are nothing. It is also precisely why the threshold cannot drop to 2.

**Providers, in priority order (D10):**

| Provider | Reach for this audience | Notes |
|---|---|---|
| **Facebook** | Highest | Often the only account a user in a developing market has. Requires business verification — a one-off cost for us under D5, not a per-hub burden |
| **Google** | High | Overlaps heavily with the Android cloud-backup keeper (K1), so it adds less independence than it appears to — see [R3](#part-9-risk-register) |
| **Apple** | Medium, iOS only | Mandatory *only* if we ship an App Store build offering other social logins |
| **GitHub** | Lowest | Developer crossover. Cheapest to register, reaches the fewest users |

Central OAuth applications (D5). If they disappear, users lose one keeper and recover through the others.

### K5+ — Backup buddies

**Piece stored**: on the node, encrypted to each buddy's public key, exactly as K3. Each buddy's app caches its own piece locally.
**Released**: instantly when the buddy taps Approve (D6).

Uses the existing guardian selection UI, `friends.is_guardian`, the existing approve flow, and the existing anti-spam knowledge check.

#### Nudges — event-based, not day-based

A user three days into an invite-only local app doesn't yet know three people on it, so a day-3 nudge is an instruction they can't follow.

```
Trigger: user has ≥3 accepted connections and <2 human keepers
    → Gentle banner: "🛡️ Add someone you trust as a keeper"

Trigger: any keeper is lost (buddy leaves, inviter declines, sign-in revoked)
    → "You're down to 2 keepers — add one so you've got a spare"

Trigger: first completed trade with only the minimum 3 keepers
    → One-time push: "You've got beans now — worth adding a spare keeper"
```

### Protection status

Replace any binary "backed up ✅" with a keeper count, because that's the truth:

```
┌─────────────────────────────────────────────┐
│  Your keepers                     4 of 3    │
│                                              │
│   📱 This phone's backup            ✅       │
│   🏠 Mullum Community Hub           ✅       │
│   👋 Kim                            ✅       │
│   G  Google                         ✅       │
│                                              │
│  Any 3 can bring you back.                   │
│  You can afford to lose 1.        [Add →]    │
└─────────────────────────────────────────────┘
```

"You can afford to lose N" is the number users actually need, and it makes the value of adding a keeper obvious without nagging.

---

## Part 3: Recovery

### Release rules

| Piece | Released when | Instant? |
|---|---|---|
| K1 phone backup | Platform restore puts the file back | Yes, automatic |
| K3 / K5+ humans | That person taps Approve | Yes (D6) |
| K4 sign-in | Fresh provider login verified, rate-limited | Yes |
| K2 hub | ≥1 human piece already released → instant. Otherwise 24h + notification to every remaining device and every human keeper | Conditional (D7) |

D7 exists because K1, K2 and K4 are all machine-released. Without it, that trio is a silent, fully-automated path into any account — and if a user signs in with Google on an Android phone backed up to the same Google account, one company effectively controls two of the three. The 24h delay plus notification means the account owner and their keepers find out and can stop it. When any human is in the loop, the delay serves no purpose and doesn't apply.

### Flow

```
1. Install BeanPool on the new device → "Restore my account"
2. Enter community hub (registrar-assisted) + callsign          (D8)
3. App shows your keepers and collects pieces:
     📱 phone backup ....... found automatically
     G  Google ............. tap to sign in
     👋 Kim ................ tap "ask Kim"  → push → Kim approves
     🏠 Hub ................ auto once a human approves, else 24h
4. On the 3rd piece: rebuild the words → original keypair → in
```

The original key is restored, not replaced — so there is no migration, no re-vouching, and no history loss.

The existing **migrate-to-new-key** guardian recovery stays in place alongside this. It remains the only remedy for a user whose key has actually been compromised, because a rebuilt key is by definition the same key.

### Scenarios

**New phone, same Apple ID.** K1 restores itself. Sarah taps her Google sign-in (K4). That's 2. The hub's piece needs 24h — or she texts Kim, who taps Approve, and she's in immediately. *Effort: one tap, plus one text if she's impatient.*

**Switched iPhone → Android.** No K1. Google (K4) + Kim (K3) = 2, hub joins instantly because a human approved = 3. *Effort: one tap and one text.*

**No sign-in account, phone in the ocean, switched platforms.** Kim (K3) + two buddies (K5, K6) = 3. *Effort: three texts.*

**Wrote the words down.** Type them. Works forever, needs nobody.

---

## Part 4: The Sovereign Path & Seed Vault

For users who want the raw 12 words on paper, in a password manager, or engraved in steel. Available during onboarding ("Rather write down 12 words?") and always in Settings → Security.

### The problem with today's storage

The words sit in **plaintext** — SecureStore JSON on native, `localStorage` on the native web build, unencrypted IndexedDB in the PWA. A rooted phone, a jailbroken phone, or a browser devtools window is enough. A stolen unlocked phone gives immediate access to identity *and* recovery phrase.

**The signing key** must stay usable without user interaction, for request signing. **The words** are only needed when the user explicitly asks for them. That asymmetry is what lets us lock the words down hard.

### Design

```
┌──────────────────────────────────────────────────────────────┐
│  BeanPoolIdentity (used for signing — unchanged)             │
│  ├─ publicKey / privateKey / callsign / createdAt            │
│  └─ mnemonic: REMOVED ← moves to the vault (see Part 8)      │
│                                                              │
│  SeedVault (separate entry, encrypted at rest)               │
│  ├─ ciphertext / iv / tag                                    │
│  ├─ salt + kdf_params (recorded, not assumed)                │
│  ├─ protection: 'biometric' | 'password' | 'both'            │
│  └─ biometricKeyId                                           │
└──────────────────────────────────────────────────────────────┘
```

`kdf_params` is stored rather than hard-coded because the PWA can't afford native Argon2 costs on the Android 8 / 1 GB-class devices this project targets — a blob made on one platform must open on the other.

### Protection modes

```
┌───────────────────────────────────────┐
│  👆 Face ID / Fingerprint (easiest)   │  key lives in Secure Enclave /
│     Held in your phone's secure chip  │  StrongBox, can't be extracted
├───────────────────────────────────────┤
│  🔑 A password                        │  Argon2id → AES-256-GCM
│     Works on any device               │
├───────────────────────────────────────┤
│  🛡️ Both (most locked down)           │  HKDF(hardware_key ‖ argon2_key)
│     Two-factor encryption             │  — compromising one reveals nothing
└───────────────────────────────────────┘
```

`expo-secure-store`'s `requireAuthentication: true` maps to Secure Enclave (iOS, `SecAccessControlCreateWithFlags` + `kSecAttrTokenIDSecureEnclave`) and StrongBox/TEE (Android, `setUserAuthenticationRequired` + `setIsStrongBoxBacked`). PWA uses WebAuthn/passkey PRF where available, else an Argon2id passphrase.

### Defence-in-depth

| Threat | Defence |
|---|---|
| **Jailbroken/rooted device** | Words encrypted at rest; hardware key inaccessible even with root |
| **Stolen unlocked phone** | Vault requires biometric and/or password; existing `LocalAuth` app lock gates the app |
| **Screenshot malware** | `FLAG_SECURE` / iOS screenshot blocking on the view, 60 s auto-clear, hold-to-reveal per word |
| **Shoulder surfing** | Words masked until long-pressed; all-visible only on explicit "Show All" |
| **Clipboard exfiltration** | App-owned 60 s timer overwrites the clipboard. **Note**: `Clipboard.setStringAsync` has no expiry parameter (Revision 1 implied it did) and an app-owned timer doesn't survive app kill — the warning copy must not overpromise |
| **Memory dump** | Plaintext in a local variable during display only, zeroed on dismiss/background, never in persisted React state |
| **Brute force (password mode)** | Argon2id 64 MB. 5 failures → 30 s / 5 min / 1 hr backoff. 10 failures → require biometric + password |
| **No biometric hardware** | Falls back to password-only with an explanation |

### Settings → Security

```
┌─────────────────────────────────────────────┐
│  🔒 Security                                │
│  App Lock                                    │
│  ├─ Require Face ID on launch    [toggle]    │
│  ──────────────────────────────────────      │
│  My Keepers                       4 of 3     │
│  ├─ This phone's backup             ✅       │
│  ├─ Mullum Community Hub            ✅       │
│  ├─ Kim                             ✅       │
│  ├─ Google (m•••@gmail.com)         ✅       │
│  ├─ Add a keeper                  [→]        │
│  └─ Remove a keeper               [→]        │
│  ──────────────────────────────────────      │
│  My Words                                    │
│  ├─ View Recovery Phrase      [👆 locked]    │
│  ├─ Locked with               Face ID 🟢     │
│  └─ Change password           [→]            │
│  ──────────────────────────────────────      │
│  Recovery Requests                [→]        │
└─────────────────────────────────────────────┘
```

"Remove a keeper" is required, not optional — a user must be able to revoke Google, or a buddy they've fallen out with. Removing a keeper deletes their piece and **re-splits the words across the remaining keepers**, so the removed piece is dead rather than merely orphaned.

---

## Part 5: Server-Side Changes

Compared with Revision 2 this is a large deletion: no broker service, no OAuth credentials per node, no peppers, no magic-link mail, no `sso_bindings`, no `sso_key_backups`.

### New API routes

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/recovery/shares` | Signed | Upload the encrypted pieces after a split or re-split |
| `GET` | `/api/recovery/keepers/:callsign` | Public, rate-limited | List a member's keeper *types* (not identities) so the restore screen can be drawn |
| `POST` | `/api/recovery/collect` | Per-piece (see below) | Request release of a specific piece |
| `POST` | `/api/recovery/sso-verify` | Public + fresh OAuth token | Verify a provider login and release the K4 piece |
| `DELETE` | `/api/recovery/shares/:holderId` | Signed | Remove a keeper (triggers re-split) |

The existing `/api/recovery/request`, `/approve`, `/status`, `/lookup` and `/pending` routes stay as they are — they still serve the migrate-to-new-key flow, and the approve endpoint gains a side effect: releasing that approver's piece.

### New DB table

```sql
CREATE TABLE IF NOT EXISTS recovery_shares (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_pubkey TEXT NOT NULL REFERENCES members(public_key),
    holder_type TEXT NOT NULL,       -- 'device' | 'hub' | 'member' | 'sso'
    holder_ref TEXT NOT NULL,        -- member pubkey | provider name | 'self'
    share_index INTEGER NOT NULL,    -- Shamir evaluation point
    encrypted_share TEXT NOT NULL,
    share_iv TEXT NOT NULL,
    share_tag TEXT NOT NULL,
    ephemeral_pubkey TEXT,           -- X25519 ephemeral, for 'member' holders
    sso_lookup_hash TEXT,            -- SHA-256(sub || lookup_salt), for 'sso' holders
    sso_lookup_salt TEXT,
    kdf_params TEXT,
    generation INTEGER NOT NULL DEFAULT 1,  -- bumped on every re-split
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(owner_pubkey, holder_type, holder_ref, generation)
);
CREATE INDEX IF NOT EXISTS idx_recovery_shares_owner ON recovery_shares(owner_pubkey);
CREATE INDEX IF NOT EXISTS idx_recovery_shares_sso ON recovery_shares(sso_lookup_hash);
```

`generation` is what makes keeper removal real: a re-split bumps the generation and pieces from older generations are refused during collection, so pieces can never be mixed across splits.

**The raw provider ID is never stored** — only `sso_lookup_hash`. A stolen database can't even enumerate which Google accounts are in use.

### Node configuration

```typescript
// local-config.ts additions
recovery?: {
    hubShareKey: string;   // wraps the hub's own piece; MUST come from env, never the DB
    ssoEnabled: boolean;   // whether this hub offers the sign-in keeper at all
};
```

No OAuth client secrets on nodes (D5 — the apps are central and the client talks to them directly). No `autoEnrollment` (D9).

---

## Part 6: Dependencies

### Native (Expo)

| Package | Purpose |
|---|---|
| `expo-auth-session` | OAuth for the K4 keeper |
| `expo-apple-authentication` | Native Apple Sign-In (App Store builds only) |
| `expo-web-browser` | OAuth redirect handling |
| `shamir-secret-sharing` | Split/combine — TypeScript, maintained, Uint8Array API |
| `hash-wasm` (or `react-native-argon2`) | Argon2id for the vault password only |

> Revision 1 specified `secrets.js-grempe`, unmaintained since 2019. For a library that splits every user's key, use one still receiving fixes. Whichever is chosen must be verified under Hermes and on the **Android 8 / API 26 floor** and 320 dp screens this project targets.

Deleted from Revision 2's list: `jose`, SMTP, and everything broker-related.

### PWA

| Feature | Native | PWA |
|---|---|---|
| Local key storage | `expo-secure-store` | IndexedDB + WebCrypto AES-GCM (**currently plaintext** — fixing this is in scope) |
| K1 phone-backup keeper | iCloud / Auto Backup file | **Not available** — browsers have no equivalent. PWA users start with 2 keepers and are prompted for a third |
| Vault biometrics | Secure Enclave / StrongBox | WebAuthn/passkey PRF, else Argon2id passphrase |
| OAuth | `expo-auth-session` | Standard browser redirects |

**Cross-platform note**: the split payload is the **12 words**, never the private key. Native holds a raw 32-byte seed while the PWA holds a 48-byte PKCS8 key, so key bytes don't transfer between platforms — but the words derive correctly on both, since both run `sha256(sha256(words))`. Any implementation that splits key bytes instead of words will break cross-platform recovery.

---

## Part 7: Cryptographic Details

### Seed phrase generation (unchanged)

```
1. 16 bytes random entropy (expo-crypto.getRandomBytes)
2. SHA-256 checksum → first 4 bits
3. 132 bits → 12 × 11-bit chunks → BIP-39 English wordlist → 12 words
4. Double SHA-256 of the space-joined words → 32-byte Ed25519 seed
5. @noble/ed25519 getPublicKey(seed) → public key
```

> Non-standard BIP-39 deviation: standard BIP-39 uses PBKDF2 with 2048 rounds, BeanPool uses double SHA-256. Same wordlist, different derived keys. Changing it now would orphan every existing account.

### The split

```
Secret:    the 12 words (space-joined, UTF-8)
Threshold: K = 3 (D2 — matches the existing guardian quorum)
Shares:    N = number of keepers (3 at signup, 4 with sign-in, more with buddies)
Field:     GF(2^8)
Library:   shamir-secret-sharing — must pass a round-trip test on Hermes
```

Re-split (and `generation` bump) happens on: adding a keeper, removing a keeper, or a keeper's key changing.

### Per-keeper encryption

**Human keepers (K3, K5+)** — ECDH to their existing account key:

```
1. Ephemeral X25519 keypair on the splitting device
2. Keeper's Ed25519 public key → X25519 (standard birational map)
3. ECDH(ephemeral_private, keeper_x25519_public) → shared secret
4. HKDF-SHA256(shared_secret, salt="beanpool-keeper-share") → AES-256 key
5. AES-256-GCM(piece, key, random_iv) → ciphertext + tag
6. Store (ciphertext, iv, tag, ephemeral_pubkey) on the node
```

The keeper decrypts by converting their own Ed25519 private key to X25519 and repeating the ECDH.

**Sign-in keeper (K4)**:

```
1. sub = provider subject claim (Google/Apple `sub`, Facebook/GitHub `id`)
2. lookup_salt = random 32B;  sso_lookup_hash = SHA-256(sub ‖ lookup_salt)
3. key = HKDF-SHA256(sub, salt, info="beanpool-keeper-sso-v1")
4. AES-256-GCM(piece, key, random_iv)
5. Store (ciphertext, iv, tag, sso_lookup_hash, lookup_salt) on the node
```

This is deliberately weak-ish, and that's fine: `sub` is not a secret in general, and the node might derive it. What that yields is one piece. **Security here comes from the threshold, not from this key** — which is the entire architectural point of Revision 3.

**Hub keeper (K2)**: AES-256-GCM under `recovery.hubShareKey`, sourced from the environment and never written to the database, so a stolen DB snapshot doesn't include it.

**Device keeper (K1)**: written as an opaque file in the platform backup set. Secrecy is not load-bearing — a piece alone reveals nothing — so no user secret and no hardware key is involved. This is what makes K1 work at all, where Revisions 1 and 2 failed.

### Argon2id parameters (vault password only)

```
Native:  m=65536 KB (64 MB), t=3, p=4, hashLength=32, salt=32B
PWA:     m=32768 KB (32 MB), t=4, p=1, hashLength=32, salt=32B
```

Two profiles because a 64 MB wasm allocation in a browser tab risks an OOM kill on the 1 GB-class devices this project targets. Parameters are stored in the blob so either platform can open the other's vault. Both must be benchmarked on a real low-end device before being fixed.

---

## Part 8: Migration for Existing Users

Revision 1 declared `mnemonic: REMOVED` from `BeanPoolIdentity` with no migration path. Four screens read that field directly — [welcome.tsx:542](../apps/native/app/welcome.tsx#L542), [settings.tsx:537,1776,1850](../apps/native/app/%28tabs%29/settings.tsx#L537), [SettingsPage.tsx:247,646](../apps/pwa/src/pages/SettingsPage.tsx#L247) — so removing it breaks all of them, and every existing user already has plaintext words in storage.

```
1. Add getMnemonic(): Promise<string[] | null> — a vault-aware accessor that
   reads the vault if present and falls back to identity.mnemonic.
   Migrate all four call sites to it FIRST, with no behaviour change.

2. On next launch after update, if the user has no keepers:
   → non-blocking card: "Let's make sure you can't lose your account"
   → accept → split now, distribute to hub + inviter (members.invited_by is
     already recorded) + this phone's backup → offer sign-in as a spare
   → dismiss → status quo, ask again in 7 days, never block

3. Separately and optionally, move the plaintext words into the vault.

4. Only once telemetry shows the long tail has migrated does
   identity.mnemonic become genuinely optional in the type.
```

An existing user whose inviter has left the community, or who joined before `invited_by` was populated, starts with two keepers and is prompted for a third. Nobody is ever blocked or logged out by this migration.

---

## Part 9: Risk Register

| # | Risk | Severity | Status |
|---|---|---|---|
| **R1** | **3 colluding human keepers take an account.** Instant release (D6) means no notification window and no cancel; because the original key is rebuilt rather than rotated, there's no revocation afterwards. | High | **Accepted** — chosen for recovery UX. Mitigations that cost no UX: keep the existing knowledge check, log every release, and notify the owner on every surviving device *after* the fact. The migrate-to-new-key flow remains the remedy once a takeover is discovered. |
| **R2** | **Hub holds more than one envelope.** It stores K4's ciphertext and (for PWA users) serves the app code, so a dishonest operator can plausibly reach 2 pieces. | Medium | Contained by the threshold of 3 (D2). This is the specific reason the threshold cannot be lowered. |
| **R3** | **One vendor controlling two keepers** — e.g. Google sign-in (K4) on an Android phone backed up to the same Google account (K1). | Medium | Contained by D7: the third piece is the hub's, which won't release automatically without a 24h delay and a notification. |
| **R4** | **Central OAuth apps disappear** (policy change, account suspension, us going away). | Low | Every user loses one keeper out of 4+ and recovers via the rest. Degrades; doesn't destroy. This is what makes D5 compatible with Principle 8. |
| **R5** | **Node data loss** takes the hub's piece and the stored copies of human pieces. | Low | Human keepers cache their own piece locally, so K3/K5+ survive. K1 is on the user's phone. Only the hub's own piece is lost. |
| **R6** | **User has no cloud backup** (cheap Android, no Google account) → K1 is a phantom keeper. | Medium | Detected and shown honestly in the keeper list, never counted as present. Facebook (D10) covers many of these users, who often have one even without a Google account. Falls back to State B/C of step 3. |
| **R7** | **Inviter declines or leaves** → 2 keepers. | Medium | Detected, surfaced, nudged. Not silent. |
| **R8** | **Bulk/admin invites have no personal inviter** → user starts with 2 keepers. | Low | Step 3 State B asks for a third. |
| **R9** | **PWA users have no K1 at all** — browsers have no cloud-backup equivalent — so they start on 2 keepers by default. | Medium | Step 3 State B makes sign-in the third keeper rather than a bonus. The PWA is a first-class client, so this is the normal path for a large share of users, not an edge case. |

**On users who don't reach 3 keepers**: they are **not** locked out and never have been. Their 12 words exist and are always available in Settings — they are exactly as protected as every user is today. The keeper model is an improvement layered on top of that floor, and a user who hasn't reached 3 keepers simply hasn't received the improvement yet. Any copy or design that implies otherwise is wrong.

Note what is **no longer** in this register: broker collusion, PIN brute-forcing, central escrow compromise, and a node operator being able to decrypt user keys. Those risks don't exist in this design rather than being mitigated in it.

---

## Part 10: Open Questions

1. **Is D7 right?** The hub's piece waits 24h unless a human has approved. It's the one decision taken without an explicit ruling, and it's the thing standing between "Google plus your phone backup" and a silent account takeover. The alternative is instant release everywhere, consistent with D6.
2. **Are we shipping on the App Store?** Apple Sign-In is only mandatory if other social logins are offered in an App Store build. If distribution stays APK + PWA, the Apple keeper and a paid developer account drop entirely. Biggest remaining scope lever.
3. **Cross-node keepers.** Assumed same-node. Federation makes cross-hub pieces possible — wanted before v1?
4. **Does `recovery.ssoEnabled` default on or off** for self-hosted hubs?
5. **Weighted pieces.** A keeper can be given two evaluation points instead of one — e.g. the phone backup counting double, so "phone + one friend" recovers while "two friends" doesn't. More flexible, more code. Worth it, or keep every keeper equal?
6. **Nostr / NIP-07** as an additional keeper type — deferred.

---

## Implementation Phasing

### Phase A: Unblock onboarding + groundwork (est. 2–3 days)

- Replace the blocking seed screen with a non-blocking version; add "Not now"
- Fix How-It-Works card 4
- Add `getMnemonic()` and migrate all four `identity.mnemonic` call sites
- "View Recovery Phrase" in Settings → Security (plaintext for now)
- **No native changes, no rebuild** — ships to PWA and native alike

### Phase B: The split and human keepers (est. 1–2 weeks)

- Shamir split/combine, round-trip tested on Hermes and on an API 26 device
- `recovery_shares` table, `generation` handling, re-split on keeper change
- K2 (hub) and K3 (inviter) keepers; keeper-side local caching
- Release wired into the existing approve flow, with D6 instant release and D7 for the hub
- Keeper status UI ("4 of 3 — you can afford to lose 1")
- Restore flow: hub first, then collect pieces

**At the end of Phase B every user is protected, with no third party and no central service involved.**

### Phase C: Seed Vault (est. 1 week)

- Encrypted vault, biometric mode via `requireAuthentication`, password mode via Argon2id
- PWA vault via WebCrypto + `hash-wasm` — this is also the fix for plaintext IndexedDB
- Migration prompt (Part 8 step 3)
- Requires a standalone rebuild to test

### Phase D: K1 phone-backup keeper (est. 3–4 days)

- Expo config plugin for backup-set file placement
- Detection and honest reporting when no cloud backup exists (R6)
- Requires a standalone rebuild to test

### Phase E: K4 sign-in keeper (est. 1 week)

- Register the central OAuth applications
- `expo-auth-session` flows + PWA redirect parity
- `/api/recovery/sso-verify` with rate limiting
- Keeper add/remove from Settings

Phases A–D contain no third-party dependency of any kind. Phase E is the only part touching Facebook/Google/Apple/GitHub, it is last, and nothing else depends on it. Within Phase E, build providers in D10 order — Facebook first, since it reaches the most users and its business verification has the longest lead time.

---

## Revision History

**Revision 3.1 (2026-08-05)** — Facebook restored as a keeper provider and made the priority one (D10); step 3 rebuilt as three states driven by the real keeper count, so the screen never claims a keeper the user doesn't have; R9 added for PWA users; corrected the framing that fewer than 3 keepers means no recovery — it means the user falls back to the 12 words, exactly as today.

**Revision 3 (2026-08-05)** — the keyholder model:
- **The words are split at signup and no party ever holds a whole copy.** Sign-in becomes one keyholder among several rather than a vault
- Central broker, peppers and the Recovery PIN all deleted — nothing holds a whole copy, so nothing needs that defence
- Four keepers from day one: phone backup, community hub, inviter, optional sign-in. Threshold stays at 3
- Layer 1 fixed by dissolving it: a single piece isn't a secret, so it can be an ordinary backed-up file
- D7 added — the hub's piece won't release automatically without a delay and a notification
- Keeper removal made real via `generation`; `sso_key_backups` / `sso_bindings` replaced by `recovery_shares`
- Risk register rewritten: broker collusion, PIN brute-forcing and node-operator decryption no longer exist as risks

**Revision 2 (2026-08-05)** — split the escrow key three ways (node / central broker / user PIN), fixed Revision 1's node-can-decrypt-everything flaw, corrected the Layer 1 mechanism, added migration and risk sections. Superseded: the broker was a central point of failure.

**Revision 1** — original design. SSO escrow with the key derivable from data the node itself stored.
