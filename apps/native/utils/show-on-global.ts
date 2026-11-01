/**
 * "Also show this on the global community" (DESIGN-list-on-global-fable.md §3-§4, reworked by DESIGN-reaching-across-fable.md;
 * slices G2′ and G1′): the member's own copy of their in-person event, Offer or Need, posted by this phone to the global
 * community with their own key. The phone is the only link: their community's server does nothing and learns nothing, and
 * global calls nobody.
 *
 * - **What goes.** The times, the rounded pin, the words, the photos, and the community's host and the event's id. Never
 *   the exact pin, the typed place or the note ({@link copyFields}). Nothing of the member's name: a copy shows no author.
 *   An Offer or a Need sends its price as words (`shownPrice`), never as a price: nothing of a deal goes.
 * - **Who says where it is from.** Global, from its own directory (apps/server engine/event-copy.ts). The host goes for it
 *   to look up; a community that isn't listed gets no line and no door, and the member is told once.
 * - **Staying in step.** An edit, a cancel and a cancelled date repeat at the moment (utils/db.ts), and {@link tendCopies}
 *   catches up on what that missed: a phone offline, a change made in the web app, an event moderated at home.
 *   An unchanged copy is sent again now and then, so a phone still tending it keeps it past global's 90-day retention, and
 *   one that can't falls off by itself. The pairs live here alone: a new phone tends nothing, and the copy stays the
 *   member's to take down from My posts on global.
 * - **A holiday at home.** The member's listings leave their community's board, and the copy leaves global with them. The
 *   pair stays, and when the holiday ends the copy goes back up as a new one ({@link CopyPair.resting}). So does an Offer or
 *   a Need that is off the board for now: paused, in a deal, out on loan, hidden by reports ({@link restsAtHome}).
 * - **A Stop showing stands.** A tap can land between any two steps of a tend, so each step goes by the pair as it is stored
 *   now: a pair that has gone stays gone, and a send that lands after it comes down ({@link recordSend}). It stands from
 *   either end: the host's page knows the home id and the copy's own page only the copy's ({@link stopShowing}), and a copy
 *   taken down behind this phone isn't brought back by the next rest.
 * - **Off the board, nothing goes.** A listing is only ever sent on its community's own word ({@link showOnGlobal}): the
 *   phone's table can be behind, and has nothing of a hide by reports.
 * - **Safe to run again.** A pair and its copy's id are written before anything is sent, and a first send reads first, so a
 *   lost answer posts nothing twice. Refused for now (a day's limit, no answer), it stays waiting. Refused outright, the
 *   pair goes only once global says the copy isn't up ({@link forgetIfGone}): it is the phone's only way to that copy.
 *
 * Phone only, for now (slice G3 is the web's tick). Sign Out wipes the pairs (utils/identity.ts wipeIdentityScopedStorage).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { audienceOf, roundToArea, t } from '@beanpool/core';
import { SHOWN_ON_GLOBAL_STORE_KEY } from './storage-keys';
import { GLOBAL_NODE_URL } from './global-node-url';
import { fetchNodeProfile, getCachedNodeProfile } from './node-profile';
import { plainOriginOf } from './node-url';
import { signedDelete, signedGet, signedPost } from './node-post';
import { BRING_MOST_PHOTOS, photosOf } from './bring-listings';
import { eventRepeatOf, isEventEnded, isOnlineEvent } from './events';
import type { BeanPoolIdentity } from './identity';
import type { FetchedPhoto } from './post-photo';

const POSTS_PATH = '/api/marketplace/posts';
const PREFERENCES_PATH = '/api/members/preferences';
/** How long one request gets, its answer's body included. React Native's fetch never gives up by itself. */
export const COPY_TIMEOUT_MS = 60_000;
/** A copy unchanged this long is sent again, so global's retention (90 days without a change) only takes an untended one. */
export const COPY_KEEP_ALIVE_MS = 30 * 24 * 60 * 60 * 1000;
/** {@link tendCopiesSoon}: at most this often. */
const TEND_EVERY_MS = 60 * 60 * 1000;

