/**
 * "Beside my name on the worldwide forum" on the phone (slice F10 apps; @beanpool/core forum-label.ts is what it does and
 * why, and the web runs the same file). Here is what is the phone's:
 *
 * - **Which communities.** The phone keeps the member's communities (utils/nodes.ts): the choice lists the others beside
 *   the worldwide one in front, by name, in one tap each. The note is asked of that community at the address the phone uses
 *   for it (community-index.ts), signed by the member's key (node-post.ts signedGet).
 * - **The choice** goes to the community in front, the worldwide forum, signed (db.ts signedRequestWithMethod).
 * - **What was picked** is kept, as the web keeps it: the forum's directory key for the community, beside the record key the
 *   community is kept under (storage-keys.ts FORUM_LABEL_PICK_STORE_KEY). A record S4 hasn't given a server key yet is
 *   still the one ticked on the next visit, never drawn twice, and its note is still renewed.
 * - **Renewing** finds the community by the forum's own key for it: the record whose server key is that directory key
 *   (community-index.ts communityRecordByKey), else the one kept as picked, at the address the phone uses for it now. None,
 *   and Settings says the note ran out until it is picked again. Asked at most once an app run, when the forum is opened
 *   and says it is public.
 * - **The language.** The note request goes to another community; the fetch wrapper (node-request-signing.ts) names the
 *   member's language on it, as on every request to a community's API, so its refusal comes back in it.
 */
import {
    FORUM_LABEL_PATHS, chooseForumLabel, readForumLabelState, renewForumLabel,
    type ForumLabelAnswer, type ForumLabelChoice, type ForumLabelDeps, type ForumLabelResult, type ForumLabelState,
} from '@beanpool/core';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { signedRequestWithMethod } from './db';
import { signedGet } from './node-post';
import { loadIdentity } from './identity';
import { getSavedNodes } from './nodes';
import { communityName } from './community-name';
import { communityKeyOf, communityRecordByKey, communityRecordOf, sameCommunityRecord, usingOf } from './community-index';
import { FORUM_LABEL_PICK_STORE_KEY } from './storage-keys';

const ASK_MS = 12_000;

/** One of the member's other communities on this phone, as the choice lists it. */
export interface PhoneCommunity { address: string; name: string; key: string | null }

/** A signed request to the community in front, its answer as core reads it (a refusal's own words kept). */
async function inFront(method: 'GET' | 'POST', body?: unknown): Promise<ForumLabelAnswer> {
    try {
        return { status: 200, body: await signedRequestWithMethod(method, FORUM_LABEL_PATHS.label, body, { withStatus: true }) };
    } catch (e) {
        const err = e as { status?: unknown; message?: string; unsaid?: boolean };
        if (typeof err.status !== 'number') throw e;
        return { status: err.status, body: { error: err.unsaid ? '' : err.message } };
    }
}

const deps: ForumLabelDeps = {
    async askNote(address) {
        const identity = await loadIdentity();
        if (!identity) throw new Error('no key on this phone');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ASK_MS);
        try {
            const res = await signedGet(communityRecordOf(address)?.using ?? address, FORUM_LABEL_PATHS.note, identity, controller.signal);
            return { status: res.status, body: await res.json().catch(() => null) };
        } finally {
            clearTimeout(timer);
        }
    },
    postLabel: (body) => inFront('POST', body),
};

/** What the member chose, as the forum says it; null when it can't say (not the worldwide forum, or no answer). */
export async function readForumLabel(): Promise<ForumLabelState | null> {
    const got = await inFront('GET').catch(() => null);
    return got?.status === 200 ? readForumLabelState(got.body) : null;
}

/** The community picked on this phone, as the forum named it: its directory key, and the record key it is kept under. */
interface KeptPick { key: string; community: string }

/** The pick kept for this phone's key; null when none, or another key's. */
async function keptPick(): Promise<KeptPick | null> {
    const [identity, raw] = await Promise.all([loadIdentity().catch(() => null), AsyncStorage.getItem(FORUM_LABEL_PICK_STORE_KEY).catch(() => null)]);
    try {
        const kept = JSON.parse(raw ?? 'null') as { member?: unknown; key?: unknown; community?: unknown } | null;
        return identity?.publicKey && kept?.member === identity.publicKey && typeof kept.key === 'string' && kept.key
            && typeof kept.community === 'string' && kept.community ? { key: kept.key, community: kept.community } : null;
    } catch {
        return null;
    }
}

/** Keeps what the forum now holds as picked here (a community: its key and record), else nothing. */
async function keepPick(state: ForumLabelState, address: string | null): Promise<void> {
    const identity = await loadIdentity().catch(() => null);
    try {
        if (identity?.publicKey && state.show === 'community' && state.community && address) {
            await AsyncStorage.setItem(FORUM_LABEL_PICK_STORE_KEY, JSON.stringify({ member: identity.publicKey, key: state.community.key, community: communityKeyOf(address) }));
        } else {
            await AsyncStorage.removeItem(FORUM_LABEL_PICK_STORE_KEY);
        }
    } catch { /* kept for the tick and renewing only: lost, and Settings says the note ran out until it is picked again */ }
}

/** The member's choice, made (core chooseForumLabel), and what was picked kept for the next visit and renewing. */
export async function setForumLabel(choice: ForumLabelChoice): Promise<ForumLabelResult> {
    const done = await chooseForumLabel(deps, choice);
    if (done.ok) await keepPick(done.state, choice.show === 'community' ? choice.address : null);
    return done;
}

/**
 * The member's other communities on this phone: every saved one but the community in front. Its `key` is the server key
 * its record proved, else the forum's key for it when it is the one picked here.
 */
export async function otherCommunities(): Promise<PhoneCommunity[]> {
    const [nodes, anchor, kept] = await Promise.all([
        getSavedNodes().catch(() => []), AsyncStorage.getItem('beanpool_anchor_url').catch(() => null), keptPick(),
    ]);
    return nodes
        .filter((n) => !anchor || !sameCommunityRecord(n.url, anchor))
        .map((n) => ({
            address: n.url,
            name: communityName(n),
            key: communityRecordOf(n.url)?.peerId ?? (kept && kept.community === communityKeyOf(n.url) ? kept.key : null),
        }));
}

let renewedThisRun = false;

/** Renews the community note when it is due, once an app run (core renewForumLabel). Never throws. */
export async function renewForumLabelOnce(): Promise<void> {
    if (renewedThisRun) return;
    renewedThisRun = true;
    const [state, kept] = await Promise.all([readForumLabel(), keptPick()]);
    await renewForumLabel(deps, state, (key) => communityRecordByKey(key)?.using ?? (kept?.key === key ? usingOf(kept.community) : null)).catch(() => null);
}
