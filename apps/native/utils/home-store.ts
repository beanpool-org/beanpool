/**
 * Home's one request and what the phone keeps of it (scratch/global-node/DESIGN-home-dashboard-fable.md §4.2, §5; slice
 * H2). The rules of what to draw are utils/home-cards.ts; this file reads, keeps and saves.
 *
 * - **One signed read for the whole screen**, `GET /api/home?cards=…` (apps/server routes/home.ts), sent with the
 *   `If-None-Match` of the answer the phone keeps, so a repeat read is a 304 with no body. The address names the cards in
 *   the catalogue's order and, on the global node only, the phone's place to about a kilometre (H4: Find your community
 *   and "Near you" are measured from it, as the Market's card was; a local community gets no point and uses the member's
 *   own area), so the same layout in the same place asks the same address and the node can confirm the copy.
 * - **The last answer is kept** per account and community (storage-keys.ts `homeAnswerStoreKey`) and drawn at once on
 *   the next landing, before the network answers (§5.2 "Offline / 2G"). Nothing on Home waits on the network.
 * - **Overlapping reads are one read**: a focus, a doorbell and a pull that meet share the read already out.
 * - **The header reads Home's answer** (§5.2): while one is fresher than two minutes, components/NeedsYouIcons.tsx draws
 *   the node's lines from it instead of asking the node itself, and on Home it waits a moment for the read under way.
 * - **The layout and the interests are the account's** (H1, `POST /api/members/preferences`), with a copy on the phone;
 *   the newer layout wins by `updatedAt`, and a save that couldn't land is sent again at the next landing. A save the
 *   node refuses (it keeps a Home only for its members) is never sent again by itself: the account's copy stands.
 * - **Interests saves go one at a time, and only the latest counts** (PR #1483 review 4165383880): a star tapped while an
 *   earlier save is out waits for it, a save overtaken by a newer star is never sent, and a save that lands after a
 *   newer star was tapped leaves the newer one owed. The mirror case (review 4166559374): an answer asked while a save was
 *   waiting or out, or before one was begun, may be older than a save the node has taken since, so it never overwrites
 *   the phone's stars; the next landing agrees. That is judged by when the read was sent, and the answer carries it: a
 *   landing that joins a read already out goes by that read's moment, not its own (review 4168250992).
 * - **Nothing is written for an account that has left the phone** (review 4166559191): every read and save takes the
 *   account it is for as it begins (home-account.ts), and each write here (the answer, the layout, the stars, the owed
 *   save, the reveal and hint) is made only while that account is still the one on the phone. Sign Out and Replace wipe
 *   what Home kept; a read or save still out then writes none of it back, and a save waiting its turn is never sent.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { readTipsRecord, type TipsRecord } from '@beanpool/core';
import { signedGet, signedPost } from './node-post';
import type { BeanPoolIdentity } from './identity';
import { homeAccount, homeGeneration, onHomeAccountChange, resetHomeAccountForTests, stillOnPhone, type HomeAccount } from './home-account';
import {
    FAV_CATEGORIES_STORE_KEY, homeAnswerStoreKey, homeFewerStoreKey, homeHintStoreKey, homeTipsStoreKey, homeInterestsOwedStoreKey, homeLayoutStoreKey, homeRevealStoreKey,
} from './storage-keys';
import {
    HOME_FRESH_FOR_HEADER_MS, readHomeAnswer, readHomeLayout,
    type HomeAnswer, type HomeCardId, type HomeLayout,
} from './home-cards';

/** How long the node has to answer before Home keeps what it had. */
export const HOME_READ_TIMEOUT_MS = 15_000;
/** How long the header waits for a read under way on Home before it asks the node itself. */
export const HOME_HEADER_WAIT_MS = 3_000;
/** How long a save of the layout or the interests has before it counts as not landed (owed, sent again later). */
export const HOME_SAVE_TIMEOUT_MS = 15_000;
/** The Market's For You stars (app/(tabs)/market.tsx), the phone's copy of the account's interests (§4.3). */
export { FAV_CATEGORIES_STORE_KEY };

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

