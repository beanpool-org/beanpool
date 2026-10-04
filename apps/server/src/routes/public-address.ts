/**
 * Public-address routes — the node half of the registrar (docs/node-dns-registrar.md).
 *
 *   - GET /api/attest  (PUBLIC): proves this node still holds its registered identity. The registrar's
 *     cron calls it with a nonce; we return a reply signed by the node's Ed25519 key. Public by design.
 *   - Admin routes drive the node's public address for the manager "Public Address" tab (claim/status/offline, and
 *     rotate: a new tunnel key).
 */

import Router from '@koa/router';
import http from 'node:http';
import { buildAttestation, claimAddress, updateAddressMetadata, addressStatus, releaseAddress, rotateAddress, nodePubkeyHex, askNameHolder } from '../services/registrar-client.js';
import { syncTunnel, restartTunnel, persistAddress, persistAddressIfUnchanged, answersAboutAnotherName, noteUnansweredClaim, getTunnelStatus, dockerSocketMounted, LOOPBACK_ORIGIN, type TunnelStatus } from '../services/tunnel-connector.js';
import { getNodeConfig, getNodeRole, updateNodeConfig, publicAddressGeneration } from '../state-engine.js';
import { recordRegistrarAnswer, registrarNames, REGISTRAR_ZONE } from '../engine/registrar-names.js';
import { dropAddressRequest, nameAskedFor } from '../services/public-address-agent.js';
import { noteTurnedAway, settleUnansweredClaims, turnedAwayList } from '../config/turned-away-names.js';
import { isAddressLabel } from '../address-request.js';
import { requireAdminRole } from '../admin-auth.js';
import type { RouteDeps } from './types.js';

export interface ProbeLogEntry {
    timestamp: string;
    step: string;
    message: string;
    type: 'info' | 'success' | 'warning' | 'error';
}

const probeLogs: ProbeLogEntry[] = [];

export function addProbeLog(step: string, message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') {
    const timestamp = new Date().toISOString().slice(11, 19);
    probeLogs.push({ timestamp, step, message, type });
    if (probeLogs.length > 60) probeLogs.shift();
}

