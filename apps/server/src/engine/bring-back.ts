/**
 * Bring back: an admin gives a member back the SAME key on a new phone, from the member's community copy (vault rethink
 * VR3, community-held placement; scratch/fable-design/DESIGN-vault-rethink-fable.md §4.3 "Getting back in", Marty's
 * picks of 27 Oct). Beside Re-key, which binds a NEW key and moves the member's rows to it (engine/member-wizards.ts).
 *
 * The flow is the re-key's, reused (engine/rekey-redeem.ts): the admin makes a code (its own prefix, BB-, 24 hours, the
 * same guessing brakes); the new phone makes a throwaway key, proposes on the code and shows two digits; the admin types
 * the number on the phone in front of them. Then, where a re-key binds the phone's key, a bring-back binds nothing: the
 * code is marked done for that throwaway key, and that key's own signed poll (GET /api/member/re-enroll/status) is
 * answered with the member's community copy and its key, sealed to it (@beanpool/core sealReleaseToDevice). The phone
 * opens the copy and saves the account only if it makes the member's key the answer names.
 *
 * What it never does: suspend the member, hold their key, move a row, or end a session. The member's account stays
 * exactly as it was; their other phones keep working. In the community-held placement the release is at once, as a
 * re-key is (design §4.3 "Why the hold stays in the shared placement"); the member's phones are told twice, when the code
 * is made (a push of its own kind) and when it is released (`account.restored`), and this server's log names the admin
 * and the time (bring_back_log).
 *
 * Who may: whoever may re-key the member (assertMayRekey): an owner for an owner (the key it gives back opens the
 * community's sealed backups: design §4.3 "Owners", Q8) and, as for a re-key, for an admin. Never the admin's own account.
 */

import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { getLocalConfig } from '../config/local-config.js';
import { logger, sanitizeMessage } from '../logger.js';
import { getMember, dispatchPushNotification } from '../state-engine.js';
import { communityCopyForRelease, sealReleaseToDevice, type SealedShare } from '@beanpool/core';
import { hasCommunityCopy, openCommunityCopy } from './community-copy.js';
import { RecoverySealKeyMissing, RecoverySealUnopenable } from '../services/recovery-seal-key.js';
import { REKEY_CODE_TTL_MS, assertMayRekey, assertNotMisspeltRow, getInvalidatedKeyInfo, type RekeyRequestRow } from './member-wizards.js';

/** The holder type a release is bound to (the AAD of sealReleaseToDevice), beside the code it was released on. */
export const BRING_BACK_HOLDER = 'community';

/** The admin made a bring-back code for someone with no copy here. */
export const BRING_BACK_NO_COPY = 'This member hasn’t turned on “Your community’s admins” here, so there is nothing to bring back. Re-key gives them a new key instead.';
/** issueBringBackCode on the operator's own account. */
export const BRING_BACK_OWN_KEY = 'You can’t bring back your own account. Restore your 12 words on the new phone, or ask another owner.';
/** A re-key code holds the member's key: the two never run at once. */
export const BRING_BACK_REKEY_WAITING = 'This member has a re-key code waiting, which holds their key. Cancel it on Re-key first.';
/** A pasted key is never a bring-back's way: the release goes to the phone whose number the admin typed. */
export const BRING_BACK_NEEDS_NUMBER = 'A bring-back is confirmed by the number on their new phone, never by a pasted key.';
/** The account or its copy went between the code and the number. */
export const BRING_BACK_GONE = 'This member’s account or their copy here is gone, so there is nothing to bring back. Re-key gives them a new key instead.';
/** This server holds the member's copy and can't open it, so it has nothing to release. */
export const BRING_BACK_CANT_OPEN = 'This server can’t open their copy: its recovery-seal key is missing, or isn’t the one the copy was locked with. Re-key gives them a new key instead.';

function refusal(status: number, message: string, code?: string): Error {
    const err: any = new Error(message);
    err.status = status;
    if (code) err.code = code;
    return err;
}

/**
 * The member's copy, opened here and let go at once, before a code is handed out and again before one is spent. A
 * server whose seal key is gone or another one (restored from a backup without data/recovery-seal.key, a standby promoted
 * without it) still has the row; without this the admin was told the member was back, the code was used, and the
 * phone's poll met the seal only then (its 503 reads as "not reachable", so the phone waited out the code's day).
 */
function assertCopyOpens(member: string): void {
    try {
        openCommunityCopy(member);
    } catch (e) {
        if (e instanceof RecoverySealKeyMissing || e instanceof RecoverySealUnopenable) throw refusal(409, BRING_BACK_CANT_OPEN, 'copy_unopenable');
        throw e;
    }
}

