// Public-address agent — the "set it once at startup, node does the rest" mechanism.
//
// Opt-in via env (existing manually-provisioned nodes like mullum/bris leave it off):
//   PUBLIC_ADDRESS_AUTO=1            enable (or just set PUBLIC_ADDRESS_NAME)
//   PUBLIC_ADDRESS_NAME=cairns       desired label (defaults to a slug of the community name)
//   PUBLIC_ADDRESS_MODE=tunnel|direct  (default tunnel)
//   PUBLIC_ADDRESS_IP=<IPv4>           (direct only: the address its A record points at; direct claims nothing without it)
//   REGISTRAR_URL=https://beanpool.org
//
// Every 5 min on a main server (every 15 while its name is live and nothing is pending: tickDue) it asks the registrar
// about this server's name and saves a live answer; the tunnel inside
// this server (services/tunnel-connector.ts) runs whatever token that holds. That refresh runs on any main server holding a
// BeanPool name (live, or waiting for approval), tunnel or direct, however it was claimed, and never claims a name; the
// address service's notices ride on its answer (services/registrar-notices.ts). Only with the env above does it also claim: the
// name it is given, when the registrar has none live for this key. A 'pending' (gated) name flips to live once approved;
// a pending name the registrar is still making ('provisioning': no approval is coming) is asked for again with a heal.
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
//
// An own address (`beanpool claim --ip <IPv4>` or `--address https://<domain>`, or Settings' /own) never reaches the
// registrar: storeOwnAddress keeps it, and the certificate scheduler orders its certificate at once (services/acme). It is
// no BeanPool name, so it neither ends a name request nor stops one: a name taken later is where new members are sent
// (engine/own-addresses.ts primaryAddress), and the IP or domain stays accepted (design
// scratch/global-node/DESIGN-https-anywhere-fable.md §3, D3). Nor does it take a name's place: given beside a BeanPool
// name or the server's CF_RECORD_NAME, it is kept beside it.

import { getNodeRole, getNodeConfig, isOwnPublicAddress, publicAddressGeneration, updateNodeConfig, resolvePublicNodeUrl, PUBLIC_URL_RULES } from '../state-engine.js';
import { getLocalConfig, updateLocalConfig } from '../config/local-config.js';
import { noteTurnedAway } from '../config/turned-away-names.js';
import { dataDir } from '../recover-command.js';
import { isAddressLabel, takeAddressRequestFile } from '../address-request.js';
import { claimAddress, addressStatus, healAddress, isPublicIpv4 } from './registrar-client.js';
import { cleanLabel, REGISTRAR_COMMUNITY_NAME_MAX, REGISTRAR_CONTACT_MAX } from '../config/clean-label.js';
import { recordRegistrarAnswer } from '../engine/registrar-names.js';
import { forgetOwnAddresses, ownerConfirmedAddresses, MAX_OWNER_ADDRESSES } from '../engine/own-addresses.js';
import { isIpLiteral, normalizeAddress, ownAddressProblem } from '../engine/host-kinds.js';
import { runAcmeTickSoon } from './acme/schedule.js';
import { logger } from '../logger.js';
import { persistAddressIfUnchanged, answersAboutAnotherName, healPausedAddress, noteUnansweredClaim, LOOPBACK_ORIGIN, withKeptTunnelToken, withLiveToken } from './tunnel-connector.js';
import { addressVerified } from './directory-publisher.js';

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
 * The name this agent claims (its env's, or `beanpool claim`'s request while it stands), or null when it claims none. With
 * nothing stored, an answer about it is stored even if this server turned it away before (tunnel-connector.ts
 * answersAboutAnotherName).
 */
export const nameAskedFor = (): string | null => (isEnabled() ? desiredName() || null : null);

/**
 * A BeanPool name saved here, tunnel or direct, live or waiting for approval: Settings' claim, this agent's, or a
 * take-over's. A live tunnel's token can change (the registrar re-made the tunnel); a pending name goes live when the
 * BeanPool project approves it; and the address service's notices come on the answer, whatever the kind (a direct name
 * has no tunnel to ask for it: #2151 review 4306456979). A paused or blocked answer leaves the stored name as it was (it
 * is written on the record of names), so the name is still asked about, and still hears them.
 */
const holdsRegistrarName = (): boolean => {
    const pa = (getNodeConfig() as any).publicAddress;
    return !!pa && (pa.status === 'live' || pa.status === 'pending') && !isOwnPublicAddress(pa);
};

