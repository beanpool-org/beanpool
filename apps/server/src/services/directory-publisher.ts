import { getDirectoryInfo, getNodeConfig, updateNodeConfig, getNodeRole } from '../state-engine.js';
import { getLocalConfig } from '../config/local-config.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { isDirectoryPushInterval, DEFAULT_DIRECTORY_PUSH_INTERVAL_HOURS, LEGACY_NEVER_INTERVAL } from '../config/community-settings.js';
import { getP2PNode, getPrivateKey } from '../p2p.js';
import { publicKeyToProtobuf } from '@libp2p/crypto/keys';
import { listingFields, closingDayReached, PROMISE_GAP_MESSAGES, type ListingFields, type PromiseGap, type PromiseStatus } from '../engine/directory-promise.js';

// The URL of the directory registry Edge Function. Read at every push, so a test can point it at a fixture.
function directoryRegistryUrl(): string {
    return process.env.DIRECTORY_REGISTRY_URL || 'https://dpemwoermzkaxoctafzg.supabase.co/functions/v1/directory-register';
}

/** Why a node whose profile switch `publishToDirectory` is off sends nothing (the global profile's default). */
export const NOT_LISTED_MESSAGE = 'This node is not listed in the directory: its publishToDirectory switch is off (the global profile\'s default: the lobby is not a place on the map).';

/**
 * The name the public community-info shows for a community with neither a name nor a callsign (routes/community.ts), and
 * what the node's settings page stored when saved untouched before its name box read the stored name. The owners' boxes
 * now start from the stored name (diagnostics, null for none), so a save left untouched stores none.
 */
export const DEFAULT_COMMUNITY_NAME = 'BeanPool Community';

/** Why a community with no name of its own is held back (the manual push's answer and the log; the owners' screens word it themselves). */
export const HELD_BACK_NAME_MESSAGE = `Not listed in the directory yet: this community has no name of its own ("${DEFAULT_COMMUNITY_NAME}" is the default). Name it in Settings and it is listed at once.`;
/** Why a server with DIRECTORY_UNLISTED set is held back. */
export const HELD_BACK_UNLISTED_MESSAGE = 'Not listed in the directory: DIRECTORY_UNLISTED is set in this server\'s .env (our test and review nodes set it). Remove it and restart to be listed.';
/** Why a community whose closing day has come pushes no more (it was withdrawn on the day). */
export const CLOSED_MESSAGE = 'Not listed in the directory: the closing day set in Settings → Directory has come, so this community left the directory. Clear the closing day, or set a later one, to be listed again.';
/** Why a community whose new beanpool.org address is still on the address service's probation is held back. */
export const HELD_BACK_PROBATION_MESSAGE = 'Not listed in the directory yet: this server\'s beanpool.org address is new, and the address service checks a new address for a while before it is listed. It is listed by itself once that is done.';

/**
 * Why a community that would otherwise publish is held back, or null:
 *   - `unnamed`: its name is blank or exactly "BeanPool Community". The name is `communityName` alone: `callsign` is the
 *     admin's handle ("admin", "node-genesis" from the first-start wizard), never a community's name on a map.
 *   - `unlisted`: DIRECTORY_UNLISTED=1 (or true/yes/on) in the server's env. Our own test and review nodes set it in
 *     their .env on their servers (deploy.sh keeps each node's .env across deploys), so they are never a pin on the
 *     public map.
 *   - `probation`: the address service (the beanpool.org registrar) answered this server's live name with
 *     `probation: true` — a new name it routes but does not vouch for yet, until it has answered as this node for a while
 *     (apps/registrar README, "New names"). It ends by itself, and the push goes at once (addressVerified). A server
 *     with no registrar name, or its own domain, is never held back for it: a node never needs the registrar.
 *   Nothing else: a community is never held back for its address, hostname or callsign.
 * Never silent: the owners' diagnostics carry it (directoryHeldBack) and their screens say what to change.
 */
export type DirectoryHoldBack = 'unnamed' | 'unlisted' | 'probation';

/** Is this server's registrar name live but still on the registrar's probation (its last answer said so)? */
function onRegistrarProbation(): boolean {
    const pa = (getNodeConfig() as any).publicAddress;
    return pa?.status === 'live' && pa.probation === true;
}

export function isDefaultOrEmptyCommunityName(name: string | null | undefined): boolean {
    const clean = (name ?? '').trim();
    return !clean || clean === DEFAULT_COMMUNITY_NAME;
}

