# Node Public-Address Registrar

**Status:** design — nothing built yet.
**Driver:** a stranger spun up a "Cairns" node; self-hosted nodes have no way to get a
`cairns.beanpool.org` address, so deep-link invites (and a memorable URL) don't work for them.
**Goal:** let an unknown operator get `<name>.beanpool.org` pointed at their node, self-service,
without ever touching Cloudflare or handling a raw API key — and without us hand-editing DNS.

Related: [[invite-architecture]], `apps/server/src/services/tls.ts` (existing Cloudflare client),
`apps/manager` (the node admin console this plugs into).

---

## 1. Why a registrar exists (the core constraint)

Almost all the plumbing already exists, but it was built for **our own** fleet:

- The app already trusts `applinks:*.beanpool.org` ([app.json:21](../apps/native/app.json)) — so on **iOS a
  new subdomain deep-links with no rebuild**. (Android can't auto-verify a wildcard — see §10.)
- A node already **serves its own** `apple-app-site-association` + `assetlinks.json` and an invite trampoline.
- A node already **gets its own TLS cert** via Cloudflare DNS-01 (`tls.ts`) — *if it holds the CF token.*

That last clause is the whole problem. The current model assumes **the node holds `CF_API_TOKEN` +
`CF_ZONE_ID`**, which can rewrite DNS for the *entire* zone (every node, including `test.beanpool.org`).
Fine on our own VMs; a hard no for a stranger.

**So the registrar is a singleton service that WE run, and it is the only thing that ever holds the
Cloudflare token.** Nodes call it; it makes the change on their behalf, scoped to one name, after our
approval (or auto — §7).

**Where it runs (decided 2026-07-27): a Cloudflare Worker / Pages Function at `beanpool.org`.**
`beanpool.org` is a static site today ([apps/website/](../apps/website)) — no server-side compute — so
"just put it on beanpool.org" means adding a Worker. That's the *right* home: serverless, always-up, no
VM to babysit, and it lives where the DNS + token already are (the thing that provisions Cloudflare,
running on Cloudflare). Trade-off: it's a **fresh small implementation**, not a reuse of the node's
Koa/SQLite — verify node signatures with **Workers Web Crypto** (Ed25519 supported), store allocations
in **D1** (serverless SQLite), keep the CF token + admin secret as **Worker secrets**. A node-hosted
variant (`REGISTRAR_MODE=1` reusing `tls.ts`) stays the fallback if the Worker path proves annoying.
*Open:* how `beanpool.org` deploys today (Pages via dashboard? git integration?) decides Worker vs
Pages Function.

---

## 2. Trust & threat model

| Concern | Mitigation |
|---|---|
| Can't hand out the CF token | Token lives only on the registrar; nodes get a **scoped tunnel token** or nothing at all |
| "Don't know who they are" | Every request is **signed by the node's keypair**; the allocation binds `name → node pubkey`; **you approve** before it goes live |
| Squatting / impersonation on your brand | Reserved-name blocklist (§5) + manual approval + you can **revoke** any lease instantly |
| A bad node abusing the name | Revoke = delete tunnel/record → node is unreachable at that name within seconds |
| Origin getting DoS'd | Offer the **tunnel** mode (origin IP never exposed) — see §3 |
| Spam registrations | Rate-limit by node pubkey + source IP; pending requests expire |

Key property: with a **tunnel**, we are the landlord and hold a kill switch. With **direct DNS**, the
operator owns their own reachability and we only hold the name.

---

## 3. Two reachability modes (operator-selectable, auto-recommended)

The manager offers a choice. The registrar **probes** the node's source IP on :443 first and
recommends, but the operator decides.

### 🛡️ Tunnel  (recommended default)
Node runs a `cloudflared` sidecar that dials **outbound** to Cloudflare; we map the hostname to that tunnel.

- ✅ **Works anywhere** — behind home NAT / CGNAT, no port-forwarding, no router config.
- ✅ **No public/static IP needed** — dynamic IP changes don't break it.
- ✅ **DoS/DDoS shielded** — Cloudflare absorbs floods; **the origin IP is never exposed** (there's no
  public A-record to attack — this is the "no DoS" win).
- ✅ **No cert on the node** — TLS terminates at Cloudflare's edge.
- ✅ **Instant kill switch** on our side.
- ⚠️ All traffic flows through Cloudflare (our account) — counts against the **1,000 tunnel / 1,000
  route** caps (§11) and CF's free-tier "mostly-HTML" ToS.
- ⚠️ Slight extra latency hop; the operator depends on us staying up.

### 🌐 Direct  (their own server)
We create a DNS **A-record** → the node's public IP; the node serves traffic itself.

- ✅ **Independent** — their box, their bandwidth; traffic never routes through our CF account.
- ✅ Doesn't consume the tunnel/route quota — just **one DNS record**.
- ✅ Lower latency (direct), no ToS concerns.
- ⚠️ Requires a **public static IP** and the ability to **open :443** (and :80 for HTTP-01 cert). Impossible on most home connections.
- ⚠️ **Origin IP is public → directly DoS-able** (no Cloudflare shield), unless proxied.
- ⚠️ Node manages its **own cert** (HTTP-01, needs :80 reachable) and its own uptime; dynamic IP breaks it.

**Proxied sub-option for Direct:** the A-record can be created `proxied: true` (orange-cloud) — then
Cloudflare *does* shield it and terminate TLS, recovering most tunnel benefits, but the origin still
must be publicly reachable and can be hit directly if the IP leaks. Default Direct to `proxied: true`
unless the operator explicitly wants a raw, fully-independent node.

**Rule of thumb baked into the recommend step:** unreachable-on-:443 → Tunnel is the *only* offer;
reachable → offer both, default Tunnel.

---

## 4. Components

```
┌────────────── Cloudflare Worker @ beanpool.org  (the registrar) ─────────────────┐
│  secrets: CF_API_TOKEN · CF_ACCOUNT_ID · CF_ZONE_ID · ADMIN_SECRET               │
│  D1: name_allocations · name_policy (auto/gated/blocked)                          │
│  • GET/POST signed node endpoints   • admin approve/revoke   • CF client (fetch)  │
└──────────────────────────────────────────────────────────────────────────────────┘
        ▲ signed HTTPS (node key, Ed25519)                ▲ admin secret (you)
        │                                                 │
┌───────┴───────── community node (Docker) ─────────┐   ┌─┴──────────────┐
│  manager "Public Address" tab  (apps/manager)      │   │ approval page  │
│  node server  (apps/server) — HTTP listener :PORT  │   │ (in the tab or │
│  cloudflared sidecar  (only in Tunnel mode)        │   │  a mini admin) │
└────────────────────────────────────────────────────┘   └────────────────┘
```

- **Registrar** — a **Cloudflare Worker / Pages Function** at `beanpool.org` (see §1). Verifies node
  signatures via Web Crypto (Ed25519), stores state in **D1**, calls the Cloudflare API with a
  token held as a **Worker secret**. (Fallback: node-hosted routes in `apps/server` reusing `tls.ts`.)
- **Manager tab** — a "Public Address" section in `apps/manager` (served at `/gateway`, admin-password
  gated), talking to *its own* node via the existing `node-client.ts` pattern; the node relays to the
  registrar so the node's identity key signs the claim.
- **cloudflared sidecar** — one extra service in the node's `docker-compose.yml`, started only when a
  tunnel token is present.

---

## 5. Data model (on the registrar)

```sql
CREATE TABLE IF NOT EXISTS name_allocations (
    name          TEXT PRIMARY KEY,            -- 'cairns'  (the label, lower-case, ^[a-z0-9-]{3,32}$)
    node_pubkey   TEXT NOT NULL,               -- claimant node's identity key
    mode          TEXT NOT NULL,               -- 'tunnel' | 'direct'
    status        TEXT NOT NULL,               -- 'pending' | 'live' | 'revoked'
    tunnel_id     TEXT,                         -- CF tunnel id (tunnel mode)
    dns_record_id TEXT,                         -- CF DNS record id (both modes)
    origin        TEXT,                         -- what cloudflared/CF points at, e.g. http://node:3000
    public_ip     TEXT,                         -- observed source IP at request time
    contact       TEXT,                         -- optional operator email/handle
    requested_at  INTEGER NOT NULL,
    decided_at    INTEGER,
    decided_by    TEXT                          -- 'admin' | 'auto'
);
-- name is PK → the atomic arbiter; two simultaneous claims, one wins, the other 409s.

CREATE TABLE IF NOT EXISTS name_policy (
    pattern TEXT PRIMARY KEY,     -- exact name or simple glob (e.g. 'sydney', 'admin')
    tier    TEXT NOT NULL         -- 'blocked' | 'gated'   (anything not listed = auto)
);
-- blocked (never): www api app admin mail smtp ns1 ns2 status help support docs blog beanpool
--                  + our own nodes test review mullum bris melb castlemaine gippsland eastgippy
--                  bindarrabi  + slurs / brand-impersonation
-- gated  (needs your approval): major place names — sydney melbourne brisbane perth adelaide
--                  cairns darwin hobart canberra newcastle goldcoast ... (seed a city list)
```

**Three tiers, all admin-editable data (not hardcoded):**
- **auto** — the default for anything not in `name_policy`; claim → live instantly (still bound to the node pubkey, still revocable).
- **gated** — big-city / high-value place names → forced to `pending` for your approval. Cairns lands here.
- **blocked** — system names, our own nodes, impersonation/slurs → refused at claim.

You can move a name between tiers or free one at any time via the admin surface.

**The registrar's table — not a DNS lookup — is the source of truth** (a lookup lags, caches, can't
see pending/reserved names, and breaks under a wildcard record; see the availability discussion). A DNS
lookup and a Cloudflare-API zone check are only belt-and-suspenders at mint time.

