# SSO client handover — 2026-08-11

**Read this before touching recovery, keepers, or Sign in with Apple.**

You are picking up mid-build. The design was settled on 2026-08-10, three PRs are open and
unreviewed, the server half has been merged since 2026-08-07, and on 2026-08-11 the sign-in
chain ran on real hardware for the first time. What remains is one short verification step
and then the main build.

---

## 1. What we are building, and why

BeanPool accounts are Ed25519 keypairs. Lose the key, lose the account — and lose the beans,
the trades, and the standing in a community. The recovery model exists so that losing a
phone is not the same as losing a life in the community.

The design is in **`docs/recovery-model.md`** (PR #249). Read it in full — this handover
summarises it but does not replace it.

### The core construction

```
seed  =  A  ⊕  B
  A  →  the hub. Plaintext in the node's database. Released under D7.
  B  →  the members' half. Never readable by the node.
```

XOR on top makes **both halves mandatory**. Shamir underneath splits `B` and gives *any k of
n*. This is the whole trick: the node alone can never recover anybody, and all the friends
together can never recover anybody either. It is structural, not a policy constant — which is
what retired the old "D13 two-human cap".

### The three tiers

| Tier | Shares stored | Node can read | How you recover |
|---|---|---|---|
| **SSO** | `sso` (sealed to provider `sub`) + hub | 1 of 2 | sign in — nothing else |
| **Non-SSO** | hub + Shamir 2-of-5 across friends | 1 of 2 | ring any two friends, they release |
| **Sovereign** | none | 0 | 12 words |

**The SSO tier is custodial by deliberate choice.** The node operator *can* get into an SSO
member's account. That was decided knowingly on 2026-08-10: normal users get stability, and
sovereignty is offered as an upgrade path rather than a prerequisite. Do not "fix" this
without re-opening the decision with Marty.

### Decisions that are easy to get wrong

- **The PWA is excluded from the keeper system entirely** — cannot enrol, approve, or
  recover. PWA users are **12-word sovereign only**. Confirmed again by Marty 2026-08-11:
  *"PWA is an edge case — the far greater % of users will be native."* This means **native is
  the entire SSO surface**.
- **Keepers get no push notification.** The member rings 2 of their 5 friends by phone and
  asks. Silence is the signal — an unexpected notification would train friends to tap
  "release" without thinking, and would tell an attacker who to target.
- **The PIN is not a gate.** It is non-SSO only, optional, and reveals the *keeper list*
  rather than unlocking `A`. Forgetting it costs convenience, not the account.
- **12 words are offered in settings, never at signup.**
- **`RECOVERY_THRESHOLD` changes meaning** — it applies to layer two only, and goes 3 → 2.
- **D7** (hub releases instantly iff ≥1 human keeper released, else 24h) assumed every split
  contains a human. The SSO tier has none, so D7 is unchanged but **not applied there** —
  otherwise its 24h delay would fire on every legitimate SSO recovery forever.

`docs/ONBOARDING.md` describes an **older** keeper model in the present tense. It carries a
superseded pointer at the top. Trust `docs/recovery-model.md`.

---

## 2. State of play

### Merged to `main` (server side, complete)

PRs **#223, #224, #230, #232** — all merged 2026-08-07.

- `apps/server/src/sso.ts` — `issueNonce()` (single-use, in-memory, 10-min TTL, member-bound),
  `verifyIdToken()` (audience, JWKS, expiry, nonce), `ssoLookupHash()` (scrypt N=16384,
  per-share salt). **The raw `sub` is never stored.**
- `apps/server/src/routes/keepers.ts` — `POST /api/recovery/sso-nonce`,
  `POST /api/recovery/shares`, `POST /api/recovery/shares/sso`,
  `GET /api/recovery/keepers/:callsign`
- `apps/server/src/engine/recovery-release.ts` — `COLLECTION_TTL_MS` 72h, `HUB_DELAY_MS` 24h
- Audiences configured: `BEANPOOL_APPLE_BUNDLE_ID = 'org.beanpool.pillar'`,
  `BEANPOOL_APPLE_SERVICES_ID = 'org.beanpool.web'`, 4 Google client IDs

### All merged 2026-08-11

| PR | What |
|---|---|
| **#248** | SSO seal key: one HKDF pass → scrypt, **plus a cost ceiling** (below) |
| **#249** | the design doc |
| **#250** | client half of Sign in with Apple + the `apple-probe` screen |
| **#251** | CR follow-up on the doc: migration section, PWA cost, threshold clarification |

**The ceiling in #248 is the one to understand.** `N` had a floor but no cap. scrypt allocates
about `128 * N * r` bytes, so a fragment claiming `N = 2^24` asks for ~17 GB — and the party
allocating it is the **member's phone**, opening a fragment the node just handed it, mid
recovery. A hostile node could have turned every restore into an OOM crash that reads as a
broken app. Capped at 65536, four times what sealing writes, so raising the cost later needs
no opener change.

### The clean slate is verified, not assumed

Every plan here rests on "no fragment has ever been deposited", which is what makes changing
the split shape a schema edit rather than a data migration. **Checked 2026-08-11 against the
live database, read-only:**

| Node | `recovery_shares` | `members` |
|---|---|---|
| **mullum** (the live community) | **0** | 32 |
| test | 0 | — |

bris and bindarrabi were not checked; both are effectively empty and neither has ever run
enrolment, but if you are about to rely on this, check them. Recipe in §7.

**Re-check this before the enrolment rewrite lands.** It is one query, and it is the single
assumption whose failure would strand real people's recovery.

### Not built at all

- Any enrolment under the two-layer model. The client keeper code that exists predates it.
- Google sign-in. `startSsoSignIn` throws `unsupported` for `'google'` — deliberately loud.
- The PIN, the add-a-friend flow, the copy pass.
- Node backup durability for the hub fragment.

---

## 3. What was proven on hardware, and what was not

On 2026-08-11 a signed Debug build ran on a physical iPhone against the live test node.

**Proven:**

| | |
|---|---|
| Node issues a nonce to a signed request | ✅ |
| `buildSignedHeaders` produces signatures the node accepts | ✅ |
| App carries a working `applesignin` entitlement | ✅ |
| Apple's sheet completes and returns an `id_token` | ✅ |
| Token audience is `org.beanpool.pillar` | ✅ |
| Nonce echoed **VERBATIM** (not hashed) | ✅ |

| Node verifies a real token against Apple's live keys | ✅ |

The last one was closed by section 4 of the probe, which sends the token with a **deliberately
wrong nonce**. `verifyIdToken` checks the nonce *last*, so a rejection there proves the JWKS
fetch, the RS256 signature, the issuer, the audience and the expiry all held — while storing
nothing, so no fragment is created for #248 to have to migrate.

**Watch for this trap if you extend the probe:** `sso.ts` phrases that rejection as *"Apple
sign-in could not be matched to this request"* and never uses the word "nonce", deliberately —
a member-facing sentence should not name an internal mechanism. The first live run therefore
reported `STOPPED EARLIER` on what was actually a pass.

**Still not proven:**

> `ssoLookupHash` and the storage path have never run against a real token.

They execute only *after* a correct nonce, which the probe deliberately never sends. They are
covered by unit tests, and they are local code with no external dependency — so this is a much
smaller gap than the one that just closed, but it is not zero.

### On the VERBATIM result

Apple echoed the raw nonce on iPhone XR / iOS 18.7.9 / `expo-apple-authentication`. The
server tolerates both raw and SHA-256 (`nonceMayBeHashed`).

**Do not delete the hashed branch.** One reading, one OS version, one SDK, one provider.
Google on Android is unmeasured. Delete it only when every provider we ship has been
measured. The measurement is recorded in the header comment of
`apps/native/utils/sso-signin.ts`.

---

## 4. The environment

### Paths

- **Worktree (branch `feat/apple-signin`)**:
  `/private/tmp/claude-501/-Users-marty-projects-beanpool/83d84cc3-4d8b-499a-a925-08fa9538a18a/scratchpad/phaseb`
  Under `/private/tmp`. If it is gone, re-create it from PR #250 — nothing is lost.
- **Marty's own repo**: `/Users/marty/projects/beanpool`, on branch `fix/ci-hang` with
  uncommitted changes. **Leave it alone.** A second autonomous Claude agent shares that tree
  and commits to `main`; HEAD is shared, so files can change mid-read.
- Metro must be run from `apps/native`, **not** the monorepo root.

### The test node

- `test.beanpool.org` is **node 11**, and the only data node we use.
- Redeploy: `DEPLOY_PULL=1 bash deploy.sh 11`
- **`mullum` is a live community. Never test or deploy against it.**

### The device

| | |
|---|---|
| Phone | Gabriela's iPhone XR, iOS 18.7.9 (Marty's partner's — ask before using) |
| UDID | `00008020-00161D201128402E` |
| Apple team | `485XM2R33S`, displayed in Xcode as **"Cytec Pty Ltd"** |
| Wrong team | `6BVG9SQ5VC` / Solar Cutter Solutions — not this project |
| Bundle ID | `org.beanpool.pillar` |
| Probe route | `beanpool://apple-probe` |
| App deployment target | iOS 15.1 |

---

## 5. Traps that have already cost hours

1. **`deploy.sh` ships your working tree.** A plain `deploy.sh` local-builds whatever tree it
   is pointed at, on any branch, silently. `DEPLOY_PULL=1` is the only path to the CI image
   from `main`. The test node sat 3 days stale while we debugged client code that was fine.
   **Verify by grepping the running image, not the version string.**
2. **`-allowProvisioningUpdates` does not register devices.** It creates certificates and
   profiles only. Device registration happens **only** via the Xcode GUI or the developer
   portal. Apple documents this nowhere. Every headless build attempt failed on this.
3. **Signature middleware runs before routing.** A 401 from an unsigned request proves
   *nothing* about whether a route exists. Plain-text `Not Found` is Koa's default and means
   the route is genuinely absent.
4. **`codesign -d --entitlements` on a Simulator build misleads** — Simulator builds are
   ad-hoc signed, so entitlements that are present in the project may not show. Check a
   device build, and check the **signed binary**, not the source `.entitlements` file.
5. **The phone must be unlocked** or `devicectl` launch fails with `Locked`.
6. **`npx expo run:ios` from the monorepo root fails** with "Unable to resolve module
   ../../App" — the root `package.json` has no `main`, so Expo falls back to the legacy
   `AppEntry.js`. Run it from `apps/native`.
7. **`@beanpool/core` `dist` is git-ignored and shared across branches.** Rebuild core after
   switching branches or stale-dist `tsc`/test failures appear.
8. **Native JS changes need a rebuild.** Marty tests standalone builds, not dev-client +
   Metro. Never tell him a native change can be tested without rebuilding.

---

## 6. Next steps, in order

### Steps 1–3 — ~~verify a real token, merge #248/#249/#250~~ DONE 2026-08-11

All four PRs merged. Section 4 of the probe verified a real Apple token. See §3.

### Step 4a — the two-layer primitive (DO THIS FIRST, it is self-contained)

Build **only** this before touching enrolment. It changes no existing behaviour, it is
exhaustively testable, and everything later sits on it. If work stops after 4a, nothing is
left broken.

**Where things already are** — read these before writing anything:

| File | What it has |
|---|---|
| `packages/beanpool-core/src/recovery-split.ts` | `RECOVERY_THRESHOLD = 3`, `splitRecoveryPhrase(phrase, shareCount)`, `combineRecoveryPhrase(shares)`, `assertRecoveryCsprngAvailable()`, envelope version + 4-byte checksum |
| `packages/beanpool-core/src/keeper-crypto.ts` | the per-holder sealing: `sealShareToMember` / `openShareAsMember` (x25519), `sealShareToSso` / `openShareFromSso` (scrypt, **async**), `recordShareForHub` / `readHubShare` (plaintext) |

Note the existing Shamir API is **phrase-level**, not bytes-level. Layer two needs to split
`B`, which is bytes. Add a bytes-level pair beside the phrase-level one reusing the same
Shamir core and the same envelope/checksum — do not fork a second implementation, and do not
change the existing phrase-level signatures (the sovereign tier still uses them).

**What to build.** A new module, `packages/beanpool-core/src/two-layer-split.ts`:

```
splitTwoLayer(phrase, friendCount)  ->  { hubShare, friendShares }
combineTwoLayer(hubShare, friendShares)  ->  phrase
```

Construction, and every part of it is load-bearing:

1. `A` = fresh random bytes the same length as the secret payload, from the same CSPRNG the
   existing code asserts on. **`A` is the hub share.** It is not a Shamir share and is never
   counted in any threshold.
2. `B = secret XOR A`. Both halves mandatory: `A` alone is noise, `B` alone is noise.
3. Shamir-split `B` across `friendCount` shares at **threshold 2**.

**Invariants the tests must actually assert** (not just round-trip):

- `A` alone reconstructs nothing, and `B` alone reconstructs nothing.
- **All** friend shares together, without `A`, reconstruct nothing. This is the property that
  makes friend collusion structurally impossible, and it is the one a naive flat-Shamir
  implementation silently loses.
- Any 2 friend shares **plus** `A` reconstruct the phrase; 1 friend share plus `A` does not.
- Round-trip survives the envelope/checksum path unchanged.
- Two calls on the same phrase produce different `A` and different shares.

**On `RECOVERY_THRESHOLD`.** It becomes the threshold of **layer two only** and drops 3 → 2.
Do not reuse the existing constant for both layers — the sovereign/phrase path still means the
old thing. Introduce the layer-two constant explicitly rather than mutating the old one in
place, and check every existing reader of `RECOVERY_THRESHOLD` before changing its value.

### Step 4b — the enrolment rewrite (only after 4a is merged) ← **NEXT after 4a**

This is the large one, and it is the one everything else waits on. `seed = A ⊕ B`, then Shamir
on `B`. Touches enrolment, the keeper panel, and `RECOVERY_THRESHOLD` semantics (3 → 2, layer
two only). The existing client keeper code predates the model and should be rewritten, not
patched.

**Do this before Google.** Google sign-in adds a second provider to a flow that still deposits
the *old* share shape — so building it first means writing the deposit path twice and having
two providers to re-verify instead of one. Apple already proves the whole chain end to end;
Google adds reach, not knowledge. Reach is worth less than not doing the work twice.

Sequencing note: the migration is free only while `recovery_shares` is empty everywhere
(§2). This step is what closes that window, so re-check the counts immediately before it
lands, not weeks earlier.

### Step 5 — Google sign-in on Android, and measure its nonce echo

Marty chose the **native Google library**, not a web flow. `startSsoSignIn` already throws a
named `unsupported` error for Google so it fails loudly rather than appearing to work.

Two things to establish, and neither is guesswork once the button exists: whether Google
echoes the nonce **verbatim or hashed** (Apple was verbatim — measure, do not assume they
match), and that a Google `sub` verifies against the four configured client IDs in `sso.ts`.
Until Google is measured, the `nonceMayBeHashed` tolerance stays.

### Step 6 — the PIN (non-SSO only), the copy pass, add-a-friend

### Step 7 — node backup durability for the hub fragment

Every fragment lives on the node. **Backups are availability; guardians are sovereignty.**
Do not confuse the two — keepers do not protect against node loss, and if the node's disk is
gone the member has nothing to connect to anyway.

### Also outstanding

**The recovery push notification currently rides the `'escrow'` category**
(`apps/server/src/routes/recovery-collect.ts:154`). Anyone who muted deal notifications has
silently opted out of recovery alerts. It needs its own category.

---

## 7. Verification recipes

**Build and install to the device** (from the worktree's `apps/native`):

```bash
xcodebuild -workspace ios/BeanPool.xcworkspace -scheme BeanPool -configuration Debug \
  -destination "id=00008020-00161D201128402E" -allowProvisioningUpdates \
  CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=485XM2R33S build

xcrun devicectl device install app --device 00008020-00161D201128402E \
  ~/Library/Developer/Xcode/DerivedData/BeanPool-*/Build/Products/Debug-iphoneos/BeanPool.app
```

`xcodebuild` exits 65 on failure. **Do not append `; echo $?`** — you will read the `echo`'s
status, not xcodebuild's. Use `exec`, or grep the log for `BUILD SUCCEEDED`.

**Launch and deep-link to the probe** (phone unlocked, same LAN as Metro):

```bash
D=00008020-00161D201128402E
xcrun devicectl device process launch --device $D \
  --payload-url "beanpool://expo-development-client/?url=http%3A%2F%2F<MAC_LAN_IP>%3A8081" \
  org.beanpool.pillar
# wait ~25s for the bundle, then:
xcrun devicectl device process launch --device $D \
  --payload-url "beanpool://apple-probe" org.beanpool.pillar
```

**Confirm the entitlement is really in the signed binary:**

```bash
codesign -d --entitlements - --xml <path>/BeanPool.app | plutil -p -
# want: com.apple.developer.applesignin => ["Default"]
#       application-identifier => 485XM2R33S.org.beanpool.pillar
```

**Confirm the node is current:**

```bash
curl -s "https://test.beanpool.org/api/recovery/keepers/<callsign>"
# 200 + JSON = route exists. Plain-text "Not Found" = node predates #223.
```

**Count fragments on a live node — READ ONLY.** This is how §2 was verified, and how to
re-verify it before the enrolment rewrite. `readonly: true` is not decoration: `mullum` is a
real community and this is the one query it is acceptable to run there.

```bash
ssh ssh-qld.beanpool.org "docker exec -w /app/apps/server beanpool-mullum-beanpool-node-1 \
  node -e \"const D=require('better-sqlite3');const d=new D('/data/state.db',{readonly:true});\
  console.log(d.prepare('SELECT COUNT(*) c FROM recovery_shares').get().c)\""
```

The qld VM hosts `test`, `mullum`, `bris` and `bindarrabi`; container names follow
`beanpool-<node>-beanpool-node-1`. The database is `/data/state.db` — there is no `/app/data`,
and no `sqlite3` binary in the image, which is why this goes through `better-sqlite3`.

---

## 8. Working rules that have already cost real time

**Every Bash call starts in the session's default directory.** A `cd` applies only inside that
one command. This produced three wrong PRs on 2026-08-11: `gh pr create` run as its own call
inferred the head branch from Marty's checkout (`fix/ci-hang`) instead of the branch just
pushed. They carried the right titles and the wrong content, and squash-merged into **empty
commits**.

**Always name the head explicitly:**

```bash
gh pr create -R beanpool-org/beanpool --base main --head <branch> --title ... --body ...
```

**A green merge is not evidence the content landed.** Verify every time:

```bash
gh api repos/beanpool-org/beanpool/commits/main --jq '{n:(.files|length),f:[.files[].filename]}'
# or: git show <merge-sha> --stat   — must list the files you expect
```

For code, a bad merge eventually shows up as a failing test. For docs nothing ever fails — the
file the next session is told to trust is exactly the one that can be stale with no red signal.
Three PRs reported `MERGED`, all checks green, and the content was not there.

**Delete the branch when you merge** (`--delete-branch`), or GitHub keeps offering to open a PR
for it and the branch list fills with merged work.

---

## 9. How Marty works

- He tests on **standalone builds**, not dev-client + Metro.
- He wants **macro before micro** — say who is waiting before starting; don't let the GitHub
  issue list become the plan.
- He challenges analysis hard, and is usually right when he does. Several design decisions
  here came from him overturning my reasoning. Concede quickly and move on.
- Onboarding UX: **no hard gates**, no false-success limbo, plain language over red dots.
- Tiers are merit badges — they gate nothing. The send gate is a positive balance.
