/**
 * Bring my listings (DESIGN-global-lounge-fable.md §2.5 B, slice L7): the weeks a member spent on the global community
 * were not wasted. At their first join of a local community the phone notes an offer, Home asks once the profile step is
 * done (components/BringListingsSheet.tsx), and on a yes the phone posts each of their own Offers and Needs to the new
 * community, as new posts, signed by the same key.
 *
 * Nothing here is a route of its own, and no community talks to another: the phone reads its member's listings from the
 * global community, fetches their photos as any phone does, and sends the new community the ordinary
 * `POST /api/marketplace/posts`, so its rules are the rules of any new post. Global is told nothing of where they went.
 *
 * - **The node decides.** A listing with no photo left is still sent: the community's own photo rule answers (every node
 *   today refuses it, `Add a photo first`), and a refusal is a line on the sheet, never a post that breaks the rule.
 * - **The order is the node's too.** Offers go first: a community with Beans takes a Need only from a member who has
 *   listed an Offer (core postRulesFor). Oldest first, so the newest ends up newest there.
 * - **Safe to run again.** Each post's id comes from the listing and the community (`broughtId`), and a run first reads
 *   what the community already holds, so a run cut off halfway, or an answer lost on the way back, posts nothing twice.
 * - **Offline.** The offer is kept (`beanpool_bring_listings`) until the run ends: a community that can't be reached
 *   means no sheet yet, or the rest tried again from Home with no second question.
 * - **Never a gate.** Joining never waits on any of this, and it can be put off or ignored.
 *
 * Archived means off the Market with its photos deleted (engine/posts.ts archiveStaleListings): the row has no mark of its
 * own, and the same `cancelled` with its photos still there is a listing its member took down, which needs no line. Past
 * the 90 days the run takes a taken-down listing's photos too, and it reads as archived: the line is true of both.
 *
 * Phone only for now, deliberately (the design's row): the web app is one community per browser. It says nothing of
 * this, and its members' listings stay where they are.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { t, tn } from '@beanpool/core';
import { BRING_LISTINGS_STORE_KEY } from './storage-keys';
import { getCachedNodeProfile, GLOBAL_NODE_URL } from './node-profile';
import { plainOriginOf } from './node-url';
import { signedGet, signedPost } from './node-post';
import type { BeanPoolIdentity } from './identity';
import type { FetchedPhoto } from './post-photo';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long an unanswered or unfinished offer is kept. The listings themselves are archived at 90 days. */
export const BRING_OFFER_KEEP_MS = 30 * DAY_MS;
/** How long "Not now" holds the sheet back. It asks once more, then never. */
export const BRING_ASK_AGAIN_MS = DAY_MS;
/** A photo the community couldn't give now is asked for on this many runs; on the last, the listing goes without it. */
export const BRING_MOST_TRIES = 3;
/** A listing carries at most this many photos (the node keeps five). */
export const BRING_MOST_PHOTOS = 5;
/** The node reads at most 2 MB of JSON (https-server.ts MAX_JSON_BODY_BYTES). Edits can build a listing past one body. */
const BODY_ROOM_CHARS = 1_900_000;
const POSTS_PATH = '/api/marketplace/posts';
const PAGE_ROWS = 200;
const MOST_PAGES = 25;
const READ_TIMEOUT_MS = 15_000;
const POST_TIMEOUT_MS = 60_000;

export interface BringOffer {
    publicKey: string;
    from: string;
    to: string;
    /** The new community's name, as the join heard it. */
    name: string;
    at: number;
    /** The member said yes: later runs ask nothing. */
    accepted?: boolean;
    /** Runs since the yes that left something for later. */
    tries?: number;
    /** "Not now"s so far. */
    asks?: number;
    notBefore?: number;
}

/** What the phone keeps: an offer, or that this key had its one (`closed`). */
type Stored = BringOffer | { publicKey: string; closed: true };

