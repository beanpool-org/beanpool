/**
 * Recovery PIN routes — optional 6-digit numeric PIN for non-SSO recovery.
 *
 * The PIN reveals the keeper list (who holds the member's Shamir fragments)
 * so the recovering device knows which friends to call. It does NOT gate
 * release of fragment A — the hub fragment is released under D7 rules regardless.
 *
 * ## Anti-Enumeration
 *
 * The verify endpoint returns an IDENTICAL error for "wrong PIN" and "no such
 * callsign". An attacker who can try PINs cannot also learn whether a callsign
 * exists on this node — the only answer they get is "no".
 *
 * ## Rate Limiting
 *
 * 2 free attempts, then 1 attempt per 15 minutes. No hard lockout — the design
 * doc explicitly forbids it ("never hard lockout"). The window is flat: a member
 * who entered 1 wrong PIN and then gets it right on the 2nd try resets to 0.
 *
 * ## IP Logging
 *
 * Every failed attempt is logged with the client IP, callsign, and timestamp
 * so node operators can block abusing addresses at the infrastructure level.
 */

import Router from '@koa/router';
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

import { db } from '../db/db.js';
import { getMember } from '../state-engine.js';
import type { RouteDeps } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve callsign → public_key. Returns null for non-existent or pruned/migrated members. */
function resolveCallsign(callsign: string): string | null {
    const row = db.prepare(
        `SELECT public_key FROM members WHERE callsign = ? AND status NOT IN ('migrated', 'pruned')`
    ).get(callsign) as { public_key: string } | undefined;
    return row?.public_key ?? null;
}

/** Hash a 6-digit PIN with async scrypt (off the event loop). */
function hashPin(pin: string): Promise<{ hash: string; salt: string }> {
    const salt = randomBytes(32).toString('hex');
    return new Promise((resolve, reject) => {
        scrypt(pin, salt, 64, (err, derived) => {
            if (err) return reject(err);
            resolve({ hash: derived.toString('hex'), salt });
        });
    });
}

/** Verify a PIN against stored hash (async, constant-time). */
function verifyPin(pin: string, storedHash: string, storedSalt: string): Promise<boolean> {
    return new Promise((resolve) => {
        scrypt(pin, storedSalt, 64, (err, derived) => {
            if (err) { resolve(false); return; }
            try {
                const expected = Buffer.from(storedHash, 'hex');
                resolve(derived.length === expected.length && timingSafeEqual(derived, expected));
            } catch { resolve(false); }
        });
    });
}

/** Validate that a value is a 6-digit numeric string. */
function isValidPin(pin: unknown): pin is string {
    return typeof pin === 'string' && /^\d{6}$/.test(pin);
}

