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
 *
 * ## Who it is for is the node's word (#1454 review, finding 2)
 *
 * The join writes the record, but only on the phone it was made on. So the card asks the community itself
 * ({@link askOneWayBackStanding}, `GET /api/community/me`, signed by the account): `probation.rules: 'words'` is a member
 * who came in with 12 words and has added no sign-in, on any phone, as the web app reads it. {@link oneWayBackFromNode}
 * makes the record agree: started on a phone that restored the account, done once a sign-in was added anywhere. With no
 * word from the node (offline, an older node), the phone's own record decides, as before.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { oneWayBackStoreKey } from './storage-keys';
import { signedGet } from './node-post';
import { GLOBAL_NODE_URL } from './node-profile';
import type { BeanPoolIdentity } from './identity';

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

/** What the community says of this account: came in with 12 words and has no sign-in (`words`), and when it joined. */
export interface OneWayBackStanding {
    words: boolean;
    /** When it joined there, from the end of its new-account limits; null when the node doesn't say. */
    joinedAt: number | null;
}

/** How long the card waits for the node's word before the phone's own record decides. */
export const ONE_WAY_BACK_ASK_MS = 10_000;

/**
 * The community's word on this account (`GET /api/community/me`, signed by it, as the web app asks): null when there is
 * none (offline, no answer in time, not a member there, or an older node that doesn't say which rules).
 */
export async function askOneWayBackStanding(
    url: string, identity: BeanPoolIdentity, options: { timeoutMs?: number } = {},
): Promise<OneWayBackStanding | null> {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), options.timeoutMs ?? ONE_WAY_BACK_ASK_MS);
    try {
        const res = await signedGet(url, '/api/community/me', identity, stop.signal);
        if (!res.ok) return null;
        const p = ((await res.json().catch(() => null)) as { probation?: { rules?: unknown; ageEndsAt?: unknown; endsWhen?: { hours?: unknown } } } | null)?.probation;
        if (p?.rules !== 'words' && p?.rules !== 'ordinary') return null;
        const ends = typeof p.ageEndsAt === 'string' ? Date.parse(p.ageEndsAt) : NaN;
        const hours = typeof p.endsWhen?.hours === 'number' ? p.endsWhen.hours : NaN;
        const joinedAt = p.rules === 'words' && Number.isFinite(ends) && Number.isFinite(hours) ? ends - hours * 60 * 60 * 1000 : null;
        return { words: p.rules === 'words', joinedAt };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The record, made to agree with the node's word, and kept: started when the node says 12 words and this phone has none
 * (the account restored here), opened again when the phone thought a sign-in was added and the node says not, and done
 * when the node says the account has a sign-in (added anywhere). "I still have my 12 words" stays the member's own. No
 * word: the record as it is.
 */
export async function oneWayBackFromNode(
    publicKey: string, url: string, standing: OneWayBackStanding | null, now: number = Date.now(),
): Promise<OneWayBack | null> {
    const record = await readOneWayBack(publicKey);
    if (!standing) return record;
    if (!standing.words) {
        if (!record) return null;
        if (record.done) return record;
        const done: OneWayBack = { ...record, done: 'linked' };
        await write(publicKey, done);
        return done;
    }
    if (!record) {
        const started: OneWayBack = { url, joinedAt: standing.joinedAt ?? now };
        await write(publicKey, started);
        return started;
    }
    if (record.done === 'linked') {
        const reopened: OneWayBack = { ...record };
        delete reopened.done;
        await write(publicKey, reopened);
        return reopened;
    }
    return record;
}

/**
 * Where to ask: the community the record is about, or the global community when it is the one this phone is using (an
 * account restored there). Nowhere else: a phone in another community never asks global about itself.
 */
export function oneWayBackCommunity(record: OneWayBack | null | undefined, inUse: string | null | undefined): string | null {
    if (record?.url) return record.url;
    const using = inUse ? inUse.trim().replace(/\/+$/, '').toLowerCase() : '';
    return using === GLOBAL_NODE_URL ? GLOBAL_NODE_URL : null;
}
