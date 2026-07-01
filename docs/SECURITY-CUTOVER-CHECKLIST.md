# Security cutover & validation checklist

Operational runbook for shipping the 2026-06 security remediation to the **test pair**
(`test` + `test-mirror`) and validating it over a few days before any production rollout.
Everything is **flag-gated and off by default** — landing the code changes nothing until
you flip a flag. The native app must carry the client-side changes BEFORE any flag flips,
or old apps break.

## Topology: one-directional live backup (Phase 1)

The bidirectional `mirror` is replaced by a **one-directional live backup** — state flows
**primary → backup only**, and the **primary imports NOTHING inbound**. This removes the trusted
writer to the live ledger that the SRV-20/21 forgery vector relied on. (Design rationale — why an
HTTPS snapshot pull rather than serve-only P2P — is in `SECURITY-AUDIT.md`, Phase 1 status note.)

> ⚠️ **Unlike the `ENFORCE_*` flags, this is an ACTIVE change, not a dormant one.** The default role
> is `primary`, which imports nothing — so the moment this code lands on a node, the old *mutual*
> mirror sync **stops importing** there. That is the intended fail-safe (a node imports from nobody
> until explicitly told it is a `backup`). Configure the roles below as part of the same deploy, or
> replication will simply stop (no data loss — the backup just stops converging until configured).

**Roles are env-driven; the same image runs in either role.**

| Env var | On `test` (PRIMARY) | On `test-mirror` (BACKUP) |
|---|---|---|
| `NODE_ROLE` | `primary` (or unset) | `backup` |
| `BACKUP_PRIMARY_URL` | — | `https://test.beanpool.org` |
| `BACKUP_ADMIN_PASSWORD` | — | the primary's `ADMIN_PASSWORD` (shared operator secret) |
| `BACKUP_PULL_INTERVAL_MS` | — | optional, default `60000` |

**Connector config (`data/connectors.json`):**
- **Primary:** NO `mirror` connectors. It trusts no one (`importRemoteState` refuses all inbound
  regardless, because `NODE_ROLE != backup`). Remove any existing `mirror` entry pointing at the backup.
- **Backup:** exactly ONE `mirror` connector = the primary, **`enabled: false`** (passive trust
  anchor — present only so the import signature gate recognizes the primary's key; the backup pulls
  over HTTPS and never dials it), with the primary's `/p2p/<peerId>` in the `address`. Get the
  primary's PeerID from its boot log (`🌐 libp2p started — PeerId: …`).

**How it works:** the backup's puller fetches `GET /api/local/admin/sync-snapshot` (admin-password
header) from the primary every `BACKUP_PULL_INTERVAL_MS`, then runs it through the existing
`importRemoteState` (signature → trusted-`mirror` gate → conservation guard). The primary's snapshot
endpoint is a pure read-only export — it adds no inbound trust.

**Self-signed LAN primaries:** point `NODE_EXTRA_CA_CERTS` at the primary's CA pem on the backup
(Node honors it for `fetch`). Public Let's Encrypt nodes (the test pair) need nothing.

**Failover promotion:** restart the backup with `NODE_ROLE=primary` **and** `PROMOTED_FROM_BACKUP=true`
for that one boot — the boot path runs a ledger conservation sanity check (`promotionSanityCheck`)
and logs a PASS/FAIL banner before the node takes live writes. Drop `BACKUP_*` and `PROMOTED_FROM_BACKUP`
on subsequent restarts. (Override these for one boot by shell-exporting them and running
`sudo -E docker compose ... up -d --force-recreate`; the shell env wins over the node `.env`.)

### How the role/backup/enforcement env reaches the container

`docker-compose.yml` declares `NODE_ROLE`, `BACKUP_*`, `PROMOTED_FROM_BACKUP`, and the three
`ENFORCE_*` flags as `${VAR:-}` passthroughs (empty default = primary, puller off, flags off —
the safe dormant state). Set them per node in a **node-local `.env`** in the project dir
(`/home/<user>/<DIR>/.env`, `chmod 600`). `deploy.sh` preserves that `.env` across the
`rm -rf` on each redeploy (the same way it preserves `data/`), so role + flags survive deploys.
Make the `.env` **self-contained** — also put `ADMIN_PASSWORD`/`CF_*`/`PUBLIC_IP` in it so a manual
`docker compose up` (outside `deploy.sh`) brings the node up fully configured, not with a blank
admin password.

