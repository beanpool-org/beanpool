/**
 * Joining a second community with an invite, for a member who already has one: the path People's "Join Another
 * Community" has always taken, lifted out so an approved knock (utils/knock.ts) takes the same one.
 *
 * The phone switches its database and anchor to the new community, redeems the invite there with the member's
 * one key (the same key on every node), and saves the community to the phone's list. If the redeem fails the
 * phone is put back on the community it came from, exactly as before. An invite made for a knock admits only the
 * key that knocked (engine/knocks.ts), and the redeem sends that key.
 *
 * ## What moves with a member, and what doesn't (design §3.6)
 *
 * The key and the 12 words: everything, automatically. The name: carried, made unique there if it's taken. The
 * photo: re-sent by the profile step that follows. Beans, trust, posts, chats: no, they belong to each community.
 * Sign-in recovery: kept by each community, so the member is asked to protect this one too (`joinedNudge`).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BeanPoolIdentity } from './identity';

export interface JoinDeps {
    closeDB(): Promise<void>;
    initDB(): Promise<void>;
    redeemInvite(code: string, callsign: string, identity: BeanPoolIdentity): Promise<{ success: true; alreadyMember: boolean; nodeHasPhoto: boolean }>;
    addSavedNode(url: string, alias?: string, currencyType?: 'text' | 'image', currencyValue?: string): Promise<void>;
    clearGuestNode(url: string): Promise<void>;
    requestSync(): Promise<unknown>;
}

async function defaultDeps(): Promise<JoinDeps> {
    // Loaded when used, as People always has: db.ts and pillar-sync pull in the whole data layer.
    const db = await import('./db');
    const nodes = await import('./nodes');
    const sync = await import('../services/pillar-sync');
    return {
        closeDB: db.closeDB,
        initDB: db.initDB,
        redeemInvite: db.redeemInvite,
        addSavedNode: nodes.addSavedNode,
        clearGuestNode: nodes.clearGuestNode,
        requestSync: sync.requestSync,
    };
}

export interface JoinedCommunity {
    url: string;
    /** The community's own name, as it answers it, else the one we were given, else its address. */
    name: string;
    alreadyMember: boolean;
}

async function communityDetails(url: string): Promise<{ name: string | null; currencyType?: 'text' | 'image'; currencyValue?: string } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
        const res = await fetch(`${url}/api/community/health`, { method: 'GET', signal: controller.signal });
        if (!res.ok) return null;
        const health = await res.json();
        const name = typeof health?.nodeName === 'string' && health.nodeName.trim() ? health.nodeName.trim()
            : typeof health?.name === 'string' && health.name.trim() ? health.name.trim() : null;
        const type = health?.currency?.type === 'text' ? 'text' : 'image';
        return { name, currencyType: type, currencyValue: health?.currency?.value || 'bean' };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Redeem `code` on `targetUrl` and make it this phone's community. `returnUrl` is where the phone goes back to
 * if the redeem fails. Throws the redeem's own error (the node's words) after putting the phone back.
 */
export async function joinAnotherCommunity(
    opts: { targetUrl: string; code: string; identity: BeanPoolIdentity; returnUrl: string | null; knownName?: string | null },
    injected?: JoinDeps,
): Promise<JoinedCommunity> {
    const deps = injected ?? await defaultDeps();
    const targetUrl = opts.targetUrl.replace(/\/+$/, '');
    await deps.closeDB();
    await AsyncStorage.setItem('beanpool_anchor_url', targetUrl);
    await deps.initDB();
    let alreadyMember: boolean;
    try {
        ({ alreadyMember } = await deps.redeemInvite(opts.code, opts.identity.callsign || 'Unknown', opts.identity));
    } catch (err) {
        await deps.closeDB();
        if (opts.returnUrl) await AsyncStorage.setItem('beanpool_anchor_url', opts.returnUrl);
        else await AsyncStorage.removeItem('beanpool_anchor_url');
        await deps.initDB();
        throw err;
    }
    // Registered here: no longer a guest, if this phone ever looked in as one.
    await deps.clearGuestNode(targetUrl).catch(() => {});
    deps.requestSync().catch(() => {});
    const details = await communityDetails(targetUrl);
    const name = details?.name ?? opts.knownName ?? targetUrl;
    try {
        await deps.addSavedNode(targetUrl, details?.name ?? opts.knownName ?? undefined, details?.currencyType, details?.currencyValue);
    } catch {
        // The phone is on the community either way; the saved list catches up from the header's picker.
    }
    return { url: targetUrl, name, alreadyMember };
}

/** Where the profile step lands a member who chose to protect the new community now. */
export const PROTECT_REDIRECT = '/(tabs)/settings?section=protection';
/** …and one who chose later. */
export const HOME_REDIRECT = '/(tabs)';

/**
 * What a member is told once they're in a second community: what came with them, what didn't, and that sign-in
 * recovery is kept by each community, so this one needs protecting too (design §3.6's "protect this community
 * too"). Both answers go through the profile step (name and photo for this community) first.
 */
export function joinedNudge(name: string): { title: string; body: string; later: string; protect: string } {
    return {
        title: `You're in ${name}`,
        body: 'Your key and your 12 words came with you, and so does your name. Your posts, chats and trades stay in each community.\n\n'
            + `A sign-in that protects your account is kept by each community, so protect your account in ${name} too.`,
        later: 'Later',
        protect: 'Protect it',
    };
}
