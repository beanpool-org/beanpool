// Marketplace Posts pure database reads and search keyword generators.
//
// Extracted from apps/server/src/state-engine.ts.

import type Database from 'better-sqlite3';
import {
    PROTOCOL_CONSTANTS,
    parseReachPeers,
    type PostReach,
    type AudienceScope
} from '@beanpool/core';
import { getMemberTrustProfile } from './trust.js';
import { avatarUrlFor } from '@beanpool/core';
import { areaBox, boundingBox, roundToArea } from './geo.js';

type Db = Database.Database;

export interface PollOption {
    id: string;
    text: string;
    votes?: number;
    percentage?: number;
}

export interface PollVoteRecord {
    voterPubkey: string;
    voterCallsign?: string;
    optionId: string;
    createdAt: string;
}

export type EventState = 'scheduled' | 'updated' | 'cancelled';
export type EventRsvpStatus = 'going' | 'interested';

export interface EventRsvpRecord {
    memberPubkey: string;
    memberCallsign?: string;
    status: EventRsvpStatus;
    updatedAt: string;
}

export interface MarketplacePost {
    id: string;
    type: 'offer' | 'need' | 'poll' | 'event';
    category: string;
    title: string;
    description: string;
    credits: number;
    priceType?: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly' | string;
    authorPublicKey: string;
    authorCallsign: string;
    createdAt: string;
    updatedAt?: string;
    active: boolean;
    status: 'active' | 'pending' | 'completed' | 'cancelled' | 'paused' | string;
    repeatable?: boolean;
    /** #108: a real cash outlay is involved (fuel/consumables). No amount — terms live in the chat. */
    cashAlsoNeeded?: boolean;
    acceptedBy?: string;
    acceptedByCallsign?: string;
    acceptedAt?: string;
    pendingTransactionId?: string;
    completedAt?: string;
    lat?: number;
    lng?: number;
    photos?: string[];
    originNode?: string;
    /** #143 step 4: how far this listing travels. Absent on a row written before the column existed → 'local'. */
    reach?: PostReach;
    /** Peer ids named when `reach === 'peers'`. Empty for every other reach. */
    reachPeers?: string[];
    /**
     * The credit backing the author's floor (vouch + earned + granted = CREDIT_BASE_FLOOR − floor) — the
     * quantity tierForCredit takes, so a card's badge matches the author's real tier. The name is historical:
     * it is not beans sent.
     */
    authorEnergyCycled?: number;
    authorFoundingNeeded?: boolean;
    authorAvatarUrl?: string | null;
    createdBy?: string;
    pollOptions?: PollOption[];
    pollClosesAt?: string;
    totalVotes?: number;
    userVotedOptionId?: string;
    pollVotes?: PollVoteRecord[];
    // Audience scoping (docs/the-commons.md §9, Item 10)
    audienceScope?: AudienceScope;
    targetGroupId?: string;
    targetGroupName?: string;
    targetPubkey?: string;
    assignedTo?: string;
    // Events (docs/events-on-the-map.md §2.1). Times are ISO UTC.
    eventStartAt?: string;
    eventEndAt?: string;
    eventPlaceName?: string;
    /** Host and `going` only — omitted for every other reader (§2.3). */
    eventPrivateNote?: string;
    eventState?: EventState;
    goingCount?: number;
    interestedCount?: number;
    /** The viewer's own RSVP; null when they have none. */
    myRsvp?: EventRsvpStatus | null;
    /** Host only: who has RSVPd. Everyone else sees the counts. */
    eventRsvps?: EventRsvpRecord[];
    /**
     * Hidden by reports (global profile, G3: apps/server/src/engine/auto-moderation.ts), waiting for a moderator.
     * Only its author and the moderators ever receive a hidden post, and to them it says so; everyone else gets
     * nothing, or a removal on a sync read.
     */
    hiddenByReportsAt?: string | null;
    /** A moderator took it down (G3). Carried by the replication export only. */
    removedByModeratorAt?: string | null;
    /**
     * Great-circle km from the point the reader gave (`PostFilter.near`), to 0.1 km; null for a post with no place.
     * Absent when no point was given (G4).
     */
    distanceKm?: number | null;
}

export interface PostFilter {
    id?: string;
    type?: string;
    category?: string;
    status?: string;
    offset?: number;
    limit?: number;
    updatedAfter?: string;
    query?: string;
    authorPubkey?: string;
    viewerPubkey?: string;
    sync?: boolean;
    /** #108: exclude listings with a cash outlay — the beans-only browse. */
    beansOnly?: boolean;
    includeInactive?: boolean;
    includeAllScopes?: boolean;
    audienceScope?: AudienceScope | string;
    targetGroupId?: string;
    assignedTo?: string;
    /** Restrict to these post types (the list route's `types=` parameter). */
    types?: string[];
    /**
     * Leave events out. The list route sets this unless the client opted in with `types=…event` or
     * `type=event`, so an app built before events never receives one (docs/events-on-the-map.md §2.6).
     */
    excludeEvents?: boolean;
    /**
     * The viewer is a moderator (an owner, admin or moderator of this node): posts hidden by reports stay in,
     * marked `hiddenByReportsAt`. Without it only their author gets them. `includeAllScopes` includes them too.
     */
    includeHidden?: boolean;
    /**
     * Who voted for what in each poll (`pollVotes`), for a reader who reads as a member of this node (readsAsMember)
     * only: the open ballot is open to members. Without it a poll carries its counts (`totalVotes`, each option's
     * `votes` and `percentage`) and no voters, so a read nobody vouched for can never leak them.
     */
    includeVoters?: boolean;
    /**
     * Distance search (global node G4, design §3.2). Every post read carries `distanceKm` from this point. With
     * `radiusKm`, only posts within it (great-circle) are read, and a post with no place is left out. Every other filter
     * applies as without it.
     */
    near?: { lat: number; lng: number; radiusKm?: number };
    /**
     * Nearest first (needs `near`): posts with no place last, then most recently updated first among equals. Without
     * it, the usual most-recently-updated order.
     */
    sortByDistance?: boolean;
    /**
     * Every place read as its coarse area (geo.ts roundToArea, 0.1°), for a visitor on a node that shows them the
     * listings but not the people (guestPost). Inside the query, not on the way out: the distance, the nearest-first
     * order, the radius and so the paging are all worked out from the area, so nothing read from many points can
     * place a post better than its area. Each post carries its area as `lat`/`lng`, and `distanceKm` in whole km.
     */
    coarse?: boolean;
}