const shortKey = (key: string): string => /^[0-9a-f]{64}$/i.test(key) ? `${key.slice(0, 10)}…` : key;

/** BB-XXXX-XXXX: the re-key code's shape with its own prefix, so a phone and an admin can tell the two apart. */
export function generateBringBackCode(): string {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `BB-${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
}

export function isBringBackCode(code: string | null | undefined): boolean {
    return typeof code === 'string' && /^BB-[0-9A-F]{4}-[0-9A-F]{4}$/.test(code);
}

/**
 * The admin's Bring back (POST …/rekey/issue-code with `{ kind: 'bring_back' }`): a code for the member's new phone.
 * Refused for a member with no community copy here, a copy this server can't open (assertCopyOpens), a removed or
 * deleted account, the operator's own account, while a re-key code holds the member's key, to an admin for an owner or
 * admin (assertMayRekey), and for a row a door stored under another spelling (assertNotMisspeltRow, as Re-key's code
 * asks). An earlier bring-back code of the member's stops. Writes the log line (never the code) and pushes the member's
 * phones.
 */
export function issueBringBackCode(memberPublicKey: string, operatorPubkey: string, now = Date.now()):
    { code: string; oldPubkey: string; callsign: string; expiresAt: string; kind: 'bring_back' } {
    assertPlainTablesWritable();
    // Before the key is lower-cased: that row is not the member whose key it is, and lower-cased it would bring them back.
    assertNotMisspeltRow(memberPublicKey);
    const member = (memberPublicKey || '').trim().toLowerCase();
    const operator = (operatorPubkey || '').trim().toLowerCase() || 'owner:password';
    const row = getMember(member);
    if (!row) throw refusal(404, 'Member not found');
    if (row.status === 'pruned') throw refusal(409, BRING_BACK_GONE, 'account_gone');
    assertMayRekey(member, operator, 'bring_back');
    if (operator === member) throw refusal(409, BRING_BACK_OWN_KEY, 'own_key');
    if (getInvalidatedKeyInfo(member)) throw refusal(409, BRING_BACK_REKEY_WAITING, 'rekey_waiting');
    if (!hasCommunityCopy(member)) throw refusal(409, BRING_BACK_NO_COPY, 'no_copy');
    assertCopyOpens(member);

    const at = new Date(now).toISOString();
    const expiresAt = new Date(now + REKEY_CODE_TTL_MS).toISOString();
    const code = generateBringBackCode();
    db.transaction(() => {
        db.prepare("UPDATE rekey_requests SET status = 'cancelled' WHERE old_pubkey = ? AND status = 'pending' AND kind = 'bring_back'").run(member);
        db.prepare(`
            INSERT INTO rekey_requests (code, old_pubkey, operator_pubkey, status, created_at, expires_at, kind)
            VALUES (?, ?, ?, 'pending', ?, ?, 'bring_back')
        `).run(code, member, operator, at, expiresAt);
        // That a code was made, for whom, by whom and when: never the code (FABLE-sec-errors M1), as a re-key's.
        db.prepare(`INSERT INTO system_logs (timestamp, level, category, message, metadata) VALUES (?, 'INFO', 'AUTH', ?, ?)`).run(
            at,
            sanitizeMessage(`Bring-back code issued for member ${row.callsign} (${shortKey(member)}) by operator ${shortKey(operator)}`),
            sanitizeMessage(JSON.stringify({ member: shortKey(member), operator: shortKey(operator), issuedAt: at, expiresAt })),
        );
    })();
    logger.info('AUTH', `[BringBack] Code issued for ${row.callsign} (${shortKey(member)}) by ${shortKey(operator)}, valid until ${expiresAt}`);

    // The member's phones hear it: someone getting the account back without them is seen while the code still waits.
    // The words are fixed by the kind (push-notice.ts); the details name no code, no key, no community.
    try {
        dispatchPushNotification([member], operator,
            'Your account is being brought back on a new phone',
            'An admin is bringing your account back on a new phone, from the copy you keep with this community. If you still have this phone and didn’t ask for this, tell an owner now: they can cancel the code.',
            { screen: 'settings', kind: 'bring_back_started' }, 'recovery', 'account.bring-back-started');
    } catch (e) {
        logger.warn('AUTH', `[BringBack] could not tell the member's phones: ${(e as Error)?.message || e}`);
    }
    return { code, oldPubkey: member, callsign: row.callsign, expiresAt, kind: 'bring_back' };
}

