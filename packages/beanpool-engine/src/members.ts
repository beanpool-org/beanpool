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
    /** This account is a community treasury (the Commons' trading face), not a person. */
    isTreasury?: boolean;
    archetype?: string | null;
    nodeRole?: 'owner' | 'admin' | null;
    /**
     * Auto-mute (global profile, G3): muted while later than now, lifted then while earlier. Carried by the
     * replication export only (a standby and a take-over keep it); never in the member directory.
     */
    moderationMutedUntil?: string | null;
    /**
     * A person's coarse area (global node G4): 0.1° steps, set by the member alone. Carried by the replication export
     * only (a standby and a take-over keep it); never in the member directory, a profile or anything a peer reads.
     */
    areaLat?: number | null;
    areaLng?: number | null;
    areaUpdatedAt?: string | null;
    /**
     * A visitor's row (members.is_visitor), not a member's: a key a member sent a message or Beans to, or a member of
     * another community, that never joined this one (isVisitorKey). Carried by the replication export only (a standby
     * and a take-over keep it); never in the member directory.
     */
    isVisitor?: boolean;
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
    archetype?: string | null;
}

/** One member in the invite tree any member can read — who invited whom, never the invite code itself. */
export interface InviteTreeNode {
    publicKey: string;
    callsign: string;
    joinedAt: string;
    invitedBy: string;
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
        isTreasury: !!row.is_treasury,
        archetype: row.archetype || null,
        nodeRole: row.node_role ?? null,
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
        archetype: row.archetype || null,
    };
}

/**
 * What anyone may be told about a member without knowing who is asking: the name, the join date and the photo
 * (the photo is public at /api/avatar/:publicKey anyway). For a response that can reach someone other than the
 * member, e.g. the unsigned invite-redeem routes, which answer for whatever publicKey is in the body, and the
 * member_joined broadcast. Never the whole Member: that carries their contact details whatever they chose, and
 * the invite code they joined with.
 */
export interface PublicMemberCard {
    publicKey: string;
    callsign: string;
    joinedAt: string;
    avatarUrl: string | null;
}

