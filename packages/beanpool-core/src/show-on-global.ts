/**
 * "Also show this on the global community" (DESIGN-list-on-global-fable.md §3-§4, reworked by DESIGN-reaching-across-fable.md;
 * slices G2′, G1′ and G3): the member's own copy of their in-person event, Offer or Need, posted by their own device to the
 * global community with their own key. The device is the only link: their community's server does nothing and learns nothing,
 * and global calls nobody. Both apps run this file (apps/native utils/show-on-global.ts, apps/pwa lib/show-on-global.ts); each
 * gives it where the pairs are kept and how to reach a node ({@link CopyKeeperSetup}).
 *
 * - **What goes.** The times, the rounded pin, the words, the photos, and the community's host and the event's id. Never
 *   the exact pin, the typed place or the note ({@link CopyKeeper.copyFields}). Nothing of the member's name: a copy shows no
 *   author, unless its member takes questions (below), and then global says it, not this file. An Offer or a Need sends its
 *   price as words (`shownPrice`), never as a price: nothing of a deal goes.
 * - **Who says where it is from.** Global, from its own directory (apps/server engine/event-copy.ts). The host goes for it
 *   to look up; a community that isn't listed gets no line and no door, and the member is told once.
 * - **Staying in step.** An edit, a cancel and a cancelled date repeat at the moment, and {@link CopyKeeper.tendCopies} catches
 *   up on what that missed: a device offline, a change made in the other app, an event moderated at home.
 *   An unchanged copy is sent again now and then, so a device still tending it keeps it past global's 90-day retention, and
 *   one that can't falls off by itself. The pairs live on the device alone: a new one tends nothing, and the copy stays the
 *   member's to take down from My posts on global.
 * - **A holiday at home.** The member's listings leave their community's board, and the copy leaves global with them. The
 *   pair stays, and when the holiday ends the copy goes back up as a new one ({@link CopyPair.resting}). So does an Offer or
 *   a Need that is off the board for now: paused, in a deal, out on loan, hidden by reports (`restsAtHome`).
 * - **A Stop showing stands.** A tap can land between any two steps of a tend, so each step goes by the pair as it is stored
 *   now: a pair that has gone stays gone, and a send that lands after it comes down (`recordSend`). It stands from
 *   either end: the host's page knows the home id and the copy's own page only the copy's ({@link CopyKeeper.stopShowing}), and a
 *   copy taken down behind this device isn't brought back by the next rest. A new tick is the member asking again: it posts a
 *   new copy under the next free id ({@link POST_ID_TAKEN_CODE}), and a return from a rest never does, since it would undo a
 *   Stop or a moderator's takedown it can't see.
 * - **Off the board, nothing goes.** A listing is only ever sent on its community's own word ({@link CopyKeeper.showOnGlobal}):
 *   the device's own row can be behind, and has nothing of a hide by reports.
 * - **Its door is global's word, and a tap's (slice GD).** "Take questions about this on the global community" goes by a request of
 *   its own ({@link CopyKeeper.takeQuestions}), never with an edit: a device that fell behind must not open a door the member has
 *   shut from the other one. A tap that didn't land stays owed, and `tendCopies` sends it, so an Off holds without an answer.
 *   An Off needs nothing but global: a tend sends every one before it asks any community, and it goes after a copy that is up
 *   whether or not this device heard it land. A rest reads the door from global first, and the copy goes back up as global last
 *   had it: off, if it can't say.
 * - **Safe to run again.** A pair and its copy's id are written before anything is sent, and a first send reads first, so a
 *   lost answer posts nothing twice. Refused for now (a day's limit, no answer), it stays waiting. Refused outright, the
 *   pair goes only once global says the copy isn't up (`followCopy`): it is the device's only way to that copy.
 * - **A phone and a browser on one account.** Each keeps its own pairs and neither knows the other, so the copy's id says which
 *   listing it is for, and only to the key itself ({@link copyIdOf}): both work out the same id, a first send reads what is
 *   there first and takes it up, and two first sends at once are one row. Each tends it; what they send is the same, and a
 *   copy taken down by one is left down by the other at its next look. A device that fell behind holds an id the other has moved
 *   on from, so a Stop showing goes after the listing, not one id, and never says it is done while a read can find the copy up
 *   ({@link CopyKeeper.stopShowing}). A rest moves a tick that never landed past no id, or the other device's first tick lands
 *   below where this one looks. The one thing that can't cross: a Stop showing on one device while the listing is off the
 *   board and the other holds the rest. Nothing is up on global to say so, and the other device brings it back once, where it
 *   reads Shown with Stop showing beside it.
 */
import { roundToArea } from './geo.js';
import type { RepeatPattern } from './event-repeat.js';
import { t } from './words.js';

const POSTS_PATH = '/api/marketplace/posts';
const PREFERENCES_PATH = '/api/members/preferences';
const QUESTIONS_PATH = `${POSTS_PATH}/takes-questions`;
/** How long one request gets, its answer's body included. React Native's fetch never gives up by itself. */
export const COPY_TIMEOUT_MS = 60_000;
/** A copy unchanged this long is sent again, so global's retention (90 days without a change) only takes an untended one. */
export const COPY_KEEP_ALIVE_MS = 30 * 24 * 60 * 60 * 1000;
/** A first send looks this many ids on from its own for a copy that is already there (`placeOf`), and tries at most this many. */
export const COPY_IDS_LOOKED_AT = 16;
/**
 * A node's word that a new post's id is held by a row it has (apps/server engine/posts.ts). In a code, because a device goes by
 * it and the words around it can change. It is the only word a device gets of a removed Offer or Need: a read by id answers
 * nothing for one, and the row stays for good, so its id is never free again.
 */