/** The event as the home community gives it, in the node's camelCase. */
export interface HomeEvent {
    id: string;
    /** 'event' or absent for an event. */
    type?: string;
    category?: string;
    credits?: number;
    priceType?: string;
    originNode?: string | null;
    title: string;
    description?: string;
    authorPublicKey?: string;
    audienceScope?: string;
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
    /**
     * The member is on holiday at home: the copy comes down, and goes back up when they're back. With `leaving`, global hasn't
     * heard yet. Without it the copy is down and the pair holds a new id, since a copy taken down can't be brought back.
     */
    resting?: boolean;
    /** The ids its copy had before a rest: a page left open on one, or a row still cached, still reaches this pair. */
    earlierIds?: string[];
}

export type CopyResult = 'shown' | 'shown-no-name' | 'later' | { refused: string };

export interface CopyDeps {
    global: string;
    get(url: string, path: string, identity: BeanPoolIdentity, signal?: AbortSignal): Promise<Response>;
    post(url: string, path: string, body: unknown, identity: BeanPoolIdentity, signal?: AbortSignal): Promise<Response>;
    del(url: string, path: string, identity: BeanPoolIdentity, signal?: AbortSignal): Promise<Response>;
    fetchPhoto(url: string): Promise<FetchedPhoto>;
    /** The host global looks the community up by. */
    hostOf(home: string): string | null | Promise<string | null>;
}

/**
 * The host the directory has a community at: its main address, which a phone still on an older name of the community
 * doesn't use. Global matches the whole host, so the older name would read as a community that isn't listed.
 */
export async function homeHostOf(home: string): Promise<string | null> {
    const profile = await fetchNodeProfile(home) ?? await getCachedNodeProfile(home);
    return profile?.primaryAddress ?? audienceOf(home);
}

const liveDeps: CopyDeps = {
    global: GLOBAL_NODE_URL,
    get: (...args) => signedGet(...args),
    post: (...args) => signedPost(...args),
    del: (...args) => signedDelete(...args),
    fetchPhoto: async (url) => (await import('./post-photo')).fetchedPostPhoto(url),
    hostOf: homeHostOf,
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

/** The pair as it is stored now: a tap may have changed it, or taken it away, since it was read. */
async function storedPair(copyId: string): Promise<CopyPair | undefined> {
    return (await readPairs()).find((p) => p.copyId === copyId);
}

async function savePair(pair: CopyPair): Promise<void> {
    await writePairs([...(await readPairs()).filter((p) => p.copyId !== pair.copyId), pair]);
}

async function dropPair(pair: CopyPair): Promise<void> {
    await writePairs((await readPairs()).filter((p) => p.copyId !== pair.copyId));
}

/** Shown, waiting to be, or resting: it stays theirs to stop. */
const stillTheirs = (p: CopyPair) => !p.leaving || !!p.resting;

/**
 * This key's pair for a home event. By the home id alone: what follows a home event (an edit, a date) goes through here, and
 * a copy's row must never be taken for the event it copies. {@link stopShowing} is the one that takes a copy's id.
 */
export async function pairOf(homeId: string, publicKey: string): Promise<CopyPair | null> {
    return (await readPairs()).find((p) => p.homeId === homeId && p.publicKey === publicKey && stillTheirs(p)) ?? null;
}

const isListing = (home: Pick<HomeEvent, 'type'>): boolean => home.type === 'offer' || home.type === 'need';

/**
 * What the tick is for: the member's own event at a place, or their own Offer or Need with a place, for the whole community.
 * An enterprise's has the enterprise as its author, and a linked community's isn't theirs. The screens offer it for no other,
 * and this holds whatever a screen asks: what a group was told stays in the group.
 */
export function mayShowOnGlobal(home: Pick<HomeEvent, 'eventOnline' | 'audienceScope' | 'authorPublicKey'> & Partial<Pick<HomeEvent, 'type' | 'lat' | 'lng' | 'originNode'>>, publicKey: string): boolean {
    const kind = isListing(home) ? typeof home.lat === 'number' && typeof home.lng === 'number' && !home.originNode : (home.type ?? 'event') === 'event' && !isOnlineEvent(home);
    return kind && (home.audienceScope ?? 'public') === 'public' && home.authorPublicKey === publicKey;
}

/** What a copy holds, and all it holds. Nothing else of the event leaves the phone. */
export function copyFields(home: HomeEvent, publicKey: string): Record<string, unknown> {
    const tags = {
        ...(home.tags?.length ? { tags: home.tags } : {}),
        ...(home.freeTags?.length ? { freeTags: home.freeTags } : {}),
    };
    if (isListing(home)) {
        return {
            type: home.type, category: home.category, title: home.title, description: home.description ?? '', authorPublicKey: publicKey,
            lat: roundToArea(Number(home.lat)), lng: roundToArea(Number(home.lng)),
            shownPrice: { beans: Number(home.credits) || 0, per: home.priceType ?? 'fixed' },
            ...tags,
        };
    }
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
        ...tags,
    };
}