export function publicMemberCard(m: Member): PublicMemberCard {
    return { publicKey: m.publicKey, callsign: m.callsign, joinedAt: m.joinedAt, avatarUrl: m.avatarUrl ?? null };
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

        // A member of this node, not just a row: a pruned account keeps its row, and so does the old key of a member
        // being re-keyed, and a ticket either signs would bring its holder in as someone new (engine/invites.ts).
        if (!isNodeMember(db, inviterPubkey)) {
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
    // Its maker has since been pruned or re-keyed: redeemInvite refuses it (apps/server engine/invites.ts), so say so now.
    if (!isNodeMember(db, row.created_by)) return { valid: false, reason: 'unknown_inviter' };

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

/**
 * Whether this node has invalidated `pubkey`: a re-key has started (issueRekeyCode, for a lost or stolen phone) or
 * finished (completeRekey). The key can still sign, but the server's write guards refuse it (assertMemberActive), it is
 * no member here (isNodeMember) and it reads nothing as one (readsAsMember). Both writers of invalidated_keys lowercase.
 */
export function isInvalidatedKey(db: Db, pubkey: string | null | undefined): boolean {
    if (!pubkey) return false;
    return !!db.prepare("SELECT 1 FROM invalidated_keys WHERE public_key = ?").get(pubkey.toLowerCase());
}

/**
 * Whether `pubkey`'s row here is a visitor's (members.is_visitor), not a member's: a key a member sent a message or
 * Beans to that has no account here, or a member of another community (the server's registerVisitor, the only writer).
 * Nobody invited it and it came in through no door. It receives what is sent to it and reads only what a non-member
 * reads (readsAsMember, passesReadGate). Joining for real (an invite, an offline ticket, the open door) makes the same
 * row a member's.
 */
export function isVisitorKey(db: Db, pubkey: string | null | undefined): boolean {
    if (!pubkey) return false;
    const row = db.prepare("SELECT is_visitor FROM members WHERE public_key = ?").get(pubkey) as { is_visitor: number | null } | undefined;
    return !!row?.is_visitor;
}

/**
 * Whether `pubkey` has already joined this node, for the doors (open join, knocks): a member row that isn't a
 * visitor's. A visitor's row hasn't: it may knock, be invited and join like anyone new, and joining makes that row a
 * member's. A closed account's row ('pruned') has, visitor or not: it can't join again.
 */
export function alreadyJoined(db: Db, pubkey: string | null | undefined): boolean {
    if (!pubkey) return false;
    const row = db.prepare("SELECT status, is_visitor FROM members WHERE public_key = ?").get(pubkey) as
        { status: string | null; is_visitor: number | null } | undefined;
    return !!row && (!row.is_visitor || row.status === 'pruned');
}

/**
 * THE ACT TEST: whether `pubkey` may act as a member of this node. A member row that exists and isn't pruned, for a key
 * this node hasn't invalidated. A pruned or self-deleted account keeps its row and can still sign, but it is no longer in
 * the community. Nor is the old key of a member being re-keyed: its row stays, set to 'suspended', and the key can still
 * sign until the new phone binds a new one, however long that takes (an expired code leaves both as they are).
 *
 * Every other status counts, 'suspended' and 'disabled' included, and so does a visitor's row: what a suspended member
 * may still do is suspension's own rule (assertMemberActive, and each route's), and a visitor keeps what it could do.
 * The re-key is caught by its invalidated key, not by 'suspended', because a report suspension writes the same status.
 *
 * NOT the test for what only members may read: that is readsAsMember, which is stricter. Pass the verified signer (the
 * route's ctx.state.actor), never a key from the request.
 */
export function isNodeMember(db: Db, pubkey: string | null | undefined): boolean {
    if (!pubkey) return false;
    const row = db.prepare("SELECT status FROM members WHERE public_key = ?").get(pubkey) as { status: string | null } | undefined;
    return !!row && row.status !== 'pruned' && !isInvalidatedKey(db, pubkey);
}

/** A member keeps their row and account under these, but reads nothing as a member while they last (readsAsMember). */
const READS_AS_NON_MEMBER_WHILE: ReadonlySet<string> = new Set(['suspended', 'disabled']);

/**
 * THE READ TEST: whether `pubkey` gets what only members of this node may read, where anyone else gets a non-member's
 * copy or nothing: contact details shared with Community, Trade Partners or Friends (contactViewer), who voted for what
 * in a poll, the People list's distances, the activity feed, the /ws member feed, and the member's view of the listings
 * on a node that shows visitors the listings and not the people (the server's viewerTier). One test, so they cannot
 * drift apart.
 *
 * A member of this node (isNodeMember: a row, not pruned, a key no re-key has invalidated) who is also:
 *  - not 'suspended' or 'disabled' (by an admin, a report or a community vote): while suspended, a member sees what a
 *    non-member sees, and reads as a member again the moment the suspension ends (Marty, 2026-09-26);
 *  - not a visitor (isVisitorKey): a visitor receives messages and Beans and sees only what a non-member sees (Marty,
 *    2026-09-26).
 *
 * Reads only: what a suspended member or a visitor may DO is isNodeMember's and suspension's. Pass the verified signer
 * (the route's ctx.state.actor), never a key from the request.
 */
export function readsAsMember(db: Db, pubkey: string | null | undefined): boolean {
    if (!pubkey) return false;
    const row = db.prepare("SELECT status, is_visitor FROM members WHERE public_key = ?").get(pubkey) as
        { status: string | null; is_visitor: number | null } | undefined;
    if (!row || row.is_visitor || row.status === 'pruned' || READS_AS_NON_MEMBER_WHILE.has(row.status ?? '')) return false;
    return !isInvalidatedKey(db, pubkey);
}

/**
 * Whether `pubkey` passes the gated-read gate (ENFORCE_READ_AUTH): a member of this node (isNodeMember) whose row isn't
 * a visitor's. Looser than readsAsMember on one point only: a suspended or disabled member passes, because what they may
 * still do (close their own trades, answer their messages, run their own group's and event's chat) needs their own
 * account's reads. What only members may read is held back from them inside the gate, by readsAsMember on each such
 * read. A visitor gets past the gate only to its own messages and Beans (https-server.ts `visitorsOwnRead`). Pass the
 * verified signer.
 */
export function passesReadGate(db: Db, pubkey: string | null | undefined): boolean {
    if (!pubkey) return false;
    const row = db.prepare("SELECT status, is_visitor FROM members WHERE public_key = ?").get(pubkey) as
        { status: string | null; is_visitor: number | null } | undefined;
    // isNodeMember's test, and not a visitor's row, in one lookup.
    return !!row && !row.is_visitor && row.status !== 'pruned' && !isInvalidatedKey(db, pubkey);
}

/** ownersWhoAddedAsFriend's query, keyed on the viewer; idx_friends_friend_pubkey answers it (test-schema-upgrade.ts). */
export const OWNERS_WHO_ADDED_AS_FRIEND_SQL = "SELECT owner_pubkey FROM friends WHERE friend_pubkey = ?";

/**
 * tradePartnersOf's query: the other side of every marketplace trade the viewer is on, as buyer or as seller. Every
 * status counts (requested, pending, completed, disputed, cancelled, rejected, and any added later), so there is no
 * status test. The two halves are answered by idx_marketplace_transactions_buyer_status and _seller_status.
 */
export const TRADE_PARTNERS_SQL = `
    SELECT seller_pubkey AS partner FROM marketplace_transactions WHERE buyer_pubkey = ?
    UNION
    SELECT buyer_pubkey FROM marketplace_transactions WHERE seller_pubkey = ?`;

/** Every member who has added `viewerPubkey` as a friend: contactVisibleTo's friends check for many owners at once. */
export function ownersWhoAddedAsFriend(db: Db, viewerPubkey: string | null | undefined): Set<string> {
    if (!viewerPubkey) return new Set();
    const rows = db.prepare(OWNERS_WHO_ADDED_AS_FRIEND_SQL).all(viewerPubkey) as any[];
    return new Set(rows.map(r => r.owner_pubkey));
}

/**
 * Every member `viewerPubkey` has a marketplace trade with, in any state and either way round: a row in
 * marketplace_transactions with the two of them as buyer and seller. The escrow engine writes that row when a trade
 * is requested (or accepted outright) and only ever moves its status, so a trade once entered stays entered. A direct
 * Bean transfer (the `transactions` ledger) is not a trade here: the apps never call one a trade, and "Visible when you
 * enter a trade" names the marketplace's step.
 */
export function tradePartnersOf(db: Db, viewerPubkey: string | null | undefined): Set<string> {
    if (!viewerPubkey) return new Set();
    const rows = db.prepare(TRADE_PARTNERS_SQL).all(viewerPubkey, viewerPubkey) as any[];
    return new Set(rows.map(r => r.partner));
}

/** Who is reading, for contactVisibleTo. Worked out once per request (contactViewer), then asked about each owner. */
export interface ContactViewer {
    /** The verified signer (the route's ctx.state.actor), or null when the request is unsigned. */
    pubkey: string | null;
    /** Reads as a member of this node (readsAsMember). Community, Trade Partners and Friends all need one. */
    isMember: boolean;
    /** Every owner who has added the viewer as a friend (ownersWhoAddedAsFriend). */
    addedBy: ReadonlySet<string>;
    /** Every member the viewer has a marketplace trade with (tradePartnersOf). */
    tradePartners: ReadonlySet<string>;
}

/**
 * What contactVisibleTo needs to know about `viewerPubkey`, which must be the verified signer, never a value from the
 * request: anyone can name a friend's key. A viewer that is not a member is looked up no further.
 */
export function contactViewer(db: Db, viewerPubkey: string | null | undefined): ContactViewer {
    const pubkey = viewerPubkey || null;
    const isMember = readsAsMember(db, pubkey);
    return {
        pubkey,
        isMember,
        addedBy: isMember ? ownersWhoAddedAsFriend(db, pubkey) : new Set(),
        tradePartners: isMember ? tradePartnersOf(db, pubkey) : new Set(),
    };
}

/**
 * Whether `viewer` may see the contact details of `ownerPubkey`, who chose `visibility` for them
 * (Settings → "Who can see this?").
 *
 * THE rule, for every route that sends a member's contact details: the profile page, the member list,
 * and any route added later. A route never decides this itself. They drifted once: the profile page
 * honoured the choice while GET /api/community/members sent every member's contact to every reader.
 *
 *  - The owner always sees their own.
 *  - Nobody else who doesn't read as a member of this node (readsAsMember): not an unsigned reader (read auth
 *    can be off), not a signed non-member, not a pruned account, not a suspended or disabled member while that
 *    lasts, not a visitor.
 *  - 'community': every member.
 *  - 'trade_partners': a member the owner has a marketplace trade with, in any state (tradePartnersOf).
 *  - 'friends': a member the OWNER has added as a friend (a `friends` row owner → viewer). One-way on
 *    purpose: adding someone as your friend does not reveal their contact to you.
 *  - 'hidden', no visibility stored, or a value this node doesn't know: nobody else.
 */
export function contactVisibleTo(
    ownerPubkey: string,
    visibility: string | null | undefined,
    viewer: ContactViewer,
): boolean {
    if (viewer.pubkey && viewer.pubkey === ownerPubkey) return true;
    if (!viewer.isMember) return false;
    switch (visibility) {
        case 'community':
            return true;
        case 'trade_partners':
            return viewer.tradePartners.has(ownerPubkey);
        case 'friends':
            return viewer.addedBy.has(ownerPubkey);
        default:
            return false;
    }
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
    if (profile.contact && !contactVisibleTo(publicKey, row.contact_visibility, contactViewer(db, requesterPubkey))) {
        profile.contact = null;
    }
    return profile;
}

export function getAllProfiles(db: Db, requesterPubkey?: string): MemberProfile[] {
    const rows = db.prepare("SELECT * FROM members WHERE status != 'pruned'").all() as any[];
    const viewer = contactViewer(db, requesterPubkey);

    const profiles: MemberProfile[] = [];
    for (const row of rows) {
        const profile = rowToProfile(row);
        if (profile.contact && !contactVisibleTo(profile.publicKey, row.contact_visibility, viewer)) {
            profile.contact = null;
        }
        profiles.push(profile);
    }
    return profiles;
}
