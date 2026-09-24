# beanpool-registrar

Cloudflare Worker that leases `<name>.beanpool.org` to community nodes and keeps them honest.
Full design: [`docs/node-dns-registrar.md`](../../docs/node-dns-registrar.md).

- **Node-facing (signed):** `GET /api/registrar/available` · `POST /api/registrar/claim` ·
  `GET /api/registrar/status` · `POST /api/registrar/offline`
- **Admin (shared secret):** `GET /api/local/admin/registrar/pending` ·
  `POST /api/local/admin/registrar/:name/approve` · `POST /api/local/admin/registrar/:name/revoke`
- **Switchboard:** `GET /i/:code` (trampoline)
- **Cron:** attestation sweep every 5 min, in two phases. Phase 1 challenges every live name
  (`/api/attest`) and writes nothing; each reply is `ok`, `impostor` (a valid signature by a
  *different* node key) or `unverifiable` (down, 5xx, not an attest, or a signature we can't verify —
  never evidence). Phase 2 runs only if the sweep is believable: a configured `CANARY_NAME` attested
  `ok`, impostors ≤ max(2, 10% of live) and not every live name, unverifiable ≤ half of live. Otherwise
  it acts on no row and logs `[ATTEST_SWEEP] suspended:…`. `ATTEST_FAIL_LIMIT` consecutive impostor
  verdicts revoke the name; an `ok` or `unverifiable` verdict in an applied sweep ends the run (a
  suspended sweep changes nothing).

## Signed request scheme (node → registrar)

Headers `x-bp-pubkey` (64 hex), `x-bp-timestamp` (unix s), `x-bp-signature` (128 hex);
signed message `` `beanpool-registrar-request/v1\n${METHOD}\n${pathname}\n${timestamp}\n${bodyText}` `` with the node's Ed25519 key.

The leading domain tag is load-bearing, not cosmetic: the node signs both this and a PUBLIC attestation with the same identity key, so without distinct tags `/api/attest` is a forgery oracle for this scheme. Change it here and in `registrar-client.ts` together, never one alone.

## Attestation response (node serves at `/api/attest?nonce=`)

```json
{ "pubkey": "<hex>", "nonce": "<echoed>", "timestamp": <unix s>,
  "signature": "<Ed25519 over `beanpool-node-attest/v1\n${nonce}\n${timestamp}`, hex>" }
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