/** A listing as `GET /api/marketplace/posts` gives it to its author: only what is read here. */
export interface OwnListing {
    id: string;
    type: 'offer' | 'need';
    category: string;
    title: string;
    description?: string;
    credits?: number;
    priceType?: string;
    authorPublicKey: string;
    createdAt?: string;
    active?: boolean;
    status?: string;
    repeatable?: boolean;
    cashAlsoNeeded?: boolean;
    lendable?: boolean;
    lendMaxDays?: number;
    lendTerms?: string;
    replacementValue?: string;
    lat?: number | null;
    lng?: number | null;
    photos?: string[];
    tags?: string[];
    originNode?: string;
    audienceScope?: string;
    hiddenByReportsAt?: string | null;
}

export interface BringPlan {
    /** Still to bring: Offers, then Needs, each oldest first. */
    bring: OwnListing[];
    /** The titles of listings no longer up: archived, or hidden after reports. */
    gone: string[];
}

export type BringLine =
    /** Off the Market on the global community. */
    | { kind: 'gone'; title: string }
    /** Came, with fewer photos than it has there. */
    | { kind: 'fewer-photos'; title: string }
    /** None of its photos could be fetched, and the community wants one. */
    | { kind: 'photos-failed'; title: string }
    /** It has no photo, and the community wants one. */
    | { kind: 'no-photo'; title: string }
    /** The community refused it, in its own words. */
    | { kind: 'refused'; title: string; reason: string }
    /** The community refused the member, in its own words: no listing would go. */
    | { kind: 'held'; reason: string };

export interface BringResult {
    brought: number;
    lines: BringLine[];
    /** Something is left for a later run (a community that didn't answer, a photo it couldn't give now). */
    kept: boolean;
    /** The community wants something of the member first (a profile photo): the question comes back. */
    held: boolean;
}

export interface BringDeps {
    get(url: string, path: string, identity: BeanPoolIdentity, signal?: AbortSignal): Promise<Response>;
    post(url: string, path: string, body: unknown, identity: BeanPoolIdentity, signal?: AbortSignal): Promise<Response>;
    fetchPhoto(url: string): Promise<FetchedPhoto>;
    /** The profile the phone holds, sent to the community that says it has no photo (utils/db.ts pushProfileToServer). */
    healProfile(community: string): Promise<boolean>;
}

const liveDeps: BringDeps = {
    get: signedGet,
    post: signedPost,
    // Loaded when used: the sheet is on Home, and these are for the one run most members never make.
    fetchPhoto: async (url) => (await import('./post-photo')).fetchedPostPhoto(url),
    healProfile: async (community) => (await import('./db')).pushProfileToServer({ community }),
};

async function readStored(): Promise<Stored | null> {
    const raw = await AsyncStorage.getItem(BRING_LISTINGS_STORE_KEY).catch(() => null);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed.publicKey === 'string' ? parsed as Stored : null;
    } catch {
        return null;
    }
}

const store = (value: Stored) => AsyncStorage.setItem(BRING_LISTINGS_STORE_KEY, JSON.stringify(value));

/** The node says it is the global community, or it is the one this app ships with. */
async function isGlobalCommunity(origin: string): Promise<boolean> {
    if (origin === plainOriginOf(GLOBAL_NODE_URL)) return true;
    return (await getCachedNodeProfile(origin).catch(() => null))?.profile === 'global';
}

/**
 * Called when a join succeeds (utils/join-another-community.ts). An offer is made once a key: for its first join of a
 * local community from the global one. True when one was noted.
 */
export async function noteBringOffer(o: { publicKey: string; from: string | null; to: string; name: string; alreadyMember: boolean; now?: number }): Promise<boolean> {
    if (o.alreadyMember || !o.from) return false;
    const from = plainOriginOf(o.from);
    const to = plainOriginOf(o.to);
    if (!from || !to || from === to) return false;
    if (!(await isGlobalCommunity(from)) || await isGlobalCommunity(to)) return false;
    if ((await readStored())?.publicKey === o.publicKey) return false;
    await store({ publicKey: o.publicKey, from, to, name: o.name, at: o.now ?? Date.now() });
    return true;
}

