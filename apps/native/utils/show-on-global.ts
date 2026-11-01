/**
 * "Also show this on the global community" (DESIGN-list-on-global-fable.md §3-§4, reworked by DESIGN-reaching-across-fable.md;
 * slice G2′): the member's own copy of their in-person event, posted by this phone to the global community with their own
 * key. The phone is the only link: their community's server does nothing and learns nothing, and global calls nobody.
 *
 * - **What goes.** The times, the rounded pin, the words, the photos, and the community's host and the event's id. Never
 *   the exact pin, the typed place or the note ({@link copyFields}). Nothing of the member's name: a copy shows no author.
 * - **Who says where it is from.** Global, from its own directory (apps/server engine/event-copy.ts). The host goes for it
 *   to look up; a community that isn't listed gets no line and no door, and the member is told once.
 * - **Staying in step.** An edit, a cancel and a cancelled date repeat at the moment (utils/db.ts), and {@link tendCopies}
 *   catches up on what that missed: a phone offline, a change made in the web app, an event moderated at home.
 *   An unchanged copy is sent again now and then, so a phone still tending it keeps it past global's 90-day retention, and
 *   one that can't falls off by itself. The pairs live here alone: a new phone tends nothing, and the copy stays the
 *   member's to take down from My posts on global.
 * - **Safe to run again.** A pair and its copy's id are written before anything is sent, and a first send reads first, so a
 *   lost answer posts nothing twice. Refused for now (a day's limit, no answer), it stays waiting.
 *
 * Phone only, for now (slice G3 is the web's tick). Sign Out wipes the pairs (utils/identity.ts wipeIdentityScopedStorage).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { audienceOf, roundToArea, t } from '@beanpool/core';
import { SHOWN_ON_GLOBAL_STORE_KEY } from './storage-keys';
import { GLOBAL_NODE_URL } from './global-node-url';
import { plainOriginOf } from './node-url';
import { signedDelete, signedGet, signedPost } from './node-post';
import { BRING_MOST_PHOTOS, photosOf } from './bring-listings';
import { eventRepeatOf, isEventEnded, isOnlineEvent } from './events';
import type { BeanPoolIdentity } from './identity';
import type { FetchedPhoto } from './post-photo';

const POSTS_PATH = '/api/marketplace/posts';
const TIMEOUT_MS = 60_000;
/** A copy unchanged this long is sent again, so global's retention (90 days without a change) only takes an untended one. */
export const COPY_KEEP_ALIVE_MS = 30 * 24 * 60 * 60 * 1000;
/** {@link tendCopiesSoon}: at most this often. */
const TEND_EVERY_MS = 60 * 60 * 1000;

/** The event as the home community gives it, in the node's camelCase. */
export interface HomeEvent {
    id: string;
    title: string;
    description?: string;
    lat?: number | null;
    lng?: number | null;
    photos?: string[];
    tags?: string[];
    freeTags?: string[];
    status?: string;
    active?: boolean;
    eventState?: string;
    eventOnline?: boolean;
    eventStartAt?: string;
    eventEndAt?: string;
    eventStartLocal?: string;
    eventEndLocal?: string;
    eventTz?: string;
    eventRepeat?: unknown;
    eventRepeatUntil?: string | null;
    eventRepeatSkips?: string[];
    hiddenByReportsAt?: string | null;
}

/** A home event and the copy that shows it. `sent` is empty until the copy has landed. */
export interface CopyPair {
    publicKey: string;
    home: string;
    homeId: string;
    copyId: string;
    sent: string;
    sentAt: number;
    /** The first photo URL last sent: a new one is a new photo. */
    photo: string;
    skips: string[];
    /** The event left the board, and global hasn't heard yet. */
    leaving?: boolean;
}

export type CopyResult = 'shown' | 'shown-no-name' | 'later' | { refused: string };

export interface CopyDeps {
    global: string;
    get(url: string, path: string, identity: BeanPoolIdentity, signal?: AbortSignal): Promise<Response>;
    post(url: string, path: string, body: unknown, identity: BeanPoolIdentity, signal?: AbortSignal): Promise<Response>;
    del(url: string, path: string, identity: BeanPoolIdentity): Promise<Response>;
    fetchPhoto(url: string): Promise<FetchedPhoto>;
    /** The host global looks the community up by. */
    hostOf(home: string): string | null;
}

