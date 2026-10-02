/**
 * Home's one request and what the phone keeps of it (scratch/global-node/DESIGN-home-dashboard-fable.md §4.2, §5; slice
 * H2). The rules of what to draw are utils/home-cards.ts; this file reads, keeps and saves.
 *
 * - **One signed read for the whole screen**, `GET /api/home?cards=…` (apps/server routes/home.ts), sent with the
 *   `If-None-Match` of the answer the phone keeps, so a repeat read is a 304 with no body. The address names the cards in
 *   the catalogue's order and nothing that changes between reads (no point: the node uses the member's own area), so the
 *   same layout asks the same address and the node can confirm the copy.
 * - **The last answer is kept** per account and community (storage-keys.ts `homeAnswerStoreKey`) and drawn at once on
 *   the next landing, before the network answers (§5.2 "Offline / 2G"). Nothing on Home waits on the network.
 * - **Overlapping reads are one read**: a focus, a doorbell and a pull that meet share the read already out.
 * - **The header reads Home's answer** (§5.2): while one is fresher than two minutes, components/NeedsYouIcons.tsx draws
 *   the node's lines from it instead of asking the node itself, and on Home it waits a moment for the read under way.
 * - **The layout and the interests are the account's** (H1, `POST /api/members/preferences`), with a copy on the phone;
 *   the newer layout wins by `updatedAt`, and a save that couldn't land is sent again at the next landing.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { signedGet, signedPost } from './node-post';
import type { BeanPoolIdentity } from './identity';
import { homeAnswerStoreKey, homeInterestsOwedStoreKey, homeLayoutStoreKey } from './storage-keys';
import {
    HOME_FRESH_FOR_HEADER_MS, readHomeAnswer, readHomeLayout,
    type HomeAnswer, type HomeCardId, type HomeLayout,
} from './home-cards';

/** How long the node has to answer before Home keeps what it had. */
export const HOME_READ_TIMEOUT_MS = 15_000;
/** How long the header waits for a read under way on Home before it asks the node itself. */
export const HOME_HEADER_WAIT_MS = 3_000;
/** The Market's For You stars (app/(tabs)/market.tsx), the phone's copy of the account's interests (§4.3). */
export const FAV_CATEGORIES_STORE_KEY = 'bp_fav_categories';

const norm = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();

/** What the phone keeps of one answer. */
export interface StoredHome {
    url: string;
    publicKey: string;
    /** The cards asked for, as sent: an answer for another list is no copy of this one. */
    asked: string;
    etag: string | null;
    answer: HomeAnswer;
    /** When the node last gave or confirmed it (the phone's clock). */
    at: number;
}

export function homePath(asked: readonly HomeCardId[]): string {
    return `/api/home?cards=${asked.join(',')}`;
}

export async function readStoredHome(publicKey: string, url: string): Promise<StoredHome | null> {
    try {
        const raw = await AsyncStorage.getItem(homeAnswerStoreKey(publicKey, url));
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || parsed.publicKey !== publicKey || typeof parsed.url !== 'string' || norm(parsed.url) !== norm(url)) return null;
        const answer = readHomeAnswer(parsed.answer);
        if (!answer || typeof parsed.asked !== 'string' || typeof parsed.at !== 'number') return null;
        return { url: parsed.url, publicKey, asked: parsed.asked, etag: typeof parsed.etag === 'string' ? parsed.etag : null, answer, at: parsed.at };
    } catch {
        return null;
    }
}

async function keep(stored: StoredHome): Promise<void> {
    try {
        await AsyncStorage.setItem(homeAnswerStoreKey(stored.publicKey, stored.url), JSON.stringify(stored));
    } catch {
        // Not kept: the next landing reads the node again. Never a gate.
    }
}

export type HomeRead =
    /** A 200, or a 304 that confirmed the copy (then `stored` is the copy, its time renewed). */
    | { kind: 'answer'; stored: StoredHome; confirmed: boolean }
    /** 401 or 403: this key is no member here (a guest, or an account the community removed). */
    | { kind: 'members_only' }
    /** No answer, a server error, or a body that isn't one: Home keeps what it had. */
    | { kind: 'failed' };

/**
 * One read of Home. `cached` is sent as `If-None-Match` only when it answers the same cards; a 304 then confirms it.
 */