export const POST_ID_TAKEN_CODE = 'post_id_taken';
/** A listing carries at most this many photos (the node keeps five). */
export const BRING_MOST_PHOTOS = 5;
/** The node reads at most 2 MB of JSON (https-server.ts MAX_JSON_BODY_BYTES). Edits can build a listing past one body. */
const BODY_ROOM_CHARS = 1_900_000;

/** A photo a community already holds, as a new post sends it, or why it can't be had: `gone` for good, or `later`. */
export type FetchedPhoto = { photo: string } | { failed: 'gone' | 'later' };

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
    /** Which of this listing's ids `copyId` is ({@link copyIdOf}). A pair made before ids were worked out has none: read as 0. */
    generation?: number;
    sent: string;
    sentAt: number;
    /** The first photo URL last sent: a new one is a new photo. */
    photo: string;
    skips: string[];
    /** The copy is coming down, and global hasn't said it is: `tendCopies` asks again. */
    leaving?: boolean;
    /**
     * The member is on holiday at home: the copy comes down, and goes back up when they're back. With `leaving`, global hasn't
     * heard yet. Without it the copy is down and the pair holds a new id, since a copy taken down can't be brought back; a tick
     * that never landed took no id and has no copy, and holds the id it had.
     */
    resting?: boolean;
    /** The ids its copy had before a rest: a page left open on one, or a row still cached, still reaches this pair. */
    earlierIds?: string[];
    /** The member takes questions about it, as this device last asked or heard. Global holds the last word. */
    questions?: boolean;
    /** `questions` hasn't reached global yet: `tendCopies` sends it. */
    questionsOwed?: boolean;
}

export type CopyResult = 'shown' | 'shown-no-name' | 'later' | { refused: string };

/** The key a copy goes by. An app's own identity has more, and each signs in its own way. */
export interface CopyIdentity {
    publicKey: string;
}

/** How to reach a node, global included. A test hands in its own. */
export interface CopyDeps<I extends CopyIdentity = CopyIdentity> {
    global: string;
    get(url: string, path: string, identity: I, signal?: AbortSignal): Promise<Response>;
    post(url: string, path: string, body: unknown, identity: I, signal?: AbortSignal): Promise<Response>;
    del(url: string, path: string, identity: I, signal?: AbortSignal): Promise<Response>;
    fetchPhoto(url: string): Promise<FetchedPhoto>;
    /** The host global looks the community up by. */
    hostOf(home: string): string | null | Promise<string | null>;
}

/**
 * Where the pairs are kept. `change` takes the pairs as they stand and gives back what they are to be: where two tabs share
 * the store it is one transaction, so a tap in one can't be lost to a write from the other. `edit` runs synchronously.
 */
export interface CopyStore {
    read(): Promise<CopyPair[]>;
    change(edit: (pairs: CopyPair[]) => CopyPair[]): Promise<void>;
}

export interface CopyKeeperSetup<I extends CopyIdentity> {
    store: CopyStore;
    deps: CopyDeps<I>;
    /** {@link copyIdOf} by this identity's key. */
    copyId(homeId: string, generation: number, identity: I): Promise<string>;
    /** A home address in the one form a pair keeps it, or null. */
    plainOrigin(url: string): string | null;
    /** Has this date's end passed? */
    isEventEnded(home: HomeEvent): boolean;
}

export interface CopyKeeper<I extends CopyIdentity> {
    pairOf(homeId: string, publicKey: string): Promise<CopyPair | null>;
    mayShowOnGlobal(home: Pick<HomeEvent, 'eventOnline' | 'audienceScope' | 'authorPublicKey'> & Partial<Pick<HomeEvent, 'type' | 'lat' | 'lng' | 'originNode'>>, publicKey: string): boolean;
    copyFields(home: HomeEvent, publicKey: string): Record<string, unknown>;
    showOnGlobal(home: HomeEvent, homeUrl: string, identity: I, deps?: CopyDeps<I>, takesQuestions?: boolean): Promise<CopyResult>;
    takeQuestions(homeId: string, on: boolean, identity: I, deps?: CopyDeps<I>): Promise<CopyResult>;
    repeatOnCopy(home: HomeEvent, identity: I, deps?: CopyDeps<I>): Promise<void>;
    stopShowing(id: string, identity: I, deps?: CopyDeps<I>): Promise<boolean>;
    tendCopies(identity: I, deps?: CopyDeps<I>, now?: number): Promise<void>;
}

/** Online, from a node row (true) or a phone's cached one (1). */
export function isOnlineEvent(post: any): boolean {
    const v = post?.eventOnline ?? post?.event_online;
    return v === true || v === 1 || v === '1';
}

/**
 * A repeating event's rule and last date, from the node's row (camelCase `eventRepeat`) or a phone's cache (snake_case
 * `event_repeat`, JSON text). The pattern only: the host's clock and each date's length are the node's.
 */
export function eventRepeatOf(p: any): { rule: RepeatPattern | null; until: string | null } {
    let raw = p?.eventRepeat ?? p?.event_repeat ?? null;
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch { raw = null; }
    }
    const until = (p?.eventRepeatUntil ?? p?.event_repeat_until ?? null) as string | null;
    if (!raw || typeof raw !== 'object' || (raw.freq !== 'weekly' && raw.freq !== 'monthly')) return { rule: null, until: null };
    const { freq, interval, byDay, byMonthDay, pos } = raw;
    const rule = { freq, interval, ...(byDay ? { byDay } : {}), ...(byMonthDay != null ? { byMonthDay } : {}), ...(pos != null ? { pos } : {}) } as RepeatPattern;
    return { rule, until: typeof until === 'string' && until ? until : null };
}