/** A point Home is measured from: the phone's last known place, on the global node only (H4; see {@link coarseHomePoint}). */
export interface HomePoint { lat: number; lng: number }

/**
 * The phone's place as Home sends it: two decimals (about a kilometre), so the address stays the same while the phone
 * moves about a street and a repeat read can still be a 304, and the node learns no more than the Market's own "near
 * you" read tells it. Null for anything that isn't a place.
 */
export function coarseHomePoint(point: HomePoint | null | undefined): HomePoint | null {
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180) return null;
    const two = (n: number) => Math.round(n * 100) / 100;
    return { lat: two(point.lat), lng: two(point.lng) };
}

/**
 * The address: the cards in the catalogue's order and, on the global node, the coarse point "near you" is measured from
 * (GET /api/home's `lat`/`lng`; without one the node uses the member's own area). The signature covers the path only.
 */
export function homePath(asked: readonly HomeCardId[], point?: HomePoint | null): string {
    const p = coarseHomePoint(point);
    return `/api/home?cards=${asked.join(',')}${p ? `&lat=${p.lat.toFixed(2)}&lng=${p.lng.toFixed(2)}` : ''}`;
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

async function keep(stored: StoredHome, whose: HomeAccount): Promise<void> {
    if (!stillOnPhone(whose)) return;
    try {
        await AsyncStorage.setItem(homeAnswerStoreKey(stored.publicKey, stored.url), JSON.stringify(stored));
    } catch {
        // Not kept: the next landing reads the node again. Never a gate.
    }
}

export type HomeRead =
    /**
     * A 200, or a 304 that confirmed the copy (then `stored` is the copy, its time renewed). `since`: where the interests
     * stood as this read was sent ({@link interestsTurnNow}); every landing that gets this answer, the one that sent the
     * read or one that joined it, judges the answer's interests by it (review 4168250992).
     */
    | { kind: 'answer'; stored: StoredHome; confirmed: boolean; since: InterestsTurn }
    /** 401 or 403: this key is no member here (a guest, or an account the community removed). */
    | { kind: 'members_only' }
    /** 404: route missing; this community's server is older than GET /api/home and needs an update. */
    | { kind: 'needs_update' }
    /** No answer, a server error, or a body that isn't one: Home keeps what it had. */
    | { kind: 'failed' }
    /** The account it was asked for left the phone while it was out: nothing kept, nothing to draw. */
    | { kind: 'left' };

/**
 * One read of Home. `cached` is sent as `If-None-Match` only when it answers the same cards; a 304 then confirms it.
 * `whose`: the account it is for, as the landing began (by default, as this read begins); kept only while it is still on
 * the phone.
 */
export async function readHomeFromNode(
    url: string, identity: BeanPoolIdentity, asked: readonly HomeCardId[], cached: StoredHome | null,
    options: { timeoutMs?: number; now?: () => number; whose?: HomeAccount; point?: HomePoint | null } = {},
): Promise<HomeRead> {
    const now = options.now ?? Date.now;
    const whose = options.whose ?? homeAccount(identity.publicKey);
    // Taken as the read is sent: the node builds its answer after this, so a save begun or out now may land before it.
    const since = interestsTurnNow();
    const askedKey = asked.join(',');
    const copy = cached && cached.publicKey === identity.publicKey && norm(cached.url) === norm(url) && cached.asked === askedKey ? cached : null;
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), options.timeoutMs ?? HOME_READ_TIMEOUT_MS);
    try {
        // The copy's tag is sent whatever point it was read at: the tag is the answer's own (routes/home.ts), so the node
        // confirms the copy only while it is still the whole answer for this point too.
        const res = await signedGet(url, homePath(asked, options.point), identity, stop.signal, copy?.etag ? { 'If-None-Match': copy.etag } : undefined);
        if (res.status === 304) {
            if (!copy) return { kind: 'failed' };
            if (!stillOnPhone(whose)) return { kind: 'left' };
            const stored = { ...copy, at: now() };
            await keep(stored, whose);
            return { kind: 'answer', stored, confirmed: true, since };
        }
        if (res.status === 401 || res.status === 403) return { kind: 'members_only' };
        if (res.status === 404) return { kind: 'needs_update' };
        if (!res.ok) return { kind: 'failed' };
        const answer = readHomeAnswer(await res.json().catch(() => null));
        if (!answer) return { kind: 'failed' };
        if (!stillOnPhone(whose)) return { kind: 'left' };
        const stored: StoredHome = { url, publicKey: identity.publicKey, asked: askedKey, etag: res.headers.get('ETag'), answer, at: now() };
        await keep(stored, whose);
        return { kind: 'answer', stored, confirmed: false, since };
    } catch {
        return { kind: 'failed' };
    } finally {
        clearTimeout(timer);
    }
}

