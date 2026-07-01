# BeanPool Server Node

> Gateway, REST APIs, WebSocket state feeds, Libp2p mesh networking, and lazy CRDT state sync.
> Everything a community admin needs to understand and deploy their own BeanPool node.

---

## 🏗️ Architecture Overview (Key Files)

| File | Purpose |
|------|---------|
| `src/index.ts` | Main boot orchestrator — 5-stage startup |
| `src/tls.ts` | **TLS certificate management** — LE via acme-client + self-signed fallback |
| `src/state-engine.ts` | In-memory state: members, posts, profiles, conversations, messages, invites, ledger, ratings, reports, sybil filters. Handles secure async cryptographic Ed25519 verification for P2P sync payloads on import. |
| `src/https-server.ts` | 67+ REST API endpoints: community, marketplace, friends, ratings, reports, admin, version/update, push notifications, escrow lifecycle, database backup, social recovery, quadratic voting. Enforces a Deny-by-Default security posture with `ctx.state.actor` and body spoof-checking. |
| `src/http-server.ts` | HTTP endpoint (port 80) for Let's Encrypt validation, LAN QR Poster, and HTTPS redirect |
| `src/p2p.ts` | Core libp2p node instantiation, bootstrap logic, and gossipsub |
| `src/connector-manager.ts` | Federated connectors with trust levels (mirror/peer — *experimental*, blocked) |
| `src/federation-api.ts` | Federation CORS middleware + `/api/node/info` |
| `src/federation-protocol.ts` | Secure Libp2p authenticated Noise streams for cross-node mesh routing |
| `src/handshake.ts` | Mutual trust verification + latency via yamux streams |
| `src/sync-protocol.ts` | Lazy state sync — Merkle hash + delta exchange |
| `src/test-sync-signature.ts` | **Sync signature integration test** — Standalone suite verifying cryptographic P2P sync payload signing and verification |
| `src/local-config.ts` | Admin auth (scrypt) + node config |
| `src/dns-shim.ts` | Captive portal DNS responder to resolve `beanpool.local` locally |
| `src/genesis.ts` | Initializes node configuration and creates the immutable genesis block |
| `src/seed-organic.ts` | Test script to seed the database with mock organic marketplace posts |
| `src/directory-publisher.ts` | Push-model publisher — syncs node metadata to the global beanpool.org Supabase directory |
| `src/db/db.ts` | SQLite database layer — `better-sqlite3` with WAL mode, self-healing schema migrations |
| `src/db/schema.sql` | Database schema — members, posts, transactions, conversations, messages, ratings, reports |
| `src/db/synonyms.json` | FTS5 synonym mapping for marketplace full-text search |
| `static/settings.html` | Admin settings page — Contextual tab layout (Identity, Network, Invites, Moderation, Audit, Commons, Inbox & Comms) with Database Backup |
| `static/settings.js` | Admin settings JavaScript — login, tabs, update checks, moderation centre, health dashboard, branch stats (Hardened against Stored XSS). |
| `../../.jules/sentinel.md` | Security audit journal maintained by the Sentinel process |
| `../../.jules/security_backlog.md` | Security task backlog |
| `../../scripts/verify-auth-boundary.mjs` | **Auth boundary verifier** — standalone script to test 38+ routes (114 checks) against the deny-by-default requireSignature middleware |

---

## 🛠️ Node Administration & Setup

### Prerequisites

| What | Why |
|------|-----|
| **Linux server** (Ubuntu 22+, Debian 12+, etc.) | Runs the Docker container |
| **Docker + Docker Compose** | Container runtime |
| **SSH access** to the server | Remote management |
| **Port forwarding** (or cloud firewall rules) | Expose services to the internet |

### Ports Required

| Port | Protocol | Purpose |
|------|----------|---------|
| **80** | HTTP | Redirect to HTTPS + QR poster page |
| **443** | HTTPS | PWA, API, admin settings |
| **4001** | TCP | Node-to-node gossip (libp2p) |
| **4002** | TCP | Yamux multiplexed streams |

---

### Option A: Public Node (with Domain + Let's Encrypt)

This is the **recommended** setup for internet-facing nodes. Free auto-renewing TLS certs from Let's Encrypt.

#### Step 1: Get a Domain + Cloudflare DNS

