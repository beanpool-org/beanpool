/**
 * What kind of node a community is, as the node says itself: `profile` and `features` from
 * `GET /api/community/info` (public; apps/server/src/config/node-profile.ts), fetched per node and
 * kept on this phone so a screen can read it without waiting for the network.
 *
 * Two profiles exist. `local` is every community node: invites, Beans, the Commons. `global` is the
 * worldwide lobby at global.beanpool.org (design: scratch/global-node/DESIGN-global-profile-fable.md):
 * anyone may join with one sign-in instead of an invite, and Beans are off.
 *
 * A node that says nothing about its profile is `local`: every node before the profile existed was
 * one. A feature a node does not mention is left out rather than guessed, so each reader decides what
 * "not said" means for it (the tabs keep today's strip; the open door stays shut).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/** The worldwide community's one address. `earth.beanpool.org` redirects here at Cloudflare. */
export const GLOBAL_NODE_URL = 'https://global.beanpool.org';

export type NodeProfileName = 'local' | 'global';

/** The switches the app reads. Each is optional: a node older than the profile says none of them. */
export interface NodeFeatures {
    beans?: boolean;
    escrow?: boolean;
    enterprises?: boolean;
    openJoin?: boolean;
    knocks?: boolean;
    distanceSearch?: boolean;
    probation?: boolean;
    autoHideReports?: boolean;
    autoMute?: boolean;
    guestListingsOnly?: boolean;
}

const FEATURE_KEYS: ReadonlyArray<keyof NodeFeatures> = [
    'beans', 'escrow', 'enterprises', 'openJoin', 'knocks', 'distanceSearch',
    'probation', 'autoHideReports', 'autoMute', 'guestListingsOnly',
];

export interface NodeProfile {
    profile: NodeProfileName;
    features: NodeFeatures;
    /** When this phone last heard it from the node (ISO). */
    checkedAt: string;
}

const CACHE_KEY = 'beanpool_node_profiles';
const FETCH_TIMEOUT_MS = 10_000;

/** One cache entry per node, whatever spelling of its address it was reached by. */
function cacheKey(url: string): string {
    return url.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Read the profile out of an info answer, or null when the answer is not one.
 *
 * Only the exact string `global` makes a node global: anything else, including an answer that does
 * not say, is `local`. Only booleans are kept from `features`.
 */
export function readNodeProfile(body: unknown, now: Date = new Date()): NodeProfile | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const b = body as { profile?: unknown; features?: unknown };
    const features: NodeFeatures = {};
    if (b.features && typeof b.features === 'object') {
        const f = b.features as Record<string, unknown>;
        for (const key of FEATURE_KEYS) {
            if (typeof f[key] === 'boolean') features[key] = f[key] as boolean;
        }
    }
    return { profile: b.profile === 'global' ? 'global' : 'local', features, checkedAt: now.toISOString() };
}

async function readCache(): Promise<Record<string, NodeProfile>> {
    try {
        const raw = await AsyncStorage.getItem(CACHE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

/** What this phone last heard from `url`, or null if it never has. No network. */
export async function getCachedNodeProfile(url: string | null | undefined): Promise<NodeProfile | null> {
    if (!url) return null;
    const cached = (await readCache())[cacheKey(url)];
    return cached ? readNodeProfile(cached, new Date(cached.checkedAt || 0)) : null;
}

async function remember(url: string, profile: NodeProfile): Promise<void> {
    try {
        const all = await readCache();
        all[cacheKey(url)] = profile;
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify(all));
    } catch {
        // A cache that could not be written is asked again next time; nothing depends on it.
    }
}

/**
 * Ask `url` what it is, and remember the answer. Null when it could not be asked (no network, a
 * timeout, an error answer, or something that is not an info answer); the cache is left as it was.
 */
export async function fetchNodeProfile(url: string, fetchImpl: typeof fetch = fetch): Promise<NodeProfile | null> {
    const base = url.trim().replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetchImpl(`${base}/api/community/info`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const profile = readNodeProfile(await res.json().catch(() => null));
        if (profile) await remember(base, profile);
        return profile;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** Why the worldwide community can't be joined from here right now. */
export type GlobalDoorRefusal =
    /** No answer: offline, the node is down, or it timed out. */
    | 'unreachable'
    /** It answered, and it is not the worldwide community (a stale build must never open-join a local node). */
    | 'not_global'
    /** It is the worldwide community, and its door is shut (`features.openJoin` is not on). */
    | 'door_closed';

export type GlobalDoorCheck = { ok: true; profile: NodeProfile } | { ok: false; reason: GlobalDoorRefusal };

/**
 * Whether `url` is the worldwide community with its door open, asked fresh (never from the cache:
 * the door is about to be used, so an old answer would only move the failure later).
 */
export async function checkGlobalDoor(
    url: string = GLOBAL_NODE_URL, fetchImpl: typeof fetch = fetch,
): Promise<GlobalDoorCheck> {
    const profile = await fetchNodeProfile(url, fetchImpl);
    if (!profile) return { ok: false, reason: 'unreachable' };
    if (profile.profile !== 'global') return { ok: false, reason: 'not_global' };
    if (profile.features.openJoin !== true) return { ok: false, reason: 'door_closed' };
    return { ok: true, profile };
}

/** What the member reads for each refusal. Never a hard gate: invites always still work. */
export const GLOBAL_DOOR_MESSAGES: Record<GlobalDoorRefusal, string> = {
    unreachable: "Can't reach the global community right now. Try again, or join with an invite.",
    not_global: "The global community isn't available right now. You can still join a community with an invite.",
    door_closed: "The global community isn't taking new members right now. You can still join a community with an invite.",
};

/** The tabs a node hides. Only a node that says outright that Beans are off hides any. */
export type HideableTab = 'projects' | 'ledger';

/**
 * Commons (the `projects` route) and Ledger are money: the pool, enterprises, crowdfunds, balances.
 * On a node with Beans off they would show a ledger that is 0 forever, so they are hidden. The
 * routes stay (a link to them still opens), only the tab strip changes.
 */
export function hiddenTabsFor(features: NodeFeatures | null | undefined): HideableTab[] {
    return features?.beans === false ? ['projects', 'ledger'] : [];
}

/** Whether this node's members trade in Beans. Unknown counts as yes: that is every node today. */
export function beansOn(features: NodeFeatures | null | undefined): boolean {
    return features?.beans !== false;
}