// ── One read at a time, and the answer the header reads ─────────────────────────────────────────────────────────

let latest: { stored: StoredHome; whose: HomeAccount } | null = null;
let inflight: { key: string; url: string; publicKey: string; promise: Promise<HomeRead> } | null = null;
const settledListeners = new Set<(read: HomeRead, url: string, publicKey: string) => void>();

// The account left or changed: what is held in memory for it goes (a read still out lands as 'left').
onHomeAccountChange(() => {
    latest = null;
    inflight = null;
});

/**
 * Home's read, shared: a second call while one for the same account, community and cards is out gets that one's
 * promise, so a focus, a doorbell and a pull that meet cost one request. The answer carries the mark of the read that
 * was sent (`since`), never the second call's: a star saved while that read was out is newer than its answer.
 */
export function loadHome(
    url: string, identity: BeanPoolIdentity, asked: readonly HomeCardId[], cached: StoredHome | null,
    options: { timeoutMs?: number; now?: () => number; whose?: HomeAccount; point?: HomePoint | null } = {},
): Promise<HomeRead> {
    const whose = options.whose ?? homeAccount(identity.publicKey);
    const key = `${identity.publicKey}|${whose.generation}|${norm(url)}|${homePath(asked, options.point)}`;
    if (inflight?.key === key) return inflight.promise;
    const promise = readHomeFromNode(url, identity, asked, cached, { ...options, whose }).then((answered): HomeRead => {
        const read: HomeRead = answered.kind === 'answer' && !stillOnPhone(whose) ? { kind: 'left' } : answered;
        if (inflight?.promise === promise) inflight = null;
        if (read.kind === 'answer') latest = { stored: read.stored, whose };
        settledListeners.forEach(l => l(read, url, identity.publicKey));
        return read;
    });
    inflight = { key, url, publicKey: identity.publicKey, promise };
    return promise;
}

