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
import { boundingBox } from './geo.js';

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
 * gives it: over every post (the posts with no place last), or over the radius the reader gave.
 * About three times wider each time, so where posts are evenly spread the circle that holds the page holds about ten
 * pages at most, and the circles before it cost a tenth of it. None wider than 3,000 km: past that a box holds much of
 * the world's posts, and one pass over every post costs about the same.
 */
export const NEAREST_FIRST_CIRCLES_KM: readonly number[] = [1, 3, 10, 30, 100, 300, 1000, 3000];

/**
 * Deeper into the list than this, the circles are skipped for one pass over every post: each circle would hand back up
 * to this many ids only for most of them to be passed over.
 */
export const NEAREST_FIRST_CIRCLES_MAX_DEPTH = 5000;

/**
 * A read with a point (G4): the order first, on ids and distances alone, then the rows of that page in full. The trade
 * counts, the joins and everything after them run for the page, not for every post the order had to look at.
 * Returns the page's rows in order, each with its `distance_km`.
 */
function postRowsNear(db: Db, near: NonNullable<PostFilter['near']>, where: string, whereParams: unknown[], filter: PostFilter): any[] {
    const byDistance = !!filter.sortByDistance;
    const offset = filter.offset || 0;
    // Reads narrowed to a few posts (one post, a search, one author's, one group's, one assignee's, a sync delta) are
    // ranked in one pass, and the planner picks how to find them: circles would read the posts near the point again for
    // each circle, only to find a few of them.
    const narrowed = !!(filter.id || filter.query?.trim() || filter.authorPubkey || filter.targetGroupId || filter.assignedTo
        || filter.updatedAfter || filter.sync || filter.audienceScope === 'group' || filter.audienceScope === 'direct');

    // `m` is joined for the author's filters in `where` (paused, winding up); it is one row at most, as are the joins
    // POST_ROW_SELECT adds, so no join changes which posts there are.
    const rank = (withinKm: number | undefined, limit: number | undefined, skip: number, circle: boolean) => {
        let sql = `
        SELECT p.id, haversine_km(?, ?, p.lat, p.lng) AS distance_km`;
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
            const box = boundingBox(near.lat, near.lng, withinKm);
            const t = circle ? 'b' : 'p';
            sql += circle ? `
        FROM posts b
        CROSS JOIN posts p
        LEFT JOIN members m ON p.author_pubkey = m.public_key` : `
        FROM posts p
        LEFT JOIN members m ON p.author_pubkey = m.public_key`;
            sql += `
        WHERE ${t}.lat BETWEEN ? AND ? AND (${box.lngRanges.map(() => `${t}.lng BETWEEN ? AND ?`).join(' OR ')})
          AND haversine_km(?, ?, ${t}.lat, ${t}.lng) <= ?${circle ? `
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
    if (byDistance && filter.limit && !narrowed && offset + filter.limit <= NEAREST_FIRST_CIRCLES_MAX_DEPTH) {
        const depth = offset + filter.limit;
        for (const km of NEAREST_FIRST_CIRCLES_KM) {
            if (near.radiusKm !== undefined && km >= near.radiusKm) break;
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
        rows = postRowsNear(db, near, where, params, filter!);
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

    // Community Polls: batch fetch votes for all poll rows
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
        if (near) post.distanceKm = typeof r.distance_km === 'number' ? Math.round(r.distance_km * 10) / 10 : null;

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
            post.pollVotes = votes.map((v: any) => ({
                voterPubkey: v.voter_pubkey,
                voterCallsign: v.voter_callsign || 'Anonymous',
                optionId: v.option_id,
                createdAt: v.created_at
            }));
        }

        out.push(post);
    }
    return out;
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
