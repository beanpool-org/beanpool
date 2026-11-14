/**
 * CONVERSION CODE — id CC-daily-pulse-cleanup (Marty, 15 Nov 2026: "yes lets remove it" and "we can do both").
 * expires: remove in the first node release after 1.4.3 (this file, its call in index.ts and test-daily-pulse-cleanup.ts).
 *
 * The Daily Pulse is gone: no daily item in the Pulse, no example offer in the Market. A node that ran it still holds what it
 * wrote. This takes that away, once, at a main server's start, and nothing else:
 *
 * - every Pulse item on the Daily Pulse's channel, and the channel, deleted as the Pulse deletes its rows (engine/pulse-seed.ts,
 *   Contract B): `deleted_at` stamped and the words and links cleared, so no feed, thumbnail or channel list shows them. That
 *   is the delete a standby follows: both tables travel by `updated_at` (engine/replication-manifest.ts), and neither has a
 *   tombstone a standby applies, so a row taken out of the table would stay on the standby and its copy would drift;
 * - every live post of the Daily Pulse account cancelled (active 0, status 'cancelled'), as the Daily Pulse retired
 *   yesterday's; a standby takes it by `updated_at` too. The account is the one that owns the channel, an enterprise row no
 *   person holds, and its posts are the ones the Daily Pulse made, `pulse_<date>`: never an enterprise's or a member's own.
 *
 * The Daily Pulse account's own row is left as it is, and so is every member's row and post. Idempotent: a start that finds
 * nothing writes nothing and says nothing. A standby writes nothing (its rows are its main server's); one that takes over
 * restarts as the main server and runs this then.
 */
import { db } from '../db/db.js';
import { ringListingDoorbell } from '../state-engine.js';

/** The Daily Pulse's channel, and its posts' ids (`pulse_<YYYY-MM-DD>`), as the removed daily-pulse.ts wrote them. */
const DAILY_PULSE_CHANNEL_ID = 'chan_daily_pulse';
const DAILY_PULSE_POST_ID = 'pulse_[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]';

export interface DailyPulseCleanup {
    /** Pulse items deleted. */
    items: number;
    /** 1 when the channel was deleted here, 0 when there was none or it was already gone. */
    channel: number;
    /** Daily Pulse posts cancelled. */
    posts: number;
}

/** What the Daily Pulse left on this server, taken away. Writes nothing when it finds nothing. */
export function removeDailyPulse(now: Date = new Date()): DailyPulseCleanup {
    const at = now.toISOString();
    const result = db.transaction((): DailyPulseCleanup => {
        // Read before the channel is stamped: its owner is the account the Daily Pulse wrote as (daily-pulse.ts
        // ensureDailyPulseChannel), and only while that is an enterprise row, which no person holds.
        const account = db.prepare(
            `SELECT c.owner_pubkey FROM creator_channels c JOIN members m ON m.public_key = c.owner_pubkey
              WHERE c.id = ? AND m.is_treasury = 1`,
        ).pluck().get(DAILY_PULSE_CHANNEL_ID) as string | undefined;
        const items = db.prepare(
            `UPDATE pulse_items SET deleted_at = ?, url = NULL, title = NULL, thumbnail_url = NULL, updated_at = ?
              WHERE channel_id = ? AND deleted_at IS NULL`,
        ).run(at, at, DAILY_PULSE_CHANNEL_ID).changes;
        const channel = db.prepare(
            'UPDATE creator_channels SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
        ).run(at, at, DAILY_PULSE_CHANNEL_ID).changes;
        const posts = account
            ? db.prepare(
                `UPDATE posts SET active = 0, status = 'cancelled', updated_at = ?
                  WHERE author_pubkey = ? AND id GLOB ? AND (active = 1 OR status = 'active')`,
            ).run(at, account, DAILY_PULSE_POST_ID).changes
            : 0;
        return { items, channel, posts };
    })();
    // No post event says so: a socket off the member feed is told its listing went, as the Daily Pulse told it.
    if (result.posts > 0) ringListingDoorbell('post_removed');
    if (result.items + result.channel + result.posts > 0) {
        console.log(`[CC-daily-pulse-cleanup] Daily Pulse removed: ${result.items} Pulse item(s), ${result.channel} channel, ${result.posts} post(s) cancelled.`);
    }
    return result;
}