/** Home's answer for the header, while it is fresher than {@link HOME_FRESH_FOR_HEADER_MS} and asked for `needs`. */
export function freshHomeForHeader(url: string | null, publicKey: string | null | undefined, now: number = Date.now()): StoredHome | null {
    const kept = latest && stillOnPhone(latest.whose) ? latest.stored : null;
    if (!kept || !url || !publicKey || kept.publicKey !== publicKey || norm(kept.url) !== norm(url)) return null;
    if (!kept.asked.split(',').includes('needs')) return null;
    return now - kept.at >= 0 && now - kept.at < HOME_FRESH_FOR_HEADER_MS ? kept : null;
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

/** For the tests: forget the shared read, the latest answer, any interests save under way, and whose Home it was. */
export function resetHomeStoreForTests(): void {
    resetHomeAccountForTests();
    latest = null;
    inflight = null;
    settledListeners.clear();
    interestsTurn = 0;
    interestsSaves = 0;
    interestsSaving = 0;
    interestsQueue = Promise.resolve();
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

/** The phone's copy of the layout, for `whose` (by default the account as of now) while it is still on the phone. */
export async function writePhoneLayout(publicKey: string, url: string, layout: HomeLayout, whose: HomeAccount = homeAccount(publicKey)): Promise<void> {
    if (whose.publicKey !== publicKey || !stillOnPhone(whose)) return;
    try {
        await AsyncStorage.setItem(homeLayoutStoreKey(publicKey, url), JSON.stringify(layout));
    } catch {
        // Not kept on the phone: the account's copy still has it once the save lands.
    }
}

/**
 * The phone's copy of the layout made the account's again (null: none): after the node refused the phone's, so the
 * phone's is no longer newer and is never sent again by itself. Only while `whose` is still on the phone.
 */
export async function yieldPhoneLayout(
    publicKey: string, url: string, account: HomeLayout | null, whose: HomeAccount = homeAccount(publicKey),
): Promise<void> {
    if (whose.publicKey !== publicKey || !stillOnPhone(whose)) return;
    try {
        if (account) await AsyncStorage.setItem(homeLayoutStoreKey(publicKey, url), JSON.stringify(account));
        else await AsyncStorage.removeItem(homeLayoutStoreKey(publicKey, url));
    } catch {
        // Asked again at the next landing.
    }
}

/** What the node kept of a save (its answer names each Home key the body named). */
export interface SavedPreferences { layout?: HomeLayout | null; interests?: string[] }

/**
 * The node answered and won't take the save: a refusal (400, 401, 403, …; the node keeps a Home only for its members,
 * home-preferences.ts). Sending it again changes nothing, so it isn't. A save that didn't land (no answer, 408, 429, a
 * server error) is null instead, and is sent again later.
 */
export const SAVE_REFUSED = 'refused' as const;
/**
 * The node refused the layout's shape (a 400 to a save that named one): a node from before the frame takes only version
 * 1 (CARD-FRAME §2.3). The screen tells it apart from a members-only refusal: the member's cards stay on the phone, "not
 * on your account yet", and are sent again at each landing.
 */
export const SAVE_SHAPE_REFUSED = 'shape-refused' as const;

const refusal = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429;

/**
 * Save the layout and/or the interests to the account (`POST /api/members/preferences`, signed, own write only). The
 * node keeps the list as sent (shape and bounds only) and the newer layout; its answer says what it kept. {@link SAVE_REFUSED} when it won't
 * take it, null when the save didn't land.
 */
export async function saveHomePreferences(
    url: string, identity: BeanPoolIdentity, prefs: { layout?: HomeLayout; interests?: readonly string[] },
    options: { timeoutMs?: number } = {},
): Promise<SavedPreferences | typeof SAVE_REFUSED | typeof SAVE_SHAPE_REFUSED | null> {
    const preferences: Record<string, unknown> = {};
    if (prefs.layout) {
        const { updatedAt, ...rest } = prefs.layout;
        preferences['home.layout'] = updatedAt ? { ...rest, updatedAt } : rest;
    }
    if (prefs.interests) preferences.interests = [...prefs.interests];
    if (!Object.keys(preferences).length) return {};
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), options.timeoutMs ?? HOME_SAVE_TIMEOUT_MS);
    try {
        const res = await signedPost(url, '/api/members/preferences', { publicKey: identity.publicKey, preferences }, identity, stop.signal);
        if (res.status === 400 && prefs.layout) return SAVE_SHAPE_REFUSED;
        if (refusal(res.status)) return SAVE_REFUSED;
        if (!res.ok) return null;
        const body = await res.json().catch(() => null) as Record<string, unknown> | null;
        const out: SavedPreferences = {};
        if (prefs.layout) out.layout = readHomeLayout(body?.['home.layout']);
        if (prefs.interests) out.interests = Array.isArray(body?.interests) ? (body!.interests as unknown[]).filter((c): c is string => typeof c === 'string') : [...prefs.interests];
        return out;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ── The one-time reveal and its hint (§6.2) ───────────────────────────────────────────────────────────────────────

export type HomeOnce = 'reveal' | 'hint' | 'fewer';
const onceKey = (which: HomeOnce, publicKey: string) => (
    which === 'reveal' ? homeRevealStoreKey(publicKey) : which === 'fewer' ? homeFewerStoreKey(publicKey) : homeHintStoreKey(publicKey)
);

/** Whether the account has seen the reveal or the hint here. A phone that can't say counts as seen: never shown twice. */
export async function seenOnce(publicKey: string, which: HomeOnce): Promise<boolean> {
    try {
        return !!(await AsyncStorage.getItem(onceKey(which, publicKey)));
    } catch {
        return true;
    }
}

/** The reveal or the hint seen, for `whose` while it is still on the phone. */
export async function markSeenOnce(whose: HomeAccount, which: HomeOnce): Promise<void> {
    if (!stillOnPhone(whose)) return;
    try {
        await AsyncStorage.setItem(onceKey(which, whose.publicKey), '1');
    } catch {
        // Shown once more at the next landing at most.
    }
}

// ── The Tips card's record ─────────────────────────────────────────────────────────────────────────────────────────

/** The account's Tips record here (@beanpool/core `readTipsRecord`: anything unreadable is a fresh one). */
export async function readTips(publicKey: string): Promise<TipsRecord> {
    try {
        const raw = await AsyncStorage.getItem(homeTipsStoreKey(publicKey));
        return readTipsRecord(raw ? JSON.parse(raw) : null);
    } catch {
        return readTipsRecord(null);
    }
}

/** The Tips record kept, for `whose` while it is still on the phone (a write that fails shows a tip once more, at most). */
export async function writeTips(whose: HomeAccount, record: TipsRecord): Promise<void> {
    if (!stillOnPhone(whose)) return;
    try {
        await AsyncStorage.setItem(homeTipsStoreKey(whose.publicKey), JSON.stringify(record));
    } catch {
        // Kept in memory for this visit; the next landing reads the last one written.
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

/** The phone's copy of the stars; for `whose`, only while that account is still on the phone (none: a phone with no account). */
export async function writePhoneInterests(list: readonly string[], whose?: HomeAccount | null): Promise<void> {
    if (whose && !stillOnPhone(whose)) return;
    try {
        await AsyncStorage.setItem(FAV_CATEGORIES_STORE_KEY, JSON.stringify(list));
    } catch {
        // The account's copy still has them once the save lands.
    }
}

/**
 * 'owed': the phone changed them and the save hasn't landed. 'synced': the two agreed once, or the node refused the
 * phone's list (then the account's stands). Absent: never compared.
 */
type InterestsState = 'owed' | 'synced';

async function interestsState(publicKey: string, url: string): Promise<InterestsState | null> {
    try {
        const v = await AsyncStorage.getItem(homeInterestsOwedStoreKey(publicKey, url));
        return v === 'owed' || v === 'synced' ? v : null;
    } catch {
        return null;
    }
}

async function setInterestsState(publicKey: string, url: string, state: InterestsState | null, whose: HomeAccount): Promise<void> {
    if (!stillOnPhone(whose)) return;
    try {
        if (state) await AsyncStorage.setItem(homeInterestsOwedStoreKey(publicKey, url), state);
        else await AsyncStorage.removeItem(homeInterestsOwedStoreKey(publicKey, url));
    } catch {
        // Asked again at the next landing.
    }
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((c, i) => c === b[i]);

/**
 * The member's latest change of interests on this phone, counted up at each change. A save carries the count it was
 * made at: one overtaken by a newer change is never sent, and one that lands after a newer change marks nothing synced
 * (the newer list is still owed). A landing that read the phone before a change leaves that change alone.
 */
let interestsTurn = 0;
/** The interests saves begun (counted up as each is made), and how many are waiting their turn or out now. */
let interestsSaves = 0;
let interestsSaving = 0;
/** The interests saves, one at a time in the order made, so the node takes the latest list last. */
let interestsQueue: Promise<unknown> = Promise.resolve();

function inTurn<T>(job: () => Promise<T>): Promise<T> {
    const run = interestsQueue.then(job, job);
    interestsQueue = run.catch(() => undefined);
    return run;
}

/** One interests save, counted from the moment it is made until it has its answer (or is never sent). */
function saveInTurn<T>(job: () => Promise<T>): Promise<T> {
    interestsSaves += 1;
    interestsSaving += 1;
    return inTurn(job).finally(() => { interestsSaving -= 1; });
}

/**
 * Where the interests stand as Home asks the node: the changes made, the saves begun and how many were waiting or out,
 * and the account's generation (home-account.ts). Each read takes it as it is sent ({@link readHomeFromNode}) and
 * carries it with its answer; each landing gives that to {@link reconcileInterests}.
 */
export interface InterestsTurn {
    readonly changes: number;
    readonly saves: number;
    readonly saving: number;
    readonly generation: number;
}

export const interestsTurnNow = (): InterestsTurn => ({
    changes: interestsTurn, saves: interestsSaves, saving: interestsSaving, generation: homeGeneration(),
});

/**
 * Whether an answer asked at `since` may be older than what the phone has: a star tapped since, or a save that was
 * waiting or out as it was asked, or begun after. The node may have built the answer before such a save landed
 * (review 4166559374: two quick stars on a slow link, a read between the saves), so its list must not overwrite them.
 */
const answerMayBeOlder = (since: InterestsTurn): boolean =>
    since.changes !== interestsTurn || since.saving > 0 || since.saves !== interestsSaves;

/**
 * The member starred or unstarred a category (the interests card, the Market's "Tune" or its For You panel): the
 * phone's copy at once, then the account's (§4.3: one truth, and For You keeps working offline). A save that doesn't
 * land is owed, and sent at the next landing; one the node refuses is not (a visitor's star stays on the phone only).
 * True once this list is the account's.
 */
export async function saveInterests(url: string | null, identity: BeanPoolIdentity | null | undefined, list: readonly string[]): Promise<boolean> {
    const turn = ++interestsTurn;
    const mine = [...list];
    const whose = identity ? homeAccount(identity.publicKey) : null;
    await writePhoneInterests(mine, whose);
    if (!url || !identity || !whose) return false;
    await setInterestsState(identity.publicKey, url, 'owed', whose);
    return saveInTurn(async () => {
        // Overtaken by a newer star, or the account has left the phone: never sent.
        if (turn !== interestsTurn || !stillOnPhone(whose)) return false;
        const saved = await saveHomePreferences(url, identity, { interests: mine });
        if (!saved || turn !== interestsTurn) return false;
        await setInterestsState(identity.publicKey, url, saved === SAVE_REFUSED ? null : 'synced', whose);
        return saved !== SAVE_REFUSED;
    });
}

/**
 * At a landing, the account's interests (from the answer's `me`) and the phone's made one: an owed save is sent; the
 * stars a member made in the Market before Home existed are sent once to an account that has none; otherwise, or when
 * the node refuses the phone's, the account's win and the phone's copy follows. `since` is where the interests stood as
 * the answer's read was sent (its own mark, {@link HomeRead}): a star tapped since, or a save waiting, out or begun
 * since, means the answer may be older than what the phone has, so the phone's list is left as it is (its own save
 * carries it) and the next landing agrees. Nothing is written or sent once the account has left the phone. Returns the
 * list Home draws with.
 */
export async function reconcileInterests(
    url: string, identity: BeanPoolIdentity, account: readonly string[], since: InterestsTurn = interestsTurnNow(),
): Promise<string[]> {
    const whose: HomeAccount = { publicKey: identity.publicKey, generation: since.generation };
    const phone = await readPhoneInterests();
    const state = await interestsState(identity.publicKey, url);
    if (!stillOnPhone(whose) || answerMayBeOlder(since)) return readPhoneInterests();
    const push = state === 'owed' || (state === null && account.length === 0 && phone.length > 0);
    // This landing's own save, once sent, is the one save begun since the answer it is allowed.
    let mark = since;
    if (push) {
        const saved = await saveInTurn(async () => {
            if (since.changes !== interestsTurn || !stillOnPhone(whose)) return null;
            const out = await saveHomePreferences(url, identity, { interests: phone });
            if (out && out !== SAVE_REFUSED && since.changes === interestsTurn) await setInterestsState(identity.publicKey, url, 'synced', whose);
            return out;
        });
        mark = { ...since, saves: since.saves + 1 };
        if (!stillOnPhone(whose) || answerMayBeOlder(mark)) return readPhoneInterests();
        // Refused: the account's list stands (below), and the phone's is never sent again by itself.
        if (saved !== SAVE_REFUSED) return phone;
    }
    if (!sameList(account, phone)) await writePhoneInterests(account, whose);
    if (!stillOnPhone(whose) || answerMayBeOlder(mark)) return readPhoneInterests();
    if (state !== 'synced') await setInterestsState(identity.publicKey, url, 'synced', whose);
    return [...account];
}
