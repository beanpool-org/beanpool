/**
 * Message requests waiting on the global community, for the one "Message requests" row at the top of Chat (decision 4 of
 * DESIGN-reaching-across-fable.md, as Marty changed it: every kind of outside request behind one row, no alert or badge).
 * A question through a copy's door reaches its member on global, and no push rings for a request, so a phone set to their own
 * community would otherwise never show it. The row is for the device that ticked, not every device they have (below).
 *
 * - **Counts alone** (GET /api/me/unread): nothing of who wrote, and nothing of a line. Accept, Decline and Report are global's
 *   own list, one tap on: this phone's chats are kept per community, and a line is read where it is kept.
 * - **Nothing is asked of global until the member has asked for questions on this device**, by the director's ruling on #2741: a
 *   phone never asks global what waits for a key unless the member ticked a door here. It keeps a mark from the first tick
 *   ({@link noteQuestionsOpened}), which stays after an Off or a Stop showing, since a request already sent is still theirs
 *   to answer. Sign Out wipes it (utils/identity.ts wipeIdentityScopedStorage).
 * - **So a door can be open with no row.** A door outlives the mark: after a new phone, a Sign Out, or a tick in the browser
 *   alone, this phone asks nothing and shows nothing until a door is ticked on it. What waits is on global's own Message
 *   requests, and market/posting.md tells the member so.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { audienceOf } from '@beanpool/core';
import { QUESTIONS_OPENED_STORE_KEY } from './storage-keys';
import { GLOBAL_NODE_URL } from './global-node-url';
import { signedGet } from './node-post';
import type { BeanPoolIdentity } from './identity';

const ASK_TIMEOUT_MS = 10_000;
/** A Chat tab that comes and goes asks at most this often. */
const ASK_EVERY_MS = 5 * 60 * 1000;

let asked: { key: string; at: number; count: number } | null = null;

/** The member has ticked a door on this phone. */
export async function noteQuestionsOpened(publicKey: string): Promise<void> {
    await AsyncStorage.setItem(QUESTIONS_OPENED_STORE_KEY, publicKey).catch(() => {});
}

/**
 * The tap on the row: the phone moves to global, as a tapped notice does, and its Message requests open there. `recheck` is the
 * root layout's recognition (app/NodeStatusContext.tsx), asked again before the bounce: the guard opens a screen only for the
 * community it knows the phone is on (member-landing.ts), and without this it still reads the one just left.
 */
export async function openGlobalRequests(publicKey: string | null | undefined, recheck: () => Promise<unknown>): Promise<void> {
    if (!publicKey) return;
    const { communitySwitchUnderWay, switchCommunity } = await import('./use-communities');
    const { openAfterLanding } = await import('./member-landing');
    if (communitySwitchUnderWay()) return;
    await switchCommunity(GLOBAL_NODE_URL, async () => {
        await recheck().catch(() => 'unknown');
        openAfterLanding('/(tabs)/chats?filter=requests', GLOBAL_NODE_URL, publicKey);
    }).catch((e) => console.warn('[Requests] Could not move to the global community', e));
}

/**
 * How many wait on global for this key. 0 on a phone that has opened no door, and on global itself, whose own list has them: and
 * whatever the member answers there changes the count, so the one kept here goes, or the row is still there when they get home.
 */
export async function requestsWaitingOnGlobal(identity: BeanPoolIdentity | null | undefined, now: number = Date.now()): Promise<number> {
    if (!identity?.privateKey) return 0;
    const anchor = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
    if (!anchor || audienceOf(anchor) === audienceOf(GLOBAL_NODE_URL)) {
        asked = null;
        return 0;
    }
    if ((await AsyncStorage.getItem(QUESTIONS_OPENED_STORE_KEY).catch(() => null)) !== identity.publicKey) return 0;
    if (asked?.key === identity.publicKey && now - asked.at < ASK_EVERY_MS) return asked.count;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
    try {
        const res = await signedGet(GLOBAL_NODE_URL, '/api/me/unread', identity, controller.signal);
        const answer: any = res.ok ? await res.json() : null;
        if (typeof answer?.requests !== 'number') return asked?.key === identity.publicKey ? asked.count : 0;
        asked = { key: identity.publicKey, at: now, count: answer.requests };
        return answer.requests;
    } catch {
        return asked?.key === identity.publicKey ? asked.count : 0;
    } finally {
        clearTimeout(timer);
    }
}