const firstPhoto = (home: HomeEvent) => home.photos?.[0] ?? '';

/**
 * Runs a request and the reading of its answer, and gives up at {@link COPY_TIMEOUT_MS} whatever it is waiting on. Each tend
 * waits for the one before ({@link tendCopies}), so everything a tend waits on the network for goes through here.
 */
async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const noAnswer = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error('No answer in time'));
        }, COPY_TIMEOUT_MS);
    });
    try {
        return await Promise.race([run(controller.signal), noAnswer]);
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

/** What a node answers a read with, body and all. Null where it refused the read or answered with something else. */
function readJson(url: string, path: string, identity: BeanPoolIdentity, deps: CopyDeps): Promise<unknown> {
    return withTimeout(async (signal) => {
        const res = await deps.get(url, path, identity, signal);
        return res.ok ? res.json().catch(() => null) : null;
    });
}

/**
 * Is the copy up on global? `later` when global didn't say. A copy taken down there still reads by id for its host, as
 * cancelled, for 30 days: that one isn't up, and an edit can't bring it back.
 */
async function copyIsThere(pair: CopyPair, identity: BeanPoolIdentity, deps: CopyDeps): Promise<boolean | 'later'> {
    const rows = await readJson(deps.global, `${POSTS_PATH}?id=${encodeURIComponent(pair.copyId)}`, identity, deps);
    return Array.isArray(rows) ? rows.some((row) => row?.status !== 'cancelled') : 'later';
}

/**
 * Whether a rest has to wait: global's auto-hide leaves the row in place for its author, so `copyIsThere` reads a held copy
 * as up, and a rest would cancel it and the listing's return post the same words clean, with nobody having chosen that.
 * An unread answer waits too: a rest is the step that can't be taken back, and the next tend asks again.
 */
async function restMustWait(pair: CopyPair, identity: BeanPoolIdentity, deps: CopyDeps): Promise<boolean> {
    const rows = await readJson(deps.global, `${POSTS_PATH}?id=${encodeURIComponent(pair.copyId)}`, identity, deps).catch(() => null);
    return !Array.isArray(rows) || rows.some((row) => !!row?.hiddenByReportsAt);
}

/**
 * After a refusal, which doesn't say the copy has gone (a mute, a date that has ended, a tag one library lacks, a second
 * send of the same id). The pair goes only if global says the copy isn't up. Otherwise it stays as it was, so a cancel at
 * home can still take the copy down, and the next tend sees what wasn't sent and tries again.
 */
async function forgetIfGone(pair: CopyPair, identity: BeanPoolIdentity, deps: CopyDeps): Promise<boolean | 'later'> {
    const there = await copyIsThere(pair, identity, deps);
    if (there === false) await dropPair(pair);
    return there;
}

/**
 * A send landed, and the pair takes it in. If a Stop showing came while it was on its way the pair stays gone, and what just
 * landed comes down, asked again in case that Stop's own remove got there first. A pair going to rest is left to its rest.
 */
async function recordSend(sent: CopyPair, identity: BeanPoolIdentity, deps: CopyDeps): Promise<void> {
    const stored = await storedPair(sent.copyId);
    if (stored && !stored.leaving) await savePair(sent);
    else if (!stored?.resting) await takeDown(sent, identity, deps);
}

async function createCopy(pair: CopyPair, home: HomeEvent, identity: BeanPoolIdentity, deps: CopyDeps): Promise<CopyResult> {
    const { photos, later } = await photosOf({ photos: (home.photos ?? []).slice(0, BRING_MOST_PHOTOS) }, pair.home, deps);
    if (photos.length === 0 && later) return 'later';
    const body = {
        id: pair.copyId, ...copyFields(home, identity.publicKey), photos,
        shownFrom: { host: await deps.hostOf(pair.home), postId: pair.homeId },
    };
    const answer = await withTimeout(async (signal) => answerOf(await deps.post(deps.global, POSTS_PATH, body, identity, signal)));
    if (answer === 'later') return 'later';
    if ('refused' in answer) {
        // Up all the same: this was a second send of the id (an edit made during the upload), and the first one landed.
        const there = await forgetIfGone(pair, identity, deps);
        return there === false ? answer : there === 'later' ? 'later' : 'shown';
    }
    // A global that predates copies made a plain event of it, with the member's name on: it comes down at once.
    if (answer.done.post?.shownCopy !== true) {
        await withTimeout((signal) => deps.post(deps.global, `${POSTS_PATH}/remove`, { id: pair.copyId, authorPublicKey: identity.publicKey }, identity, signal)).catch(() => null);
        await dropPair(pair);
        return { refused: t("The global community can't show this yet.") };
    }
    await recordSend({ ...pair, sent: JSON.stringify(copyFields(home, identity.publicKey)), sentAt: Date.now(), photo: firstPhoto(home) }, identity, deps);
    return answer.done.post?.shownFrom ? 'shown' : 'shown-no-name';
}

async function updateCopy(pair: CopyPair, home: HomeEvent, identity: BeanPoolIdentity, deps: CopyDeps): Promise<CopyResult> {
    const fields = copyFields(home, identity.publicKey);
    const fetched = firstPhoto(home) !== pair.photo ? await photosOf({ photos: home.photos ?? [] }, pair.home, deps) : null;
    const { type: _type, credits: _credits, priceType: _priceType, ...kept } = fields;
    const { category: _category, ...eventEdit } = kept;
    const edit = isListing(home) ? kept : eventEdit;
    // An edit leaves alone what it doesn't name, and copyFields names nothing there is none of: what was taken off at home is
    // sent as taken off, or it stays public here while `sent` says the copy is in step.
    const repeats = isListing(home) ? {} : !fields.eventRepeat ? { eventRepeat: null } : fields.eventRepeatUntil ? {} : { eventRepeatUntil: null };
    const taken = { tags: fields.tags ?? [], freeTags: fields.freeTags ?? [], ...repeats };
    const body = { id: pair.copyId, ...edit, ...taken, ...(fetched?.photos.length ? { photos: fetched.photos } : {}) };
    const answer = await withTimeout(async (signal) => answerOf(await deps.post(deps.global, `${POSTS_PATH}/update`, body, identity, signal)));
    if (answer === 'later') return 'later';
    if ('refused' in answer) {
        await forgetIfGone(pair, identity, deps);
        return answer;
    }
    await recordSend({ ...pair, sent: JSON.stringify(fields), sentAt: Date.now(), photo: fetched?.photos.length ? firstPhoto(home) : pair.photo }, identity, deps);
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
        if (await withTimeout(async (signal) => (await deps.post(deps.global, path, { date }, identity, signal)).ok)) done.push(date);
    }
    for (const date of pair.skips.filter((d) => !want.includes(d))) {
        if (await withTimeout(async (signal) => (await deps.del(deps.global, `${path}?date=${encodeURIComponent(date)}`, identity, signal)).ok)) done.splice(done.indexOf(date), 1);
    }
    const stored = await storedPair(pair.copyId);
    if (stored && done.join() !== pair.skips.join()) await savePair({ ...stored, skips: done });
}

