/**
 * Living Activity Waterfall Database Layer (#208).
 *
 * Persists and retrieves ambient community activity events:
 * - Member joins (member_joined)
 * - Completed marketplace trades (trade_completed)
 * - Ratings given (rating_given)
 * - New marketplace posts (post_created)
 */

import { db } from './db.js';
import { bumpActivityVersion } from '../engine/versions.js';

export type ActivityEventType = 'member_joined' | 'trade_completed' | 'rating_given' | 'post_created' | 'dispute_resolved';

export interface ActivityFeedItem {
    id: number;
    eventType: ActivityEventType;
    actorPubkey: string;
    actorCallsign?: string;
    targetPubkey?: string;
    targetCallsign?: string;
    metadata?: Record<string, any>;
    createdAt: string;
}

/**
 * The most rows the feed query will ever return, whatever a caller asks for. Exported so the
 * route can build its ETag from the same bound the query enforces, rather than from the raw
 * requested limit.
 */
export const ACTIVITY_FEED_MAX_LIMIT = 100;

/**
 * Prepared once. better-sqlite3 compiles the SQL on every `prepare()` call, and this runs on
 * every recorded event on a 1-CPU node shared with four other containers.
 */
let insertActivityStmt: { run: (...args: any[]) => { lastInsertRowid: number | bigint } } | null = null;

/**
 * Records a new community activity event into the feed.
 */
export function recordActivity(
    eventType: ActivityEventType,
    actorPubkey: string,
    targetPubkey?: string | null,
    metadata?: Record<string, any>
): number {
    if (!eventType || !actorPubkey) return 0;

    const metaStr = metadata ? JSON.stringify(metadata) : null;
    if (!insertActivityStmt) {
        insertActivityStmt = db.prepare(`
            INSERT INTO activity_feed (event_type, actor_pubkey, target_pubkey, metadata)
            VALUES (?, ?, ?, ?)
        `);
    }

    const result = insertActivityStmt.run(eventType, actorPubkey, targetPubkey || null, metaStr);
    bumpActivityVersion();
    return Number(result.lastInsertRowid);
}

/**
 * Retrieves recent community activity events with member callsigns joined.
 */
export function getActivityFeed(limit: number = 50, offset: number = 0): ActivityFeedItem[] {
    const safeLimit = Math.max(1, Math.min(ACTIVITY_FEED_MAX_LIMIT, limit));
    const safeOffset = Math.max(0, offset);

    const rows = db.prepare(`
        SELECT 
            af.id,
            af.event_type,
            af.actor_pubkey,
            af.target_pubkey,
            af.metadata,
            af.created_at,
            actor.callsign AS actor_callsign,
            target.callsign AS target_callsign
        FROM activity_feed af
        LEFT JOIN members actor ON actor.public_key = af.actor_pubkey
        LEFT JOIN members target ON target.public_key = af.target_pubkey
        -- A post hidden by reports (G3) is not announced here: the feed is the same for every member. Hiding and
        -- restoring bump the activity version (engine/auto-moderation.ts).
        WHERE NOT (af.event_type = 'post_created' AND EXISTS (
            SELECT 1 FROM posts hp
             WHERE hp.id = CASE WHEN json_valid(af.metadata) THEN json_extract(af.metadata, '$.postId') END
               AND hp.hidden_by_reports_at IS NOT NULL))
        ORDER BY af.created_at DESC, af.id DESC
        LIMIT ? OFFSET ?
    `).all(safeLimit, safeOffset) as any[];

    return rows.map(r => {
        let metaObj: Record<string, any> | undefined = undefined;
        if (r.metadata) {
            try {
                metaObj = JSON.parse(r.metadata);
            } catch {
                // Ignore parse errors on malformed metadata
            }
        }

        return {
            id: r.id,
            eventType: r.event_type as ActivityEventType,
            actorPubkey: r.actor_pubkey,
            actorCallsign: r.actor_callsign || undefined,
            targetPubkey: r.target_pubkey || undefined,
            targetCallsign: r.target_callsign || undefined,
            metadata: metaObj,
            createdAt: r.created_at,
        };
    });
}

/**
 * The posts `postIds` renamed `title` in the lines that name them as they were: a new listing's `title`, a deal's and a
 * ruling's `postTitle` (Delete account, engine/post-scrub.ts). Returns the lines changed.
 */
export function retitlePostsInActivity(postIds: string[], title: string): number {
    if (postIds.length === 0) return 0;
    const changed = db.prepare(`
        UPDATE activity_feed SET metadata = json_replace(metadata, '$.title', ?, '$.postTitle', ?)
         WHERE json_valid(metadata) AND json_extract(metadata, '$.postId') IN (SELECT value FROM json_each(?))`)
        .run(title, title, JSON.stringify(postIds)).changes;
    if (changed > 0) bumpActivityVersion();
    return changed;
}

/**
 * The name `publicKey` had, as the lines keep it, replaced by `name`: their own join's `callsign`, and a ruling's
 * `counterpartyCallsign` on the other party's line (Delete account, state-engine.ts purgeMemberSelf). Every other line
 * names them by key, and reads the name from their row. Returns the lines changed.
 */
export function renameMemberInActivity(publicKey: string, name: string): number {
    const joined = db.prepare(`
        UPDATE activity_feed SET metadata = json_replace(metadata, '$.callsign', ?)
         WHERE event_type = 'member_joined' AND actor_pubkey = ? AND json_valid(metadata)`).run(name, publicKey).changes;
    const ruled = db.prepare(`
        UPDATE activity_feed SET metadata = json_replace(metadata, '$.counterpartyCallsign', ?)
         WHERE json_valid(metadata) AND json_extract(metadata, '$.counterpartyPubkey') = ?`).run(name, publicKey).changes;
    if (joined + ruled > 0) bumpActivityVersion();
    return joined + ruled;
}

/**
 * Prunes activity feed events older than specified retention days.
 * Kept lean (default 30 days) to prevent unbound table growth.
 */
export function pruneOldActivity(days: number = 30): number {
    const res = db.prepare(`
        DELETE FROM activity_feed 
        WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' days')
    `).run(Math.max(1, days));

    if (res.changes > 0) {
        bumpActivityVersion();
    }

    return res.changes;
}
