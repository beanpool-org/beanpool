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

let _stmtActiveMemberCount: any = null;
let _stmtActiveCountAll: any = null;

function getStmtActiveMemberCount() {
    if (!_stmtActiveMemberCount) {
        _stmtActiveMemberCount = db.prepare(
            "SELECT COUNT(*) as c FROM posts WHERE author_pubkey != ? AND active = 1 AND status = 'active'"
        );
    }
    return _stmtActiveMemberCount;
}

function getStmtActiveCountAll() {
    if (!_stmtActiveCountAll) {
        _stmtActiveCountAll = db.prepare(
            "SELECT COUNT(*) as c FROM posts WHERE active = 1 AND status = 'active'"
        );
    }
    return _stmtActiveCountAll;
}

/**
 * Pure read-only lookup of the Daily Pulse Treasury public key.
 * Does NOT generate keys or insert members into the database.
 */
export function getPulseTreasuryPubkey(): string | null {
    const existing = getStmtFindPulseMember().get(PULSE_CALLSIGN) as { public_key: string; is_treasury: number } | undefined;
    if (existing?.public_key && existing.is_treasury === 1) {
        return existing.public_key;
    }
    return null;
}

/**
 * Ensures the system Treasury identity for "Daily Pulse" exists.
 * If a regular member already registered "Daily Pulse", it safely renames that member
 * and creates the official system treasury with private keys.
 */
export function ensurePulseTreasury(): string {
    const existing = getStmtFindPulseMember().get(PULSE_CALLSIGN) as { public_key: string; is_treasury: number } | undefined;

    if (existing?.public_key) {
        if (existing.is_treasury === 1) {
            return existing.public_key;
        }
        // Non-treasury member collided with the reserved callsign — rename to free it
        const newCallsign = `Daily Pulse ${existing.public_key.substring(0, 6)}`;
        db.prepare("UPDATE members SET callsign = ? WHERE public_key = ?").run(newCallsign, existing.public_key);
    }

    const created = createTreasury(PULSE_CALLSIGN, PULSE_AVATAR, 0, { systemCreated: true });
    return created.publicKey;
}

export const DAILY_PULSE_CHANNEL_ID = 'chan_daily_pulse';

/**
 * Ensures the creator channel for Daily Pulse exists in the learn category.
 */
export function ensureDailyPulseChannel(pulsePubkey: string): string {
    const nowIso = new Date().toISOString();
    db.prepare(
        `INSERT INTO creator_channels
            (id, owner_pubkey, platform, url, handle, category, is_primary_video,
             supports_autolist, syndicate_to_node, created_at, updated_at)
         VALUES (?, ?, 'website', NULL, '@DailyPulse', 'learn', 0, 0, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
             owner_pubkey     = excluded.owner_pubkey,
             category         = 'learn',
             syndicate_to_node = 1,
             deleted_at       = NULL,
             updated_at       = excluded.updated_at`
    ).run(DAILY_PULSE_CHANNEL_ID, pulsePubkey, nowIso, nowIso);
    return DAILY_PULSE_CHANNEL_ID;
}

/**
 * Counts active real member listings in the marketplace.
 * Read-only: does not trigger treasury creation or key generation.
 * The Daily Pulse's own post is explicitly excluded so it does not count towards the threshold.
 */
export function getActiveMemberListingCount(): number {
    const pulsePubkey = getPulseTreasuryPubkey();
    if (!pulsePubkey) {
        const row = getStmtActiveCountAll().get() as { c: number } | undefined;
        return row?.c || 0;
    }
    const row = getStmtActiveMemberCount().get(pulsePubkey) as { c: number } | undefined;
    return row?.c || 0;
}

/**
 * Deactivates any active Daily Pulse marketplace post in SQL.
 * Guarded: only executes UPDATE if an active pulse post actually exists,
 * preventing write locks and updated_at churn during redundant calls.
 */
export function deactivatePulseMarketplacePost(): void {
    const pulsePubkey = getPulseTreasuryPubkey();
    if (!pulsePubkey) return;
    const active = getStmtGetActivePulse().get(pulsePubkey);
    if (!active) return;
    db.prepare(
        "UPDATE posts SET active = 0, status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE author_pubkey = ? AND active = 1 AND status = 'active'"
    ).run(pulsePubkey);
}

/**
 * Rotates the Daily Pulse content.
 * 1. Curated Daily Content: always rotated into the Pulse tab (pulse_items, category 'learn', curated = 1).
 * 2. Marketplace Gate: only creates/rotates a 0-Bean marketplace offer when the marketplace has FEWER THAN 2 listings.
 *    With 2 or more real member listings, any active marketplace offer is soft-deleted and suppressed.
 */