> ⚠️ **Admin-password lock gotcha.** `initAdminPassword` **skips entirely once the node is locked**
> (`isLocked:true` in `data/local-config.json`, set on first boot). After that, `ADMIN_PASSWORD`
> (env or `.env`) is **ignored** — redeploying with a new value does nothing. The backup's snapshot
> pull authenticates with the *primary's actual* admin password, so they must match. To set a known
> password on an already-locked node: stop it, null `isLocked`/`adminHash`/`salt` in
> `local-config.json` (preserve `thresholds`/branding/contact), then restart with `ADMIN_PASSWORD`
> set — it re-locks to that value. Set `BACKUP_ADMIN_PASSWORD` on the backup to the same value.

## Enforcement flags (all default OFF)
| Flag | Closes | Requires (clients) |
|---|---|---|
| `ENFORCE_READ_AUTH` | SRV-2/SRV-4 unauth reads | app signs GET reads (native #138 + PWA) |
| `ENFORCE_WS_AUTH` | SRV-4 unauth `/ws` feed | app signs the WS connect (native #138 + PWA) |
| `ENFORCE_LEDGER_AUTH` | SRV-20 ledger forgery | nothing extra (server-side verify); needs the ledger migration first |

## PRs in this remediation
- Merged: read-auth (#131), WS-auth (#143), X-1b (#130), SRV-9a/10 (#129), SRV-21 + mirror-only (#128/#136), native forward-compat (#138), signed-ledger 3a-3c (#145).
- Open at time of writing: **#147** signed-ledger 3d/3e, **#148** NAT-4/20/21, **#149** SRV-3 + recovery rate-limit.

## Cutover sequence (in order)

> **Status (2026-06-28):** Steps 0–2 are **DONE** — Phase 1 (#153) and the A2 remediation
> (#155–#166) are merged to `main`, and the native app is **v1.1.54, live & adopted in both
> stores** (supersedes the "bump → 1.1.53/169" note below). The **test pair has completed the
> full backend cutover** (steps 3–6): deployed, one-directional backup configured + converging,
> ledger migrated on both, all three `ENFORCE_*` flags ON, failover promotion verified
> (`✅ PROMOTION OK`). Admin password reset on both to the shared operator value (in each node's
> `.env`). **Production (mullum1/mullum2) is NOT done** — repeat steps 3–6 there after on-device
> app validation on the test pair.

0. **Topology (Phase 1, branch `feat/phase1-one-directional-backup`):** merge it; then on the
   backend deploy (step 3) set the role env per the table above, edit `connectors.json` on each node
   (primary: drop the mirror; backup: one passive mirror = primary). No app/flag dependency — this is
   independent of the `ENFORCE_*` flags and can validate on its own.
1. **Merge** #147, #148, #149 into `main`.
2. **Republish the native app** from a clean `main` checkout — bump versionCode/version (→ 1.1.53 / 169). This build carries: forward-compat read/WS signing (#138) + NAT-4/20/21 (#148). **Submit to the store and wait for approval + tester adoption.** Do NOT flip flags before testers are on this build.
3. **Deploy the backend** to `test` + `test-mirror`: `bash deploy.sh 5 6` (rebuilds from `main`). Flags still off → no behavior change yet.
4. **Run the ledger migration** on each node, with the node STOPPED. The deployed
   runtime image is **compiled JS only** (no `src/`, `tsx` is pruned), so run the
   *compiled* script in a one-off container (NOT `pnpm exec tsx src/...`):
   `cd <PROJECT_DIR> && docker compose -p <proj> down`
   `docker compose -p <proj> run --rm -T -e CONFIRM_LEDGER_RESET=yes beanpool-node node dist/srv20-ledger-reset.js`
   (keeps members + offers + messages; resets transactions + balances; expect
   `balance sum (should be 0): 0`). Take a `data/` tarball first. Restart the node.
5. **Flip the flags** (env on both nodes, then restart): `ENFORCE_READ_AUTH=true`,
   `ENFORCE_WS_AUTH=true`, `ENFORCE_LEDGER_AUTH=true`.
6. **Validate for a few days** (below).

## Validation — what to confirm on the test pair
**Topology — one-directional backup (Phase 1, no flag needed):**
- [ ] Backup boot log shows `role: backup … pulls snapshots from primary` and
      `[Backup] 🔁 One-directional backup active`; primary shows `role: primary — imports no inbound state`.
- [ ] After ~1 pull interval the backup converges: do a transfer/post on the **primary**, confirm it
      appears on the backup within `BACKUP_PULL_INTERVAL_MS` (backup log: `[Backup] ⬇️ Pulled snapshot`).
- [ ] **Primary rejects/ignores any inbound push.** From the backup (or a test peer) attempt a P2P
      sync/event push to the primary, or POST a `SyncPayload` — the primary logs the import refusal
      (`runs as 'primary', which imports no remote state`) and balances on the primary are unchanged.
- [ ] The primary has **no `mirror` connector** (`data/connectors.json` + admin "Trusted Connectors"
      shows none); the backup has exactly one passive mirror = the primary.
- [ ] `GET /api/local/admin/sync-snapshot` returns a signed payload **only with** the correct
      `X-Admin-Password` (401 without); it never mutates state.
- [ ] **Failover:** stop the primary; restart the backup with `NODE_ROLE=primary PROMOTED_FROM_BACKUP=true`;
      confirm the `🔁 FAILOVER PROMOTION … ✅ PROMOTION OK` banner and that the app can read/write the
      promoted node. Confirm the promoted node now **also** refuses inbound state.
- [ ] No `Conservation violation` in the backup log during steady-state pulls (full snapshots are
      zero-sum). If one appears on a legitimate pull, raise `LEDGER_CONSERVATION_TOLERANCE`, don't disable.

**Reads / WS (ENFORCE_READ_AUTH, ENFORCE_WS_AUTH):**
- [ ] The new app loads balances / marketplace / people / messages normally (signed reads pass).
- [ ] Live sync connects (WS) and updates flow.
- [ ] An *old* app (or an unsigned curl) gets 401 on a gated read and a refused WS upgrade.
- [ ] Public allowlist still open unsigned: `/api/version`, `/api/community/info`, node/directory info, commons/crowdfund lists, `<img>` photo/attachment endpoints.

**Ledger (ENFORCE_LEDGER_AUTH):**
- [ ] A member→member transfer from the new app **syncs** between test ↔ test-mirror (signed).
- [ ] Marketplace + pledge + demurrage flows still sync (node-authoritative / member-signed).
- [ ] Logs show **no** `Conservation violation` on legitimate sync. If they do, the ledger isn't
      perfectly zero-sum in practice — raise `LEDGER_CONSERVATION_TOLERANCE` (named constant in
      state-engine.ts) rather than disabling the guard.
- [ ] Balances stay consistent between the two nodes after a day of activity.

**NAT-4 cleartext (the regression-sensitive one — reverted twice before):**
- [ ] LAN sync still works: the app connects to a `http://192.168.x.x` / `.local` node over cleartext.
- [ ] A `http://`-to-public-domain node is refused (forces https) — and a normal `https://` public node works.

**NAT-20/21 (onboarding-nav — fragile, prior reverts):**
- [ ] Normal login lands in the app (no spurious recovery/mismatch redirect).
- [ ] A genuine wrong-node state still surfaces node-mismatch; a genuine recovery alert still prompts.
- [ ] Deep-link invites still work; a `beanpool://` link to a cleartext-public node is ignored.

## Residual / out of scope (documented)
- **SRV-20 residual — now off the critical path (Phase 1).** The forgery vector required a *trusted
  inbound writer*; the primary no longer has one (it imports from nobody), so the live authority is
  not exposed. The balance-neutral-escrow-chain residual now only matters on a *backup* (a read
  replica taking no live writes) and is gated further by `promotionSanityCheck()` if it is ever
  promoted. Per-txn amount-bound escrow signing remains the future-proof fix **if** a trusting
  topology is ever reintroduced.
- **Manual (operator) — not code:** rotate the FCM/Google key (NAT-2, still in git history),
  keystore (NAT-3), and Play service-account key (NAT-10).
- Group/system messages remain `plaintext-v1` (node operator can read group chats; 2-party DMs are E2E).

## Rollback
Each flag is independent — set it back to `false` and restart to disable enforcement. The ledger
migration is NOT reversible (history was cleared); take a `data/` backup before step 4 if you want
the option to restore the pre-cutover ledger.