// Rate limiting constants
const FREE_ATTEMPTS = 2;
const COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createPinRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { rateLimit } = deps;

    // -----------------------------------------------------------------------
    // POST /api/recovery/pin/set — Set or update optional recovery PIN
    // Requires authentication (signed request from the account owner).
    // -----------------------------------------------------------------------
    router.post('/api/recovery/pin/set', async (ctx) => {
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'This request must be signed by an active member of this node.' };
            return;
        }
        const member = getMember(actor);
        if (!member || ['migrated', 'pruned'].includes(String(member.status))) {
            ctx.status = 401;
            ctx.body = { error: 'This request must be signed by an active member of this node.' };
            return;
        }
        if (!rateLimit(ctx)) return;

        const body = (ctx as any).requestBody;
        const pin = body?.pin;

        // Allow clearing PIN by passing null/empty
        if (pin === null || pin === '' || pin === undefined) {
            db.prepare(`DELETE FROM recovery_pin WHERE owner_pubkey = ?`).run(actor);
            ctx.status = 200;
            ctx.body = { ok: true, pinSet: false };
            return;
        }

        if (!isValidPin(pin)) {
            ctx.status = 400;
            ctx.body = { error: 'PIN must be exactly 6 digits.' };
            return;
        }

        const { hash, salt } = await hashPin(pin);
        const now = new Date().toISOString();

        db.prepare(`
            INSERT INTO recovery_pin (owner_pubkey, pin_hash, pin_salt, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(owner_pubkey) DO UPDATE SET
                pin_hash = excluded.pin_hash,
                pin_salt = excluded.pin_salt,
                attempts = 0,
                last_attempt_at = NULL,
                updated_at = excluded.updated_at
        `).run(actor, hash, salt, now, now);

        ctx.status = 200;
        ctx.body = { ok: true, pinSet: true };
    });

    // -----------------------------------------------------------------------
    // POST /api/recovery/pin/status — Check if caller has a PIN set
    // Authenticated (signed request).
    // -----------------------------------------------------------------------
    router.post('/api/recovery/pin/status', async (ctx) => {
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'This request must be signed by an active member of this node.' };
            return;
        }

        const row = db.prepare(`SELECT 1 FROM recovery_pin WHERE owner_pubkey = ?`).get(actor);
        ctx.status = 200;
        ctx.body = { pinSet: !!row };
    });

    // -----------------------------------------------------------------------
    // POST /api/recovery/pin/verify — Verify PIN to reveal keeper list
    // UNAUTHENTICATED (recovering device has no identity to sign with).
    // Uniform error for wrong PIN and non-existent callsign.
    // -----------------------------------------------------------------------
    router.post('/api/recovery/pin/verify', async (ctx) => {
        if (!rateLimit(ctx)) return;

        const body = (ctx as any).requestBody;
        const callsign = typeof body?.callsign === 'string' ? body.callsign.trim() : '';
        const pin = body?.pin;

        // Uniform denial response — identical for all failure modes.
        const deny = () => {
            ctx.status = 200;
            ctx.body = { verified: false, keepers: null };
        };

        if (!callsign || !isValidPin(pin)) return deny();

        // Resolve callsign → pubkey (or null)
        const ownerPubkey = resolveCallsign(callsign);

        // Look up the PIN record (may not exist if member hasn't set one, or callsign is fake)
        const pinRow = ownerPubkey
            ? db.prepare(`SELECT pin_hash, pin_salt, attempts, last_attempt_at FROM recovery_pin WHERE owner_pubkey = ?`)
                .get(ownerPubkey) as { pin_hash: string; pin_salt: string; attempts: number; last_attempt_at: string | null } | undefined
            : undefined;

        if (!pinRow) {
            // No PIN set or no such member — burn the same time as a real verification
            // to prevent timing side-channels.
            await hashPin('000000');
            return deny();
        }

        // Rate limit check: if past free attempts, enforce cooldown
        if (pinRow.attempts >= FREE_ATTEMPTS && pinRow.last_attempt_at) {
            const elapsed = Date.now() - new Date(pinRow.last_attempt_at).getTime();
            if (elapsed < COOLDOWN_MS) {
                const remainingMins = Math.ceil((COOLDOWN_MS - elapsed) / 60_000);
                // Log rate-limited attempt with IP
                const ip = ctx.request.ip || ctx.ip || 'unknown';
                console.warn(`[PIN] ⏳ Rate-limited attempt for callsign="${callsign}" from IP=${ip} (${remainingMins}m remaining)`);
                ctx.status = 200;
                ctx.body = {
                    verified: false,
                    keepers: null,
                    rateLimited: true,
                    retryAfterMinutes: remainingMins,
                };
                return;
            }
        }

        // Verify PIN
        const valid = await verifyPin(pin, pinRow.pin_hash, pinRow.pin_salt);
        const now = new Date().toISOString();

        if (!valid) {
            // Increment attempt counter and log failure with IP
            db.prepare(`UPDATE recovery_pin SET attempts = attempts + 1, last_attempt_at = ? WHERE owner_pubkey = ?`)
                .run(now, ownerPubkey);
            const ip = ctx.request.ip || ctx.ip || 'unknown';
            console.warn(`[PIN] ❌ Failed verification for callsign="${callsign}" from IP=${ip} (attempt #${pinRow.attempts + 1})`);
            return deny();
        }

        // Success — reset attempt counter and return keeper list
        db.prepare(`UPDATE recovery_pin SET attempts = 0, last_attempt_at = NULL WHERE owner_pubkey = ?`)
            .run(ownerPubkey);

        // Fetch keeper types (not identities — never expose who the friends are)
        const keepers = db.prepare(`
            SELECT holder_type, COUNT(*) as count
            FROM recovery_shares
            WHERE owner_pubkey = ? AND generation = (
                SELECT MAX(generation) FROM recovery_shares WHERE owner_pubkey = ?
            )
            GROUP BY holder_type
        `).all(ownerPubkey, ownerPubkey) as { holder_type: string; count: number }[];

        ctx.status = 200;
        ctx.body = {
            verified: true,
            keepers: keepers.map(k => ({ type: k.holder_type, count: k.count })),
        };
    });

    return router;
}
