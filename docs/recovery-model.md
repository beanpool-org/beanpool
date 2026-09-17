# Recovery model

**Status: Updated September 2026.** Keeper-based (social / guardian / friend-shard) recovery
was completely scrapped in September 2026 (PR #713 removed all client entry points; see
[`keeper-recovery-parked.md`](keeper-recovery-parked.md)).

The only two recovery paths in BeanPool are:
1. **The member's 12 words** (available everywhere: PWA and Native; the sole node-independent path).
2. **SSO Sign-In Recovery** (available on Native only; works only while the community node still holds its fragment).

Where this document contradicts `docs/ONBOARDING.md`, this document wins and ONBOARDING.md is stale.

---

## What recovery is for

A member's account **is** a keypair. The 12 words are that key written in English. There is
no password reset, because there is nobody holding a copy to reset it against.

Two different things can go wrong, and they need different answers:

| Failure | Answer |
|---|---|
| Lost the phone (Native) | SSO sign-in (if linked) or **the 12 words** |
| Lost the phone (PWA) | **the 12 words** (PWA has no SSO recovery) |
| Lost the community — node gone, or you want to leave | **the 12 words** |

The 12 words get you into *any* node and are completely sovereign and node-independent. SSO
recovery gets you back onto a new native device on *this* node only, and depends on the node
holding its fragment. Keeper/social recovery has been scrapped.

---

## The construction

The two-layer construction survives exclusively for **SSO Sign-In Recovery** on Native:

```
seed  =  A  ⊕  B

  A  →  the hub. Plaintext in the node's database.
  B  →  sealed to the SSO provider sub (Google/Apple). Never readable by the node alone.
```

`A` is 32 random bytes; `B` is `seed ⊕ A`. Both halves are required — this is a 2-of-2 XOR,
not a threshold.

The former second layer that split `B` with Shamir across human friends/guardians was scrapped
in September 2026. Zero human-keeper shares exist on live nodes, and all client entry points
have been removed. The member's 12 words and native SSO recovery are the only live recovery paths.

---

## The two recovery paths

### 1. SSO — custodial by choice (Native only)

```
A  →  hub                          node reads it
B  →  sealed to the provider sub   node can obtain the sub
```

**The node operator can reconstruct these accounts.** This is a deliberate trade, taken
2026-08-10: stability over sovereignty for people who would otherwise have no recovery at
all. It must be stated in the product, not buried.

Sealing `B` to the `sub` still earns its place — it locks out anyone holding only the
*data* (stolen database, backup tarball, decommissioned disk, an operator who never
bothers). It does not lock out an operator who decides to, because the `sub` arrives in
every id_token and the operator's own code receives it.

That seal has to be **expensive**: `sealShareToSso` uses scrypt at the same cost
`ssoLookupHash` uses for the same value. The raw `sub` itself is never stored — the
node keeps only a scrypt hash with a per-share random salt.

A Google `sub` is the same value handed to every OAuth client that user has ever signed
into — an identifier, not a secret. Apple's is scoped per developer team and genuinely
private. Neither is private *from the node*.

### 2. Sovereign — 12 words only (Everywhere)

Nothing is stored anywhere on the network. Nobody can recover the member if the words are lost.

This is the **default** for all members, and the **only** recovery mechanism on the PWA.
The 12 words are deterministic BIP-39 mnemonics generating the Ed25519 keypair. They are
the only recovery path that works across any node independently.

> **Scrapped: Friend / Guardian Keepers (Non-SSO Shamir 2-of-5).**
> The formerly planned non-SSO social recovery tier (Shamir 2-of-5 across trusted friends)
> was completely scrapped in September 2026. Zero human-keeper shares exist on live nodes,
> and all client entry points have been removed.

---

## Where the fragments actually live

For members enrolled in SSO on Native, fragments live as rows in `recovery_shares` on the node's disk:

| Fragment | Stored | Node can read |
|---|---|---|
| hub (`A`) | node | **yes** — `hubShareKey` was withdrawn 2026-08-08 |
| sso (`B`) | node | only while verifying the provider `sub` during active recovery |

Consequences worth stating plainly:

- **Node death takes every fragment for every member at once.** Node backup durability is
  the entire availability story for SSO recovery.
- The 12 words are the only node-independent thing in the system.

### The PWA is 12-words only

The PWA is served by the node. A hostile operator can ship JavaScript that does whatever
they like. Furthermore, web OAuth redirects to dynamic community node domains face
strict provider constraints (e.g. Apple Services ID domain association restrictions).

PWA members are strictly **sovereign tier**: 12 words, nothing stored on the node, no exceptions.
SSO recovery is native-only.

---

## Recovery flows

### SSO (Native only)

```
1  enter callsign
2  sign in with Google or Apple
3  A ⊕ B → in
```

No PIN. No delay. **The sign-in is the authentication.**

### 12 Words (Native and PWA)

```
1  enter callsign
2  enter 12-word recovery phrase
3  in
```

Works everywhere, offline or online, on any node, requiring no third parties.

---

## The PIN — Scrapped

The recovery PIN mechanism (`recovery_pin` table) was scrapped alongside friend-keeper recovery.
No client UI exists, and no recovery routes verify a PIN.

```
2 free attempts, then one attempt per 15 minutes. Flat.
A correct PIN is always accepted immediately.
```

~96 guesses a day against 10⁶ — **28 years**. A progressive ladder was considered and
dropped; it bought nothing over the flat cap.

**Never a hard lockout.** A lockout converts into denial of service: an attacker burns the
attempts and the real member finds a locked door on the day they need it. A capped delay
---

## Notifications & Security Alert Banner

The account owner is alerted via `RecoveryAlertBanner` on both Native and PWA clients if an active recovery session is opened on the community node (`/api/recovery/collect/mine`). The owner can cancel an unauthorized recovery session directly from the banner via `/api/recovery/collect/cancel`.