/**
 * Any BeanPool address saved here, live or waiting for approval, tunnel or direct; an own address (an IP, a domain) is none.
 * Not one the registrar is still making (isProvisioning): until it is live, a request from `beanpool claim` for it stands,
 * and is asked again as one.
 */
const holdsAddress = (): boolean => {
    const pa = (getNodeConfig() as any).publicAddress;
    return !!pa && (pa.status === 'live' || (pa.status === 'pending' && !isProvisioning(pa))) && !isOwnPublicAddress(pa);
};

/** What storeOwnAddress did with an address, or why it did nothing. */
export type OwnAddressResult =
    | { ok: true; host: string; kind: 'ip' | 'own'; changed: boolean; communityAddress: boolean }
    | { ok: false; error: string };

/**
 * Whether an own address (`host`, of `kind`) is stored as the community's address (`replace`), or is that already
 * (`same`). Never over a BeanPool name, nor over the name the server is given (CF_RECORD_NAME, which resolvePublicNodeUrl
 * falls back to with nothing stored): taking its place would make it another community's to this node, and every
 * member's app signing for it would be refused (421; S2 review 4305409688). Never an IP over a domain.
 */
function asCommunityAddress(host: string, kind: 'ip' | 'own'): { same: boolean; replace: boolean } {
    const config = getNodeConfig();
    const pa = config.publicAddress;
    const same = isOwnPublicAddress(pa) && normalizeAddress(pa.hostname) === host;
    const named = !pa && !!resolvePublicNodeUrl(PUBLIC_URL_RULES.community, config);
    const replace = !same && ((!pa && !named) || (isOwnPublicAddress(pa) && !(kind === 'ip' && pa.mode === 'own')));
    return { same, replace };
}

/** Why storeOwnAddress takes nothing of `host`: it can't be this server's address, or the list is full. Null when it takes it. */
function ownAddressRefused(host: string): string | null {
    const problem = ownAddressProblem(host);
    if (problem) return problem;
    const owned = ownerConfirmedAddresses();
    if (!owned.includes(host) && owned.length >= MAX_OWNER_ADDRESSES) {
        return `This community already has ${MAX_OWNER_ADDRESSES} addresses of its own. Remove one it no longer uses first (Settings → Network).`;
    }
    return null;
}

/**
 * Whether storing `input` would move the community's live own address to another of its kind: a domain to another
 * domain, an IP to another IP. Settings' /own asks for the owner's fresh proof first, as the claim route does over a live
 * name (design case 18, B3; S2 review 4305409734). The first own address, the same one again, one kept beside, and a
 * first name over an IP (as a first claim) stay plain. One storeOwnAddress refuses moves nothing: no code is spent on it
 * (#2002 NB1).
 */
export function replacesLiveOwnAddress(input: string): boolean {
    const host = normalizeAddress(input);
    if (!host || ownAddressRefused(host)) return false;
    const kind: 'ip' | 'own' = isIpLiteral(host) ? 'ip' : 'own';
    const pa = getNodeConfig().publicAddress;
    return pa?.status === 'live' && isOwnPublicAddress(pa) && pa.mode === kind && asCommunityAddress(host, kind).replace;
}

/**
 * An own address given to this server: `beanpool claim --ip/--address` (the request file, below) or Settings
 * (routes/public-address.ts /own, owner-only). Kept in the owner-confirmed list (`ownerAddresses`), which only an owner
 * shortens (routes/app-addresses.ts remove), so members' apps holding it keep working whatever the community's address
 * becomes later (D3); and, while this server holds no BeanPool name and is given none (CF_RECORD_NAME), also as the
 * community's address, `publicAddress { mode: 'ip' | 'own', hostname, status: 'live', since }`: the directory's publicUrl
 * and the identity-epoch check's host. A name is never replaced by an own address, a domain never by an IP
 * (asCommunityAddress), and the registrar's record (its tunnel token) never by either. Its certificate is looked at now,
 * not at the next hourly tick, and an address given again is a retry past the back-off of an order that failed
 * (services/acme/schedule.ts runAcmeTickSoon). `by` ends the log line.
 */