/** An ended event stays readable by id to its host and Going for this long; after that, to nobody. */
export const EVENT_READABLE_AFTER_END_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The host set for an event, and for every host-only action on it: the author, an active keeper of an
 * enterprise author, or an active convenor of the target group. The same set `removePost` trusts.
 */
export function isEventHost(
    db: Db,
    row: { author_pubkey: string; audience_scope?: string | null; target_group_id?: string | null },
    pubkey: string | undefined,
): boolean {
    if (!pubkey) return false;
    if (row.author_pubkey === pubkey) return true;
    const keeper = db.prepare(`
        SELECT 1 FROM treasury_operators o
        JOIN members m ON m.public_key = o.member_pubkey
        WHERE o.member_pubkey = ? AND o.treasury_pubkey = ? AND m.status = 'active'
    `).get(pubkey, row.author_pubkey);
    if (keeper) return true;
    if (row.audience_scope === 'group' && row.target_group_id) {
        return !!db.prepare(
            "SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND role = 'convenor' AND status = 'active'"
        ).get(row.target_group_id, pubkey);
    }
    return false;
}

// Server-side photo limits. Clients resize to ≤800px JPEG at 0.7 quality.
export const MAX_POST_PHOTOS = 5;
export const MAX_PHOTO_BASE64_CHARS = 600_000;

export const CONTRIBUTION_REQUIRED_ERROR = 'CONTRIBUTION_REQUIRED: list at least one Offer before you can post Needs or accept Offers.';
export const COVENANT_REQUIRED_ERROR = 'COVENANT_REQUIRED: keep at least one active Offer posted to spend on community credit (a negative balance).';

function selectInChunks<T = any>(db: Db, ids: string[], queryBuilder: (placeholders: string) => string, chunkSize = 500): T[] {
    if (ids.length === 0) return [];
    const results: T[] = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = db.prepare(queryBuilder(placeholders)).all(...chunk) as T[];
        results.push(...rows);
    }
    return results;
}

export function validatePostPhotos(photos: string[] | undefined): void {
    if (photos === undefined) return;
    if (!Array.isArray(photos)) throw new Error('photos must be an array');
    if (photos.length > MAX_POST_PHOTOS) throw new Error(`A post can have at most ${MAX_POST_PHOTOS} photos`);
    for (const p of photos) {
        if (typeof p !== 'string' || !/^data:image\/(jpeg|jpg|png|webp);base64,/.test(p)) {
            throw new Error('Each photo must be a base64 data URL (JPEG, PNG, or WebP)');
        }
        if (p.length > MAX_PHOTO_BASE64_CHARS) {
            throw new Error('Photo too large — resize to 800px JPEG before uploading');
        }
    }
}

export function generateSearchKeywords(title: string, description: string, category: string, synonymMap?: Record<string, string[]>): string {
    const text = `${title} ${description}`.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const expanded = new Set<string>();
    expanded.add(category);

    if (!synonymMap) return [...expanded].join(' ');

    const lookup = (word: string): string[] | undefined => {
        if (synonymMap[word]) return synonymMap[word];
        if (word.endsWith('ies')) { const stem = word.slice(0, -3) + 'y'; if (synonymMap[stem]) return synonymMap[stem]; }
        if (word.endsWith('es')) { const stem = word.slice(0, -2); if (synonymMap[stem]) return synonymMap[stem]; }
        if (word.endsWith('s')) { const stem = word.slice(0, -1); if (synonymMap[stem]) return synonymMap[stem]; }
        if (word.endsWith('ing')) { const stem = word.slice(0, -3); if (synonymMap[stem]) return synonymMap[stem]; }
        if (word.endsWith('ed')) { const stem = word.slice(0, -2); if (synonymMap[stem]) return synonymMap[stem]; }
        return undefined;
    };

    // ⚡ Bolt: Single-pass n-gram scanning over pre-split words array to avoid re-parsing and string allocations
    const allWords = text.split(/\s+/).filter(Boolean);
    const len = allWords.length;
    for (let i = 0; i < len; i++) {
        const word = allWords[i];
        if (word.length > 2) {
            const syns = lookup(word);
            if (syns) {
                for (const syn of syns) expanded.add(syn);
            }
        }
        if (i < len - 1) {
            const two = `${word} ${allWords[i+1]}`;
            if (synonymMap[two]) {
                for (const syn of synonymMap[two]) expanded.add(syn);
            }
            if (i < len - 2) {
                const three = `${two} ${allWords[i+2]}`;
                if (synonymMap[three]) {
                    for (const syn of synonymMap[three]) expanded.add(syn);
                }
            }
        }
    }
    return [...expanded].join(' ');
}

export function rowToPost(db: Db, row: any, photosByPost: Map<string, any[]>): MarketplacePost {
    const postPhotos = photosByPost.get(row.id) || [];
    // The author's tier credit, from the same profile their own tier comes from. The earned lane alone
    // left out grants and vouches, so an admin-badged Elder showed as a Newcomer on their cards.
    let trustPoints = 0;
    try {
        trustPoints = PROTOCOL_CONSTANTS.CREDIT_BASE_FLOOR - getMemberTrustProfile(db, row.author_pubkey).floor;
    } catch (e) {
        trustPoints = 0;
    }

    return {
        id: row.id,
        type: row.type,
        category: row.category,
        title: row.title,
        description: row.description,
        credits: row.credits,
        priceType: row.price_type || 'fixed',
        authorPublicKey: row.author_pubkey,
        authorCallsign: row.author_callsign,
        createdAt: row.created_at,
        updatedAt: row.updated_at || row.created_at,
        active: Boolean(row.active),
        status: row.status,
        repeatable: Boolean(row.repeatable),
        cashAlsoNeeded: Boolean(row.cash_also_needed),
        acceptedBy: row.accepted_by,
        acceptedByCallsign: row.accepted_callsign,
        acceptedAt: row.accepted_at,
        pendingTransactionId: row.pending_transaction_id,
        completedAt: row.completed_at,
        lat: row.lat,
        lng: row.lng,
        photos: postPhotos.sort((a: any, b: any) => a.order_num - b.order_num).map((p: any) => `/api/marketplace/posts/${row.id}/photos/${p.order_num}?v=${p.updated_at ? new Date(p.updated_at).getTime() : 0}`),
        originNode: row.origin_node,
        // #143 step 4. `reach` falls back to 'local' rather than undefined so a client never has to decide
        // what an absent value means — on a database upgraded before the column existed, it means "stays
        // home", and that is the answer the poster is entitled to.
        reach: (row.reach ?? 'local') as PostReach,
        reachPeers: parseReachPeers(row.reach_peers),
        authorEnergyCycled: trustPoints,
        authorFoundingNeeded: (row.author_trade_count ?? 0) === 0 && (row.author_earned_credit ?? 0) === 0,
        authorAvatarUrl: avatarUrlFor(row.author_pubkey, row.author_avatar),
        createdBy: row.created_by || undefined,
        pollOptions: row.poll_options ? (() => { try { return JSON.parse(row.poll_options); } catch { return undefined; } })() : undefined,
        pollClosesAt: row.poll_closes_at || undefined,
        audienceScope: (row.audience_scope ?? 'public') as AudienceScope,
        targetGroupId: row.target_group_id || undefined,
        targetGroupName: row.target_group_name || undefined,
        targetPubkey: row.target_pubkey || undefined,
        assignedTo: row.assigned_to || undefined,
        ...(row.type === 'event' ? {
            eventStartAt: row.event_start_at || undefined,
            eventEndAt: row.event_end_at || undefined,
            eventPlaceName: row.event_place_name || undefined,
            eventState: (row.event_state || 'scheduled') as EventState,
        } : {}),
        ...(row.hidden_by_reports_at ? { hiddenByReportsAt: row.hidden_by_reports_at } : {}),
    };
}

