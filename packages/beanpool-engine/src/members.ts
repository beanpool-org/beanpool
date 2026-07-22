// Members, Invites, and Profile pure database queries and validation helpers.
//
// Extracted from apps/server/src/state-engine.ts so both the node server
// and the fleet manager can run identical validations and lookups.
//
// Pure reads/computations (parameterized on better-sqlite3 Database handle).

import type Database from 'better-sqlite3';
import crypto from 'node:crypto';

type Db = Database.Database;

export type GenesisInviteType = 'standard' | 'trusted' | 'ambassador' | 'elder';

export interface Member {
    publicKey: string;
    callsign: string;
    joinedAt: string;
    invitedBy: string;
    inviteCode: string;
    homeNodeUrl?: string;
    avatarUrl?: string | null;
    status?: 'active' | 'migrated' | 'pruned' | 'flagged' | string;
    profileUpdatedAt?: number | null;
    bio?: string | null;
    contactValue?: string | null;
    contactVisibility?: string | null;
    lastActiveAt?: string | null;
    updatedAt?: string | null;
    earnedCredit?: number;
    elderVouchedBy?: string | null;
}

export interface InviteCode {
    code: string;
    createdBy: string;
    createdAt: string;
    usedBy: string | null;
    usedAt: string | null;
    intendedFor?: string;
}

export interface MemberProfile {
    publicKey: string;
    avatar: string | null;
    bio: string;
    contact: {
        value: string;
        visibility: 'hidden' | 'trade_partners' | 'community' | 'friends';
    } | null;
    callsign?: string;
    joinedAt?: string;
    status?: 'active' | 'disabled' | 'pruned';
    elderVouchedBy?: string | null;
    elderVouchedByCallsign?: string | null;
}

export interface InviteTreeNode {
    publicKey: string;
    callsign: string;
    joinedAt: string;
    invitedBy: string;
    inviteCode: string;
    status: string;
    children: InviteTreeNode[];
}

export interface InviteCheckResult {
    valid: boolean;
    reason?: 'invalid' | 'used' | 'expired' | 'unknown_inviter' | 'malformed';
    inviterCallsign?: string | null;
}

export function rowToMember(row: any): Member {
    if (!row) return row;
    return {
        publicKey: row.public_key,
        callsign: row.callsign,
        joinedAt: row.joined_at,
        invitedBy: row.invited_by,
        inviteCode: row.invite_code,
        homeNodeUrl: row.home_node_url || undefined,
        avatarUrl: row.avatar_url || null,
        profileUpdatedAt: row.profile_updated_at || null,
        bio: row.bio || null,
        contactValue: row.contact_value || null,
        contactVisibility: row.contact_visibility || null,
        status: row.status || 'active',
        lastActiveAt: row.last_active_at || null,
        updatedAt: row.updated_at || null,
        earnedCredit: row.earned_credit ?? 0,
        elderVouchedBy: row.elder_vouched_by || null,
    };
}

export function rowToProfile(row: any): MemberProfile {
    if (!row) return row;
    return {
        publicKey: row.public_key,
        avatar: row.avatar_url || null,
        bio: row.bio || '',
        contact: row.contact_value ? {
            value: row.contact_value,
            visibility: row.contact_visibility || 'hidden'
        } : null,
        callsign: row.callsign,
        joinedAt: row.joined_at,
        status: row.status || 'active',
        elderVouchedBy: row.elder_vouched_by || null,
        elderVouchedByCallsign: row.elder_vouched_by_callsign || null,
    };
}

export function getMember(db: Db, publicKey: string): Member | undefined {
    const row = db.prepare("SELECT * FROM members WHERE public_key = ?").get(publicKey) as any;
    return row ? rowToMember(row) : undefined;
}

export function getMembers(db: Db): Member[] {
    const rows = db.prepare("SELECT * FROM members WHERE status != 'pruned'").all() as any[];
    return rows.map(rowToMember);
}

export function getAllMembers(db: Db): Member[] {
    const rows = db.prepare("SELECT * FROM members").all() as any[];
    return rows.map(rowToMember);
}

export function generateShortCode(): string {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // base32-ish without confusing chars (0/O, 1/I)
    let part1 = '';
    let part2 = '';
    for (let i = 0; i < 4; i++) part1 += chars[crypto.randomInt(chars.length)];
    for (let i = 0; i < 4; i++) part2 += chars[crypto.randomInt(chars.length)];
    return `INV-${part1}-${part2}`;
}

