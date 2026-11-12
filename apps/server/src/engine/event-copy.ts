/**
 * A member's copy of an in-person event, an Offer or a Need from their own community, on the global community
 * (DESIGN-list-on-global-fable.md §3, reworked by DESIGN-reaching-across-fable.md; slices G2′ and G1′). A signed post by the
 * member's own key, made by their phone or browser (@beanpool/core show-on-global.ts): their home server does nothing and learns
 * nothing, and this node calls nobody.
 *
 * - **Marked by `posts.shown_from_host`**, set on every copy and on nothing else. It holds the host while that was a shown
 *   row of the directory at the write, else '': an unlisted community's host is never kept, and the copy is still a copy.
 * - **A billboard.** Nobody but its author reads it with an author: everyone else, a member included, reads it as a visitor
 *   does (guestPost), so no name, no key and nothing to message. {@link readOfCopy} is applied in state-engine.ts getPosts,
 *   so a read can't forget it; a copy is left out of one member's listings (engine getPosts), of the activity feed
 *   (createPost), and of the sockets (state-engine.ts broadcast, as a post hidden by reports).
 * - **The from-line and the door are drawn at each read** from the row of the directory, and never from anything the
 *   phone said. So a row that is gone takes its line with it, whatever the copy holds.
 * - **No read goes by who wrote it.** A reader's block list, the author's holiday, a paused account and a new name or face
 *   move their listings and leave a copy where it is, in every list, count and tag (@beanpool/engine posts.ts UNNAMED_COPY_SQL)
 *   and on the socket (state-engine.ts listingReach): a copy that came and went with its author's row would say whose it is.
 * - **Going is at home.** An RSVP is answered 409 with the door's words (rsvpEvent), and no chat is made or opened
 *   (createPost, event-thread.ts loadEventForThread).
 * - **It carries the times and the rounded pin only**: no place name, no note, no link, whatever a request sends
 *   ({@link copyBody}, {@link copyUpdates}), and the visitor's read drops them besides.
 * - **An Offer or a Need is a billboard with a price in words.** `credits` stays 0 and the home price goes in `shown_price`,
 *   for a reader to draw (`shownPrice`, @beanpool/core copyPriceLine): nothing adds it, compares it or pays it. Nothing of a
 *   deal goes with it ({@link copyBody}): no shop, no lending, no repeat, no reach to a peer. And none can start
 *   (engine/escrow.ts assertNoDealOnCopy), whatever this node's Beans switch says: a node with Beans on and a directory
 *   has copies too. So it is no Offer of the member's: it opens no credit line and passes no Offer-first gate
 *   (@beanpool/engine posts.ts OWN_OFFER_WHERE).
 *
 * - **Its door is the member's, per listing (slice GD; DESIGN-reaching-across-fable.md §3 and decisions 1 and 4).** "Take
 *   questions about this on the global community", on an Offer or a Need, off until they tick it: `shown_takes_questions`. An
 *   event has none (§1: the ask is "come", and the answer is the knock). On, a member reading it while it is up gets the name
 *   and key of a visitor's read and nothing more ({@link readOfCopy}), and global's request rule does the rest: a first line
 *   waits, makes nobody a friend, and rings nothing. A visitor's read is as it was. So a line through this door is always a
 *   request: where a community turns requests off the doors close ({@link closeCopyDoors}), and none opens ({@link setCopyQuestions}).
 *   Off, every read names nobody at once. The door is on the author, not the listing: a request already sent is theirs to answer,
 *   as any is, and someone who kept the key can ask again, as of any member here. No money goes by it: a deal is refused as on
 *   any copy, on or off.
 *
 * Probation, the daily limits, reports, auto-hide and retention count it as any post of its author's: those act on the
 * one post, and none of them is a read another member can follow. A re-key leaves its stamp where it was, so it doesn't
 * move with their listings (engine/key-move.ts). But a copy has to come down when its author does: a removal
 * (adminPruneUser), a burst hide (engine/burst-cleanup.ts) or a deleted account takes it down with the member's other
 * posts, and a member watching the listings can tell.
 */
import { getPosts, guestPost, publicBroadcastPost, readsAsMember, roundToArea, type MarketplacePost, type ShownFrom } from '@beanpool/engine';
import { audienceOf, copyPriceText, word, wordsFor } from '@beanpool/core';
import { getProfileSwitches } from '../config/node-profile.js';
import { db } from '../db/db.js';
import { assertNotMuted } from './auto-moderation.js';
import { bumpPostsVersion } from './versions.js';
import { shownCommunityAt, type DirectoryRow } from './directory-cache.js';
import { POST_PRICE_TYPES, isListingPrice } from './post-fields.js';

const { t: tr } = wordsFor('en');

/** What a copy's row stores. `host` '' is a copy whose community is no shown row: nothing of where it came from is kept. */
export interface CopyColumns { host: string; postId: string | null; price?: string | null; takesQuestions?: boolean }

