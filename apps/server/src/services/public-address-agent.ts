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
// A name the registrar's sweep paused (another node's key, or something that is no BeanPool node, answered at it) is asked
// back with a heal, never a claim, however it was claimed (services/tunnel-connector.ts healPausedAddress).
// See docs/node-dns-registrar.md.
//
// The tunnel's destination is always this server's own loopback (LOOPBACK_ORIGIN): the tunnel runs inside the server.
//
// A name asked for at install (`beanpool claim --name`, address-request.ts) counts as PUBLIC_ADDRESS_NAME (the env wins
// when both are set). The node takes the command's file within ~2 s and asks for the name at once; while the request
// stands and no address is held it asks again after 10 s, 30 s and 2 min (the command waits 3), then on the 5-min tick. Taken only while this server holds no address:
// changing a name it holds stays in Settings, owner-only. The request ends once this server holds any address, however it
// got it (Settings, this agent, a take-over), and when Settings takes the address offline: it never claims later.

import { getNodeRole, getNodeConfig, publicAddressGeneration } from '../state-engine.js';
import { getLocalConfig, updateLocalConfig } from '../config/local-config.js';
import { dataDir } from '../recover-command.js';
import { isAddressLabel, takeAddressRequestFile } from '../address-request.js';
import { claimAddress, addressStatus } from './registrar-client.js';
import { cleanLabel, REGISTRAR_COMMUNITY_NAME_MAX, REGISTRAR_CONTACT_MAX } from '../config/clean-label.js';
import { recordRegistrarAnswer } from '../engine/registrar-names.js';
import { persistAddressIfUnchanged, healPausedAddress, LOOPBACK_ORIGIN, withKeptTunnelToken } from './tunnel-connector.js';

// Where it always lived; the take-over suites import it from here.
export { withKeptTunnelToken };

