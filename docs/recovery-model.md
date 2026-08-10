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

  A  →  the hub. Plaintext in the node's database. Released on PIN.
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

**PWA members are the sovereign tier**, always. 12 words, nothing stored, no exceptions —
including no SSO tier, since an SSO recovery in the browser hands the operator the seed
just as readily.

A guarantee that cannot be kept is worse than an absent feature. How loudly this needs
messaging depends on how many members are actually on the PWA, which is still unmeasured.

---

## Recovery flows

Both tiers need the PIN — it releases `A`, and nothing works without it.

### Non-SSO

```
1  enter callsign + PIN          ← nothing opens without the PIN
2  friend list is revealed        ← gated behind the PIN, see below
3  ring two of the five and ask them to approve in settings
4  they approve; their pieces rebuild B
5  A ⊕ B → in
```

### SSO

```
1  enter callsign + PIN
2  sign in with Google or Apple
3  A ⊕ B → in
```

### Why the friend list sits behind the PIN

Opening a recovery session is unauthenticated by design — anybody can mint a keypair, so
anybody can type a callsign. If the list of names were visible before the PIN, a stranger
could harvest any member's five closest people by pretending to recover them.

The PIN is required anyway, so gating the reveal behind it is free. The rate limit then
protects the social graph as well as the fragment.

Return the **same error** for a wrong PIN and a callsign that does not exist, or the
endpoint becomes a way to enumerate the node's membership.

---

## The PIN

Six digits. Checked by the node, which is what makes six digits sufficient.

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

At **split time**, not signup. The PIN guards `A`, and `A` does not exist until a split
happens.

- **Non-SSO:** when the second friend is added and the split becomes possible. Same moment
  as the consent question — *"turn on recovery?"*
- **SSO:** at signup, because their split happens immediately. The frictionless tier gains
  one screen, unavoidably: without the PIN, a Google account takeover is the whole account.

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
| Hijacked Google account | `B` only — PIN still required | — | — |

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

---

## What exists today

**Merged and unaffected by this design:** fragment sealing (`keeper-crypto.ts`), the
on-device recovery self-check, the server deposit/summary/delete routes, collection and
release, D6/D7, generations and the re-split invalidation, the push infrastructure.

**Merged and changing:** native keeper enrolment (drop the device path, drop the inviter,
add the XOR layer), `recovery-shares.ts` (drop the human cap, drop `'device'` from the
holder types), the protection panel copy, `schema.sql`.

**Not built at all:**

- Any sign-in button in the client. Every claim about the SSO tier is theoretical until
  this exists, and it is unaffected by every decision in this document.
- The restore flow client. The server half is complete; there is no client code.
- Add-a-friend — now the *only* recovery route for non-SSO members.
- The PIN, in any form.

`RECOVERY_THRESHOLD` changes meaning: it becomes the threshold of layer two only, and its
value drops from 3 to 2.

---

## Open questions

1. **Does the node persist the raw `sub`?** If it does, the SSO tier's cold-database
   protection evaporates. This gates the SSO row of every table above and has not been
   checked.
2. **How many members are on the PWA?** The decision above excludes them from recovery
   entirely. Unmeasured, and it determines how loudly that needs saying.
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