async function verifyEdgeStatus(hostname: string, target: 'live' | 'offline', maxAttempts = 12, intervalMs = 5000): Promise<boolean> {
    const cfEdgeIp = '104.21.93.179';
    const totalSecs = Math.round(maxAttempts * intervalMs / 1000);
    addProbeLog('4/4', `📡 Probing ${hostname} every ${intervalMs / 1000}s (up to ${totalSecs}s)...`, 'info');
    for (let i = 0; i < maxAttempts; i++) {
        try {
            const status = await new Promise<number>((resolve) => {
                const req = http.request({
                    hostname: cfEdgeIp,
                    port: 80,
                    path: '/',
                    method: 'GET',
                    headers: { Host: hostname }
                }, (res) => {
                    resolve(res.statusCode || 0);
                });
                req.on('error', () => resolve(0));
                req.setTimeout(4000, () => { req.destroy(); resolve(0); });
                req.end();
            });

            const isOriginSuccess = (status === 200 || status === 301 || status === 302 || status === 304 || status === 307 || status === 308);
            const elapsed = (i + 1) * intervalMs / 1000;

            if (target === 'live') {
                if (isOriginSuccess) {
                    addProbeLog('4/4', `🟢 Probe ${i + 1}/${maxAttempts}: HTTP ${status} — Confirmed LIVE!`, 'success');
                    return true;
                }
                addProbeLog('4/4', `Probe ${i + 1}/${maxAttempts} (${elapsed}s): HTTP ${status === 530 ? '530 — waiting for tunnel…' : status}`, 'info');
            } else if (target === 'offline') {
                if (status === 530 || status === 502 || status === 520 || status === 522 || status === 523 || status === 404 || status === 0) {
                    addProbeLog('4/4', `🔴 Probe ${i + 1}/${maxAttempts}: HTTP ${status} — Confirmed OFFLINE!`, 'warning');
                    return true;
                }
                addProbeLog('4/4', `Probe ${i + 1}/${maxAttempts}: HTTP ${status} (waiting for teardown…)`, 'info');
            }
        } catch (err: any) {
            addProbeLog('4/4', `Probe ${i + 1}/${maxAttempts}: error (${err.message})`, 'warning');
            if (target === 'offline') return true;
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    addProbeLog('4/4', `⏳ Timed out after ${totalSecs}s. Click ⚡ Restart tunnel to retry.`, 'warning');
    return false;
}

/** The tunnel inside this server, as one line for the probe log. */
function describeTunnel(t: TunnelStatus): string {
    if (t.state === 'connected') return `connected to Cloudflare (${t.connections})`;
    if (t.state === 'starting') return 'starting';
    if (t.state === 'off') return 'not running';
    return `${t.state}${t.reason ? `: ${t.reason}` : ''}`;
}

/** What every status answer carries about this server: its tunnel, and whether Docker's socket is still mounted. */
const serverSide = () => ({ tunnel: getTunnelStatus(), dockerSocket: dockerSocketMounted() });

/**
 * The fields of a registrar answer, or of the saved address, that Settings shows. An answer is built from these by name,
 * never by spreading what the registrar sent: whatever else it carries stays on the server.
 */
const ADDRESS_FIELDS = [
    'status', 'name', 'hostname', 'mode', 'reason', 'since', 'warning', 'held_until', 'heldUntil',
    'communityName', 'community_name', 'contact',
] as const;

/**
 * The tunnel token is an owner's: an owner signed in with their key, or the admin password, which counts as one. Whoever
 * holds it can run a second connector for this node's name and be handed a share of its visitors, owners' Manage
 * sign-ins among them. An admin is told only that there is one (`tunnelTokenOwnerOnly`).
 */
function addressFields(ctx: any, answer: any): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!answer || typeof answer !== 'object') return out;
    for (const k of ADDRESS_FIELDS) if (answer[k] !== undefined) out[k] = answer[k];
    if (typeof answer.tunnelToken === 'string' && answer.tunnelToken) {
        if (ctx.state?.adminRole === 'owner') out.tunnelToken = answer.tunnelToken;
        else out.tunnelTokenOwnerOnly = true;
    }
    return out;
}

/** Claiming, releasing or renaming the community's address is an owner's (operators/setup/signing-in.md). */
const ADDRESS_OWNER_ONLY = 'Only an owner of this node can change its public address';

/** The states in which the registrar routes a name to (or keeps it for) the key that holds it. */
const HELD_STATES = new Set(['live', 'pending', 'paused']);
/** The most names Settings asks the registrar about at once: the turned-away list's size. */
const EXTRA_NAMES_MAX = 8;
/** How long Settings waits for one /holder answer, and how long the answers it got are reused (#1583 review r4176052022). */
const HOLDER_WAIT_MS = 3_000;
const HOLDER_CACHE_MS = 60_000;

/** A name as the registrar keys it: trimmed, lower case, no trailing dot (#1583 review r4176051940). */
const foldName = (n: unknown): string => String(n ?? '').trim().replace(/\.$/, '').toLowerCase();

/**
 * Why `name` (folded) is not one to release by name, or null: it is the stored address, the name the record of names calls
 * current (the status read stores it, even with the stored address cleared: #1583 review r4176138202), the name the
 * public-address agent asks for, or the owner's pending Settings pick (a claim that got no answer here, still their latest
 * choice, which the connector or Settings' status read may store at any moment: #1583 review r4176051848).
 */
function notReleasable(name: string): string | null {
    const host = `${name}.${REGISTRAR_ZONE}`;
    if (foldName((getNodeConfig() as any).publicAddress?.name) === name || foldName(nameAskedFor()) === name
        || registrarNames().some((e) => e.role === 'current' && e.address === host)) {
        return `${host} is this community's address; Take offline releases it.`;
    }
    if (turnedAwayList().some((e) => e.why === 'unanswered' && foldName(e.name) === name)) {
        return `${host} is the name you chose last; another pick or Take offline replaces it.`;
    }
    return null;
}

/**
 * Names this server's key may hold besides its stored address (#1576 review r4175512149): the install's late claim and
 * every name on the turned-away list or kept as former in the record of names, never the stored name, the one the
 * public-address agent asks for, nor the owner's pending pick. Newest first.
 */