/**
 * The tick: makes the pair, then the copy. Waiting on something (no answer, a day's limit) it stays a pair, and
 * {@link tendCopies} sends it. `homeUrl` is the community the event is on.
 *
 * An Offer or a Need goes on its community's word, not the screen's: the row a screen holds can be behind, and has nothing of
 * a hide by reports. Off the board for now, nothing is sent and the tick rests until it is back; gone, it is refused. Home
 * not saying, it waits: {@link tendCopies} asks again before it sends.
 */
export async function showOnGlobal(home: HomeEvent, homeUrl: string, identity: BeanPoolIdentity, deps: CopyDeps = liveDeps): Promise<CopyResult> {
    const refused = { refused: t("The global community can't show this yet.") };
    if (!mayShowOnGlobal(home, identity.publicKey)) return refused;
    const { randomUUID } = await import('expo-crypto');
    const kept = await pairOf(home.id, identity.publicKey);
    if (kept?.resting) return 'later';
    const pair: CopyPair = kept
        ?? { publicKey: identity.publicKey, home: plainOriginOf(homeUrl) ?? homeUrl, homeId: home.id, copyId: randomUUID(), sent: '', sentAt: 0, photo: '', skips: [] };
    if (isListing(home)) {
        const atHome = await readHome(pair, identity, deps).catch(() => 'later' as const);
        if (atHome === 'later') {
            await savePair(pair);
            return 'later';
        }
        if (!mayHaveCopy(atHome, identity.publicKey)) return refused;
        if (restsAtHome(atHome)) {
            // A pair held has a copy up to bring down, unless reports hold it. A new one has nothing up, which is what `resting`
            // without `leaving` says.
            if (kept?.sent && !kept.resting && await restMustWait(kept, identity, deps)) return 'later';
            await (kept ? restCopy(kept, identity, deps) : savePair({ ...pair, resting: true }));
            return 'later';
        }
    }
    await savePair(pair);
    return sendCopy(pair, home, identity, deps);
}