/**
 * A post hidden by reports, as a sync read gives it to anyone but its author and the moderators: a removal, with
 * nothing of what it said. Apps treat it exactly as a post its author took down, so a phone that already holds the
 * post drops it; when a moderator restores it, the next sync brings the real one back.
 */
function hiddenAsRemoved(post: MarketplacePost): MarketplacePost {
    return {
        id: post.id,
        type: post.type,
        category: post.category,
        title: '',
        description: '',
        credits: 0,
        priceType: post.priceType,
        authorPublicKey: post.authorPublicKey,
        authorCallsign: post.authorCallsign,
        createdAt: post.createdAt,
        updatedAt: post.updatedAt,
        active: false,
        status: 'cancelled',
        photos: [],
        reach: post.reach,
        audienceScope: post.audienceScope,
        targetGroupId: post.targetGroupId,
        targetPubkey: post.targetPubkey,
        assignedTo: post.assignedTo,
        ...(post.type === 'event' ? { eventState: 'cancelled' as EventState } : {}),
    };
}

export function hasListedOffer(db: Db, publicKey: string): boolean {
    const row = db.prepare("SELECT 1 FROM posts WHERE author_pubkey = ? AND type = 'offer' LIMIT 1").get(publicKey);
    return !!row;
}

export function hasLiveOffer(db: Db, publicKey: string): boolean {
    const row = db.prepare("SELECT 1 FROM posts WHERE author_pubkey = ? AND type = 'offer' AND active = 1 AND status = 'active' LIMIT 1").get(publicKey);
    return !!row;
}

export function liveOfferCount(db: Db, publicKey: string): number {
    const row = db.prepare("SELECT COUNT(*) as c FROM posts WHERE author_pubkey = ? AND type = 'offer' AND active = 1 AND status = 'active'").get(publicKey) as any;
    return row?.c || 0;
}

/** A listed post's row: the post, its author, who took it, its group, and the author's trade count. */
const POST_ROW_SELECT = `
        SELECT p.*, m.callsign as author_callsign, m.avatar_url as author_avatar, a.callsign as accepted_callsign,
               g.name as target_group_name,
               COALESCE(m.earned_credit, 0) as author_earned_credit,
               (
                 COALESCE((SELECT COUNT(*) FROM transactions t
                      WHERE (t.from_pubkey = m.public_key OR t.to_pubkey = m.public_key)
                        AND t.from_pubkey != t.to_pubkey
                        AND t.from_pubkey NOT LIKE 'escrow_%' AND t.to_pubkey NOT LIKE 'escrow_%'
                        AND t.from_pubkey != 'SYSTEM' AND t.to_pubkey != 'SYSTEM'), 0) +
                 COALESCE((SELECT COUNT(*) FROM marketplace_transactions mt
                      WHERE (mt.buyer_pubkey = m.public_key OR mt.seller_pubkey = m.public_key)
                        AND mt.status = 'completed'), 0)
               ) as author_trade_count
        FROM posts p
        LEFT JOIN members m ON p.author_pubkey = m.public_key
        LEFT JOIN members a ON p.accepted_by = a.public_key
        LEFT JOIN groups g ON p.target_group_id = g.id`;

const RECENT_ORDER = " ORDER BY p.updated_at DESC, p.created_at DESC";
// Nearest first ends on p.id, so the order is total and limit/offset pages it without repeats or gaps.
const NEAREST_ORDER = " ORDER BY distance_km ASC NULLS LAST, p.updated_at DESC, p.created_at DESC, p.id ASC";

/**
 * The circles a nearest-first page is searched in, widening from the reader's point (km). The first that holds the page
 * gives it, and exactly: every post outside a circle is farther than every post inside it. Each is a box on
 * idx_posts_lat_lng, so the posts near the reader are read and the rest of the world is not. If none holds it, one pass
 * over every post gives it (the posts with no place last).
 * About three times wider each time, so where posts are evenly spread the circle that holds the page holds about ten
 * pages at most, and the circles before it cost a tenth of it. None wider than 3,000 km: past that a box holds much of
 * the world's posts, and one pass over every post costs about the same (measured: a 10,000 km circle cost more).
 */
export const NEAREST_FIRST_CIRCLES_KM: readonly number[] = [1, 3, 10, 30, 100, 300, 1000, 3000];

/**
 * The circles for a coarse read (`coarse`), which measures from each post's area. An area is 0.1° across, about 11 km,
 * and every post in it is the same distance away, so a page near the reader is the areas nearest them, whole. A circle
 * under 5 km seldom holds an area's centre, and 10 km holds several at once: at a busy spot that read thousands of posts
 * for a page of fifty (test-distance-search-perf). From 5 km, the area nearest the reader is often all the page needs.
 */
export const NEAREST_FIRST_CIRCLES_KM_BY_AREA: readonly number[] = [5, 10, 30, 100, 300, 1000, 3000];

