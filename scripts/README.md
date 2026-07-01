# BeanPool Operational Scripts & Tools

This directory contains standalone, zero-dependency utility and diagnostic scripts for managing, verifying, and troubleshooting the BeanPool mesh network.

---

## 🛡️ 1. Auth Boundary Verification (`verify-auth-boundary.mjs`)

This script probes all signature-protected routes on a running BeanPool node to ensure that authorization cannot be spoofed or bypassed. It acts as a safety net against protect-list drift in route middleware.

### How it Works
It issues requests using three separate attack vectors against every sensitive POST route:
1. **No authentication headers** — must return HTTP `401 Unauthorized`.
2. **Signature from an incorrect key** — must return HTTP `403 Forbidden`.
3. **Valid signature but spoofed body parameters** — must return HTTP `403 Forbidden`.

### How to Run

1. Make sure you are running a local dev server:
   ```bash
   pnpm --filter @beanpool/server dev
   ```
2. Execute the verification script in another terminal window, targeting your server:
   ```bash
   # Run against a local development node (default port 8443)
   node scripts/verify-auth-boundary.mjs https://localhost:8443
   
   # Run against a specific live or staging node
   node scripts/verify-auth-boundary.mjs https://your-live-node:8443
   ```
3. **Exit Codes**: Returns `0` if all boundaries hold securely, or `1` if any vulnerability is detected.

---

## 🌱 2. Network Diagnostic Suite (`bp-diagnose.mjs`)

A read-only command-line utility and local Web Dashboard for auditing network reachability, checking mirror sync health, identifying profile drifts, and inspecting marketplace sanity.

### 🖥️ CLI Commands & Examples

All analytical tools can be run directly inside your terminal.

#### A. Network Reachability Sweep
Sweeps all default nodes (or overrides via `--nodes`) to review status, version, total database counts, and SSL certificate expiries.
```bash
node scripts/bp-diagnose.mjs network --all-nodes
```

#### B. Identity Inspector
Cross-reference a member callsign or public key across all default nodes.
```bash
# Search by Callsign (partial, case-insensitive)
node scripts/bp-diagnose.mjs identity --all-nodes --callsign "Martino"

# Probe by Public Key (verifies balance, ratings, and friend count)
node scripts/bp-diagnose.mjs identity --all-nodes --pubkey 5dd9291c0b722b9f4c093f08bf35d79676cc835a6e171cc5529c04538e720440

# Decrypt a mobile transfer code and probe across nodes
node scripts/bp-diagnose.mjs identity --all-nodes --pin 1234 --transfer "beanpool://import?d=..."
```

#### C. Mirror Consistency Check
Performs O(n) set symmetric comparisons between two server databases to locate sync drifts, CallSign mismatches, or missing post listings.
```bash
node scripts/bp-diagnose.mjs mirror https://test.beanpool.org https://review.beanpool.org
```

#### D. Marketplace Health Audit
Scans a single node for orphaned postings, zombie listings, zero-credit items, or stale posts.
```bash
node scripts/bp-diagnose.mjs marketplace --node https://test.beanpool.org
```

---

### 🎨 3. Launching the Visual Web Dashboard

To run a visual SPA dashboard instead of using the terminal CLI, launch the built-in HTTP server:

```bash
node scripts/bp-diagnose.mjs dashboard --port 3000
```

### Visual Features & Proxy
* Open **`http://localhost:3000`** in your browser to view the premium glassmorphism dark-theme panel.
* **CORS Proxying**: The local HTTP server acts as a backend proxy for the browser, safely relaying queries to the mesh and bypassing browser CORS blocks and self-signed certificate rejections.

---

## 🚀 4. Version Bumper Utility (`bump-version.mjs`)

A utility script to automatically increment versions across all workspace `package.json` files, commit the changes, and create the matching Git release tag in a single step.

### How to Run

1. Execute the version bump specifying the increment type (`patch`, `minor`, `major`) or an explicit version number:
   ```bash
   # Dry-run preview of the next patch bump
   node scripts/bump-version.mjs patch --dry-run
   
   # Apply patch bump, commit changes, and create git tag locally
   node scripts/bump-version.mjs patch
   
   # Bump to an explicit minor version without creating a tag
   node scripts/bump-version.mjs 1.1.0 --no-tag
   ```
2. **Deploy to production**: Once successfully bumped, push the code and tags to trigger the automated GitHub Actions build:
   ```bash
   git push && git push --tags
   ```