export function rotateDailyPulse(now: Date = new Date()): { post: any; entry: DailyPulseEntry; pulseItem?: any } {
    const pulsePubkey = ensurePulseTreasury();
    const entry = getTodaysPulseEntry(now);
    const localEpochMs = now.getTime() - (now.getTimezoneOffset() * 60 * 1000);
    const localDateStr = new Date(localEpochMs).toISOString().split('T')[0];
    const pulseId = `pulse_${localDateStr}`;
    const pulseItemId = `item_pulse_${localDateStr}`;
    const nowIso = now.toISOString();
    const publishedAt = `${localDateStr}T05:00:00.000Z`;

    return db.transaction(() => {
        // 1. Rotate curated daily content into the Pulse tab (Learn lane)
        const channelId = ensureDailyPulseChannel(pulsePubkey);

        // Soft-delete previous pulse items for chan_daily_pulse that are not today's ID
        db.prepare(
            `UPDATE pulse_items
                SET deleted_at = ?, url = NULL, title = NULL, thumbnail_url = NULL, updated_at = ?
              WHERE channel_id = ? AND id != ? AND deleted_at IS NULL`
        ).run(nowIso, nowIso, channelId, pulseItemId);

        // Check if today's pulse item already exists
        const existingPulseItem = db.prepare(
            "SELECT * FROM pulse_items WHERE id = ? AND channel_id = ?"
        ).get(pulseItemId, channelId) as any;

        let pulseItem: any;
        if (existingPulseItem) {
            db.prepare(
                `UPDATE pulse_items
                    SET title = ?, published_at = ?, category = 'learn', source = 'curated',
                        curated = 1, deleted_at = NULL, updated_at = ?
                  WHERE id = ?`
            ).run(entry.headline, publishedAt, nowIso, pulseItemId);
            pulseItem = db.prepare("SELECT * FROM pulse_items WHERE id = ?").get(pulseItemId);
        } else {
            db.prepare(
                `INSERT INTO pulse_items
                    (id, channel_id, owner_pubkey, platform, external_id, url, title,
                     thumbnail_url, published_at, category, source, muted, curated,
                     created_at, updated_at)
                 VALUES (?, ?, ?, 'website', ?, NULL, ?, NULL, ?, 'learn', 'curated', 0, 1, ?, ?)`
            ).run(
                pulseItemId,
                channelId,
                pulsePubkey,
                `daily_pulse_${localDateStr}`,
                entry.headline,
                publishedAt,
                nowIso,
                nowIso,
            );
            pulseItem = db.prepare("SELECT * FROM pulse_items WHERE id = ?").get(pulseItemId);
        }

        // 2. Gate marketplace appearance on fewer than 2 real member listings (< 2)
        const memberListings = getActiveMemberListingCount();
        if (memberListings >= 2) {
            deactivatePulseMarketplacePost();
            console.log(`[DailyPulse] Marketplace has ${memberListings} active member listing(s) (>= 2) — suppressing Daily Pulse marketplace post.`);
            return { post: null, entry, pulseItem };
        }

        // 3. Clean up any previous pulse offers that are NOT today's deterministic pulse ID
        db.prepare(
            "UPDATE posts SET active = 0, status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE author_pubkey = ? AND id != ? AND active = 1 AND status = 'active'"
        ).run(pulsePubkey, pulseId);

        // 4. Check if today's pulse post already exists in the database
        const existingToday = db.prepare("SELECT * FROM posts WHERE id = ?").get(pulseId) as any;
        if (existingToday) {
            db.prepare(
                "UPDATE posts SET active = 1, status = 'active', author_pubkey = ?, title = ?, description = ?, category = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
            ).run(pulsePubkey, entry.headline, entry.body, entry.category || 'general', pulseId);
            const activePosts = getPosts({ id: pulseId });
            const post = activePosts[0] || existingToday;
            console.log(`[DailyPulse] Retained existing Daily Pulse for ${localDateStr}: "${entry.headline}" (ID: ${post.id})`);
            return { post, entry, pulseItem };
        }

        // 5. Create the new 0-Bean post (reach: 'local' so peers are not flooded)
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
        return { post, entry, pulseItem };
    })();
}

/**
 * Returns the currently active Daily Pulse post, if any.
 * Suppressed if active real member listings >= 2.
 * Pure read-only query — never mutates database state.
 */
export function getActivePulsePost(): { id: string; title: string } | null {
    if (getActiveMemberListingCount() >= 2) {
        return null;
    }
    const pulsePubkey = getPulseTreasuryPubkey();
    if (!pulsePubkey) return null;
    const row = getStmtGetActivePulse().get(pulsePubkey) as { id: string; title: string } | undefined;
    return row?.id ? row : null;
}

/**
 * Ensures today's Daily Pulse marketplace post is active if member listings < 2.
 * If already active, does nothing (no writes).
 * If soft-deleted / cancelled, reactivates it.
 * If not created yet, runs rotateDailyPulse().
 */
export function ensurePulseMarketplacePost(now: Date = new Date()): void {
    if (getActiveMemberListingCount() >= 2) return;

    const localEpochMs = now.getTime() - (now.getTimezoneOffset() * 60 * 1000);
    const localDateStr = new Date(localEpochMs).toISOString().split('T')[0];
    const pulseId = `pulse_${localDateStr}`;

    const existing = db.prepare("SELECT id, active, status FROM posts WHERE id = ?").get(pulseId) as { id: string; active: number; status: string } | undefined;
    if (existing) {
        if (existing.active !== 1 || existing.status !== 'active') {
            const pulsePubkey = ensurePulseTreasury();
            const entry = getTodaysPulseEntry(now);
            db.prepare(
                "UPDATE posts SET active = 1, status = 'active', author_pubkey = ?, title = ?, description = ?, category = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
            ).run(pulsePubkey, entry.headline, entry.body, entry.category || 'general', pulseId);
        }
    } else {
        rotateDailyPulse(now);
    }
}

/**
 * Synchronizes the marketplace gate based on active member listing count:
 * - When listings >= 2: deactivates any active Daily Pulse marketplace post.
 * - When listings < 2: ensures today's Daily Pulse marketplace post is restored/active.
 * Safe to call on write paths (create, delete, pause, resume) and scheduled rotation.
 */
export function syncPulseMarketplaceGate(now: Date = new Date()): void {
    const memberListings = getActiveMemberListingCount();
    if (memberListings >= 2) {
        deactivatePulseMarketplacePost();
    } else {
        ensurePulseMarketplacePost(now);
    }
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