/**
 * Deeper into the list than this, the circles are skipped for one pass over every post: each circle would hand back up
 * to this many ids only for most of them to be passed over.
 */
export const NEAREST_FIRST_CIRCLES_MAX_DEPTH = 5000;

/**
 * The fields a read searched in circles may carry, and what each may hold. A circle reads every post in its box, whatever
 * the filter, so it is quick only when a good share of the posts near the reader are posts the listing shows. For a
 * filter that few of them match (the Events or Polls tab, a category, one author), circles read out to 3,000 km for a
 * few posts, and then one pass runs anyway; no count or guess made before the circles can tell that cheaply (the second
 * and third deciding reviews of #1140). So circles are only for the reads where that can't happen, decided by the kind of
 * filter alone:
 * - nearest first, with a page size, and no radius (a radius's one pass reads its box and no further);
 * - the listing's own rules only: who is reading (`viewerPubkey`), a moderator's hidden posts (`includeHidden`), events
 *   left out (`excludeEvents`), or `type` / `category` 'all', which getPosts reads as no filter. Every visible post near
 *   the reader is a match;
 * - `type` offer or need, or a `types` list with offer or need in it (the apps send `types=offer,need,poll,event` for
 *   their whole feed): offers and needs are each a large share of the posts, so a box fills a page about as fast as with
 *   no filter. circlesMayRead also checks that `type` and `types` together still keep offers or needs.
 * Every other field that is set sends the read to the one exact pass, where the planner may use the type, category or
 * author index: events or polls alone, a category, one author, a group, an audience scope, an assignee, beans only, a
 * search, a status, inactive posts, a sync or by-id read, and any field added to PostFilter later: the type below names
 * every field, so a new one doesn't compile until it is named here, and a field it doesn't know is refused too. So a new
 * filter is never slower than the one pass, and can be let in here once it is shown to match most posts everywhere.
 */
const CIRCLE_FIELDS: { readonly [K in keyof PostFilter]-?: ((filter: PostFilter) => boolean) | null } = {
    near: f => f.near!.radiusKm === undefined,
    sortByDistance: () => true,
    limit: () => true,
    offset: () => true,
    viewerPubkey: () => true,
    includeHidden: () => true,
    includeVoters: () => true,
    excludeEvents: () => true,
    type: f => f.type === 'all' || f.type === 'offer' || f.type === 'need',
    types: f => f.types!.includes('offer') || f.types!.includes('need'),
    category: f => f.category === 'all',
    // The area is read for every post in a box as the place is: which posts a circle holds doesn't change.
    coarse: () => true,
    id: null, status: null, updatedAfter: null, query: null, authorPubkey: null, sync: null, beansOnly: null,
    includeInactive: null, includeAllScopes: null, audienceScope: null, targetGroupId: null, assignedTo: null,
};

/** Whether a nearest-first read may search circles before its one pass (CIRCLE_FIELDS). */
function circlesMayRead(filter: PostFilter): boolean {
    if (!filter.sortByDistance || !filter.limit || (filter.offset || 0) + filter.limit > NEAREST_FIRST_CIRCLES_MAX_DEPTH) return false;
    for (const [field, value] of Object.entries(filter)) {
        if (value === undefined || value === null || value === false || value === '') continue;
        const allowed = CIRCLE_FIELDS[field as keyof PostFilter];
        if (!allowed || !allowed(filter)) return false;
    }
    // `type` and `types` both apply: type=offer with types=need,poll keeps nothing.
    return (['offer', 'need'] as const).some(t =>
        (!filter.type || filter.type === 'all' || filter.type === t) && (!filter.types?.length || filter.types.includes(t)));
}

/**
 * A read with a point (G4): the order first, on ids and distances alone, then the rows of that page in full. The trade
 * counts, the joins and everything after them run for the page, not for every post the order had to look at.
 * Returns the page's rows in order, each with its `distance_km`.
 */
function postRowsNear(db: Db, near: NonNullable<PostFilter['near']>, where: string, whereParams: unknown[], filter: PostFilter): any[] {
    const byDistance = !!filter.sortByDistance;
    const offset = filter.offset || 0;
    // How far a post is from the reader's point (the two `?`): from its place, or for a coarse read from its area
    // (geo.ts area_km, haversine_km from the roundToArea of each). Every distance, radius and order below reads it through
    // this, so a coarse read is worked out from the area alone.
    const km = (t: string) => filter.coarse ? `area_km(?, ?, ${t}.lat, ${t}.lng)` : `haversine_km(?, ?, ${t}.lat, ${t}.lng)`;

    // `m` is joined for the author's filters in `where` (paused, winding up); it is one row at most, as are the joins
    // POST_ROW_SELECT adds, so no join changes which posts there are.
    const rank = (withinKm: number | undefined, limit: number | undefined, skip: number, circle: boolean) => {
        let sql = `
        SELECT p.id, ${km('p')} AS distance_km`;
        const params: unknown[] = [near.lat, near.lng];
        if (withinKm === undefined) {
            sql += `
        FROM posts p
        LEFT JOIN members m ON p.author_pubkey = m.public_key
        WHERE 1=1`;
        } else {
            // Within a radius: a box on posts(lat, lng) that idx_posts_lat_lng answers, split in two across the
            // antimeridian and every longitude around a pole (geo.ts boundingBox), then the exact great-circle distance. A
            // post with no place fails BETWEEN, so it is never inside one.
            // In a circle, the box is `b` and each post in it is joined to itself (`p`) for the listing's own conditions.
            // SQLite never reorders a CROSS JOIN, so the box always drives: left to itself, the planner takes
            // idx_posts_category for a category filter, and every circle would read every post in that category. One
            // pass (a radius, or everything) is left to the planner.
            // For a coarse read the box holds every post whose AREA is in the circle's box: still the true columns, so
            // the index still answers it (geo.ts areaBox).
            const exact = boundingBox(near.lat, near.lng, withinKm);
            const box = filter.coarse ? areaBox(exact) : exact;
            const t = circle ? 'b' : 'p';
            sql += circle ? `
        FROM posts b
        CROSS JOIN posts p
        LEFT JOIN members m ON p.author_pubkey = m.public_key` : `
        FROM posts p
        LEFT JOIN members m ON p.author_pubkey = m.public_key`;
            sql += `
        WHERE ${t}.lat BETWEEN ? AND ? AND (${box.lngRanges.map(() => `${t}.lng BETWEEN ? AND ?`).join(' OR ')})
          AND ${km(t)} <= ?${circle ? `
          AND p.id = b.id` : ''}`;
            params.push(box.latMin, box.latMax, ...box.lngRanges.flat(), near.lat, near.lng, withinKm);
        }
        sql += where;
        params.push(...whereParams);
        sql += byDistance ? NEAREST_ORDER : RECENT_ORDER;
        if (limit) {
            sql += " LIMIT ? OFFSET ?";
            params.push(limit, skip);
        }
        return db.prepare(sql).all(...params) as Array<{ id: string; distance_km: number | null }>;
    };

    let ranked: Array<{ id: string; distance_km: number | null }> | undefined;
    if (circlesMayRead(filter)) {
        const depth = offset + filter.limit!;
        for (const km of filter.coarse ? NEAREST_FIRST_CIRCLES_KM_BY_AREA : NEAREST_FIRST_CIRCLES_KM) {
            const inside = rank(km, depth, 0, true);
            if (inside.length === depth) { ranked = inside.slice(offset); break; }
        }
    }
    ranked ??= rank(near.radiusKm, filter.limit, offset, false);

    const full = selectInChunks(db, ranked.map(r => r.id), ph => `${POST_ROW_SELECT}\n        WHERE p.id IN (${ph})`);
    const byId = new Map(full.map(row => [row.id as string, row]));
    return ranked.flatMap(r => {
        const row = byId.get(r.id);
        return row ? [{ ...row, distance_km: r.distance_km }] : [];
    });
}

