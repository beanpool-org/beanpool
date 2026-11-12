/**
 * The known floor (community modes slice 4, design §4.2, §4.5, §7.3): the confirmation dial, the community's known floor
 * and cap, and an admin's exception for one member. The formula is @beanpool/core's (knownGrantFor, creditAllowance,
 * usableAllowance); the reads are @beanpool/engine's known-floor.ts. Here: the setters, each written to known_floor_log.
 *
 * Who: the owner sets the dial, the known floor and the cap (Marty's answer 7: "the owner, for now"); an owner or admin
 * sets one member's exception. A raise above the community's known floor goes only up to the cap. Lowering never takes
 * Beans back: a member below their new floor is spend-frozen (getBalance's `frozen`) until they climb back.
 *
 * The three settings are node_config rows (config/community-settings.ts carries them in every copy); the default removes
 * the row. The dial's default is on (Marty, 21 Oct: "Yes, on by default"): the owner switching it off writes 'off', and
 * switching it back on removes the row. With nobody confirmed, on changes nobody's limit. A node with Beans off (the global
 * profile) reads the dial off whatever its row says (engine confirmationDialOn), and its owner can't switch it on.
 */
import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { KNOWN_FLOOR_DEFAULT, CREDIT_CAP_DEFAULT, CREDIT_CAP_MAX, formatHundredths, isHundredths } from '@beanpool/core';
import { CONFIRMATION_DIAL_KEY, KNOWN_FLOOR_KEY, CREDIT_CAP_KEY, confirmationDialOn, confirmationDialSetFrom, savedCreditCap, knownFloor, isConfirmed, memberKnownGrant } from '@beanpool/engine';
import { getProfileSwitches } from './node-profile.js';
import { getMember } from '../state-engine.js';
import { clearEnterpriseFloorCache } from '@beanpool/engine';
import { workOffHoldsFloor } from '../engine/names-debts.js';
import { exceptionNotice, knownGrantNow } from '../engine/credit-notices.js';
import type { TellVoucher, VoucherNotice } from '../engine/vouchers.js';

export class KnownFloorError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = 'KnownFloorError';
    }
}

export interface KnownFloorException { memberPubkey: string; amount_c: number | null; frozen: boolean; setBy: string; setAt: string }
export interface KnownFloorLogLine { id: string; actor: string; action: string; memberPubkey: string | null; oldValue: string | null; newValue: string | null; at: string }

/** The dial as the owner set it (no 'off' row: on), Beans or not: what a change to it is compared with and logged from. */
function dialSet(): boolean {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(CONFIRMATION_DIAL_KEY) as { value: string | null } | undefined;
    return confirmationDialSetFrom(row?.value ?? null);
}

// Each write names its key (test-replication-manifest reads every node_config write); the default removes the row.
function setDial(on: boolean): void {
    if (on) db.prepare('DELETE FROM node_config WHERE key = ?').run(CONFIRMATION_DIAL_KEY);
    else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CONFIRMATION_DIAL_KEY, 'off');
}
function setCap(cap: number): void {
    if (cap === CREDIT_CAP_DEFAULT) db.prepare('DELETE FROM node_config WHERE key = ?').run(CREDIT_CAP_KEY);
    else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CREDIT_CAP_KEY, String(cap));
}
function setFloor(floor: number): void {
    if (floor === KNOWN_FLOOR_DEFAULT) db.prepare('DELETE FROM node_config WHERE key = ?').run(KNOWN_FLOOR_KEY);
    else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KNOWN_FLOOR_KEY, String(floor));
}

function log(actor: string, action: string, memberPubkey: string | null, oldValue: unknown, newValue: unknown, at?: string): void {
    db.prepare(`INSERT INTO known_floor_log (id, actor_pubkey, action, member_pubkey, old_value, new_value, at)
                VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`)
        .run(crypto.randomBytes(16).toString('hex'), actor, action, memberPubkey,
            oldValue === null || oldValue === undefined ? null : String(oldValue),
            newValue === null || newValue === undefined ? null : String(newValue),
            at ?? null);
}

/** A money setting a body carries: whole hundredths of a Bean, 0 or more (the wire's `*_c`), or refused (400). */
function wholeHundredths(v: unknown, name: string): number {
    if (!isHundredths(v) || v < 0) throw new KnownFloorError(400, 'bad_amount', `${name} must be a number of Beans, 0 or more, to the cent.`);
    return v;
}

