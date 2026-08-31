# Node DNS Registrar — Handoff (2026-07-27)

**Goal:** let a self-hosted node claim `<name>.beanpool.org` (or bring its own domain), so invites
deep-link and the node is reachable — without handing strangers our Cloudflare keys. Full design +
rationale: [`docs/node-dns-registrar.md`](node-dns-registrar.md). This file = current state + next steps.

## Where it stands

**Phase 1 is code-complete. Nothing is deployed yet.**

| Piece | Where | Status |
|---|---|---|
| Registrar Worker (D1, CF client, attestation cron) | `apps/registrar/` | ✅ **merged to main (PR #87)** |
| Node client + `GET /api/attest` + admin claim/status/offline routes | `apps/server/src/services/registrar-client.ts`, `routes/public-address.ts` | ✅ merged #87 |
| Boot agent (config-driven auto-claim) + cloudflared sidecar | `apps/server/src/services/public-address-agent.ts`, `deploy/cloudflared-sidecar.compose.yml` | ✅ merged #87 |
| `/settings` "Public Address" panel | `apps/server/static/settings.html` + `settings.js` | 🔶 **PR #88 open (not merged)** |
| This handoff + memory update | `docs/`, memory | uncommitted on branch `feat/settings-public-address` |

Git: on branch `feat/settings-public-address` (PR #88). `main` has all of #87.

## The 3 cases (all share: name registry + switchboard invites + attestation)
- **A** `<name>.beanpool.org` + **Tunnel** (default; NAT-safe; we hold the kill switch). ← only mode fully built.
- **B** `<name>.beanpool.org` + **Direct** A-record (public-IP nodes). Provision path coded in the Worker (`createARecord`), not exercised.
- **C** **Bring-your-own-domain** (independent; invites still work via the switchboard). Design only.

## Two contracts anyone continuing MUST preserve
1. **Signed request (node → registrar):** headers `x-bp-pubkey` (raw Ed25519 hex) / `x-bp-timestamp` / `x-bp-signature`; message = `` `beanpool-registrar-request/v1\n${METHOD}\n${pathname}\n${ts}\n${bodyText}` ``. Node side: `registrar-client.ts` (`.publicKey.raw` + `.sign()`). Worker side: `apps/registrar/src/sign.js`.
2. **Attestation:** node serves `GET /api/attest?nonce=` → `{pubkey, nonce, timestamp, signature}` signed over `` `beanpool-node-attest/v1\n${nonce}\n${timestamp}` ``. The nonce is restricted to `[A-Za-z0-9._-]{1,128}`: a newline in it used to let a caller shape the signed message like a signed request, making this public endpoint an oracle for the private scheme. Worker cron verifies; **offline-safe**: `mismatch` (wrong identity) → revoke fast; `unverified` (unreachable) → **never revoke** (solar nodes sleep). See `attestOne`/`attestSweep` in `apps/registrar/src/index.js`.

## Validated facts / constants
- **CF creds** live in repo `.env` (`CF_API_TOKEN` = DNS-only; `CLOUDFLARE_API_KEY`+`_EMAIL` = global). Never print them.
- **Account ID** `151a28c4fd1e6ee09768f4226be76b4d` · **Zone (beanpool.org)** `060a99ae34e53b26dcf3be6578722b31`.
- **Phase 0 PASSED** (`scratchpad/cf-phase0.sh`): create-tunnel → token → ingress → CNAME route → teardown all work against the real account. Tunnel-mode CF calls are proven, not guessed.
- Martin already runs CF tunnels (`qld`, `vic`, `anythingllm`) for his Binary Lane VMs.
- `beanpool.org` = a Cloudflare **Pages** static site; registrar attaches as a **Worker + Worker Routes** (Pages can't cron; attestation needs a cron).
- Limits: 1,000 tunnels + 1,000 routes/account; DNS 200 (new zones)/1,000/3,500 by plan → ~1,000-community ceiling.

## Gotchas
- The registrar Worker's `CF_API_TOKEN` must be a **NEW scoped token with Account·Cloudflare·Tunnel·Edit + Zone·DNS·Edit** — the existing `.env` token only has DNS (confirmed: it can't see tunnels).
- **Config-driven `Take offline` re-claims:** on a node with `PUBLIC_ADDRESS_NAME` set, the boot agent re-claims ~5 min after a UI "Take offline". Unset the env to keep it down. (Fine for manually-claimed nodes.)
- `settings.html`/`settings.js` are **static** (served directly; a node restart picks them up — no build, unlike native). Bump the `settings.js?v=` cache-buster on change (now `v1.0.38`).
- `deleteTunnel` uses `?cascade=true` (live tunnels won't delete otherwise). Re-claim deprovisions old CF resources first (PR #87 review fixes).

## NEXT STEPS

### 1. Deploy the Worker (the blocker to a working system) — needs Martin's CF account
Steps in `apps/registrar/README.md`. Summary:
```bash
cd apps/registrar && npm i
npx wrangler login                                    # Martin (interactive OAuth — can't be done headlessly)
npx wrangler d1 create beanpool-registrar             # paste database_id into wrangler.toml
npx wrangler d1 execute beanpool-registrar --file schema.sql --remote
npx wrangler secret put CF_API_TOKEN  CF_ACCOUNT_ID  CF_ZONE_ID  ADMIN_SECRET   # 4 secrets
# uncomment [[routes]] in wrangler.toml (beanpool.org/api/registrar/*, /i/*), then:
npx wrangler deploy
```
If Martin provides a **Workers+D1-scoped token** (or pastes the D1 id), the agent can run everything except `wrangler login`. Then **validate end-to-end:** run a node with `PUBLIC_ADDRESS_AUTO=1 PUBLIC_ADDRESS_NAME=<test>` and watch claim → (approve, since test-city names may be `gated`) → tunnel up → `/settings` shows 🟢. First-run wrinkles to watch: exact D1 binding name (`DB`), the `cfd_tunnel` config/route API shapes under a scoped token, and the tunnel origin (`PUBLIC_ADDRESS_ORIGIN`, default `https://localhost:8443`, `noTLSVerify` on).

### 2. Phase 2 backlog (no CF account needed to build)
- **Switchboard `code→node` lookup** — currently `/i/:code` is a param-reflecting trampoline; wire real invite-code → node-URL resolution and make the node emit `beanpool.org/i/<code>` invite links.
- **Case B** (Direct/A-record) end-to-end + reachability probe to auto-recommend tunnel vs direct.
- **Case C** (bring-your-own-domain) via the switchboard.
- **auto-approve** for the `auto` tier (currently all names go `pending` unless… check: `auto` tier auto-provisions; `gated` waits. Seed list in `schema.sql`).
- **Public community directory**; **admin approval UI** (only endpoints exist).
- **Android**: fold active community subdomains into the app's `autoVerify` host list on a normal release (apex `/i/` switchboard already auto-verifies).

## Pointers
- Spec: `docs/node-dns-registrar.md` · Memory: `node-dns-registrar` · PRs: #87 (merged), #88 (open).
- Phase 0 script: `scratchpad/cf-phase0.sh` (self-cleaning; re-runnable to re-prove CF calls).