const liveDeps: CopyDeps = {
    global: GLOBAL_NODE_URL,
    get: (...args) => signedGet(...args),
    post: (...args) => signedPost(...args),
    del: (...args) => signedDelete(...args),
    fetchPhoto: async (url) => (await import('./post-photo')).fetchedPostPhoto(url),
    hostOf: audienceOf,
};

async function readPairs(): Promise<CopyPair[]> {
    const raw = await AsyncStorage.getItem(SHOWN_ON_GLOBAL_STORE_KEY).catch(() => null);
    try {
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

const writePairs = (pairs: CopyPair[]) => AsyncStorage.setItem(SHOWN_ON_GLOBAL_STORE_KEY, JSON.stringify(pairs));

async function savePair(pair: CopyPair): Promise<void> {
    await writePairs([...(await readPairs()).filter((p) => p.copyId !== pair.copyId), pair]);
}

async function dropPair(pair: CopyPair): Promise<void> {
    await writePairs((await readPairs()).filter((p) => p.copyId !== pair.copyId));
}

/** This key's pair for a home event, if it is shown or waiting to be. */
export async function pairOf(homeId: string, publicKey: string): Promise<CopyPair | null> {
    return (await readPairs()).find((p) => p.homeId === homeId && p.publicKey === publicKey && !p.leaving) ?? null;
}

/** An event the tick is for: in person. A group's, an enterprise's and a direct post are never offered it. */
export function mayShowOnGlobal(home: Pick<HomeEvent, 'eventOnline'>): boolean {
    return !isOnlineEvent(home);
}

/** What a copy holds, and all it holds. Nothing else of the event leaves the phone. */
export function copyFields(home: HomeEvent, publicKey: string): Record<string, unknown> {
    const { rule, until } = eventRepeatOf(home);
    return {
        type: 'event', category: 'community', title: home.title, description: home.description ?? '', credits: 0, priceType: 'fixed',
        authorPublicKey: publicKey,
        lat: roundToArea(Number(home.lat)), lng: roundToArea(Number(home.lng)),
        eventStartAt: home.eventStartAt, eventEndAt: home.eventEndAt,
        ...(home.eventStartLocal ? { eventStartLocal: home.eventStartLocal } : {}),
        ...(home.eventEndLocal ? { eventEndLocal: home.eventEndLocal } : {}),
        ...(home.eventTz ? { eventTz: home.eventTz } : {}),
        ...(rule ? { eventRepeat: rule, ...(until ? { eventRepeatUntil: until } : {}) } : {}),
        ...(home.tags?.length ? { tags: home.tags } : {}),
        ...(home.freeTags?.length ? { freeTags: home.freeTags } : {}),
    };
}

const firstPhoto = (home: HomeEvent) => home.photos?.[0] ?? '';

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        return await run(controller.signal);
    } finally {
        clearTimeout(timer);
    }
}

/** The node's answer to a write: done, for now, or refused in its words. A status with no words is a page in front of it. */
async function answerOf(res: Response): Promise<{ done: any } | 'later' | { refused: string }> {
    const answer: any = await res.json().catch(() => null);
    if (res.ok) return answer?.success === true ? { done: answer } : 'later';
    if (res.status === 401 || res.status === 408 || res.status === 429 || res.status >= 500) return 'later';
    return typeof answer?.error === 'string' && answer.error ? { refused: answer.error } : 'later';
}

/** Is the copy on global? `later` when global didn't say. */
async function copyIsThere(pair: CopyPair, identity: BeanPoolIdentity, deps: CopyDeps): Promise<boolean | 'later'> {
    const res = await withTimeout((signal) => deps.get(deps.global, `${POSTS_PATH}?id=${encodeURIComponent(pair.copyId)}`, identity, signal));
    if (!res.ok) return 'later';
    const rows: unknown = await res.json().catch(() => null);
    return Array.isArray(rows) ? rows.length > 0 : 'later';
}

