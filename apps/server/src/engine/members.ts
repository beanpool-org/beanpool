// Stateful wrappers and mutations for members and profiles.
//
// Bridges the database storage layer with server singletons and broadcasts.

import { db } from '../db/db.js';
import { ledger } from './ledger.js';
import { getMember, getProfile, type Member, type MemberProfile } from '@beanpool/engine';

/**
 * Record activity timestamp for a member.
 */
export function recordActivity(publicKey: string): void {
    db.prepare("UPDATE members SET last_active_at=? WHERE public_key=?").run(new Date().toISOString(), publicKey);
}

/**
 * Seeds initial genesis member, bypasses FK constraints.
 */
export function seedGenesisMember(adminPublicKey: string, callsign: string): Member {
    const existing = db.prepare("SELECT * FROM members WHERE public_key = ?").get(adminPublicKey) as any;
    if (existing) {
        db.prepare("UPDATE members SET invited_by = 'genesis', invite_code = 'genesis' WHERE public_key = ?").run(adminPublicKey);
        return getMember(db, adminPublicKey)!;
    }

    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) 
                    VALUES (?, ?, ?, ?, ?)`).run(adminPublicKey, callsign, new Date().toISOString(), 'genesis', 'genesis');
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(adminPublicKey);
    })();

    ledger.initializeGenesisAccount(adminPublicKey);
    console.log(`⛰️ Genesis member seeded: ${callsign}`);
    return getMember(db, adminPublicKey)!;
}

/**
 * Is `callsign` free on THIS node? Uniqueness is per-node and case-insensitive.
 * `'migrated'` and `'pruned'` members are excluded (they left — their name is
 * reclaimable), as is the caller's own row via `excludePublicKey` (so re-saving your
 * own name is never a "collision"). Mirrors the partial UNIQUE index `lower(callsign)
 * WHERE status NOT IN ('migrated', 'pruned')` so the app-level check and the DB
 * constraint agree — keep the two predicates in lockstep.
 *
 * NB: this MUST use `.get()`. better-sqlite3's `.run()` returns a truthy RunResult even
 * for a SELECT that matched nothing, which would make this return `false` unconditionally
 * ("every name is taken") — and tsc cannot catch it, since `!someObject` is valid TS.
 */
export function isCallsignAvailable(callsign: string, excludePublicKey?: string): boolean {
    const norm = callsign.trim().toLowerCase();
    if (norm.length < 2) return false;
    const row = db.prepare(
        `SELECT 1 FROM members WHERE lower(callsign) = ? AND status NOT IN ('migrated', 'pruned') AND public_key != ? LIMIT 1`
    ).get(norm, excludePublicKey ?? '');
    return !row;
}

/**
 * Guardians needed before a member is worth offering as a recovery target. This is the
 * LEGACY guardian-vote path, not the keyholder split — it happens to share the number 3
 * with core's RECOVERY_THRESHOLD, so it is kept as its own constant rather than importing
 * that one and quietly coupling two unrelated schemes.
 */
const RECOVERY_MIN_GUARDIANS = 3;

/** A member offered as a social-recovery target. Deliberately public-safe fields only. */
export interface RecoveryCandidate {
    publicKey: string;
    callsign: string;
    joinedAt: string | null;
    avatarUrl: string | null;
}

/**
 * Members on `callsign` who can actually be recovered: live, and holding enough guardians
 * to reach the threshold. Backs the public `/api/recovery/lookup/:callsign` endpoint.
 *
 * Lives here, next to isCallsignAvailable, because it shares that function's predicate and
 * the two must not drift — the endpoint is public and unauthenticated, so a mismatched
 * `status != 'migrated'` both leaks PRUNED members as recovery targets and loses the partial
 * index, turning a rate-limited lookup into a full table scan.
 *
 * The guardian count is pushed into SQL rather than calling getGuardiansOf() per matched
 * row, which was N+1 queries on that same public endpoint.
 */
export function findRecoveryCandidates(callsign: string): RecoveryCandidate[] {
    const norm = callsign.trim().toLowerCase();
    if (!norm) return [];
    const rows = db.prepare(`
        SELECT public_key, callsign, joined_at, avatar_url
        FROM members
        WHERE lower(callsign) = ? AND status NOT IN ('migrated', 'pruned')
          AND (SELECT COUNT(*) FROM friends WHERE owner_pubkey = members.public_key AND is_guardian = 1) >= ?
    `).all(norm, RECOVERY_MIN_GUARDIANS) as any[];
    return rows.map(r => ({
        publicKey: r.public_key,
        callsign: r.callsign,
        joinedAt: r.joined_at,
        avatarUrl: r.avatar_url,
    }));
}

/**
 * Return `callsign` if it's free, otherwise the first numbered variant that is
 * (Sarah → Sarah2 → Sarah3 …). Used at REGISTRATION so a name clash never blocks a
 * join — the member lands with a guaranteed-unique name and the wizard-on-join then
 * lets them pick a proper one (with fun suggestions) via the strictly-enforced
 * rename path. The server variant is deliberately dull (a number); the friendly
 * suggestions are a client concern.
 */
function uniquifyCallsign(callsign: string, excludePublicKey?: string): string {
    const base = callsign.trim();
    if (isCallsignAvailable(base, excludePublicKey)) return base;
    for (let i = 2; i < 1000; i++) {
        const suffix = String(i);
        // Trim AFTER slicing: slicing a long base can land on a space, which would
        // otherwise produce "Alex Smith 2". Cap so base+suffix never exceeds 32.
        const cand = `${base.slice(0, 32 - suffix.length).trim()}${suffix}`;
        if (isCallsignAvailable(cand, excludePublicKey)) return cand;
    }
    // Pathological fallback — 998 variants all taken. Suffix keeps it unique.
    const suffix = Date.now().toString().slice(-8);
    return `${base.slice(0, 32 - suffix.length).trim()}${suffix}`;
}

/**
 * Internal member registration.
 */
export function registerMemberInternal(
    broadcast: (event: any) => void,
    publicKey: string,
    callsign: string,
    invitedBy: string | null,
    inviteCode: string | null
): Member | null {
    if (!callsign || callsign.trim().length < 2) {
        console.warn(`[Security] Rejected registration with invalid callsign "${callsign}" for ${publicKey}`);
        return null;
    }
    callsign = callsign.trim();

    const existing = db.prepare("SELECT * FROM members WHERE public_key = ?").get(publicKey) as any;
    if (existing) {
        // Re-registration for a known key. Only touch the callsign if it actually
        // changed, and uniquify it (excluding self) so a re-register never collides.
        if (callsign.toLowerCase() !== String(existing.callsign || '').toLowerCase()) {
            callsign = uniquifyCallsign(callsign, publicKey);
            db.prepare("UPDATE members SET callsign = ? WHERE public_key = ?").run(callsign, publicKey);
            broadcast({ type: 'profile_updated', publicKey });
        }
        return getMember(db, publicKey)!;
    }

    if (!inviteCode && !invitedBy) {
        console.warn(`[Security] Blocked unauthorized open registration attempt for ${callsign} (${publicKey})`);
        return null;
    }

    // Never block a join on a name clash — land on a unique variant; the
    // wizard-on-join lets the member pick a proper name straight after.
    callsign = uniquifyCallsign(callsign);

    db.transaction(() => {
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code)
                    VALUES (?, ?, ?, ?, ?)`).run(publicKey, callsign, new Date().toISOString(), invitedBy, inviteCode);
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(publicKey);
    })();

    ledger.initializeGenesisAccount(publicKey);
    const member = getMember(db, publicKey)!;
    broadcast({ type: 'member_joined', member });
    console.log(`👤 New member: ${callsign} invited by ${invitedBy ? invitedBy.substring(0, 12) : 'system'}...`);
    return member;
}

