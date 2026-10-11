/**
 * The member's side of a re-key (#1768; design scratch/global-node/DESIGN-rekey-redeem-fable.md §2–§4, decided by Marty
 * 2026-10-11): the replacement phone scans or types the admin's RK- code, and that binds nothing. It registers a
 * PROPOSAL (this key wants this code) and gets two digits to show; the admin TYPES the number on the phone in front of
 * them (`POST …/rekey/complete` with `{ code, match }`), and the node binds the live, undeclined proposal with those
 * digits (bindRekeyByMatch), or the admin declines a phone. The number match of the settings sign-in
 * (settings-signin-pairing.ts confirmPairing): the dashboard never shows the digits, and three wrong numbers stop the
 * code. So a stolen or guessed code buys nothing on its own: a thief's scan only adds a proposal with digits of its
 * own, which the admin never sees on the member's phone (#1783 review B2).
 *
 * - One answer for a code that is unknown, used, expired or cancelled (REKEY_CODE_NOT_VALID): a wrong guess learns
 *   nothing about which codes were ever made. A node-wide ceiling of wrong codes an hour (REKEY_WRONG_CODES), after which
 *   every ask answers 429 for the rest of the hour, with one security line in the log, on top of the auth limiter.
 * - At most REKEY_MAX_PROPOSERS keys may propose on one code, and REKEY_MAX_DECLINES declines stop it taking more.
 * - A key that already has a row here (a member, a visitor, a closed account) is refused: merging that row into the
 *   member is out of scope, and a member re-keying someone else would otherwise move their own account under it.
 * - Every step is resumable: the same key asking again is the same proposal and the same digits; the key the code was
 *   completed with asking again is told it is bound (a lost answer), with the member's name.
 *
 * The rows are a plain table (rekey_proposals), copied to a standby, which writes none of its own.
 */

import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { getLocalConfig } from '../config/local-config.js';
import { logger } from '../logger.js';
import { assertMayRekey, completeRekey, type RekeyRequestRow } from './member-wizards.js';

/** The one sentence for a code that is unknown, used, expired or cancelled. */
export const REKEY_CODE_NOT_VALID = 'That code isn’t valid. Ask the admin for a new one.';
/** A phone that already holds an account here (a member, a visitor or a closed account). */
export const REKEY_KEY_HAS_ACCOUNT = 'This phone already has an account in this community, so it can’t take over another one. Use a phone with no account here, or ask the admin to paste its key instead.';
/** A code that has taken all the phones it will. */
export const REKEY_CODE_FULL = 'This code can’t take any more phones. Ask the admin for a new one.';
/** The node-wide ceiling on wrong codes. */
export const REKEY_TOO_MANY_WRONG = 'Too many wrong codes have been tried here in the last hour. Try again later.';

/** The admin typed digits no phone waiting on the code shows. */
export const REKEY_WRONG_NUMBER = 'No phone waiting on this code shows that number. Check the number on their phone and type it again.';
/** The third wrong number: the code stops. */
export const REKEY_CODE_STOPPED = 'Three wrong numbers were typed, so this code has stopped. Make a new code with the member there.';

export const REKEY_MAX_PROPOSERS = 5;
/** Wrong numbers typed on one code before it stops (settings-signin-pairing's PAIRING_CONFIRM_TRIES). */
export const REKEY_MATCH_TRIES = 3;
export const REKEY_MAX_DECLINES = 3;
export const REKEY_WRONG_CODES = { perHour: 60, windowMs: 3_600_000 } as const;

/** A refusal with its HTTP status and a short machine code. */
export class RekeyRedeemRefusal extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
    }
}

export type RekeyAsk =
    | { state: 'waiting'; match: string; expiresAt: string }
    | { state: 'bound'; callsign: string; communityName: string; linkSignInAgain: boolean }
    | { state: 'declined' };

export type RekeyRedeemStatus =
    | { state: 'waiting'; match: string; expiresAt: string }
    | { state: 'bound'; callsign: string; communityName: string; linkSignInAgain: boolean }
    | { state: 'declined' }
    | { state: 'gone' };

interface ProposalRow { code: string; new_pubkey: string; match: string; proposed_at: string; declined_at: string | null }