export function verifyOfflineTicket(db: Db, ticketB64: string):
    | { ok: true; inviterPubkey: string; timestamp: number; intendedFor?: string; codeHash: string }
    | { ok: false; reason: 'unknown_inviter' | 'expired' | 'invalid' | 'malformed'; error: string } {
    try {
        const normalizedB64 = ticketB64.replace(/-/g, '+').replace(/_/g, '/');
        const ticketStr = Buffer.from(normalizedB64, 'base64').toString('utf8');
        const ticketObj = JSON.parse(ticketStr);
        const { p: payloadStr, s: signatureBase64 } = ticketObj;

        let signedBytes = Buffer.from(payloadStr);
        let payloadJson = payloadStr;
        if (!payloadStr.trim().startsWith('{')) {
            signedBytes = Buffer.from(payloadStr, 'base64');
            payloadJson = signedBytes.toString('utf8');
        }

        const payloadObj = JSON.parse(payloadJson);
        const { i: inviterPubkey, t: timestamp, f: intendedFor } = payloadObj;

        if (!getMember(db, inviterPubkey)) {
            return { ok: false, reason: 'unknown_inviter', error: 'Inviter is not a formally recognized member of this decentralized mesh' };
        }

        const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
        const FUTURE_SKEW_MS = 10 * 60 * 1000;
        if (typeof timestamp !== 'number' || timestamp > Date.now() + FUTURE_SKEW_MS) {
            return { ok: false, reason: 'invalid', error: 'Offline ticket timestamp is invalid' };
        }
        if (Date.now() - timestamp > THIRTY_DAYS_MS) {
            return { ok: false, reason: 'expired', error: 'This offline ticket has expired (maximum 30 days issuance)' };
        }

        const spkiHeader = Buffer.from('302a300506032b6570032100', 'hex');
        const spki = Buffer.concat([spkiHeader, Buffer.from(inviterPubkey, 'hex')]);
        const publicKeyObject = crypto.createPublicKey({
            key: spki,
            format: 'der',
            type: 'spki'
        });

        const isValid = crypto.verify(
            undefined,
            signedBytes,
            publicKeyObject,
            Buffer.from(signatureBase64, 'base64')
        );

        if (!isValid) return { ok: false, reason: 'invalid', error: 'Invalid cryptographic signature structure' };

        const codeHash = crypto.createHash('sha256').update(signatureBase64).digest('hex').substring(0, 16);
        return { ok: true, inviterPubkey, timestamp, intendedFor, codeHash };
    } catch (e) {
        return { ok: false, reason: 'malformed', error: 'Malformed or broken offline ticket payload' };
    }
}

export function checkInvite(db: Db, codeOrTicket: string): InviteCheckResult {
    const raw = codeOrTicket.trim();
    if (!raw) return { valid: false, reason: 'invalid' };

    if (raw.startsWith('BP-')) {
        const verified = verifyOfflineTicket(db, raw.substring(3));
        if (!verified.ok) return { valid: false, reason: verified.reason };

        // Replay/Single-use enforcement check in database
        const used = db.prepare("SELECT used_by FROM invite_codes WHERE code = ?").get(verified.codeHash) as any;
        if (used) return { valid: false, reason: 'used' };

        const inviter = getMember(db, verified.inviterPubkey);
        return { valid: true, inviterCallsign: inviter?.callsign || null };
    }

    const row = db.prepare("SELECT * FROM invite_codes WHERE code = ?").get(raw) as any;
    if (!row) return { valid: false, reason: 'invalid' };
    if (row.used_by) return { valid: false, reason: 'used' };

    // standard online codes generated more than 30 days ago expire
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    if (ageMs > 30 * 24 * 60 * 60 * 1000) return { valid: false, reason: 'expired' };

    const inviter = getMember(db, row.created_by);
    return { valid: true, inviterCallsign: inviter?.callsign || null };
}

export function getInvitesByMember(db: Db, pubkey: string): InviteCode[] {
    const rows = db.prepare("SELECT * FROM invite_codes WHERE created_by = ?").all(pubkey) as any[];
    return rows.map(r => ({
        code: r.code,
        createdBy: r.created_by,
        createdAt: r.created_at,
        usedBy: r.used_by,
        usedAt: r.used_at,
        intendedFor: r.intended_for || undefined,
    }));
}