export function knownFloorSettings() {
    return {
        confirmation: confirmationDialOn(db),
        // Whole hundredths of a Bean, `*_c` (@beanpool/core hundredths.ts).
        knownFloor_c: knownFloor(db),
        creditCap_c: savedCreditCap(db),
        knownFloorDefault_c: KNOWN_FLOOR_DEFAULT,
        creditCapDefault_c: CREDIT_CAP_DEFAULT,
        creditCapMax_c: CREDIT_CAP_MAX,
    };
}

/**
 * A change to the dial, the known floor or the cap, checked whole: what each will be, against what they are. `before`'s
 * `confirmation` is the dial as the node runs it (off without Beans); `confirmationSet` the one the owner set, which a
 * change is compared with (#2415 review r4360287274: compared with the run one, an off sent with Beans off wrote nothing).
 */
export interface KnownFloorPlan {
    before: ReturnType<typeof knownFloorSettings> & { confirmationSet: boolean };
    /** The dial as sent, or undefined where it was left out. */
    confirmation: boolean | undefined;
    floor: number;
    cap: number;
}

/**
 * The owner's change to the dial, the known floor or the cap, checked and nothing written (throws KnownFloorError).
 * `beans`: whether the node will have Beans when it is written: the shape route's change may switch them in the same
 * request (config/community-shape-write.ts), which checks Beans itself; the node's own switches otherwise.
 */
export function checkKnownFloorSettings(body: { confirmation?: unknown; knownFloor_c?: unknown; creditCap_c?: unknown }, beans = getProfileSwitches().beans): KnownFloorPlan {
    const before = { ...knownFloorSettings(), confirmationSet: dialSet() };
    if (body.confirmation !== undefined && typeof body.confirmation !== 'boolean') {
        throw new KnownFloorError(400, 'bad_confirmation', 'confirmation must be true or false.');
    }
    if (body.confirmation === true && !beans) {
        throw new KnownFloorError(409, 'no_beans', 'This node has no Beans, so it has no known floor to turn on.');
    }
    const cap = body.creditCap_c === undefined ? before.creditCap_c : wholeHundredths(body.creditCap_c, 'The cap');
    if (cap < CREDIT_CAP_DEFAULT || cap > CREDIT_CAP_MAX) {
        throw new KnownFloorError(400, 'bad_cap', `The cap is from ${formatHundredths(CREDIT_CAP_DEFAULT, 'en')} to ${formatHundredths(CREDIT_CAP_MAX, 'en')} Beans.`);
    }
    const floor = body.knownFloor_c === undefined ? before.knownFloor_c : wholeHundredths(body.knownFloor_c, 'The known floor');
    if (floor > cap) {
        throw new KnownFloorError(400, 'floor_above_cap', `The known floor can't be more than the cap (${formatHundredths(cap, 'en')} Beans).`);
    }
    return { before, confirmation: body.confirmation as boolean | undefined, floor, cap };
}

/**
 * Writes a checked change, each setting that changed one line in known_floor_log stamped `at` (the shape route stamps
 * its own log's line the same, so the two are read as one change). Inside the caller's transaction where there is one.
 */
export function writeKnownFloorSettings(actor: string, plan: KnownFloorPlan, at?: string): void {
    const { before, confirmation, cap, floor } = plan;
    db.transaction(() => {
        if (confirmation !== undefined && confirmation !== before.confirmationSet) {
            setDial(confirmation);
            log(actor, 'confirmation', null, before.confirmationSet ? 'on' : 'off', confirmation ? 'on' : 'off', at);
        }
        if (cap !== before.creditCap_c) {
            setCap(cap);
            log(actor, 'credit_cap', null, before.creditCap_c, cap, at);
        }
        if (floor !== before.knownFloor_c) {
            setFloor(floor);
            log(actor, 'known_floor', null, before.knownFloor_c, floor, at);
        }
    })();
    clearEnterpriseFloorCache(db);
}

/** The dial, the known floor or the cap, checked whole before anything is written. Settings changes them only through
 *  POST /api/local/admin/community-shape (config/community-shape-write.ts), which logs and tells: this is for a suite's probe. */