/**
 * Public facade for registering a member.
 */
export function registerMember(broadcast: (event: any) => void, publicKey: string, callsign: string): Member | null {
    return registerMemberInternal(broadcast, publicKey, callsign, null, null);
}

/**
 * Register visitor identity (for federated protocol).
 */
export function registerVisitor(publicKey: string, callsign?: string, homeNodeUrl?: string): void {
    const existing = db.prepare("SELECT * FROM members WHERE public_key = ?").get(publicKey) as any;
    if (existing) {
        if (callsign && existing.callsign.startsWith('Visitor-')) {
            db.prepare("UPDATE members SET callsign = ? WHERE public_key = ?").run(callsign, publicKey);
        }
        if (homeNodeUrl && !existing.home_node_url) {
            db.prepare("UPDATE members SET home_node_url = ? WHERE public_key = ?").run(homeNodeUrl, publicKey);
        }
        return;
    }
    const generatedCallsign = callsign || `Visitor-${publicKey.substring(0, 8)}`;
    db.transaction(() => {
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, home_node_url) 
                    VALUES (?, ?, ?, ?, ?, ?)`).run(publicKey, generatedCallsign, new Date().toISOString(), null, null, homeNodeUrl || null);
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(publicKey);
    })();
    ledger.initializeGenesisAccount(publicKey);
    console.log(`🌐 Visitor registered: ${generatedCallsign} (federation${homeNodeUrl ? ` from ${homeNodeUrl}` : ''})`);
}

/**
 * Update member profile avatar, bio, callsign, or contact information.
 */
export function updateProfile(
    broadcast: (event: any) => void,
    publicKey: string,
    update: {
        avatar?: string | null;
        bio?: string;
        contact?: { value: string; visibility: 'hidden' | 'trade_partners' | 'community' | 'friends' } | null;
        callsign?: string;
        archetype?: string | null;
    }
): MemberProfile | null {
    if (!getMember(db, publicKey)) return null;
    recordActivity(publicKey);

    const existing = db.prepare("SELECT * FROM members WHERE public_key = ?").get(publicKey) as any;
    const avatar = update.avatar !== undefined ? update.avatar : existing.avatar_url;
    const bio = typeof update.bio === 'string' ? update.bio.slice(0, 200) : (update.bio === null ? null : existing.bio);
    // Rename gate: enforce per-node uniqueness, but ONLY when the callsign actually
    // changes — re-saving your own name (e.g. the background profile push) must not
    // trip it. A genuine rename to a name held by someone else throws CALLSIGN_TAKEN,
    // which the route surfaces as 409 so the wizard/settings can offer suggestions.
    let callsign = existing.callsign;
    if (typeof update.callsign === 'string') {
        const requested = update.callsign.trim().slice(0, 32);
        if (requested !== existing.callsign) {
            if (requested.length < 2) throw new Error('CALLSIGN_TOO_SHORT');
            if (requested.toLowerCase() !== String(existing.callsign || '').toLowerCase()) {
                if (!isCallsignAvailable(requested, publicKey)) throw new Error('CALLSIGN_TAKEN');
            }
            callsign = requested;
        }
    }
    let contact_value = existing.contact_value;
    let contact_visibility = existing.contact_visibility;
    if (update.contact !== undefined) {
        contact_value = update.contact?.value || null;
        contact_visibility = update.contact?.visibility || null;
    }
    const archetype = update.archetype !== undefined ? update.archetype : (existing.archetype || null);

    const profileUpdatedAt = new Date().toISOString();

    db.prepare(`UPDATE members SET avatar_url=?, bio=?, contact_value=?, contact_visibility=?, callsign=?, profile_updated_at=?, archetype=? WHERE public_key=?`)
      .run(avatar, bio, contact_value, contact_visibility, callsign, profileUpdatedAt, archetype, publicKey);

    broadcast({ type: 'profile_updated', publicKey, profileUpdatedAt });
    return getProfile(db, publicKey);
}