---

## 6. Lifecycle

```
                          ┌── auto tier ──────────────────────────┐
 private ──claim──▶ (reserve) ─┤                                       ├─▶ live ──revoke/offline──▶ revoked
                          └── gated tier ──▶ pending ──approve──┘         │
                                              │ reject / expire (24h)     │
   ◀──────────────────────────────────────────┴───────────────────────◀──┘  (name freed, reusable)
```

- **claim** — node POSTs a signed request; registrar validates the name, checks `name_policy`, reserves
  it (`INSERT`, UNIQUE), probes reachability. **auto-tier → provisions immediately (§8) and goes
  `live`; gated-tier → stops at `pending`** (nothing in Cloudflare yet).
- **approve** (gated only) — you click approve → registrar performs the CF calls (§8), stores ids, flips
  to `live`, returns the tunnel token (tunnel mode) to the node on its next poll.
- **reject / expire** — allocation deleted, name freed.
- **revoke / offline** — operator hits "Take offline" (or you revoke) → registrar deletes the CF
  tunnel + DNS record, sets `revoked`, frees the name.

---

## 7. Registrar API

### Node-facing (signed by the node keypair; signer pubkey === `node_pubkey`)

| Method / path | Body | Does |
|---|---|---|
| `GET  /api/registrar/available?name=` | — | Cheap hint: free / taken / reserved / invalid. Not authoritative. |
| `POST /api/registrar/claim` | `{ name, mode, origin, contact? }` | Atomic reserve → probe → `pending`. Returns `{ status:'pending' }` or `409`. |
| `GET  /api/registrar/status` | (signed) | Node polls: `pending` / `live` (+ `tunnelToken`, `hostname`) / `revoked`. |
| `POST /api/registrar/offline` | (signed) | Operator tears their own name down. |