export async function readHomeFromNode(
    url: string, identity: BeanPoolIdentity, asked: readonly HomeCardId[], cached: StoredHome | null,
    options: { timeoutMs?: number; now?: () => number } = {},
): Promise<HomeRead> {
    const now = options.now ?? Date.now;
    const askedKey = asked.join(',');
    const copy = cached && cached.publicKey === identity.publicKey && norm(cached.url) === norm(url) && cached.asked === askedKey ? cached : null;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), options.timeoutMs ?? HOME_READ_TIMEOUT_MS);
    try {
        const res = await signedGet(url, homePath(asked), identity, stop.signal, copy?.etag ? { 'If-None-Match': copy.etag } : undefined);
        if (res.status === 304) {
            if (!copy) return { kind: 'failed' };
            const stored = { ...copy, at: now() };
            await keep(stored);
            return { kind: 'answer', stored, confirmed: true };
        }
        if (res.status === 401 || res.status === 403) return { kind: 'members_only' };
        if (!res.ok) return { kind: 'failed' };
        const answer = readHomeAnswer(await res.json().catch(() => null));
        if (!answer) return { kind: 'failed' };
        const stored: StoredHome = { url, publicKey: identity.publicKey, asked: askedKey, etag: res.headers.get('ETag'), answer, at: now() };
        await keep(stored);
        return { kind: 'answer', stored, confirmed: false };
    } catch {
        return { kind: 'failed' };
    } finally {
        clearTimeout(timer);
    }
}

// ── One read at a time, and the answer the header reads ─────────────────────────────────────────────────────────

let latest: StoredHome | null = null;
let inflight: { key: string; url: string; publicKey: string; promise: Promise<HomeRead> } | null = null;
const settledListeners = new Set<(read: HomeRead, url: string, publicKey: string) => void>();

/**
 * Home's read, shared: a second call while one for the same account, community and cards is out gets that one's
 * promise, so a focus, a doorbell and a pull that meet cost one request.
 */
export function loadHome(
    url: string, identity: BeanPoolIdentity, asked: readonly HomeCardId[], cached: StoredHome | null,
    options: { timeoutMs?: number; now?: () => number } = {},
): Promise<HomeRead> {
    const key = `${identity.publicKey}|${norm(url)}|${asked.join(',')}`;
    if (inflight?.key === key) return inflight.promise;
    const promise = readHomeFromNode(url, identity, asked, cached, options).then(read => {
        if (inflight?.promise === promise) inflight = null;
        if (read.kind === 'answer') latest = read.stored;
        settledListeners.forEach(l => l(read, url, identity.publicKey));
        return read;
    });
    inflight = { key, url, publicKey: identity.publicKey, promise };
    return promise;
}

/** Home's answer for the header, while it is fresher than {@link HOME_FRESH_FOR_HEADER_MS} and asked for `needs`. */
export function freshHomeForHeader(url: string | null, publicKey: string | null | undefined, now: number = Date.now()): StoredHome | null {
    if (!latest || !url || !publicKey || latest.publicKey !== publicKey || norm(latest.url) !== norm(url)) return null;
    if (!latest.asked.split(',').includes('needs')) return null;
    return now - latest.at >= 0 && now - latest.at < HOME_FRESH_FOR_HEADER_MS ? latest : null;
}

/**
 * Home's answer for the header: a fresh one at once; else, when `waitMs` is given (the header on Home, whose read is
 * starting or under way), the next read's answer within that long; else null, and the header asks the node itself.
 * A read that fails ends the wait at once.
 */
export function homeForHeader(url: string | null, publicKey: string | null | undefined, waitMs: number): Promise<StoredHome | null> {
    const fresh = freshHomeForHeader(url, publicKey);
    if (fresh || !url || !publicKey) return Promise.resolve(fresh);
    const waiting = inflight && inflight.publicKey === publicKey && norm(inflight.url) === norm(url);
    if (!waiting && waitMs <= 0) return Promise.resolve(null);
    return new Promise(resolve => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            settledListeners.delete(listener);
            resolve(freshHomeForHeader(url, publicKey));
        };
        const listener = (_read: HomeRead, u: string, pk: string) => { if (pk === publicKey && norm(u) === norm(url)) finish(); };
        const timer = setTimeout(finish, Math.max(waitMs, waiting ? HOME_HEADER_WAIT_MS : 0));
        settledListeners.add(listener);
    });
}

/** Each read as it settles (the header redraws from a new answer). Returns the unsubscribe. */
export function onHomeRead(listener: (read: HomeRead, url: string, publicKey: string) => void): () => void {
    settledListeners.add(listener);
    return () => { settledListeners.delete(listener); };
}

/** For the tests: forget the shared read and the latest answer. */
export function resetHomeStoreForTests(): void {
    latest = null;
    inflight = null;
    settledListeners.clear();
}

// ── The layout ────────────────────────────────────────────────────────────────────────────────────────────────────