export function getPosts(db: Db, filter?: PostFilter): MarketplacePost[] {
    return getPostsRankedBy(db, filter, postRowsNear);
}

/** How a read with a point finds its page's rows, in order, each with its `distance_km` (postRowsNear). */
export type RowsNear = (db: Db, near: NonNullable<PostFilter['near']>, where: string, whereParams: unknown[], filter: PostFilter) => any[];

/**
 * getPosts, with a read with a point ranked by `rowsNear` in place of postRowsNear. Only the perf suite
 * (apps/server test-distance-search-perf.ts) passes another: the one query nearest first was before the circles, so the
 * two are timed through the same conditions and the same code after them, on one database, in one run.
 */
export function getPostsRankedBy(db: Db, filter: PostFilter | undefined, rowsNear: RowsNear): MarketplacePost[] {
    // `haversine_km` is registered on the connection (geo.ts registerGeoFunctions); asked only when a point is given, so
    // every read without one runs exactly the query it always has.
    const near = filter?.near;
    // The listing's conditions, each " AND …", read with `params`.
    let where = '';
    const params: any[] = [];

    if (!filter?.id && !filter?.updatedAfter && !filter?.sync) {
        const selfView = !!filter?.authorPubkey && filter.authorPubkey === filter.viewerPubkey;
        if (!filter?.includeInactive) {
            where += selfView
                ? " AND p.active = 1 AND (p.status IN ('active', 'pending', 'paused') OR (p.type = 'poll' AND p.status = 'completed'))"
                : " AND p.active = 1 AND (p.status IN ('active', 'pending') OR (p.type = 'poll' AND p.status = 'completed'))";
        }
        // Events drop off the feed and map when they end — a filter, not a sweep (§2.2).
        where += " AND NOT (p.type = 'event' AND p.event_end_at IS NOT NULL AND p.event_end_at <= ?)";
        params.push(new Date().toISOString());
        if (!filter?.authorPubkey) {
            where += " AND p.author_pubkey NOT IN (SELECT public_key FROM member_preferences WHERE pref_key='holiday_mode' AND pref_value='true')";
            where += " AND (m.paused IS NULL OR m.paused = 0) AND (m.status IS NULL OR m.status NOT IN ('winding_up', 'completed'))";
        } else if (!selfView && !filter?.includeInactive) {
            where += " AND (m.paused IS NULL OR m.paused = 0) AND (m.status IS NULL OR m.status NOT IN ('winding_up', 'completed'))";
        }
    } else if (filter?.updatedAfter || filter?.sync) {
        // Include completed/cancelled/deleted states for sync
    } else if (!filter?.includeInactive) {
        // By id, a cancelled event stays readable (to its host and the people going, checked below) until the
        // 30-day scrub marks it completed: the host has to be able to open the page and see it CANCELLED,
        // not just its chat (events §1, "host and attendees can still see it for 30 days").
        where += " AND (p.active = 1 OR (p.type = 'event' AND p.status = 'cancelled' AND p.event_state = 'cancelled'))";
    }

    if (filter?.id) { where += " AND p.id = ?"; params.push(filter.id); }
    if (filter?.type && filter.type !== 'all') { where += " AND p.type = ?"; params.push(filter.type); }
    if (filter?.types && filter.types.length > 0) {
        where += ` AND p.type IN (${filter.types.map(() => '?').join(',')})`;
        params.push(...filter.types);
    }
    if (filter?.excludeEvents) { where += " AND p.type != 'event'"; }
    if (filter?.category && filter.category !== 'all') { where += " AND p.category = ?"; params.push(filter.category); }
    if (filter?.status) { where += " AND p.status = ?"; params.push(filter.status); }
    if (filter?.authorPubkey) { where += " AND p.author_pubkey = ?"; params.push(filter.authorPubkey); }
    // #108: beans-only browse. COALESCE so rows predating the column are treated as beans-only
    // rather than vanishing from the filtered view.
    if (filter?.beansOnly) { where += " AND COALESCE(p.cash_also_needed, 0) = 0"; }

    // Audience scoping (docs/the-commons.md §9, Item 10)
    // Non-members must NEVER see group-scoped or direct-scoped posts in feeds, map pins, search, or direct queries.
    const viewer = filter?.viewerPubkey;
    if (filter?.includeAllScopes) {
        // Internal engine lookup bypasses feed scoping
    } else if (filter?.audienceScope === 'public') {
        where += " AND (p.audience_scope IS NULL OR p.audience_scope = 'public')";
    } else if (filter?.audienceScope === 'group') {
        where += " AND p.audience_scope = 'group'";
        if (!viewer) {
            where += " AND 1=0";
        } else {
            where += " AND (p.author_pubkey = ? OR p.target_group_id IN (SELECT group_id FROM group_members WHERE member_pubkey = ? AND status = 'active'))";
            params.push(viewer, viewer);
        }
    } else if (filter?.audienceScope === 'direct') {
        where += " AND p.audience_scope = 'direct'";
        if (!viewer) {
            where += " AND 1=0";
        } else {
            where += " AND (p.author_pubkey = ? OR p.target_pubkey = ? OR p.assigned_to = ?)";
            params.push(viewer, viewer, viewer);
        }
    } else {
        if (!viewer) {
            where += " AND (p.audience_scope IS NULL OR p.audience_scope = 'public')";
        } else {
            where += ` AND (
                (p.audience_scope IS NULL OR p.audience_scope = 'public')
                OR (p.audience_scope = 'group' AND (p.author_pubkey = ? OR p.target_group_id IN (SELECT group_id FROM group_members WHERE member_pubkey = ? AND status = 'active')))
                OR (p.audience_scope = 'direct' AND (p.author_pubkey = ? OR p.target_pubkey = ? OR p.assigned_to = ?))
            )`;
            params.push(viewer, viewer, viewer, viewer, viewer);
        }
    }

    if (filter?.targetGroupId) {
        where += " AND p.target_group_id = ?";
        params.push(filter.targetGroupId);
    }
    if (filter?.assignedTo) {
        where += " AND p.assigned_to = ?";
        params.push(filter.assignedTo);
    }

    // Hidden by reports (global profile, G3): out of every listing, search, map read and read by id for everyone
    // but its author and the moderators. A sync read keeps the row, as a removal (hiddenAsRemoved), so a phone that
    // already holds the post drops it at its next sync.
    const hiddenFromViewer = !filter?.includeAllScopes && !filter?.includeHidden;
    const syncRead = !!(filter?.updatedAfter || filter?.sync);
    if (hiddenFromViewer && !syncRead) {
        if (viewer) {
            where += " AND (p.hidden_by_reports_at IS NULL OR p.author_pubkey = ?)";
            params.push(viewer);
        } else {
            where += " AND p.hidden_by_reports_at IS NULL";
        }
    }

    if (filter?.query && filter.query.trim()) {
        const searchTerms = filter.query.trim().replace(/["']/g, '').split(/\s+/).filter(w => w.length > 0);
        if (searchTerms.length > 0) {
            const ftsQuery = searchTerms.map(t => `"${t}"*`).join(' OR ');
            where += ` AND p.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)`;
            params.push(ftsQuery);
            // Goods search isolation: searching marketplace keywords must not return polls unless explicitly asked
            if (filter.type !== 'poll') {
                where += " AND p.type != 'poll'";
            }
        }
    }

    if (filter?.updatedAfter) {
        where += " AND p.updated_at >= ?";
        params.push(filter.updatedAfter);
    }

    let rows: any[];
    if (near) {
        rows = rowsNear(db, near, where, params, filter!);
    } else {
        let query = `${POST_ROW_SELECT}
        WHERE 1=1${where}${RECENT_ORDER}`;
        if (filter?.limit) {
            query += " LIMIT ? OFFSET ?";
            params.push(filter.limit, filter.offset || 0);
        }
        rows = db.prepare(query).all(...params) as any[];
    }
    const postIds = rows.map(r => r.id);

    const photos = selectInChunks(db, postIds, ph => `SELECT post_id, order_num, updated_at FROM post_photos WHERE post_id IN (${ph})`);

    const photosByPost = new Map<string, any[]>();
    for (const p of photos as any[]) {
        if (!photosByPost.has(p.post_id)) {
            photosByPost.set(p.post_id, []);
        }
        photosByPost.get(p.post_id)!.push(p);
    }

    // Community Polls: batch fetch votes for all poll rows. Every reader gets the counts; only a member
    // (`includeVoters`) gets who voted for what, below.
    const pollRows = rows.filter(r => r.type === 'poll');
    const pollVotesByPost = new Map<string, any[]>();
    if (pollRows.length > 0) {
        try {
            const pollIds = pollRows.map(r => r.id);
            const votes = selectInChunks(db, pollIds, ph => `
                SELECT pv.post_id, pv.voter_pubkey, pv.option_id, pv.created_at, m.callsign as voter_callsign
                FROM poll_votes pv
                LEFT JOIN members m ON pv.voter_pubkey = m.public_key
                WHERE pv.post_id IN (${ph})
                ORDER BY pv.created_at ASC
            `);
            for (const v of votes as any[]) {
                if (!pollVotesByPost.has(v.post_id)) {
                    pollVotesByPost.set(v.post_id, []);
                }
                pollVotesByPost.get(v.post_id)!.push(v);
            }
        } catch {
            // Safe fallback if poll_votes table does not exist in testing handle
        }
    }

    // #143 step 4. `reachPeers` names WHICH NEIGHBOURING COMMUNITIES a member singled out, and that is the
    // poster's business, not the board's — in a community small enough to know everyone, "she offers this to
    // Gippsland but not to Castlemaine" is socially loaded in a way the listing itself is not. This board is
    // a public HTTPS read by design, so it went to anyone who asked, including the peers not named.
    //
    // Dropped rather than emptied: `reachPeers: []` would read as "named nobody", which is a different and
    // false statement, and an edit form loading that would silently clear the poster's real choice.
    //
    // `reach` itself stays. It is a property of the listing rather than a fact about third parties, and the
    // cached copy a peer stores needs to be 'local' for loop prevention to hold.
    // Events: batch fetch RSVPs for all event rows, as for poll votes above.
    const eventRows = rows.filter(r => r.type === 'event');
    const rsvpsByPost = new Map<string, any[]>();
    if (eventRows.length > 0) {
        try {
            const rsvps = selectInChunks(db, eventRows.map(r => r.id), ph => `
                SELECT er.post_id, er.member_pubkey, er.status, er.updated_at, m.callsign as member_callsign
                FROM event_rsvps er
                LEFT JOIN members m ON er.member_pubkey = m.public_key
                WHERE er.post_id IN (${ph})
                ORDER BY er.updated_at ASC
            `);
            for (const v of rsvps as any[]) {
                if (!rsvpsByPost.has(v.post_id)) rsvpsByPost.set(v.post_id, []);
                rsvpsByPost.get(v.post_id)!.push(v);
            }
        } catch {
            // Table absent on an older schema
        }
    }

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const out: MarketplacePost[] = [];
    for (const r of rows) {
        const post = rowToPost(db, r, photosByPost);
        if (hiddenFromViewer && r.hidden_by_reports_at && r.author_pubkey !== viewer) {
            // Only a sync read gets this far with a hidden post it may not see (the SQL above left it out otherwise).
            // A removal says nothing of where the post was, so it carries no distance either.
            out.push(hiddenAsRemoved(post));
            continue;
        }
        if (post.authorPublicKey !== viewer) delete post.reachPeers;
        if (filter?.coarse) {
            // The area, never the place: the rounding the query measured from (geo.ts area_km).
            post.lat = typeof r.lat === 'number' ? roundToArea(r.lat) : r.lat;
            post.lng = typeof r.lng === 'number' ? roundToArea(r.lng) : r.lng;
        }
        if (near) {
            post.distanceKm = typeof r.distance_km !== 'number' ? null
                : filter?.coarse ? Math.round(r.distance_km) : Math.round(r.distance_km * 10) / 10;
        }

        if (post.type === 'event') {
            const rsvps = rsvpsByPost.get(post.id) || [];
            const mine = viewer ? rsvps.find(v => v.member_pubkey === viewer) : undefined;
            const host = isEventHost(db, r, viewer);
            const going = mine?.status === 'going';
            // An ended event is readable by id to its host and Going only, and to nobody once the 30-day
            // window has passed. Internal lookups (includeAllScopes) and sync are not reader views.
            // A cancelled event read by id follows the same rule: host and Going only.
            const endMs = r.event_end_at ? Date.parse(r.event_end_at) : NaN;
            const readerView = filter?.id && !filter.includeAllScopes && !filter.sync && !filter.updatedAfter;
            if (readerView && endMs <= nowMs) {
                if ((!host && !going) || nowMs - endMs > EVENT_READABLE_AFTER_END_MS) continue;
            }
            if (readerView && !r.active && !host && !going) continue;
            post.goingCount = rsvps.filter(v => v.status === 'going').length;
            post.interestedCount = rsvps.filter(v => v.status === 'interested').length;
            post.myRsvp = (mine?.status as EventRsvpStatus | undefined) ?? null;
            if ((host || going) && r.event_private_note) post.eventPrivateNote = r.event_private_note;
            if (host) {
                post.eventRsvps = rsvps.map((v: any) => ({
                    memberPubkey: v.member_pubkey,
                    memberCallsign: v.member_callsign || undefined,
                    status: v.status,
                    updatedAt: v.updated_at,
                }));
            }
        }

        if (post.type === 'poll') {
            // Check auto-close if expired (projected in memory; DB writes handled in write paths/hygiene)
            if (post.pollClosesAt && post.pollClosesAt <= nowIso && post.status === 'active') {
                post.status = 'completed';
            }
            const votes = pollVotesByPost.get(post.id) || [];
            const totalVotes = votes.length;
            post.totalVotes = totalVotes;
            const voteCounts = new Map<string, number>();
            let userVotedOptionId: string | undefined;
            for (const v of votes) {
                voteCounts.set(v.option_id, (voteCounts.get(v.option_id) || 0) + 1);
                if (viewer && v.voter_pubkey === viewer) {
                    userVotedOptionId = v.option_id;
                }
            }
            post.userVotedOptionId = userVotedOptionId;
            if (post.pollOptions) {
                post.pollOptions = post.pollOptions.map((opt: any) => {
                    const count = voteCounts.get(opt.id) || 0;
                    const percentage = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
                    return { ...opt, votes: count, percentage };
                });
            }
            if (filter?.includeVoters) {
                post.pollVotes = votes.map((v: any) => ({
                    voterPubkey: v.voter_pubkey,
                    voterCallsign: v.voter_callsign || 'Anonymous',
                    optionId: v.option_id,
                    createdAt: v.created_at
                }));
            }
        }

        out.push(post);
    }
    return out;
}

/**
 * The post without who voted for what (`pollVotes`), for a reader or a socket that is not a member of this node. The
 * counts stay. Any other post comes back as it was.
 */
export function withoutPollVoters(post: MarketplacePost): MarketplacePost {
    if (!('pollVotes' in post)) return post;
    const { pollVotes: _voters, ...rest } = post;
    return rest;
}

/**
 * The author every post names to a visitor (guestPost): one constant, never a per-post token, which would link one
 * person's listings together. Not empty, so an app that writes it into a NOT NULL column (the phone's local posts
 * table) still can. The phone knows it (apps/native utils/posts-view.ts HIDDEN_AUTHOR) and opens no profile for it.
 */
export const HIDDEN_AUTHOR = 'hidden';

/** What a visitor gets of each field: the field as it is, nothing, or a neutral value in its place. */
type GuestRule<K extends keyof MarketplacePost> = 'keep' | 'drop' | ((post: MarketplacePost) => MarketplacePost[K]);

/**
 * Every field of a post, and what a visitor gets of it (guestPost). The type names every field, so a field added to
 * MarketplacePost doesn't compile until it is decided here, and a field this table doesn't know never reaches a visitor.
 * The listing stays: what it is, its words, photos, price text, dates, counts, and its area. The people go: who posted it
 * (key, name, face, standing), who took it and when, who voted, who is going, who it was for, and where exactly.
 */
const GUEST_FIELDS: { readonly [K in keyof MarketplacePost]-?: GuestRule<K> } = {
    id: 'keep', type: 'keep', category: 'keep', title: 'keep', description: 'keep', credits: 'keep', priceType: 'keep',
    createdAt: 'keep', updatedAt: 'keep', active: 'keep',
    // 'pending' stays: "spoken for", without saying by whom.
    status: 'keep',
    repeatable: 'keep', cashAlsoNeeded: 'keep', photos: 'keep', originNode: 'keep', reach: 'keep', audienceScope: 'keep',
    pollOptions: 'keep', pollClosesAt: 'keep', totalVotes: 'keep',
    eventStartAt: 'keep', eventEndAt: 'keep', eventState: 'keep', goingCount: 'keep', interestedCount: 'keep',
    // Neutral, not absent, so an app written against the member's shape meets no `undefined`: each falls back to its
    // "nobody" (an empty name reads as Anonymous / Unknown in both apps).
    authorPublicKey: () => HIDDEN_AUTHOR,
    authorCallsign: () => '',
    acceptedByCallsign: () => '',
    authorAvatarUrl: () => null,
    authorEnergyCycled: () => 0,
    authorFoundingNeeded: () => false,
    // The area, and a whole-km distance from it. A read made with `coarse` has both already; rounding again changes
    // nothing there, and keeps a read that forgot it from sending the place.
    lat: p => typeof p.lat === 'number' ? roundToArea(p.lat) : p.lat,
    lng: p => typeof p.lng === 'number' ? roundToArea(p.lng) : p.lng,
    distanceKm: p => typeof p.distanceKm === 'number' ? Math.round(p.distanceKm) : p.distanceKm,
    // The trade, the keeper behind an enterprise's post, the voters, the reader's own vote and RSVP, the host's lists and
    // note, the peers named, who a direct or group post was for, the typed place (often an address), and moderation.
    acceptedBy: 'drop', acceptedAt: 'drop', pendingTransactionId: 'drop', completedAt: 'drop', createdBy: 'drop',
    pollVotes: 'drop', userVotedOptionId: 'drop', myRsvp: 'drop', eventRsvps: 'drop', eventPrivateNote: 'drop',
    reachPeers: 'drop', targetPubkey: 'drop', assignedTo: 'drop', targetGroupId: 'drop', targetGroupName: 'drop',
    eventPlaceName: 'drop', hiddenByReportsAt: 'drop', removedByModeratorAt: 'drop',
};

/**
 * A post as a visitor sees it on a node that shows them the listings but not the people (the global profile's
 * `guestListingsOnly`, apps/server routes/marketplace.ts): the listing and its rough area, and nobody. Every field is
 * decided in GUEST_FIELDS; a field only replaced where the post has it, so a removal stays a removal. Read the post
 * with `coarse` first: this rounds the place too, but only the query can make the order and the radius the area's.
 */
export function guestPost(post: MarketplacePost): MarketplacePost {
    const out: Record<string, unknown> = {};
    for (const [field, rule] of Object.entries(GUEST_FIELDS) as Array<[keyof MarketplacePost, GuestRule<keyof MarketplacePost>]>) {
        if (!(field in post) || rule === 'drop') continue;
        out[field] = rule === 'keep' ? post[field] : rule(post);
    }
    return out as unknown as MarketplacePost;
}

/**
 * The copy of a post that may go to every socket. `new_post` / `post_updated` broadcasts are not addressed
 * to the viewer the post was read for, so the viewer-only fields come off first: an event's note, RSVP list
 * and the reader's own RSVP, and — for every type — `reachPeers`, which `getPosts` gives to the author alone.
 * These posts are read for the author (or the voter, for a poll vote), and the apps now keep what the feed
 * sends them (@beanpool/core `livePostChange`).
 */
export function publicBroadcastPost(post: MarketplacePost): MarketplacePost {
    const { reachPeers: _peers, ...shared } = post;
    if (shared.type !== 'event') return shared;
    const { eventPrivateNote: _note, eventRsvps: _rsvps, myRsvp: _mine, ...rest } = shared;
    return rest;
}

export function getActivePostCount(db: Db): number {
    const row = db.prepare("SELECT COUNT(*) as c FROM posts WHERE active = 1 AND status = 'active' AND (audience_scope IS NULL OR audience_scope = 'public') AND hidden_by_reports_at IS NULL").get() as any;
    return row?.c || 0;
}

export function getPostCount(db: Db, filter?: {
    type?: string;
    category?: string;
    status?: string;
    query?: string;
    audienceScope?: AudienceScope | string;
    viewerPubkey?: string;
    targetGroupId?: string;
    includeAllScopes?: boolean;
}): number {
    let query = "SELECT COUNT(*) as c FROM posts p WHERE p.active = 1";
    const params: any[] = [];

    const viewer = filter?.viewerPubkey;
    if (filter?.includeAllScopes) {
        // Internal lookup bypasses feed scoping
    } else if (filter?.audienceScope === 'public') {
        query += " AND (p.audience_scope IS NULL OR p.audience_scope = 'public')";
    } else if (filter?.audienceScope === 'group') {
        query += " AND p.audience_scope = 'group'";
        if (!viewer) {
            query += " AND 1=0";
        } else {
            query += " AND (p.author_pubkey = ? OR p.target_group_id IN (SELECT group_id FROM group_members WHERE member_pubkey = ? AND status = 'active'))";
            params.push(viewer, viewer);
        }
    } else if (filter?.audienceScope === 'direct') {
        query += " AND p.audience_scope = 'direct'";
        if (!viewer) {
            query += " AND 1=0";
        } else {
            query += " AND (p.author_pubkey = ? OR p.target_pubkey = ? OR p.assigned_to = ?)";
            params.push(viewer, viewer, viewer);
        }
    } else {
        if (!viewer) {
            query += " AND (p.audience_scope IS NULL OR p.audience_scope = 'public')";
        } else {
            query += ` AND (
                (p.audience_scope IS NULL OR p.audience_scope = 'public')
                OR (p.audience_scope = 'group' AND (p.author_pubkey = ? OR p.target_group_id IN (SELECT group_id FROM group_members WHERE member_pubkey = ? AND status = 'active')))
                OR (p.audience_scope = 'direct' AND (p.author_pubkey = ? OR p.target_pubkey = ? OR p.assigned_to = ?))
            )`;
            params.push(viewer, viewer, viewer, viewer, viewer);
        }
    }

    // Hidden by reports (G3): counted for its author only, as getPosts lists it.
    if (!filter?.includeAllScopes) {
        if (viewer) { query += " AND (p.hidden_by_reports_at IS NULL OR p.author_pubkey = ?)"; params.push(viewer); }
        else query += " AND p.hidden_by_reports_at IS NULL";
    }
    if (filter?.targetGroupId) { query += " AND p.target_group_id = ?"; params.push(filter.targetGroupId); }
    if (filter?.type && filter.type !== 'all') { query += " AND p.type = ?"; params.push(filter.type); }
    if (filter?.category && filter.category !== 'all') { query += " AND p.category = ?"; params.push(filter.category); }
    if (filter?.status) { query += " AND p.status = ?"; params.push(filter.status); }

    if (filter?.query && filter.query.trim()) {
        const searchTerms = filter.query.trim().replace(/["']/g, '').split(/\s+/).filter(w => w.length > 0);
        if (searchTerms.length > 0) {
            const ftsQuery = searchTerms.map(t => `"${t}"*`).join(' OR ');
            query += ` AND p.rowid IN (SELECT rowid FROM posts_fts WHERE posts_fts MATCH ?)`;
            params.push(ftsQuery);
            if (filter?.type !== 'poll') {
                query += " AND p.type != 'poll'";
            }
        }
    }

    const row = db.prepare(query).get(...params) as any;
    return row?.c || 0;
}
