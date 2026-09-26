// Stateful wrappers and mutations for members and profiles.
//
// Bridges the database storage layer with server singletons and broadcasts.

import { db, seedNodeRolesFromGenesis, afterTransactionCommit } from '../db/db.js';
import { ledger } from './ledger.js';
import { getMember, getProfile, isNodeMember, isVisitorKey, publicMemberCard, type Member, type MemberProfile } from '@beanpool/engine';
import { recordActivity as recordFeedActivity } from '../db/activity-feed-db.js';
import { bumpMembersVersion } from './versions.js';
import { isAcceptablePhotoValue } from './avatar.js';
import { stripImageValue } from '../storage/image-metadata.js';
import { isSelfAvatarUrl, isSyntheticAccount } from '@beanpool/core';
import { isMemberKeySpelling, badKeyError } from './member-key.js';

/**
 * Record activity timestamp for a member.
 */
export function recordActivity(publicKey: string): void {
    db.prepare("UPDATE members SET last_active_at=? WHERE public_key=?").run(new Date().toISOString(), publicKey);
    // A visitor's row is no lead or convenor coming back: it acts for no enterprise and no group (the director's rule,
    // 2026-09-26), so what it may still do (a reply in its own DM) cancels no vote to replace it (4111202724).
    if (isVisitorKey(db, publicKey)) return;
    try {
        const activeProps = db.prepare(
            "SELECT id, enterprise_pubkey FROM enterprise_succession_proposals WHERE lead_pubkey = ? AND status = 'active'"
        ).all(publicKey) as any[];
        if (activeProps.length > 0) {
            db.prepare("UPDATE enterprise_succession_proposals SET status = 'cancelled' WHERE lead_pubkey = ? AND status = 'active'").run(publicKey);
            // Tell clients only once the UPDATE is durable. recordActivity is called from inside
            // transactions (transfer() has wrapped its writes in one since #1096), and a later statement
            // in that transaction can still throw: the UPDATE rolls back with it, but a broadcast already
            // sent cannot be recalled, and every client would have retired a proposal the node still holds
            // as active. afterTransactionCommit fires straight away outside a transaction, and defers to
            // the outermost commit inside one — dropping the queued hooks if it rolls back instead.
            for (const p of activeProps) {
                afterTransactionCommit(() => {
                    (globalThis as any).broadcast?.({
                        type: 'enterprise_succession_cancelled',
                        proposalId: p.id,
                        enterprisePubkey: p.enterprise_pubkey,
                        leadPubkey: publicKey
                    });
                });
            }
        }
    } catch {
        // Safe to ignore if table does not exist in isolated db test
    }
    // A group convenor coming back closes any vote to replace them (engine/group-succession.ts). One indexed
    // lookup; the hook itself (registered by the state engine, which owns the callbacks) runs only on a hit.
    if (memberActivityHook) {
        try {
            const open = db.prepare("SELECT 1 FROM group_convenor_proposals WHERE convenor_pubkey = ? AND status = 'active' LIMIT 1").get(publicKey);
            if (open) memberActivityHook(publicKey);
        } catch {
            // Table absent on an isolated test schema.
        }
    }
}

let memberActivityHook: ((publicKey: string) => void) | null = null;

/** Run `fn` when a member with an open group-convenor vote against them records activity. */
export function setMemberActivityHook(fn: ((publicKey: string) => void) | null): void {
    memberActivityHook = fn;
}

/**
 * Seeds initial genesis member, bypasses FK constraints.
 */