export function setKnownFloorSettings(actor: string, body: { confirmation?: unknown; knownFloor_c?: unknown; creditCap_c?: unknown }) {
    writeKnownFloorSettings(actor, checkKnownFloorSettings(body));
    return knownFloorSettings();
}

export function knownFloorExceptions(): KnownFloorException[] {
    return (db.prepare('SELECT member_pubkey, amount_c, frozen, set_by, set_at FROM known_floor_exceptions ORDER BY set_at DESC').all() as any[])
        .map(r => ({ memberPubkey: r.member_pubkey, amount_c: r.amount_c, frozen: r.frozen === 1, setBy: r.set_by, setAt: r.set_at }));
}

export function readKnownFloorLog(limit = 100): KnownFloorLogLine[] {
    return (db.prepare('SELECT * FROM known_floor_log ORDER BY at DESC, rowid DESC LIMIT ?').all(Math.max(1, Math.min(500, limit))) as any[])
        .map(r => ({ id: r.id, actor: r.actor_pubkey, action: r.action, memberPubkey: r.member_pubkey, oldValue: r.old_value, newValue: r.new_value, at: r.at }));
}

/**
 * One member's lines in the log, newest first, each naming who made the change: what every admin reads on their panel.
 * A look at a voucher's card (`voucher_looked`, engine/vouchers.ts) stays in the log but not on this panel: it changes
 * nothing about the member's floor, and a daily look would push real changes out of the panel's window (#2923 review).
 */
export function readKnownFloorLogFor(pk: string, limit = 20) {
    return (db.prepare("SELECT * FROM known_floor_log WHERE member_pubkey = ? AND action <> 'voucher_looked' ORDER BY at DESC, rowid DESC LIMIT ?").all(pk, Math.max(1, Math.min(100, limit))) as any[])
        .map(r => ({ id: r.id, actor: r.actor_pubkey, actorCallsign: getMember(r.actor_pubkey)?.callsign ?? null, action: r.action,
            oldValue: r.old_value, newValue: r.new_value, at: r.at }));
}

/**
 * One member's known-floor line, for the Manager's member screen: whether they are confirmed, their exception, the
 * known grant it comes to (0 with the dial off or unconfirmed), and their lines in the log. Their credit line only, never
 * their balance. `changeRefused` is the refusal the exception route would give this viewer, so the screen says why in
 * place of controls that can't work: 'key_session_only' (the node password or a token), 'own_floor' (their own line),
 * or null.
 */
export function knownFloorForMember(pk: string, viewerKey: string | null = null) {
    const m = getMember(pk);
    if (!m || m.status !== 'active' || m.isTreasury) throw new KnownFloorError(404, 'not_member', 'Only an active member of this community has a known floor.');
    return {
        memberPubkey: pk,
        confirmation: confirmationDialOn(db),
        knownFloor_c: knownFloor(db),
        creditCap_c: savedCreditCap(db),
        confirmed: isConfirmed(db, pk),
        exception: knownFloorExceptions().find(e => e.memberPubkey === pk) ?? null,
        knownGrant: memberKnownGrant(db, pk),
        log: readKnownFloorLogFor(pk),
        changeRefused: !viewerKey ? 'key_session_only' : viewerKey === pk ? 'own_floor' : null,
    };
}

/**
 * An owner's or admin's exception for one member: `amount` (a lower training limit, or higher up to the cap), `frozen`,
 * or `clear` (back to the community's known floor). Only for an active member; an admin can't set their own.
 * A freeze keeps the amount it froze (NULL: the community's known floor) and only sets the flag: their tier reads the kept
 * amount (trust.ts), and `frozen: false` with no amount unfreezes them back to it. `clear` drops both.
 * A change that changes nothing (the same amount again, a freeze of a frozen line, the default where it already is) writes
 * nothing and logs nothing, and answers with the line as it is (#1631 review r4179579785: the panel read "from 250 Beans to
 * 250 Beans"). A live work-off's 0 is not the admin's own 0: setting 0 over it takes it over (workOffHoldsFloor).
 * A change that writes tells the member, a confirmed one with the dial on (engine/credit-notices.ts: the new figure, who
 * changed it, and for a lowering or a freeze that nothing spent is taken back), by `tell` once it has committed; a change
 * that writes nothing tells nothing.
 */