export function storeOwnAddress(input: string, by: string): OwnAddressResult {
    const host = normalizeAddress(input) ?? String(input ?? '').slice(0, 80);
    const refused = ownAddressRefused(host);
    if (refused) return { ok: false, error: refused };
    const kind: 'ip' | 'own' = isIpLiteral(host) ? 'ip' : 'own';
    const owned = ownerConfirmedAddresses();
    const { same, replace } = asCommunityAddress(host, kind);
    const update: Record<string, unknown> = {};
    if (!owned.includes(host)) update.ownerAddresses = [...owned, host];
    if (replace) update.publicAddress = { mode: kind, hostname: host, status: 'live', since: new Date().toISOString() };
    const changed = Object.keys(update).length > 0;
    if (changed) {
        updateNodeConfig(update as any);
        forgetOwnAddresses();
        logger.security('AUTH', `This server's own address set by ${by}: ${host}${replace ? ' (the community\'s address)' : ''}`);
    }
    runAcmeTickSoon(host);
    return { ok: true, host, kind, changed, communityAddress: replace || same };
}

/**
 * The registrar's word that a name can't be had (apps/registrar handleClaim): invalid 400, blocked or reserved 403, taken
 * 409, in its own JSON (registrar-client marks it `registrar`). Any other answer (a 401 from a clock out of step, 408,
 * 429, a 400 or 403 page from a proxy or firewall in front of the registrar) is asked again.
 */
const REFUSED = new Set([400, 403, 409]);

/** The registrar holds the requested name for this key now (live, or waiting for approval): the request is done. */
const requestDone = (name: string): void => {
    const r = getLocalConfig().addressRequest;
    if (r && r.name === name) updateLocalConfig({ addressRequest: null });
};

/**
 * A pending answer that waits for nobody: an auto name the registrar has not finished making (the claim's answer never
 * reached this server, or Cloudflare failed). Not yet live, and no approval is coming: this server asks again. An older
 * registrar says 'awaiting-approval' for it too, as for a gated claim, and is waited on as before.
 */
const isProvisioning = (st: any): boolean => st?.status === 'pending' && st.reason === 'provisioning';

/**
 * The registrar answers this server's name `provisioning`: asked for again at once with a heal of this key's own name (a
 * claim of it would be a heal at the registrar too; a heal can never take a new name or take back a release), which
 * makes it. A live answer is stored and run, and ends the request from `beanpool claim`; anything else leaves the name
 * pending as stored, for the next check to ask again. Never throws.
 */
async function finishProvisioning(st: any): Promise<void> {
    const since = publicAddressGeneration();
    try {
        const res = await healAddress(st.name, st.mode === 'direct' ? undefined : LOOPBACK_ORIGIN);
        if (res?.status !== 'live') {
            console.log(`[PublicAddr] ⏳ "${st.name}" is not finished yet (${res?.status ?? 'no answer'}${res?.reason ? `, ${res.reason}` : ''}): asked again on the next check`);
            return;
        }
        const { reason: _reason, since: _since, ...was } = st;
        const { changed: _changed, attest: _attest, ...healed } = res;
        const answer = await withLiveToken({ mode: st.mode, ...healed }, st.name);
        const stored = persistAddressIfUnchanged({ ...was, ...answer, name: st.name, ...(st.mode === 'direct' ? {} : { origin: LOOPBACK_ORIGIN }) }, 'stored', since, nameAskedFor());
        if (!stored) return;
        await stored;
        requestDone(st.name);
        console.log(`[PublicAddr] 🟢 live at ${answer.hostname || st.hostname}`);
    } catch (e: any) {
        console.warn(`[PublicAddr] "${st.name}" is still being set up, and asking again failed: ${e.message}; asked again on the next check`);
    }
}

/**
 * Ends a request from `beanpool claim`: this server holds an address (or its owner released one) however it got it. Left
 * standing, it would claim the install's name after a later release, against the owner's latest choice. `why` ends the
 * log line: what ended it.
 */
export function dropAddressRequest(why: string): void {
    const r = getLocalConfig().addressRequest;
    if (!r) return;
    updateLocalConfig({ addressRequest: null });
    noteTurnedAway(r.name, 'install-request-ended');
    if (!r.refused) console.log(`[PublicAddr] beanpool claim's request for "${r.name}" ends: ${why}`);
}