const UNLISTED_YES = ['1', 'true', 'yes', 'on'];
const UNLISTED_NO = ['', '0', 'false', 'no', 'off'];

/** DIRECTORY_UNLISTED in the env, read at every call. */
export function directoryUnlistedByEnv(): boolean {
    return UNLISTED_YES.includes((process.env.DIRECTORY_UNLISTED || '').trim().toLowerCase());
}

/** A DIRECTORY_UNLISTED that is neither a yes nor a no ("ture"): the community is listed, and the boot says so. */
function unrecognisedUnlistedValue(): string | null {
    const raw = process.env.DIRECTORY_UNLISTED ?? '';
    return UNLISTED_YES.includes(raw.trim().toLowerCase()) || UNLISTED_NO.includes(raw.trim().toLowerCase()) ? null : raw;
}

function holdBack(): DirectoryHoldBack | null {
    if (directoryUnlistedByEnv()) return 'unlisted';
    if (isDefaultOrEmptyCommunityName(getLocalConfig().communityName)) return 'unnamed';
    if (onRegistrarProbation()) return 'probation';
    return null;
}

const HELD_BACK_MESSAGES: Record<DirectoryHoldBack, string> = { unnamed: HELD_BACK_NAME_MESSAGE, unlisted: HELD_BACK_UNLISTED_MESSAGE, probation: HELD_BACK_PROBATION_MESSAGE };

/**
 * For the owners' screens (GET /api/local/admin/diagnostics `directoryHeldBack`: the manager's Directory Publishing and
 * static/settings.js): why this community is not on the public map although it is set to publish. Null where it
 * publishes, and where its screens already say why not: a standby, or Listed off (the global profile's default).
 */
export function directoryHeldBack(): DirectoryHoldBack | null {
    if (getNodeRole() !== 'primary' || !getProfileSwitches().publishToDirectory) return null;
    return holdBack();
}

/** The owners' diagnostics' `directoryPromise`: the listing promise as this node measures it, and why it is left out. */
export interface DirectoryPromiseDiagnostics extends PromiseStatus {
    /** What the next push says about joining: knocks on and the door not "only admins". */
    acceptingKnocks: boolean;
    /** One sentence per gap, in order (PROMISE_GAP_MESSAGES); empty when the promise is kept. */
    why: string[];
}

/**
 * For the owners' screens (GET /api/local/admin/diagnostics `directoryPromise`, and GET /api/local/admin/directory/
 * promise): the listing promise (engine/directory-promise.ts) as the next push will carry it, and why not. Null where
 * nothing is pushed at all and the screens already say why: a standby, or Listed off. A community held back for its
 * name still gets it, so its owners can make the promise before they name it.
 */
export function directoryPromiseStatus(): DirectoryPromiseDiagnostics | null {
    if (getNodeRole() !== 'primary' || !getProfileSwitches().publishToDirectory) return null;
    const { fields, status } = listingFields();
    return { ...status, acceptingKnocks: fields.acceptingKnocks, why: status.gaps.map((g: PromiseGap) => PROMISE_GAP_MESSAGES[g]) };
}

let pushTimer: ReturnType<typeof setInterval> | null = null;

function safePush(): void {
    pushDirectoryNow().catch(err => {
        console.error('[Directory] Unhandled error in scheduled directory push:', err?.message || err);
    });
}

