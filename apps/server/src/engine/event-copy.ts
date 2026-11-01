/**
 * A member's copy of an in-person event from their own community, on the global community (DESIGN-list-on-global-fable.md §3,
 * reworked by DESIGN-reaching-across-fable.md; slice G2′). A signed post by the member's own key, made by their phone
 * (apps/native utils/show-on-global.ts): their home server does nothing and learns nothing, and this node calls nobody.
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
 *   move their listings and leave a copy where it is, in every list, count and tag (@beanpool/engine posts.ts IS_COPY_SQL)
 *   and on the socket (state-engine.ts listingReach): a copy that came and went with its author's row would say whose it is.
 * - **Going is at home.** An RSVP is answered 409 with the door's words (rsvpEvent), and no chat is made or opened
 *   (createPost, event-thread.ts loadEventForThread).
 * - **It carries the times and the rounded pin only**: no place name, no note, no link, whatever a request sends
 *   ({@link copyEventBody}, {@link copyEventUpdates}), and the visitor's read drops them besides.
 *
 * Probation, the daily limits, reports, auto-hide and retention count it as any post of its author's: those act on the
 * one post, and none of them is a read another member can follow. A re-key leaves its stamp where it was, so it doesn't
 * move with their listings (engine/key-move.ts). But a copy has to come down when its author does: a removal
 * (adminPruneUser), a burst hide (engine/burst-cleanup.ts) or a deleted account takes it down with the member's other
 * posts, and a member watching the listings can tell.
 */
import { guestPost, roundToArea, type MarketplacePost, type ShownFrom } from '@beanpool/engine';
import { audienceOf, word, wordsFor } from '@beanpool/core';
import { getProfileSwitches } from '../config/node-profile.js';
import { shownCommunityAt, type DirectoryRow } from './directory-cache.js';

const { t: tr } = wordsFor('en');

/** What a copy's row stores. `host` '' is a copy whose community is no shown row: nothing of where it came from is kept. */
export interface CopyColumns { host: string; postId: string | null }

/** An RSVP on a copy: 409 with this code, and the door's words (routes/marketplace.ts). */
export const EVENT_COPY_CODE = 'event_copy';
export const COPY_IN_PERSON_ONLY = word('Only an event at a place can be shown on the global community.');
const NO_DOOR_WORDS = word('This event is run by another community, so you can\'t say you are going from here.');
const POST_ID_MOST_CHARS = 128;

function doorOf(host: string): (ShownFrom & { row: DirectoryRow }) | null {
    const row = host ? shownCommunityAt(host) : null;
    return row ? { host, postId: null, name: row.name!, url: row.url!, door: row.acceptingKnocks === false ? 'invite' : 'ask', row } : null;
}

/**
 * What a create asks of `shownFrom`: null for no copy (no field sent, or a node that keeps no directory, where the phone
 * finds no `shownCopy` on its answer). Throws for a kind that can't be one: a post in the open with its author's name is
 * not what the member ticked. The host goes in only for a shown row.
 */
export function copyOfRequest(raw: unknown, body: { type?: unknown; eventOnline?: unknown; audienceScope?: unknown }): CopyColumns | null {
    if (raw === undefined || raw === null || !getProfileSwitches().directoryMirror) return null;
    if (body.type !== 'event' || body.eventOnline === true || (body.audienceScope ?? 'public') !== 'public') throw new Error(COPY_IN_PERSON_ONLY);
    const asked = raw as { host?: unknown; postId?: unknown };
    const host = typeof asked.host === 'string' ? audienceOf(`https://${asked.host}`) : null;
    if (!host || !doorOf(host)) return { host: '', postId: null };
    const id = asked.postId;
    return { host, postId: typeof id === 'string' && id.length > 0 && id.length <= POST_ID_MOST_CHARS ? id : null };
}

/** A rounded point, whichever way a request sent it. */
function rounded(v: unknown): number | undefined {
    return typeof v === 'number' && Number.isFinite(v) ? roundToArea(v) : undefined;
}

/** A copy's create body: the times and the rounded pin. Whatever a phone sent, nothing typed about the place goes on. */
export function copyEventBody<T extends Record<string, any>>(body: T): T {
    return { ...body, lat: rounded(body.lat), lng: rounded(body.lng), eventPlaceName: undefined, eventPrivateNote: undefined, eventLink: undefined, eventHostLetsIn: false };
}

/** A copy's edit, held to the same: an edit can't add what a create can't, nor make it online. */
export function copyEventUpdates(updates: Record<string, any>): void {
    for (const field of ['eventPlaceName', 'eventPrivateNote', 'eventLink', 'eventHostLetsIn', 'eventOnline']) delete updates[field];
    if (updates.lat !== undefined) updates.lat = rounded(updates.lat);
    if (updates.lng !== undefined) updates.lng = rounded(updates.lng);
}

/**
 * A post as `reader` reads it. Every other post comes back as it is. A copy loses its stored columns for `shownCopy` and,
 * while the directory shows the community, `shownFrom`; for anyone but its author it is a visitor's read.
 */
export function readOfCopy(post: MarketplacePost, reader: string | null | undefined): MarketplacePost {
    if (post.shownFromHost === undefined) return post;
    const { shownFromHost, shownFromPostId, ...rest } = post;
    const door = doorOf(shownFromHost);
    const read: MarketplacePost = {
        ...rest, shownCopy: true,
        ...(door ? { shownFrom: { host: door.host, postId: shownFromPostId ?? null, name: door.name, url: door.url, door: door.door } } : {}),
    };
    return reader && reader === post.authorPublicKey ? read : guestPost(read);
}

/** The door's words for an RSVP on a copy, with the community's own name, or what is left to say without one. */
export function copyRsvpRefusal(host: string): Error {
    const door = doorOf(host);
    return Object.assign(new Error(door ? tr('To go, ask to join {community}', { community: door.name }) : NO_DOOR_WORDS), { code: EVENT_COPY_CODE });
}
