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

### Open, unreviewed, all mergeable

| PR | Branch | What |
|---|---|---|
| **#248** | `fix/sso-seal-scrypt` | SSO seal key: one HKDF pass → scrypt (`scrypt-xc20p-v1`) |
| **#249** | `docs/recovery-model` | the design doc |
| **#250** | `feat/apple-signin` | client half of Sign in with Apple + the `apple-probe` screen |

**Merge #248 first and soon.** Its old comment justified a weak key with "it yields ONE
fragment, and the threshold is three". `A ⊕ B` made that false — the SSO fragment is now half
of two, sitting next to the other half in plaintext in the same table. **No fragments exist
yet, so there is nothing to migrate. That window closes the moment anyone enrols.**

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

### Step 1 — ~~close the last link~~ DONE 2026-08-11

Section 4 of the probe verified a real Apple token against the node. See §3.

### Step 2 — merge #248 (scrypt), while migration is still free

### Step 3 — merge #249 (doc) and #250 (client)

### Step 4 — the two-layer split and enrolment rewrite (the main build)

This is the large one. `seed = A ⊕ B`, then Shamir on `B`. Touches enrolment, the keeper
panel, and `RECOVERY_THRESHOLD` semantics (3 → 2, layer two only). The existing client keeper
code predates the model and should be rewritten, not patched.

### Step 5 — Google sign-in on Android, and measure its nonce echo

Marty chose the **native Google library**, not a web flow. `startSsoSignIn` already throws a
named `unsupported` error for Google so it fails loudly rather than appearing to work.

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

---

## 8. How Marty works

- He tests on **standalone builds**, not dev-client + Metro.
- He wants **macro before micro** — say who is waiting before starting; don't let the GitHub
  issue list become the plan.
- He challenges analysis hard, and is usually right when he does. Several design decisions
  here came from him overturning my reasoning. Concede quickly and move on.
- Onboarding UX: **no hard gates**, no false-success limbo, plain language over red dots.
- Tiers are merit badges — they gate nothing. The send gate is a positive balance.
