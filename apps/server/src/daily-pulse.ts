/**
 * Daily Pulse — Auto-generated daily inspirational community offer.
 * Rotates daily at 5:00 AM local time so the marketplace is never empty.
 * Zero push notifications, zero DMs — passive discovery in marketplace only.
 */

import { db } from './db/db.js';
import { createTreasury, createPost, removePost } from './state-engine.js';
import { getTodaysPulseEntry, type DailyPulseEntry } from './daily-pulse-entries.js';

export const PULSE_CALLSIGN = 'Daily Pulse';
export const PULSE_AVATAR = 'bundled://newspaper';

let _pulseTimer: NodeJS.Timeout | null = null;
let _pulseInterval: NodeJS.Timeout | null = null;

/**
 * Ensures the system Treasury identity for "Daily Pulse" exists.
 */
export function ensurePulseTreasury(): string {
    const existing = db.prepare(
        "SELECT public_key FROM members WHERE lower(callsign) = lower(?) AND status NOT IN ('migrated', 'pruned')"
    ).get(PULSE_CALLSIGN) as { public_key: string } | undefined;

    if (existing?.public_key) {
        return existing.public_key;
    }

    const created = createTreasury(PULSE_CALLSIGN, PULSE_AVATAR, 0, { systemCreated: true });
    return created.publicKey;
}

/**
 * Rotates the Daily Pulse post in the marketplace.
 * 1. Soft-deletes yesterday's Pulse offer.
 * 2. Fetches today's compressed entry (modulo 300).
 * 3. Creates today's 0-Bean offer authored by Daily Pulse Treasury.
 */
export function rotateDailyPulse(now: Date = new Date()): { post: any; entry: DailyPulseEntry } {
    const pulsePubkey = ensurePulseTreasury();

    // 1. Clean up existing active pulse offers from Daily Pulse author
    const existingPosts = db.prepare(
        "SELECT id FROM posts WHERE author_pubkey = ? AND active = 1 AND status = 'active'"
    ).all(pulsePubkey) as { id: string }[];

    for (const post of existingPosts) {
        try {
            removePost(post.id, pulsePubkey);
        } catch (err) {
            console.warn(`[DailyPulse] Failed to remove previous pulse post ${post.id}:`, err);
        }
    }

    // 2. Fetch today's entry
    const entry = getTodaysPulseEntry(now);

    // 3. Create the new 0-Bean post
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
        undefined, // id
        false,     // cashAlsoNeeded
        { reach: 'everywhere' }
    );

    if (!post) {
        throw new Error(`[DailyPulse] Failed to create Daily Pulse post: "${entry.headline}"`);
    }

    console.log(`[DailyPulse] Rotated Daily Pulse for ${now.toISOString().split('T')[0]}: "${entry.headline}" (ID: ${post.id})`);
    return { post, entry };
}

/**
 * Returns the currently active Daily Pulse post, if any.
 */
export function getActivePulsePost(): any | null {
    const pulsePubkey = ensurePulseTreasury();
    const row = db.prepare(
        "SELECT id FROM posts WHERE author_pubkey = ? AND active = 1 AND status = 'active' ORDER BY created_at DESC LIMIT 1"
    ).get(pulsePubkey) as { id: string } | undefined;

    return row?.id ? row : null;
}

/**
 * Schedules daily rotation at 5:00 AM local time.
 */
export function scheduleDailyPulse(config?: { dailyPulse?: boolean }): void {
    if (config?.dailyPulse === false) {
        console.log('[DailyPulse] Daily Pulse disabled in configuration.');
        return;
    }

    // Ensure today has an active pulse post on boot
    const active = getActivePulsePost();
    if (!active) {
        try {
            rotateDailyPulse();
        } catch (err) {
            console.error('[DailyPulse] Error initializing Daily Pulse on boot:', err);
        }
    }

    // Calculate delay until next 5:00 AM local time
    const now = new Date();
    const next5AM = new Date(now);
    next5AM.setHours(5, 0, 0, 0);
    if (next5AM.getTime() <= now.getTime()) {
        next5AM.setDate(next5AM.getDate() + 1);
    }
    const delay = next5AM.getTime() - now.getTime();

    if (_pulseTimer) clearTimeout(_pulseTimer);
    if (_pulseInterval) clearInterval(_pulseInterval);

    _pulseTimer = setTimeout(() => {
        try {
            rotateDailyPulse();
        } catch (err) {
            console.error('[DailyPulse] Error during scheduled 5 AM rotation:', err);
        }
        _pulseInterval = setInterval(() => {
            try {
                rotateDailyPulse();
            } catch (err) {
                console.error('[DailyPulse] Error during recurring 24h rotation:', err);
            }
        }, 24 * 60 * 60 * 1000);
        if (_pulseInterval.unref) _pulseInterval.unref();
    }, delay);

    if (_pulseTimer.unref) _pulseTimer.unref();
    console.log(`[DailyPulse] Scheduled next Daily Pulse rotation at ${next5AM.toLocaleString()} (in ${Math.round(delay / 1000 / 60)} mins)`);
}

/**
 * Stops any active Daily Pulse timers (for tests / server shutdown).
 */
export function stopDailyPulseTimer(): void {
    if (_pulseTimer) {
        clearTimeout(_pulseTimer);
        _pulseTimer = null;
    }
    if (_pulseInterval) {
        clearInterval(_pulseInterval);
        _pulseInterval = null;
    }
}