/** The kinds of image a node stores, by the start of their base64 (engine/avatar.ts sniffRasterImageType). */
function imageMimeOf(base64: string): string | null {
    if (base64.startsWith('/9j/')) return 'image/jpeg';
    if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
    if (base64.startsWith('R0lGOD')) return 'image/gif';
    return base64.startsWith('UklGR') ? 'image/webp' : null;
}

/** A node stores no picture past 2 MB (MAX_PICTURE_BYTES): as base64, about this many characters. */
const MOST_PHOTO_CHARS = 2_800_000;

/** A fetched photo's bytes as a post sends them. A 200 that isn't an image (a captive portal's page) is no photo. */
export function fetchedPhotoOf(base64: string): FetchedPhoto {
    const mime = imageMimeOf(base64);
    return mime && base64.length <= MOST_PHOTO_CHARS ? { photo: `data:${mime};base64,${base64}` } : { failed: 'gone' };
}

function photoUrlOf(photo: unknown, from: string): string | null {
    if (typeof photo !== 'string' || !/^\/api\/marketplace\/posts\/[^/?#]+\/photos\/\d+(\?[^#]*)?$/.test(photo)) return null;
    return `${from}${photo}`;
}

/** The listing's photos as the data URLs a new post sends; `missed` could not be fetched, `later` might yet be. */
export async function photosOf(post: { photos?: string[] }, from: string, deps: { fetchPhoto(url: string): Promise<FetchedPhoto> }): Promise<{ photos: string[]; missed: number; later: boolean }> {
    const photos: string[] = [];
    let missed = 0;
    let later = false;
    let room = BODY_ROOM_CHARS;
    for (const photo of (post.photos ?? []).slice(0, BRING_MOST_PHOTOS)) {
        const url = photoUrlOf(photo, from);
        const got: FetchedPhoto = url ? await deps.fetchPhoto(url) : { failed: 'gone' };
        if ('photo' in got && got.photo.length <= room) {
            photos.push(got.photo);
            room -= got.photo.length;
        } else {
            missed++;
            later = later || ('failed' in got && got.failed === 'later');
        }
    }
    return { photos, missed, later };
}

const isListing = (home: Pick<HomeEvent, 'type'>): boolean => home.type === 'offer' || home.type === 'need';

/** Shown, waiting to be, or resting: it stays theirs to stop. */
const stillTheirs = (p: CopyPair) => !p.leaving || !!p.resting;

/** Coming back from a rest that took a copy down. A tick that never landed rests too, but never had a copy. */
const backFromRest = (p: CopyPair) => !!p.resting && !!p.earlierIds?.length;

const firstPhoto = (home: HomeEvent) => home.photos?.[0] ?? '';

/**
 * Runs a request and the reading of its answer, and gives up at {@link COPY_TIMEOUT_MS} whatever it is waiting on. Each tend
 * waits for the one before (`tendCopies`), so everything a tend waits on the network for goes through here.
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
async function answerOf(res: Response): Promise<{ done: any } | 'later' | { refused: string; code?: unknown }> {
    const answer: any = await res.json().catch(() => null);
    if (res.ok) return answer?.success === true ? { done: answer } : 'later';
    if (res.status === 401 || res.status === 408 || res.status === 429 || res.status >= 500) return 'later';
    return typeof answer?.error === 'string' && answer.error ? { refused: answer.error, code: answer.code } : 'later';
}

/** Nothing at home has stopped it. Whether its date has passed is another question (`rollsOn`). */
const isOn = (home: HomeEvent) => home.status === 'active' && home.active !== false && home.eventState !== 'cancelled' && !home.hiddenByReportsAt;

/** An Offer or a Need off its community's board for now: paused, in a deal, out on loan, hidden by reports. It can come back. */
function restsAtHome(home: HomeEvent): boolean {
    if (!isListing(home) || home.active === false) return false;
    return home.status === 'paused' || home.status === 'pending' || (home.status === 'active' && !!home.hiddenByReportsAt);
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

/** What a Stop showing owes the member when `stopShowing` answers false: the copy may still be up, and the row can't say so. */
export const stopLaterLine = () => t('It will come down from the global community as soon as it can.');

/** What an Off owes the member when global didn't answer: it is still owed, and the tick says what they asked for. */
export const questionsLaterLine = () => t('It will stop taking questions as soon as the global community answers.');

/** The one line a run owes the member, or none. */
export function copyResultLine(result: CopyResult): string | null {
    if (result === 'shown') return null;
    if (result === 'shown-no-name') return t("Your community isn't in the directory, so this shows there without its name.");
    if (result === 'later') return t('It will go up on the global community as soon as it can.');
    return result.refused;
}

/** One app's copies: the logic above and below, with its store and its way to the nodes. */
export function makeCopyKeeper<I extends CopyIdentity>(setup: CopyKeeperSetup<I>): CopyKeeper<I> {
    const { store, deps: liveDeps } = setup;

    const readPairs = () => store.read();

    /** The pair as it is stored now: a tap may have changed it, or taken it away, since it was read. */
    async function storedPair(copyId: string): Promise<CopyPair | undefined> {
        return (await readPairs()).find((p) => p.copyId === copyId);
    }

    async function savePair(pair: CopyPair): Promise<void> {
        await store.change((pairs) => [...pairs.filter((p) => p.copyId !== pair.copyId), pair]);
    }

    async function dropPair(pair: CopyPair): Promise<void> {
        await store.change((pairs) => pairs.filter((p) => p.copyId !== pair.copyId));
    }

    /**
     * This key's pair for a home event. By the home id alone: what follows a home event (an edit, a date) goes through here, and
     * a copy's row must never be taken for the event it copies. `stopShowing` is the one that takes a copy's id.
     */
    async function pairOf(homeId: string, publicKey: string): Promise<CopyPair | null> {
        return (await readPairs()).find((p) => p.homeId === homeId && p.publicKey === publicKey && stillTheirs(p)) ?? null;
    }

    /**
     * What the tick is for: the member's own event at a place, or their own Offer or Need with a place, for the whole community.
     * An enterprise's has the enterprise as its author, and a linked community's isn't theirs. The screens offer it for no other,
     * and this holds whatever a screen asks: what a group was told stays in the group.
     */
    const mayShowOnGlobal: CopyKeeper<I>['mayShowOnGlobal'] = (home, publicKey) => {
        const kind = isListing(home as HomeEvent) ? typeof home.lat === 'number' && typeof home.lng === 'number' && !home.originNode : (home.type ?? 'event') === 'event' && !isOnlineEvent(home);
        return kind && (home.audienceScope ?? 'public') === 'public' && home.authorPublicKey === publicKey;
    };

    /** What a copy holds, and all it holds. Nothing else of the event leaves the device. */
    function copyFields(home: HomeEvent, publicKey: string): Record<string, unknown> {
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

    /** What a node answers a read with, body and all. Null where it refused the read or answered with something else. */
    function readJson(url: string, path: string, identity: I, deps: CopyDeps<I>): Promise<unknown> {
        return withTimeout(async (signal) => {
            const res = await deps.get(url, path, identity, signal);
            return res.ok ? res.json().catch(() => null) : null;
        });
    }

    /**
     * Is the copy up on global? `later` when global didn't say. An event's copy taken down there still reads by id for its host,
     * as cancelled, for 30 days, and an Offer's or a Need's reads as nothing at once: neither is up, and an edit can't bring it back.
     */
    async function copyIsThere(pair: CopyPair, identity: I, deps: CopyDeps<I>): Promise<boolean | 'later'> {
        const rows = await readJson(deps.global, `${POSTS_PATH}?id=${encodeURIComponent(pair.copyId)}`, identity, deps);
        return Array.isArray(rows) ? rows.some((row) => row?.status !== 'cancelled') : 'later';
    }

    /**
     * Where a first send stands, from global's own word. This listing's ids run on from a copy taken down to the next one, so
     * the newest id global shows says it: up, and this send takes it up, wherever it was made; down, and the one after it is
     * free; none at all, and the pair's own may be. A read can't say more: a removed Offer or Need reads as nothing and keeps its
     * id, so `createCopy` hears it from the create. `later` when global didn't say. A copy at an id past
     * {@link COPY_IDS_LOOKED_AT} isn't seen by a device that has only now ticked.
     */
    async function placeOf(pair: CopyPair, identity: I, deps: CopyDeps<I>): Promise<{ generation: number; id: string; up: boolean } | 'later'> {
        const first = pair.generation ?? 0;
        const later = await Promise.all(Array.from({ length: COPY_IDS_LOOKED_AT - 1 }, (_, i) => setup.copyId(pair.homeId, first + 1 + i, identity)));
        const ids = [pair.copyId, ...later];
        const rows = await readJson(deps.global, `${POSTS_PATH}?ids=${ids.map(encodeURIComponent).join(',')}`, identity, deps);
        if (!Array.isArray(rows)) return 'later';
        const held = new Map<unknown, any>(rows.map((row) => [row?.id, row]));
        const newest = ids.reduce((found, id, i) => (held.has(id) ? i : found), -1);
        if (newest < 0) return { generation: first, id: pair.copyId, up: false };
        if (held.get(ids[newest])?.status !== 'cancelled') return { generation: first + newest, id: ids[newest], up: true };
        return { generation: first + newest + 1, id: ids[newest + 1] ?? await setup.copyId(pair.homeId, first + newest + 1, identity), up: false };
    }

    /** The pair takes the id global's word gave it. Null if a Stop showing took it meanwhile. */
    async function movedTo(pair: CopyPair, place: { generation: number; id: string }): Promise<CopyPair | null> {
        if (place.id === pair.copyId) return pair;
        const moved: CopyPair = { ...pair, copyId: place.id, generation: place.generation, earlierIds: [...(pair.earlierIds ?? []), pair.copyId] };
        let kept = false;
        await store.change((pairs) => {
            const stored = pairs.find((p) => p.copyId === pair.copyId);
            if (!stored || stored.leaving) return pairs;
            kept = true;
            return [...pairs.filter((p) => p.copyId !== pair.copyId && p.copyId !== place.id), moved];
        });
        return kept ? moved : null;
    }

    /**
     * Whether a rest has to wait: global's auto-hide leaves the row in place for its author, so `copyIsThere` reads a held copy
     * as up, and a rest would cancel it and the listing's return post the same words clean, with nobody having chosen that.
     * An unread answer waits too: a rest is the step that can't be taken back, and the next tend asks again.
     * A moderator's takedown leaves the stamp on a cancelled row: that one isn't held, and the rest may finish.
     */
    async function restMustWait(pair: CopyPair, identity: I, deps: CopyDeps<I>): Promise<boolean> {
        const rows = await readJson(deps.global, `${POSTS_PATH}?id=${encodeURIComponent(pair.copyId)}`, identity, deps).catch(() => null);
        if (!Array.isArray(rows)) return true;
        // What comes back after the rest is what global last had: the member's other device may have shut the door.
        if (rows.length > 0 && !pair.questionsOwed) {
            const open = rows.some((row) => row?.takesQuestions === true);
            await store.change((pairs) => pairs.map((p) => (p.copyId === pair.copyId && !p.questionsOwed ? { ...p, questions: open } : p)));
        }
        return rows.some((row) => !!row?.hiddenByReportsAt && row?.status !== 'cancelled');
    }

    /**
     * Global's word on the listing, where a device can't go by its own id: after a refusal, which doesn't say the copy has gone (a
     * mute, a date that has ended, a tag one library lacks, a second send of the same id), and before a rest. The pair goes only
     * if nothing is up. Otherwise it stays with the copy, moving on with it if the other device has, so a cancel at home can still
     * take it down and the next tend sees what wasn't sent and tries again. Gives the pair as it stands now: null if it went or
     * a Stop showing took it, `later` where global didn't say.
     */
    async function followCopy(pair: CopyPair, identity: I, deps: CopyDeps<I>): Promise<CopyPair | null | 'later'> {
        const place = await placeOf(pair, identity, deps);
        if (place === 'later') return 'later';
        if (place.up) return movedTo(pair, place);
        await dropPair(pair);
        return null;
    }

    /**
     * A send landed, and the pair takes it in. If a Stop showing came while it was on its way the pair stays gone, and what just
     * landed comes down, asked again in case that Stop's own remove got there first. A pair going to rest is left to its rest.
     */
    async function recordSend(sent: CopyPair, identity: I, deps: CopyDeps<I>, landedDoor?: boolean): Promise<void> {
        const stored = await storedPair(sent.copyId);
        if (stored && !stored.leaving) {
            // A tap on the door can land while this was on its way: it stands, and what global took says what is still owed.
            const owed = landedDoor === undefined ? stored.questionsOwed : !!stored.questions !== landedDoor;
            await savePair({ ...sent, questions: stored.questions, questionsOwed: owed });
        } else if (!stored?.resting) await takeDown(sent, identity, deps);
    }

    /**
     * `stepOn`: an id held by a copy that isn't up sends this on to the next one, as a tick does: the member is asking again. Each
     * try carries the photos, which global wants before it looks at the id, so the tries stop at {@link COPY_IDS_LOOKED_AT}.
     * Where a try has to wait, the pair keeps the id it reached and `tendCopies` goes on from there.
     */
    async function createCopy(first: CopyPair, home: HomeEvent, identity: I, deps: CopyDeps<I>, stepOn: boolean): Promise<CopyResult> {
        const { photos, later } = await photosOf({ photos: (home.photos ?? []).slice(0, BRING_MOST_PHOTOS) }, first.home, deps);
        if (photos.length === 0 && later) return 'later';
        const door = first.questions ? { takesQuestions: true } : {};
        const fields = { ...copyFields(home, identity.publicKey), photos, shownFrom: { host: await deps.hostOf(first.home), postId: first.homeId, ...door } };
        let pair = first;
        for (let tries = 1; ; tries++) {
            const body = { id: pair.copyId, ...fields };
            const answer = await withTimeout(async (signal) => answerOf(await deps.post(deps.global, POSTS_PATH, body, identity, signal)));
            if (answer === 'later') return 'later';
            if (!('refused' in answer)) {
                // A global that predates copies made a plain event of it, with the member's name on: it comes down at once.
                if (answer.done.post?.shownCopy !== true) {
                    await withTimeout((signal) => deps.post(deps.global, `${POSTS_PATH}/remove`, { id: pair.copyId, authorPublicKey: identity.publicKey }, identity, signal)).catch(() => null);
                    await dropPair(pair);
                    return { refused: t("The global community can't show this yet.") };
                }
                await recordSend({ ...pair, sent: JSON.stringify(copyFields(home, identity.publicKey)), sentAt: Date.now(), photo: firstPhoto(home) }, identity, deps, answer.done.post?.takesQuestions === true);
                return answer.done.post?.shownFrom ? 'shown' : 'shown-no-name';
            }
            // Up all the same: this was a second send of the id (an edit made during the upload, or the member's other device),
            // and the first one landed.
            const there = await copyIsThere(pair, identity, deps);
            if (there === 'later') return 'later';
            if (there) return 'shown';
            const taken = answer.code === POST_ID_TAKEN_CODE;
            if (!taken || !stepOn || tries >= COPY_IDS_LOOKED_AT) {
                await dropPair(pair);
                return { refused: taken ? t("The global community can't show this yet.") : answer.refused };
            }
            const generation = (pair.generation ?? 0) + 1;
            const moved = await movedTo(pair, { generation, id: await setup.copyId(pair.homeId, generation, identity) });
            if (!moved) return 'later';
            pair = moved;
        }
    }

    async function updateCopy(pair: CopyPair, home: HomeEvent, identity: I, deps: CopyDeps<I>): Promise<CopyResult> {
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
            await followCopy(pair, identity, deps);
            return answer;
        }
        await recordSend({ ...pair, sent: JSON.stringify(fields), sentAt: Date.now(), photo: fetched?.photos.length ? firstPhoto(home) : pair.photo }, identity, deps);
        return 'shown';
    }

    /**
     * `stepOn`: {@link createCopy}'s. Only a return from a rest goes without, and that holds for a read as for a refusal: an
     * event's cancelled copy reads, so `placeOf` would have it step past what the other device or a moderator took down.
     */
    async function sendCopy(pair: CopyPair, home: HomeEvent, identity: I, deps: CopyDeps<I>, stepOn = true): Promise<CopyResult> {
        try {
            if (pair.sent) return await updateCopy(pair, home, identity, deps);
            const place = await placeOf(pair, identity, deps);
            if (place === 'later') return 'later';
            if (!stepOn && !place.up && place.id !== pair.copyId) {
                await dropPair(pair);
                return { refused: t("The global community can't show this yet.") };
            }
            const placed = await movedTo(pair, place);
            if (!placed) return 'later';
            return place.up ? await updateCopy({ ...placed, sent: 'lost', photo: firstPhoto(home) }, home, identity, deps) : await createCopy(placed, home, identity, deps, stepOn);
        } catch {
            return 'later';
        }
    }

    /** What the pair owes global of its door. Refused, global's word stands: an Off that finds no copy has nothing to shut. */
    async function sendQuestions(pair: CopyPair, identity: I, deps: CopyDeps<I>): Promise<CopyResult> {
        const on = !!pair.questions;
        const answer = await withTimeout(async (signal) => answerOf(await deps.post(deps.global, QUESTIONS_PATH, { id: pair.copyId, on }, identity, signal)));
        if (answer === 'later') return 'later';
        if ('refused' in answer) {
            // The member's other device may have moved the copy on: the door goes with the listing, not one id.
            const followed = await followCopy(pair, identity, deps);
            if (followed === 'later') return 'later';
            if (followed && followed.copyId !== pair.copyId) return sendQuestions(followed, identity, deps);
            // Up, and global wouldn't shut it: the door is still open, so the Off stays owed and the member hears why.
            if (followed && !on) return answer;
            await store.change((pairs) => pairs.map((p) => (p.copyId === pair.copyId ? { ...p, questions: false, questionsOwed: false } : p)));
            return on ? answer : 'shown';
        }
        await store.change((pairs) => pairs.map((p) => (p.copyId === pair.copyId && !!p.questions === on ? { ...p, questionsOwed: false } : p)));
        return 'shown';
    }

    /**
     * Sends what a pair owes, if it stays up. A pair still to land carries it with the create, and a rest with its return. An Off
     * can't wait for that: a first send whose answer was lost is up, door and all, so global is asked, and only global.
     */
    async function settleQuestions(copyId: string, identity: I, deps: CopyDeps<I>): Promise<CopyResult | null> {
        const pair = await storedPair(copyId);
        if (!pair?.questionsOwed || pair.resting || pair.leaving) return null;
        if (pair.sent) return sendQuestions(pair, identity, deps);
        if (pair.questions) return null;
        const place = await placeOf(pair, identity, deps);
        if (place === 'later') return 'later';
        const placed = place.up ? await movedTo(pair, place) : null;
        return placed ? sendQuestions(placed, identity, deps) : null;
    }

    /** The tick beside "Shown on the global community". `later`: global didn't answer, and it is tried again. */
    async function takeQuestions(homeId: string, on: boolean, identity: I, deps: CopyDeps<I> = liveDeps): Promise<CopyResult> {
        const pair = await pairOf(homeId, identity.publicKey);
        if (!pair) return { refused: t("The global community can't show this yet.") };
        await savePair({ ...pair, questions: on, questionsOwed: true });
        return (await settleQuestions(pair.copyId, identity, deps).catch(() => 'later' as const)) ?? 'shown';
    }

    /** The dates cancelled at home, cancelled on the copy; a date brought back, brought back. */
    async function repeatDates(pair: CopyPair, home: HomeEvent, identity: I, deps: CopyDeps<I>): Promise<void> {
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
     * `tendCopies` sends it. `homeUrl` is the community the event is on.
     *
     * An Offer or a Need goes on its community's word, not the screen's: the row a screen holds can be behind, and has nothing of
     * a hide by reports. Off the board for now, nothing is sent and the tick rests until it is back; gone, it is refused. Home
     * not saying, it waits: `tendCopies` asks again before it sends.
     */
    async function showOnGlobal(home: HomeEvent, homeUrl: string, identity: I, deps: CopyDeps<I> = liveDeps, takesQuestions = false): Promise<CopyResult> {
        const refused = { refused: t("The global community can't show this yet.") };
        if (!mayShowOnGlobal(home, identity.publicKey)) return refused;
        const kept = await pairOf(home.id, identity.publicKey);
        if (kept?.resting) return 'later';
        const pair: CopyPair = {
            ...(kept ?? {
                publicKey: identity.publicKey, home: setup.plainOrigin(homeUrl) ?? homeUrl, homeId: home.id,
                copyId: await setup.copyId(home.id, 0, identity), generation: 0, sent: '', sentAt: 0, photo: '', skips: [],
            }),
            ...(takesQuestions ? { questions: true, questionsOwed: true } : {}),
        };
        if (isListing(home)) {
            const atHome = await readHome(pair, identity, deps).catch(() => 'later' as const);
            if (atHome === 'later') {
                await savePair(pair);
                return 'later';
            }
            if (!mayHaveCopy(atHome, identity.publicKey)) return refused;
            if (restsAtHome(atHome)) {
                // A pair held may have a copy up to bring down, unless reports hold it. A new one has nothing up, which is what
                // `resting` without `leaving` says.
                if (kept && !kept.resting && await restMustWait(kept, identity, deps)) return 'later';
                await (kept ? restCopy((await storedPair(kept.copyId)) ?? kept, identity, deps) : savePair({ ...pair, resting: true }));
                return 'later';
            }
        }
        await savePair(pair);
        const result = await sendCopy(pair, home, identity, deps);
        // A first send that found the copy up made an edit of it, and an edit says nothing of the door.
        const now = await pairOf(home.id, identity.publicKey);
        if (now) await settleQuestions(now.copyId, identity, deps).catch(() => 'later' as const);
        return result;
    }

    /**
     * After an edit or a cancelled date at home: the copy follows, or comes down if the edit made it an event that can't be
     * shown (moved online: it has no point to send). Nothing is said: a miss is caught up by `tendCopies`.
     */
    async function repeatOnCopy(home: HomeEvent, identity: I, deps: CopyDeps<I> = liveDeps): Promise<void> {
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

    /** Asks global to take one copy down. `later` when it didn't answer. */
    function askRemove(id: string, identity: I, deps: CopyDeps<I>): ReturnType<typeof answerOf> {
        return withTimeout(async (signal) => answerOf(await deps.post(deps.global, `${POSTS_PATH}/remove`, { id, authorPublicKey: identity.publicKey }, identity, signal)))
            .catch(() => 'later' as const);
    }

    /** Asks global to take the copy down, the pair marked first. False when global didn't answer, and it stays marked. */
    async function askDown(pair: CopyPair, identity: I, deps: CopyDeps<I>): Promise<boolean> {
        await savePair({ ...pair, leaving: true });
        return (await askRemove(pair.copyId, identity, deps)) !== 'later';
    }

    /**
     * Is nothing of this listing left up, from this pair's id on? A copy found up comes down. False where global didn't say, or
     * wouldn't take it down. One read, of at most {@link COPY_IDS_LOOKED_AT} ids. A new tick on this device is left alone: what is
     * up past a pair on its way out is what the member has asked for since.
     */
    async function nothingLeftUp(pair: CopyPair, identity: I, deps: CopyDeps<I>): Promise<boolean> {
        const ticked = (await readPairs()).some((p) => p.homeId === pair.homeId && p.publicKey === pair.publicKey && p.copyId !== pair.copyId && !p.leaving);
        if (ticked) return true;
        const place = await placeOf(pair, identity, deps).catch(() => 'later' as const);
        if (place === 'later') return false;
        if (!place.up) return true;
        const answer = await askRemove(place.id, identity, deps);
        return answer !== 'later' && !('refused' in answer);
    }

    /**
     * The copy comes down and the pair goes. It goes after the listing, not one id: the member's other device may have moved the
     * copy on (a rest and its return, a new tick), and global answers a remove of the id left behind as it does the first. False
     * when global didn't answer, or can't be read to say the copy is down, or wouldn't take it down: the pair stays `leaving` and
     * `tendCopies` tries again. A resting pair has nothing of its own up, so global is only read, for the other device having
     * come back.
     */
    async function takeDown(pair: CopyPair, identity: I, deps: CopyDeps<I>): Promise<boolean> {
        const nothingUp = pair.resting && !pair.leaving;
        if (nothingUp) await savePair({ ...pair, resting: false, leaving: true });
        else if (!(await askDown({ ...pair, resting: false }, identity, deps))) return false;
        if (!(await nothingLeftUp(pair, identity, deps))) return false;
        await dropPair(pair);
        return true;
    }

    /**
     * A holiday at home: the copy comes down and the pair waits with a new id for the holiday to end. A Stop showing while global
     * was being asked has the last word: `takeDown` saves `resting: false` before it asks, and drops the pair after.
     *
     * A tick that never landed took no id, so it rests where it is: gone on to the next, it would look past the one it left free,
     * where the other device's first tick lands. A first send whose answer was lost is up, so global is read to say which this
     * is. A Stop or a send can land during that read, and stands: what the read says goes by the pair as it is stored now.
     */
    async function restCopy(pair: CopyPair, identity: I, deps: CopyDeps<I>): Promise<void> {
        if (!pair.sent && !pair.leaving) {
            const there = await copyIsThere(pair, identity, deps).catch(() => 'later' as const);
            if (there === 'later') return;
            if (!there) {
                await store.change((pairs) => pairs.map((p) => (p.copyId === pair.copyId && !p.leaving && !p.sent ? { ...p, resting: true } : p)));
                return;
            }
            const stored = await storedPair(pair.copyId);
            if (!stored || stored.leaving) return;
        }
        if (!(await askDown({ ...pair, resting: true }, identity, deps))) return;
        const generation = (pair.generation ?? 0) + 1;
        const waiting: CopyPair = {
            ...pair, leaving: false, resting: true, copyId: await setup.copyId(pair.homeId, generation, identity), generation,
            sent: '', sentAt: 0, photo: '', skips: [], earlierIds: [...(pair.earlierIds ?? []), pair.copyId],
        };
        await store.change((pairs) => {
            const stored = pairs.find((p) => p.copyId === pair.copyId);
            return stored?.resting ? [...pairs.filter((p) => p.copyId !== pair.copyId), { ...waiting, questions: stored.questions, questionsOwed: stored.questionsOwed }] : pairs;
        });
    }

    /**
     * Stop showing, and a cancel at home: the copy goes, and the pair with it, or the next rest brings the copy back. False when
     * global didn't answer, and it is tried again. `id` is the home event's from the host's page and the copy's from its own
     * (a deletion hands on whichever it was given), which may be an id from before a rest. A pair already on its way out is
     * asked after again: its copy may still be up, so it can't answer true by being out of sight.
     */
    async function stopShowing(id: string, identity: I, deps: CopyDeps<I> = liveDeps): Promise<boolean> {
        const named = (await readPairs()).filter((p) => p.publicKey === identity.publicKey
            && (p.homeId === id || p.copyId === id || p.earlierIds?.includes(id)));
        const pair = named.find(stillTheirs) ?? named[0];
        return pair ? takeDown(pair, identity, deps) : true;
    }

    /** The event from its community, null where it is gone, `later` where the community didn't say. */
    async function readHome(pair: CopyPair, identity: I, deps: CopyDeps<I>): Promise<HomeEvent | null | 'later'> {
        const rows = await readJson(pair.home, `${POSTS_PATH}?id=${encodeURIComponent(pair.homeId)}`, identity, deps);
        return Array.isArray(rows) ? (rows[0] as HomeEvent | undefined) ?? null : 'later';
    }

    /** Is the member on holiday at their community? `later` where it didn't say: a pair changes on its word alone. */
    async function onHoliday(pair: CopyPair, identity: I, deps: CopyDeps<I>): Promise<boolean | 'later'> {
        const prefs: any = await readJson(pair.home, `${PREFERENCES_PATH}?publicKey=${encodeURIComponent(identity.publicKey)}`, identity, deps);
        return prefs && typeof prefs === 'object' ? prefs.holiday_mode === 'true' : 'later';
    }

    /** Can this post have a copy at all, up or resting? Not one gone, cancelled, finished, hidden for good or that can't be shown. */
    function mayHaveCopy(home: HomeEvent | null, publicKey: string): home is HomeEvent {
        return !!home && (isOn(home) || restsAtHome(home)) && mayShowOnGlobal(home, publicKey);
    }

    /** One tend at a time: the app coming to the front and a holiday switched can overlap, and two would each rest a pair. */
    let lastTend: Promise<unknown> = Promise.resolve();

    /**
     * Each of this key's pairs brought into step from its community's own word: an event or listing gone, cancelled, ended,
     * hidden or moved online there takes its copy down; a series between dates waits for the next round; a holiday there, or an
     * Offer or Need off the board for now, rests the copy, and its end brings it back; one waiting goes; one changed follows, and
     * one long unchanged is sent again. A community that gives no answer changes nothing.
     */
    function tendCopies(identity: I, deps: CopyDeps<I> = liveDeps, now: number = Date.now()): Promise<void> {
        const run = lastTend.then(() => tendPairs(identity, deps, now));
        lastTend = run.catch(() => {});
        return run;
    }

    async function tendPairs(identity: I, deps: CopyDeps<I>, now: number): Promise<void> {
        const holidays = new Map<string, Promise<boolean | 'later'>>();
        const mine = async () => (await readPairs()).filter((p) => p.publicKey === identity.publicKey);
        // An Off needs nothing but global, so all of them go before any community is asked. In the loop below, a community that
        // hangs would hold up the next pair's by a timeout for each pair before it.
        for (const pair of await mine()) {
            if (pair.questionsOwed && !pair.questions) await settleQuestions(pair.copyId, identity, deps).catch(() => null);
        }
        for (const { copyId } of await mine()) {
            try {
                let pair = await storedPair(copyId);
                if (!pair) continue;
                if (pair.leaving) {
                    // The rest's retry asks again: reports may have held the copy since the first remove went unanswered.
                    if (pair.resting && await restMustWait(pair, identity, deps)) continue;
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
                if (setup.isEventEnded(home)) {
                    if (!rollsOn(home)) await takeDown(pair, identity, deps);
                    continue;
                }
                if (!rests && !holidays.has(pair.home)) holidays.set(pair.home, onHoliday(pair, identity, deps));
                const away = rests || await holidays.get(pair.home);
                if (away === 'later') continue;
                // About to rest a copy that has landed, by global's word on the listing. Taken down behind this device (the member's other
                // one, a moderator), it stays down: a rest can't tell, since global answers a second remove as it does the first, and
                // its return would post a new one. Moved on by the other device, it is this rest's: let go, it stays up with the listing
                // off the board until that device next opens. Global not saying, the rest waits: it is the step that can't be taken back.
                if (away && pair.sent && !pair.resting) {
                    const followed = await followCopy(pair, identity, deps);
                    if (!followed || followed === 'later') continue;
                    pair = followed;
                }
                // Held by global's reports, or global didn't say: the copy stays as it is and the rest waits.
                if (away && !pair.resting && await restMustWait(pair, identity, deps)) continue;
                // Home may have taken a minute to say: only what is still stored, and not on its way out, goes on from here.
                const still = await storedPair(pair.copyId);
                if (!still || still.leaving) continue;
                if (away) {
                    if (!still.resting) await restCopy(still, identity, deps);
                    continue;
                }
                if (still.sent !== JSON.stringify(copyFields(home, identity.publicKey)) || firstPhoto(home) !== still.photo || now - still.sentAt >= COPY_KEEP_ALIVE_MS) {
                    // A rest's return finding its next id held: the member's other device came back first, and that copy was taken
                    // down. It isn't brought back past that. A tick still waiting to land does go on.
                    await sendCopy({ ...still, resting: false }, home, identity, deps, !backFromRest(still));
                }
                const current = await storedPair(copyId);
                if (current?.sent) {
                    await repeatDates(current, home, identity, deps);
                    await settleQuestions(copyId, identity, deps);
                }
            } catch { /* the next time round */ }
        }
    }

    return { pairOf, mayShowOnGlobal, copyFields, showOnGlobal, takeQuestions, repeatOnCopy, stopShowing, tendCopies };
}
