/**
 * Daily Pulse — Auto-generated daily inspirational community offer.
 * Rotates daily at 5:00 AM local time so the marketplace is never empty.
 * Zero push notifications, zero DMs — passive discovery in marketplace only.
 */

import { db } from './db/db.js';
import { createTreasury, createPost, getPosts, getNodeRole } from './state-engine.js';
import { getTodaysPulseEntry, type DailyPulseEntry } from './daily-pulse-entries.js';

export const PULSE_CALLSIGN = 'Daily Pulse';
export const PULSE_AVATAR = 'bundled://sprout';

let _pulseTimer: NodeJS.Timeout | null = null;
let _stmtFindPulseMember: any = null;
let _stmtGetActivePulse: any = null;

function getStmtFindPulseMember() {
    if (!_stmtFindPulseMember) {
        _stmtFindPulseMember = db.prepare(
            "SELECT public_key, is_treasury FROM members WHERE lower(callsign) = lower(?) AND status NOT IN ('migrated', 'pruned')"
        );
    }
    return _stmtFindPulseMember;
}

function getStmtGetActivePulse() {
    if (!_stmtGetActivePulse) {
        _stmtGetActivePulse = db.prepare(
            "SELECT id, title FROM posts WHERE author_pubkey = ? AND active = 1 AND status = 'active' ORDER BY created_at DESC LIMIT 1"
        );
    }
    return _stmtGetActivePulse;
}

/**
 * Ensures the system Treasury identity for "Daily Pulse" exists.
 * If a regular member already registered "Daily Pulse", it promotes it to is_treasury = 1.
 */
export function ensurePulseTreasury(): string {
    const existing = getStmtFindPulseMember().get(PULSE_CALLSIGN) as { public_key: string; is_treasury: number } | undefined;

    if (existing?.public_key) {
        if (!existing.is_treasury) {
            db.prepare("UPDATE members SET is_treasury = 1 WHERE public_key = ?").run(existing.public_key);
        }
        return existing.public_key;
    }

    const created = createTreasury(PULSE_CALLSIGN, PULSE_AVATAR, 0, { systemCreated: true });
    return created.publicKey;
}

/**
 * Rotates the Daily Pulse post in the marketplace.
 * 1. Soft-deletes yesterday's Pulse offer atomically in SQL.
 * 2. Fetches today's compressed entry (modulo 300).
 * 3. Creates today's 0-Bean offer authored by Daily Pulse Treasury with local reach.
 * Deterministic ID (pulse_YYYY-MM-DD) enforces idempotency across concurrent rotations.
 */
export function rotateDailyPulse(now: Date = new Date()): { post: any; entry: DailyPulseEntry } {
    const pulsePubkey = ensurePulseTreasury();
    const entry = getTodaysPulseEntry(now);
    const pulseId = `pulse_${now.toISOString().split('T')[0]}`;

    return db.transaction(() => {
        // 1. Clean up any previous pulse offers that are NOT today's deterministic pulse ID
        db.prepare(
            "UPDATE posts SET active = 0, status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE author_pubkey = ? AND id != ? AND active = 1 AND status = 'active'"
        ).run(pulsePubkey, pulseId);

        // 2. Check if today's pulse post already exists in the database
        const existingToday = db.prepare("SELECT * FROM posts WHERE id = ?").get(pulseId) as any;
        if (existingToday) {
            if (existingToday.active !== 1 || existingToday.status !== 'active') {
                db.prepare(
                    "UPDATE posts SET active = 1, status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
                ).run(pulseId);
            }
            const activePosts = getPosts({ id: pulseId });
            const post = activePosts[0] || existingToday;
            console.log(`[DailyPulse] Retained existing Daily Pulse for ${now.toISOString().split('T')[0]}: "${entry.headline}" (ID: ${post.id})`);
            return { post, entry };
        }

        // 3. Create the new 0-Bean post (reach: 'local' so peers are not flooded)
        const post = createPost(
            'offer',
            entry.category || 'general',
            entry.headline,
            entry.body,
            0,
            'fixed',
            pulsePubkey,
            undefined, // lat
            undefined, // lng
            undefined, // photos
            false,     // repeatable
            pulseId,   // deterministic id enforces idempotency
            false,     // cashAlsoNeeded
            { reach: 'local' }
        );

        if (!post) {
            throw new Error(`[DailyPulse] Failed to create Daily Pulse post: "${entry.headline}"`);
        }

        console.log(`[DailyPulse] Rotated Daily Pulse for ${now.toISOString().split('T')[0]}: "${entry.headline}" (ID: ${post.id})`);
        return { post, entry };
    })();
}

/**
 * Returns the currently active Daily Pulse post, if any.
 */
export function getActivePulsePost(): { id: string; title: string } | null {
    const pulsePubkey = ensurePulseTreasury();
    const row = getStmtGetActivePulse().get(pulsePubkey) as { id: string; title: string } | undefined;
    return row?.id ? row : null;
}

/**
 * Schedules daily rotation at 5:00 AM local time.
 * Re-computes target time dynamically for robust DST handling.
 */
export function scheduleDailyPulse(config?: { dailyPulse?: boolean }): void {
    if (getNodeRole() !== 'primary') {
        console.log('[DailyPulse] Skipping Daily Pulse scheduling — backup replica.');
        return;
    }

    if (config?.dailyPulse === false || process.env.DAILY_PULSE === 'false') {
        console.log('[DailyPulse] Daily Pulse disabled in configuration.');
        return;
    }

    // Ensure today has an active pulse post matching today's headline on boot
    const todaysEntry = getTodaysPulseEntry();
    const active = getActivePulsePost();
    if (!active || active.title !== todaysEntry.headline) {
        try {
            rotateDailyPulse();
        } catch (err) {
            console.error('[DailyPulse] Error initializing Daily Pulse on boot:', err);
        }
    }

    function scheduleNext(): void {
        const now = new Date();
        const next5AM = new Date(now);
        next5AM.setHours(5, 0, 0, 0);
        if (next5AM.getTime() - now.getTime() <= 1000) {
            next5AM.setDate(next5AM.getDate() + 1);
        }
        const delay = Math.max(1000, next5AM.getTime() - now.getTime());

        if (_pulseTimer) clearTimeout(_pulseTimer);

        _pulseTimer = setTimeout(() => {
            try {
                rotateDailyPulse();
            } catch (err) {
                console.error('[DailyPulse] Error during scheduled 5 AM rotation:', err);
            }
            scheduleNext();
        }, delay);

        if (_pulseTimer.unref) _pulseTimer.unref();
        console.log(`[DailyPulse] Scheduled next Daily Pulse rotation at ${next5AM.toLocaleString()} (in ${Math.round(delay / 1000 / 60)} mins)`);
    }

    scheduleNext();
}

/**
 * Stops any active Daily Pulse timers (for tests / server shutdown).
 */
export function stopDailyPulseTimer(): void {
    if (_pulseTimer) {
        clearTimeout(_pulseTimer);
        _pulseTimer = null;
    }
}