function extraNameCandidates(): string[] {
    const suffix = `.${REGISTRAR_ZONE}`;
    const former = registrarNames().filter((e) => e.role !== 'current' && e.address.endsWith(suffix)).map((e) => e.address.slice(0, -suffix.length));
    const names = [...turnedAwayList().map((e) => e.name).reverse(), ...former].map(foldName);
    return [...new Set(names)].filter((n) => isAddressLabel(n) && !notReleasable(n)).slice(0, EXTRA_NAMES_MAX);
}

/** Names being released right now, and names a Settings claim is asking for: neither starts while the other runs. */
const releasesInFlight = new Set<string>();
const claimsInFlight = new Set<string>();

/**
 * Who holds `name`, as Settings needs it: `held` when the registrar says this key holds it in a state that keeps it
 * (live, waiting, paused), `releasable` when that answer came from /holder, which a registrar has only since it reads a
 * release's name (#1271 after #1116). An older registrar (no /holder) can't say: then nothing is held as far as this
 * knows, and nothing is released by name, as an older release would let go of the key's first name, the stored one.
 * An answer about another name says nothing about this one (#1583 review r4176051981).
 */
async function heldByThisKey(name: string): Promise<{ held: boolean; state: string | null; known: boolean }> {
    try {
        const r = await askNameHolder(name);
        if (!r.ok || !r.json || foldName(r.data?.name) !== name) return { held: false, state: null, known: false };
        if (r.data?.held !== 'you') return { held: false, state: null, known: true };
        const state = typeof r.data?.state === 'string' ? r.data.state : null;
        return { held: !!state && HELD_STATES.has(state), state, known: true };
    } catch { return { held: false, state: null, known: false }; }
}

/** Settings' /holder answers, reused for HOLDER_CACHE_MS; any address write here clears them. Never used to release. */
const holderCache = new Map<string, { at: number; h: { held: boolean; state: string | null; known: boolean } }>();
export function clearHolderCache(): void { holderCache.clear(); }

/** heldByThisKey for Settings' list: from the cache, or asked with a short wait (no answer in time: can't say, for a minute too). */
async function heldForSettings(name: string): Promise<{ held: boolean; state: string | null; known: boolean }> {
    const hit = holderCache.get(name);
    if (hit && Date.now() - hit.at < HOLDER_CACHE_MS) return hit.h;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), HOLDER_WAIT_MS); });
    const h = await Promise.race([heldByThisKey(name), late]);
    clearTimeout(timer);
    const answer = h ?? { held: false, state: null, known: false };
    holderCache.set(name, { at: Date.now(), h: answer });
    return answer;
}

/**
 * The owner's address is claimed again at once: a release by name was answered about it (a registrar that ignored the
 * name). Within the registrar's hold the name comes back to this key.
 */
async function reclaimStored(stored: any): Promise<boolean> {
    try {
        const since = publicAddressGeneration();
        const answer = await claimAddress(stored.name, stored.mode === 'direct' ? 'direct' : 'tunnel', LOOPBACK_ORIGIN, stored.contact, stored.communityName);
        return !!(await persistAddressIfUnchanged(answer, 'claim', since));
    } catch (e: any) {
        console.error(`[PublicAddr] could not claim "${stored?.name}" back: ${e?.message || e}`);
        return false;
    }
}