// Guarded here, not just at the index.ts boot call site — /api/local/admin/node/config
// and /api/local/admin/directory/push can also reach these, and a backup replica must
// never advertise itself in the public directory regardless of caller. Nor must a node
// whose profile switch `publishToDirectory` is off (config/node-profile.ts): the global
// node is the lobby, not a community with a place, so it is never a pin on the map.
// A community with no name of its own still gets the timer: every push is held back until it is named, and naming it
// pushes at once (communityNameSaved), with no restart. DIRECTORY_UNLISTED, which only a restart changes, sets none.
// Returns whether the timer is set.
export function initDirectoryPublisher(): boolean {
    const typo = unrecognisedUnlistedValue();
    if (typo !== null) {
        console.warn(`[Directory] ⚠️ DIRECTORY_UNLISTED=${JSON.stringify(typo)} in this server's .env is not a yes (1, true, yes, on) or a no (empty, 0, false, no, off), so this community is listed. To keep it off the public map, set DIRECTORY_UNLISTED=1 and restart.`);
    }
    if (getNodeRole() !== 'primary') {
        console.log('[Directory] 🔒 Skipping — backup replicas do not publish to the directory.');
        return false;
    }
    if (pushTimer) {
        clearInterval(pushTimer);
        pushTimer = null;
    }
    if (!getProfileSwitches().publishToDirectory) {
        console.log(`[Directory] 📴 ${NOT_LISTED_MESSAGE}`);
        return false;
    }
    if (directoryUnlistedByEnv()) {
        console.log(`[Directory] 📴 ${HELD_BACK_UNLISTED_MESSAGE}`);
        return false;
    }
    // The schedule, whole hours from 1 (the route takes only those); anything else stored reads as the default. Its old
    // 0, Never, is carried over to Listed off at boot and at a kept record's install (config/community-shape-upgrade.ts).
    // A 0 still stored here means that carry didn't run or failed: fail closed, as the old Never did, and send nothing.
    const stored = getNodeConfig().directoryPushIntervalHours;
    if (stored === LEGACY_NEVER_INTERVAL) {
        console.log('[Directory] 📴 The old schedule "Never" is still stored and was not carried over to Listed off, so nothing is sent. To be listed, save a schedule (every 1 hour or more) in Node Identity; not to be, switch Listed off under How this community works.');
        return false;
    }
    const intervalHours = isDirectoryPushInterval(stored) ? stored : DEFAULT_DIRECTORY_PUSH_INTERVAL_HOURS;

    // Convert hours to milliseconds
    const intervalMs = intervalHours * 60 * 60 * 1000;

    pushTimer = setInterval(safePush, intervalMs);
    
    // Initial push 30s after boot
    setTimeout(safePush, 30_000);
    console.log(`[Directory] 📡 Push publisher initialized (Interval: ${intervalHours}h)`);
    if (holdBack() === 'unnamed') console.log(`[Directory] ⏸️ ${HELD_BACK_NAME_MESSAGE}`);
    return true;
}

/**
 * The community's name was saved (routes/community.ts update-identity: the manager's Node Identity and first-start
 * wizard, static/settings.js). A community named after its server started is listed at once rather than at the next
 * timed push (12 hours by default), and a rename shows at once. Only while the publisher runs: nothing on a standby or
 * with Listed off; nothing while it is held back.
 */
export function communityNameSaved(): void {
    if (!pushTimer || holdBack()) return;
    safePush();
}

/**
 * The registrar's probation of this server's name ended: its answer stored now says nothing of it (public-address-agent.ts
 * reconcile). Listed at once, as a name saved is, rather than at the next timed push (12 hours by default). Only while the
 * publisher runs, and nothing while anything else holds it back.
 */
export function addressVerified(): void {
    if (!pushTimer || holdBack()) return;
    safePush();
}

/**
 * An owner changed the listing promise's ticks or the closing day (Settings → Directory): pushed at once, so the card
 * says so now rather than at the next timed push. On the same conditions as a rename.
 */
export function directoryPromiseSaved(): void {
    communityNameSaved();
}

/** The fields a registry from before the listing promise (mothership A2) doesn't know: the push without them is the old one. */
const LISTING_FIELDS: (keyof ListingFields)[] = ['promise', 'acceptingKnocks', 'closingOn', 'answers'];

/** Signs `payload` with the node key and POSTs it to the registry. Throws on a network failure; the answer is the caller's. */
async function signedPush(payload: Record<string, unknown>, privateKey: NonNullable<ReturnType<typeof getPrivateKey>>): Promise<Response> {
    const rawBody = JSON.stringify(payload);
    const signatureBytes = await privateKey.sign(new TextEncoder().encode(rawBody));
    const signatureHex = Buffer.from(signatureBytes).toString('hex');
    const pubKeyHex = Buffer.from(publicKeyToProtobuf(privateKey.publicKey)).toString('hex');
    return fetch(directoryRegistryUrl(), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-signature': signatureHex,
            'x-public-key': pubKeyHex
        },
        body: rawBody
    });
}

/** Why the node withdraws: the owners switched Listed off, the closing day came, or DIRECTORY_UNLISTED was found at boot. */
export type WithdrawReason = 'listed_off' | 'closing_day' | 'unlisted_at_boot';

export interface WithdrawResult {
    /** Whether a withdraw was sent at all. */
    sent: boolean;
    /** Whether the registry took it (2xx). */
    ok: boolean;
    /** Why nothing was sent, or what went wrong. */
    reason?: string;
}

