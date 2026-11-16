/**
 * "Beside my name on the worldwide forum" on the phone (slice F10 apps; @beanpool/core forum-label.ts is what it does and
 * why, and the web runs the same file). Here is what is the phone's:
 *
 * - **Which communities.** The phone keeps the member's communities (utils/nodes.ts): the choice lists the others beside
 *   the worldwide one in front, by name, in one tap each. The note is asked of that community at the address the phone uses
 *   for it (community-index.ts), signed by the member's key (node-post.ts signedGet).
 * - **The choice** goes to the community in front, the worldwide forum, signed (db.ts signedRequestWithMethod).
 * - **Renewing** finds the community by the forum's own key for it: the record whose server key is that directory key
 *   (community-index.ts communityRecordByKey). None on this phone, and Settings says the note ran out until it is picked
 *   again. Asked at most once an app run, when the forum is opened and says it is public.
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
import { communityRecordByKey, communityRecordOf, sameCommunityRecord } from './community-index';

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

/** The member's choice, made (core chooseForumLabel). */
export function setForumLabel(choice: ForumLabelChoice): Promise<ForumLabelResult> {
    return chooseForumLabel(deps, choice);
}

/** The member's other communities on this phone: every saved one but the community in front. */
export async function otherCommunities(): Promise<PhoneCommunity[]> {
    const [nodes, anchor] = await Promise.all([getSavedNodes().catch(() => []), AsyncStorage.getItem('beanpool_anchor_url').catch(() => null)]);
    return nodes
        .filter((n) => !anchor || !sameCommunityRecord(n.url, anchor))
        .map((n) => ({ address: n.url, name: communityName(n), key: communityRecordOf(n.url)?.peerId ?? null }));
}

let renewedThisRun = false;

/** Renews the community note when it is due, once an app run (core renewForumLabel). Never throws. */
export async function renewForumLabelOnce(): Promise<void> {
    if (renewedThisRun) return;
    renewedThisRun = true;
    const state = await readForumLabel();
    await renewForumLabel(deps, state, (key) => communityRecordByKey(key)?.using ?? null).catch(() => null);
}