async function createCopy(pair: CopyPair, home: HomeEvent, identity: BeanPoolIdentity, deps: CopyDeps): Promise<CopyResult> {
    const { photos, later } = await photosOf({ photos: (home.photos ?? []).slice(0, BRING_MOST_PHOTOS) }, pair.home, deps);
    if (photos.length === 0 && later) return 'later';
    const body = {
        id: pair.copyId, ...copyFields(home, identity.publicKey), photos,
        shownFrom: { host: deps.hostOf(pair.home), postId: pair.homeId },
    };
    const answer = await answerOf(await withTimeout((signal) => deps.post(deps.global, POSTS_PATH, body, identity, signal)));
    if (answer === 'later') return 'later';
    if ('refused' in answer) {
        await dropPair(pair);
        return answer;
    }
    // A global that predates copies made a plain event of it, with the member's name on: it comes down at once.
    if (answer.done.post?.shownCopy !== true) {
        await withTimeout((signal) => deps.post(deps.global, `${POSTS_PATH}/remove`, { id: pair.copyId, authorPublicKey: identity.publicKey }, identity, signal)).catch(() => null);
        await dropPair(pair);
        return { refused: t("The global community can't show this yet.") };
    }
    await savePair({ ...pair, sent: JSON.stringify(copyFields(home, identity.publicKey)), sentAt: Date.now(), photo: firstPhoto(home) });
    return answer.done.post?.shownFrom ? 'shown' : 'shown-no-name';
}

async function updateCopy(pair: CopyPair, home: HomeEvent, identity: BeanPoolIdentity, deps: CopyDeps): Promise<CopyResult> {
    const fields = copyFields(home, identity.publicKey);
    const fetched = firstPhoto(home) !== pair.photo ? await photosOf({ photos: home.photos ?? [] }, pair.home, deps) : null;
    const { type: _type, category: _category, credits: _credits, priceType: _priceType, ...edit } = fields;
    const body = { id: pair.copyId, ...edit, ...(fetched?.photos.length ? { photos: fetched.photos } : {}), ...(fields.eventRepeat ? {} : { eventRepeat: null }) };
    const answer = await answerOf(await withTimeout((signal) => deps.post(deps.global, `${POSTS_PATH}/update`, body, identity, signal)));
    if (answer === 'later') return 'later';
    if ('refused' in answer) {
        await dropPair(pair);
        return answer;
    }
    await savePair({ ...pair, sent: JSON.stringify(fields), sentAt: Date.now(), photo: fetched?.photos.length ? firstPhoto(home) : pair.photo });
    return 'shown';
}

async function sendCopy(pair: CopyPair, home: HomeEvent, identity: BeanPoolIdentity, deps: CopyDeps): Promise<CopyResult> {
    try {
        if (pair.sent) return await updateCopy(pair, home, identity, deps);
        const there = await copyIsThere(pair, identity, deps);
        if (there === 'later') return 'later';
        return there ? await updateCopy({ ...pair, sent: 'lost', photo: firstPhoto(home) }, home, identity, deps) : await createCopy(pair, home, identity, deps);
    } catch {
        return 'later';
    }
}

/** The dates cancelled at home, cancelled on the copy; a date brought back, brought back. */
async function repeatDates(pair: CopyPair, home: HomeEvent, identity: BeanPoolIdentity, deps: CopyDeps): Promise<void> {
    const want = home.eventRepeatSkips ?? [];
    const path = `/api/events/${encodeURIComponent(pair.copyId)}/skip`;
    const done = [...pair.skips];
    for (const date of want.filter((d) => !pair.skips.includes(d))) {
        if ((await deps.post(deps.global, path, { date }, identity)).ok) done.push(date);
    }
    for (const date of pair.skips.filter((d) => !want.includes(d))) {
        if ((await deps.del(deps.global, `${path}?date=${encodeURIComponent(date)}`, identity)).ok) done.splice(done.indexOf(date), 1);
    }
    if (done.join() !== pair.skips.join()) await savePair({ ...((await readPairs()).find((p) => p.copyId === pair.copyId) ?? pair), skips: done });
}

/**
 * The tick: makes the pair, then the copy. Waiting on something (no answer, a day's limit) it stays a pair, and
 * {@link tendCopies} sends it. `homeUrl` is the community the event is on.
 */
export async function showOnGlobal(home: HomeEvent, homeUrl: string, identity: BeanPoolIdentity, deps: CopyDeps = liveDeps): Promise<CopyResult> {
    const { randomUUID } = await import('expo-crypto');
    const pair: CopyPair = (await pairOf(home.id, identity.publicKey))
        ?? { publicKey: identity.publicKey, home: plainOriginOf(homeUrl) ?? homeUrl, homeId: home.id, copyId: randomUUID(), sent: '', sentAt: 0, photo: '', skips: [] };
    await savePair(pair);
    return sendCopy(pair, home, identity, deps);
}

