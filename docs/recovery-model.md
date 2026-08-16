# Recovery model

**Status: designed, not built.** Agreed 2026-08-10. Nothing in this document describes
shipped behaviour unless the "What exists today" section says so. Where it contradicts
`docs/ONBOARDING.md`, this document wins and ONBOARDING.md is stale.

It supersedes the K1–K5 keeper numbering entirely. That scheme is gone; the tiers below
replace it.

---

## What recovery is for

A member's account **is** a keypair. The 12 words are that key written in English. There is
no password reset, because there is nobody holding a copy to reset it against.

Two different things can go wrong, and they need different answers:

| Failure | Answer |
|---|---|
| Lost the phone | keepers |
| Lost the community — node gone, or you want to leave | **the 12 words** |

Keepers get you back into *this* node. The 12 words get you into *any* node. Neither
replaces the other, and the product must stop implying that keepers make the words
optional.

---

## The construction

Two layers. This is the core of the design and everything else follows from it.

```
seed  =  A  ⊕  B

  A  →  the hub. Plaintext in the node's database. Released under D7.
  B  →  the members' half. Never readable by the node.
```

`A` is 32 random bytes; `B` is `seed ⊕ A`. Both halves are required — this is a 2-of-2 XOR,
not a threshold.

**Layer two** splits `B` again, with Shamir, across whoever holds it.

### Why two layers rather than one flat split

A single Shamir split of the seed across `hub + 5 friends` at threshold 3 lets **any three
shares** reconstruct — including three friends with no hub involvement, and including the
hub plus any two friends.

The XOR layer makes both sides structurally mandatory:

- The node holds `A` and can never reach `B`. It cannot recover anyone alone.
- All five friends together rebuild `B`, which without `A` is uniformly random noise.

This replaces the `MAX_HUMAN_KEEPERS = 2` cap (D13) with a property of the shape rather
than a policy constant. The cap is retired.

### Why Shamir stays

An XOR-only scheme cannot express a threshold — every share becomes mandatory, so adding a
sixth friend would make a member *less* recoverable, and a weighted share is meaningless.
Shamir with `threshold = n` reproduces XOR exactly, so nothing is lost by keeping it and
the upgrade paths below stay possible.

---

## The three tiers

### SSO — custodial by choice

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

That seal has to be **expensive**, and through 2026-08-09 it was not. `sealShareToSso` used
a single HKDF pass, justified in its own comment by the model this document replaces —
*"what that yields an attacker is ONE fragment, and the threshold is three."* Under `A ⊕ B`
it yields half of two, next to the other half, and a data-only attacker could test guesses
against the Poly1305 tag in microseconds. PR #248 moves it to scrypt at the same cost
`ssoLookupHash` already used for the same value. The raw `sub` itself is never stored — the
node keeps only a scrypt hash with a per-share random salt.

A Google `sub` is the same value handed to every OAuth client that user has ever signed
into — an identifier, not a secret. Apple's is scoped per developer team and genuinely
private. Neither is private *from the node*.

### Non-SSO — sovereign, recoverable

```
A  →  hub                                node reads it
B  →  Shamir 2-of-5 across friends       node reads nothing
```

Node reads one of two halves. The operator cannot recover these accounts.

**2-of-5 is the floor, not a preference.** At 1-of-5 a node operator who is also one of
the member's five friends — likely in a small community — holds `A` and a full copy of
`B`, and walks in alone. At 2-of-5 they still need a second friend.

2-of-5 also means three of the five can lose their phone, leave, or ghost, and the member
is still fine.

### Sovereign — 12 words only

Nothing is stored anywhere. Nobody can recover the member, including the member if the
paper is lost.

This is the **default** for a non-SSO member at signup, and it requires no work to
implement: with only the hub available there is nothing to split. It stays that way until
the member has picked friends.

### The 12 words, for everyone else

Decided 2026-08-10: **available in settings, never shown at signup** — for SSO members and
non-SSO members alike.

Showing them during onboarding reintroduces the exact friction this project exists to
remove, and most people tick the box without saving them anyway. Withholding them entirely
would make members captive to one node, and the words are the only thing that lets someone
leave — which makes them load-bearing for federation, not a power-user extra.

So: quiet, always reachable, and surfaced at the moment a member adds their first keeper —
when the difference between *this node* and *any node* is something they have context for.

---

## The upgrade path

An SSO member who adds friends moves `B` into a Shamir split alongside the sign-in piece:

