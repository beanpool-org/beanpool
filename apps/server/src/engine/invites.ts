// Stateful wrappers for generating and redeeming invite codes.
//
// Extracted from apps/server/src/state-engine.ts to separate invite code database side-effects.

import { db } from '../db/db.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { assertFeatureOn } from '../config/node-profile.js';
import { assertMayInviteHere, mayInviteHere, ADMINS_ONLY_TICKET_MESSAGE } from '../config/door.js';
import { isPrivatePreview, PRIVATE_PREVIEW_MESSAGE } from '../config/private-preview.js';
import { isNodeAdmin } from './node-roles.js';
import { ledger } from './ledger.js';
import { recordActivity, registerMemberInternal } from './members.js';
import { recordFunnelEvent } from './funnel.js';
import { isMemberKeySpelling, BAD_KEY_ERROR } from './member-key.js';
import { getGenesisEarnedCredit, getTier, PROTOCOL_CONSTANTS } from '@beanpool/core';
import {
    getMember,
    mayBringSomeoneIn,
    isInvalidatedKey,
    isVisitorKey,
    generateShortCode,
    verifyOfflineTicket,
    type Member,
    type InviteCode,
    type GenesisInviteType
} from '@beanpool/engine';
import { ticketBinding } from './member-signature.js';
import { ticketJoinRefusal } from './writer-bounds.js';
import { inviteLogTag } from '../sanitize-message.js';
import { assertMayBindInvite, confirmByInvite } from './names-list.js';

/**
 * Whether a code's maker can still bring someone in (the engine's mayBringSomeoneIn): a member of this node, not just a
 * row. A pruned account keeps its row, and so does the old key of a member being re-keyed (a lost or stolen phone); a
 * code from either would let its holder straight back in as someone new, so neither makes one, and one made before is
 * refused. Nor a visitor's row (a key a member messaged or sent Beans to, or a member of another community): it never
 * joined, and its code would admit anyone, itself included. A code a visitor made before this version is refused too.
 */
function canInvite(inviterPubkey: string): boolean {
    return mayBringSomeoneIn(db, inviterPubkey);
}

const INVITER_GONE = 'The member who made this invite is no longer in this community, so it can’t be used. Ask a member for a fresh one.';

/**
 * Where the node's `invites` switch is off (the global node, config/node-profile.ts), nothing here makes an invite or
 * joins anyone with one: each function below throws FeatureOffError (404 `feature_off`) before it reads or writes
 * anything, a funnel count included. The routes answer the same before they get here (routes/profile-feature-gate.ts);
 * this is the guard under them, for every caller, a knock's answer (engine/knocks.ts approveKnock) among them.
 */
function assertInvitesOn(): void {
    assertFeatureOn('invites');
}

/**
 * Creates standard online invite code for an active member.
 */
/**
 * `beforeWrite`: a caller's own limit on new codes (the route's 20 a day and 50 unused, W-main), run once the inviter is
 * known to be a member who may bring someone in and before anything is written, so a limit never answers for someone
 * who may not invite at all.
 *
 * Where only admins invite (the door, config/door.ts), a member who is no owner or admin here gets DoorClosedError (403
 * `admins_only`), after the member check and before the limit: a knock's answer included (engine/knocks.ts).
 */
export function generateInvite(inviterPubkey: string, intendedFor?: string, beforeWrite?: () => void, namesEntryId?: string): InviteCode | null {
    assertPlainTablesWritable();
    assertInvitesOn();
    const inviter = getMember(db, inviterPubkey);
    if (!inviter || !canInvite(inviterPubkey)) return null;
    assertMayInviteHere(inviterPubkey);
    // An invite bound to a names-list entry (community modes slice 3): only an admin who could confirm someone against
    // that entry now, and never one with a live confirmation (NamesListError, before the limit and before any write).
    const boundEntry = namesEntryId === undefined ? null : assertMayBindInvite(inviterPubkey, namesEntryId);
    beforeWrite?.();

    recordActivity(inviterPubkey);

    const code = generateShortCode();
    const createdAt = new Date().toISOString();

    db.prepare(`INSERT INTO invite_codes (code, created_by, created_at, intended_for, names_entry_id) VALUES (?, ?, ?, ?, ?)`)
      .run(code, inviterPubkey, createdAt, intendedFor || null, boundEntry);

    const invite: InviteCode & { namesEntryId?: string } = { code, createdBy: inviterPubkey, createdAt, usedBy: null, usedAt: null, intendedFor };
    if (boundEntry) invite.namesEntryId = boundEntry;
    // Never the code itself: it lets anyone join for 30 days. Its tag lets an operator follow it (FABLE-sec-errors M2).
    console.log(`🎟️  Invite generated: ${inviteLogTag(code)} by ${inviter.callsign}`);
    return invite;
}