/**
 * The admin typed the number on the member's new phone (engine/rekey-redeem.ts bindRekeyByMatch found the waiting
 * phone): the code is done for that phone's throwaway key, which may now collect the release (bringBackRelease). Binds
 * nothing and moves nothing. Writes the log row and tells the member's phones. Refused, with the code still waiting,
 * when the account or its copy is gone or this server can't open the copy (assertCopyOpens).
 */
export function confirmBringBack(req: RekeyRequestRow, throwawayKey: string, operatorPubkey: string, now = Date.now()):
    { success: true; broughtBack: true; oldPubkey: string; callsign: string } {
    assertPlainTablesWritable();
    const member = req.old_pubkey;
    const operator = (operatorPubkey || '').trim().toLowerCase() || 'owner:password';
    const row = getMember(member);
    if (!row || row.status === 'pruned' || !hasCommunityCopy(member)) throw refusal(409, BRING_BACK_GONE, 'account_gone');
    // Before the code is spent: refused here, it still waits, and no wrong number is counted.
    assertCopyOpens(member);
    const at = new Date(now).toISOString();
    db.transaction(() => {
        const done = db.prepare("UPDATE rekey_requests SET status = 'completed', new_pubkey = ?, completed_at = ? WHERE id = ? AND status = 'pending'")
            .run(throwawayKey, at, req.id).changes;
        if (done !== 1) throw refusal(409, 'This code is no longer waiting. Make a new one with the member there.', 'no_live_code');
        db.prepare('INSERT INTO bring_back_log (member_pubkey, operator_pubkey, released_to, released_at) VALUES (?, ?, ?, ?)')
            .run(member, operator, shortKey(throwawayKey), at);
        db.prepare(`INSERT INTO system_logs (timestamp, level, category, message, metadata) VALUES (?, 'INFO', 'AUTH', ?, ?)`).run(
            at,
            sanitizeMessage(`Member ${row.callsign} (${shortKey(member)}) brought back to a new phone (${shortKey(throwawayKey)}) by operator ${shortKey(operator)}`),
            sanitizeMessage(JSON.stringify({ member: shortKey(member), operator: shortKey(operator), phone: shortKey(throwawayKey) })),
        );
    })();
    logger.info('AUTH', `[BringBack] ${row.callsign} (${shortKey(member)}) brought back to a new phone (${shortKey(throwawayKey)}) by ${shortKey(operator)}`);
    try {
        dispatchPushNotification([member], operator,
            '🔑 Your account was just brought back',
            'An admin just brought your account back on a new phone, from the copy you keep with this community. If that wasn’t you, tell an owner now: they can move your account to a new key.',
            { screen: 'settings', kind: 'brought_back' }, 'recovery', 'account.restored');
    } catch (e) {
        logger.warn('AUTH', `[BringBack] could not tell the member's phones: ${(e as Error)?.message || e}`);
    }
    return { success: true, broughtBack: true, oldPubkey: member, callsign: row.callsign };
}

export interface BringBackReleased {
    state: 'released';
    callsign: string;
    communityName: string;
    /** The member's key: the phone saves the opened copy only if it makes this key. */
    memberKey: string;
    /** The member's copy and its key, sealed to the asking throwaway key, bound to the code (sealReleaseToDevice). */
    release: SealedShare;
}

/**
 * The answer to the throwaway key a bring-back was confirmed for (its signed poll): the member's community copy and its
 * key, sealed to that key, while the code's day lasts. After that, or with the copy gone, `gone`. Opened from the seal
 * here and sealed to the phone at once; nothing new is kept. Throws RecoverySealKeyMissing or RecoverySealUnopenable
 * (the route answers 503) when this server can't open the copy.
 */
export function bringBackRelease(req: RekeyRequestRow, askingKey: string, now = Date.now()): BringBackReleased | { state: 'gone' } {
    if (req.status !== 'completed' || req.new_pubkey !== askingKey || new Date(req.expires_at).getTime() < now) return { state: 'gone' };
    const member = getMember(req.old_pubkey);
    if (!member || member.status === 'pruned') return { state: 'gone' };
    const copy = openCommunityCopy(req.old_pubkey);
    if (!copy) return { state: 'gone' };
    const release = sealReleaseToDevice(communityCopyForRelease(copy), askingKey, { collectionId: req.code, holderType: BRING_BACK_HOLDER });
    return {
        state: 'released',
        callsign: member.callsign,
        communityName: getLocalConfig().communityName || '',
        memberKey: req.old_pubkey,
        release,
    };
}
