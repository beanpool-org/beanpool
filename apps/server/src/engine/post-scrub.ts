/**
 * Delete account (report C14, recommendation b): what a member put in their posts goes with the account.
 *
 * `purgeMemberSelf` (state-engine.ts) cancels the posts that could come back and closes the open polls; this wipes every
 * post the key wrote, whatever its status: one that was already cancelled or done keeps what the member wrote just as
 * much. Each keeps its row and its id, because the deals, the chats, the reports and the wage claims that name it must
 * still find it, and loses:
 *   - its title (DELETED_POST_TITLE) and description (empty), and the search words made from them;
 *   - every photo: the row, with a `post_photos` tombstone per slot so a standby deletes its copy too, and the object in
 *     the image store once the deletion has committed (storage design §7: row first);
 *   - its place: the pin (lat, lng) and, for an event, the place name and the private note for the people going.
 * An event's replies go (with an `event_rsvps` tombstone each, as the 30-day scrub writes them): the event is cancelled,
 * so nobody is reminded of it again, and nothing counts or lists them. Its chat keeps its messages until the 30-day
 * scrub, as a cancelled event's does, under the neutral title.
 *
 * A poll is left as it is: a closed poll is the community's record, its question and votes stay, and its author already
 * reads as Deleted Member. An admin's removal (adminPruneUser) keeps the posts' words, photos and places: a vote can
 * bring the member back.
 *
 * The copies of a title kept elsewhere go too: the event chat's name (engine/event-thread.ts ensureEventThread), the
 * titles in the activity feed, and a pricing guide item's picture that points at one of the photos (pricing-aggregator.ts).
 */

import { generateSearchKeywords } from '@beanpool/engine';
import { db, afterTransactionCommit } from '../db/db.js';
import { deleteStoredObjects } from '../storage/image-columns.js';
import { bumpActivityVersion } from './versions.js';

/** What a deleted member's post is called from then on. Its description is empty. */
export const DELETED_POST_TITLE = 'Deleted post';

/** The name the anonymised profile takes (state-engine.ts purgeMemberSelf), for the copies of it this wipes. */
const DELETED_MEMBER = 'Deleted Member';

/**
 * A tombstone stamped no earlier than the row it deletes: a standby deletes its copy only when the tombstone is not older
 * than the row (engine/sync.ts), and an RSVP can be stamped a millisecond ahead of the clock (engine/posts.ts rsvpEvent).
 */
function tombstoneRow(table: 'post_photos' | 'event_rsvps', rowKey: string, at: string, rowStamp: string | null): void {
    const deletedAt = rowStamp && rowStamp > at ? rowStamp : at;
    db.prepare('INSERT OR REPLACE INTO tombstones (table_name, row_key, deleted_at) VALUES (?, ?, ?)').run(table, rowKey, deletedAt);
}

/**
 * Wipe the posts `publicKey` wrote, stamped `at`. Inside the caller's transaction: the rows, the tombstones and the copies
 * go with the account or not at all, and the photos' objects and the search index's leftovers only once it has committed.
 * Returns the ids of the posts it wiped.
 */