/** An RSVP on a copy: 409 with this code, and the door's words (routes/marketplace.ts). */
export const EVENT_COPY_CODE = 'event_copy';
export const COPY_IN_PERSON_ONLY = word('Only an event at a place can be shown on the global community.');
export const COPY_LISTING_ONLY = word('Only an Offer or Need for everyone, with a place, can be shown on the global community.');
const COPY_PRICE_REFUSED = word('A copy of an Offer or Need needs its price in Beans.');
const QUESTIONS_LISTING_ONLY = word('Only an Offer or Need shown on the global community can take questions.');
const QUESTIONS_NEED_REQUESTS = word("This community isn't taking message requests right now, so this can't take questions.");
const NO_DOOR_WORDS = word('This event is run by another community, so you can\'t say you are going from here.');
const POST_ID_MOST_CHARS = 128;

function doorOf(host: string): (ShownFrom & { row: DirectoryRow }) | null {
    const row = host ? shownCommunityAt(host) : null;
    return row ? { host, postId: null, name: row.name!, url: row.url!, door: row.acceptingKnocks === false ? 'invite' : 'ask', row } : null;
}

/** Whether a create asks for a copy here: a node that keeps no directory makes a plain post of it, and the phone sees that. */
const asksForCopy = (raw: unknown): boolean => raw !== undefined && raw !== null && getProfileSwitches().directoryMirror;

const isListing = (type: unknown): boolean => type === 'offer' || type === 'need';

/**
 * A price as sent, in the one form it is kept: `{ price_c, per }`, whole hundredths held as a listing's own price is.
 * Anything else (an old `{ beans }`, a float) is refused.
 */
function storedPrice(raw: unknown): string {
    const { price_c, per } = (raw ?? {}) as { price_c?: unknown; per?: unknown };
    if (!isListingPrice(price_c) || !(POST_PRICE_TYPES as readonly unknown[]).includes(per)) throw new Error(COPY_PRICE_REFUSED);
    return copyPriceText({ price_c, per: per as (typeof POST_PRICE_TYPES)[number] });
}

/**
 * What a create asks of `shownFrom`: null for no copy (no field sent, or a node that keeps no directory, where the phone
 * finds no `shownCopy` on its answer). Throws for a kind that can't be one: a post in the open with its author's name is
 * not what the member ticked. The host goes in only for a shown row; the price stays either way, since the member gave it.
 */
export function copyOfRequest(raw: unknown, body: { type?: unknown; eventOnline?: unknown; audienceScope?: unknown; lat?: unknown; lng?: unknown; shownPrice?: unknown }): CopyColumns | null {
    if (!asksForCopy(raw)) return null;
    const open = (body.audienceScope ?? 'public') === 'public';
    if (isListing(body.type)) {
        if (!open || rounded(body.lat) === undefined || rounded(body.lng) === undefined) throw new Error(COPY_LISTING_ONLY);
    } else if (body.type !== 'event' || body.eventOnline === true || !open) throw new Error(COPY_IN_PERSON_ONLY);
    const price = isListing(body.type) ? storedPrice(body.shownPrice) : null;
    const asked = raw as { host?: unknown; postId?: unknown; takesQuestions?: unknown };
    const takesQuestions = asked.takesQuestions === true && isListing(body.type) && getProfileSwitches().dmRequests;
    const host = typeof asked.host === 'string' ? audienceOf(`https://${asked.host}`) : null;
    if (!host || !doorOf(host)) return { host: '', postId: null, price, takesQuestions };
    const id = asked.postId;
    return { host, postId: typeof id === 'string' && id.length > 0 && id.length <= POST_ID_MOST_CHARS ? id : null, price, takesQuestions };
}

/** A rounded point, whichever way a request sent it. */
function rounded(v: unknown): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) ? roundToArea(v) : undefined;
}

/**
 * The fields of a listing a copy never carries: what would make it a deal, or send it past this board. A count and a price for
 * all of them too (DESIGN-per-item-price-fable.md §6): they change by the hour at home, so a copy says the price for one only.
 */
const NEVER_ON_A_COPY = ['repeatable', 'cashAlsoNeeded', 'lendable', 'lendMaxDays', 'lendTerms', 'replacementValue', 'shopId', 'reach', 'reachPeers', 'targetGroupId', 'targetPubkey', 'assignedTo', 'unitsLeft', 'unitsLeftWas', 'lot'] as const;

/**
 * A create body as a copy may have it; the request's own for anything else. An event: the times and the rounded pin, and
 * nothing typed about the place. An Offer or a Need: its words, photos and rounded pin, at 0 Beans, for this board and no further.
 */
