// Stateful mutations for Marketplace Posts.
//
// Extracted from apps/server/src/state-engine.ts.

import { isSyntheticAccount, parseReachPeers, type PostReach, type AudienceScope } from '@beanpool/core';
import { db } from '../db/db.js';
import { recordActivity } from '../db/activity-feed-db.js';
import crypto from 'node:crypto';
import { bumpPostsVersion } from './versions.js';
import {
    getMember,
    getPosts,
    validatePostPhotos,
    generateSearchKeywords,
    hasListedOffer,
    isEventHost,
    publicBroadcastPost,
    CONTRIBUTION_REQUIRED_ERROR,
    type MarketplacePost,
    type EventRsvpStatus
} from '@beanpool/engine';

type BroadcastFn = (event: any, recipients?: string[]) => void;

const HOLIDAY_MODE_ERROR = 'HOLIDAY_MODE: turn off holiday mode in Settings before trading.';

function assertMemberActive(publicKey: string): void {
    if (isSyntheticAccount(publicKey)) return;
    const member = db.prepare("SELECT status FROM members WHERE public_key = ?").get(publicKey) as any;
    if (!member) throw new Error('Member not found');
    if (member.status === 'disabled') throw new Error('Account is disabled');
    if (member.status === 'pruned') throw new Error('Account has been pruned');
    if (member.status === 'completed') throw new Error('Enterprise has wound up — account closed');
}

function assertProfileComplete(publicKey: string): void {
    const member = db.prepare("SELECT avatar_url, callsign FROM members WHERE public_key = ?").get(publicKey) as any;
    if (!member) return;
    if (!member.avatar_url) {
        throw new Error('Please set a profile photo before using the marketplace. Tap your profile to add one.');
    }
    if (!member.callsign || member.callsign.trim().length < 2) {
        throw new Error('Please set a display name before using the marketplace.');
    }
}

function isOnHoliday(publicKey: string): boolean {
    const row = db.prepare("SELECT pref_value FROM member_preferences WHERE public_key = ? AND pref_key = 'holiday_mode'").get(publicKey) as any;
    return row?.pref_value === 'true';
}

function assertNotOnHoliday(publicKey: string): void {
    if (isOnHoliday(publicKey)) throw new Error(HOLIDAY_MODE_ERROR);
}

function assertEnterpriseCanPost(publicKey: string): void {
    const member = db.prepare("SELECT is_treasury, paused, status FROM members WHERE public_key = ?").get(publicKey) as any;
    if (member?.is_treasury) {
        if (member.paused === 1) throw new Error('Enterprise is paused — cannot post offers or needs while paused');
        if (member.status === 'winding_up') throw new Error('Enterprise is winding up — no new listings allowed');
        if (member.status === 'completed') throw new Error('Enterprise has wound up — trading closed');
    }
}

/**
 * Turn whatever a client sent for reach into the two columns, fail-closed (#143 step 4).
 *
 * FAIL-CLOSED MEANS 'local' HERE. Everything unrecognised — a typo, a number, a reach the client invented,
 * `reach: 'peers'` with an empty list — becomes a listing that stays home. The alternative, throwing, would
 * turn a client bug into a member unable to post at all; and the alternative default, letting it travel, would
 * export a listing whose author asked for something we did not understand.
 *
 * `reach: 'peers'` with NO usable peer ids collapses to 'local' rather than being stored as a 'peers' row with
 * an empty list. Both behave identically today, but the collapsed form cannot later be misread as "named peers,
 * we just lost the names" — and it keeps the partial index (which excludes 'local') free of rows that can never
 * be served.
 */
/** The reach currently stored for a post, for an update that changes only the peer list. */
function existingReach(id: string): PostReach {
    const row = db.prepare('SELECT reach FROM posts WHERE id = ?').get(id) as any;
    return (row?.reach ?? 'local') as PostReach;
}

/** The peer list currently stored, for an update that changes only the reach. */
function existingReachPeers(id: string): string[] {
    const row = db.prepare('SELECT reach_peers FROM posts WHERE id = ?').get(id) as any;
    return parseReachPeers(row?.reach_peers);
}

// ===================== EVENTS (docs/events-on-the-map.md) =====================

export const EVENT_DEFAULT_DURATION_MS = 2 * 60 * 60 * 1000;
export const EVENT_PLACE_NAME_MAX = 80;
export const EVENT_PRIVATE_NOTE_MAX = 1000;
export const EVENT_UPCOMING_CAP = 5;

function parseEventTime(raw: unknown, label: string): string {
    const ms = typeof raw === 'string' || typeof raw === 'number' ? new Date(raw).getTime() : NaN;
    if (!Number.isFinite(ms)) throw new Error(`${label} must be a valid date and time`);
    return new Date(ms).toISOString();
}

function cleanPlaceName(raw: unknown): string | null {
    if (raw == null) return null;
    if (typeof raw !== 'string') throw new Error('Place name must be text');
    const v = raw.trim();
    if (v.length > EVENT_PLACE_NAME_MAX) throw new Error(`Place name must be ${EVENT_PLACE_NAME_MAX} characters or fewer`);
    return v || null;
}

function cleanPrivateNote(raw: unknown): string | null {
    if (raw == null) return null;
    if (typeof raw !== 'string') throw new Error('The note for people going must be text');
    const v = raw.trim();
    if (v.length > EVENT_PRIVATE_NOTE_MAX) throw new Error(`The note for people going must be ${EVENT_PRIVATE_NOTE_MAX} characters or fewer`);
    return v || null;
}

function assertEventPin(lat: unknown, lng: unknown): void {
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new Error('An event needs a place on the map');
    }
}

/** The end an event gets: the given one (after the start), or start + 2 hours when none is given. */
function resolveEventEnd(startIso: string, rawEnd: unknown): string {
    if (rawEnd == null || rawEnd === '') {
        return new Date(Date.parse(startIso) + EVENT_DEFAULT_DURATION_MS).toISOString();
    }
    const endIso = parseEventTime(rawEnd, 'End time');
    if (Date.parse(endIso) <= Date.parse(startIso)) throw new Error('An event must end after it starts');
    return endIso;
}