/** One tick of the agent (every 5 min on a main server; a suite runs one at once). Never throws for a registrar failure. */
export async function reconcile(): Promise<void> {
    if (getNodeRole() !== 'primary') return;
    const claims = isEnabled();
    if (!claims && !holdsRegistrarName()) return;

    // Every answer below is stored only if nothing wrote the address while the registrar was asked (Settings' claim or
    // Take offline, a take-over): a late answer never moves the community off a name set after this tick began.
    const since = publicAddressGeneration();
    let st: any;
    const held = (getNodeConfig() as any).publicAddress;
    try { st = await addressStatus(held?.name); } catch (e: any) { console.warn('[PublicAddr] status check failed:', e.message); return; }

    // With nothing stored, the key's live or waiting name that this server turned away (one the owner took offline, the
    // install's late claim) is never stored: the answer counts as none, and the name asked for is claimed below.
    const turnedAway = (st.status === 'live' || st.status === 'pending') && !held?.name && answersAboutAnotherName(st, null, nameAskedFor());
    if (!turnedAway && (st.status === 'live' || st.status === 'pending')) {
        const provisioning = isProvisioning(st);
        if (st.status === 'pending') console.log(`[PublicAddr] ⏳ "${st.name || desiredName()}" ${provisioning ? 'is still being set up by the address service' : 'awaiting approval'}`);
        // Not stored: another write came meanwhile (it stands; the next tick asks again), or the answer names another
        // name than the one stored (an older registrar answers about the key's first name): never moved onto it.
        // A new name the registrar routes but does not vouch for yet answers `probation: true` (the directory push waits:
        // directory-publisher.ts holdBack); the first live answer without it, after one with it, lists the community.
        const wasOnProbation = held?.status === 'live' && held.probation === true && held.name === st.name;
        const stored = persistAddressIfUnchanged(st, 'stored', since, nameAskedFor());
        if (!stored) return;
        await stored;
        if (provisioning) { await finishProvisioning(st); return; }
        if (st.name) requestDone(st.name);
        if (wasOnProbation && st.status === 'live' && st.probation !== true) {
            console.log(`[PublicAddr] ✅ "${st.name}" is verified by the address service: listed in the directory now`);
            addressVerified();
        }
        return;
    }

    // A pause of this server's own name that its heal lifts (the sweep's): asked back at once, by proving its key.
    if (!turnedAway && await healPausedAddress(st, since)) return;
    // Any other answer (none, paused, released, revoked, blocked) is written on the name it concerns; none is forgotten.
    if (!turnedAway) recordRegistrarAnswer(st, 'status');
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

    // The registrar refuses a direct claim without an address (SEC-REG-01): asked for nothing rather than refused.
    const publicIp = process.env.PUBLIC_ADDRESS_IP?.trim();
    if (mode === 'direct' && !isPublicIpv4(publicIp)) {
        console.warn('[PublicAddr] PUBLIC_ADDRESS_MODE=direct needs PUBLIC_ADDRESS_IP (this server\'s public IPv4 address): nothing claimed.');
        return;
    }
    try {
        const res = await claimAddress(name, mode, LOOPBACK_ORIGIN, contact, communityName, mode === 'direct' ? publicIp : undefined);
        const stored = persistAddressIfUnchanged({ name, mode, communityName, contact, ...res, ...(mode === 'tunnel' ? { origin: LOOPBACK_ORIGIN } : {}) }, 'claim', since);
        if (!stored) { lateClaim(name, res); return; }
        await stored;
        if (res.status === 'live' || (res.status === 'pending' && !isProvisioning(res))) requestDone(name);
        if (res.status === 'live') console.log(`[PublicAddr] 🟢 live at ${res.hostname}`);
        else if (isProvisioning(res)) console.log(`[PublicAddr] ⏳ "${name}" claimed — still being set up by the address service; asked again on the next check`);
        else console.log(`[PublicAddr] ⏳ "${name}" claimed — awaiting approval`);
    } catch (e: any) {
        console.warn('[PublicAddr] claim failed:', e.message);
        await noteUnansweredClaim(name, e);
        // The registrar refused the requested name (taken, not allowed): kept with its reason, never asked for again. A
        // registrar that did not answer, or answered anything else, leaves the request standing for the next check.
        const r = getLocalConfig().addressRequest;
        const status = Number(e?.status);
        if (!envEnabled() && r && r.name === name && REFUSED.has(status) && e?.registrar === true) {
            updateLocalConfig({ addressRequest: { ...r, refused: String(e?.message || `refused (${status})`).slice(0, 300) } });
        }
    }
}

/**
 * This agent's claim answered after the address was written another way (the owner's Settings claim or Take offline, a
 * take-over): the newer write stands, and the name the claim got is kept by this key, unused. No registrar answer moves
 * the community onto it: /status is asked about the stored name, and an answer about another name is never stored
 * (tunnel-connector.ts answersAboutAnotherName). It is not released: a registrar that does not read a release's name
 * (older than #1116, or another one) releases this key's first name, which can be the owner's pick, and a release only
 * holds the name for this key for the cool-off anyway. The owner can claim it in Settings, or let it go. Said once, here.
 */
