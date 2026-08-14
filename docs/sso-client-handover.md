# SSO client handover — 2026-08-11, revised 2026-08-14

**Read this before touching recovery, keepers, or Sign in with Apple or Google.**

You are picking up mid-build. The design was settled on 2026-08-10 and the server half merged
2026-08-07. Steps 4a–5b have all landed and been verified on hardware: the two-layer primitive,
the enrolment rewrite, Google sign-in on Android, and **the complete recovery round-trip**
(tested and verified on physical Pixel 9 Pro against `test.beanpool.org` on 2026-08-14).

**What remains unbuilt:** the copy pass, and the trusted-friends recovery path end-to-end. Both
**Google** (Step 5b, Pixel 9 Pro) and **Apple** (Step 8, iPhone XR) SSO recovery round-trips are
**VERIFIED on physical hardware**. The PIN client UI (#272), node backup durability (#274), and
the friend picker (#273) are all built and tested — see §6.

> **Revision note.** Revised 2026-08-14 after Step 5b (the Google recovery round-trip) was executed
> on a physical Pixel 9 Pro against `test.beanpool.org` and verified via DB assertion (57 members preserved,
> exact public key restored, PR #268 merged). Everything asserted here was checked against `main`, the
> running image, or the live database — not against a chat summary.

### Start here

1. `test` is on **1.1.42** with everything below deployed and live-verified (§2).
2. **Step 5b (the recovery round-trip) is COMPLETE and VERIFIED** on physical Pixel 9 Pro.
3. If `test.beanpool.org` is unreachable, read **§5 trap 9** before touching anything — a
   deploy can drop the tunnel while the node stays perfectly healthy.
4. Two things are recorded as **decided-but-not-signed-off**: the Google nonce-binding
   trade-off (end of §2) and the SSO tier being custodial by choice (§1). Neither is a bug.

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

### The clean slate CLOSED on 2026-08-13

Everything below this line was written while `recovery_shares` was empty everywhere, which is
what made changing the split shape a schema edit rather than a data migration. **That window
is now shut.** The first real fragments were deposited on `test` on 2026-08-13:

| Node | `recovery_shares` | Note |
|---|---|---|
| **mullum** (the live community) | **0** as of 2026-08-11 | re-check before assuming |
| test | **2** (`hub` + `sso`/`google`, member `Monnunit`) | real, not probe placeholders |

Changing the split shape from here is a **data migration**, not a schema edit. Anyone planning
one must now answer what happens to existing fragments.

bris and bindarrabi were never checked. Recipe in §7.

### Built since this document was first written (2026-08-11 → 13)

The list below said "not built at all". Most of it now is. Verified against `main` and, where
noted, against the live database — not taken from a chat report.

- **The two-layer primitive** — `packages/beanpool-core/src/two-layer-split.ts` + tests (#256).
- **The enrolment rewrite** under the two-layer model (#257), and keeper tiers reachable from
  the app (#258).
- **Google sign-in on Android** (#259). `startSsoSignIn` no longer throws `unsupported`.
  End-to-end enrolment confirmed by the two DB rows above.
- **The PIN** — server half only (#262). Endpoints `/api/recovery/pin/{set,status,verify}`,
  table `recovery_pin`. **No client UI exists.**
- **PWA sovereignty warnings** (#263) and recovery push routing (#264).

### Deployed and verified LIVE on 2026-08-13

`test` runs **1.1.42** (`DEPLOY_PULL=1 bash deploy.sh 11`, CI image from `main`). Confirmed by
grepping the running image and by signed requests against the public host — not by the version
string, and not from a chat report:

| Check | Result |
|---|---|
| PIN routes in the running image (`dist/routes/pin.js`) | ✅ |
| `recovery_pin` table created | ✅ |
| `quorum_required` default back to **3** | ✅ |
| the 2 recovery fragments survived the deploy | ✅ |
| anti-enumeration: unknown vs real vs wrong-case callsign | ✅ byte-identical |

**A caveat about `pin.ts`'s own header.** It says the verify endpoint is *"UNAUTHENTICATED
(recovering device has no identity to sign with)"*. That is wrong and will cost the next
person time: `requireSignature` gates **every** mutating `/api/*` request, and
`/api/recovery/pin/verify` is a POST that is *not* on the bypass list. It does not require
**membership** — the middleware only binds `ctx.state.actor` to whatever key signed — so a
recovering device signs with a **throwaway keypair**. Unsigned calls get
`401 Missing cryptographic signature headers`. Recipe in §7.

### Still not built — CORRECTED 2026-08-14

This list went stale within a day and contradicted the rest of the document: it still called
the Google round-trip "the single largest unverified gap" after §6 recorded it as a verified
pass, and still listed backup durability after #274 shipped it. Corrected below, each line
checked against the tree or the live DB on 2026-08-14.

- ~~The Google recovery ROUND-TRIP~~ — **DONE and independently re-verified** (#268). See §6
  Step 5b. Live DB confirms 57 members, one `Monnunit` row, exact pubkey restored.
- ~~The PIN client UI~~ — **DONE** (#272): `utils/pin.ts`, `components/RecoveryPinModal.tsx`.
- ~~Node backup durability~~ — **DONE** (#274): `recoveryPins` in the sync payload,
  `idx_recovery_pin_updated_at`, `test-recovery-backup-durability.ts`.
- ~~The friend picker~~ — **DONE** (#273): `components/FriendPickerSheet.tsx`.

- ~~The APPLE recovery round-trip~~ — **DONE and verified on hardware** (2026-08-14). Tested on
  physical iPhone XR against `test.beanpool.org`. Live DB confirms 57 members preserved, one `Gabi` row,
  exact public key `9f79f679a922b04f104cb6230d2b96a89e1eb60f3a7f7e408fa048163e29a8c6` restored.
- The copy pass.
- The trusted-friends *recovery* path end-to-end (enrolment via the picker exists; ringing 2
  of 5 friends and recombining has not been exercised on hardware).

### ⚠️ A nonce-binding property was traded away on 2026-08-13

`9375d98` relaxed `verifyIdToken` to accept **Google** `id_token`s carrying no `nonce` claim,
because the free `GoogleSignin.signIn()` API cannot embed one (binding needs the premium
`GoogleOneTapSignIn`). Google tokens are therefore **no longer cryptographically bound to the
nonce**; the remaining anti-replay is `consumeNonce()`'s single-use + member-binding on the
server-issued value, plus the signed-request envelope. Apple is unaffected and still strict.

`test-sso.ts` asserts this tolerated path explicitly (#266) so it is covered rather than
merely un-asserted. **This has not been signed off as acceptable for production** — it is
recorded here because `sso.ts` reasons carefully about nonce binding everywhere else, and a
future reader should not mistake it for an oversight or for a settled decision.

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

**Still not proven (as of 2026-08-11) — since CLOSED for Google:**

> `ssoLookupHash` and the storage path have never run against a real token.

They executed for the first time on 2026-08-13, when a real Google enrolment wrote an `sso`
row carrying a genuine `sso_lookup_hash` on `test`. The Apple equivalent remains unrun.

**What replaced it as the open gap:** nothing has ever *read* a fragment back. Storage is
proven; reconstruction is not. See §6 Step 5b.

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

### Added 2026-08-13 — each of these cost real time in one session

9. **`deploy.sh` overwrites every node's Cloudflare tunnel token.** Line ~130 writes the
   single global `CF_TUNNEL_TOKEN` from your local `.env` over `<node>/data/tunnel-token`.
   Deploying to `test` took `test.beanpool.org` off the internet for ~20 minutes with
   Cloudflare **error 1033 / HTTP 530**, cloudflared logging `Unauthorized: Tunnel not found`.
   The token bytes were unchanged (same SHA-256 as the siblings), so the likeliest story is
   that the tunnel had already been deleted Cloudflare-side and the *running* container was
   coasting on an established connection — recreating it forced a re-registration that failed.
   Either way: **a deploy can drop a node's public reachability, and the node itself will look
   perfectly healthy while it happens.** Diagnose in this order:
   - node direct (`docker exec … curl -k https://localhost:8446/…`) — 200 means the app is fine
   - `docker logs <stack>-cloudflared-1` — the real error is here
   - only ONE cloudflared container runs on the qld VM (test's). mullum/bris/bindarrabi hold
     token files but run no tunnel, so *they are not affected by this*, and their 404s are
     normal, not an outage.
   Decode which tunnel a token names without exposing the secret:
   ```bash
   ssh ssh-qld.beanpool.org "cat /root/BeanPool-Test/data/tunnel-token" | python3 -c \
     "import sys,base64,json; d=json.loads(base64.b64decode(sys.stdin.read().strip()+'==')); print('tunnel:',d['t'])"
   ```
10. **`/api/community` 404s on a perfectly healthy node.** It is not a route. Using it as a
    health check invents outages — `/api/version` or `/api/recovery/keepers/<callsign>` are
    real. This wasted a diagnostic cycle during the incident above.
11. **The SSO sheet swallows the real error.** `SsoEnrolSheet.tsx` maps the `provider` and
    `no-token` reasons to a generic *"…couldn't complete the sign-in. Try again."* and drops
    `e.message`. On Android the true cause is in `logcat`, not on screen. `234cad0` improved
    this; do not assume the UI text is the whole story.
12. **Firebase SHA-1 fingerprints are a dead end for Google Sign-In here.** A red ⚠ on a
    fingerprint in the Firebase console (`beanpool-6196d`, project number `751074523085`) is
    **cosmetic for this app** — per Google's own docs it only affects Firebase Auth and
    Dynamic Links, and BeanPool uses neither (only `expo-notifications` for FCM, which
    authenticates by API key + sender ID). Real Google Sign-In lives in a *different* GCP
    project, `653933790375` — the one whose client IDs are in `sso.ts` and `sso-signin.ts`.
    `apps/native/google-services.json` even has `"oauth_client": []`. Hours went into that
    console screen before this was established. **The authoritative signing SHA-1 is Play
    Console → Release → Setup → App integrity**, and it is `…FB:08:…` (the SHA-256 there
    matches `PLAY_APP_SIGNING_SHA256` already hardcoded in `routes/settings.ts`).
    The Play Developer API **cannot** return it — no endpoint exposes the signing certificate.

---

## 6. Next steps, in order

### Steps 1–5b — DONE (2026-08-11 → 14)

| Step | What | Where |
|---|---|---|
| 1–3 | verify a real Apple token, merge #248/#249/#250/#251 | done 2026-08-11 |
| 4a | the two-layer primitive | `packages/beanpool-core/src/two-layer-split.ts` (#256) |
| 4b | the enrolment rewrite | #257 |
| 4c | keeper tiers reachable from the app | #258 |
| 5 | Google sign-in on Android | #259 |
| 5b | Google recovery round-trip | #268 (verified on Pixel 9 Pro 2026-08-14) |

**Step 5's nonce question was answered, and the answer was "we cannot".** The free
`GoogleSignin.signIn()` API accepts no custom nonce, so there is nothing to measure — the
claim is simply absent. The server was relaxed to tolerate that (`9375d98`) rather than
Google being dropped. See the warning at the end of §2 before treating this as settled.

### Step 5b — the recovery ROUND-TRIP — **VERIFIED PASS (2026-08-14)**

Executed and verified on a physical Pixel 9 Pro (`4B231FDAP000YL`) against `test.beanpool.org` on 2026-08-14:
1. Local app data wiped on device (`adb shell pm clear org.beanpool.pillar`).
2. Standalone APK built and installed (`versionCode 213`, `1.1.95`).
3. User selected "Restore your account" → "Recover with Google / Apple" → entered `Monnunit` and `https://test.beanpool.org`.
4. Recovery session opened, Google token verified, SSO fragment released (`share_index 2` with `kdf_params`), and Hub fragment instantly released (`share_index 1` with `sso-approved`).
5. App fetched released fragments, unsealed `B` via Google sub, read `A` from Hub, XOR-combined into seed, and derived keypair.
6. Local WebSocket connected to `wss://test.beanpool.org/ws?callsign=monnunit&pubkey=50b70b5ae9920531fadc70e6064ee1371f93829a515f3ef39df6d69cd13d9121` signed with the restored private key.
7. **Post-recovery DB assertion:** Exactly 57 members remain, ONE `Monnunit` row with matching public key `50b70b5ae9920531fadc70e6064ee1371f93829a515f3ef39df6d69cd13d9121` in `active` status. Zero new accounts minted.

### Step 6 — the PIN client half, settings management & Guardian recovery (COMPLETED in #272)

The PIN client utilities (`apps/native/utils/pin.ts`), Settings management UI (`RecoveryPinModal.tsx`), and Guardian recovery integration (`recover-identity.tsx`) merged in #272 (`243a880`).
- Authenticated endpoints (`/api/recovery/pin/status` and `/api/recovery/pin/set`) wired to Settings → Account Protection.
- Unauthenticated endpoint (`/api/recovery/pin/verify`) wired to Social Recovery with non-lockout skip fallback.
- Comprehensive unit tests in `apps/native/utils/__tests__/pin.test.ts` (51/51 native tests pass).

### Step 7 — node backup durability for the hub fragment (COMPLETED in #274)

Guaranteed durability for all recovery fragments and PIN hashes across automated database snapshots and live node-to-node replication (#274, `2c40003`).
- **Engine Sync Layer**: `SyncRecoveryPin` interface and `recoveryPins` field in `SyncPayload` mapped from `recovery_pin` table.
- **Server Replication & Importer**: Added `recoveryPins` replication in `importRemoteState` with LWW conflict resolution, and included `recovery_pin` in `clearReplicatedTables`.
- **Database Optimization**: Added `idx_recovery_pin_updated_at` index on `recovery_pin(updated_at)`.
- **Automated Durability Test**: New 16-point integration suite in `apps/server/src/test-recovery-backup-durability.ts` verifying atomic `VACUUM INTO` snapshots, disk wipe/restore integrity, live primary-to-backup mirror replication, and force-resync table sweeps (all 7 monorepo suites and 59 integration suites passing).

### Physical iOS Apple Sign-In & Probe Verification (COMPLETED on hardware 2026-08-14)

Live physical measurement on **Gabriela's iPhone (XR, iOS 18)** against `test.beanpool.org`:
- **Nonce Binding**: Apple iOS Authentication Services returned the nonce **`VERBATIM`** in the JWT claims (`claims.nonce === nonce`). The node accepted this form directly.
- **Cryptographic Token Verification**: `probeNodeVerification` against `https://test.beanpool.org/api/recovery/shares/sso` reported:
  `VERIFIED (400) — rejected on the nonce, which means Apple's JWKS, the RS256 signature, the issuer, the audience and the expiry ALL passed against a real token.`
- **Audience & Claims**: `aud === 'org.beanpool.pillar'` matched the configured bundle ID; `credential.user` matched `claims.sub` (`001096.1c23950fb36f4f21ab14de52dd6f8705.0151`).
- **Conclusion**: The entire live Apple Sign-In cryptographic verification chain (JWKS download, live RS256 verification, audience/issuer/nonce binding) is 100% verified end-to-end on physical Apple hardware.

**Scope of that conclusion — read this before treating Apple as finished.** What is proven is
*token verification*: Apple's JWKS, RS256, issuer, audience, nonce. That is the sign-in half.
It is **not** the recovery half. The probe deliberately sends a wrong nonce and stores nothing,
so it never exercises release, unsealing or recombination.

### Step 8 — the APPLE recovery round-trip (COMPLETED & VERIFIED on hardware 2026-08-14)

The Apple equivalent of Step 5b, executed on physical **iPhone XR** (`00008020-00161D201128402E`)
against `test.beanpool.org`.

1. **Pre-recovery baseline:** 57 members on `test`, `Gabi` holding hub + sso/apple fragments.
2. **Recovery execution:** App cleared locally, Welcome screen → "🔑 Restore your account" → "Recover with Apple" → Callsign `Gabi`, node `https://test.beanpool.org` → FaceID authentication.
3. **Recombination:** Unauthenticated SSO request fetched hub fragment $A$ and sealed fragment $B$, derived unwrap key from Apple `sub` (`001096.1c2395...`), unsealed $B$, and reconstructed seed via $A \oplus B$.
4. **Post-recovery DB assertion:** Exactly 57 members remain, ONE `Gabi` row with matching public key `9f79f679a922b04f104cb6230d2b96a89e1eb60f3a7f7e408fa048163e29a8c6` in `active` status. Zero new accounts minted.

Both **Google** and **Apple** SSO recovery round-trips are now 100% verified on physical devices.

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

**Call a signed API endpoint as a "recovering device" (no membership needed).** This is how
the PIN anti-enumeration property was verified against the live node, and it is the shape any
recovery-side client call must take. Save as `pintest.mjs`, run with plain `node`:

```javascript
import crypto from 'node:crypto';
const BASE = 'https://test.beanpool.org';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');   // throwaway identity
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');

async function signedPost(path, body) {
    const raw = JSON.stringify(body);
    const ts = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const msg = `POST\n${path}\n${ts}\n${nonce}\n${raw}`;          // EXACT signed payload shape
    const sig = crypto.sign(null, Buffer.from(msg), privateKey).toString('base64');
    const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Public-Key': pub,
                   'X-Signature': sig, 'X-Timestamp': ts, 'X-Nonce': nonce },
        body: raw,
    });
    return { status: res.status, body: await res.text() };
}

const fake = await signedPost('/api/recovery/pin/verify', { callsign: 'no-such-callsign', pin: '000000' });
const real = await signedPost('/api/recovery/pin/verify', { callsign: 'Monnunit',         pin: '000000' });
console.log(fake, real);
console.log('anti-enumeration:', fake.body === real.body ? 'PASS' : 'FAIL');
```

Both must return **byte-identical** `{"verified":false,"keepers":null}`. If the real callsign
ever answers differently — including a `rateLimited` field — the endpoint has become a
membership oracle and that is a regression, not a feature. (It leaked exactly that way in
#262 before review; see the CR fixes in that PR.)

**Count fragments on a live node — READ ONLY.** This is how §2 was verified, and how to
re-verify it before the enrolment rewrite. `readonly: true` is not decoration: `mullum` is a
real community and this is the one query it is acceptable to run there.

```bash
ssh ssh-qld.beanpool.org "docker exec -w /app/apps/server beanpool-mullum-beanpool-node-1 \
  node -e \"const D=require('better-sqlite3');const d=new D('/data/state.db',{readonly:true});\
  console.log(d.prepare('SELECT COUNT(*) c FROM recovery_shares').get().c)\""
```

**Did a recovery mint a NEW identity instead of restoring the old one?** The check that
decides whether Step 5b passed. Run it before and after.

```bash
ssh ssh-qld.beanpool.org "docker exec -w /app/apps/server beanpool-test-beanpool-node-1 \
  node -e \"const D=require('better-sqlite3');const d=new D('/data/state.db',{readonly:true});
  console.log('members:', d.prepare('SELECT COUNT(*) c FROM members').get().c);
  console.log(JSON.stringify(d.prepare(\\\"SELECT callsign, public_key, status FROM members WHERE lower(callsign)='monnunit'\\\").all()))\""
# PASS: still 57 members, ONE Monnunit row, pubkey 50b70b5ae992…d13d9121
# FAIL: 58 members, or a second Monnunit row, or a different pubkey
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