export async function readPhoneLayout(publicKey: string, url: string): Promise<HomeLayout | null> {
    try {
        const raw = await AsyncStorage.getItem(homeLayoutStoreKey(publicKey, url));
        return raw ? readHomeLayout(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

export async function writePhoneLayout(publicKey: string, url: string, layout: HomeLayout): Promise<void> {
    try {
        await AsyncStorage.setItem(homeLayoutStoreKey(publicKey, url), JSON.stringify(layout));
    } catch {
        // Not kept on the phone: the account's copy still has it once the save lands.
    }
}

/** What the node kept of a save (its answer names each Home key the body named), or null when it didn't take it. */
export interface SavedPreferences { layout?: HomeLayout | null; interests?: string[] }

/**
 * Save the layout and/or the interests to the account (`POST /api/members/preferences`, signed, own write only). The
 * node drops unknown ids and keeps the newer layout; its answer says what it kept. Null when the save didn't land.
 */
export async function saveHomePreferences(
    url: string, identity: BeanPoolIdentity, prefs: { layout?: HomeLayout; interests?: readonly string[] },
): Promise<SavedPreferences | null> {
    const preferences: Record<string, unknown> = {};
    if (prefs.layout) {
        const { updatedAt, ...rest } = prefs.layout;
        preferences['home.layout'] = updatedAt ? { ...rest, updatedAt } : rest;
    }
    if (prefs.interests) preferences.interests = [...prefs.interests];
    if (!Object.keys(preferences).length) return {};
    try {
        const res = await signedPost(url, '/api/members/preferences', { publicKey: identity.publicKey, preferences }, identity);
        if (!res.ok) return null;
        const body = await res.json().catch(() => null) as Record<string, unknown> | null;
        const out: SavedPreferences = {};
        if (prefs.layout) out.layout = readHomeLayout(body?.['home.layout']);
        if (prefs.interests) out.interests = Array.isArray(body?.interests) ? (body!.interests as unknown[]).filter((c): c is string => typeof c === 'string') : [...prefs.interests];
        return out;
    } catch {
        return null;
    }
}

// ── The interests ─────────────────────────────────────────────────────────────────────────────────────────────────

export async function readPhoneInterests(): Promise<string[]> {
    try {
        const raw = await AsyncStorage.getItem(FAV_CATEGORIES_STORE_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string') : [];
    } catch {
        return [];
    }
}

export async function writePhoneInterests(list: readonly string[]): Promise<void> {
    try {
        await AsyncStorage.setItem(FAV_CATEGORIES_STORE_KEY, JSON.stringify(list));
    } catch {
        // The account's copy still has them once the save lands.
    }
}

/** 'owed': the phone changed them and the save hasn't landed. 'synced': the two agreed once. Absent: never compared. */
type InterestsState = 'owed' | 'synced';

async function interestsState(publicKey: string, url: string): Promise<InterestsState | null> {
    try {
        const v = await AsyncStorage.getItem(homeInterestsOwedStoreKey(publicKey, url));
        return v === 'owed' || v === 'synced' ? v : null;
    } catch {
        return null;
    }
}

async function setInterestsState(publicKey: string, url: string, state: InterestsState): Promise<void> {
    try {
        await AsyncStorage.setItem(homeInterestsOwedStoreKey(publicKey, url), state);
    } catch {
        // Asked again at the next landing.
    }
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((c, i) => c === b[i]);

/**
 * The member starred or unstarred a category (the interests card, the Market's "Tune" or its For You panel): the
 * phone's copy at once, then the account's (§4.3: one truth, and For You keeps working offline). A save that doesn't
 * land is owed, and sent at the next landing.
 */
export async function saveInterests(url: string | null, identity: BeanPoolIdentity | null | undefined, list: readonly string[]): Promise<boolean> {
    await writePhoneInterests(list);
    if (!url || !identity) return false;
    await setInterestsState(identity.publicKey, url, 'owed');
    const saved = await saveHomePreferences(url, identity, { interests: list });
    if (!saved) return false;
    await setInterestsState(identity.publicKey, url, 'synced');
    return true;
}

/**
 * At a landing, the account's interests (from the answer's `me`) and the phone's made one: an owed save is sent; the
 * stars a member made in the Market before Home existed are sent once to an account that has none; otherwise the
 * account's win and the phone's copy follows. Returns the list Home draws with.
 */
export async function reconcileInterests(url: string, identity: BeanPoolIdentity, account: readonly string[]): Promise<string[]> {
    const phone = await readPhoneInterests();
    const state = await interestsState(identity.publicKey, url);
    const push = state === 'owed' || (state === null && account.length === 0 && phone.length > 0);
    if (push) {
        const saved = await saveHomePreferences(url, identity, { interests: phone });
        if (saved) await setInterestsState(identity.publicKey, url, 'synced');
        return phone;
    }
    if (!sameList(account, phone)) await writePhoneInterests(account);
    if (state !== 'synced') await setInterestsState(identity.publicKey, url, 'synced');
    return [...account];
}