/**
 * After an edit or a cancelled date at home: the copy follows, or comes down if the edit made it an event that can't be
 * shown (moved online: it has no point to send). Nothing is said: a miss is caught up by {@link tendCopies}.
 */
export async function repeatOnCopy(home: HomeEvent, identity: BeanPoolIdentity, deps: CopyDeps = liveDeps): Promise<void> {
    const pair = await pairOf(home.id, identity.publicKey);
    if (!pair) return;
    if (!mayShowOnGlobal(home, identity.publicKey)) {
        await takeDown(pair, identity, deps);
        return;
    }
    if (pair.resting) return;
    await sendCopy(pair, home, identity, deps);
    const now = await pairOf(home.id, identity.publicKey);
    if (now) await repeatDates(now, home, identity, deps).catch(() => {});
}

/** Asks global to take the copy down, the pair marked first. False when global didn't answer, and it stays marked. */
async function askDown(pair: CopyPair, identity: BeanPoolIdentity, deps: CopyDeps): Promise<boolean> {
    await savePair({ ...pair, leaving: true });
    const answer = await withTimeout(async (signal) => answerOf(await deps.post(deps.global, `${POSTS_PATH}/remove`, { id: pair.copyId, authorPublicKey: identity.publicKey }, identity, signal)))
        .catch(() => 'later' as const);
    return answer !== 'later';
}