/** The offer for this key on the community the phone is on, if it is time for one. */
export async function pendingBringOffer(publicKey: string, here: string | null, now: number = Date.now()): Promise<BringOffer | null> {
    const held = await readStored();
    if (!held || held.publicKey !== publicKey || 'closed' in held) return null;
    if (now - held.at > BRING_OFFER_KEEP_MS) {
        await closeBringOffer(publicKey);
        return null;
    }
    if (!here || plainOriginOf(here) !== held.to) return null;
    return (held.notBefore ?? 0) > now ? null : held;
}

/** This key's one offer is over: answered, finished, or out of date. No later join makes another. */
export async function closeBringOffer(publicKey: string): Promise<void> {
    await store({ publicKey, closed: true });
}

/** "Not now": asked once more a day later, then never. */
export async function putOffBringOffer(offer: BringOffer, now: number = Date.now()): Promise<void> {
    if ((offer.asks ?? 0) >= 1) return closeBringOffer(offer.publicKey);
    await store({ ...offer, accepted: false, asks: (offer.asks ?? 0) + 1, notBefore: now + BRING_ASK_AGAIN_MS });
}

/** What the end of a run leaves: the offer closed, kept for another run, or asked again. */
export async function settleBringOffer(offer: BringOffer, result: BringResult, now: number = Date.now()): Promise<void> {
    if (result.held) return putOffBringOffer(offer, now);
    if (!result.kept) return closeBringOffer(offer.publicKey);
    await store({ ...offer, accepted: true, tries: (offer.tries ?? 0) + 1 });
}

/** Marked at the yes, so a phone that dies during the run goes on from Home without asking again. */
export async function acceptBringOffer(offer: BringOffer): Promise<BringOffer> {
    const accepted = { ...offer, accepted: true };
    await store(accepted);
    return accepted;
}

/**
 * A listing's id on the community it is brought to: the same each run, so a run again finds it there. Its own, not the
 * global one's: two communities can link and pull each other's listings, and each id must name one post.
 */
export function broughtId(postId: string, to: string): string {
    const hex = bytesToHex(sha256(utf8ToBytes(`${to}\n${postId}`)));
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await run(controller.signal);
    } finally {
        clearTimeout(timer);
    }
}

/** The member's listings on `url`, in every state: a number is the status of a refusal; no answer throws. */
async function ownListings(url: string, identity: BeanPoolIdentity, deps: BringDeps): Promise<OwnListing[] | number> {
    const rows: OwnListing[] = [];
    let next: string | null = null;
    for (let page = 0; page < MOST_PAGES; page++) {
        const path: string = `${POSTS_PATH}?author=${encodeURIComponent(identity.publicKey)}&types=offer,need&sync=true&paged=1&limit=${PAGE_ROWS}`
            + (next ? `&pageAfter=${encodeURIComponent(next)}` : '');
        const res: Response = await withTimeout(READ_TIMEOUT_MS, (signal) => deps.get(url, path, identity, signal));
        if (!res.ok) return res.status;
        const body: unknown = await res.json();
        if (!Array.isArray(body)) throw new Error('not a list of listings');
        rows.push(...body as OwnListing[]);
        next = res.headers.get('X-Posts-Next');
        if (!next) break;
    }
    return rows;
}

const hasNoPhoto = (p: OwnListing) => !Array.isArray(p.photos) || p.photos.length === 0;
const typeOrder = (p: OwnListing) => (p.type === 'offer' ? 0 : 1);

/**
 * What a run would do, from both communities' own answers. `unreachable`: one of them gave none, so the offer is kept.
 * `nothing`: the global community won't read this key's listings (no account there any more), so there is nothing to bring.
 */
