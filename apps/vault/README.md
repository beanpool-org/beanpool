# @beanpool/vault — BeanPool's key vault

A small server that keeps each member's locked sign-in recovery copy, and gives one back only after it has checked
the Google, Apple, Facebook or GitHub sign-in itself. No community keeps a copy or can ask for one. The design is
`scratch/global-node/DESIGN-key-vault-opus.md` (V2 is this package; V3 builds the image and releases).

## Two programs

- **`vault-keyholder`** (`src/keyholder/`) holds the shares while they arrive, the master secret `M` for as long as
  it takes to use it, and the working keys. It never hands out a key. What it does is a fixed list: HMAC a copy's
  indexes, wrap an envelope (from a deposit box it opens itself), read an envelope's metadata, release a copy sealed
  to the restoring device's key, sign a ticket or the daily report, seal and open backups; and the ceremonies:
  genesis, unlock, reshare, taking a backup's state into a fresh vault. It listens on a Unix socket (0600).
- **`vault-api`** (`src/api/`) is plain `node:http`: the routes, the SQLite database (`node:sqlite`, no native
  module), holds, Expo pushes, rate limits, backups and `/v1/report`. It holds no key and never sees a copy in the clear.

Any restart of the keyholder leaves the vault locked until two custodians unlock it. While locked, every route but
`/v1/health` and `/v1/unlock/*` answers 503 `{locked: true}`.

## The keys

`M` (32 bytes) is split 2 of 3 in SLIP-0039 (`src/keyholder/slip39.ts`, checked against the 45 official vectors), each
share sealed to one custodian's pinned Ed25519 key. `M` opens `DK`, the working keys: `K_index` (the `sub_index` and
`pk_index` HMACs), `K_wrap` (envelopes), `K_disk` (V3's data partition), `K_backup`, the Ed25519 ticket key and the
X25519 deposit key. The apps pin the last two. A reshare changes `M`, `K_wrap` and `K_backup` and keeps the rest.

## Routes

| route | signed by | does |
|---|---|---|
| `GET /v1/health` | nobody | `{state, release, since}` |
| `POST /v1/ticket` | the member key, or a throwaway key to restore | a ticket; the provider nonce is `base64url(SHA-256(ticket))` |
| `POST /v1/github/start`, `/poll` | the ticket's key | GitHub's device flow, run by the vault |
| `POST /v1/copies` | the member key | a deposit: `{ticket, provider, idToken \| proof, box}` |
| `POST /v1/copies/status`, `/delete`, `/v1/push-token` | the member key | connected sign-ins and open holds; disconnect; this device's push token |
| `POST /v1/restore`, `/v1/restore/collect` | the throwaway key | every restore is held 24 hours (D2), then released sealed to that key |
| `POST /v1/holds/approve`, `/cancel` | the member key | "Yes, it's me" (released now), or Stop (never released) |
| `GET /v1/report` | nobody | signed daily totals, nothing per member |
| `POST /v1/unlock/*`, `/v1/reshare/*` | a custodian key | hello, genesis, share, restore-from-backup; reshare |

Requests are signed in BeanPool's request format 2 (`@beanpool/core` `request-signing.ts`) for the vault's own host
name. The wire formats the phone shares (tickets, deposit boxes, releases) are `@beanpool/core` `vault-wire.ts`.

## Never stored

Callsigns, emails, IP addresses, raw `sub`s, tokens, community lists, or a copy of what a release handed out. A copy's
row is `{id, sub_index, pk_index, envelope, updated_day}`.

## What V3's image must provide

The keyholder refuses to start on Linux when a core file is possible, and anywhere with a debugger or heap-snapshot
flag. Plain Node can't `mlockall`, and the vault ships no native module, so memory is kept off disk by the image:

- no swap partition or file, no hibernation, no crash kernel (kdump);
- `LimitCORE=0` on the keyholder's unit; `kernel.yama.ptrace_scope = 3`;
- the keyholder and the API under their own users, the socket and state directory readable by those two only;
- the keyholder's state directory off the data partition (it holds the key to it).

`/v1/report` says what the keyholder found.

## Tests

`pnpm --filter @beanpool/vault test`: vitest over real HTTP and a real Unix socket, with a stub JWKS, a stub GitHub and a
stub Expo, and an injected clock. No provider, host or object store is contacted.