export function copyBody<T extends Record<string, any>>(body: T): T {
    if (!asksForCopy(body?.shownFrom)) return body;
    const place = { lat: rounded(body.lat), lng: rounded(body.lng) };
    if (body.type === 'event') return { ...body, ...place, eventPlaceName: undefined, eventPrivateNote: undefined, eventLink: undefined, eventHostLetsIn: false };
    if (!isListing(body.type)) return body;
    const kept: Record<string, any> = { ...body, ...place, price_c: 0, priceType: 'fixed' };
    for (const field of NEVER_ON_A_COPY) delete kept[field];
    return kept as T;
}

/**
 * A copy's edit, held to the same: an edit can't add what a create can't, nor make an event online. A price is held as the
 * create's is; `credits` and the rest of a deal never move.
 */
export function copyUpdates(updates: Record<string, any>): void {
    for (const field of ['eventPlaceName', 'eventPrivateNote', 'eventLink', 'eventHostLetsIn', 'eventOnline', 'price_c', 'priceType', 'audienceScope', ...NEVER_ON_A_COPY]) delete updates[field];
    if (updates.lat !== undefined) updates.lat = rounded(updates.lat);
    if (updates.lng !== undefined) updates.lng = rounded(updates.lng);
    if (updates.shownPrice !== undefined) updates.shownPrice = storedPrice(updates.shownPrice);
}

/**
 * A post as `reader` reads it. Every other post comes back as it is. A copy loses its stored columns for `shownCopy` and,
 * while the directory shows the community, `shownFrom`; its `shownPrice` stays, for a reader to word; for anyone but its
 * author it is a visitor's read. One that takes questions adds its author's name and key, and nothing else of them, for a
 * member while it is up: a read that is a removal, or a copy off the board, has nothing to ask about.
 */
export function readOfCopy(post: MarketplacePost, reader: string | null | undefined): MarketplacePost {
    if (post.shownFromHost === undefined) return post;
    const { shownFromHost, shownFromPostId, takesQuestions, ...rest } = post;
    const door = doorOf(shownFromHost);
    const read: MarketplacePost = {
        ...rest, shownCopy: true,
        ...(door ? { shownFrom: { host: door.host, postId: shownFromPostId ?? null, name: door.name, url: door.url, door: door.door } } : {}),
    };
    if (reader && reader === post.authorPublicKey) return { ...read, ...(takesQuestions ? { takesQuestions: true } : {}) };
    const seen = guestPost(read);
    const open = takesQuestions && !!reader && post.status === 'active' && post.active !== false && !post.hiddenByReportsAt && readsAsMember(db, reader);
    return open ? { ...seen, takesQuestions: true, authorPublicKey: post.authorPublicKey, authorCallsign: post.authorCallsign } : seen;
}

/**
 * The tick. Null for anything but the signer's own copy, whatever it is and whether it exists: this goes by the signer alone, so
 * a key in a request tests nothing. Off is never refused, a mute included: it is the member closing a door. The table's touch
 * trigger moves this row's stamp and no other's, so the next read of every reader, a delta's too, has it.
 */
export function setCopyQuestions(broadcast: (event: any) => void, id: string, signer: string, on: boolean): boolean | null {
    const row = db.prepare('SELECT type, shown_takes_questions FROM posts WHERE id = ? AND author_pubkey = ? AND shown_from_host IS NOT NULL').get(id, signer) as { type: string; shown_takes_questions: number | null } | undefined;
    if (!row) return null;
    if (on) {
        assertNotMuted(signer);
        if (!isListing(row.type)) throw Object.assign(new Error(QUESTIONS_LISTING_ONLY), { status: 400 });
        if (!getProfileSwitches().dmRequests) throw Object.assign(new Error(QUESTIONS_NEED_REQUESTS), { status: 409 });
    }
    if ((row.shown_takes_questions === 1) === on) return on;
    db.prepare('UPDATE posts SET shown_takes_questions = ? WHERE id = ?').run(on ? 1 : null, id);
    // The doorbell moves the tags on every read of the posts (state-engine.ts broadcast), as a write's must.
    const post = getPosts(db, { id, viewerPubkey: signer, includeVoters: true })[0];
    if (post) broadcast({ type: 'post_updated', post: publicBroadcastPost(post) });
    return on;
}

/**
 * Where a community's requests are off, nothing would hold a stranger's first line, so no door stays open: every copy's closes,
 * for good, and its member can open it again once requests are back. One stamp for every row, so it ties nobody to anything.
 */
export function closeCopyDoors(at: string = new Date().toISOString()): number {
    const { changes } = db.prepare('UPDATE posts SET shown_takes_questions = NULL, updated_at = ? WHERE shown_takes_questions = 1').run(at);
    if (changes > 0) bumpPostsVersion();
    return Number(changes);
}

/** The door's words for an RSVP on a copy, with the community's own name, or what is left to say without one. */
export function copyRsvpRefusal(host: string): Error {
    const door = doorOf(host);
    return Object.assign(new Error(door ? tr('To go, ask to join {community}', { community: door.name }) : NO_DOOR_WORDS), { code: EVENT_COPY_CODE });
}
