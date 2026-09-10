# Keeper (social) recovery — parked 2026-09-10

BeanPool no longer offers keeper-based social recovery. Two recovery paths remain:
the member's own 12 words, and SSO (native only).

This change removed the **client entry points**. The server routes, tables and existing
rows are untouched, so the decision can be reversed without a migration.

## Why

Measured on all ten live nodes before removing anything:

- **Zero human-keeper shares exist.** Every row in `recovery_shares` is `hub` + `sso` —
  the SSO two-layer split, not friend fragments. Three members are enrolled (Catie/Apple
  and Sapoty/Google on mullum, Marty Party/Google on melb) and all three are on SSO.
  Nobody lost a safety net.
- **`recovery_pin` is empty on every node**, and nothing in `routes/recovery-collect.ts`
  or `routes/keepers.ts` ever checks a PIN — `routes/pin.ts` exposes only `pin/set`,
  `pin/status` and `pin/verify`, and no recovery route imports them. The PIN's stated
  purpose was to stop keepers colluding to restore an account without its owner. It never
  did that, and no member ever set one.
- The PWA could not participate in keeper recovery, and native discovery was push-only.

## What survives, and why

`RecoveryAlertBanner` stays rendered on **both** clients. It had never actually fired:
both clients filtered `/api/recovery/collect/mine` on a `status` field the route does not
send, so the banner was suppressed on every node since it shipped. Fixed here, because this
decision leans on it. The server routes are still live,
so a crafted request or an old client build can still open a recovery session against a
member who has shares on the node. The banner is the only thing that tells them, and it is
now the sole defence against the collusion path described above.

## The naming traps, for whoever reverses or extends this

- **"Keeper" means two unrelated things.** RECOVERY keepers hold key fragments (parked
  here). TREASURY keepers/operators/stewards (`can_operate`, `treasury_operators`) are a
  live, separately-designed feature. Never conflate them.
- **Two thresholds.** `TWO_LAYER_THRESHOLD = 2` governed friend/keeper recovery.
  `RECOVERY_THRESHOLD = 3` governs splitting the 12-word phrase and is untouched.
- **`utils/keeper-enrolment.ts` is not keeper-only.** Three of its four routes are the SSO
  path (`shares/hub-fragment`, `shares/sso`, `DELETE shares/sso/:provider`) and stay wired.
  Only `enrolFriendKeepers` → `POST /api/recovery/shares` was the keeper upload.
- **`/api/recovery/collect`, `collect/hub` and `collect/fragments` are shared** by SSO
  recovery and the old friend recovery. `sso-recovery.ts` still calls all three. Only
  `approve-keeper` and `approve-keeper/context` were keeper-only.

## Left in place, unreferenced

`utils/friend-recovery.ts`, `utils/pin.ts`, `enrolFriendKeepers` in `keeper-enrolment.ts`,
and the seven legacy guardian helpers in `utils/db.ts` (`lookupRecoveryCallsign`,
`createRecoveryRequest`, `getPendingRecoveryRequests`, `approveRecoveryRequest`,
`rejectRecoveryRequest`, `cancelRecoveryRequest`, `getRecoveryStatus`). Their tests still
pass. Nothing calls them.

## Known gaps

- **SSO recovery does not exist on the PWA** and never did. The PWA keeps only the 12-word
  restore. Docs asserting SSO parity across both clients are wrong.
- Other docs still describe social recovery in the present tense and were not rewritten
  here: `ONBOARDING.md`, `recovery-model.md`, `keepers-enterprise-commons.md`,
  `sso-client-handover.md`, `trust-profile-and-trade-safety.md` and others.
- `state-engine.ts:926` still emits the trust reason "N people trust them as a recovery
  guardian". It never fires, because `getMyWards()` is zero everywhere.
