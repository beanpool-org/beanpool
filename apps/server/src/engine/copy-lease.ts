/**
 * A copy's lease (scratch/fable-design/DESIGN-no-switch-messaging-fable.md §4; Marty, 19 Nov 2026: "yes to all 5"): a member's
 * copy on this community (engine/event-copy.ts) stays on the board while a device of its member says it is still in step with
 * the listing at home, and comes off it when none has for {@link COPY_LEASE_DAYS}. Today's 90-day retention
 * (engine/posts.ts archiveStaleListings) still ends it after that; this is the backstop for a copy nobody tends any more: its
 * phone lost, its listing deleted from a device that never held its pair (Damo, 16 Nov), or a 1.4.6 phone's.
 *
 * - **Who says so.** Only a device signed by the copy's own author, three ways: the create, an edit, and the confirm route a
 *   device calls once a day for the copies it tends (@beanpool/core show-on-global.ts). A 1.4.6 phone sends no confirm, but its
 *   edits and its 30-day resend are writes, and each one counts. Nothing else does: a pause, a resume or a moderator's hand is
 *   no device's word that the listing is still on at home.
 * - **Off the board, not gone.** A copy past its lease is paused, as its author's own pause takes a post off (status 'paused'):
 *   out of every board read for everyone but its author, and a phone's next sync takes it out of its Market. Its row, photos
 *   and id stay, so a device that comes back finds it where it was and its confirm puts it straight back on.
 * - **Only what the lease took off goes back.** `hidden_at` says the lease paused it; a pause by its author has none, and a
 *   confirm leaves that one paused.
 * - **The home community does nothing and learns nothing**, as with every copy. This node learns nothing it didn't have: that
 *   the author's device is still about, which its edits said already.
 * - **A copy from before this table** has no lease row and keeps today's rule alone, until its first write from a device
 *   gives it one. Nothing here exists to bring the old ones in (no conversion code, Marty 10 Nov).
 */
import { db } from '../db/db.js';
import { assertPlainTablesWritable, getNodeRole } from '../config/node-role.js';
import { bumpPostsVersion } from './versions.js';

/** A copy no device of its member has confirmed in this many days comes off the board. */
export const COPY_LEASE_DAYS = 14;
/** The most copies one confirm names: a device sends its copies in reads of this many (core show-on-global.ts). */
export const COPY_CONFIRM_MOST = 100;
/** At most this many copies a sweep takes off; the rest wait for the next hourly run. */
export const COPY_LEASE_SWEEP_BATCH = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

type Broadcast = (event: any) => void;

/**
 * The author's device says these copies are still in step at home: each of the signer's own copies has its lease from now, and
 * one the lease took off the board goes back on. Anything else named, someone else's post or a post that is no copy, is passed
 * over and says nothing of itself. Gives the ids it took.
 */
export function confirmCopies(broadcast: Broadcast, ids: readonly string[], signer: string, at: string = new Date().toISOString()): string[] {
    assertPlainTablesWritable();
    const own = db.prepare('SELECT 1 FROM posts WHERE id = ? AND author_pubkey = ? AND shown_from_host IS NOT NULL');
    const leaseOf = db.prepare('SELECT hidden_at FROM copy_leases WHERE post_id = ?');
    const lease = db.prepare(`INSERT INTO copy_leases (post_id, confirmed_at, hidden_at, updated_at) VALUES (?, ?, NULL, ?)
        ON CONFLICT(post_id) DO UPDATE SET confirmed_at = excluded.confirmed_at, hidden_at = NULL, updated_at = excluded.updated_at`);
    const backOn = db.prepare(`UPDATE posts SET status = 'active', updated_at = ? WHERE id = ? AND status = 'paused'`);
    const taken: string[] = [];
    const shown: string[] = [];
    db.transaction(() => {
        for (const id of new Set(ids)) {
            if (!own.get(id, signer)) continue;
            const hidden = (leaseOf.get(id) as { hidden_at: string | null } | undefined)?.hidden_at;
            lease.run(id, at, at);
            if (hidden && backOn.run(at, id).changes > 0) shown.push(id);
            taken.push(id);
        }
    })();
    if (shown.length > 0) {
        bumpPostsVersion();
        // By id alone, as a pause is told (engine/posts.ts pausePost): a copy's socket names nobody.
        for (const id of shown) broadcast({ type: 'post_updated', id });
    }
    return taken;
}

/**
 * Each copy on the board whose lease has run out comes off it: paused, and marked as the lease's. Oldest first, at most
 * `batch` a run. Main server only: a standby gets the result with its next copy. Gives how many came off.
 */
export function sweepCopyLeases(broadcast: Broadcast, nowMs: number = Date.now(), batch: number = COPY_LEASE_SWEEP_BATCH): number {
    if (getNodeRole() !== 'primary') return 0;
    const cutoff = new Date(nowMs - COPY_LEASE_DAYS * DAY_MS).toISOString();
    const due = db.prepare(`
        SELECT p.id FROM posts p JOIN copy_leases l ON l.post_id = p.id
         WHERE p.shown_from_host IS NOT NULL AND p.active = 1 AND p.status = 'active' AND l.confirmed_at < ?
         ORDER BY l.confirmed_at, p.id
         LIMIT ?`).all(cutoff, batch) as { id: string }[];
    if (due.length === 0) return 0;
    const off = db.prepare(`UPDATE posts SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'`);
    const mark = db.prepare('UPDATE copy_leases SET hidden_at = ?, updated_at = ? WHERE post_id = ?');
    const hidden: string[] = [];
    for (const { id } of due) {
        try {
            const at = new Date().toISOString();
            db.transaction(() => {
                if (off.run(at, id).changes === 0) return;
                mark.run(at, at, id);
                hidden.push(id);
            })();
        } catch (e) {
            // One bad row must not stop the rest, nor the hourly tick that runs this.
            console.warn(`[Copies] could not take copy ${id.slice(0, 8)} off the board:`, e);
        }
    }
    if (hidden.length === 0) return 0;
    bumpPostsVersion();
    for (const id of hidden) broadcast({ type: 'post_updated', id });
    return hidden.length;
}
