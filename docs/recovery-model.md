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

A sign-in copy has two locks: the app's, and the node's around it.

```
the app's lock   seed (+ the 12 words)  under  scrypt(provider:sub, salt)   sealSeedToSso, scrypt-xc20p-single-v1
the node's lock  that whole copy        under  data/recovery-seal.key       recovery seal S1 #1178, S2 #1185
```

**The app's lock** (unchanged since #750 on the phone, and the same bytes from the global node's
browsers since G11-c): `sealSeedToSso` in `packages/beanpool-core/src/keeper-crypto.ts` seals the
whole 32-byte seed, and the 12 words when the device has them, under one key,
`scrypt(provider:sub, salt)` (N = 16384). The salt, the scrypt cost and the words box sit beside it
in `kdfParams`. There is no hub half. The only secret in it is the `sub`.

**The node's lock** (the recovery seal; design `scratch/global-node/DESIGN-sso-seal-db-fable.md`
option B, Marty 2026-09-26, card sso-copy-lock), in `apps/server/src/services/recovery-seal-key.ts`:

- **The key** is `data/recovery-seal.key`: 32 random bytes, 0600, beside `libp2p_key`, never in the
  database. A main server makes it at boot when it has none; a standby never makes one. It is read
  on every use, so a key deleted while the server runs is gone at once.
- **The wrap** is XChaCha20-Poly1305 under HKDF-SHA256(key, `beanpool-recovery-row/v1`), with a
  random 24-byte nonce per row. Its plaintext is the JSON of the app's four fields
  (`encryptedShare`, `shareIv`, `shareTag`, `kdfParams`), so the words box is inside it too. The
  row stores the wrap's ciphertext, nonce and tag, and
  `kdf_params = {"alg":"node-wrap-xc20p-v1","inner":"<the app's alg>"}`. The lookup hash and its
  salt stay in the clear: they find the row and reveal nothing.
- **Bound to where it sits** (AAD): a stored copy to (owner, holder type); a released copy in
  `recovery_releases` to (collection, share id, holder type). Never the generation, so a
  carry-forward can write the same copy into the next one.
- **Where:** `engine/recovery-shares.ts` wraps in `putShareGeneration`, after every check has run
  on the app's bytes, and `rowToShare` unwraps. The release path reads through the same reader.
  A released copy is stored wrapped, and unwrapped only when `/api/recovery/collect/fragments`
  serves it. `sync.ts` and the snapshot export copy rows without opening them.
- **No key, no copy:** without the key file, deposits, collect/sso, fragments, status and
  disconnect answer 503 with *"This server holds sign-in recovery copies it cannot open:
  data/recovery-seal.key is missing."* Nothing is ever stored unwrapped.
- **Copies made before the seal** are wrapped in place at the first boot of the new server, and
  each server then runs one `VACUUM`, so the copies it had already deleted are gone from
  `state.db`'s free pages. From then on the connection runs with `secure_delete = ON`.
- **Where the key travels:** only inside the take-over bundle (`BUNDLED_FILES` in
  `takeover-envelope.ts`), so only inside the take-over envelope and a sealed backup. A take-over
  and a sealed-backup restore install it. It is never in a sync payload, a snapshot, a plain backup,
  a log line or an HTTP answer.
- **A server that already holds a different key** (a standby that was once a main server) keeps
  it as `recovery-seal-retired-<id>.key`. The reader tries it when the live key does not open a
  row, and the next boot locks those rows again with the live key.
- **Keys without it** (an envelope or sealed backup made before S2, or a plain backup restored on
  another machine): the take-over or restore goes on, the server makes a key of its own, and the
  copies it inherited don't open. Members' 12 words still work, and connecting the sign-in again
  makes a new copy (a deposit leaves out the rows this key cannot open).

The apps changed nothing for this: `sso-share-vectors` and `test-sso-recovery-roundtrip` are
unchanged, which is the proof.

**Before #750** the phone made two-part copies, `seed = A ⊕ B`: `A` (the hub) in the clear in the
node's database, `B` sealed to the `sub`. #750 replaced them for correctness (an unauthenticated
XOR gave silent wrong seeds, #489), not for security: `A` never protected against anyone holding
the database. The server still serves such copies, and the seal wraps their rows the same way.

The former layer that split `B` with Shamir across human friends/guardians was scrapped in
September 2026. Zero human-keeper shares exist on live nodes, and all client entry points have
been removed.

---

## The two recovery paths

### 1. SSO — custodial by choice (phones; the global node's browsers)

**The node operator can open these copies.** This is a deliberate trade, taken
2026-08-10: stability over sovereignty for people who would otherwise have no recovery at
all. It is stated in the product, not buried (Marty, 2026-09-26, card sso-copy-lock, D-2 = a):
the members' guide (`settings/recovery.md`, "Who can open the copy") and, under a connected
sign-in, the phone's Account Protection screen and the web app's Settings say that the people
who run the community's server can open the copy, that a stolen copy of its database can't,
and (where the device has the 12 words) that only the words keep everyone else out.