export function createPublicAddressRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;

    /**
     * Apple's domain-verification file, served whenever its contents are configured.
     *
     * Here rather than with the Sign in with Apple code that needs it, because Apple re-verifies
     * domains on its own schedule and this has to keep answering long after any particular feature
     * — or diagnostic — is gone. A route that lived beside a temporary probe would be deleted with
     * it, and verification would lapse silently months later.
     *
     * Public by design: the file is a verification token Apple fetches anonymously, and it grants
     * nothing. Same reasoning as `/api/attest` below.
     */
    router.get('/.well-known/apple-developer-domain-association.txt', async (ctx) => {
        const association = process.env.APPLE_DOMAIN_ASSOCIATION;
        if (!association) {
            ctx.status = 404;
            ctx.body = 'not configured';
            return;
        }
        ctx.type = 'text/plain; charset=utf-8';
        ctx.body = association;
    });

    router.get('/api/attest', async (ctx) => {
        const nonce = String(ctx.query.nonce || '');
        // The registrar's nonce is a crypto.randomUUID() — hex and hyphens. Anything outside that
        // charset is an attempt to smuggle structure (a newline turns the signed `${nonce}\n${ts}`
        // into a multi-line message that can mimic another signing context). Domain separation in
        // buildAttestation is the structural backstop; this rejects the payload outright as well.
        if (!nonce) {
            ctx.status = 400; ctx.body = { error: 'nonce required' }; return;
        }
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(nonce)) {
            ctx.status = 400; ctx.body = { error: 'invalid nonce format' }; return;
        }
        try { ctx.body = await buildAttestation(nonce); }
        catch (e: any) { ctx.status = 503; ctx.body = { error: e.message || 'identity not ready' }; }
    });

    router.get('/api/local/admin/public-address/logs', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        ctx.body = { success: true, logs: probeLogs };
    });

    router.post('/api/local/admin/public-address/claim', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        if (!requireAdminRole(ctx, ['owner'], ADDRESS_OWNER_ONLY)) return;
        const b = (ctx.request as any).body || (ctx as any).requestBody || {};
        const name = String(b.name || '').toLowerCase().trim();
        const mode: 'tunnel' | 'direct' = b.mode === 'direct' ? 'direct' : 'tunnel';
        if (!name) { ctx.status = 400; ctx.body = { error: 'name required' }; return; }
        if (releasesInFlight.has(name)) { ctx.status = 409; ctx.body = { error: `${name}.${REGISTRAR_ZONE} is being released right now; try again in a moment.` }; return; }
        claimsInFlight.add(name);
        clearHolderCache();
        try {
            probeLogs.length = 0;
            addProbeLog('1/4', `⏳ Requesting tunnel allocation for "${name}.beanpool.org"...`, 'info');
            // The tunnel runs inside this server, so it always leads to this server's own loopback.
            const communityName = b.communityName || b.community_name;
            const result = await claimAddress(name, mode, LOOPBACK_ORIGIN, b.contact, communityName);
            addProbeLog('1/4', `✅ Registrar granted claim for ${result.hostname}`, 'success');

            // Recorded before the stored address changes: a name held until now is kept, as former.
            recordRegistrarAnswer({ name, hostname: result.hostname, status: result.status, reason: result.reason }, 'claim');
            updateNodeConfig({ publicAddress: {
                name, mode, hostname: result.hostname, status: result.status, tunnelToken: result.tunnelToken, communityName, contact: b.contact,
                ...(mode === 'tunnel' ? { origin: LOOPBACK_ORIGIN } : {}),
            } } as any);
            dropAddressRequest(`the owner claimed "${name}" in Settings`);   // the owner's choice ends what `beanpool claim` asked for at install
            settleUnansweredClaims(name);   // and replaces any claim of another name that got no answer here
            if (result.tunnelToken) addProbeLog('2/4', `⚡ Starting the tunnel inside this server...`, 'info');
            const tunnel = await syncTunnel();
            if (result.tunnelToken) {
                const ok = tunnel.state === 'starting' || tunnel.state === 'connected';
                addProbeLog('3/4', `${ok ? '✅' : '❌'} Tunnel ${describeTunnel(tunnel)}`, ok ? 'success' : 'error');
                // Run edge status probe asynchronously in background to prevent HTTP request timeouts
                verifyEdgeStatus(result.hostname, 'live').catch(err => {
                    console.warn('[PublicAddr] Edge status probe error:', err?.message || err);
                });
            }
            ctx.body = { success: true, ...addressFields(ctx, result), ...serverSide() };
        } catch (e: any) {
            addProbeLog('1/4', `❌ Claim failed: ${e.message}`, 'error');
            // No answer in time, but the registrar can still complete it: the owner's latest choice until another claim or
            // Take offline replaces it, then turned away (config/turned-away-names.ts).
            if (/timed out/.test(String(e?.message || ''))) noteTurnedAway(name, 'unanswered');
            void noteUnansweredClaim(name, e);
            ctx.status = 400;
            ctx.body = { error: e.message };
        } finally {
            claimsInFlight.delete(name);
        }
    });

    // The names this key holds besides the stored address (the install's late claim, a name moved off or taken offline
    // that the registrar still lists for this key): Settings offers to release each by name. Owner-only, as releasing is.
    router.get('/api/local/admin/public-address/extra-names', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        if (!requireAdminRole(ctx, ['owner'], ADDRESS_OWNER_ONLY)) return;
        if (getNodeRole() !== 'primary') { ctx.body = { success: true, names: [] }; return; }
        const names: { name: string; hostname: string; state: string | null; releasable: boolean; fromInstall: boolean }[] = [];
        const list = turnedAwayList();
        const late = new Set(list.filter((e) => e.why === 'late-claim').map((e) => foldName(e.name)));
        const install = new Set(list.filter((e) => e.why === 'late-claim' || e.why === 'install-request-ended' || e.why === 'request-replaced').map((e) => foldName(e.name)));
        const candidates = extraNameCandidates();
        // Asked all at once, each with a short wait, and reused for a minute: Settings never waits on the registrar.
        const answers = await Promise.all(candidates.map((name) => heldForSettings(name)));
        for (const [i, name] of candidates.entries()) {
            const h = answers[i];
            const fromInstall = install.has(name);
            if (h.held) names.push({ name, hostname: `${name}.${REGISTRAR_ZONE}`, state: h.state, releasable: true, fromInstall });
            // An older registrar can't say who holds it: the agent's late claim was given to this key, so it is shown,
            // with nothing to release it by.
            else if (!h.known && late.has(name)) names.push({ name, hostname: `${name}.${REGISTRAR_ZONE}`, state: null, releasable: false, fromInstall });
        }
        ctx.body = { success: true, names };
    });

    // Release one of those names, by name. Never the stored address: refused here, and asked of a registrar only when it
    // says (/holder) that this key holds the name, as only a registrar that reads a release's name answers /holder.
    router.post('/api/local/admin/public-address/release-name', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        if (!requireAdminRole(ctx, ['owner'], ADDRESS_OWNER_ONLY)) return;
        const b = (ctx.request as any).body || (ctx as any).requestBody || {};
        const name = String(b.name || '').toLowerCase().trim();
        if (!isAddressLabel(name)) { ctx.status = 400; ctx.body = { error: 'name required' }; return; }
        if (getNodeRole() !== 'primary') { ctx.status = 409; ctx.body = { error: 'Only the main server releases names.' }; return; }
        const host = `${name}.${REGISTRAR_ZONE}`;
        const busy = () => releasesInFlight.has(name) || claimsInFlight.has(name);
        // Read before /holder, and read again after it (#1583 review r4176051800): a Settings claim, Settings' status read
        // or the connector may store the name meanwhile.
        const since = publicAddressGeneration();
        const before = notReleasable(name);
        if (before || busy()) { ctx.status = 409; ctx.body = { error: before || `${host} is being changed right now; nothing was released.` }; return; }
        const h = await heldByThisKey(name);
        if (!h.held) {
            ctx.status = 409;
            ctx.body = { error: `The address service does not say this community holds ${host}; nothing was released.` };
            return;
        }
        // From this check to the send, no await: nothing can store the name in between.
        const after = notReleasable(name);
        if (after || busy() || publicAddressGeneration() !== since) {
            ctx.status = 409;
            ctx.body = { error: after || `This community's address changed meanwhile; nothing was released. Open Settings again.` };
            return;
        }
        // Turned away before the release goes out: neither the connector nor Settings' status read stores it while it is
        // in flight, and a Settings claim of it waits (claimsInFlight/releasesInFlight).
        noteTurnedAway(name, 'taken-offline');
        releasesInFlight.add(name);
        clearHolderCache();
        const sending = releaseAddress(name);
        try {
            const result = await sending;
            const answered = foldName(result?.name);
            if (result?.status !== 'released' || answered !== name) {
                // Not this name released: a registrar that ignored the name, or one that says this key has no such row.
                const stored = (getNodeConfig() as any).publicAddress;
                const said = answered ? `${answered}.${REGISTRAR_ZONE} ${result?.status ?? 'answered'}` : `"${result?.status ?? 'no status'}"`;
                if (answered && stored?.name && foldName(stored.name) === answered) {
                    console.error(`[PublicAddr] SECURITY asked to release "${name}", the address service released this community's address "${answered}"; claiming it back`);
                    const back = await reclaimStored(stored);
                    ctx.status = 502;
                    ctx.body = { error: `Not released: the address service answered about ${answered}.${REGISTRAR_ZONE}, this community's address, instead. ${back ? 'It was claimed back.' : 'Claiming it back failed: claim it again in Settings.'}` };
                    return;
                }
                console.warn(`[PublicAddr] asked to release "${name}", the address service answered ${said}`);
                ctx.status = 502;
                ctx.body = { error: `Not released: the address service did not release ${host} (it answered ${said}).` };
                return;
            }
            console.log(`[PublicAddr] the owner released "${name}", a name this community held unused (${result.status})`);
            ctx.body = { success: true, name, status: result.status, addressUnchanged: publicAddressGeneration() === since };
        } catch (e: any) {
            ctx.status = 502;
            ctx.body = { error: `Not released: ${e?.message || 'the address service did not answer'}` };
        } finally {
            releasesInFlight.delete(name);
            clearHolderCache();
        }
    });

    router.post('/api/local/admin/public-address/update', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        if (!requireAdminRole(ctx, ['owner'], ADDRESS_OWNER_ONLY)) return;
        const b = (ctx.request as any).body || (ctx as any).requestBody || {};
        try {
            const communityName = b.communityName !== undefined ? b.communityName : b.community_name;
            const result = await updateAddressMetadata(communityName, b.contact);
            const prev = (getNodeConfig() as any).publicAddress || {};
            const updatedPa = { ...prev };
            if (communityName !== undefined) updatedPa.communityName = communityName;
            if (b.contact !== undefined) updatedPa.contact = b.contact;
            updateNodeConfig({ publicAddress: updatedPa } as any);
            ctx.body = { success: true, ...addressFields(ctx, result) };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message };
        }
    });

    router.get('/api/local/admin/public-address/status', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        let localPa = (getNodeConfig() as any).publicAddress || null;

        // Fallback to env or saved token configuration if nodeConfig cache hasn't synced yet
        if (!localPa && process.env.PUBLIC_ADDRESS_NAME) {
            localPa = {
                status: 'live',
                name: process.env.PUBLIC_ADDRESS_NAME,
                hostname: `${process.env.PUBLIC_ADDRESS_NAME}.beanpool.org`,
                mode: process.env.PUBLIC_ADDRESS_MODE || 'tunnel'
            };
        }

        // An answer that comes after the address was written another way (a claim or Take offline in another tab, the
        // agent) is shown, never stored over the newer write.
        const since = publicAddressGeneration();
        try {
            const stored = (getNodeConfig() as any).publicAddress;
            const result = await addressStatus(stored?.name);
            // A live answer about another name this key holds (an older registrar answers about its first one) is never
            // stored: Settings shows the stored address. With nothing stored, nor one this server left (one the owner took
            // offline, the install's late claim): Settings shows it offline. Any other answer is only written on
            // the name it concerns, below.
            if (result.status === 'live' && answersAboutAnotherName(result, stored, nameAskedFor())) {
                ctx.body = { success: true, pubkey: nodePubkeyHex(), ...addressFields(ctx, stored), ...serverSide() };
                return;
            }
            if (result.status === 'live' && publicAddressGeneration() !== since) {
                ctx.body = { success: true, pubkey: nodePubkeyHex(), ...addressFields(ctx, result), ...serverSide() };
                return;
            }
            if (result.status === 'live') {
                recordRegistrarAnswer(result, 'stored');
                const prev = (getNodeConfig() as any).publicAddress || {};
                // Where the tunnel leads is recorded for the name it was set for (tunnel-connector.ts moves an old one).
                const origin = prev.origin && (!result.name || !prev.name || result.name === prev.name) ? { origin: prev.origin } : {};
                const { origin: _dropped, ...kept } = prev;
                updateNodeConfig({ publicAddress: { ...kept, ...origin, ...result } } as any);
                await syncTunnel();
                ctx.body = { success: true, pubkey: nodePubkeyHex(), ...addressFields(ctx, result), ...serverSide() };
                return;
            }
            // Any other answer is written on the name it concerns, and the name stays this community's. `none` above
            // all: a registrar that lost its data, or runs with the wrong database, answers it to every key. Wiping the
            // saved address and the tunnel token on it made every node whose admin opened Settings forget its name
            // (design §1.3). Settings says what the address service said instead.
            const names = recordRegistrarAnswer(result, 'status');
            const kept = result.status === 'none' ? names.find((n) => n.role === 'current') : undefined;
            ctx.body = {
                success: true, pubkey: nodePubkeyHex(), ...addressFields(ctx, result),
                ...(kept ? { kept: { hostname: kept.address, mode: localPa?.mode ?? null } } : {}),
                ...serverSide(),
            };
        } catch (e: any) {
            if (localPa && (localPa.hostname || localPa.name)) {
                ctx.body = {
                    success: true,
                    pubkey: nodePubkeyHex(),
                    ...addressFields(ctx, localPa),
                    cached: true,
                    error: e.message,
                    ...serverSide(),
                };
            } else {
                ctx.status = 400;
                ctx.body = { error: e.message };
            }
        }
    });

    // The tunnel runs inside this server (services/tunnel-connector.ts): this restarts that child process.
    router.post('/api/local/admin/public-address/restart-tunnel', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        try {
            addProbeLog('1/1', `⚡ Restarting the tunnel inside this server...`, 'info');
            const tunnel = await restartTunnel();
            if (!tunnel) {
                addProbeLog('1/1', `❌ This server runs no tunnel: it has no live tunnel address.`, 'error');
                ctx.status = 409;
                ctx.body = { error: 'This server runs no tunnel: it has no live tunnel address.', tunnel: getTunnelStatus() };
                return;
            }
            const ok = tunnel.state === 'starting' || tunnel.state === 'connected';
            addProbeLog('1/1', `${ok ? '✅' : '❌'} Tunnel ${describeTunnel(tunnel)}`, ok ? 'success' : 'error');
            if (!ok) {
                ctx.status = 500;
                ctx.body = { error: `The tunnel did not start: ${tunnel.reason || tunnel.state}`, tunnel };
                return;
            }
            ctx.body = { success: true, tunnel };
        } catch (e: any) {
            addProbeLog('1/1', `❌ Tunnel restart failed: ${e.message}`, 'error');
            ctx.status = 500;
            ctx.body = { error: e.message };
        }
    });

    // Settings' "New tunnel key": the name onto a fresh tunnel (the registrar's rotate). The old tunnel is deleted, so a copy
    // of its token (a standby given away, the token shown on this screen) stops working. A copy of the data folder or a backup
    // is NOT cut off: it holds the node key, and /status hands that key the new token;
    // the tunnel inside this server restarts on the new one. Only the main server runs the tunnel, so only it rotates.
    router.post('/api/local/admin/public-address/rotate', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        const pa = (getNodeConfig() as any).publicAddress;
        if (getNodeRole() !== 'primary' || !pa?.name || pa.mode === 'direct' || pa.status !== 'live') {
            ctx.status = 409;
            ctx.body = { error: getNodeRole() !== 'primary'
                ? 'Only the main server runs the tunnel, so only it can give the tunnel a new key.'
                : 'This server has no live tunnel address to give a new key.' };
            return;
        }
        const where = pa.hostname || pa.name;
        // Stored only if nothing wrote the address while the registrar was asked (a claim or Take offline in another tab, or
        // the agent's tick storing the same name again).
        const since = publicAddressGeneration();
        try {
            probeLogs.length = 0;
            addProbeLog('1/2', `⏳ Asking the address service for a new tunnel key for ${where}...`, 'info');
            const res = await rotateAddress(pa.name, LOOPBACK_ORIGIN);
            if (res?.status !== 'live') {
                recordRegistrarAnswer({ name: pa.name, hostname: pa.hostname, ...res }, 'status');
                addProbeLog('1/2', `❌ The address service answered "${res?.status ?? 'nothing'}" for ${where}`, 'error');
                ctx.status = 409;
                ctx.body = { error: `The address service answered "${res?.status ?? 'nothing'}"${res?.reason ? ` (${res.reason})` : ''} for ${where}.`, status: res?.status ?? null, reason: res?.reason ?? null };
                return;
            }
            addProbeLog('1/2', `✅ ${where} has a new tunnel key; the old one no longer works`, 'success');
            const { changed: _changed, rotated: _rotated, attest: _attest, ...answer } = res;
            const stored = persistAddressIfUnchanged({ ...pa, ...answer, name: pa.name, mode: 'tunnel', origin: LOOPBACK_ORIGIN }, 'stored', since);
            if (!stored) {
                addProbeLog('2/2', `❌ The address was written while the new key was made; that write stands`, 'error');
                ctx.status = 409;
                ctx.body = { error: `${where} got a new tunnel key, but the address was written meanwhile — open Settings again.` };
                return;
            }
            const tunnel = await stored;
            const ok = tunnel.state === 'starting' || tunnel.state === 'connected';
            addProbeLog('2/2', `${ok ? '✅' : '❌'} Tunnel ${describeTunnel(tunnel)}`, ok ? 'success' : 'error');
            ctx.body = { success: true, status: 'live', name: pa.name, hostname: res.hostname || pa.hostname, tunnel };
        } catch (e: any) {
            // An address service from before rotate existed answers 404 'not found'.
            const why = e?.message === 'not found' ? 'the address service doesn\'t offer new tunnel keys yet' : e?.message;
            addProbeLog('1/2', `❌ No new tunnel key: ${why}`, 'error');
            ctx.status = 502;
            ctx.body = { error: `No new tunnel key: ${why}` };
        }
    });

    router.post('/api/local/admin/public-address/offline', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        if (!requireAdminRole(ctx, ['owner'], ADDRESS_OWNER_ONLY)) return;
        try {
            probeLogs.length = 0;
            addProbeLog('1/4', `⏳ Releasing domain & deleting tunnel on Cloudflare registrar...`, 'info');
            const prevConfig = (getNodeConfig() as any).publicAddress;
            const hostname = prevConfig?.hostname;
            clearHolderCache();
            // Named: with no name the registrar releases this key's first name, which can be another one it holds. Unnamed
            // only when nothing is stored here.
            const result = await releaseAddress(prevConfig?.name);
            addProbeLog('1/4', `✅ Domain released on registrar`, 'success');
            // The name stays accepted here (decision D-B, pending Marty). The record keeps the registrar's hold as its
            // answer gives it (held_until), and none when it gives none: then the registrar freed the name at once.
            // Recorded before the stored address goes.
            recordRegistrarAnswer(result, 'released');
            updateNodeConfig({ publicAddress: null } as any);
            dropAddressRequest('the owner took the address offline in Settings');   // a release never brings back the name asked for at install
            settleUnansweredClaims();   // nor a claim that got no answer here
            noteTurnedAway(prevConfig?.name, 'taken-offline');
            addProbeLog('2/4', `⏳ Stopping the tunnel inside this server...`, 'info');
            const tunnel = await syncTunnel();
            addProbeLog('3/4', tunnel.state === 'off' ? `✅ Tunnel stopped` : `❌ Tunnel still ${describeTunnel(tunnel)}`, tunnel.state === 'off' ? 'success' : 'error');
            if (hostname) {
                verifyEdgeStatus(hostname, 'offline', 10).catch(err => {
                    console.warn('[PublicAddr] Edge offline probe error:', err?.message || err);
                });
            }
            ctx.body = { success: true, ...addressFields(ctx, result), status: 'none' };
        } catch (e: any) {
            addProbeLog('1/4', `❌ Offline failed: ${e.message}`, 'error');
            ctx.status = 400;
            ctx.body = { error: e.message };
        }
    });

    return router;
}
