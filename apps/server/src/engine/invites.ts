// Stateful wrappers for generating and redeeming invite codes.
//
// Extracted from apps/server/src/state-engine.ts to separate invite code database side-effects.

import { db } from '../db/db.js';
import { ledger } from './ledger.js';
import { recordActivity, registerMemberInternal } from './members.js';
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
    const invite = db.prepare("SELECT * FROM invite_codes WHERE code COLLATE NOCASE = ?").get(code) as any;
    if (!invite) return { success: false, error: 'Invalid invite code' };

    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const createdAtTime = new Date(invite.created_at).getTime();
    if (Date.now() - createdAtTime > THIRTY_DAYS_MS) {
        return { success: false, error: 'This invite code has expired (maximum 30 days validation)' };
    }

    // Check if identity is ALREADY a member before "already used" check
    const existingMember = getMember(db, publicKey);
    if (existingMember) {
        return { success: true, member: existingMember, alreadyMember: true };
    }

    // Check intended_for restriction if specified
    if (invite.intended_for) {
        const normIntended = invite.intended_for.toLowerCase().replace(/^@/, '').trim();
        const normCallsign = callsign.toLowerCase().replace(/^@/, '').trim();
        if (normIntended && normCallsign && normIntended !== normCallsign) {
            return { success: false, error: `This invite was issued specifically for @${invite.intended_for.replace(/^@/, '')}` };
        }
    }

    if (invite.used_by) return { success: false, error: 'This invite has already been used' };

    // Register member FIRST — invite_codes.used_by has FK to members(public_key)
    const member = registerMemberInternal(broadcast, publicKey, callsign, invite.created_by, code);
    if (!member) return { success: false, error: 'Registration failed' };

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
    try {
        const verified = verifyOfflineTicket(db, ticketB64);
        if (!verified.ok) return { success: false, error: verified.error };
        const { inviterPubkey, timestamp, intendedFor, codeHash } = verified;

        // Check if identity is ALREADY a member before "already used" check
        const existingMember = getMember(db, joinerPublicKey);
        if (existingMember) {
            return { success: true, member: existingMember, alreadyMember: true };
        }

        // Check intended_for restriction if specified
        if (intendedFor) {
            const normIntended = intendedFor.toLowerCase().replace(/^@/, '').trim();
            const normCallsign = callsign.toLowerCase().replace(/^@/, '').trim();
            if (normIntended && normCallsign && normIntended !== normCallsign) {
                return { success: false, error: `This offline ticket was issued specifically for @${intendedFor.replace(/^@/, '')}` };
            }
        }

        const existingInvite = db.prepare("SELECT * FROM invite_codes WHERE code COLLATE NOCASE = ?").get(codeHash) as any;
        if (existingInvite) {
            if (existingInvite.used_by) return { success: false, error: 'This exact mathematical offline ticket has already been redeemed' };
        } else {
            const createdAt = new Date(timestamp).toISOString();
            db.prepare(`INSERT INTO invite_codes (code, created_by, created_at, intended_for) VALUES (?, ?, ?, ?)`).run(codeHash, inviterPubkey, createdAt, intendedFor || null);
        }

        recordActivity(inviterPubkey);

        const member = registerMemberInternal(broadcast, joinerPublicKey, callsign, inviterPubkey, codeHash);
        if (!member) return { success: false, error: 'Registration failed during state sync' };

        db.prepare("UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code COLLATE NOCASE = ?").run(joinerPublicKey, new Date().toISOString(), codeHash);

        return { success: true, member };
    } catch (e) {
        return { success: false, error: 'Malformed or broken offline ticket payload' };
    }
}