`origin` is where Cloudflare/cloudflared should send traffic — for a sidecar on the compose network,
`http://node:PORT` (the node's plain HTTP listener, `app.listen(port)` in
[http-server.ts:144](../apps/server/src/http-server.ts)); TLS is terminated at the edge so the origin
hop is plain HTTP on the private network.

### Admin-facing (`checkAdminAuth` — your password)

| Method / path | Does |
|---|---|
| `GET  /api/local/admin/registrar/pending` | List pending + live allocations for the approval page |
| `POST /api/local/admin/registrar/:name/approve` | Run the CF provisioning, go `live` |
| `POST /api/local/admin/registrar/:name/revoke`  | Delete CF resources, free the name |

**Auth note (learned from the treasury work):** the signed-request guard pins body fields ending in
`pubkey` to the signer. Nothing here needs a pubkey in the body (the signer *is* the claimant), so no
path-vs-body gymnastics required — just don't add a `*pubkey` body field.

---

## 8. Exact Cloudflare calls

Extend the `cf*` helpers in `tls.ts` into a small `cf-client.ts` (same `Bearer ${CF_API_TOKEN}` fetch
pattern already at [tls.ts:274](../apps/server/src/services/tls.ts)). New env: **`CF_ACCOUNT_ID`**
(tunnels are account-scoped; only `CF_ZONE_ID` exists today). Token scopes needed:
**Account · Cloudflare Tunnel · Edit** and **Zone · DNS · Edit** on the beanpool.org zone.