The two locks earn their place against anyone holding only the *data*: the node's lock
against a stolen database, a snapshot, a plain backup, a standby's disk or a decommissioned
disk (see [The construction](#the-construction)); the app's lock against anyone who also has the
key file but not the member's `sub`. Neither locks out an operator who decides to, because the
operator's process holds the key and the `sub` arrives in every id_token it verifies.

The app's lock is scrypt, at the same cost `ssoLookupHash` uses for the same value. The raw
`sub` itself is never stored: the node keeps only a scrypt hash with a per-copy random salt.

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

## Where the copies actually live

Each sign-in copy is one row in `recovery_shares` on the node's disk. Every copy a recovery
released is also kept, for good, in `recovery_releases`: that table is the record of each
recovery, permanent by design (`pruneCollectionsFor` in `engine/recovery-release.ts` never deletes
a collection that released anything). Every row in both is wrapped with `data/recovery-seal.key`:

| Row | Stored | Node can open |
|---|---|---|
| sign-in copy (single-blob: every copy made since #750) | node, wrapped | the node's lock always, with the key file; the app's lock only with the member's `sub`, which arrives at a verified sign-in |
| hub (`A`, two-part copies from before #750) | node, wrapped | **yes**, with the key file: `hubShareKey` was withdrawn 2026-08-08 |

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

**Except on the global community (G11-c, decided 2026-09-25, D-1 = a).** A browser member of
`global.beanpool.org` joins with a sign-in (Google, Apple, GitHub or Facebook), and the same join
enrols that sign-in as their recovery: the page seals the account's seed and its 12 words to the
sign-in's `sub` with `sealSeedToSso`, and the door stores the copy from the sign-in it has just
verified, exactly as the phone's global join does (the two clients build the same bytes; see
`@beanpool/core/sso-share-vectors`). Neither reason above holds for that one node. The web app
there is shipped by us, on a domain we run, so "a hostile operator can ship JavaScript" is the
custodial trade-off every SSO member already accepts on a phone, not a new one: the copy is the
same single-blob seal (`scrypt-xc20p-single-v1`) the phone has made since #750, with no hub
fragment, and its only secret is `provider:sub`, which the operator receives on every sign-in.
For GitHub that `sub` is public, so a GitHub-sealed copy is open to anyone holding the database
(see [What each party can reach](#what-each-party-can-reach)). And it is one fixed domain, not a
dynamic community domain, so the providers' redirect and Services ID rules are met once, in their
consoles. Local communities' web apps stay 12-words only. A seal that fails, or a copy the node
cannot store, never blocks the join; the member then has the 12 words, and Settings says the
sign-in is not connected.

**Restoring with that sign-in in a browser (G11-d).** A cleared or new browser on the global
community gets the account back with the sign-in it joined with, through the same recovery
routes the phone uses (`routes/recovery-collect.ts`, unchanged): the public callsign lookup names
the account and its public key, a throwaway key made for the restore opens the session and signs
every call in it, Google/Apple/Facebook leave the page and return to the join's own return page
(`/app/auth/<provider>`, Apple via the node's 303), GitHub is the node's device flow, and core's
`openSeedFromSso` opens the released copy in the page (`apps/pwa/src/lib/web-restore.ts`). The
restored key must equal the public key the lookup named, or nothing is saved: a check the phone's
restore does not make. The 12 words are kept only when the web app's own derivation of them makes
that key. The account is then saved as a 12-words restore is: the node asked whether it is a
member, a join this browser sent settled first, and the identity store's guarded write, which
never replaces another account. The web opens only the single-blob copy; an older two-part one is
said plainly, with the words and the phone as the ways back.

---

## Recovery flows

### SSO (Native, and the global community's web app)

```
1  enter callsign
2  sign in (Google, Apple, Facebook or GitHub)
3  the node verifies it, unwraps the copy and releases it; the device opens it with the sub → in
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

With the recovery seal (S1 #1178, S2 #1185), on a server that has run the upgrade's first boot:

| | SSO tier (phones; the global node's browsers) | Sovereign (12 words) |
|---|---|---|
| A copy of the database: a stolen or decommissioned disk, a snapshot, a plain backup, a standby's disk | **nothing**, for every provider | nothing |
| The sign-in provider (Google, Apple, GitHub, Facebook), from what it holds | nothing: it has the `sub` but none of our data | nothing |
| Node operator, passively | nothing | nothing |
| **Node operator, deliberately** | **the account**, and its 12 words when the copy carries them | nothing |
| **A hijacked sign-in account** (or a provider signing in as the member) | **the account**, through the recovery routes while the server runs: the sign-in is the authentication. The member's devices are told a recovery started | nothing |

**Why the operator, deliberately.** The operator's process holds `data/recovery-seal.key` and
receives the `sub` in every id_token it verifies (`apps/server/src/sso.ts`), so logging one
sign-in is enough to open that member's copy. For GitHub it does not even need a sign-in: the
node's `sub` is the public numeric user id (`readGithubUser` in
`apps/server/src/engine/github-device.ts`), one lookup from the member's GitHub name. Google's
`sub` is the same value every OAuth client the person has used receives. Apple's is scoped to
BeanPool's developer team. (Facebook's scope is not checked here.) "The operator" is anyone who
holds the database **and** the key:

- whoever runs the machine, or has a copy of the whole `data/` folder;
- whoever opens a **sealed backup**: its take-over bundle carries the key, and it opens with the
  recovery code or any one owner's phone;
- a standby, once it takes over: the take-over bundle installs the key.

**Why a copy of the database, nothing.** The key is never in the database, so never in a sync
payload, a snapshot, a snapshot download or a plain backup (`state.db`, `node_config.json` and
images: `sealed-backup.ts`). A standby holds the main server's wrapped rows and no key until it
takes over. What such a copy holds opens only with the key and the `sub` together.

**What is still open.**

- **Copies made before the upgrade.** Snapshots, backups and copies of the data folder made
  before a server first booted with the seal hold the copies as the app sealed them, openable with
  the `sub` alone (for GitHub, by anyone who holds the file). No code reaches files that already exist; the operator
  manual (`operators/server/backups-and-replicas.md`, "Backups made before the recovery seal")
  tells operators to delete them.
- **Disconnecting a sign-in deletes its row in `recovery_shares`, not the copies earlier
  recoveries released**, which stay wrapped in `recovery_releases`, nor the ones in snapshots and
  backups. The operator can still open those. The members' guide says so.
- **A copy deleted after the seal reaches a standby** (#1197): `deleteAllShares` writes a
  `recovery_shares` tombstone keyed `<owner>|<generation>`, the standby deletes that member's copies
  of that generation or older stamped no later than the deletion (a copy re-deposited after it is
  kept), and every start re-applies the tombstones a standby has recorded
  (`applyRecordedRecoveryTombstones`). Two limits remain: a standby offline for longer than the
  tombstone retention (30 days) needs a force-resync, and a member removed by an admin or a vote
  (`adminPruneUser`) keeps their copies on both servers, so a reinstatement can bring them back
  (card removed-member-delete).
- **The operator.** Only a secret the server never sees would lock the operator out: a passkey
  with the PRF extension (design option C). It cannot cover the old Android phones this app is
  for, so it could only ever sit on top, as an opt-in. Marty, 2026-09-26 (D-3 = a): not now;
  revisit after launch, web first.

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
`A ⊕ B` construction where `A` is the hub fragment and `B` is sealed to the SSO provider `sub`,
itself replaced by the single-blob copy in #750.

**The recovery seal — taken 2026-09-26 (Marty, card sso-copy-lock).** A sign-in copy's only
secret was the `sub`, and GitHub's is public, so any copy of the database opened every
GitHub-linked account in it. D-1 = a: the node locks every copy with a key kept outside its
database, with no app change (S1 #1178, S2 #1185). D-2 = a: say plainly that the server's
operators can open the copy (S3). D-3 = a: a passkey lock later, not now.

**A mandatory PIN in front of `A` — rejected.** It would have locked out more members through
forgetting than it ever protected. The PIN table is unused and no recovery route checks it.

---

## What exists today

- **12-word seed phrase**: BIP-39 mnemonic recovery implemented across both Native (`apps/native`)
  and PWA (`apps/pwa`). Sovereign, node-independent, works everywhere.
- **SSO recovery (phones; the global node's browsers)**: Google, Apple, Facebook and GitHub, one
  single-blob copy per sign-in (`sealSeedToSso`), wrapped on the node with
  `data/recovery-seal.key` (see [The construction](#the-construction)). Copies made before #750
  are two-part (`A ⊕ B`) and still served.
- **`RecoveryAlertBanner`**: Rendered on both Native and PWA to alert members to active recovery
  sessions via `/api/recovery/collect/mine` and allow cancellation via `/api/recovery/collect/cancel`.
- **Scrapped**: Friend keeper enrolment, guardian approvals, recovery PINs, and 3-of-N social
  recovery. All client entry points have been removed. Server-side helper functions remain
  unreferenced so the decision can be reversed without a migration if ever desired.

---

## Open questions

1. ~~**Does the node persist the raw `sub`?**~~ **Answered 2026-08-11: it does not.**
   `ssoLookupHash` stores a scrypt hash with a per-share random salt and the raw value is
   never written. That alone never protected a GitHub copy (its `sub` is public); since the
   recovery seal (2026-09-26) the cold-database protection rests on `data/recovery-seal.key`,
   for every provider. The `sub` still arrives in plaintext during verification, which is why
   the operator is not locked out.
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

