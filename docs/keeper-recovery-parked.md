# Keeper (social) recovery — scrapped 2026-09-10

BeanPool no longer offers keeper-based social recovery. Two recovery paths remain:
the member's own 12 words, and SSO (native only). The owner's decision is that this is
permanent — the product stands on those two paths and does not deviate.

PR #713 removed every client entry point. Branch `chore/remove-keeper-server` removed
the unreachable server code, cleaned up dormant schema definitions, and updated test suites.

## Why

Measured on all ten live nodes before removing anything:

- **Zero human-keeper shares exist.** Every row in `recovery_shares` is `hub` + `sso` —
  the SSO two-layer split, not friend fragments. Three members are enrolled (Catie/Apple
  and Sapoty/Google on mullum, Marty Party/Google on melb) and all three are on SSO.
  Nobody lost a safety net.
- **`recovery_pin` was empty on every node**, and nothing in `routes/recovery-collect.ts`
  or `routes/keepers.ts` ever checked a PIN — `routes/pin.ts` exposed only `pin/set`,
  `pin/status` and `pin/verify`, and no recovery route imported them. The PIN's stated
  purpose was to stop keepers colluding to restore an account without its owner. It never
  did that, and no member ever set one.
- The PWA could not participate in keeper recovery, and native discovery was push-only.

## What survives, and why

1. **Member's 12 words**: Sovereign, offline, requires zero node coordination.
2. **SSO Recovery (Native only: Google, Apple, GitHub)**:
   - Tables: `recovery_shares` (stores `hub` and `sso` fragments), `recovery_collections` (bearer sessions), and `recovery_releases` (audit log of released fragments).
   - Endpoints:
     - `POST /api/recovery/sso-nonce`: Mints single-use nonce for verified provider login.
     - `POST /api/recovery/shares/hub-fragment`: Retrieves stored hub fragment `A` for re-splitting against an additional SSO provider.
     - `POST /api/recovery/shares/sso`: Deposits verified SSO generation (hub + sso fragments).
     - `POST /api/recovery/shares/status`: Reads current recovery generation, keeper counts, and threshold (2 for SSO tier).
     - `DELETE /api/recovery/shares/sso/:provider`: Disconnects an individual SSO provider.
     - `DELETE /api/recovery/shares`: Drops all recovery shares with explicit confirmation.
     - `POST /api/recovery/collect`: Opens an unauthenticated bearer collection session bound to caller's ephemeral key.
     - `POST /api/recovery/collect/status`: Polls progress of an open collection session.
     - `POST /api/recovery/collect/hub`: Releases hub fragment (instant after verified SSO release, or after 24h delay under D7).
     - `POST /api/recovery/collect/sso-nonce`: Mints nonce for collection session.
     - `POST /api/recovery/collect/sso`: Releases verified SSO fragment.
     - `POST /api/recovery/collect/fragments`: Retrieves released fragments.
     - `POST /api/recovery/collect/mine`: Lists live collections for the account owner.
     - `POST /api/recovery/collect/cancel`: Cancels an in-flight recovery collection.
     - `GET /api/recovery/lookup/:callsign`: Public lookup for recovery targets, returning `canRecoverByGuardians: false` and `canRecoverBySso: boolean`.
3. `RecoveryAlertBanner` stays rendered on **both** clients to notify members of live recovery collections opened against their accounts.

## Server Deletion Summary (Completed in `chore/remove-keeper-server`)