export function seedGenesisMember(adminPublicKey: string, callsign: string): Member {
    const existing = db.prepare("SELECT * FROM members WHERE public_key = ?").get(adminPublicKey) as any;
    if (existing) {
        db.prepare("UPDATE members SET invited_by = 'genesis', invite_code = 'genesis' WHERE public_key = ?").run(adminPublicKey);
        if (adminPublicKey !== 'SYSTEM') {
            seedNodeRolesFromGenesis();
            db.prepare(
                `INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by)
                 VALUES (?, 'owner', 'genesis')`
            ).run(adminPublicKey);
        }
        return getMember(db, adminPublicKey)!;
    }

    db.pragma('foreign_keys = OFF');
    db.transaction(() => {
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) 
                    VALUES (?, ?, ?, ?, ?)`).run(adminPublicKey, callsign, new Date().toISOString(), 'genesis', 'genesis');
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(adminPublicKey);
    })();

    ledger.initializeGenesisAccount(adminPublicKey);
    if (adminPublicKey !== 'SYSTEM') {
        seedNodeRolesFromGenesis();
        db.prepare(
            `INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by)
             VALUES (?, 'owner', 'genesis')`
        ).run(adminPublicKey);
    }
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

/** Bounded so a one-letter prefix cannot ask the node to serialise the whole member table. */
const RECOVERY_CANDIDATE_LIMIT = 20;

/** A member offered as a social-recovery target. Deliberately public-safe fields only. */
export interface RecoveryCandidate {
    publicKey: string;
    callsign: string;
    joinedAt: string | null;
    avatarUrl: string | null;
    /** Enough guardians to reach the threshold — i.e. guardian recovery can be started. */
    canRecoverByGuardians: boolean;
    /**
     * Holds at least one sign-in fragment — i.e. SSO recovery can be started.
     *
     * A boolean, NOT the provider names. Which provider a member uses is not something a public,
     * unauthenticated endpoint should hand out to anyone who can guess a callsign; that the account
     * is recoverable at all is enough to build the picker with.
     */
    canRecoverBySso: boolean;
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
export function findRecoveryCandidates(callsign: string, options: { exact?: boolean } = {}): RecoveryCandidate[] {
    const norm = callsign.trim().toLowerCase();
    if (!norm) return [];
    // PREFIX, not exact. Callsigns are unique per node, so the member who wanted `paul` and was
    // given `paul12` has no reason to remember the digits months later — and an exact match returns
    // nothing, which reads as "your account is gone" rather than "try harder". Matching on the
    // prefix and showing avatars lets them recognise themselves instead of recalling a string.
    //
    // Enumeration is no cheaper than before in any way that matters: callsigns are public by design
    // (they are how members find each other) and this endpoint is already rate-limited for exactly
    // this reason. LIKE 'x%' uses the index; a leading wildcard would not, and is not offered.
    //
    // The guardian floor moved out of the WHERE clause: it decides which BUTTON to offer, not
    // whether the account exists. Filtering on it hid every SSO-only member from a lookup they are
    // perfectly able to recover through.
    //
    // EXACT (`options.exact`), on a node that shows visitors the listings and not the people (the
    // global node, G9a-2): a stranger there must not list its members by typing a letter. Case is
    // still forgiven; the same partial index answers it.
    // `%` and `_` are LIKE wildcards. Bound straight in, a caller could send `%` and enumerate the
    // whole node from an unauthenticated endpoint — which is precisely what the rate limit on this
    // route exists to bound, so leaving it would have undone that.
    const escaped = norm.replace(/[\\%_]/g, c => '\\' + c);

    // Eligibility is decided in SQL, not afterwards in JS. With the filter applied after LIMIT,
    // twenty matching-but-unrecoverable accounts consumed the whole limit and the caller got an
    // empty list — hiding a recoverable member behind namesakes who happen to sort earlier.
    const rows = db.prepare(`
        SELECT * FROM (
            SELECT m.public_key, m.callsign, m.joined_at, m.avatar_url,
                   (SELECT COUNT(*) FROM recovery_shares s
                     WHERE s.owner_pubkey = m.public_key AND s.holder_type = 'sso'
                       AND s.generation = (SELECT MAX(generation) FROM recovery_shares
                                            WHERE owner_pubkey = m.public_key)) AS sso_count
            FROM members m
            WHERE ${options.exact ? 'lower(m.callsign) = ?' : "lower(m.callsign) LIKE ? ESCAPE '\\'"}
              AND m.status NOT IN ('migrated', 'pruned')
        )
        WHERE sso_count > 0
        ORDER BY length(callsign), callsign
        LIMIT ?
    `).all(options.exact ? norm : escaped + '%', RECOVERY_CANDIDATE_LIMIT) as any[];

    return rows.map(r => ({
        publicKey: r.public_key,
        callsign: r.callsign,
        joinedAt: r.joined_at,
        avatarUrl: r.avatar_url,
        canRecoverByGuardians: false,
        canRecoverBySso: Number(r.sso_count) > 0,
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
    // One key, one spelling (engine/member-key.ts): every door that reaches here (an invite, an offline ticket, the open
    // door, re-registering) has already taken the key that way; this is the last line, before any lookup or write.
    if (!isMemberKeySpelling(publicKey)) {
        console.warn(`[Security] Rejected registration for a key not written as this community keeps keys (${JSON.stringify(String(publicKey).slice(0, 16))}…)`);
        return null;
    }
    if (!callsign || callsign.trim().length < 2) {
        console.warn(`[Security] Rejected registration with invalid callsign "${callsign}" for ${publicKey}`);
        return null;
    }
    callsign = callsign.trim();

    const existing = db.prepare("SELECT * FROM members WHERE public_key = ?").get(publicKey) as any;
    if (existing?.is_visitor && (inviteCode || invitedBy)) {
        // A visitor joining for real, through a door (an invite, an offline ticket, the open door): its row becomes a
        // member's, as a new member's would be, and keeps what was sent to it (messages, Beans). Joined now, so a new
        // member's limits start now; the name is uniquified against everyone else, as at any join.
        callsign = uniquifyCallsign(callsign, publicKey);
        db.prepare("UPDATE members SET is_visitor = 0, invited_by = ?, invite_code = ?, callsign = ?, joined_at = ? WHERE public_key = ?")
            .run(invitedBy, inviteCode, callsign, new Date().toISOString(), publicKey);
        return announceJoin(broadcast, publicKey, callsign, invitedBy, 'Visitor joined');
    }
    // A visitor's row with no door is refused below, as a key with no row is: re-registering renames no visitor.
    if (existing && !existing.is_visitor) {
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
    return announceJoin(broadcast, publicKey, callsign, invitedBy, 'New member');
}

/** What every join does once the row is a member's: the member_joined broadcast, the feed's line and the log. */
function announceJoin(broadcast: (event: any) => void, publicKey: string, callsign: string, invitedBy: string | null, what: string): Member {
    const member = getMember(db, publicKey)!;
    // Every member socket gets this, so it carries the public card, not the row (which holds the invite code the
    // member joined with). The apps only use the event as a doorbell; the server reads member.publicKey.
    broadcast({ type: 'member_joined', member: publicMemberCard(member) });
    try {
        recordFeedActivity('member_joined', publicKey, null, { callsign });
    } catch (e) {
        console.warn('[ActivityFeed] Could not record member_joined:', e);
    }
    console.log(`👤 ${what}: ${callsign} invited by ${invitedBy ? invitedBy.substring(0, 12) : 'system'}...`);
    return member;
}

/**
 * Public facade for registering a member.
 */
export function registerMember(broadcast: (event: any) => void, publicKey: string, callsign: string): Member | null {
    return registerMemberInternal(broadcast, publicKey, callsign, null, null);
}

/**
 * Register visitor identity: a key a member messages or sends Beans to that has no row here (engine/messaging.ts
 * createConversation, state-engine transfer), and a member of another community (the federation paths). The row is
 * marked a visitor's (members.is_visitor).
 */
export function registerVisitor(publicKey: string, callsign?: string, homeNodeUrl?: string): void {
    if (writeVisitorRow(publicKey, callsign, homeNodeUrl)) ledger.initializeGenesisAccount(publicKey);
}

/**
 * registerVisitor's rows, without its in-memory ledger account: for state-engine transfer(), which makes a new
 * recipient's row inside its own transaction, only once the Beans have moved, and whose ledger.transfer has already
 * made the account it credits (initializeGenesisAccount would zero it). True when it wrote a new row.
 */
export function writeVisitorRow(publicKey: string, callsign?: string, homeNodeUrl?: string): boolean {
    const existing = db.prepare("SELECT * FROM members WHERE public_key = ?").get(publicKey) as any;
    // One key, one spelling (engine/member-key.ts): a new row only for a key in it, so a send, a message or a peer
    // naming a member's key in capitals makes no second row for it. Thrown before anything is written (the send route
    // and the conversation route refuse it first, 400 bad_key). An existing row under exactly this id is left to the
    // lines below: an enterprise or a project is keyed on its id. A reserved id is no one's key and no request names
    // one (the send and conversation routes refuse it): the admin inbox's own `system` sender gets its row, as before.
    if (!existing && !isMemberKeySpelling(publicKey) && !isSyntheticAccount(publicKey)) throw badKeyError();
    if (existing) {
        let changed = false;
        if (callsign && existing.callsign.startsWith('Visitor-')) {
            db.prepare("UPDATE members SET callsign = ? WHERE public_key = ?").run(callsign, publicKey);
            changed = true;
        }
        if (homeNodeUrl && !existing.home_node_url) {
            db.prepare("UPDATE members SET home_node_url = ? WHERE public_key = ?").run(homeNodeUrl, publicKey);
            changed = true;
        }
        // Bumped HERE rather than at the call sites: this function writes to `members` and is
        // reached from five federation paths (inbound handshake, settlement exchange, listing
        // resolution, transfer to a visiting member, messaging a visiting member), none of which
        // broadcast. Only the federation listing cache remembered to invalidate, so a visitor
        // arriving by any other route was invisible in the member directory for as long as the
        // ETag held — which, with no other write, is forever.
        if (changed) bumpMembersVersion();
        return false;
    }
    const generatedCallsign = callsign || `Visitor-${publicKey.substring(0, 8)}`;
    // A visitor's row (is_visitor = 1, the engine's isVisitorKey): it receives what is sent to it and reads only what a
    // non-member reads. An existing row, above, is never made one: a member stays a member.
    db.transaction(() => {
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, home_node_url, is_visitor)
                    VALUES (?, ?, ?, ?, ?, ?, 1)`).run(publicKey, generatedCallsign, new Date().toISOString(), null, null, homeNodeUrl || null);
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(publicKey);
    })();
    bumpMembersVersion();
    console.log(`🌐 Visitor registered: ${generatedCallsign} (federation${homeNodeUrl ? ` from ${homeNodeUrl}` : ''})`);
    return true;
}