const slug = (s: string | null): string => {
    const cleaned = (s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    if (!cleaned) return '';                                   // empty → desiredName() warns to set a name
    return cleaned.length < 3 ? `${cleaned}-node` : cleaned;   // NAME_RE requires ≥3 chars
};

/** The name `beanpool claim` asked for, while it stands (not refused by the registrar). */
const requestedName = (): string | null => {
    const r = getLocalConfig().addressRequest;
    return r && !r.refused && isAddressLabel(r.name) ? r.name : null;
};

const desiredName = (): string =>
    (process.env.PUBLIC_ADDRESS_NAME || '').toLowerCase().trim() || requestedName() || slug(getLocalConfig().communityName);

const envEnabled = (): boolean => process.env.PUBLIC_ADDRESS_AUTO === '1' || !!process.env.PUBLIC_ADDRESS_NAME;
const isEnabled = (): boolean => envEnabled() || !!requestedName();

/**
 * A tunnel address saved here, live or waiting for approval: Settings' claim, this agent's, or a take-over's. A live one's
 * token can change (the registrar re-made the tunnel); a pending one goes live when the BeanPool project approves it.
 */
const holdsTunnelAddress = (): boolean => {
    const pa = (getNodeConfig() as any).publicAddress;
    return !!pa && (pa.status === 'live' || pa.status === 'pending') && pa.mode !== 'direct';
};

/** Any address saved here, live or waiting, tunnel or direct. */
const holdsAddress = (): boolean => {
    const pa = (getNodeConfig() as any).publicAddress;
    return !!pa && (pa.status === 'live' || pa.status === 'pending');
};

/**
 * The registrar's word that a name can't be had (apps/registrar handleClaim): invalid 400, blocked or reserved 403, taken
 * 409. Any other answer (a 401 from a clock out of step, 408, 429, a page in front of the registrar) is asked again.
 */
const REFUSED = new Set([400, 403, 409]);

/** The registrar holds the requested name for this key now (live or waiting): the request is done. */
const requestDone = (name: string): void => {
    const r = getLocalConfig().addressRequest;
    if (r && r.name === name) updateLocalConfig({ addressRequest: null });
};

/**
 * Ends a request from `beanpool claim`: this server holds an address (or its owner released one) however it got it. Left
 * standing, it would claim the install's name after a later release, against the owner's latest choice.
 */
export function dropAddressRequest(): void {
    const r = getLocalConfig().addressRequest;
    if (!r) return;
    updateLocalConfig({ addressRequest: null });
    if (!r.refused) console.log(`[PublicAddr] beanpool claim's request for "${r.name}" ends: the address is set in Settings now`);
}

/** One tick of the agent (every 5 min on a main server; a suite runs one at once). Never throws for a registrar failure. */
export async function reconcile(): Promise<void> {
    if (getNodeRole() !== 'primary') return;
    const claims = isEnabled();
    if (!claims && !holdsTunnelAddress()) return;

    // Every answer below is stored only if nothing wrote the address while the registrar was asked (Settings' claim or
    // Take offline, a take-over): a late answer never moves the community off a name set after this tick began.
    const since = publicAddressGeneration();
    let st: any;
    try { st = await addressStatus(); } catch (e: any) { console.warn('[PublicAddr] status check failed:', e.message); return; }

    if (st.status === 'live' || st.status === 'pending') {
        if (st.status === 'pending') console.log(`[PublicAddr] ⏳ "${st.name || desiredName()}" awaiting approval`);
        const stored = persistAddressIfUnchanged(st, 'stored', since);
        if (!stored) return;    // the newer write stands; the next tick asks again
        await stored;
        if (st.name) requestDone(st.name);
        return;
    }

    // A pause of this server's own name that its heal lifts (the sweep's): asked back at once, by proving its key.
    if (await healPausedAddress(st, since)) return;
    // Any other answer (none, paused, released, revoked, blocked) is written on the name it concerns; none is forgotten.
    recordRegistrarAnswer(st, 'status');
    // The refresh never claims: only a server told to by its env claims a name.
    if (!claims) return;

    const name = desiredName();
    if (!name) { console.warn('[PublicAddr] enabled but no name — set PUBLIC_ADDRESS_NAME or a community name.'); return; }
    const mode: 'tunnel' | 'direct' = process.env.PUBLIC_ADDRESS_MODE === 'direct' ? 'direct' : 'tunnel';
    // The env's contact, or the one `beanpool claim --contact` gave with the name being claimed.
    const req = getLocalConfig().addressRequest;
    const contact = cleanLabel(process.env.PUBLIC_ADDRESS_CONTACT, REGISTRAR_CONTACT_MAX)
        || (req && req.name === name ? cleanLabel(req.contact, REGISTRAR_CONTACT_MAX) : undefined);
    const communityName = cleanLabel(process.env.PUBLIC_ADDRESS_COMMUNITY_NAME, REGISTRAR_COMMUNITY_NAME_MAX)
        || cleanLabel(getLocalConfig().communityName, REGISTRAR_COMMUNITY_NAME_MAX);

    try {
        const res = await claimAddress(name, mode, LOOPBACK_ORIGIN, contact, communityName);
        const stored = persistAddressIfUnchanged({ name, mode, communityName, contact, ...res, ...(mode === 'tunnel' ? { origin: LOOPBACK_ORIGIN } : {}) }, 'claim', since);
        if (!stored) { lateClaim(name, res); return; }
        await stored;
        if (res.status === 'live' || res.status === 'pending') requestDone(name);
        if (res.status === 'live') console.log(`[PublicAddr] 🟢 live at ${res.hostname}`);
        else console.log(`[PublicAddr] ⏳ "${name}" claimed — awaiting approval`);
    } catch (e: any) {
        console.warn('[PublicAddr] claim failed:', e.message);
        // The registrar refused the requested name (taken, not allowed): kept with its reason, never asked for again. A
        // registrar that did not answer, or answered anything else, leaves the request standing for the next check.
        const r = getLocalConfig().addressRequest;
        const status = Number(e?.status);
        if (!envEnabled() && r && r.name === name && REFUSED.has(status)) {
            updateLocalConfig({ addressRequest: { ...r, refused: String(e?.message || `refused (${status})`).slice(0, 300) } });
        }
    }
}

/**
 * This agent's claim answered after the address was written another way (the owner's Settings claim or Take offline, a
 * take-over): the newer write stands, and the name the claim got is kept by this key, unused. It is not released: a
 * release names the name, but a registrar that does not read the name (older than #1116, or another one) releases this
 * key's own allocation, which can be the owner's pick, and a release only holds the name for this key for the cool-off
 * anyway. The owner can claim it in Settings, or let it go. Said once, here.
 */
function lateClaim(name: string, res: any): void {
    const now = (getNodeConfig() as any).publicAddress;
    if (res?.status !== 'live' && res?.status !== 'pending') return;
    if (now?.name === name) return;
    console.warn(`[PublicAddr] "${name}" was claimed for this server's key, but the address was set ${now?.name ? `to "${now.name}"` : 'offline'} `
        + 'while the claim was answered: that stands. The claimed name is kept unused, not released; claim it in Settings to use it.');
}

let checking = false;
/** After a check that left the request standing: the next one in 10 s, 30 s, 2 min; after that only the 5-min tick. */
const REQUEST_BACKOFF_MS = [10_000, 30_000, 120_000];
let requestTries = 0;
let nextRequestCheck = 0;

/**
 * Every 2 s on a main server: take a file `beanpool claim` left, and while a request stands and no address is held, ask
 * the registrar at once, then backing off (REQUEST_BACKOFF_MS): a registrar that is down is not asked every 10 s by
 * every node until it is back. A file is dropped while an address is held (Settings changes a held name, owner-only).
 */
export async function checkAddressRequest(now = Date.now()): Promise<void> {
    if (checking || getNodeRole() !== 'primary') return;
    checking = true;
    try {
        const req = takeAddressRequestFile(dataDir());
        let fresh = false;
        if (req) {
            if (holdsAddress()) {
                console.warn(`[PublicAddr] beanpool claim asked for "${req.name}", but this server already holds an address; change it in Settings.`);
            } else {
                updateLocalConfig({ addressRequest: { name: req.name, mode: 'tunnel', contact: req.contact ?? null, requestedAt: req.at, refused: null } });
                console.log(`[PublicAddr] 📡 beanpool claim asked for "${req.name}"`);
                fresh = true;
                requestTries = 0;
            }
        }
        if (holdsAddress()) { dropAddressRequest(); return; }
        if (!requestedName()) return;
        if (!fresh && now < nextRequestCheck) return;
        await reconcile();
        if (requestedName() && !holdsAddress()) {
            nextRequestCheck = requestTries < REQUEST_BACKOFF_MS.length ? now + REQUEST_BACKOFF_MS[requestTries] : Infinity;
            requestTries++;
        }
    } finally {
        checking = false;
    }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function initPublicAddress(): void {
    if (getNodeRole() !== 'primary') { console.log('[PublicAddr] 🔒 skipping — backup replica.'); return; }
    if (isEnabled()) console.log(`[PublicAddr] 📡 auto public-address enabled (name: ${desiredName() || '—'}, mode: ${process.env.PUBLIC_ADDRESS_MODE || 'tunnel'})`);
    setTimeout(() => reconcile().catch(() => {}), 20_000);      // after identity/p2p ready
    setInterval(() => checkAddressRequest().catch(() => {}), 2_000).unref();
    if (timer) clearInterval(timer);
    timer = setInterval(() => reconcile().catch(() => {}), 5 * 60_000); // pick up approvals + keep the token fresh
}