| Area | Deletions & Cleanups |
|---|---|
| **Keeper Routes** (`routes/keepers.ts`, `routes/recovery-collect.ts`) | Removed `POST /api/recovery/shares` (raw share upload), `GET /api/recovery/keepers/:callsign` (public keeper summary), `POST /api/recovery/keeper-candidates` (inviter candidate lookup), `POST /api/recovery/approve-keeper`, `POST /api/recovery/approve-keeper/context`, `POST /api/recovery/approve-keeper/pending`. |
| **Legacy Guardian Routes** (`routes/community.ts`) | Removed `POST /api/friends/guardian`, `POST /api/recovery/request`, `GET /api/recovery/pending/:guardianPubkey`, `POST /api/recovery/approve`, `POST /api/recovery/reject`, `GET /api/recovery/status/:pubkey`, `POST /api/recovery/cancel`. |
| **PIN Routes** (`routes/pin.ts`) | Deleted `apps/server/src/routes/pin.ts` and unmounted PIN router from `https-server.ts`. |
| **Engine** (`engine/recovery-release.ts`, `engine/social.ts`, `engine/members.ts`, `state-engine.ts`, `@beanpool/engine`) | Removed `releaseMemberFragment`, `pendingKeeperActionsFor`, `setGuardian`, `getGuardiansOf`, `getMyWards`, `createRecoveryRequest`, `getRecoveryRequest`, `approveRecovery`, `rejectRecovery`, `cancelRecovery`, `executeRecovery`, `getPendingRecoveryRequests`, `getRecoveryStatus`. Set `canRecoverByGuardians: false` and removed `RECOVERY_MIN_GUARDIANS` in `findRecoveryCandidates`. |
| **Database Schema** (`schema.sql`, `db.ts`) | Removed `recovery_requests`, `recovery_approvals`, `recovery_pin` table definitions from `schema.sql` (no destructive `DROP TABLE` run on live DBs; tables remain dormant). Removed `is_guardian` column definition from `friends`. Cleaned up genesis seeds and migration patches. |
| **Replication / Sync** (`engine/sync.ts`, `state-engine.ts`, `@beanpool/engine`) | Removed `recoveryPins`, `recoveryRequests`, and `recoveryApprovals` from replication exports/imports. Cleaned `clearReplicatedTables` to only flush active tables (`recovery_shares`). |
| **Client Cleanup** (`apps/native`) | Deleted `utils/friend-recovery.ts`, `utils/__tests__/friend-recovery.test.ts`, `utils/pin.ts`, `utils/__tests__/pin.test.ts`. Cleaned friend enrolment functions from `keeper-enrolment.ts` and legacy guardian functions from `db.ts`. |
| **Test Suites** | Deleted dead test files (`test-friend-recovery-roundtrip.ts`, `test-keeper-pending-route.ts`, `test-recovery-pin.ts`). Updated surviving suites (`test-keeper-release.ts`, `test-keeper-routes.ts`, `test-keeper-http.ts`, `test-recovery-collect.ts`, `test-recovery-ws.ts`, `test-membership-probe.ts`, `test-social-ratings.ts`, `test-recovery-backup-durability.ts`, `test-callsign-predicates.ts`). Verified all 98 registered suites. |

## The naming traps, for whoever reverses or extends this

- **"Keeper" means two unrelated things.** RECOVERY keepers hold key fragments (parked
  here). TREASURY keepers/operators/stewards (`can_operate`, `treasury_operators`) are a
  live, separately-designed feature. Never conflate them.
- **Two thresholds.** `TWO_LAYER_THRESHOLD = 2` governs SSO recovery (hub + sso).
  `RECOVERY_THRESHOLD = 3` governs splitting the 12-word phrase and is untouched.
- **`utils/keeper-enrolment.ts` is not keeper-only.** Three of its routes are the SSO
  path (`shares/hub-fragment`, `shares/sso`, `DELETE shares/sso/:provider`) and stay wired.
- **`/api/recovery/collect`, `collect/hub` and `collect/fragments` are shared** by SSO
  recovery. `sso-recovery.ts` calls all three.

## The consequence to plan for

SSO recovery only works while the community node still holds its hub fragment. The 12 words
are the only path that depends on nobody. Keeper recovery was the answer to "I lost my phone
**and** never wrote the words down" — scrapping it does not make that member disappear, it
removes their last net. Forced type-back verification of the 12 words at setup should ship
before or alongside the deletion PR, not after.