```
B  =  Shamir 2-of-N over { sso, friend, friend, … }
```

| | Operator holding `A` | |
|---|---|---|
| SSO, no friends | `A` + `B` via the sub | **custodial** |
| SSO + one friend | `A` + one share of a 2-of-N | **locked out** |

One keeper flips a member from custodial to sovereign — and gives them a path with no
Google in it at all (two friends + hub). That is the whole education story, in one action.

The transition is a re-split, which already exists.

---

## Where the fragments actually live

Every fragment is a row in `recovery_shares` on the node's disk. Keepers hold the
*unwrapping key*, not the bytes.

| Fragment | Stored | Node can read |
|---|---|---|
| hub (`A`) | node | **yes** — `hubShareKey` was withdrawn 2026-08-08 |
| sso | node | only while it holds the `sub` |
| friend | node, `x25519-xc20p-v1` to their account key | **no** |

Consequences worth stating plainly:

- **Node death takes every fragment for every member at once.** Adding a friend does not
  change this. Node backup durability is the entire availability story.
- Making the hub mandatory therefore costs nothing that was not already lost.
- The 12 words are the only node-independent thing in the system.

### The PWA is excluded from the keeper system entirely

The "operator cannot recover a keepered account" guarantee holds because the native app is
served by the App Store and Play Store, not by the node.

**The PWA is served by the node.** A hostile operator can ship JavaScript that does
whatever they like. That breaks all three roles, not just one:

| Role on the PWA | What a hostile operator gets |
|---|---|
| Enrolling keepers | the seed, at the moment it is split |
| Approving as a keeper | the keeper's private key, or a forged approval |
| Recovering | the reconstructed seed, at the moment it is rebuilt |

So the rule is broader than "no keeper enrolment on the PWA" (decided 2026-08-10): **the
PWA does not enrol keepers, does not approve as a keeper, and does not run a recovery.**
Recovery is set up and used in the app, and the PWA says so.

**What this costs, stated rather than glossed (CR).** Browsers evict storage: Safari's ITP
caps script-writable storage at seven days without interaction, and any "clear browsing data"
takes the rest. A PWA member who never writes their 12 words down has no second chance —
there is no hub fragment and no friend to ask. That is a real loss mode, and it is the price
of the paragraph above rather than an oversight in it. The mitigation is not a keeper tier
it cannot safely have; it is that the PWA must ask for the 12 words early, insistently, and
must not present itself as a place where an account can safely live unbacked.

**PWA members are the sovereign tier**, always. 12 words, nothing stored, no exceptions —
including no SSO tier, since an SSO recovery in the browser hands the operator the seed
just as readily.

A guarantee that cannot be kept is worse than an absent feature. How loudly this needs
messaging depends on how many members are actually on the PWA, which is still unmeasured.

---

## Recovery flows

### SSO

```
1  enter callsign
2  sign in with Google or Apple
3  A ⊕ B → in
```

No PIN. No delay. **The sign-in is the authentication**, and this is the tier that traded
sovereignty for exactly this. A second factor here would guard against a strictly weaker
attacker than the node operator, who by the tier's own definition can already read the
account — and Google's own 2FA is better security than six digits anyway.

### Non-SSO

```
1  enter callsign
2  enter PIN (if set) → the friend list is revealed
3  ring two of the five and ask them to approve in settings
4  they approve; their pieces rebuild B, and the hub releases A instantly (D7)
5  A ⊕ B → in
```

### D7 assumed every split had a human in it

The rule as built: *the hub releases instantly if at least one human keeper has already
released, otherwise after 24 hours.*

That is exactly right for the non-SSO tier — a genuine recovery always has two friends
approving, so the hub is instant, and a request that nobody vouched for waits a day with
the owner alerted. The delay bites only when something odd is happening.

**In the SSO tier there are no humans, ever.** The condition that lifts the delay can never
be met, so the 24 hours would fire on *every legitimate recovery, permanently* — a fixed
tax on the one population that chose this tier to avoid friction.

Its protective value is also inverted there. The delay protects by giving the owner time to
see the alarm, which requires them to still have their phone. Someone genuinely recovering
does not.

So: **D7 unchanged for non-SSO, and not applied to the SSO tier at all.**

### The friend list, and what the PIN is actually for

Opening a recovery session is unauthenticated by design — anybody can mint a keypair, so
anybody can type a callsign. If the friend list were visible to whoever asks, a stranger
could harvest any member's five closest people by pretending to recover them.