export function setKnownFloorException(actor: string, body: { memberPubkey?: unknown; amount_c?: unknown; frozen?: unknown; clear?: unknown }, tell?: TellVoucher) {
    const pk = body.memberPubkey;
    if (typeof pk !== 'string' || !pk) throw new KnownFloorError(400, 'bad_member', 'memberPubkey is required.');
    const m = getMember(pk);
    if (!m || m.status !== 'active' || m.isTreasury) throw new KnownFloorError(404, 'not_member', 'Only an active member of this community has a known floor.');
    if (pk === actor) throw new KnownFloorError(403, 'own_floor', 'Another admin or the owner sets your own known floor.');
    const old = db.prepare('SELECT amount_c, frozen FROM known_floor_exceptions WHERE member_pubkey = ?').get(pk) as { amount_c: number | null; frozen: number } | undefined;
    const describe = (r: { amount_c: number | null; frozen: number | boolean } | undefined) =>
        !r ? 'default' : (r.frozen ? 'frozen' : String(r.amount_c));
    const line = () => ({ memberPubkey: pk, confirmed: isConfirmed(db, pk), exception: knownFloorExceptions().find(e => e.memberPubkey === pk) ?? null });
    let notice: VoucherNotice | undefined;
    if (body.clear === true) {
        if (!old) return line();
        notice = db.transaction(() => {
            const before = knownGrantNow(pk);
            db.prepare('DELETE FROM known_floor_exceptions WHERE member_pubkey = ?').run(pk);
            log(actor, 'exception_cleared', pk, describe(old), 'default');
            return exceptionNotice(pk, actor, 'cleared', before);
        })();
    } else {
        if (body.frozen !== undefined && typeof body.frozen !== 'boolean') throw new KnownFloorError(400, 'bad_frozen', 'frozen must be true or false.');
        const frozen = body.frozen === true;
        // Unfreezing with no amount goes back to the kept one; with none kept, back to the community's known floor.
        const unfreeze = body.frozen === false && body.amount_c === undefined;
        if (unfreeze && !old?.frozen) throw new KnownFloorError(409, 'not_frozen', "This member's known floor isn't frozen.");
        let amount: number | null = null;
        if (unfreeze) {
            amount = old!.amount_c;
        } else if (!frozen) {
            amount = wholeHundredths(body.amount_c, 'The amount');
            const cap = savedCreditCap(db);
            if (amount > cap) throw new KnownFloorError(400, 'above_cap', `A member's known floor can't be more than the cap (${formatHundredths(cap, 'en')} Beans).`);
        }
        // An unfreeze is always a change (the line was frozen); a freeze keeps the amount, so only the flag is compared.
        if (old && !unfreeze && (frozen ? old.frozen === 1 : old.frozen === 0 && old.amount_c === amount) && !workOffHoldsFloor(pk)) return line();
        notice = db.transaction(() => {
            const before = knownGrantNow(pk);
            if (unfreeze && amount === null) {
                db.prepare('DELETE FROM known_floor_exceptions WHERE member_pubkey = ?').run(pk);
            } else {
                // A freeze leaves the amount as it is (a fresh row's is NULL); anything else writes it.
                db.prepare(`INSERT INTO known_floor_exceptions (member_pubkey, amount_c, frozen, set_by, set_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                    ON CONFLICT(member_pubkey) DO UPDATE SET amount_c = CASE WHEN excluded.frozen = 1 THEN amount_c ELSE excluded.amount_c END,
                        frozen = excluded.frozen, set_by = excluded.set_by, set_at = excluded.set_at`)
                    .run(pk, amount, frozen ? 1 : 0, actor);
            }
            // A raise above the community's known floor is its own line, so every admin sees it (design §7.3).
            const action = frozen ? 'exception_frozen' : unfreeze ? 'exception_unfrozen' : amount! > knownFloor(db) ? 'exception_raised' : 'exception_lowered';
            log(actor, action, pk, describe(old), frozen ? 'frozen' : amount === null ? 'default' : String(amount));
            return exceptionNotice(pk, actor, frozen ? 'frozen' : unfreeze ? 'unfrozen' : 'amount', before);
        })();
    }
    clearEnterpriseFloorCache(db);
    if (notice) tell?.(notice);
    return line();
}
