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
        db.prepare("UPDATE members SET callsign = ? WHERE public_key = ?").run(callsign, publicKey);
        broadcast({ type: 'profile_updated', publicKey });
        return getMember(db, publicKey)!;
    }

    if (!inviteCode && !invitedBy) {
        console.warn(`[Security] Blocked unauthorized open registration attempt for ${callsign} (${publicKey})`);
        return null;
    }

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
    const callsign = typeof update.callsign === 'string' ? update.callsign.slice(0, 32) : existing.callsign;
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