function audienceRecipients(row: { audience_scope?: string | null; target_group_id?: string | null }): string[] | undefined {
    if (row.audience_scope === 'group' && row.target_group_id) {
        const rows = db.prepare("SELECT member_pubkey FROM group_members WHERE group_id = ? AND status = 'active'").all(row.target_group_id) as any[];
        return rows.map(r => r.member_pubkey);
    }
    return undefined;
}

function normaliseReach(rawReach: unknown, rawPeers: unknown): { reach: PostReach; reachPeers: string | null } {
    if (rawReach === 'everywhere') return { reach: 'everywhere', reachPeers: null };
    if (rawReach === 'peers') {
        const peers = Array.isArray(rawPeers)
            ? [...new Set(rawPeers.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map(p => p.trim()))]
            : [];
        if (peers.length === 0) return { reach: 'local', reachPeers: null };
        return { reach: 'peers', reachPeers: JSON.stringify(peers) };
    }
    return { reach: 'local', reachPeers: null };
}

export function createPost(
    broadcast: BroadcastFn,
    type: 'offer' | 'need' | 'poll' | 'event',
    category: string,
    title: string,
    description: string,
    credits: number,
    priceType: 'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly' | string,
    authorPublicKey: string,
    lat?: number,
    lng?: number,
    photos?: string[],
    repeatable?: boolean,
    id?: string,
    cashAlsoNeeded?: boolean,
    options?: {
        reach?: unknown;
        reachPeers?: unknown;
        createdBy?: string;
        pollOptions?: Array<{ id: string; text: string }>;
        durationDays?: number;
        audienceScope?: AudienceScope;
        targetGroupId?: string;
        targetPubkey?: string;
        assignedTo?: string;
        eventStartAt?: unknown;
        eventEndAt?: unknown;
        eventPlaceName?: unknown;
        eventPrivateNote?: unknown;
    },
): MarketplacePost | null {
    assertMemberActive(authorPublicKey);
    if (!getMember(db, authorPublicKey)) {
        return null;
    }
    assertProfileComplete(authorPublicKey);
    assertNotOnHoliday(authorPublicKey);
    assertEnterpriseCanPost(authorPublicKey);

    const audienceScope: AudienceScope = (options?.audienceScope as AudienceScope) || 'public';
    if (!['public', 'group', 'direct'].includes(audienceScope)) {
        throw new Error(`Invalid audience scope: ${audienceScope}`);
    }

    if (audienceScope !== 'public') {
        options = { ...options, reach: 'local', reachPeers: null };
    }
    // Events are for this community or one of its groups (§1). A direct event has no meaning.
    if (type === 'event' && audienceScope === 'direct') {
        throw new Error('An event is for this community or a group');
    }

    if (audienceScope === 'group') {
        if (!options?.targetGroupId) {
            throw new Error('targetGroupId is required when audienceScope is group');
        }
        const grp = db.prepare("SELECT id FROM groups WHERE id = ?").get(options.targetGroupId) as any;
        if (!grp) {
            throw new Error('Group not found');
        }
        const isMem = db.prepare(
            "SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status = 'active' AND role IN ('convenor', 'member')"
        ).get(options.targetGroupId, authorPublicKey);
        if (!isMem) {
            throw new Error('UNAUTHORIZED: Must be an active convenor or member to post to a group');
        }
    } else if (audienceScope === 'direct') {
        if (!options?.targetPubkey && !options?.assignedTo) {
            throw new Error('targetPubkey or assignedTo is required when audienceScope is direct');
        }
        if (options?.targetPubkey) {
            const targetMem = db.prepare("SELECT status FROM members WHERE public_key = ?").get(options.targetPubkey) as any;
            if (!targetMem || targetMem.status === 'pruned') {
                throw new Error('Target member not found or pruned');
            }
        }
        if (options?.assignedTo) {
            const assignedMem = db.prepare("SELECT status FROM members WHERE public_key = ?").get(options.assignedTo) as any;
            if (!assignedMem || assignedMem.status === 'pruned') {
                throw new Error('Assigned member not found or pruned');
            }
        }
    }

    let cleanPollOptions: Array<{ id: string; text: string }> | null = null;
    let pollClosesAt: string | null = null;
    let eventStartAt: string | null = null;
    let eventEndAt: string | null = null;
    let eventPlaceName: string | null = null;
    let eventPrivateNote: string | null = null;

    if (type === 'poll') {
        const memberRow = db.prepare("SELECT status, credit_frozen FROM members WHERE public_key = ?").get(authorPublicKey) as any;
        if (!memberRow || memberRow.status !== 'active') {
            throw new Error('Only active members can create polls');
        }
        if (memberRow.credit_frozen) {
            throw new Error('Credit-frozen members cannot create polls');
        }

        // Sweep expired polls before rate limit check
        const nowIso = new Date().toISOString();
        db.prepare("UPDATE posts SET status = 'completed', updated_at = ? WHERE type = 'poll' AND status = 'active' AND poll_closes_at <= ?").run(nowIso, nowIso);

        const rawOpts = options?.pollOptions;
        if (!Array.isArray(rawOpts) || rawOpts.length < 2 || rawOpts.length > 4) {
            throw new Error('Polls must have between 2 and 4 options');
        }
        const seenIds = new Set<string>();
        cleanPollOptions = (rawOpts as any[]).map((opt: any, idx: number) => {
            const text = typeof opt === 'string' ? opt.trim() : (typeof opt?.text === 'string' ? opt.text.trim() : '');
            if (!text || text.length > 80) {
                throw new Error('Poll options must be between 1 and 80 characters');
            }
            const rawId = (typeof opt === 'object' && opt?.id) ? String(opt.id).trim() : `opt_${idx + 1}`;
            const optId = /^[a-zA-Z0-9_-]{1,32}$/.test(rawId) ? rawId : `opt_${idx + 1}`;
            if (seenIds.has(optId)) {
                throw new Error(`Duplicate option ID detected: ${optId}`);
            }
            seenIds.add(optId);
            return { id: optId, text };
        });

        const durationDays = options?.durationDays ? Number(options.durationDays) : 7;
        if (![3, 7, 14].includes(durationDays)) {
            throw new Error('Poll duration must be 3, 7, or 14 days');
        }
        pollClosesAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();

        // Enforce poll isolation defaults
        category = 'community';
        credits = 0;
        priceType = 'fixed';
        repeatable = false;
        lat = undefined;
        lng = undefined;
        photos = [];
        cashAlsoNeeded = false;
        options = { ...options, reach: 'local', reachPeers: null };
    } else if (type === 'event') {
        eventStartAt = parseEventTime(options?.eventStartAt, 'Start time');
        if (Date.parse(eventStartAt) <= Date.now()) throw new Error('An event must start in the future');
        eventEndAt = resolveEventEnd(eventStartAt, options?.eventEndAt);
        assertEventPin(lat, lng);
        eventPlaceName = cleanPlaceName(options?.eventPlaceName);
        eventPrivateNote = cleanPrivateNote(options?.eventPrivateNote);
        validatePostPhotos(photos);

        // What polls force, less the pin and photos an event keeps. Reach is local until the listings pull
        // carries event fields (§2.4).
        category = 'community';
        credits = 0;
        priceType = 'fixed';
        repeatable = false;
        cashAlsoNeeded = false;
        options = { ...options, reach: 'local', reachPeers: null };
    } else {
        validatePostPhotos(photos);
    }

    if (type === 'need' && !hasListedOffer(db, authorPublicKey)) throw new Error(CONTRIBUTION_REQUIRED_ERROR);

    const finalId = id || crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const searchKeywords = generateSearchKeywords(title, description, category);
    const { reach, reachPeers } = normaliseReach(options?.reach, options?.reachPeers);

    db.transaction(() => {
        if (type === 'poll') {
            const authorOpen = db.prepare("SELECT COUNT(*) as c FROM posts WHERE author_pubkey = ? AND type = 'poll' AND status = 'active'").get(authorPublicKey) as any;
            if (authorOpen && authorOpen.c >= 1) {
                throw new Error('Rate limit: You can only have 1 active poll at a time');
            }

            const nodeOpen = db.prepare("SELECT COUNT(*) as c FROM posts WHERE type = 'poll' AND status = 'active'").get() as any;
            if (nodeOpen && nodeOpen.c >= 5) {
                throw new Error('Rate limit: Node limit of 5 active polls reached');
            }
        }

        if (type === 'event') {
            // Upcoming cap (§2.2). Three separate pools: a group's events count against the group, and
            // everything else against the author — a member, or the enterprise a keeper posts for.
            // "Upcoming" is active and not yet ended; an ended event stays active until the 30-day scrub
            // and must not hold a slot for that month.
            const upcoming = audienceScope === 'group'
                ? db.prepare(`SELECT COUNT(*) as c FROM posts WHERE type = 'event' AND status = 'active' AND event_end_at > ?
                              AND audience_scope = 'group' AND target_group_id = ?`).get(createdAt, options!.targetGroupId) as any
                : db.prepare(`SELECT COUNT(*) as c FROM posts WHERE type = 'event' AND status = 'active' AND event_end_at > ?
                              AND author_pubkey = ? AND (audience_scope IS NULL OR audience_scope != 'group')`).get(createdAt, authorPublicKey) as any;
            if (upcoming && upcoming.c >= EVENT_UPCOMING_CAP) {
                throw new Error(`Limit reached: ${EVENT_UPCOMING_CAP} upcoming events at a time`);
            }
        }

        db.prepare(`INSERT INTO posts (
            id, type, category, title, description, credits, price_type, author_pubkey, created_at, active, status, repeatable, lat, lng, updated_at, search_keywords, cash_also_needed, reach, reach_peers, created_by, poll_options, poll_closes_at, audience_scope, target_group_id, target_pubkey, assigned_to,
            event_start_at, event_end_at, event_place_name, event_private_note, event_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            finalId, type, category, title, description, credits, priceType, authorPublicKey, createdAt,
            repeatable ? 1 : 0, lat ?? null, lng ?? null, createdAt, searchKeywords,
            cashAlsoNeeded ? 1 : 0, reach, reachPeers, options?.createdBy ?? null,
            cleanPollOptions ? JSON.stringify(cleanPollOptions) : null,
            pollClosesAt,
            audienceScope,
            audienceScope === 'group' ? (options?.targetGroupId ?? null) : null,
            audienceScope === 'direct' ? (options?.targetPubkey ?? null) : null,
            audienceScope === 'direct' ? (options?.assignedTo ?? null) : null,
            eventStartAt, eventEndAt, eventPlaceName, eventPrivateNote,
            type === 'event' ? 'scheduled' : null
        );

        if (photos && photos.length > 0) {
            const insertPhoto = db.prepare(`INSERT INTO post_photos (post_id, photo_data, order_num) VALUES (?, ?, ?)`);
            photos.slice(0, 5).forEach((p, idx) => insertPhoto.run(finalId, p, idx));
        }
    })();

    // getPosts appends `AND p.id = ?` and posts.id is the primary key, so the row is unique and
    // the old `.find(p => p.id === id)` only re-checked what the SQL already guaranteed.
    bumpPostsVersion();
    const post = getPosts(db, { id: finalId, viewerPubkey: authorPublicKey })[0]!;

    let recipients: string[] | undefined;
    if (audienceScope === 'group') {
        const rows = db.prepare("SELECT member_pubkey FROM group_members WHERE group_id = ? AND status = 'active'").all(options!.targetGroupId) as any[];
        recipients = rows.map(r => r.member_pubkey);
    } else if (audienceScope === 'direct') {
        recipients = Array.from(new Set([authorPublicKey, options?.targetPubkey, options?.assignedTo].filter(Boolean) as string[]));
    }

    broadcast({ type: 'new_post', post: publicBroadcastPost(post) }, recipients);

    // Activity feed isolation (docs/the-commons.md §9, Item 10)
    // Only public posts are recorded to the public activity feed
    if (audienceScope === 'public') {
        try {
            recordActivity('post_created', authorPublicKey, null, { postId: finalId, title, type, category, credits });
        } catch (e) {
            console.warn('[ActivityFeed] Could not record post_created:', e);
        }
    }
    return post;
}

export function removePost(broadcast: BroadcastFn, id: string, callerPublicKey: string): boolean {
    const postRow = db.prepare("SELECT id, author_pubkey, target_group_id, audience_scope, target_pubkey, assigned_to FROM posts WHERE id = ?").get(id) as any;
    if (!postRow) return false;

    const isDirectAuthor = postRow.author_pubkey === callerPublicKey;
    const isTreasuryAuthor = !isDirectAuthor && !!db.prepare(
        "SELECT 1 FROM treasury_operators WHERE member_pubkey = ? AND treasury_pubkey = ?"
    ).get(callerPublicKey, postRow.author_pubkey);
    const isAuthor = isDirectAuthor || isTreasuryAuthor;

    let isConvenor = false;
    if (postRow.audience_scope === 'group' && postRow.target_group_id) {
        const convenorRow = db.prepare(
            "SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND role = 'convenor' AND status = 'active'"
        ).get(postRow.target_group_id, callerPublicKey);
        isConvenor = !!convenorRow;
    }

    if (!isAuthor && !isConvenor) {
        return false;
    }

    const pendingTx = db.prepare(`SELECT COUNT(*) as c FROM marketplace_transactions WHERE post_id = ? AND status = 'pending'`).get(id) as any;
    if (pendingTx && pendingTx.c > 0) throw new Error('This post has a deal in escrow — complete or cancel the deal before deleting it');

    let removed = false;
    db.transaction(() => {
        const result = db.prepare(`
            UPDATE posts SET active = 0, status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            WHERE id = ? AND (
                author_pubkey = ?
                OR author_pubkey IN (SELECT treasury_pubkey FROM treasury_operators WHERE member_pubkey = ?)
                OR (
                    audience_scope = 'group'
                    AND target_group_id IS NOT NULL
                    AND target_group_id IN (
                        SELECT group_id FROM group_members
                        WHERE member_pubkey = ? AND role = 'convenor' AND status = 'active'
                    )
                )
            )
        `).run(id, callerPublicKey, callerPublicKey, callerPublicKey);
        if (result.changes === 0) return;
        removed = true;
        // Removing an event is cancelling it: the card shows CANCELLED to anyone who can still open it.
        db.prepare(`UPDATE posts SET event_state = 'cancelled' WHERE id = ? AND type = 'event'`).run(id);
        db.prepare(`UPDATE marketplace_transactions SET status='rejected', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE post_id=? AND status='requested'`).run(id);
        db.prepare(`UPDATE deferred_wage_claims SET status = 'cancelled' WHERE post_id = ? AND status = 'pending'`).run(id);
    })();
    if (!removed) return false;
    bumpPostsVersion();

    let recipients: string[] | undefined;
    if (postRow.audience_scope === 'group' && postRow.target_group_id) {
        const rows = db.prepare("SELECT member_pubkey FROM group_members WHERE group_id = ? AND status = 'active'").all(postRow.target_group_id) as any[];
        recipients = rows.map(r => r.member_pubkey);
    } else if (postRow.audience_scope === 'direct') {
        recipients = Array.from(new Set([postRow.author_pubkey, postRow.target_pubkey, postRow.assigned_to].filter(Boolean) as string[]));
    }

    broadcast({ type: 'post_removed', id }, recipients);
    return true;
}

export function updatePost(broadcast: BroadcastFn, id: string, authorPublicKey: string, updates: Partial<MarketplacePost> & { pollOptions?: Array<{ id: string; text: string }> }): MarketplacePost | null {
    const eventRow = db.prepare("SELECT type, active, status, event_state, event_end_at, author_pubkey, audience_scope, target_group_id FROM posts WHERE id = ?").get(id) as any;
    if (eventRow?.type === 'event') {
        // Every host may edit, not only the author (§2.2) — so the author check below is the host check.
        if (!isEventHost(db, eventRow, authorPublicKey)) return null;
        if (eventRow.event_state === 'cancelled' || eventRow.status === 'cancelled' || !eventRow.active) {
            throw new Error('Cannot edit a cancelled event');
        }
        if (eventRow.event_end_at && Date.parse(eventRow.event_end_at) <= Date.now()) {
            throw new Error('Cannot edit an event that has ended');
        }
    }
    const existingPost = getPosts(db, { id, includeAllScopes: true })[0] ?? null;
    if (!existingPost) return null;
    if (existingPost.type === 'event') {
        authorPublicKey = existingPost.authorPublicKey;
    } else if (existingPost.authorPublicKey !== authorPublicKey) {
        return null;
    }

    if (existingPost.audienceScope !== 'public') {
        delete updates.reach;
        delete (updates as any).reachPeers;
    }

    if (existingPost.type === 'poll') {
        if (existingPost.status !== 'active') {
            throw new Error('Cannot edit a closed poll');
        }
        const voteCountRow = db.prepare("SELECT COUNT(*) as c FROM poll_votes WHERE post_id = ?").get(id) as any;
        const hasVotes = (voteCountRow?.c || 0) > 0;
        if (hasVotes) {
            if (updates.title !== undefined && updates.title !== existingPost.title) {
                throw new Error('Cannot edit poll question once votes have been cast');
            }
            if (updates.pollOptions !== undefined) {
                throw new Error('Cannot edit poll options once votes have been cast');
            }
        }
        // Enforce poll isolation during updates
        delete updates.credits;
        delete updates.lat;
        delete updates.lng;
        delete updates.photos;
        delete updates.category;
        delete updates.priceType;
        delete updates.repeatable;
        delete updates.cashAlsoNeeded;
        delete updates.reach;
        delete (updates as any).reachPeers;
    }

    // Events: the host may edit everything, RSVPs or not. A change of time or place marks the event
    // UPDATED; title, description, photo and note changes are silent (§2.2).
    const eventFields: string[] = [];
    const eventValues: any[] = [];
    if (existingPost.type === 'event') {
        delete updates.credits;
        delete updates.category;
        delete updates.priceType;
        delete updates.repeatable;
        delete updates.cashAlsoNeeded;
        delete updates.reach;
        delete (updates as any).reachPeers;
        delete (updates as any).pollOptions;

        const raw = updates as any;
        const prevStart = existingPost.eventStartAt!;
        const prevEnd = existingPost.eventEndAt!;
        let nextStart = prevStart;
        if (raw.eventStartAt !== undefined) {
            nextStart = parseEventTime(raw.eventStartAt, 'Start time');
            if (nextStart !== prevStart && Date.parse(nextStart) <= Date.now()) {
                throw new Error('An event must start in the future');
            }
        }
        let nextEnd: string;
        if (raw.eventEndAt === undefined) {
            // Moving the start without naming an end keeps the event's length.
            nextEnd = nextStart === prevStart
                ? prevEnd
                : new Date(Date.parse(nextStart) + (Date.parse(prevEnd) - Date.parse(prevStart))).toISOString();
        } else {
            nextEnd = resolveEventEnd(nextStart, raw.eventEndAt);
        }
        if (Date.parse(nextEnd) <= Date.parse(nextStart)) throw new Error('An event must end after it starts');

        const nextLat = updates.lat !== undefined ? updates.lat : existingPost.lat;
        const nextLng = updates.lng !== undefined ? updates.lng : existingPost.lng;
        assertEventPin(nextLat, nextLng);

        let placeChanged = nextLat !== existingPost.lat || nextLng !== existingPost.lng;
        if (raw.eventPlaceName !== undefined) {
            const nextPlace = cleanPlaceName(raw.eventPlaceName);
            if (nextPlace !== (existingPost.eventPlaceName ?? null)) placeChanged = true;
            eventFields.push('event_place_name = ?'); eventValues.push(nextPlace);
        }
        if (raw.eventPrivateNote !== undefined) {
            eventFields.push('event_private_note = ?'); eventValues.push(cleanPrivateNote(raw.eventPrivateNote));
        }
        const timeChanged = nextStart !== prevStart || nextEnd !== prevEnd;
        eventFields.push('event_start_at = ?', 'event_end_at = ?'); eventValues.push(nextStart, nextEnd);
        if (timeChanged || placeChanged) {
            eventFields.push("event_state = 'updated'");
        }
    }

    if (updates.photos !== undefined && Array.isArray(updates.photos)) {
        const existingByOrder = new Map<number, string>(
            (db.prepare(`SELECT order_num, photo_data FROM post_photos WHERE post_id=?`).all(id) as any[])
                .map(r => [r.order_num, r.photo_data])
        );
        updates.photos = updates.photos.map(p => {
            const m = typeof p === 'string' ? p.match(/\/api\/marketplace\/posts\/([^/]+)\/photos\/(\d+)(?:\?.*)?$/) : null;
            if (m && m[1] === id) {
                const data = existingByOrder.get(Number(m[2]));
                if (data) return data;
            }
            return p;
        });
        validatePostPhotos(updates.photos);
    }

    const fields: string[] = [];
    const values: any[] = [];

    if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
    if (updates.category !== undefined) { fields.push('category = ?'); values.push(updates.category); }
    if (updates.credits !== undefined) { fields.push('credits = ?'); values.push(updates.credits); }
    if (updates.priceType !== undefined) { fields.push('price_type = ?'); values.push(updates.priceType); }
    if (updates.repeatable !== undefined) { fields.push('repeatable = ?'); values.push(updates.repeatable ? 1 : 0); }
    // The string "false" is truthy, so a stringified payload could never CLEAR the flag.
    // Normalise the same way the create route does.
    if (updates.cashAlsoNeeded !== undefined) { fields.push('cash_also_needed = ?'); values.push((updates.cashAlsoNeeded === true || (updates.cashAlsoNeeded as any) === 'true') ? 1 : 0); }
    if (updates.lat !== undefined) { fields.push('lat = ?'); values.push(updates.lat); }
    if (updates.lng !== undefined) { fields.push('lng = ?'); values.push(updates.lng); }

    if (existingPost.type === 'poll' && updates.pollOptions !== undefined) {
        const rawOpts = updates.pollOptions;
        if (!Array.isArray(rawOpts) || rawOpts.length < 2 || rawOpts.length > 4) {
            throw new Error('Polls must have between 2 and 4 options');
        }
        const seenIds = new Set<string>();
        const cleanPollOptions = (rawOpts as any[]).map((opt: any, idx: number) => {
            const text = typeof opt === 'string' ? opt.trim() : (typeof opt?.text === 'string' ? opt.text.trim() : '');
            if (!text || text.length > 80) {
                throw new Error('Poll options must be between 1 and 80 characters');
            }
            const rawId = (typeof opt === 'object' && opt?.id) ? String(opt.id).trim() : `opt_${idx + 1}`;
            const optId = /^[a-zA-Z0-9_-]{1,32}$/.test(rawId) ? rawId : `opt_${idx + 1}`;
            if (seenIds.has(optId)) {
                throw new Error(`Duplicate option ID detected: ${optId}`);
            }
            seenIds.add(optId);
            return { id: optId, text };
        });
        fields.push('poll_options = ?');
        values.push(JSON.stringify(cleanPollOptions));
    }

    // #143 step 4. BOTH columns always move together, through the same normaliser the create path uses —
    // otherwise switching 'peers' → 'everywhere' would leave a stale peer list behind, and a client sending
    // only `reachPeers` could leave a listing claiming named peers that no longer match the reach.
    // `reachPeers` alone is accepted so a member can edit the named list without restating the reach.
    if (updates.reach !== undefined || (updates as any).reachPeers !== undefined) {
        const nextReach = updates.reach !== undefined ? updates.reach : existingReach(id);
        const norm = normaliseReach(nextReach, (updates as any).reachPeers ?? existingReachPeers(id));
        fields.push('reach = ?'); values.push(norm.reach);
        fields.push('reach_peers = ?'); values.push(norm.reachPeers);
    }

    fields.push(...eventFields);
    values.push(...eventValues);

    const now = new Date().toISOString();
    fields.push('updated_at = ?');
    values.push(now);

    const newTitle = updates.title ?? existingPost.title;
    const newDesc = updates.description ?? existingPost.description;
    const newCat = updates.category ?? existingPost.category;
    const newKeywords = generateSearchKeywords(newTitle, newDesc, newCat);
    fields.push('search_keywords = ?');
    values.push(newKeywords);

    values.push(id, authorPublicKey);

    db.transaction(() => {
        db.prepare(`UPDATE posts SET ${fields.join(', ')} WHERE id = ? AND author_pubkey = ?`).run(...values);

        if (updates.photos !== undefined && Array.isArray(updates.photos)) {
            db.prepare(`DELETE FROM post_photos WHERE post_id = ?`).run(id);
            const insertPhoto = db.prepare(`INSERT INTO post_photos (post_id, photo_data, order_num, updated_at) VALUES (?, ?, ?, ?)`);
            updates.photos.slice(0, 5).forEach((p, idx) => insertPhoto.run(id, p, idx, now));
        }
    })();

    // getPosts appends `AND p.id = ?` and posts.id is the primary key, so the row is unique and
    // the old `.find(p => p.id === id)` only re-checked what the SQL already guaranteed.
    bumpPostsVersion();
    const updated = getPosts(db, { id, viewerPubkey: authorPublicKey })[0] ?? null;
    if (updated) {
        let recipients: string[] | undefined;
        if (updated.audienceScope === 'group' && updated.targetGroupId) {
            const rows = db.prepare("SELECT member_pubkey FROM group_members WHERE group_id = ? AND status = 'active'").all(updated.targetGroupId) as any[];
            recipients = rows.map(r => r.member_pubkey);
        } else if (updated.audienceScope === 'direct') {
            recipients = Array.from(new Set([updated.authorPublicKey, updated.targetPubkey, updated.assignedTo].filter(Boolean) as string[]));
        }
        broadcast({ type: 'post_updated', post: publicBroadcastPost(updated) }, recipients);
    }
    return updated;
}

/**
 * RSVP to an event: `going`, `interested`, or null for "not going", which deletes the row (§2.2).
 * One tap, no host approval. Modelled on votePoll.
 */
export function rsvpEvent(
    broadcast: BroadcastFn,
    postId: string,
    memberPublicKey: string,
    status: EventRsvpStatus | null,
    signature?: string,
): { success: boolean; post: MarketplacePost } {
    if (status !== null && status !== 'going' && status !== 'interested') {
        throw new Error("RSVP status must be 'going', 'interested' or null");
    }
    assertMemberActive(memberPublicKey);
    const memberRow = db.prepare("SELECT status FROM members WHERE public_key = ?").get(memberPublicKey) as any;
    if (!memberRow || memberRow.status !== 'active') {
        throw new Error('Only active members can RSVP to events');
    }

    const row = db.prepare("SELECT id, type, active, status, event_state, event_end_at, author_pubkey, audience_scope, target_group_id FROM posts WHERE id = ?").get(postId) as any;
    if (!row || row.type !== 'event') {
        throw new Error('Event not found');
    }
    if (!row.active || row.status !== 'active' || row.event_state === 'cancelled') {
        throw new Error('This event has been cancelled');
    }
    const nowIso = new Date().toISOString();
    if (row.event_end_at && row.event_end_at <= nowIso) {
        throw new Error('This event has ended');
    }
    if (row.audience_scope === 'group') {
        const isMem = row.target_group_id && db.prepare(
            "SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status = 'active' AND role IN ('convenor', 'member')"
        ).get(row.target_group_id, memberPublicKey);
        if (!isMem && row.author_pubkey !== memberPublicKey) {
            throw new Error('UNAUTHORIZED: Must be an active convenor or member of the group to RSVP to this event');
        }
    }

    if (signature) {
        try {
            const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
            const spki = Buffer.concat([spkiHeader, Buffer.from(memberPublicKey, 'hex')]);
            const publicKeyObject = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
            const valid = crypto.verify(undefined, Buffer.from(`${postId}:${status ?? 'none'}`), publicKeyObject, Buffer.from(signature, 'base64'));
            if (!valid) throw new Error('Invalid cryptographic signature for RSVP');
        } catch (err: any) {
            if (err.message === 'Invalid cryptographic signature for RSVP') throw err;
            throw new Error('Invalid RSVP signature format');
        }
    }

    db.transaction(() => {
        // Atomically re-check the event is still open and bump updated_at so delta sync carries the change.
        const res = db.prepare(
            "UPDATE posts SET updated_at = ? WHERE id = ? AND active = 1 AND status = 'active' AND COALESCE(event_state, '') != 'cancelled' AND event_end_at > ?"
        ).run(nowIso, postId, nowIso);
        if (res.changes === 0) {
            throw new Error('This event is no longer open');
        }
        // RSVP writes and their tombstones must be strictly ordered in time, or a replica cannot tell
        // "not going, then going again" from "going, then not going" when both land in one millisecond.
        const rowKey = `${postId}|${memberPublicKey}`;
        const prev = db.prepare(`
            SELECT MAX(ts) AS ts FROM (
                SELECT updated_at AS ts FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?
                UNION ALL
                SELECT deleted_at AS ts FROM tombstones WHERE table_name = 'event_rsvps' AND row_key = ?
            )`).get(postId, memberPublicKey, rowKey) as { ts: string | null } | undefined;
        const writeAt = prev?.ts && prev.ts >= nowIso
            ? new Date(Date.parse(prev.ts) + 1).toISOString()
            : nowIso;
        if (status === null) {
            const del = db.prepare("DELETE FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?").run(postId, memberPublicKey);
            if (del.changes > 0) {
                db.prepare(`INSERT OR REPLACE INTO tombstones (table_name, row_key, deleted_at) VALUES ('event_rsvps', ?, ?)`).run(rowKey, writeAt);
            }
        } else {
            db.prepare(`
                INSERT INTO event_rsvps (post_id, member_pubkey, status, signature, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(post_id, member_pubkey) DO UPDATE SET
                    status = excluded.status,
                    signature = excluded.signature,
                    updated_at = excluded.updated_at
            `).run(postId, memberPublicKey, status, signature || '', writeAt);
        }
    })();

    bumpPostsVersion();
    const updatedPost = getPosts(db, { id: postId, viewerPubkey: memberPublicKey, includeAllScopes: true })[0]!;
    broadcast({ type: 'post_updated', post: publicBroadcastPost(updatedPost) }, audienceRecipients(row));
    return { success: true, post: updatedPost };
}

export function closePoll(broadcast: BroadcastFn, postId: string, authorPublicKey: string): MarketplacePost | null {
    const post = getPosts(db, { id: postId, includeAllScopes: true })[0];
    if (!post || post.type !== 'poll') {
        throw new Error('Poll not found');
    }
    if (post.authorPublicKey !== authorPublicKey) {
        throw new Error('Only the author can close a poll');
    }
    if (post.status === 'completed') {
        return post;
    }
    const now = new Date().toISOString();
    db.prepare("UPDATE posts SET status = 'completed', updated_at = ? WHERE id = ?").run(now, postId);
    bumpPostsVersion();
    const updated = getPosts(db, { id: postId, viewerPubkey: authorPublicKey, includeAllScopes: true })[0] ?? null;
    if (updated) {
        let recipients: string[] | undefined;
        if (updated.audienceScope === 'group' && updated.targetGroupId) {
            const rows = db.prepare("SELECT member_pubkey FROM group_members WHERE group_id = ? AND status = 'active'").all(updated.targetGroupId) as any[];
            recipients = rows.map(r => r.member_pubkey);
        } else if (updated.audienceScope === 'direct') {
            recipients = Array.from(new Set([updated.authorPublicKey, updated.targetPubkey, updated.assignedTo].filter(Boolean) as string[]));
        }
        broadcast({ type: 'post_updated', post: updated }, recipients);
    }
    return updated;
}

export function votePoll(
    broadcast: BroadcastFn,
    postId: string,
    voterPublicKey: string,
    optionId: string,
    signature?: string
): { success: boolean; post: MarketplacePost } {
    assertMemberActive(voterPublicKey);
    const memberRow = db.prepare("SELECT status, credit_frozen FROM members WHERE public_key = ?").get(voterPublicKey) as any;
    if (!memberRow || memberRow.status !== 'active') {
        throw new Error('Only active members can vote in polls');
    }
    if (memberRow.credit_frozen) {
        throw new Error('Credit-frozen members cannot vote in polls');
    }

    const post = getPosts(db, { id: postId, includeAllScopes: true })[0];
    if (!post || post.type !== 'poll') {
        throw new Error('Poll not found');
    }
    if (post.status !== 'active') {
        throw new Error('This poll is closed');
    }
    if (post.audienceScope === 'group') {
        if (!post.targetGroupId) {
            throw new Error('UNAUTHORIZED: Group-scoped poll missing target group');
        }
        const isMem = db.prepare(
            "SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status = 'active' AND role IN ('convenor', 'member')"
        ).get(post.targetGroupId, voterPublicKey);
        if (!isMem && post.authorPublicKey !== voterPublicKey) {
            throw new Error('UNAUTHORIZED: Must be an active convenor or member of the group to vote in this poll');
        }
    } else if (post.audienceScope === 'direct') {
        const isTarget = post.targetPubkey === voterPublicKey || post.assignedTo === voterPublicKey || post.authorPublicKey === voterPublicKey;
        if (!isTarget) {
            throw new Error('UNAUTHORIZED: This direct poll is not addressed to you');
        }
    }
    const nowIso = new Date().toISOString();
    if (post.pollClosesAt && post.pollClosesAt <= nowIso) {
        db.prepare("UPDATE posts SET status = 'completed', updated_at = ? WHERE id = ?").run(nowIso, postId);
        bumpPostsVersion();
        throw new Error('This poll is closed');
    }

    const options = post.pollOptions || [];
    const validOption = options.some(opt => opt.id === optionId);
    if (!validOption) {
        throw new Error('Invalid poll option');
    }

    if (signature) {
        try {
            const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
            const spki = Buffer.concat([spkiHeader, Buffer.from(voterPublicKey, 'hex')]);
            const publicKeyObject = crypto.createPublicKey({
                key: spki,
                format: 'der',
                type: 'spki'
            });
            const sigBuf = Buffer.from(signature, 'base64');
            const valid = crypto.verify(undefined, Buffer.from(`${postId}:${optionId}`), publicKeyObject, sigBuf)
                || crypto.verify(undefined, Buffer.from(JSON.stringify({ postId, optionId })), publicKeyObject, sigBuf);
            if (!valid) {
                throw new Error('Invalid cryptographic signature for vote');
            }
        } catch (err: any) {
            if (err.message === 'Invalid cryptographic signature for vote') {
                throw err;
            }
            throw new Error('Invalid vote signature format');
        }
    }

    db.transaction(() => {
        // Atomically verify poll is active and bump updated_at for delta sync
        const res = db.prepare(
            "UPDATE posts SET updated_at = ? WHERE id = ? AND status = 'active' AND (poll_closes_at IS NULL OR poll_closes_at > ?)"
        ).run(nowIso, postId, nowIso);
        if (res.changes === 0) {
            throw new Error('This poll is closed');
        }

        db.prepare(`
            INSERT INTO poll_votes (post_id, voter_pubkey, option_id, signature, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(post_id, voter_pubkey) DO UPDATE SET
                option_id = excluded.option_id,
                signature = excluded.signature,
                created_at = excluded.created_at
        `).run(postId, voterPublicKey, optionId, signature || '', nowIso);
    })();

    bumpPostsVersion();
    const updatedPost = getPosts(db, { id: postId, viewerPubkey: voterPublicKey, includeAllScopes: true })[0]!;
    let recipients: string[] | undefined;
    if (updatedPost.audienceScope === 'group' && updatedPost.targetGroupId) {
        const rows = db.prepare("SELECT member_pubkey FROM group_members WHERE group_id = ? AND status = 'active'").all(updatedPost.targetGroupId) as any[];
        recipients = rows.map(r => r.member_pubkey);
    } else if (updatedPost.audienceScope === 'direct') {
        recipients = Array.from(new Set([updatedPost.authorPublicKey, updatedPost.targetPubkey, updatedPost.assignedTo].filter(Boolean) as string[]));
    }
    broadcast({ type: 'post_updated', post: updatedPost }, recipients);
    return { success: true, post: updatedPost };
}

export function pausePost(broadcast: BroadcastFn, postId: string, authorPublicKey: string): boolean {
    const postRow = db.prepare("SELECT audience_scope, target_group_id, target_pubkey, assigned_to FROM posts WHERE id = ?").get(postId) as any;
    const res = db.prepare(`UPDATE posts SET status = 'paused', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND author_pubkey = ? AND status = 'active'`).run(postId, authorPublicKey);
    if (res.changes > 0) {
        let recipients: string[] | undefined;
        if (postRow?.audience_scope === 'group' && postRow.target_group_id) {
            const rows = db.prepare("SELECT member_pubkey FROM group_members WHERE group_id = ? AND status = 'active'").all(postRow.target_group_id) as any[];
            recipients = rows.map(r => r.member_pubkey);
        } else if (postRow?.audience_scope === 'direct') {
            recipients = Array.from(new Set([authorPublicKey, postRow.target_pubkey, postRow.assigned_to].filter(Boolean) as string[]));
        }
        broadcast({ type: 'post_updated', id: postId }, recipients);
        return true;
    }
    return false;
}

export function resumePost(broadcast: BroadcastFn, postId: string, authorPublicKey: string): boolean {
    const postRow = db.prepare("SELECT audience_scope, target_group_id, target_pubkey, assigned_to FROM posts WHERE id = ?").get(postId) as any;
    const res = db.prepare(`UPDATE posts SET status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND author_pubkey = ? AND status = 'paused'`).run(postId, authorPublicKey);
    if (res.changes > 0) {
        let recipients: string[] | undefined;
        if (postRow?.audience_scope === 'group' && postRow.target_group_id) {
            const rows = db.prepare("SELECT member_pubkey FROM group_members WHERE group_id = ? AND status = 'active'").all(postRow.target_group_id) as any[];
            recipients = rows.map(r => r.member_pubkey);
        } else if (postRow?.audience_scope === 'direct') {
            recipients = Array.from(new Set([authorPublicKey, postRow.target_pubkey, postRow.assigned_to].filter(Boolean) as string[]));
        }
        broadcast({ type: 'post_updated', id: postId }, recipients);
        return true;
    }
    return false;
}

type TransferFn = (from: string, to: string, amount: number, memo: string, method?: 'direct' | 'escrow', isFeeExempt?: boolean) => any;
type ConservingTxnFn = <T>(fn: () => T) => T;

export function adminDeletePost(broadcast: BroadcastFn, postId: string, transferFn?: TransferFn, conservingTxn?: ConservingTxnFn): boolean {
    let deleted = false;
    const runTx = conservingTxn ? (fn: () => void) => conservingTxn(fn) : (fn: () => void) => db.transaction(fn)();
    runTx(() => {
        if (transferFn) {
            const pending = db.prepare("SELECT * FROM marketplace_transactions WHERE post_id=? AND status='pending'").all(postId) as any[];
            for (const tx of pending) {
                transferFn(`escrow_${tx.id}`, tx.buyer_pubkey, tx.credits, `Escrow refund for removed post`, 'escrow', true);
                db.prepare("UPDATE marketplace_transactions SET status='cancelled', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(tx.id);
            }
        }
        db.prepare("UPDATE marketplace_transactions SET status='cancelled', completed_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE post_id=? AND status='requested'").run(postId);
        const result = db.prepare("UPDATE posts SET active=0, status='cancelled', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(postId);
        if (result.changes > 0) {
            deleted = true;
            db.prepare("UPDATE deferred_wage_claims SET status = 'cancelled' WHERE post_id = ? AND status = 'pending'").run(postId);
        }
    });
    if (!deleted) return false;
    broadcast({ type: 'post_removed', id: postId });
    return true;
}

export function adminBulkDeletePosts(broadcast: BroadcastFn, postIds: string[], transferFn?: TransferFn, conservingTxn?: ConservingTxnFn): number {
    let deletedCount = 0;
    for (const postId of postIds) {
        if (adminDeletePost(broadcast, postId, transferFn, conservingTxn)) {
            deletedCount++;
        }
    }
    return deletedCount;
}