That is the PIN's job, and its only job: **it reveals the keeper list.** It does not gate
the hub fragment — D7 already governs that, and correctly.

Which means **forgetting the PIN is not a lockout.** It costs the member the convenience of
being shown who to ring; they recover perfectly well by remembering. That is the whole
reason to put the PIN here rather than in front of `A`: a secret set once at signup and
first needed years later, on the day someone loses their phone, is a secret many people
will not have.

Return the **same error** for a wrong PIN and a callsign that does not exist, or the
endpoint becomes a way to enumerate the node's membership.

---

## The PIN

**Non-SSO only, optional, off by default.** Six digits, checked by the node — which is what
makes six digits sufficient.

```
2 free attempts, then one attempt per 15 minutes. Flat.
A correct PIN is always accepted immediately.
```

~96 guesses a day against 10⁶ — **28 years**. A progressive ladder was considered and
dropped; it bought nothing over the flat cap.

**Never a hard lockout.** A lockout converts into denial of service: an attacker burns the
attempts and the real member finds a locked door on the day they need it. A capped delay
means the member waits at most one interval, once.

Sustained hammering is an operations concern — log failed attempts server-side so an
operator can block an IP. Not a product feature.

### When it is set

Offered when the split becomes possible — the moment the second friend is added, alongside
the *"turn on recovery?"* consent question. Skippable, and changeable later from settings.

An earlier revision made it mandatory in both tiers and set it at signup for SSO members.
That was dropped on 2026-08-10 for two reasons: it asked people to price a risk they cannot
evaluate, and a mandatory PIN in front of `A` would have locked out more members through
forgetting than it ever protected from a stolen Google account.

---

## Notifications

**Keepers are not notified.** Removing them from the target list is a one-line change to
the `openCollection` handler.

The member is expected to ring two of their five. That makes silence meaningful — *if
nobody called you, there is nothing to do* — and it makes an unsolicited in-app prompt the
suspicious thing rather than the normal thing. A voice you know is harder to fake than a
push notification.

It also removes the thoughtless-tap path, where a keeper approves a plausible-looking
request without a moment's consideration.

**The owner is notified**, on one event only:

| Event | Notify |
|---|---|
| Wrong PIN | **no** — there is nothing the owner can do about it |
| Correct PIN | **yes** — *"Someone is recovering your account"* → **[Stop it]** |

**This table describes the non-SSO tier only, and the gap is worth naming (CR).** There, the
notice fires when the PIN is entered — before any friend has released — so **[Stop it]** has
real time to work. The SSO tier has no PIN and no delay: a sign-in *is* the recovery, so any
notice necessarily arrives after the seed is already reconstructable, and **[Stop it]** can
re-split for next time but cannot undo this one. That is not a flaw in the notification
design; it is the custodial trade being visible from a second angle. Anyone who finds it
unacceptable is really objecting to sign-in-and-you're-in, which is the decision to reopen.

"Change your PIN" was considered and rejected as an action: against uniform guessing a new
six-digit PIN is exactly as likely to be hit as the old one. It creates alarm and changes
nothing. **Only notify when there is something to do.**

The owner's alert has a useful property: in a genuine recovery it goes to a phone that is
already lost, so it is harmless noise. In a theft it lands on a phone the member is
holding. The signal self-selects for the case where the member can act.

### [Stop it] is real

Re-splitting invalidates a live collection — every release checks the generation the
session pinned when it opened. It kills the attacker's session mid-flight and turns every
fragment they were chasing into noise. It needs to be one tap from the notification, not a
settings expedition.

### Category

Recovery notifications currently ride the `escrow` push category, which means a member who
muted deal notifications has silently opted out. Recovery needs its own category — and one
that is deliberately hard to mute, because it is the only notification in the app where
silence costs someone their account.

---

## What each party can reach

| | SSO tier | Non-SSO tier | Sovereign |
|---|---|---|---|
| Cold DB / backup thief | nothing | `A` only | nothing |
| Node operator, passively | nothing | `A` only | nothing |
| **Node operator, deliberately** | **the account** | `A` only | nothing |
| All the member's friends | — | `B` only, which is noise | — |
| Hijacked Google account | **the account** — the sign-in is the authentication | — | — |

---

## Decisions, and what they replaced