/** After an edit or a cancelled date at home: the copy follows. Nothing is said: a miss is caught up by {@link tendCopies}. */
export async function repeatOnCopy(home: HomeEvent, identity: BeanPoolIdentity, deps: CopyDeps = liveDeps): Promise<void> {
    const pair = await pairOf(home.id, identity.publicKey);
    if (!pair) return;
    await sendCopy(pair, home, identity, deps);
    const now = await pairOf(home.id, identity.publicKey);
    if (now) await repeatDates(now, home, identity, deps).catch(() => {});
}

/** The copy comes down. Global not answering, the pair stays marked, and {@link tendCopies} tries again. */
async function takeDown(pair: CopyPair, identity: BeanPoolIdentity, deps: CopyDeps): Promise<boolean> {
    await savePair({ ...pair, leaving: true });
    const answer = await withTimeout((signal) => deps.post(deps.global, `${POSTS_PATH}/remove`, { id: pair.copyId, authorPublicKey: identity.publicKey }, identity, signal))
        .then(answerOf).catch(() => 'later' as const);
    if (answer === 'later') return false;
    await dropPair(pair);
    return true;
}

/** Stop showing, and a cancel at home: the copy goes. False when global didn't answer, and it is tried again. */
export async function stopShowing(homeId: string, identity: BeanPoolIdentity, deps: CopyDeps = liveDeps): Promise<boolean> {
    const pair = await pairOf(homeId, identity.publicKey);
    return pair ? takeDown(pair, identity, deps) : true;
}

/** The event from its community, null where it is gone, `later` where the community didn't say. */
async function readHome(pair: CopyPair, identity: BeanPoolIdentity, deps: CopyDeps): Promise<HomeEvent | null | 'later'> {
    const res = await withTimeout((signal) => deps.get(pair.home, `${POSTS_PATH}?id=${encodeURIComponent(pair.homeId)}`, identity, signal));
    if (!res.ok) return 'later';
    const rows: unknown = await res.json().catch(() => null);
    return Array.isArray(rows) ? (rows[0] as HomeEvent | undefined) ?? null : 'later';
}

const isUp = (home: HomeEvent) => home.status === 'active' && home.active !== false && home.eventState !== 'cancelled' && !home.hiddenByReportsAt && !isEventEnded(home);

/**
 * Each of this key's pairs brought into step from its community's own word: an event gone, cancelled, ended or hidden there
 * takes its copy down; one waiting goes; one changed follows, and one long unchanged is sent again. A community that gives
 * no answer changes nothing.
 */
export async function tendCopies(identity: BeanPoolIdentity, deps: CopyDeps = liveDeps, now: number = Date.now()): Promise<void> {
    for (const pair of (await readPairs()).filter((p) => p.publicKey === identity.publicKey)) {
        try {
            if (pair.leaving) {
                await takeDown(pair, identity, deps);
                continue;
            }
            const home = await readHome(pair, identity, deps);
            if (home === 'later') continue;
            if (!home || !isUp(home)) {
                await takeDown(pair, identity, deps);
                continue;
            }
            if (pair.sent !== JSON.stringify(copyFields(home, identity.publicKey)) || firstPhoto(home) !== pair.photo || now - pair.sentAt >= COPY_KEEP_ALIVE_MS) {
                await sendCopy(pair, home, identity, deps);
            }
            const current = (await readPairs()).find((p) => p.copyId === pair.copyId);
            if (current?.sent) await repeatDates(current, home, identity, deps);
        } catch { /* the next time round */ }
    }
}

let lastTended = 0;

/** {@link tendCopies} when the app comes to the front, at most hourly. Never in anyone's way. */
export async function tendCopiesSoon(identity: BeanPoolIdentity | null | undefined, now: number = Date.now()): Promise<void> {
    if (!identity || now - lastTended < TEND_EVERY_MS) return;
    lastTended = now;
    await tendCopies(identity).catch(() => {});
}

/** The one line a run owes the member, or none. */
export function copyResultLine(result: CopyResult): string | null {
    if (result === 'shown') return null;
    if (result === 'shown-no-name') return t("Your community isn't in the directory, so this shows there without its name.");
    if (result === 'later') return t('It will go up on the global community as soon as it can.');
    return result.refused;
}