1. Register a domain (e.g. `mycommunity.org`) — or use a subdomain of one you own
2. Add the domain to **[Cloudflare](https://dash.cloudflare.com)** (free tier works)
3. Create an **A record** pointing to your server's public IP:
   - Name: `bean` (or whatever subdomain, e.g. `bean.mycommunity.org`)
   - Content: your server's public IP
   - Proxy: **OFF** (DNS only, grey cloud)
4. Get your Cloudflare credentials:
   - **API Token**: Cloudflare → My Profile → API Tokens → Create Token → "Edit zone DNS" template
   - **Zone ID**: Cloudflare → your domain → Overview → right sidebar under "API"

#### Step 2: Install Docker

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in, then verify:
docker --version
docker compose version
```

#### Step 3: Create the Project Directory

```bash
mkdir -p ~/BeanPool && cd ~/BeanPool
```

#### Step 4: Create `docker-compose.yml`

```yaml
services:
  beanpool-node:
    image: ghcr.io/martyinspace/beanpool-node:latest
    ports:
      - "80:8080"
      - "443:8443"
      - "4001:4001"
      - "4002:4002"
    environment:
      - PUBLIC_IP=${PUBLIC_IP}
      - ADMIN_PASSWORD=${ADMIN_PASSWORD}
      - BEANPOOL_DATA_DIR=/data
      - CF_API_TOKEN=${CF_API_TOKEN}
      - CF_ZONE_ID=${CF_ZONE_ID}
      - CF_RECORD_NAME=${CF_RECORD_NAME}
    volumes:
      - ./data:/data
    restart: unless-stopped
```

#### Step 5: Create `.env` File

```bash
cat > .env << 'INNEREOF'
PUBLIC_IP=YOUR_SERVER_PUBLIC_IP
ADMIN_PASSWORD=choose-a-strong-password-here
CF_API_TOKEN=your-cloudflare-api-token
CF_ZONE_ID=your-cloudflare-zone-id
CF_RECORD_NAME=bean.mycommunity.org
INNEREOF
```

> **Important:** Replace all values with your actual credentials. The `CF_RECORD_NAME` must exactly match the A record you created in Cloudflare.

#### Step 6: Start the Node

```bash
# Pull the latest image
docker compose pull

# Start in background
docker compose up -d

# Watch the logs
docker compose logs -f
```

#### Step 7: Access Your Node

- **PWA**: `https://bean.mycommunity.org`
- **Admin Settings**: `https://bean.mycommunity.org/settings.html`
- **QR Poster** (for printing): `http://bean.mycommunity.org` (HTTP, for LAN access)

---

### Option B: LAN-Only Node (No Domain Required)

For local networks, home servers, or testing. Uses **self-signed certificates** — no domain or Cloudflare needed.

#### Step 1: Install Docker

Same as Option A Step 2.

#### Step 2: Create the Project Directory

```bash
mkdir -p ~/BeanPool && cd ~/BeanPool
```

#### Step 3: Create `docker-compose.yml`

```yaml
services:
  beanpool-node:
    image: ghcr.io/martyinspace/beanpool-node:latest
    ports:
      - "80:8080"
      - "443:8443"
      - "4001:4001"
      - "4002:4002"
    environment:
      - PUBLIC_IP=YOUR_LAN_IP
      - ADMIN_PASSWORD=choose-a-strong-password
      - BEANPOOL_DATA_DIR=/data
    volumes:
      - ./data:/data
    restart: unless-stopped
```

> **Note:** No `CF_*` variables — the node detects this and automatically falls back to self-signed certificates.

#### Step 4: Start the Node

```bash
docker compose pull
docker compose up -d
docker compose logs -f
```

#### Step 5: Access Your Node

- **PWA**: `https://YOUR_LAN_IP` (browser will warn about self-signed cert)
- **Admin Settings**: `https://YOUR_LAN_IP/settings.html`

### ⚠️ Self-Signed Certificate Warning

To avoid this, you can install the CA certificate:
- Visit `http://YOUR_LAN_IP` (HTTP, not HTTPS)
- Download the CA certificate from the trust page
- Install it on each device

---

### Option C: Public Node via Cloudflare Tunnel (Portless & Edge SSL Terminated)

For nodes running behind NAT, residential connections, or firewalls where opening inbound ports 80/443 is not possible or desired. SSL termination is handled at the Cloudflare Edge.

#### Step 1: Create a Cloudflare Tunnel
1. Go to your Cloudflare Zero Trust Dashboard -> Access -> Tunnels.
2. Create a new tunnel (e.g. `beanpool-tunnel`) and copy the connector token.
3. Add a public hostname mapping:
   - Subdomain: `bean` (e.g. `bean.yourcommunity.org`)
   - Service: `https://localhost:8443` (mapping to the node's TLS port)
   - Under **HTTP Settings**, enable **No TLS Verify** (since the node uses a self-signed fallback certificate locally)

#### Step 2: Add Tunnel to `docker-compose.yml`
Configure the `cloudflared` agent container to run alongside your BeanPool node:

```yaml
services:
  beanpool-node:
    image: ghcr.io/martyinspace/beanpool-node:latest
    ports:
      - "8443:8443"
      - "4001:4001"
      - "4002:4002"
    environment:
      - PUBLIC_IP=bean.yourcommunity.org
      - ADMIN_PASSWORD=choose-a-strong-password
      - BEANPOOL_DATA_DIR=/data
    volumes:
      - ./data:/data
    restart: unless-stopped

  tunnel:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run
    environment:
      - TUNNEL_TOKEN=your-cloudflare-tunnel-token-here
    restart: unless-stopped
```

#### Step 3: Access Your Node
- **PWA**: `https://bean.yourcommunity.org` (served with a valid Cloudflare Edge SSL certificate, no warnings!)
- **Admin Settings**: `https://bean.yourcommunity.org/settings.html`

---

### Post-Setup: First-Time Configuration

#### 1. Set Your Admin Password
Navigate to `https://your-node/settings.html` and log in with the password you set in `.env`.

#### 2. Create the Genesis Block
1. Go to Settings → choose a **community name**
2. Set the **initial credit limit** (how many Beans each member can go into debt)
3. Click **Initialize** — this creates the immutable genesis block

#### 3. Configure Community Info
In Settings → **Community** tab, set: Community Name, Admin Email, Admin Phone

#### 4. Generate Seed Invite Codes
- In Settings → **Invite Codes**, generate codes for your founding members
- Use one on your own phone to bootstrap the network, creating your deterministic Ed25519 member identity via a 12-word seed phrase recovery method.

#### 5. Connect to Other Nodes (Optional)
- In Settings → **Connectors**, choose **Peer** trust (federation) or **Mirror** (backup).

---

### Maintenance & Troubleshooting

#### Let's Encrypt Rate Limits
Let's Encrypt allows **5 duplicate certificates per domain per week**. If you hit the limit:
- The node will log `⚠️ Let's Encrypt failed — falling back to self-signed`
- It will automatically retry every 24 hours

#### Backups
All persistent data is in `./data/`. Copy this folder to natively backup all SQLite databases.

#### Software Updates
Your node automatically checks GitHub for new releases every 6 hours. When an update is available:
- A pulsing badge appears in the admin header next to the version number
- The System tab shows version comparison and release notes
- To update, run on the Docker host:

```bash
cd ~/BeanPool
docker compose pull
docker compose up -d
```

> Your data is preserved in `./data/` — only the application container is replaced.

You can configure the auto-check interval (Hourly / Every 6 hours / Daily / Weekly) in Settings → System tab.

#### Developer Release Flow (Pushing a New Version)

When you're ready to ship a new version, the entire pipeline is driven by **git tags** — no manual version bumps in `package.json` needed.

```bash
# 1. Commit and push your changes to main
git add -A && git commit -m "feat: your changes"
git push origin main

# 2. Tag the release (this triggers the full pipeline)
git tag -a v1.0.38 -m "Short description of what's new"
git push --tags
```

**What happens automatically:**

1. **GitHub Actions** detects the `v*` tag push
2. **Builds** the Docker image with `APP_VERSION=1.0.38` baked in as a build arg
3. **Pushes** to GHCR as `:latest` + `:v1.0.38` + `:1.0` + `:sha-xxxxx`
4. **Creates a GitHub Release** with auto-generated release notes from commits since last tag
5. **All deployed nodes** detect the new version within their configured check interval (default 6h)
6. **Admin sees** the pulsing update badge in the header → clicks through to System tab → copies the update commands

> **Version priority chain:** The server resolves its running version as: `APP_VERSION` env var (set by CI) → `/app/.version` file → `package.json`. This means the git tag is always the source of truth in production.

To deploy immediately (without waiting for auto-detection):
```bash
bash deploy.sh        # All nodes
bash deploy.sh 2      # Mullum 2 only
bash deploy.sh 1 4    # Mullum 1 + Review
```

---

### 🛡️ Authentication Boundary Verification

To prevent regression or accidental exposure of new endpoints, a standalone, dependency-free verification script is provided at `scripts/verify-auth-boundary.mjs`. This script tests every protected route against three attack vectors:
1. **Unsigned requests**: Checks that requests without signature headers return `401 Unauthorized`.
2. **Wrong-key signatures**: Checks that requests signed with a key mismatching the claimed public key return `403 Forbidden`.
3. **Spoofed bodies**: Checks that requests with valid signatures but a spoofed `publicKey` inside the request body return `403 Forbidden`.

To run the verifier:
```bash
# Terminal 1: Start the server
pnpm --filter @beanpool/server dev

# Terminal 2: Run the verifier
node scripts/verify-auth-boundary.mjs
```
The script will run 114 checks (38 routes × 3 tests) and must print `Boundary holds.` at the end.

---

### 🛡️ Federation Security & Verification Gates

To protect federated nodes from replay attacks, origin spoofing, and balance manipulation, the node enforces several security gates:
1. **Replay-Proof Signed Requests (X-1)**: Every mutating REST API request uses cryptographic client Ed25519 signatures validated against timestamps and request nonces to prevent capture and replay.
2. **CORS Exact-Origin Verification (SRV-5)**: Cross-community API requests are verified against an exact allowed list of trusted peer node origins rather than permitting wildcard origins.
3. **Positive-Amount Ledger Validation (SRV-8)**: Deep ledger routing checks enforce that all credit transfer transactions carry positive amounts (> 0), preventing zero-amount or negative-amount credit drain attacks.
4. **Trusted Peer Sync Gating (SRV-1)**: P2P replication sync endpoints are gated strictly behind authenticated and trusted peer domains, dropping connections from untrusted node identities.

---

## 🪞 Mirroring, Failover & Merging Nodes

Because BeanPool's internal state engine (Ledger, Members, Web of Trust, and Posts) is built entirely on top of **Conflict-Free Replicated Data Types (CRDTs)**, node operators have incredibly flexible options for backing up, failing over, and even merging communities together.

### 1. Setting Up a Mirror (Disaster Recovery Backup)

A `mirror` connector silently maintains a mathematically identical, real-time copy of your primary node's `state.db` (SQLite). 

**Steps:**
1. Log into the Admin Settings of both your Primary Node and your Backup Node and exchange `PeerID`s.
2. Bridge Primary to Backup: Connectors Tab -> Public URL + PeerID -> `mirror`.
3. Bridge Backup to Primary: Repeat inverted process.

The nodes will instantly handshake over the Yamux stream protocol, exchange Merkle tree root hashes, identify the state deltas, and stream the missing CRDT events seamlessly.

### 2. Automated Failover (Cloudflare Load Balancing)

Because both nodes now possess the identical live state, automate failover at the DNS layer:

> [!WARNING]
> **CRITICAL: NEVER USE ACTIVE‑ACTIVE (ROUND‑ROBIN) ROUTING**
> The mirror connector sync runs on a **30 second interval** (default). During this window there is a consistency lag before state changes on the primary propagate to backups.
> If you configure a load balancer to distribute traffic evenly (active‑active), a client request may hit a backup node that has not yet received the latest state, leading to missing posts, duplicate transactions, or `404 Not Found` errors.
> 
> **YOU MUST configure the load balancer as ACTIVE‑PASSIVE (FAILOVER)** so that all client traffic is pinned to a single **Primary** node. Backups remain warm standby replicas.
> 
> For a 3‑node deployment, define a strict priority chain (**Primary → Secondary → Tertiary**) so traffic only moves to the next node when the higher‑priority node is unavailable.

**Steps:**
1. In Cloudflare, navigate to **Traffic → Load Balancing**.
2. Create an **Active‑Passive (Failover)** pool with priority ordering:
   - **Primary:** `mullum1.beanpool.org` (Priority 1)
   - **Secondary / Backup:** `mullum2.beanpool.org` (Priority 2)
   - **Tertiary (optional):** `mullum3.beanpool.org` (Priority 3)
3. Add a **Health Check** (e.g., HTTP GET `/healthz`) that pings the active server every **60 seconds**.

If the primary node goes down or is taken offline for an update, Cloudflare will instantly fail over all traffic to the secondary node, preserving a consistent user experience.

### 3. Merging Two Separate Communities

1. Connect Node A to Node B via explicit Mutual Trust set to `mirror` on both boxes.
2. **The CRDT Merge:** The nodes will mathematically resolve the event logs. Bob's posts from Node A will simply interleave cleanly alongside Alice's posts from Node B. Balances expand organically without zero-sum collisions.

### 4. Rolling Updates (Zero Downtime)

For infrastructure upgrades or standard node bin-pull deployments without user disruption:
1. **Deploy to Backup/Secondary Node:** Update the backup node container (e.g. `mullum2`). Since all active users are pinned to the Primary node, they experience zero disruption.
2. **Re-Sync:** Once the backup node boots back up, it automatically performs an organic catch-up sync with the Primary.
3. **Deploy to Primary Node:** Run the update on the Primary node container (e.g. `mullum1`).
4. **Transparent Failover:** When the primary node stops, the load balancer's health check is tripped, transparently re-routing all active users to the already-updated Secondary/Backup node.
5. **Auto-Restore:** Once the Primary node finishes updating and passes the health check, the load balancer automatically restores all traffic back to the Primary node.

### 5. Federating with a Mirrored Community

Neighboring communities scaling federation can elegantly federate through a single point:
1. External node (`review`) adds ONE connector pointing to `mullum.beanpool.org` (the Load Balancer).
2. The admins residing across the Target Mirrored infrastructure must log into BOTH `mullum1` and `mullum2` to explicitly establish mutual trust `peer` rules referencing `review`'s public attributes.

### 6. P2P Mirroring over a Cloudflare Tunnel (Secure WebSockets)

Decentralized nodes running behind a Cloudflare Tunnel (`cloudflared`) on private/residential networks cannot accept raw TCP connections (port `4001`) inbound. Since Cloudflare Tunnels are optimized for standard web protocols (HTTP/HTTPS/WebSockets over `80`/`443`), raw P2P mirroring must be routed over secure WebSockets (`wss`) instead:

1. **Dedicated DNS Setup (Proxied)**:
   - Create a CNAME record on Cloudflare (e.g. `p2p-mullum2.beanpool.org`) pointing to your canonical tunnel ID.
   - **Crucial**: The record must be orange-clouded (`proxied: true`). If grey-clouded, it resolves to Cloudflare's virtual routing IPv6 space (`fd10:aec2:5dae::`) causing `Network is unreachable` errors.
2. **Ingress Routing Configuration**:
   - In `/etc/cloudflared/config.yml` on the host machine, map the P2P subdomain directly to your container's local libp2p WebSocket port:
     ```yaml
     ingress:
       - hostname: p2p-mullum2.beanpool.org
         service: http://localhost:4007  # Mapped via Docker to container port 4002
     ```
3. **P2P Multiaddress Format**:
   - Remote nodes must dial the tunnel-routed node using the secure WebSocket DNS address on port `443` (not the default libp2p port):
     ```text
     /dns4/p2p-mullum2.beanpool.org/tcp/443/wss/p2p/PEER_ID
     ```

### 7. Self-Healing Stale Socket Drops

When a mirrored node is restarted, the remote node may retain a "stale" yamux socket reference. Because the socket is dead but libp2p retains a stale connection reference, the node gets stuck in an asymmetric `Outbound Only` state with failing handshakes.

To prevent this, the server integrates a self-healing socket pruner:
- **Continuous Handshake Checks**: The node runs a periodic handshake routine every 10 seconds.
- **Auto-Hangup**: If a handshake fails on a node marked as `connected`, the node logs the failure, resets all internal connection flags, and forcefully executes `p2pNode.hangUp(peerId)` to purge the stale socket.
- **Auto-Recovery**: The connection retry loop automatically dials a clean, fresh Yamux stream, establishing a fully mutual, bidirectional synced state within 30 seconds of a restart.

### 8. Active/Passive Collision & Deadlock HUD Warnings

To coordinate node connections and prevent concurrent dial-racing or silent connection hangs:
- **Active Dialer (`enabled: true`)**: The connector will actively dial the target node at the specified address and intervals.
- **Passive Listener (`enabled: false`)**: The connector waits to receive incoming connections and handshakes from the peer without actively dial-out.

During handshake, nodes exchange their connection roles (`c.enabled` and `remoteActive`), which the Admin dashboard (served at `/settings.html` via `static/settings.js`) monitors dynamically:
- **Dual Active Collision (`⚠️ Collision` - Red)**: Triggered when both sides are configured as Active dialers (`c.enabled !== false && c.remoteActive === true`). Displays a prominent red warning asking to click **"Make Passive"** on one node to prevent connection bouncing.
- **Dual Passive Deadlock (`⚠️ Deadlock` - Yellow)**: Triggered when both sides are configured as Passive listeners (`c.enabled === false && c.remoteActive === false && c.connected`). Displays a yellow warning badge and instructions to click **"Make Active"** on one node to initiate syncing.

### 9. Push-on-Write Real-Time Replication

To support immediate, low-latency replication of directory listings, posts, and transactions between trusted mirrors:
- **WebSocket Delta Broadcasts**: Instantly triggers state updates to all active mirror streams over secure WebSockets `/beanpool/sync/delta/2.0.0` upon any database write.
- **Ed25519 Payload Signatures**: To maintain a zero-trust architecture, the server signs all outgoing delta event payloads using its unique private libp2p Ed25519 identity key.
- **Cryptographic Verification**: The receiving mirror verifies the signature using the peer's public key before committing the delta transaction to the local SQLite database.

### 10. 15-Minute Safety Reconcile & Tombstone Pruning

A robust background data lifecycle management strategy guarantees ultimate consistency and keeps storage footprints light:
- **15-Minute Safety Reconcile**: As a fallback for lost delta frames or socket drops, a periodic background routine re-compares the full Merkle tree of the local and remote node states, triggering a catch-up sync.
- **24-Hour Tombstone GC**: Soft-deleted entries leave database tombstones to track deletions. A daily garbage collector automatically prunes tombstones older than 30 days once downstream mirror peer cursors have caught up and synced past them.

---

## 🌐 Live Network Topology

The project maintains 5 live independent nodes spanning bare-metal and Azure VMs. All four bare-metal nodes run on the Debian "Lighthouse" server at `192.168.1.219`, served via Cloudflare Tunnel.

| # | Flag | Name | IP Address | DNS Name | Type | PWA |
|---|------|------|-----------|----------|------|-----|
| 1 | 🇦🇺 | Mullum 1 | `20.211.27.68` | `mullum1.beanpool.org` | Azure VM (AU) | [Open](https://mullum1.beanpool.org) |
| 2 | 🏠 | Mullum 2 | `192.168.1.219` | `mullum2.beanpool.org` | Bare Metal (Cloudflare Tunnel) | [Open](https://mullum2.beanpool.org:8447) |
| 4 | 🏠 | Review | `192.168.1.219` | `review.beanpool.org` | Bare Metal (Cloudflare Tunnel) | [Open](https://review.beanpool.org:8445) |
| 5 | 🏠 | Test | `192.168.1.219` | `test.beanpool.org` | Bare Metal (Cloudflare Tunnel) | [Open](https://test.beanpool.org) |
| 6 | 🏠 | Test Mirror | `192.168.1.219` | `test-mirror.beanpool.org` | Bare Metal (Cloudflare Tunnel) | [Open](https://test-mirror.beanpool.org:8451) |

### Deployment Commands
The root `deploy.sh` manages upgrades across the mesh:
```bash
bash deploy.sh           # Deploy to all nodes
bash deploy.sh 1         # Mullum 1 only
bash deploy.sh 2         # Mullum 2 only
bash deploy.sh 4         # Review only
bash deploy.sh 5         # Test only
bash deploy.sh 6         # Test Mirror only
```

### SSH Access
```bash
ssh -i ~/.ssh/id_azure_lattice azureuser@20.211.27.68   # Mullum 1 (Azure)
ssh marty@192.168.1.219                                  # Mullum 2 + Review + Test + Test Mirror (Debian Lighthouse)
```

**Check Container Logs:**
```bash
ssh -i ~/.ssh/id_azure_lattice azureuser@20.211.27.68 "docker logs beanpool-beanpool-node-1 2>&1"
```