### Tunnel mode (on approve)
1. **Create tunnel** — `POST /accounts/{account_id}/cfd_tunnel`
   `{ "name": "bp-<name>", "config_src": "cloudflare" }` → `result.id` (remotely-managed config, so the
   operator's cloudflared needs only the token).
2. **Fetch connector token** — `GET /accounts/{account_id}/cfd_tunnel/{id}/token` → handed back to the
   node, which runs `cloudflared` with it automatically. It's also **shown in the admin tab** (masked,
   with reveal/copy/rotate) so a self-hoster can run/debug the connector by hand — it's their own
   resource's credential.
3. **Set ingress** — `PUT /accounts/{account_id}/cfd_tunnel/{id}/configurations`
   `{ "config": { "ingress": [ { "hostname": "<name>.beanpool.org", "service": "<origin>" },
   { "service": "http_status:404" } ] } }`.
4. **Route the hostname (DNS CNAME)** — `POST /zones/{zone_id}/dns_records`
   `{ "type":"CNAME", "name":"<name>", "content":"<id>.cfargotunnel.com", "proxied": true }` → store `dns_record_id`.

### Direct mode (on approve)
1. **A-record** — `POST /zones/{zone_id}/dns_records`
   `{ "type":"A", "name":"<name>", "content":"<public_ip>", "proxied": <true default | false raw> }` → store `dns_record_id`.
2. Node obtains its own cert via **HTTP-01** (needs :80) — or, if `proxied:true`, CF terminates TLS and the node can stay on plain HTTP behind the proxy.

### Revoke (both)
- `DELETE /zones/{zone_id}/dns_records/{dns_record_id}`
- tunnel mode also: `DELETE /accounts/{account_id}/cfd_tunnel/{id}` (clean connections first, or `?cascade`).

> ✅ **VALIDATED live 2026-07-27** (Phase 0, `scratchpad/cf-phase0.sh`): all four tunnel-mode calls
> succeeded against the real account and read back correctly — create returned a tunnel id, the token
> endpoint returned a 240-char connector token, the ingress `PUT` stored the hostname→origin rules, and
> the CNAME `POST` created `<label> → <id>.cfargotunnel.com` (proxied). Revoke (`DELETE` record then
> tunnel) removed both cleanly. Shapes above are confirmed, not guessed.

---

## 9. Node / manager side

**Manager "Public Address" tab** — three states (private → requesting → live), with a mode toggle:

```
NETWORKING ▸ Public Address
  This node is private (LAN only).

  Address:  [ cairns            ].beanpool.org     ✅ available
  Reach it via:   ( 🛡️ Tunnel — recommended )   ( 🌐 Direct )
                  no ports · DoS-shielded          your IP · independent
                                         [  Go public  ]
  ── requesting ──▶  ⏳ tunnel created · awaiting approval        (gated names only)
  ── live ──▶        🟢 Live at cairns.beanpool.org   [Copy]   [ Take offline ]
                     Tunnel token  ••••••••••••  [Reveal] [Copy] [Rotate]
```

**Handshake:** the node stores the chosen name/mode, calls `claim`, then polls `status`. On `live` in
tunnel mode it receives the token, writes it to its data dir, and starts/refreshes the `cloudflared`
sidecar **automatically**. The token is *also* surfaced in this admin-only tab (masked, with
reveal/copy/rotate) so a self-hoster can run or debug the connector themselves — auto-assigned *and*
visible.

**Config surface (node):** `COMMUNITY_NAME` (or set via the tab), `REGISTRAR_URL`
(default `https://beanpool.org`), plus a stored `TUNNEL_TOKEN` the node manages itself.

**Docker compose (tunnel mode):** add a `cloudflared` service —
`cloudflared tunnel run --token ${TUNNEL_TOKEN}` — on the same network as the node; ingress `origin`
points at the node's service name. Started only when a token exists.

---

## 10. Deep links & the "switchboard" invite

**Where the deep-link list actually lives:** baked into the app binary
([apps/native/app.json](../apps/native/app.json) — iOS `associatedDomains`, Android `intentFilters`),
fixed at build time. **Not** Firebase (Firebase Dynamic Links was shut down in 2025) and **not** EAS
(that only *builds* the app). Adding a brand-new domain ⇒ rebuild + resubmit to both stores ⇒ does not
scale per-community. So we never do that.