function lateClaim(name: string, res: any): void {
    const now = (getNodeConfig() as any).publicAddress;
    if (res?.status !== 'live' && res?.status !== 'pending') return;
    if (now?.name === name) return;
    noteTurnedAway(name, 'late-claim');   // Settings shows it, and offers to release it by name
    console.warn(`[PublicAddr] "${name}" was claimed for this server's key, but the address was set ${now?.name ? `to "${now.name}"` : 'offline'} `
        + 'while the claim was answered: that stands. This server\'s key holds the claimed name too, unused and never moved onto; Settings shows it, to release or claim.');
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
        const taken = takeAddressRequestFile(dataDir());
        if (taken && taken.kind !== 'name') {
            const got = storeOwnAddress(taken.host, 'beanpool claim');
            if (!got.ok) console.warn(`[PublicAddr] beanpool claim gave "${taken.host}" as this server's address; not taken: ${got.error}`);
            else console.log(`[PublicAddr] 📡 beanpool claim gave this server's address: ${got.host}${got.communityAddress ? '' : ' (kept beside the community\'s name)'}`);
        }
        const req = taken?.kind === 'name' ? taken : null;
        let fresh = false;
        if (req) {
            if (holdsAddress()) {
                console.warn(`[PublicAddr] beanpool claim asked for "${req.name}", but this server already holds an address; change it in Settings.`);
            } else {
                // A request for another name replaces a standing one: the replaced name is turned away, so its claim's late
                // answer (the registrar answers the newest live row first) never moves the community onto it.
                const replaced = getLocalConfig().addressRequest;
                if (replaced && replaced.name !== req.name) noteTurnedAway(replaced.name, 'request-replaced');
                updateLocalConfig({ addressRequest: { name: req.name, mode: 'tunnel', contact: req.contact ?? null, requestedAt: req.at, refused: null } });
                console.log(`[PublicAddr] 📡 beanpool claim asked for "${req.name}"`);
                fresh = true;
                requestTries = 0;
            }
        }
        if (holdsAddress()) {
            const held = (getNodeConfig() as any).publicAddress;
            dropAddressRequest(`this server holds "${held?.name || held?.hostname}" now (the registrar's answer to this server, or a take-over)`);
            return;
        }
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

/**
 * The agent ticks every TICK_MS (pick up an approval, a pause, a new token). A quiet server — its name live, nothing
 * pending, no request from `beanpool claim` standing — asks only every QUIET_TICK_MS: every node asking every 5 min
 * would spend the registrar's free plan (100,000 requests a day) at about 300 nodes, every 15 min at about 900
 * (scratch/global-node/DESIGN-registrar-trust-fable.md §4.6). A live name losing its tunnel is not waited on: the
 * tunnel's own Unauthorized asks the registrar at once (tunnel-connector.ts healDeadTunnel).
 */
export const TICK_MS = 5 * 60_000;
export const QUIET_TICK_MS = 15 * 60_000;
let lastAskedAt = 0;

/**
 * Is the agent's tick at `now` due to ask the registrar? Always, unless quiet (a live name, with its token if a tunnel,
 * and no request standing) and asked within QUIET_TICK_MS (half a tick's slack).
 */
export function tickDue(now = Date.now()): boolean {
    const pa = (getNodeConfig() as any).publicAddress;
    const quiet = pa?.status === 'live' && (pa.mode === 'direct' || !!pa.tunnelToken) && !getLocalConfig().addressRequest;
    return !quiet || now - lastAskedAt >= QUIET_TICK_MS - TICK_MS / 2;
}

/** The interval's tick: reconcile when due. */
export async function tick(now = Date.now()): Promise<void> {
    if (!tickDue(now)) return;
    lastAskedAt = now;
    await reconcile();
}

let timer: ReturnType<typeof setInterval> | null = null;

export function initPublicAddress(): void {
    if (getNodeRole() !== 'primary') { console.log('[PublicAddr] 🔒 skipping — backup replica.'); return; }
    if (isEnabled()) console.log(`[PublicAddr] 📡 auto public-address enabled (name: ${desiredName() || '—'}, mode: ${process.env.PUBLIC_ADDRESS_MODE || 'tunnel'})`);
    setTimeout(() => tick().catch(() => {}), 20_000);      // after identity/p2p ready
    setInterval(() => checkAddressRequest().catch(() => {}), 2_000).unref();
    if (timer) clearInterval(timer);
    timer = setInterval(() => tick().catch(() => {}), TICK_MS);
}