/** The copy comes down and the pair goes. Global not answering, {@link tendCopies} tries again. A resting pair has nothing up. */
async function takeDown(pair: CopyPair, identity: BeanPoolIdentity, deps: CopyDeps): Promise<boolean> {
    const nothingUp = pair.resting && !pair.leaving;
    if (!nothingUp && !(await askDown({ ...pair, resting: false }, identity, deps))) return false;
    await dropPair(pair);
    return true;
}

/**
 * A holiday at home: the copy comes down and the pair waits with a new id for the holiday to end. A Stop showing while global
 * was being asked has the last word: {@link takeDown} saves `resting: false` before it asks, and drops the pair after.
 */
async function restCopy(pair: CopyPair, identity: BeanPoolIdentity, deps: CopyDeps): Promise<void> {
    if (!(await askDown({ ...pair, resting: true }, identity, deps))) return;
    const { randomUUID } = await import('expo-crypto');
    const waiting: CopyPair = {
        ...pair, leaving: false, resting: true, copyId: randomUUID(), sent: '', sentAt: 0, photo: '', skips: [],
        earlierIds: [...(pair.earlierIds ?? []), pair.copyId],
    };
    const pairs = await readPairs();
    if (!pairs.find((p) => p.copyId === pair.copyId)?.resting) return;
    await writePairs([...pairs.filter((p) => p.copyId !== pair.copyId), waiting]);
}

/**
 * Stop showing, and a cancel at home: the copy goes, and the pair with it, or the next rest brings the copy back. False when
 * global didn't answer, and it is tried again. `id` is the home event's from the host's page and the copy's from its own
 * (utils/db.ts deletePost hands on whichever it was given), which may be an id from before a rest.
 */
export async function stopShowing(id: string, identity: BeanPoolIdentity, deps: CopyDeps = liveDeps): Promise<boolean> {
    const pair = (await readPairs()).find((p) => p.publicKey === identity.publicKey && stillTheirs(p)
        && (p.homeId === id || p.copyId === id || p.earlierIds?.includes(id)));
    return pair ? takeDown(pair, identity, deps) : true;
}

/** What a Stop showing owes the member when {@link stopShowing} answers false: the copy is still up, and the row can't say so. */
export const stopLaterLine = () => t('It will come down from the global community as soon as it can.');

/** The event from its community, null where it is gone, `later` where the community didn't say. */
async function readHome(pair: CopyPair, identity: BeanPoolIdentity, deps: CopyDeps): Promise<HomeEvent | null | 'later'> {
    const rows = await readJson(pair.home, `${POSTS_PATH}?id=${encodeURIComponent(pair.homeId)}`, identity, deps);
    return Array.isArray(rows) ? (rows[0] as HomeEvent | undefined) ?? null : 'later';
}

/** Is the member on holiday at their community? `later` where it didn't say: a pair changes on its word alone. */
async function onHoliday(pair: CopyPair, identity: BeanPoolIdentity, deps: CopyDeps): Promise<boolean | 'later'> {
    const prefs: any = await readJson(pair.home, `${PREFERENCES_PATH}?publicKey=${encodeURIComponent(identity.publicKey)}`, identity, deps);
    return prefs && typeof prefs === 'object' ? prefs.holiday_mode === 'true' : 'later';
}

/** Nothing at home has stopped it. Whether its date has passed is another question ({@link rollsOn}). */
const isOn = (home: HomeEvent) => home.status === 'active' && home.active !== false && home.eventState !== 'cancelled' && !home.hiddenByReportsAt;

/** An Offer or a Need off its community's board for now: paused, in a deal, out on loan, hidden by reports. It can come back. */
function restsAtHome(home: HomeEvent): boolean {
    if (!isListing(home) || home.active === false) return false;
    return home.status === 'paused' || home.status === 'pending' || (home.status === 'active' && !!home.hiddenByReportsAt);
}