Friends and keepers are not notified because keeper/social recovery has been scrapped.

---

## What each party can reach

| | SSO tier (Native) | Sovereign (12 words) |
|---|---|---|
| Cold DB / backup thief | nothing | nothing |
| Node operator, passively | nothing | nothing |
| **Node operator, deliberately** | **the account** | nothing |
| Hijacked Google/Apple account | **the account** — the sign-in is the authentication | nothing |

---

## Decisions, and what they replaced

**Keeper-based (social / guardian) recovery — SCRAPPED (September 2026).** Enrolling friends or
guardians as recovery keepers was permanently removed from both clients (PR #713). Zero
human-keeper shares exist on live nodes. The only two surviving recovery mechanisms are the
12-word seed phrase (universal, sovereign) and SSO recovery (native only, node-dependent).
See [`keeper-recovery-parked.md`](keeper-recovery-parked.md).

**K1, the phone fragment — removed.** It only survived via OS cloud backup, which fails
silently and cannot be probed.

**The inviter as a counted keeper — removed.** The inviter is frequently someone the member
never meets again and has never been asked to hold anything.

**`sso ×2 + hub` at threshold 3 — rejected in that form.** Replaced by the two-layer
`A ⊕ B` construction where `A` is the hub fragment and `B` is sealed to the SSO provider `sub`.

**A mandatory PIN in front of `A` — rejected.** It would have locked out more members through
forgetting than it ever protected. The PIN table is unused and no recovery route checks it.

---

## What exists today

- **12-word seed phrase**: BIP-39 mnemonic recovery implemented across both Native (`apps/native`)
  and PWA (`apps/pwa`). Sovereign, node-independent, works everywhere.
- **SSO recovery (Native only)**: Google and Apple sign-in recovery verified on physical hardware,
  operating on the two-layer `A ⊕ B` model where `A` is the hub fragment and `B` is sealed to
  the provider `sub`.
- **`RecoveryAlertBanner`**: Rendered on both Native and PWA to alert members to active recovery
  sessions via `/api/recovery/collect/mine` and allow cancellation via `/api/recovery/collect/cancel`.
- **Scrapped**: Friend keeper enrolment, guardian approvals, recovery PINs, and 3-of-N social
  recovery. All client entry points have been removed. Server-side helper functions remain
  unreferenced so the decision can be reversed without a migration if ever desired.

---

## Open questions

1. ~~**Does the node persist the raw `sub`?**~~ **Answered 2026-08-11: it does not.**
   `ssoLookupHash` stores a scrypt hash with a per-share random salt and the raw value is
   never written. The cold-database protection stands — but only against an attacker who
   never sees a live sign-in, since the `sub` does arrive in plaintext during verification.
2. **How many members are on the PWA?** The decision above excludes them from recovery
   entirely. Marty's read (2026-08-11) is that the native share is much the larger and the
   PWA is an edge case; still unmeasured numerically, and it determines how loudly that
   needs saying.
3. **Re-keying.** Re-splitting produces a new curve for the same seed, so an old backup
   still reconstructs. Only migrating to a new keypair truly revokes. Deferred by decision.
4. **Node backup durability.** Every fragment for every member lives on one disk. This is
   the whole availability story and it is not a keeper problem — it is an operations one.

### Settled 2026-08-10

**Hub-mandatory, and cross-node rescue is parked.** Making `A` mandatory means a dead node
is unrecoverable even with every friend willing. The alternative — fragments held on
keepers' devices so friends can restore someone onto a *different* node — is a real feature
for a federated network, and it is incompatible with hub-mandatory. Chosen anyway, because
today it costs nothing: every fragment already dies with the node, so hub-mandatory removes
no capability that exists. Worth revisiting if a real community ever folds.

**Build order.** The sign-in button first. `#220` and `#222` verify Google and Apple tokens
and no token has ever arrived, because nothing in any client can produce one. Every claim
about the SSO tier stays theoretical until that exists, and nothing decided here changes
it.

---

## Sign in with Apple & `auth.beanpool.org` Architecture (#240)

### 1. The Wildcard Constraint (Web / PWA Only)
Apple does **not** allow wildcard domains (`*.beanpool.org` or `*.<community-domain>`) for web-based Sign in with Apple (*Services IDs*). In standard OAuth web redirects, every target domain must be verified individually with Apple by serving a domain association file (`/.well-known/apple-developer-domain-association.txt`).

Because federated BeanPool nodes run on dynamic, self-hosted domains that cannot be allowlisted in advance in Apple's Developer Console, **browser-based OAuth redirects cannot land directly on arbitrary community nodes**.

### 2. Resolution & PWA Scope
- **Native iOS (`expo-apple-authentication`)**: Runs in-process via Apple's native ASAuthorization framework. Apple signs the OIDC `id_token` on-device and delivers it directly to the native app, which posts it to the community node (`/api/recovery/shares/sso`). **Native iOS SSO is completely unblocked and does not use or require `auth.beanpool.org` or web redirects.**
- **Web PWA (Sovereign Only)**: As settled in the recovery architecture, PWA members operate in sovereign mode with 12-word recovery phrases. The web-based OAuth redirect flow is therefore not required in production today.
- **Central Domain Reservation (`auth.beanpool.org`)**: `auth.beanpool.org` with callback `https://auth.beanpool.org/apple/callback` remains registered under Services ID `org.beanpool.web` in Apple's Developer Console as the designated central callback router if browser-based Apple authentication is ever introduced for web clients in the future.
- **No `.p8` Private Key Required**: Tokens are verified on nodes against Apple's public JWKS keys without client secrets. No long-lived server `.p8` private keys are used or maintained.