/**
 * Generates admin tier-granted invite codes with optional genesis credit boost.
 */
export function adminGenerateInvite(
    adminPubkey: string,
    genesisType: GenesisInviteType = 'standard',
    intendedFor?: string,
    issuedBy?: string
): InviteCode | null {
    assertPlainTablesWritable();
    assertInvitesOn();
    // `adminPubkey` is the member the code hangs off in the invite tree (the genesis member, routes/community.ts), not
    // the admin: the admin is `issuedBy`, already checked by the route (checkAdminAuth and a node role, which a prune
    // takes away). Held to the same rule, or the code would never redeem.
    const admin = getMember(db, adminPubkey);
    if (!admin || !canInvite(adminPubkey)) return null;

    recordActivity(adminPubkey);

    const code = generateShortCode();
    const createdAt = new Date().toISOString();

    db.prepare(`INSERT INTO invite_codes (code, created_by, created_at, genesis_type, intended_for, issued_by) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(code, adminPubkey, createdAt, genesisType, intendedFor || null, issuedBy || null);

    const invite: InviteCode = { code, createdBy: adminPubkey, createdAt, usedBy: null, usedAt: null, intendedFor };
    const tierLabel = genesisType === 'standard' ? '🥚' : genesisType === 'trusted' ? '🏠' : genesisType === 'ambassador' ? '🏛️' : '⛰️';
    console.log(`🎟️  Admin Genesis Invite generated: ${inviteLogTag(code)} [${genesisType} ${tierLabel}] by ${admin.callsign}`);
    return invite;
}

const REPLACED_KEY = 'This key was replaced by a new one, so it can’t join with this invite. Use the device or the 12 words that hold the new key.';
const CLOSED_ACCOUNT = 'This key’s account in this community was closed, so it can’t join again with this invite.';
const VISITOR_UNSIGNED = 'Joining with this key needs a request signed by it. Join from the app that holds it.';

/**
 * A key whose account here was closed (removed, or deleted by its owner: its row is 'pruned') joins with no invite. It
 * was answered as a member until 4109713263, and its app then carried on into a community that refuses everything that
 * key signs (https-server.ts CLOSED_ACCOUNT_REFUSAL). The way back from a removal is a community vote, not a code.
 * Nothing is written and the code stays unused.
 */
function closedAccountRefusal(member: Member): { success: false; error: string } | null {
    if (member.status !== 'pruned') return null;
    recordFunnelEvent('invite_failed', 'account_closed');
    return { success: false, error: CLOSED_ACCOUNT };
}

/**
 * A visitor's row (a key a member messaged or sent Beans to, or a member of another community) becomes a member's only
 * on a redeem signed by that same key (`joinerSigned`, routes/community.ts signedByKey). Both apps sign their redeems.
 * The redeem routes skip the signature middleware and take the key from the body, so without this anyone holding a code
 * or a ticket could name any visitor's key: rename it (to a member's name, say), put it in the code maker's invite
 * branch, where pruning that branch would close it for good, and restart its new-member limits (4110268487).
 *
 * Nothing is written, and the code or the ticket stays unused. Refused rather than answered "already a member", as
 * every row was before visitors' rows: that answer would tell the app it joined when the row is still a visitor's (the
 * membership probe says so), and hand an unsigned caller the visitor's card. A key with no row joins unsigned, as before.
 */
function unsignedVisitorRefusal(joinerSigned: boolean): { success: false; error: string } | null {
    if (joinerSigned) return null;
    recordFunnelEvent('invite_failed', 'visitor_unsigned');
    return { success: false, error: VISITOR_UNSIGNED };
}

/**
 * Validates and redeems standard INV- code, registering the member and seeding earned credit. `joinerSigned`: the
 * request carries a fresh signature by `publicKey` itself (unsignedVisitorRefusal).
 */
export function redeemInvite(
    broadcast: (event: any) => void,
    code: string,
    publicKey: string,
    callsign: string,
    joinerSigned = false
): { success: boolean; error?: string; member?: Member; alreadyMember?: boolean } {
    assertPlainTablesWritable();
    assertInvitesOn();
    // One key, one spelling (engine/member-key.ts), before any lookup or write: a member's key in capitals is no other
    // key, and no second member. The route takes the key that way first (routes/community.ts redeemKey).
    if (!isMemberKeySpelling(publicKey)) return { success: false, error: BAD_KEY_ERROR };

    // Funnel: the top of the join flow. Counted here rather than derived because a
    // rejected code leaves nothing behind to derive from.
    recordFunnelEvent('invite_attempt');

    const invite = db.prepare("SELECT * FROM invite_codes WHERE code COLLATE NOCASE = ?").get(code) as any;
    if (!invite) {
        recordFunnelEvent('invite_failed', 'invalid');
        return { success: false, error: 'Invalid invite code' };
    }

    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const createdAtTime = new Date(invite.created_at).getTime();
    if (Date.now() - createdAtTime > THIRTY_DAYS_MS) {
        recordFunnelEvent('invite_failed', 'expired');
        return { success: false, error: 'This invite code has expired (maximum 30 days validation)' };
    }

    // A private preview (config/private-preview.ts) admits only an owner's or admin's invite: the admin who issued a
    // seed invite (`issued_by`), else the code's maker, and an owner or admin here now. A member's code, made before
    // the preview or not, is refused with the preview's own sentence.
    if (isPrivatePreview() && !isNodeAdmin(String(invite.issued_by ?? invite.created_by))) {
        recordFunnelEvent('invite_failed', 'private_preview');
        return { success: false, error: PRIVATE_PREVIEW_MESSAGE };
    }

    // An invite that answers a request to join (engine/knocks.ts) admits the key that asked and no other, whoever
    // holds the code. Checked before anything else can answer, so another key learns nothing from it. (Every other
    // invite admits whoever holds it: `intended_for` is a note for the inviter, below.)
    const knock = db.prepare('SELECT pubkey FROM join_requests WHERE invite_code = ?').get(invite.code) as { pubkey: string } | undefined;
    if (knock && knock.pubkey !== String(publicKey).toLowerCase()) {
        recordFunnelEvent('invite_failed', 'wrong_key');
        return { success: false, error: 'This invite was made for someone else, so it can’t be used here. Ask a member for your own invite.' };
    }
    // Nor, with any invite, a key a re-key replaced (engine/member-wizards.ts). Admitted, the replaced key would be a
    // second member, able to make invites of its own (`generateInvite` asks only for a member row): the thing the
    // re-key was for stopping. For a knock's invite this is the second lock: a re-key moves the knock to the new key
    // (engine/knocks.ts `moveKnocks`), so the check above already refuses the old one. `redeemOfflineTicket` has it too.
    if (isInvalidatedKey(db, String(publicKey))) {
        recordFunnelEvent('invite_failed', 'key_invalidated');
        return { success: false, error: REPLACED_KEY };
    }

    // Check if identity is ALREADY a member before "already used" check. A visitor's row is not: it joins here like
    // anyone new, and registerMemberInternal makes that row a member's, but only on a redeem its own key signed.
    const existingMember = getMember(db, publicKey);
    if (existingMember) {
        const closed = closedAccountRefusal(existingMember);
        if (closed) return closed;
    }
    if (existingMember && !isVisitorKey(db, publicKey)) {
        // Not a failure and not a new join — someone re-entering. Its own event so it
        // neither inflates signups nor drags down the rejection rate.
        recordFunnelEvent('invite_reentry');
        return { success: true, member: existingMember, alreadyMember: true };
    }
    if (existingMember) {
        const unsigned = unsignedVisitorRefusal(joinerSigned);
        if (unsigned) return unsigned;
    }

    // NB: `invite.intended_for` is recorded for the INVITER's records only — it is
    // deliberately not enforced here, so an invitee picks whatever callsign they want.
    if (invite.used_by) {
        recordFunnelEvent('invite_failed', 'already_used');
        return { success: false, error: 'This invite has already been used' };
    }

    if (!canInvite(invite.created_by)) {
        recordFunnelEvent('invite_failed', 'inviter_gone');
        return { success: false, error: INVITER_GONE };
    }

    // Register member FIRST — invite_codes.used_by has FK to members(public_key). One transaction with the code's use
    // and, for an invite bound to a names-list entry, the confirmation (confirmByInvite): never a member without them.
    const member = db.transaction(() => {
        const m = registerMemberInternal(broadcast, publicKey, callsign, invite.created_by, code);
        if (!m) return null;
        const outcome = invite.names_entry_id ? confirmByInvite(invite.created_by, invite.names_entry_id, publicKey) : null;
        db.prepare("UPDATE invite_codes SET used_by = ?, used_at = ?, names_bind_outcome = ? WHERE code COLLATE NOCASE = ?")
            .run(publicKey, new Date().toISOString(), outcome, code);
        return m;
    })();
    if (!member) {
        recordFunnelEvent('invite_failed', 'registration_failed');
        return { success: false, error: 'Registration failed' };
    }

    // Pre-seed earned credit for tiered genesis invites
    const genesisType = (invite.genesis_type || 'standard') as GenesisInviteType;
    if (genesisType !== 'standard') {
        const earnedCredit = getGenesisEarnedCredit(genesisType);
        if (earnedCredit > 0) {
            db.prepare("UPDATE members SET earned_credit = ? WHERE public_key = ?").run(earnedCredit, publicKey);
            const tier = getTier(PROTOCOL_CONSTANTS.CREDIT_BASE_FLOOR - earnedCredit);
            console.log(`🌟 Genesis invite redeemed: ${callsign} starts as ${tier.emoji} ${tier.name} (earned_credit: ${earnedCredit})`);
        }
    }

    return { success: true, member };
}

/**
 * Replay-protected redemption of offline cryptographic tickets. `joinerSigned` as in redeemInvite.
 */
export function redeemOfflineTicket(
    broadcast: (event: any) => void,
    ticketB64: string,
    joinerPublicKey: string,
    callsign: string,
    joinerSigned = false
): { success: boolean; error?: string; member?: Member; alreadyMember?: boolean } {
    assertPlainTablesWritable();
    assertInvitesOn();
    // One key, one spelling, as in redeemInvite.
    if (!isMemberKeySpelling(joinerPublicKey)) return { success: false, error: BAD_KEY_ERROR };

    // Funnel: the offline ticket is the other door into the same flow, so it counts as
    // an attempt too — otherwise a community handing out paper tickets would look like
    // nobody was trying to join at all.
    recordFunnelEvent('invite_attempt');

    // Only the ticket's decoding and checking answer "malformed" (the route's 400, which the apps read as "this send
    // made no member"). Nothing after it is caught here: a throw once registerMemberInternal has written the member (the
    // invite_codes write after it failing on a full disk, say) must reach Koa as a 500, which the apps keep the key for,
    // and never be told to them as a broken ticket (PR #1198, 4112075324). verifyOfflineTicket catches its own throws;
    // this catch is for anything it lets through.
    let verified: ReturnType<typeof verifyOfflineTicket>;
    try {
        verified = verifyOfflineTicket(db, ticketB64, ticketBinding);
    } catch {
        recordFunnelEvent('invite_failed', 'malformed');
        return { success: false, error: 'Malformed or broken offline ticket payload' };
    }
    if (!verified.ok) {
        recordFunnelEvent('invite_failed', 'invalid');
        return { success: false, error: verified.error };
    }
    const { inviterPubkey, timestamp, intendedFor, namesEntryId, codeHash } = verified;

    // Never a key a re-key replaced, as in redeemInvite.
    if (isInvalidatedKey(db, String(joinerPublicKey))) {
        recordFunnelEvent('invite_failed', 'key_invalidated');
        return { success: false, error: REPLACED_KEY };
    }

    // Check if identity is ALREADY a member before "already used" check. A visitor's row is not, as in redeemInvite.
    const existingMember = getMember(db, joinerPublicKey);
    if (existingMember) {
        const closed = closedAccountRefusal(existingMember);
        if (closed) return closed;
    }
    if (existingMember && !isVisitorKey(db, joinerPublicKey)) {
        recordFunnelEvent('invite_reentry');
        return { success: true, member: existingMember, alreadyMember: true };
    }
    // A visitor's row, only on a redeem its own key signed (unsignedVisitorRefusal). Before the ticket's code is
    // written, so a refused ticket stays unused.
    if (existingMember) {
        const unsigned = unsignedVisitorRefusal(joinerSigned);
        if (unsigned) return unsigned;
    }

    // As with redeemInvite: `intendedFor` rides along on the ticket for the inviter's
    // records and is stored below, but never constrains the joiner's chosen callsign.
    const existingInvite = db.prepare("SELECT * FROM invite_codes WHERE code COLLATE NOCASE = ?").get(codeHash) as any;
    if (existingInvite?.used_by) {
        recordFunnelEvent('invite_failed', 'already_used');
        return { success: false, error: 'This exact mathematical offline ticket has already been redeemed' };
    }
    // Where only admins invite (the door, config/door.ts), a ticket made by a member is refused. A code is made here, so
    // one made before the door closed still joins; a ticket is made on the phone and this server first sees it now, and
    // the date it carries is its maker's own claim, so it can't show it was made before. Nothing is written and the
    // ticket stays unused: should the door open again, it joins.
    if (!mayInviteHere(inviterPubkey)) {
        recordFunnelEvent('invite_failed', 'admins_only');
        return { success: false, error: ADMINS_ONLY_TICKET_MESSAGE };
    }
    // A ticket is an invite its maker makes on the phone, which this server first sees when someone joins with it, so it
    // counts against the maker's 20 invites a day then (W-main, engine/writer-bounds.ts). Past it, nothing is written and
    // the ticket stays unused.
    const inviterAtLimit = ticketJoinRefusal(inviterPubkey);
    if (inviterAtLimit) {
        recordFunnelEvent('invite_failed', 'inviter_daily_limit');
        return { success: false, error: inviterAtLimit };
    }
    // No recordActivity(inviterPubkey): the joiner redeems the ticket, possibly weeks after the inviter
    // signed it and without the inviter present. Stamping the inviter active would reset lead-succession
    // inactivity and cancel a succession vote on a lead who did nothing (#838 review).

    // One transaction: the code's row, the member, the code's use and, for a ticket bound to a names-list entry (signed
    // inside it, core inviteTicketText), the confirmation by the ticket's maker (confirmByInvite: made on the phone, so
    // the maker's right to it is checked now; a binding that can't stand makes the member unconfirmed, never refused).
    const member = db.transaction(() => {
        if (!existingInvite) {
            const createdAt = new Date(timestamp).toISOString();
            db.prepare(`INSERT INTO invite_codes (code, created_by, created_at, intended_for, names_entry_id) VALUES (?, ?, ?, ?, ?)`)
                .run(codeHash, inviterPubkey, createdAt, intendedFor || null, namesEntryId ?? null);
        }
        const m = registerMemberInternal(broadcast, joinerPublicKey, callsign, inviterPubkey, codeHash);
        if (!m) return null;
        const outcome = namesEntryId ? confirmByInvite(inviterPubkey, namesEntryId, joinerPublicKey) : null;
        db.prepare("UPDATE invite_codes SET used_by = ?, used_at = ?, names_bind_outcome = ? WHERE code COLLATE NOCASE = ?")
            .run(joinerPublicKey, new Date().toISOString(), outcome, codeHash);
        return m;
    })();
    if (!member) {
        recordFunnelEvent('invite_failed', 'registration_failed');
        return { success: false, error: 'Registration failed during state sync' };
    }

    return { success: true, member };
}
