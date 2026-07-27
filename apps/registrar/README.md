# beanpool-registrar

Cloudflare Worker that leases `<name>.beanpool.org` to community nodes and keeps them honest.
Full design: [`docs/node-dns-registrar.md`](../../docs/node-dns-registrar.md).

- **Node-facing (signed):** `GET /api/registrar/available` · `POST /api/registrar/claim` ·
  `GET /api/registrar/status` · `POST /api/registrar/offline`
- **Admin (shared secret):** `GET /api/local/admin/registrar/pending` ·
  `POST /api/local/admin/registrar/:name/approve` · `POST /api/local/admin/registrar/:name/revoke`
- **Switchboard:** `GET /i/:code` (trampoline)
- **Cron:** attestation sweep every 5 min — a live name that stops proving it's the registered node
  (a signed `/api/attest` challenge) is auto-revoked after `ATTEST_FAIL_LIMIT` misses.

## Signed request scheme (node → registrar)

Headers `x-bp-pubkey` (64 hex), `x-bp-timestamp` (unix s), `x-bp-signature` (128 hex);
signed message `` `${METHOD}\n${pathname}\n${timestamp}\n${bodyText}` `` with the node's Ed25519 key.

## Attestation response (node serves at `/api/attest?nonce=`)

```json
{ "pubkey": "<hex>", "nonce": "<echoed>", "timestamp": <unix s>,
  "signature": "<Ed25519 over `${nonce}\n${timestamp}`, hex>" }
```

## Deploy

```bash
cd apps/registrar
npm i

# 1. D1 database
npx wrangler d1 create beanpool-registrar        # paste database_id into wrangler.toml
npx wrangler d1 execute beanpool-registrar --file schema.sql --remote

# 2. Secrets (values not committed)
npx wrangler secret put CF_API_TOKEN             # scoped: Account·Tunnel·Edit + Zone·DNS·Edit
npx wrangler secret put CF_ACCOUNT_ID            # 151a28c4fd1e6ee09768f4226be76b4d
npx wrangler secret put CF_ZONE_ID               # 060a99ae34e53b26dcf3be6578722b31
npx wrangler secret put ADMIN_SECRET

# 3. Deploy + attach routes (uncomment [[routes]] in wrangler.toml first)
npx wrangler deploy
```

> The Worker attaches to `beanpool.org/api/registrar/*` and `beanpool.org/i/*` via Worker Routes and
> coexists with the existing Cloudflare Pages static site (Worker routes win for matching paths).

## Status

Phase 1a (this dir): registrar core — **not yet deployed or run**; validate with `wrangler dev` + a
local D1. The CF provisioning calls it uses were proven live 2026-07-27 (`scratchpad/cf-phase0.sh`).
Next: the node `/api/attest` endpoint + phone-home client (Phase 1b), then the manager tab + sidecar (1c).