// ── the node-wide wrong-code ceiling ─────────────────────────────────────────────────────────────────────────────────

let wrongWindow = { startedAt: 0, count: 0, logged: false };

function wrongCodesFull(now: number): boolean {
    if (now - wrongWindow.startedAt >= REKEY_WRONG_CODES.windowMs) return false;
    return wrongWindow.count >= REKEY_WRONG_CODES.perHour;
}

function noteWrongCode(now: number): void {
    if (now - wrongWindow.startedAt >= REKEY_WRONG_CODES.windowMs) wrongWindow = { startedAt: now, count: 0, logged: false };
    wrongWindow.count++;
    if (wrongWindow.count >= REKEY_WRONG_CODES.perHour && !wrongWindow.logged) {
        wrongWindow.logged = true;
        logger.security('AUTH', `[Rekey] ${wrongWindow.count} wrong re-key codes tried in the last hour: every re-key ask is refused until the hour is up`);
    }
}

/** Tests only: a fresh hour. */
export function resetRekeyWrongCodesForTests(): void {
    wrongWindow = { startedAt: 0, count: 0, logged: false };
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A code as the admin's screen shows it, whatever case or spaces the phone typed. */
export function cleanRekeyCode(code: unknown): string {
    return typeof code === 'string' ? code.trim().toUpperCase().replace(/\s+/g, '') : '';
}

const shortKey = (key: string): string => `${key.slice(0, 10)}…`;

function requestByCode(code: string): RekeyRequestRow | undefined {
    if (!code) return undefined;
    return db.prepare('SELECT * FROM rekey_requests WHERE code = ?').get(code) as RekeyRequestRow | undefined;
}

function isLive(req: RekeyRequestRow | undefined, now: number): req is RekeyRequestRow {
    return !!req && req.status === 'pending' && new Date(req.expires_at).getTime() >= now;
}

/**
 * The bound phone's answer. `linkSignInAgain` only when the move removed sign-in copies of the old key (the count kept in
 * the move's audit row): most members never linked one, and are not told one was removed (#1783 review N5).
 */
function boundAnswer(newKey: string): { state: 'bound'; callsign: string; communityName: string; linkSignInAgain: boolean } {
    const member = db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(newKey) as { callsign: string } | undefined;
    const move = db.prepare('SELECT details FROM rekey_audit_log WHERE new_pubkey = ? ORDER BY id DESC LIMIT 1').get(newKey) as { details: string | null } | undefined;
    let removed = 0;
    try { removed = Number(JSON.parse(move?.details || '{}').signInCopiesRemoved) || 0; } catch { /* an older row: none recorded */ }
    return { state: 'bound', callsign: member?.callsign ?? '', communityName: getLocalConfig().communityName || '', linkSignInAgain: removed > 0 };
}

function proposalOf(code: string, newKey: string): ProposalRow | undefined {
    return db.prepare('SELECT * FROM rekey_proposals WHERE code = ? AND new_pubkey = ?').get(code, newKey) as ProposalRow | undefined;
}

// ── the phone ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The replacement phone's ask (POST /api/member/re-enroll, signed by `newKey`, whose statement the route has checked):
 * a proposal and its digits, the same one again for the same key, or `bound` for the key the code was completed with.
 * Throws {@link RekeyRedeemRefusal}.
 */
export function proposeRekey(rawCode: unknown, newKey: string, now = Date.now()): RekeyAsk {
    if (wrongCodesFull(now)) throw new RekeyRedeemRefusal(429, 'too_many_wrong_codes', REKEY_TOO_MANY_WRONG);
    const code = cleanRekeyCode(rawCode);
    const req = requestByCode(code);

    // A lost answer: the code was completed with this very key, which is the member now.
    if (req?.status === 'completed' && req.new_pubkey === newKey) return boundAnswer(newKey);

    // Any row here: a member (a member re-keying someone else from their own phone), a visitor's row, a closed account.
    // Asked before the code, whatever the code is, so the answer to such a key says nothing about which codes are live.
    if (db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(newKey)
        || db.prepare('SELECT 1 FROM invalidated_keys WHERE public_key = ?').get(newKey)) {
        throw new RekeyRedeemRefusal(409, 'key_has_account', REKEY_KEY_HAS_ACCOUNT);
    }
    if (!isLive(req, now)) {
        noteWrongCode(now);
        throw new RekeyRedeemRefusal(404, 'code_not_valid', REKEY_CODE_NOT_VALID);
    }
    // A code for an account deleted or removed since it was made binds nothing (completeRekey refuses it, REKEY_ACCOUNT_GONE),
    // so no phone waits on it: the same one sentence, and nothing written.
    const account = db.prepare('SELECT status FROM members WHERE public_key = ?').get(req.old_pubkey) as { status: string } | undefined;
    if (!account || account.status === 'pruned') throw new RekeyRedeemRefusal(404, 'code_not_valid', REKEY_CODE_NOT_VALID);
    assertPlainTablesWritable();

    return db.transaction((): RekeyAsk => {
        const mine = proposalOf(code, newKey);
        if (mine?.declined_at) return { state: 'declined' };
        if (mine) return { state: 'waiting', match: mine.match, expiresAt: req.expires_at };

        const all = db.prepare('SELECT match, declined_at FROM rekey_proposals WHERE code = ?').all(code) as { match: string; declined_at: string | null }[];
        const declines = all.filter((p) => p.declined_at).length;
        if (all.length >= REKEY_MAX_PROPOSERS || declines >= REKEY_MAX_DECLINES) {
            throw new RekeyRedeemRefusal(409, 'code_full', REKEY_CODE_FULL);
        }
        const taken = new Set(all.filter((p) => !p.declined_at).map((p) => p.match));
        let match = '';
        do match = String(crypto.randomInt(100)).padStart(2, '0'); while (taken.has(match));
        const at = new Date(now).toISOString();
        db.prepare('INSERT INTO rekey_proposals (code, new_pubkey, match, proposed_at) VALUES (?, ?, ?, ?)').run(code, newKey, match, at);
        // Never the code (FABLE-sec-errors M1): who it is for, and a short prefix of the asking key.
        const member = db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(req.old_pubkey) as { callsign: string } | undefined;
        logger.info('AUTH', `[Rekey] A phone (${shortKey(newKey)}) asked to take over ${member?.callsign ?? 'a member'}'s account; waiting for the admin`);
        return { state: 'waiting', match, expiresAt: req.expires_at };
    })();
}

/**
 * Where the asking key's proposal stands (GET /api/member/re-enroll/status, signed by it): `bound` once the code was
 * completed with it, `declined` once the admin said "not theirs", `waiting` while the code is live, else `gone`. A key
 * that never proposed on the code, a member's included, is told `gone`, so the answer says nothing about the code.
 */
export function rekeyRedeemStatus(rawCode: unknown, key: string, now = Date.now()): RekeyRedeemStatus {
    const code = cleanRekeyCode(rawCode);
    const req = requestByCode(code);
    if (!req) return { state: 'gone' };
    if (req.status === 'completed') return req.new_pubkey === key ? boundAnswer(key) : { state: 'gone' };
    const mine = proposalOf(code, key);
    if (!mine) return { state: 'gone' };
    if (mine.declined_at) return { state: 'declined' };
    return isLive(req, now) ? { state: 'waiting', match: mine.match, expiresAt: req.expires_at } : { state: 'gone' };
}

// ── the admin ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * "Not theirs": the admin declines a phone that asked on the member's live code. Who may make the code may decline
 * (assertMayRekey: an owner for an owner's or admin's). The declined phone's poll answers `declined`; three declines stop
 * the code taking more phones.
 */
export function declineRekeyProposal(oldPublicKey: string, newPublicKey: string, operator: string, now = Date.now()): { declined: true; declines: number } {
    assertPlainTablesWritable();
    const cleanOld = (oldPublicKey || '').trim().toLowerCase();
    const cleanNew = (newPublicKey || '').trim().toLowerCase();
    const cleanOperator = (operator || '').trim().toLowerCase() || 'owner:password';
    const req = db.prepare("SELECT * FROM rekey_requests WHERE old_pubkey = ? AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1")
        .get(cleanOld) as RekeyRequestRow | undefined;
    if (!isLive(req, now)) throw new RekeyRedeemRefusal(404, 'no_live_code', 'This member has no re-key code waiting. Make a new code.');
    assertMayRekey(cleanOld, cleanOperator);
    const at = new Date(now).toISOString();
    const changed = db.prepare('UPDATE rekey_proposals SET declined_at = ? WHERE code = ? AND new_pubkey = ? AND declined_at IS NULL').run(at, req.code, cleanNew).changes;
    if (changed !== 1) throw new RekeyRedeemRefusal(404, 'no_such_phone', 'No phone with that key is waiting on this code.');
    const declines = (db.prepare('SELECT COUNT(*) AS n FROM rekey_proposals WHERE code = ? AND declined_at IS NOT NULL').get(req.code) as { n: number }).n;
    logger.info('AUTH', `[Rekey] A phone (${shortKey(cleanNew)}) declined by ${/^[0-9a-f]{64}$/.test(cleanOperator) ? shortKey(cleanOperator) : cleanOperator}`);
    return { declined: true, declines };
}

/**
 * The admin's bind (POST …/rekey/complete with `{ code, match }`): the number typed is the number on the member's phone,
 * and the node finds the live, undeclined proposal on this code with those digits and binds its key (completeRekey). A
 * number no waiting phone shows is a wrong try, kept on the code's row (wrong_matches); the third stops the code
 * (status 'expired': the member stays held, as a lapsed code leaves them, and a new code is made with them there). Who
 * may make the code may bind it (assertMayRekey), asked before a try is counted. Throws {@link RekeyRedeemRefusal}, or
 * completeRekey's errors.
 */
export function bindRekeyByMatch(oldPublicKey: string, rawCode: unknown, rawMatch: unknown, operator: string, now = Date.now()):
    ReturnType<typeof completeRekey> {
    assertPlainTablesWritable();
    const cleanOld = (oldPublicKey || '').trim().toLowerCase();
    const cleanOperator = (operator || '').trim().toLowerCase() || 'owner:password';
    const code = cleanRekeyCode(rawCode);
    const req = requestByCode(code);
    if (!req || req.old_pubkey !== cleanOld || !isLive(req, now)) {
        throw new RekeyRedeemRefusal(404, 'no_live_code', 'This member has no re-key code waiting. Make a new code.');
    }
    assertMayRekey(cleanOld, cleanOperator);
    const match = typeof rawMatch === 'string' ? rawMatch.trim() : '';
    if (!/^\d{2}$/.test(match)) throw new RekeyRedeemRefusal(400, 'match_required', 'Type the two digits on their phone.');

    const found = db.prepare('SELECT new_pubkey FROM rekey_proposals WHERE code = ? AND match = ? AND declined_at IS NULL').get(code, match) as { new_pubkey: string } | undefined;
    if (found) return completeRekey(cleanOld, found.new_pubkey, code, cleanOperator);

    const tries = db.transaction((): number => {
        db.prepare('UPDATE rekey_requests SET wrong_matches = COALESCE(wrong_matches, 0) + 1 WHERE id = ?').run(req.id);
        const n = (db.prepare('SELECT wrong_matches FROM rekey_requests WHERE id = ?').get(req.id) as { wrong_matches: number }).wrong_matches;
        if (n >= REKEY_MATCH_TRIES) db.prepare("UPDATE rekey_requests SET status = 'expired' WHERE id = ? AND status = 'pending'").run(req.id);
        return n;
    })();
    const who = /^[0-9a-f]{64}$/.test(cleanOperator) ? shortKey(cleanOperator) : cleanOperator;
    if (tries >= REKEY_MATCH_TRIES) {
        const member = db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(cleanOld) as { callsign: string } | undefined;
        logger.security('AUTH', `[Rekey] ${member?.callsign ?? 'A member'}'s re-key code stopped after ${tries} wrong numbers typed by ${who}`);
        throw new RekeyRedeemRefusal(409, 'code_stopped', REKEY_CODE_STOPPED);
    }
    logger.info('AUTH', `[Rekey] A wrong number typed by ${who} (${tries} of ${REKEY_MATCH_TRIES})`);
    const err = new RekeyRedeemRefusal(409, 'wrong_number', REKEY_WRONG_NUMBER);
    (err as RekeyRedeemRefusal & { triesLeft?: number }).triesLeft = REKEY_MATCH_TRIES - tries;
    throw err;
}