let withdrawing: Promise<WithdrawResult> | null = null;

/**
 * Takes this community off the public directory at once (front doors S13, design §2.2): POSTs `{ nodeId, timestamp,
 * unlist: true }`, signed exactly as a push is (signedPush: the node key, the same two headers), and the registry deletes
 * the row whose node_id is this key's PeerId (supabase/functions/directory-register, v6). Nothing else is in it, not even
 * the callsign: a registry from before v6 refuses it for the missing field (400) and never mistakes it for a push.
 *
 * Only a main server, and only one that has pushed (`lastDirectoryPush` recorded): a node that was never listed sends
 * nothing, so no node needs our servers for anything here. A withdraw the registry took clears `lastDirectoryPush`, so
 * each way out sends one and never repeats; one that failed keeps it (Listed off's and the boot's are tried again at the
 * next boot, the closing day's at the next timed push; the directory drops a row unpushed for 7 days in any case).
 * Never throws.
 */
export async function withdrawFromDirectory(reason: WithdrawReason): Promise<WithdrawResult> {
    if (getNodeRole() !== 'primary') return { sent: false, ok: false, reason: 'not a main server' };
    if (!getNodeConfig().lastDirectoryPush) return { sent: false, ok: false, reason: 'never pushed' };
    if (withdrawing) return withdrawing;
    const run = (async (): Promise<WithdrawResult> => {
        try {
            const p2pNode = getP2PNode();
            const privateKey = getPrivateKey();
            if (!p2pNode || !privateKey) return { sent: false, ok: false, reason: 'P2P node not ready' };
            const res = await signedPush({ nodeId: p2pNode.peerId.toString(), timestamp: Date.now(), unlist: true }, privateKey);
            if (!res.ok) {
                const why = `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`;
                console.warn(`[Directory] ⚠️ Could not take this community off the directory (${reason}): ${why}. The directory drops a row not pushed for 7 days.`);
                return { sent: true, ok: false, reason: why };
            }
            await res.body?.cancel().catch(() => { /* answered */ });
            updateNodeConfig({ lastDirectoryPush: undefined });
            console.log(`[Directory] 📴 Took this community off the directory (${reason}).`);
            return { sent: true, ok: true };
        } catch (err: any) {
            console.warn(`[Directory] ⚠️ Could not take this community off the directory (${reason}): ${err?.message || err}`);
            return { sent: true, ok: false, reason: String(err?.message || err) };
        }
    })();
    // Cleared once it settles, from outside it: a run that returns before its first await would otherwise clear the slot
    // before it was set, and hold it for good.
    withdrawing = run;
    void run.finally(() => { if (withdrawing === run) withdrawing = null; });
    return run;
}

/** The owners switched Listed off (config/community-shape-write.ts): the row goes now, not in 7 days. Not awaited. */
export function listedSwitchedOff(): void {
    withdrawFromDirectory('listed_off').catch(() => { /* never throws */ });
}

/**
 * At boot (index.ts, a main server): DIRECTORY_UNLISTED is set, or Listed is off, and this node pushed before, so its row
 * may still be out there: the withdraw at Listed off failed (the registry down, the node offline), or the server stopped
 * before it was sent. It goes now, once (the withdraw clears the record). Null when there is nothing to do: a listed
 * community, or one that never pushed (the global profile, which is never listed, among them).
 */
export async function withdrawIfUnlistedAtBoot(): Promise<WithdrawResult | null> {
    const unlistedByEnv = directoryUnlistedByEnv();
    if ((!unlistedByEnv && getProfileSwitches().publishToDirectory) || getNodeRole() !== 'primary' || !getNodeConfig().lastDirectoryPush) return null;
    return withdrawFromDirectory(unlistedByEnv ? 'unlisted_at_boot' : 'listed_off');
}