export function getInviteTree(db: Db, rootPubkey?: string): InviteTreeNode[] {
    const members = getAllMembers(db);
    const byPubkey = new Map<string, Member>();
    for (const m of members) byPubkey.set(m.publicKey, m);

    // Group children by their inviter (invitedBy) for O(1) retrieval
    const childrenByInviter = new Map<string, Member[]>();
    for (const m of members) {
        if (!m.invitedBy) continue;
        if (!childrenByInviter.has(m.invitedBy)) childrenByInviter.set(m.invitedBy, []);
        childrenByInviter.get(m.invitedBy)!.push(m);
    }

    function buildNode(m: Member): InviteTreeNode {
        const children = childrenByInviter.get(m.publicKey) || [];
        return {
            publicKey: m.publicKey,
            callsign: m.callsign,
            joinedAt: m.joinedAt,
            invitedBy: m.invitedBy,
            inviteCode: m.inviteCode,
            status: m.status || 'active',
            children: children.map(buildNode).sort((a, b) => a.callsign.localeCompare(b.callsign))
        };
    }

    if (rootPubkey) {
        const root = byPubkey.get(rootPubkey);
        return root ? [buildNode(root)] : [];
    }

    // Default: find all roots (no inviter, or inviter is 'genesis', or inviter not present)
    const roots = members.filter(m => !m.invitedBy || m.invitedBy === 'genesis' || !byPubkey.has(m.invitedBy));
    return roots.map(buildNode).sort((a, b) => a.callsign.localeCompare(b.callsign));
}

export function getProfile(db: Db, publicKey: string, requesterPubkey?: string): MemberProfile | null {
    const row = db.prepare("SELECT * FROM members WHERE public_key = ?").get(publicKey) as any;
    if (!row) return null;
    const profile = rowToProfile(row);
    profile.elderVouchedBy = row.elder_vouched_by || null;
    if (row.elder_vouched_by) {
        const voucher = db.prepare("SELECT callsign FROM members WHERE public_key = ?").get(row.elder_vouched_by) as any;
        profile.elderVouchedByCallsign = voucher?.callsign || null;
    }
    if (profile.contact && profile.contact.visibility === 'hidden' && requesterPubkey !== publicKey) {
        profile.contact = null;
    } else if (profile.contact && profile.contact.visibility === 'friends' && requesterPubkey !== publicKey) {
        if (!requesterPubkey) {
            profile.contact = null;
        } else {
            const isFriend = db.prepare("SELECT 1 FROM friends WHERE owner_pubkey=? AND friend_pubkey=?").get(publicKey, requesterPubkey);
            if (!isFriend) profile.contact = null;
        }
    }
    return profile;
}

export function getProfiles(db: Db): Record<string, MemberProfile> {
    const rows = db.prepare("SELECT * FROM members WHERE status != 'pruned'").all() as any[];
    const result: Record<string, MemberProfile> = {};
    for (const r of rows) {
        const prof = rowToProfile(r);
        if (prof.contact && prof.contact.visibility !== 'community') prof.contact = null;
        result[prof.publicKey] = prof;
    }
    return result;
}

export function getAllProfiles(db: Db, requesterPubkey?: string): MemberProfile[] {
    const rows = db.prepare("SELECT * FROM members WHERE status != 'pruned'").all() as any[];
    
    // Batch fetch friends where friend_pubkey is the requesterPubkey
    let friendOwners = new Set<string>();
    if (requesterPubkey) {
        const friendRows = db.prepare("SELECT owner_pubkey FROM friends WHERE friend_pubkey = ?").all(requesterPubkey) as any[];
        friendOwners = new Set(friendRows.map(f => f.owner_pubkey));
    }

    const profiles: MemberProfile[] = [];
    for (const row of rows) {
        const profile = rowToProfile(row);
        const publicKey = profile.publicKey;
        if (profile.contact && requesterPubkey !== publicKey) {
            if (profile.contact.visibility === 'hidden') {
                profile.contact = null;
            } else if (profile.contact.visibility === 'friends') {
                if (!requesterPubkey || !friendOwners.has(publicKey)) {
                    profile.contact = null;
                }
            }
        }
        profiles.push(profile);
    }
    return profiles;
}
