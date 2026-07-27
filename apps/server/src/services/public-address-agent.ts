// Public-address agent — the "set it once at startup, node does the rest" mechanism.
//
// Opt-in via env (existing manually-provisioned nodes like mullum/bris leave it off):
//   PUBLIC_ADDRESS_AUTO=1            enable (or just set PUBLIC_ADDRESS_NAME)
//   PUBLIC_ADDRESS_NAME=cairns       desired label (defaults to a slug of the community name)
//   PUBLIC_ADDRESS_MODE=tunnel|direct  (default tunnel)
//   PUBLIC_ADDRESS_ORIGIN=...         what Cloudflare/cloudflared points at (default https://localhost:8443)
//   REGISTRAR_URL=https://beanpool.org
//
// On boot (primary only) it claims the name via the signed registrar client, persists the result to
// node_config, and writes the tunnel token to <data>/tunnel-token for the cloudflared sidecar to pick up.
// Re-runs every 5 min so a 'pending' (gated) name flips to live once you approve it. See docs/node-dns-registrar.md.

import fs from 'node:fs';
import path from 'node:path';
import { getNodeRole, updateNodeConfig } from '../state-engine.js';
import { getLocalConfig } from '../config/local-config.js';
import { claimAddress, addressStatus } from './registrar-client.js';

const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'tunnel-token'); // the cloudflared sidecar reads this

const slug = (s: string | null): string => {
    const cleaned = (s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    if (!cleaned) return '';                                   // empty → desiredName() warns to set a name
    return cleaned.length < 3 ? `${cleaned}-node` : cleaned;   // NAME_RE requires ≥3 chars
};

const desiredName = (): string =>
    (process.env.PUBLIC_ADDRESS_NAME || '').toLowerCase().trim() || slug(getLocalConfig().communityName);

const isEnabled = (): boolean => process.env.PUBLIC_ADDRESS_AUTO === '1' || !!process.env.PUBLIC_ADDRESS_NAME;

function writeToken(token?: string): void {
    if (!token) return;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    } catch (e: any) { console.warn('[PublicAddr] could not write tunnel token:', e.message); }
}

const persist = (pa: any) => updateNodeConfig({ publicAddress: pa } as any);

async function reconcile(): Promise<void> {
    const name = desiredName();
    if (!name) { console.warn('[PublicAddr] enabled but no name — set PUBLIC_ADDRESS_NAME or a community name.'); return; }
    const mode: 'tunnel' | 'direct' = process.env.PUBLIC_ADDRESS_MODE === 'direct' ? 'direct' : 'tunnel';
    const origin = process.env.PUBLIC_ADDRESS_ORIGIN || `https://localhost:${process.env.PORT_HTTPS || 8443}`;

    let st: any;
    try { st = await addressStatus(); } catch (e: any) { console.warn('[PublicAddr] status check failed:', e.message); return; }

    if (st.status === 'live') { persist(st); writeToken(st.tunnelToken); return; }
    if (st.status === 'pending') { console.log(`[PublicAddr] ⏳ "${st.name || name}" awaiting approval`); persist(st); return; }

    // status 'none' → claim it
    try {
        const res = await claimAddress(name, mode, origin);
        persist({ name, mode, ...res });
        if (res.status === 'live') { writeToken(res.tunnelToken); console.log(`[PublicAddr] 🟢 live at ${res.hostname}`); }
        else console.log(`[PublicAddr] ⏳ "${name}" claimed — awaiting approval`);
    } catch (e: any) { console.warn('[PublicAddr] claim failed:', e.message); }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function initPublicAddress(): void {
    if (!isEnabled()) return;
    if (getNodeRole() !== 'primary') { console.log('[PublicAddr] 🔒 skipping — backup replica.'); return; }
    console.log(`[PublicAddr] 📡 auto public-address enabled (name: ${desiredName() || '—'}, mode: ${process.env.PUBLIC_ADDRESS_MODE || 'tunnel'})`);
    setTimeout(() => reconcile().catch(() => {}), 20_000);      // after identity/p2p ready
    if (timer) clearInterval(timer);
    timer = setInterval(() => reconcile().catch(() => {}), 5 * 60_000); // pick up approvals + keep token fresh
}