**The switchboard: every invite is a `beanpool.org` link that carries the node's address.**
```
https://beanpool.org/i/<code>            →  resolves to { node: <any-url>, code }
```
The app opens because the link is on `beanpool.org` (already trusted), reads the node address, and
connects to **any node on any domain.** Consequences:
- **No per-community rebuilds, ever** — a community can host on `cairns.beanpool.org`, on
  `beanpool.theircommunity.org.au`, on a bare IP — invites still one-tap-open the app.
- **Android is solved too** — the invite lives on the **apex `beanpool.org`**, which *is* an
  `autoVerify` host on both platforms, so it auto-opens. (The un-verifiable `*.beanpool.org` wildcard
  only matters if you deep-link a subdomain *directly*; route invites through the apex and it's moot.)
- **Bring-your-own-domain gets full deep-linking**, not the degraded trampoline — because the invite
  URL is `beanpool.org`, not their domain. Their *node traffic* stays entirely on their domain (off our
  account); only the tiny "open the app" hop touches `beanpool.org`.

Each node still serves its own AASA/assetlinks (already true) for the case where someone opens a
subdomain URL directly.

---

## 11. Abuse resistance & attestation

**The threat:** a bad actor registers `freeshipping.beanpool.org`, takes the tunnel token, and points
it at a drug/arms/CSAM server. Because it's proxied through *our* Cloudflare account and under *our*
domain, the liability — and a possible account suspension that would take down the **whole fleet** —
lands on us. So abuse controls ship **with** the registrar, not after.

1. **Attestation (the core defence, v1).** The registrar periodically calls
   `GET https://<name>.beanpool.org/api/attest?nonce=<rand>` and requires a reply **signed by the
   registered `node_pubkey`** over the nonce+timestamp. Three outcomes, deliberately handled differently:
   - **ok** (valid signed reply) → verified, stays live.
   - **mismatch** (the origin answers 2xx but it isn't our node — wrong key / not our JSON) → the origin
     was **swapped** → abuse → **auto-revoke fast** (2 consecutive misses ≈ 10 min).
   - **unverified** (unreachable / 5xx / no connector) → the node is simply **offline** → **never
     auto-revoked.** Critical for solar/off-grid nodes that sleep overnight — being *down* is benign
     (visitors just get a tunnel error); only serving *other content* is punished. The name shows as
     "unverified since …" in the admin console for optional manual review.

   **What operators must know (surface in the manager tab + operator docs):** *"Your address stays
   yours as long as your node runs beanpool — the check is automatic, nothing to do. If your node goes
   offline it is **not** taken away; it just isn't reachable until it's back. It's only auto-removed if
   your node starts serving something that isn't beanpool, if you take it offline yourself, or if an
   admin revokes it."*
2. **Approval gate.** Manual approval on `gated` names now (paper trail, bound to pubkey + contact);
   auto for the rest. Fast one-click **revoke** always available.
3. **Raise the cost of anonymity.** Registration binds `name → node_pubkey` + a contact / an existing
   community's vouch (optional lever) — ends drive-by anonymous abuse, gives an audit trail.
4. **Blast-radius isolation (decision to make).** Consider standing up third-party tunnels so a
   suspension can't nuke the production fleet. True isolation likely needs a **separate domain** for
   stranger nodes (costs the `*.beanpool.org` wildcard) — but the switchboard (§10) already lets a
   separate-domain node keep full deep-linking, so this is more viable than it first seemed.
5. **CF's own scanning** (CSAM/malware) is a backstop — but attestation should catch abuse *first*, so
   it's our kill switch and not their account-suspension.

**Honest residual:** attestation proves "the registered node is here," not "*only* it is here" — a
determined actor could run a real node *and* smuggle other content on the same host. Not fully
preventable at the tunnel layer. What we *guarantee*: abuse is **short-lived (auto-revoked),
attributable (pubkey + contact), low-blast-radius (isolation), and instantly killable.**

---

## 12. Limits (verified 2026-07-27)

- Cloudflare Tunnel: **1,000 tunnels/account** and **1,000 routes/account** (raised only on Enterprise).
- DNS records/zone: **200** (zones created ≥ 1 Sep 2024) or **1,000** (older) on Free; **3,500** on Pro/Business.
- Each tunnel hostname is *also* a proxied DNS record → three caps that all land near **~1,000
  communities**. Tunnels are the *harder* ceiling (Enterprise to lift) vs records (Pro lifts to 3,500).
- **At scale**, graduate nodes that have a real public IP to **Direct** A-records (1 record, no tunnel
  quota) and reserve tunnels for the NAT'd minority.

---

## 13. The cases we cover + build plan

**Three operator cases, one registrar:**

| Case | Address | Reachability | Traffic through our CF? | Who holds the leash |
|---|---|---|---|---|
| **A** *(default, unknown ops)* | `<name>.beanpool.org` | 🛡️ Tunnel | yes | us (kill switch + attestation) |
| **B** *(public-IP ops)* | `<name>.beanpool.org` | 🌐 Direct A-record (proxied) | optional | us (DNS) + them (origin) |
| **C** *(fully independent)* | their own domain | their own | **no** | them (we only hold the switchboard invite) |

All three: name claimed in the registrar's table (auto/gated/blocked), invites ride the **switchboard**
(§10), and live names are held to **attestation** (§11).

**Build order:**

- **Phase 0 — hand-validate (now, ~15 min, mutates CF):** run the real create-tunnel → set-ingress →
  route → attest → revoke sequence against the account (creds confirmed 2026-07-27; account
  `151a28c4…`, zone `060a99ae…`) on one throwaway name, to lock the exact API shapes before coding.
- **Phase 1 — MVP (Case A):** registrar Worker (D1: `name_allocations` + `name_policy`; signed
  claim/status/offline; admin pending/approve/revoke; CF client tunnel path) · **attestation loop** ·
  manager "Public Address" tab · `cloudflared` compose sidecar · node `/api/attest` endpoint ·
  **switchboard** `beanpool.org/i/<code>` + app handler. Approval manual.
- **Phase 2 — breadth:** Case B (Direct/A-record + reachability probe) · Case C (BYO-domain wired to the
  switchboard) · auto-approve for the `auto` tier · public community directory · isolation decision.

**Deploy-time (not blocking code):** confirm how `beanpool.org` deploys (Pages vs standalone Worker);
mint a scoped token (Zone·DNS·Edit + Account·Tunnel·Edit) to replace the DNS-only one.

---

## 14. Decisions (2026-07-27) + what's still open

**Decided:**
- **Registrar = Cloudflare Worker/Pages Function at `beanpool.org`** (not a node). §1, §4.
- **Approval = auto by default; `gated` tier (big-city names) needs your click; `blocked` refused.** §5, §7.
- **Name policy is admin-editable data** (auto/gated/blocked tiers), changeable anytime. §5.
- **Tunnel token is shown to the operator** (admin tab, masked + reveal/copy/rotate), not hidden. §8, §9.
- **Both reach-modes selectable** (🛡️ Tunnel default / 🌐 Direct), registrar recommends via a probe. §3.
- **Switchboard invites** — every invite is a `beanpool.org/i/<code>` link carrying the node address; so
  **any** community (subdomain *or* own domain) gets full one-tap deep-linking, no per-domain rebuilds. §10.
- **Bring-your-own-domain allowed** and **not degraded** — its node traffic stays off our account; its
  invites still open the app via the switchboard. §10, Case C.
- **Attestation is in v1** (continuous signed proof-of-node → auto-revoke); manual approval for now. §11.
- **Registrar = a Cloudflare Worker with a cron trigger** (refined 2026-07-27) — attestation needs a
  *scheduled* sweep, which Pages Functions can't do but a Worker can (`fetch` + `scheduled` handlers).
  `beanpool.org` is Cloudflare Pages (static site); the Worker attaches via **Worker Routes** on the
  zone (`beanpool.org/api/registrar/*`, `beanpool.org/i/*`) and coexists with the Pages site. Storage = **D1**.

**Still open:**
1. **Isolation** — third-party tunnels on the main account (accept the shared-suspension risk) vs a
   separate domain/account for stranger nodes (switchboard keeps their deep-linking either way). §11.
2. **Seed the `gated` city list** + name syntax rules (min length, hyphens, confusables).
3. Pages Function (D1 + Web-Crypto Ed25519 verify) vs node-hosted fallback if the rewrite gets fiddly.