export async function planBring(offer: BringOffer, identity: BeanPoolIdentity, deps: BringDeps = liveDeps): Promise<BringPlan | 'unreachable' | 'nothing'> {
    let rows: OwnListing[] | number;
    let there: OwnListing[] | number;
    try {
        rows = await ownListings(offer.from, identity, deps);
        if (typeof rows === 'number') return rows === 403 || rows === 404 ? 'nothing' : 'unreachable';
        there = await ownListings(offer.to, identity, deps);
    } catch {
        return 'unreachable';
    }
    if (typeof there === 'number') return 'unreachable';
    const held = new Set(there.map((p) => p.id));
    // Their own, for everyone, written here: never a group's, one for one person, or a copy of another community's.
    const mine = rows.filter((p) => p.authorPublicKey === identity.publicKey && !p.originNode && (p.type === 'offer' || p.type === 'need')
        && (p.audienceScope ?? 'public') === 'public');
    const isUp = (p: OwnListing) => p.status === 'active' && p.active !== false && !p.hiddenByReportsAt;
    const bring = mine.filter(isUp).filter((p) => !held.has(broughtId(p.id, offer.to)))
        .sort((a, b) => typeOrder(a) - typeOrder(b) || String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
    const gone = mine.filter((p) => !isUp(p) && (!!p.hiddenByReportsAt || (p.status === 'cancelled' && hasNoPhoto(p)))).map((p) => p.title);
    return { bring, gone };
}

/** A photo URL of this listing on this community, whole: anything else in the row is never fetched. */
function photoUrlOf(photo: unknown, from: string): string | null {
    if (typeof photo !== 'string' || !/^\/api\/marketplace\/posts\/[^/?#]+\/photos\/\d+(\?[^#]*)?$/.test(photo)) return null;
    return `${from}${photo}`;
}

/** The listing's photos as the data URLs a new post sends; `missed` could not be fetched, `later` might yet be. */
async function photosOf(post: OwnListing, from: string, deps: BringDeps): Promise<{ photos: string[]; missed: number; later: boolean }> {
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

/** The new post: the listing's own words, place and terms. Its reach starts at the community, as any new post's. */
function postBody(post: OwnListing, id: string, publicKey: string, photos: string[]): Record<string, unknown> {
    return {
        id,
        type: post.type,
        category: post.category,
        title: post.title,
        description: post.description ?? '',
        credits: Number(post.credits) || 0,
        priceType: post.priceType || 'fixed',
        authorPublicKey: publicKey,
        ...(typeof post.lat === 'number' && typeof post.lng === 'number' ? { lat: post.lat, lng: post.lng } : {}),
        photos,
        repeatable: post.repeatable === true,
        cashAlsoNeeded: post.cashAlsoNeeded === true,
        // As the composers send them: none is no field. A tag this community's library doesn't know yet is refused in its words.
        ...(post.tags?.length ? { tags: post.tags } : {}),
        ...(post.lendable === true ? { lendable: true, lendMaxDays: post.lendMaxDays, lendTerms: post.lendTerms, replacementValue: post.replacementValue } : {}),
    };
}

type Sent = 'ok' | 'later' | { refused: string };

async function send(offer: BringOffer, body: Record<string, unknown>, identity: BeanPoolIdentity, deps: BringDeps): Promise<Sent> {
    let res: Response;
    try {
        res = await withTimeout(POST_TIMEOUT_MS, (signal) => deps.post(offer.to, POSTS_PATH, body, identity, signal));
    } catch {
        return 'later';
    }
    const answer: any = await res.json().catch(() => null);
    // A 2xx that isn't the route's answer is a proxy's or a captive portal's page: nothing is known to have landed.
    if (res.ok) return answer?.success === true ? 'ok' : 'later';
    if (res.status === 401 || res.status === 408 || res.status === 429 || res.status >= 500) return 'later';
    return { refused: typeof answer?.error === 'string' && answer.error ? answer.error : String(res.status) };
}

/** The node's words for a member with no profile photo (engine/posts.ts assertProfileComplete), read as utils/db.ts reads them. */
const isProfilePhotoRefusal = (reason: string) => /set a profile photo/i.test(reason);

/**
 * Brings the plan's listings. `onStep` hears how many are done. Stops at the first sign the new community isn't answering:
 * what it has is safe, and the next run reads what it holds.
 */
export async function runBring(
    offer: BringOffer, plan: BringPlan, identity: BeanPoolIdentity, onStep?: (done: number, total: number) => void, deps: BringDeps = liveDeps,
): Promise<BringResult> {
    const result: BringResult = { brought: 0, lines: plan.gone.map((title) => ({ kind: 'gone', title })), kept: false, held: false };
    const lastTry = (offer.tries ?? 0) + 1 >= BRING_MOST_TRIES;
    let healed = false;
    for (const [i, post] of plan.bring.entries()) {
        onStep?.(i, plan.bring.length);
        const { photos, missed, later } = await photosOf(post, offer.from, deps);
        // No photo came, and one might yet: this one waits, and the rest still go.
        if (photos.length === 0 && later && !lastTry) {
            result.kept = true;
            continue;
        }
        const body = postBody(post, broughtId(post.id, offer.to), identity.publicKey, photos);
        let sent = await send(offer, body, identity, deps);
        // A profile the join's profile step hasn't reached this community yet: sent, and asked again, as a new post does.
        if (typeof sent === 'object' && isProfilePhotoRefusal(sent.refused) && !healed) {
            healed = true;
            if (await deps.healProfile(offer.to).catch(() => false)) sent = await send(offer, body, identity, deps);
        }
        if (sent === 'later') {
            result.kept = true;
            break;
        }
        if (sent === 'ok') {
            result.brought++;
            if (missed > 0) result.lines.push({ kind: 'fewer-photos', title: post.title });
            continue;
        }
        if (isProfilePhotoRefusal(sent.refused)) {
            result.held = true;
            result.lines.push({ kind: 'held', reason: sent.refused });
            break;
        }
        const noneSent = photos.length === 0;
        result.lines.push(noneSent && missed > 0 ? { kind: 'photos-failed', title: post.title }
            : noneSent ? { kind: 'no-photo', title: post.title }
            : { kind: 'refused', title: post.title, reason: sent.refused });
    }
    onStep?.(plan.bring.length, plan.bring.length);
    return result;
}

/** A line of the sheet in the member's language; `name` is the new community. */
export function bringLineWords(line: BringLine, name: string): string {
    switch (line.kind) {
        case 'gone': return t('"{title}" is no longer up on the global community, so it stayed behind.', { title: line.title });
        case 'fewer-photos': return t('"{title}" came across without some of its photos: they could not be fetched.', { title: line.title });
        case 'photos-failed': return t('"{title}" stayed behind: its photos could not be fetched, and {name} needs at least one.', { title: line.title, name });
        case 'no-photo': return t('"{title}" stayed behind: it has no photo, and {name} needs at least one.', { title: line.title, name });
        case 'refused': return t('"{title}" stayed behind: {reason}', { title: line.title, reason: line.reason });
        case 'held': return line.reason;
    }
}

/** The sheet's sentences, by the numbers they carry. */
export const BRING_WORDS = {
    title: (name: string) => t('Bring my listings to {name}?', { name }),
    body: (n: number) => tn(n, 'Your {n} listing on the global community will be posted there too, by you.', 'Your {n} listings on the global community will be posted there too, by you.', { n }),
    noPrice: () => t('They arrive with no price. You can set one on each listing.'),
    bring: (n: number) => tn(n, 'Bring it', 'Bring them', { n }),
    bringing: (done: number, total: number) => t('Bringing {done} of {total}…', { done, total }),
    done: (n: number, name: string) => (n === 0 ? t('None of your listings came across.') : tn(n, '{n} listing is now in {name}.', '{n} listings are now in {name}.', { n, name })),
    kept: () => t('A community could not be reached. The rest will be tried again next time you open Home.'),
};
