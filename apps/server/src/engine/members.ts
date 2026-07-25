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
    try {
        db.transaction(() => {
            db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) 
                        VALUES (?, ?, ?, ?, ?)`).run(adminPublicKey, callsign, new Date().toISOString(), 'genesis', 'genesis');
            db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(adminPublicKey);
        })();
    } finally {
        db.pragma('foreign_keys = ON');
    }

    ledger.initializeGenesisAccount(adminPublicKey);
    console.log(`⛰️ Genesis member seeded: ${callsign}`);
    return getMember(db, adminPublicKey)!;
}

/**
 * Is `callsign` free on THIS node? Uniqueness is per-node and case-insensitive.
 * `'migrated'` members are excluded (they moved away — their name is reclaimable),
 * as is the caller's own row via `excludePublicKey` (so re-saving your own name is
 * never a "collision"). Mirrors the partial UNIQUE index `lower(callsign) WHERE
 * status != 'migrated'` so the app-level check and the DB constraint agree.
 */
export function isCallsignAvailable(callsign: string, excludePublicKey?: string): boolean {
    const norm = callsign.trim().toLowerCase();
    if (norm.length < 2) return false;
    const row = db.prepare(
        `SELECT 1 FROM members WHERE lower(callsign) = ? AND status != 'migrated' AND public_key != ? LIMIT 1`
    ).get(norm, excludePublicKey ?? '');
    return !row;
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
        const cand = `${base.slice(0, 28)}${i}`;
        if (isCallsignAvailable(cand, excludePublicKey)) return cand;
    }
    // Pathological fallback — 998 variants all taken. Suffix keeps it unique.
    return `${base.slice(0, 22)}${Date.now().toString().slice(-8)}`;
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
        if (requested.toLowerCase() !== String(existing.callsign || '').toLowerCase()) {
            if (requested.length < 2) throw new Error('CALLSIGN_TOO_SHORT');
            if (!isCallsignAvailable(requested, publicKey)) throw new Error('CALLSIGN_TAKEN');
            callsign = requested;
        }
    }
    let contact_value = existing.contact_value;
    let contact_visibility = existing.contact_visibility;
    if (update.contact !== undefined) {
        contact_value = update.contact?.value || null;
        contact_visibility = update.contact?.visibility || null;
    }

    const profileUpdatedAt = new Date().toISOString();

    db.prepare(`UPDATE members SET avatar_url=?, bio=?, contact_value=?, contact_visibility=?, callsign=?, profile_updated_at=? WHERE public_key=?`)
      .run(avatar, bio, contact_value, contact_visibility, callsign, profileUpdatedAt, publicKey);

    broadcast({ type: 'profile_updated', publicKey, profileUpdatedAt });
    return getProfile(db, publicKey);
}
