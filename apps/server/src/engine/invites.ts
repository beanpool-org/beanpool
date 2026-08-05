// Stateful wrappers for generating and redeeming invite codes.
//
// Extracted from apps/server/src/state-engine.ts to separate invite code database side-effects.

import { db } from '../db/db.js';
import { ledger } from './ledger.js';
import { recordActivity, registerMemberInternal } from './members.js';
import { recordFunnelEvent } from './funnel.js';
import { getGenesisEarnedCredit, getTier, PROTOCOL_CONSTANTS } from '@beanpool/core';
import {
    getMember,
    generateShortCode,
    verifyOfflineTicket,
    type Member,
    type InviteCode,
    type GenesisInviteType
} from '@beanpool/engine';

/**
 * Creates standard online invite code for an active member.
 */
export function generateInvite(inviterPubkey: string, intendedFor?: string): InviteCode | null {
    const inviter = getMember(db, inviterPubkey);
    if (!inviter) return null;

    recordActivity(inviterPubkey);

    const code = generateShortCode();
    const createdAt = new Date().toISOString();

    db.prepare(`INSERT INTO invite_codes (code, created_by, created_at, intended_for) VALUES (?, ?, ?, ?)`)
      .run(code, inviterPubkey, createdAt, intendedFor || null);

    const invite: InviteCode = { code, createdBy: inviterPubkey, createdAt, usedBy: null, usedAt: null, intendedFor };
    console.log(`🎟️  Invite generated: ${code} by ${inviter.callsign}`);
    return invite;
}

/**
 * Generates admin tier-granted invite codes with optional genesis credit boost.
 */
export function adminGenerateInvite(
    adminPubkey: string,
    genesisType: GenesisInviteType = 'standard',
    intendedFor?: string
): InviteCode | null {
    const admin = getMember(db, adminPubkey);
    if (!admin) return null;

    recordActivity(adminPubkey);

    const code = generateShortCode();
    const createdAt = new Date().toISOString();

    db.prepare(`INSERT INTO invite_codes (code, created_by, created_at, genesis_type, intended_for) VALUES (?, ?, ?, ?, ?)`)
      .run(code, adminPubkey, createdAt, genesisType, intendedFor || null);

    const invite: InviteCode = { code, createdBy: adminPubkey, createdAt, usedBy: null, usedAt: null, intendedFor };
    const tierLabel = genesisType === 'standard' ? '🥚' : genesisType === 'trusted' ? '🏠' : genesisType === 'ambassador' ? '🏛️' : '⛰️';
    console.log(`🎟️  Admin Genesis Invite generated: ${code} [${genesisType} ${tierLabel}] by ${admin.callsign}`);
    return invite;
}

/**
 * Validates and redeems standard INV- code, registering the member and seeding earned credit.
 */
export function redeemInvite(
    broadcast: (event: any) => void,
    code: string,
    publicKey: string,
    callsign: string
): { success: boolean; error?: string; member?: Member; alreadyMember?: boolean } {
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

    // Check if identity is ALREADY a member before "already used" check
    const existingMember = getMember(db, publicKey);
    if (existingMember) {
        // Not a failure and not a new join — someone re-entering. Its own event so it
        // neither inflates signups nor drags down the rejection rate.
        recordFunnelEvent('invite_reentry');
        return { success: true, member: existingMember, alreadyMember: true };
    }

    // NB: `invite.intended_for` is recorded for the INVITER's records only — it is
    // deliberately not enforced here, so an invitee picks whatever callsign they want.
    if (invite.used_by) {
        recordFunnelEvent('invite_failed', 'already_used');
        return { success: false, error: 'This invite has already been used' };
    }

    // Register member FIRST — invite_codes.used_by has FK to members(public_key)
    const member = registerMemberInternal(broadcast, publicKey, callsign, invite.created_by, code);
    if (!member) {
        recordFunnelEvent('invite_failed', 'registration_failed');
        return { success: false, error: 'Registration failed' };
    }

    db.prepare("UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code COLLATE NOCASE = ?").run(publicKey, new Date().toISOString(), code);

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
 * Replay-protected redemption of offline cryptographic tickets.
 */
export function redeemOfflineTicket(
    broadcast: (event: any) => void,
    ticketB64: string,
    joinerPublicKey: string,
    callsign: string
): { success: boolean; error?: string; member?: Member; alreadyMember?: boolean } {
    // Funnel: the offline ticket is the other door into the same flow, so it counts as
    // an attempt too — otherwise a community handing out paper tickets would look like
    // nobody was trying to join at all.
    recordFunnelEvent('invite_attempt');

    try {
        const verified = verifyOfflineTicket(db, ticketB64);
        if (!verified.ok) {
            recordFunnelEvent('invite_failed', 'invalid');
            return { success: false, error: verified.error };
        }
        const { inviterPubkey, timestamp, intendedFor, codeHash } = verified;

        // Check if identity is ALREADY a member before "already used" check
        const existingMember = getMember(db, joinerPublicKey);
        if (existingMember) {
            recordFunnelEvent('invite_reentry');
            return { success: true, member: existingMember, alreadyMember: true };
        }

        // As with redeemInvite: `intendedFor` rides along on the ticket for the inviter's
        // records and is stored below, but never constrains the joiner's chosen callsign.
        const existingInvite = db.prepare("SELECT * FROM invite_codes WHERE code COLLATE NOCASE = ?").get(codeHash) as any;
        if (existingInvite) {
            if (existingInvite.used_by) {
                recordFunnelEvent('invite_failed', 'already_used');
                return { success: false, error: 'This exact mathematical offline ticket has already been redeemed' };
            }
        } else {
            const createdAt = new Date(timestamp).toISOString();
            db.prepare(`INSERT INTO invite_codes (code, created_by, created_at, intended_for) VALUES (?, ?, ?, ?)`).run(codeHash, inviterPubkey, createdAt, intendedFor || null);
        }

        recordActivity(inviterPubkey);

        const member = registerMemberInternal(broadcast, joinerPublicKey, callsign, inviterPubkey, codeHash);
        if (!member) {
            recordFunnelEvent('invite_failed', 'registration_failed');
            return { success: false, error: 'Registration failed during state sync' };
        }

        db.prepare("UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code COLLATE NOCASE = ?").run(joinerPublicKey, new Date().toISOString(), codeHash);

        return { success: true, member };
    } catch (e) {
        recordFunnelEvent('invite_failed', 'malformed');
        return { success: false, error: 'Malformed or broken offline ticket payload' };
    }
}
