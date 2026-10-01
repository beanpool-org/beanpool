/**
 * "Your account has one way back" (two-doors design §2.5): a member who joined the global community with 12 words has
 * ONE way back, the 12 words, and no copy anywhere else. The app says so plainly, and never as a gate (memory
 * `onboarding-no-hard-gates`):
 *
 * - A plain card on the landing screen and in Settings until one of two things is done: the member says they checked
 *   they still have their 12 words, or they add a sign-in (utils/join-link.ts).
 * - Dismissible. It comes back once after their first post and once after a week, then stays in Settings only.
 *
 * Kept on the phone per account ({@link oneWayBackStoreKey}): times and two flags, nothing secret. Kept when the account
 * leaves the phone, as its block list is: the same account restored here carries on where it was.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { oneWayBackStoreKey } from './storage-keys';

export const ONE_WAY_BACK_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const ONE_WAY_BACK_TEXT = {
    title: 'Your account has one way back',
    body: 'Your account has one way back: your 12 words. Check you still have them, or add a sign-in.',
    addSignIn: 'Add a sign-in',
    checkWords: 'Show my 12 words',
    checked: 'I still have my 12 words',
    notNow: 'Not now',
} as const;

export interface OneWayBack {
    /** The community this is about (the global community, the one the member joined with 12 words). */
    url: string;
    /** When the 12-words join landed (the phone's clock). */
    joinedAt: number;
    /** Done, and never shown again: a sign-in was added, or the member said they still have their 12 words. */
    done?: 'linked' | 'checked';
    /** The last time the card was put away. */
    dismissedAt?: number;
    /** The return after the member's first post has been seen. */
    postReturnUsed?: boolean;
    /** The return after a week has been seen. */
    weekReturnUsed?: boolean;
}

/** Where it shows now: the landing screen's card (and Settings), Settings only, or nowhere. */
export type OneWayBackPlace = 'card' | 'settings' | 'none';

/** Whether a return is waiting: after the first post, and after a week, each once. */
function returnsWaiting(record: OneWayBack, now: number, hasPosted: boolean): { post: boolean; week: boolean } {
    return {
        post: hasPosted && !record.postReturnUsed,
        week: now >= record.joinedAt + ONE_WAY_BACK_WEEK_MS && !record.weekReturnUsed,
    };
}

export function oneWayBackPlace(record: OneWayBack | null | undefined, now: number, hasPosted: boolean): OneWayBackPlace {
    if (!record || record.done) return 'none';
    if (record.dismissedAt === undefined) return 'card';
    const waiting = returnsWaiting(record, now, hasPosted);
    return waiting.post || waiting.week ? 'card' : 'settings';
}

/**
 * Put the card away. A return that is waiting is used by this: the card was up after the first post (or the week), so
 * it has come back for it. Two waiting at once are both used: it comes back once for them.
 */
export function dismissedOneWayBack(record: OneWayBack, now: number, hasPosted: boolean): OneWayBack {
    const waiting = returnsWaiting(record, now, hasPosted);
    return {
        ...record,
        dismissedAt: now,
        ...(waiting.post ? { postReturnUsed: true } : {}),
        ...(waiting.week ? { weekReturnUsed: true } : {}),
    };
}

export async function readOneWayBack(publicKey: string | null | undefined): Promise<OneWayBack | null> {
    if (!publicKey) return null;
    try {
        const raw = await AsyncStorage.getItem(oneWayBackStoreKey(publicKey));
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object' || typeof parsed.joinedAt !== 'number' || typeof parsed.url !== 'string') return null;
        return parsed as OneWayBack;
    } catch {
        return null;
    }
}

async function write(publicKey: string, record: OneWayBack): Promise<void> {
    try {
        await AsyncStorage.setItem(oneWayBackStoreKey(publicKey), JSON.stringify(record));
    } catch {
        // Not written: the card shows as it did. It never gates anything.
    }
}

/** A 12-words join landed for this account at `url`: the card starts. One that is done or already running is kept. */
export async function startOneWayBack(publicKey: string, url: string, now: number = Date.now()): Promise<void> {
    if (await readOneWayBack(publicKey)) return;
    await write(publicKey, { url, joinedAt: now });
}

/** The card was put away (it comes back as {@link oneWayBackPlace} says). */
export async function dismissOneWayBack(publicKey: string, hasPosted: boolean, now: number = Date.now()): Promise<void> {
    const record = await readOneWayBack(publicKey);
    if (record && !record.done) await write(publicKey, dismissedOneWayBack(record, now, hasPosted));
}

/** One of the two was done: a sign-in was added, or the member checked their 12 words. Never shown again. */
export async function finishOneWayBack(publicKey: string, how: 'linked' | 'checked'): Promise<void> {
    const record = await readOneWayBack(publicKey);
    if (record && !record.done) await write(publicKey, { ...record, done: how });
}