export function scrubPostsOf(publicKey: string, at: string): string[] {
    const posts = db.prepare(`SELECT id, type, category FROM posts WHERE author_pubkey = ? AND type != 'poll'`)
        .all(publicKey) as { id: string; type: string; category: string | null }[];
    if (posts.length === 0) return [];

    const photosOf = db.prepare('SELECT order_num, storage_key, updated_at FROM post_photos WHERE post_id = ?');
    const dropPhotos = db.prepare('DELETE FROM post_photos WHERE post_id = ?');
    // Stamped, so a standby's delta carries it: the touch trigger restamps a row whose stamp this leaves as it was.
    const wipe = db.prepare(`
        UPDATE posts
           SET title = ?, description = '', search_keywords = ?,
               lat = NULL, lng = NULL, event_place_name = NULL, event_private_note = NULL,
               updated_at = ?
         WHERE id = ?`);
    const repliesTo = db.prepare('SELECT member_pubkey, updated_at FROM event_rsvps WHERE post_id = ?');
    const dropReplies = db.prepare('DELETE FROM event_rsvps WHERE post_id = ?');
    const renameChat = db.prepare(`UPDATE conversations SET name = ? WHERE id = ? AND type = 'event_thread'`);
    const doomed: string[] = [];

    for (const p of posts) {
        const photos = photosOf.all(p.id) as { order_num: number; storage_key: string | null; updated_at: string | null }[];
        if (photos.length > 0) {
            dropPhotos.run(p.id);
            for (const ph of photos) {
                tombstoneRow('post_photos', `${p.id}|${ph.order_num}`, at, ph.updated_at);
                if (ph.storage_key) doomed.push(ph.storage_key);
            }
        }
        // The words an edit to this text would give it (engine/posts.ts updatePost): never empty, so the boot backfill
        // (state-engine.ts backfillSearchKeywords) leaves the row alone.
        wipe.run(DELETED_POST_TITLE, generateSearchKeywords(DELETED_POST_TITLE, '', p.category || 'general'), at, p.id);
        if (p.type === 'event') {
            const replies = repliesTo.all(p.id) as { member_pubkey: string; updated_at: string | null }[];
            dropReplies.run(p.id);
            for (const r of replies) tombstoneRow('event_rsvps', `${p.id}|${r.member_pubkey}`, at, r.updated_at);
            // This node's own delivery log, never replicated (engine/posts.ts scrubEndedEvents).
            try { db.prepare('DELETE FROM event_reminders_sent WHERE post_id = ?').run(p.id); } catch { }
            // The chat's id is the post's, and its name the title the event had when the chat was made. A standby's delta
            // carries it with the event (@beanpool/engine sync.ts, the conversations of the events in a delta).
            renameChat.run(DELETED_POST_TITLE, p.id);
        }
    }

    const ids = JSON.stringify(posts.map(p => p.id));
    // The activity feed (this server's own, never replicated) names a post by its title as it was: a new listing's
    // `title`, a deal's and a ruling's `postTitle`. A ruling also names the other party of the deal as they were then.
    const feed = db.prepare(`
        UPDATE activity_feed SET metadata = json_replace(metadata, '$.title', ?, '$.postTitle', ?)
         WHERE json_valid(metadata) AND json_extract(metadata, '$.postId') IN (SELECT value FROM json_each(?))`)
        .run(DELETED_POST_TITLE, DELETED_POST_TITLE, ids).changes;
    const named = db.prepare(`
        UPDATE activity_feed SET metadata = json_replace(metadata, '$.counterpartyCallsign', ?)
         WHERE json_valid(metadata) AND json_extract(metadata, '$.counterpartyPubkey') = ?`)
        .run(DELETED_MEMBER, publicKey).changes;
    if (feed + named > 0) bumpActivityVersion();
    // A pricing guide item's picture, when the aggregator took it from one of these posts. The next run finds another.
    db.prepare(`
        UPDATE pricing_guide_items SET thumbnail_url = NULL, updated_at = ?
         WHERE thumbnail_url IS NOT NULL
           AND EXISTS (SELECT 1 FROM json_each(?) WHERE instr(thumbnail_url, '/api/marketplace/posts/' || value || '/photos/') > 0)`)
        .run(at, ids);

    if (doomed.length > 0) afterTransactionCommit(() => deleteStoredObjects(doomed));
    afterTransactionCommit(dropSearchLeftovers);
    return posts.map(p => p.id);
}

/**
 * The words a wiped post had, out of the search index for good. An FTS5 delete (the posts_au trigger) takes a row's old
 * words out of every search at once, but writes them again as a delete marker beside the segment that still holds them,
 * and both stay in `posts_fts_data` until FTS5 happens to merge those segments. `optimize` merges every segment into one
 * now, without them. It rewrites the whole index, so it runs only after a wipe: here, and on a standby when a copy brings
 * one (engine/sync.ts). Never throws: the wipe has committed, and the next merge would drop them anyway.
 */
export function dropSearchLeftovers(): void {
    try {
        db.prepare(`INSERT INTO posts_fts(posts_fts) VALUES('optimize')`).run();
    } catch (e) {
        console.warn('[Search] Could not merge the search index after a deleted account\'s posts were wiped:', e);
    }
}
