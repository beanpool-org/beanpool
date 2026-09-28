// Public-address agent — the "set it once at startup, node does the rest" mechanism.
//
// Opt-in via env (existing manually-provisioned nodes like mullum/bris leave it off):
//   PUBLIC_ADDRESS_AUTO=1            enable (or just set PUBLIC_ADDRESS_NAME)
//   PUBLIC_ADDRESS_NAME=cairns       desired label (defaults to a slug of the community name)
//   PUBLIC_ADDRESS_MODE=tunnel|direct  (default tunnel)
//   REGISTRAR_URL=https://beanpool.org
//
// Every 5 min on a main server it asks the registrar about this server's name and saves a live answer; the tunnel inside
// this server (services/tunnel-connector.ts) runs whatever token that holds. That refresh runs on any main server holding a
// tunnel address (live, or waiting for approval), however it was claimed, and never claims a name. Only with the env above does it also claim: the
// name it is given, when the registrar has none live for this key. A 'pending' (gated) name flips to live once approved.
// See docs/node-dns-registrar.md.
//
// The tunnel's destination is always this server's own loopback (LOOPBACK_ORIGIN): the tunnel runs inside the server.

import { getNodeRole, getNodeConfig } from '../state-engine.js';
import { getLocalConfig } from '../config/local-config.js';
import { claimAddress, addressStatus } from './registrar-client.js';
import { recordRegistrarAnswer } from '../engine/registrar-names.js';
import { persistAddress, LOOPBACK_ORIGIN, withKeptTunnelToken } from './tunnel-connector.js';

// Where it always lived; the take-over suites import it from here.
export { withKeptTunnelToken };

const slug = (s: string | null): string => {
    const cleaned = (s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    if (!cleaned) return '';                                   // empty → desiredName() warns to set a name
    return cleaned.length < 3 ? `${cleaned}-node` : cleaned;   // NAME_RE requires ≥3 chars
};

const desiredName = (): string =>
    (process.env.PUBLIC_ADDRESS_NAME || '').toLowerCase().trim() || slug(getLocalConfig().communityName);

const isEnabled = (): boolean => process.env.PUBLIC_ADDRESS_AUTO === '1' || !!process.env.PUBLIC_ADDRESS_NAME;

/**
 * A tunnel address saved here, live or waiting for approval: Settings' claim, this agent's, or a take-over's. A live one's
 * token can change (the registrar re-made the tunnel); a pending one goes live when the BeanPool project approves it.
 */
const holdsTunnelAddress = (): boolean => {
    const pa = (getNodeConfig() as any).publicAddress;
    return !!pa && (pa.status === 'live' || pa.status === 'pending') && pa.mode !== 'direct';
};

async function reconcile(): Promise<void> {
    if (getNodeRole() !== 'primary') return;
    const claims = isEnabled();
    if (!claims && !holdsTunnelAddress()) return;

    let st: any;
    try { st = await addressStatus(); } catch (e: any) { console.warn('[PublicAddr] status check failed:', e.message); return; }

    if (st.status === 'live') { await persistAddress(st); return; }
    if (st.status === 'pending') { console.log(`[PublicAddr] ⏳ "${st.name || desiredName()}" awaiting approval`); await persistAddress(st); return; }

    // Any other answer (none, paused, released, revoked, blocked) is written on the name it concerns; none is forgotten.
    recordRegistrarAnswer(st, 'status');
    // The refresh never claims: only a server told to by its env claims a name.
    if (!claims) return;

    const name = desiredName();
    if (!name) { console.warn('[PublicAddr] enabled but no name — set PUBLIC_ADDRESS_NAME or a community name.'); return; }
    const mode: 'tunnel' | 'direct' = process.env.PUBLIC_ADDRESS_MODE === 'direct' ? 'direct' : 'tunnel';
    const contact = process.env.PUBLIC_ADDRESS_CONTACT || undefined;
    const communityName = process.env.PUBLIC_ADDRESS_COMMUNITY_NAME || getLocalConfig().communityName || undefined;

    try {
        const res = await claimAddress(name, mode, LOOPBACK_ORIGIN, contact, communityName);
        await persistAddress({ name, mode, communityName, contact, ...res, ...(mode === 'tunnel' ? { origin: LOOPBACK_ORIGIN } : {}) }, 'claim');
        if (res.status === 'live') console.log(`[PublicAddr] 🟢 live at ${res.hostname}`);
        else console.log(`[PublicAddr] ⏳ "${name}" claimed — awaiting approval`);
    } catch (e: any) { console.warn('[PublicAddr] claim failed:', e.message); }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function initPublicAddress(): void {
    if (getNodeRole() !== 'primary') { console.log('[PublicAddr] 🔒 skipping — backup replica.'); return; }
    if (isEnabled()) console.log(`[PublicAddr] 📡 auto public-address enabled (name: ${desiredName() || '—'}, mode: ${process.env.PUBLIC_ADDRESS_MODE || 'tunnel'})`);
    setTimeout(() => reconcile().catch(() => {}), 20_000);      // after identity/p2p ready
    if (timer) clearInterval(timer);
    timer = setInterval(() => reconcile().catch(() => {}), 5 * 60_000); // pick up approvals + keep the token fresh
}