/** Can this post have a copy at all, up or resting? Not one gone, cancelled, finished, hidden for good or that can't be shown. */
function mayHaveCopy(home: HomeEvent | null, publicKey: string): home is HomeEvent {
    return !!home && (isOn(home) || restsAtHome(home)) && mayShowOnGlobal(home, publicKey);
}

/**
 * A date of a series is over and the series isn't: its row keeps that date until the community's minute tick moves it on, and
 * a read doesn't move it. The same test as that tick's (apps/server engine/event-series-roll.ts rollDueSeries): a row it
 * would never touch doesn't get waited for. A series that turns out to have no date left has its `until` set by the tick.
 */
function rollsOn(home: HomeEvent): boolean {
    const { rule, until } = eventRepeatOf(home);
    const date = home.eventStartLocal?.slice(0, 10);
    return !!rule && !!date && !!home.eventTz && (!until || until > date);
}

/**
 * Each of this key's pairs brought into step from its community's own word: an event or listing gone, cancelled, ended,
 * hidden or moved online there takes its copy down; a series between dates waits for the next round; a holiday there, or an
 * Offer or Need off the board for now, rests the copy, and its end brings it back; one waiting goes; one changed follows, and
 * one long unchanged is sent again. A community that gives no answer changes nothing.
 */
export function tendCopies(identity: BeanPoolIdentity, deps: CopyDeps = liveDeps, now: number = Date.now()): Promise<void> {
    const run = lastTend.then(() => tendPairs(identity, deps, now));
    lastTend = run.catch(() => {});
    return run;
}

/** One tend at a time: the app coming to the front and a holiday switched can overlap, and two would each rest a pair under a new id. */
let lastTend: Promise<unknown> = Promise.resolve();

async function tendPairs(identity: BeanPoolIdentity, deps: CopyDeps, now: number): Promise<void> {
    const holidays = new Map<string, Promise<boolean | 'later'>>();
    for (const { copyId } of (await readPairs()).filter((p) => p.publicKey === identity.publicKey)) {
        try {
            const pair = await storedPair(copyId);
            if (!pair) continue;
            if (pair.leaving) {
                await (pair.resting ? restCopy : takeDown)(pair, identity, deps);
                continue;
            }
            const home = await readHome(pair, identity, deps);
            if (home === 'later') continue;
            if (!mayHaveCopy(home, identity.publicKey)) {
                await takeDown(pair, identity, deps);
                continue;
            }
            const rests = restsAtHome(home);
            if (isEventEnded(home)) {
                if (!rollsOn(home)) await takeDown(pair, identity, deps);
                continue;
            }
            if (!rests && !holidays.has(pair.home)) holidays.set(pair.home, onHoliday(pair, identity, deps));
            const away = rests || await holidays.get(pair.home);
            if (away === 'later') continue;
            // About to rest a copy that has landed: taken down behind this phone (another phone, a moderator), it stays down. A
            // rest can't tell, since global answers a second remove as it does the first, and its return would post a new one.
            if (away && pair.sent && !pair.resting && (await forgetIfGone(pair, identity, deps).catch(() => null)) === false) continue;
            // Held by global's reports, or global didn't say: the copy stays as it is and the rest waits.
            if (away && pair.sent && !pair.resting && await restMustWait(pair, identity, deps)) continue;
            // Home may have taken a minute to say: only what is still stored, and not on its way out, goes on from here.
            const still = await storedPair(copyId);
            if (!still || still.leaving) continue;
            if (away) {
                if (!still.resting) await restCopy(still, identity, deps);
                continue;
            }
            if (still.sent !== JSON.stringify(copyFields(home, identity.publicKey)) || firstPhoto(home) !== still.photo || now - still.sentAt >= COPY_KEEP_ALIVE_MS) {
                await sendCopy({ ...still, resting: false }, home, identity, deps);
            }
            const current = await storedPair(copyId);
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