**K1, the phone fragment — removed.** It only survived via OS cloud backup, which fails
silently and cannot be probed. A keeper that cannot confirm it holds a piece must not be
counted. It was also the only genuinely off-node fragment, so removing it makes recovery
entirely node-resident — a real cost, accepted knowingly.

**The inviter as a counted keeper — removed.** Same rule. The inviter is frequently
someone the member never meets again and has never been asked to hold anything. *"There is
a chance"* is not a recovery guarantee.

**`sso ×2 + hub` at threshold 3 — rejected in that form.** It gave the node three
node-readable fragments, making a stolen database a working master key for every member on
it. The two-layer construction and the `sub` sealing address the same goal without it.

**XOR replacing Shamir — rejected, adopted as a layer.** XOR is right for the mandatory
`A ⊕ B` split and wrong as the whole scheme: an XOR-of-all makes every keeper mandatory, so
each added friend makes a member *less* recoverable, and it cannot express a threshold or a
weighted share. Also, a deterministically derived SSO share cannot be rotated, which would
break re-splitting — the only revocation mechanism there is.

**D13's two-human cap — retired.** The two-layer shape enforces what the count was
approximating.

**A mandatory PIN in front of `A` — rejected.** It would have locked out more members
through forgetting — a secret set once at signup and first needed years later, on the day
they lose their phone — than it ever protected from a stolen Google account. The PIN
survives as an optional, non-SSO reveal of the keeper list, where forgetting it costs
convenience rather than the account.

---

## What exists today

**Merged and unaffected by this design:** fragment sealing (`keeper-crypto.ts`), the
on-device recovery self-check, the server deposit/summary/delete routes, collection and
release, generations and the re-split invalidation, the push infrastructure.

**Merged and correct as-is:** D6/D7. It needs no change — only a note that it is not
applied to the SSO tier, where no human keeper can ever satisfy its instant-release
condition.

**Merged and changing:** native keeper enrolment (drop the device path, drop the inviter,
add the XOR layer), `recovery-shares.ts` (drop the human cap, drop `'device'` from the
holder types), the protection panel copy, `schema.sql`.

**Changed by this design and already done:** PR #248 moves the sign-in fragment's key
derivation from one HKDF pass to scrypt, because `A ⊕ B` made the old justification false.
Both `sealShareToSso` and `openShareFromSso` are now async.

**Built since (2026-08-11, PR #250):** the Apple sign-in client, and a probe that ran the
whole chain on hardware — a node-issued nonce, Apple's sheet, and the node verifying a real
token against Apple's live JWKS. Apple echoes the nonce **verbatim**. See
`docs/sso-client-handover.md`.

**Not built at all:**

- Google sign-in. `startSsoSignIn` throws a named `unsupported` rather than pretending.
- The restore flow client. The server half is complete; there is no client code.
- Add-a-friend — now the *only* recovery route for non-SSO members.
- The PIN, in any form.
- The two-layer split itself. Enrolment still writes the old shape.

### `RECOVERY_THRESHOLD`, and what it does not count

Its meaning changes: it becomes the threshold of **layer two only**, and its value drops
from 3 to 2.

Spelled out because a reviewer read the drop as "any 2 of {hub, sso, friends} reconstructs"
and called it a downgrade (CR). It is not, and the difference is the whole point of the two
layers: **the hub is never a share in the threshold.** `A` is XOR-mandatory and sits outside
the count. Two friends reaching threshold yields `B` and nothing else; `B` without `A` is
noise. There is no combination of counted shares that reconstructs a seed on its own.

The one case where an operator does get in is the SSO tier, and that is not the threshold
doing it — it is the `sub` arriving in plaintext during verification, stated plainly above
and chosen deliberately.

### Migration

Not optional, and not covered by the sections above (CR).

- `RECOVERY_THRESHOLD` is read by live code and stored per-request as
  `recovery_requests.quorum_required`. Changing the constant does not change rows already
  written, so an in-flight recovery keeps the old quorum and a new one gets the new — decide
  explicitly which wins rather than discovering it.
- `recovery_shares.holder_type` carries a `CHECK` constraint. Any new or retired holder type
  needs the constraint rebuilt in the same migration, or inserts fail at runtime rather than
  at deploy.
- **Today this is free, and that is the whole reason to do it now.** No member has ever
  deposited a fragment — the probe deliberately sends a wrong nonce so it cannot. The moment
  enrolment ships, every one of these becomes a data migration instead of a schema edit.

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