export async function pushDirectoryNow() {
    if (getNodeRole() !== 'primary') {
        return { success: false, error: 'Directory push is only allowed on primary nodes' };
    }
    // Read at every push, the timer's included: an operator's override switching it off takes effect at the next push.
    // Switched on at runtime, the timer starts at the next boot, or when Settings saves the push interval.
    if (!getProfileSwitches().publishToDirectory) {
        return { success: false, error: NOT_LISTED_MESSAGE };
    }
    // Read at every push too: the timer runs for an unnamed community, and sends nothing until it is named.
    const held = holdBack();
    if (held) return { success: false, error: HELD_BACK_MESSAGES[held], heldBack: held };
    // The closing day has come: the community leaves the directory now (once: the withdraw clears lastDirectoryPush) and
    // is pushed no more, or the next timed push would list it again. Clearing the day, or a later one, lists it again.
    if (closingDayReached()) {
        const withdrawn = await withdrawFromDirectory('closing_day');
        return { success: false, error: CLOSED_MESSAGE, closed: true, withdrawn: withdrawn.sent && withdrawn.ok };
    }
    try {
        const directoryInfo = getDirectoryInfo();
        const localConfig = getLocalConfig();
        const p2pNode = getP2PNode();
        const privateKey = getPrivateKey();

        if (!p2pNode || !privateKey) {
            console.warn(`[Directory] ⚠️ P2P node not fully initialized. Skipping push.`);
            return { success: false, error: 'P2P node not ready' };
        }
        
        // Provide a stable node ID based on the node's true cryptographic PeerId
        const nodeId = p2pNode.peerId.toString();
        const timestamp = Date.now();
        
        // The listing promise (engine/directory-promise.ts), measured now: left out (null) when a measured line fails,
        // and the log says why, as the owners' diagnostics do. Counts and booleans only. A measurement that fails sends
        // none of the three: it must never cost the community its listing.
        let listing: ReturnType<typeof listingFields> | null = null;
        try {
            listing = listingFields();
        } catch (e: any) {
            console.error(`[Directory] Could not measure the listing promise, pushed without it: ${e?.message || e}`);
        }
        if (listing && !listing.status.kept && !listing.status.gaps.includes('not_made')) {
            console.log(`[Directory] The listing promise is left out of this push: ${listing.status.gaps.map(g => PROMISE_GAP_MESSAGES[g]).join(' ')}`);
        }

        // The contacts are always said, null unless the owner turned each on (getDirectoryInfo): a node that publishes
        // nothing else must still tell the directory to drop a contact it was sent before. So are the listing fields:
        // a promise that lapsed must be cleared, not kept from the push before.
        const payload: Record<string, unknown> = {
            nodeId,
            callsign: localConfig.communityName,
            timestamp,
            contactEmail: null,
            contactPhone: null,
            ...directoryInfo,
            ...listing?.fields,
        };

        let res = await signedPush(payload, privateKey);
        // The registry's table and function take the listing fields only once the director applies
        // supabase/migrations/20261018000000_directory_listing_promise.sql and the function's three lines. Until then a
        // registry that refuses a field it doesn't know must not cost the community its listing: it is pushed again
        // as before, without them, signed afresh.
        let listingRefused = false;
        if (!res.ok && listing) {
            const refusal = `HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`;
            const before = Object.fromEntries(Object.entries(payload).filter(([k]) => !LISTING_FIELDS.includes(k as keyof ListingFields)));
            res = await signedPush({ ...before, timestamp: Date.now() }, privateKey);
            if (res.ok) {
                listingRefused = true;
                console.warn(`[Directory] ⚠️ The directory registry refused the listing promise (${refusal}); published without it, as before.`);
            }
        }

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`HTTP ${res.status}: ${errText}`);
        }
        
        // Update lastDirectoryPush
        const pushedAt = new Date().toISOString();
        updateNodeConfig({ lastDirectoryPush: pushedAt });

        // Listed went off while this push was out (the boot's, the timer's, a rename's): the withdraw sent then may have
        // reached the registry first, and this push has put the row back. So it is withdrawn again now, once any withdraw
        // still out has settled (it may clear the record, and a second call would only wait on it), with this push
        // recorded so that the withdraw is sent.
        if (!getProfileSwitches().publishToDirectory) {
            await withdrawing;
            updateNodeConfig({ lastDirectoryPush: pushedAt });
            const withdrawn = await withdrawFromDirectory('listed_off');
            return { success: false, error: NOT_LISTED_MESSAGE, withdrawn: withdrawn.sent && withdrawn.ok };
        }

        console.log(`[Directory] ✅ Successfully published to directory registry`);
        return {
            success: true, timestamp: new Date().toISOString(),
            // Whether the row carries the promise: 'sent', 'none' (not kept), or 'refused' (the registry predates it).
            promise: listingRefused ? 'refused' : listing?.fields.promise ? 'sent' : 'none',
        };
    } catch (err: any) {
        console.error(`[Directory] ❌ Failed to push directory info:`, err.message);
        return { success: false, error: err.message };
    }
}