export const NOT_A_MEMBER_ERROR = 'Only members of this community can do this.';
export const NOT_A_MEMBER_CODE = 'not_a_member';

/**
 * For a write that reaches another member (their message, a trade with them) and answers with them: the signer must
 * still be a member of this node, the engine's isNodeMember (a member row that isn't a visitor's, not pruned, for a key
 * no re-key has invalidated). A pruned account keeps its row, its group roles and its open trades, and the old key of a
 * member being re-keyed (a lost or stolen phone) keeps its row too, and both can still sign; a visitor's row never
 * joined. Refused 403 before anything is written or anyone is returned.
 *
 * Deliberately not state-engine's assertMemberActive, which also refuses 'suspended' and 'disabled': a suspended
 * member keeps what suspension already allows them (closing their own trades, running their own event's chat).
 */
export function assertNodeMember(publicKey: string): void {
    if (isNodeMember(db, publicKey)) return;
    throw Object.assign(new Error(NOT_A_MEMBER_ERROR), { status: 403, statusCode: 403, code: NOT_A_MEMBER_CODE });
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
    // A visitor's row has no profile to change here, as a key with no row has none: it gets a name, a photo and a bio
    // when it joins.
    if (!getMember(db, publicKey) || isVisitorKey(db, publicKey)) return null;
    recordActivity(publicKey);

    // The photo rule, bare base64 included (G9a-3): /api/avatar/<pk> sniffs, but the group, group-members and profile
    // routes hand members.avatar_url out exactly as stored, so a HEIC or any other format the strip does not know would
    // reach other members with its GPS. Both apps send a JPEG data URL or a bundled:// name, which pass.
    if (update.avatar !== undefined && !isAcceptablePhotoValue(update.avatar)) throw new Error('AVATAR_INVALID');
    const existing = db.prepare("SELECT * FROM members WHERE public_key = ?").get(publicKey) as any;
    // The node never stores its OWN avatar URL as an avatar. Installed builds read
    // `members.avatar_url` out of their synced local row — which since #725 holds this node's
    // `/api/avatar/<pk>?size=thumb` string, not the photo — and post it straight back here on
    // every Save. Storing it replaced the member's photo with a pointer to itself, and from
    // then on `GET /api/avatar/<pk>` 404d: the photo was destroyed, on the node and (via the
    // phone's canonical mirror) on the device.
    //
    // Deliberately NOT a 400. Those builds are already on members' phones and send this on
    // every bio or name edit; rejecting it would mean they could no longer save a bio or a
    // name at all. Read as "avatar unchanged" instead, which is what the sender meant.
    const avatarUnchanged = update.avatar === undefined || isSelfAvatarUrl(update.avatar);
    // A new photo is stored without its metadata (G9a-3): /api/avatar/<pk> serves it to anyone who asks.
    const avatar = avatarUnchanged ? existing.avatar_url : stripImageValue(update.avatar);
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
    let archetype = existing.archetype || null;
    if (update.archetype === null) {
        archetype = null;
    } else if (typeof update.archetype === 'string') {
        archetype = update.archetype.trim().slice(0, 4096);
    }

    const profileUpdatedAt = new Date().toISOString();

    db.prepare(`UPDATE members SET avatar_url=?, bio=?, contact_value=?, contact_visibility=?, callsign=?, profile_updated_at=?, archetype=? WHERE public_key=?`)
      .run(avatar, bio, contact_value, contact_visibility, callsign, profileUpdatedAt, archetype, publicKey);

    broadcast({ type: 'profile_updated', publicKey, profileUpdatedAt });
    // Read as the owner: POST /api/profile/update answers the signer, who always sees their own contact details.
    return getProfile(db, publicKey, publicKey);
}
