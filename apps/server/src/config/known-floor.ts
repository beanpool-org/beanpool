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
 * the row. A node with Beans off (the global profile) can't turn the dial on.
 */
import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { KNOWN_FLOOR_DEFAULT, CREDIT_CAP_DEFAULT, CREDIT_CAP_MAX } from '@beanpool/core';
import { CONFIRMATION_DIAL_KEY, KNOWN_FLOOR_KEY, CREDIT_CAP_KEY, confirmationDialOn, savedCreditCap, knownFloor, isConfirmed, memberKnownGrant } from '@beanpool/engine';
import { getProfileSwitches } from './node-profile.js';
import { getMember } from '../state-engine.js';
import { clearEnterpriseFloorCache } from '@beanpool/engine';

export class KnownFloorError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = 'KnownFloorError';
    }
}

export interface KnownFloorException { memberPubkey: string; amount: number | null; frozen: boolean; setBy: string; setAt: string }
export interface KnownFloorLogLine { id: string; actor: string; action: string; memberPubkey: string | null; oldValue: string | null; newValue: string | null; at: string }

// Each write names its key (test-replication-manifest reads every node_config write); the default removes the row.
function setDial(on: boolean): void {
    if (!on) db.prepare('DELETE FROM node_config WHERE key = ?').run(CONFIRMATION_DIAL_KEY);
    else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CONFIRMATION_DIAL_KEY, 'on');
}
function setCap(cap: number): void {
    if (cap === CREDIT_CAP_DEFAULT) db.prepare('DELETE FROM node_config WHERE key = ?').run(CREDIT_CAP_KEY);
    else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CREDIT_CAP_KEY, String(cap));
}
function setFloor(floor: number): void {
    if (floor === KNOWN_FLOOR_DEFAULT) db.prepare('DELETE FROM node_config WHERE key = ?').run(KNOWN_FLOOR_KEY);
    else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KNOWN_FLOOR_KEY, String(floor));
}

function log(actor: string, action: string, memberPubkey: string | null, oldValue: unknown, newValue: unknown): void {
    db.prepare('INSERT INTO known_floor_log (id, actor_pubkey, action, member_pubkey, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)')
        .run(crypto.randomBytes(16).toString('hex'), actor, action, memberPubkey,
            oldValue === null || oldValue === undefined ? null : String(oldValue),
            newValue === null || newValue === undefined ? null : String(newValue));
}

function wholeBeans(v: unknown, name: string): number {
    if (!Number.isInteger(v) || (v as number) < 0) throw new KnownFloorError(400, 'bad_amount', `${name} must be a whole number of Beans, 0 or more.`);
    return v as number;
}

export function knownFloorSettings() {
    return {
        confirmation: confirmationDialOn(db),
        knownFloor: knownFloor(db),
        creditCap: savedCreditCap(db),
        knownFloorDefault: KNOWN_FLOOR_DEFAULT,
        creditCapDefault: CREDIT_CAP_DEFAULT,
        creditCapMax: CREDIT_CAP_MAX,
    };
}

/** The owner's change to the dial, the known floor or the cap. Checked whole before anything is written. */
export function setKnownFloorSettings(actor: string, body: { confirmation?: unknown; knownFloor?: unknown; creditCap?: unknown }) {
    const before = knownFloorSettings();
    if (body.confirmation !== undefined && typeof body.confirmation !== 'boolean') {
        throw new KnownFloorError(400, 'bad_confirmation', 'confirmation must be true or false.');
    }
    if (body.confirmation === true && !getProfileSwitches().beans) {
        throw new KnownFloorError(409, 'no_beans', 'This node has no Beans, so it has no known floor to turn on.');
    }
    const cap = body.creditCap === undefined ? before.creditCap : wholeBeans(body.creditCap, 'The cap');
    if (cap < CREDIT_CAP_DEFAULT || cap > CREDIT_CAP_MAX) {
        throw new KnownFloorError(400, 'bad_cap', `The cap is from ${CREDIT_CAP_DEFAULT.toLocaleString('en')} to ${CREDIT_CAP_MAX.toLocaleString('en')} Beans.`);
    }
    const floor = body.knownFloor === undefined ? before.knownFloor : wholeBeans(body.knownFloor, 'The known floor');
    if (floor > cap) {
        throw new KnownFloorError(400, 'floor_above_cap', `The known floor can't be more than the cap (${cap.toLocaleString('en')} Beans).`);
    }
    db.transaction(() => {
        if (body.confirmation !== undefined && body.confirmation !== before.confirmation) {
            setDial(body.confirmation === true);
            log(actor, 'confirmation', null, before.confirmation ? 'on' : 'off', body.confirmation ? 'on' : 'off');
        }
        if (cap !== before.creditCap) {
            setCap(cap);
            log(actor, 'credit_cap', null, before.creditCap, cap);
        }
        if (floor !== before.knownFloor) {
            setFloor(floor);
            log(actor, 'known_floor', null, before.knownFloor, floor);
        }
    })();
    clearEnterpriseFloorCache(db);
    return knownFloorSettings();
}

export function knownFloorExceptions(): KnownFloorException[] {
    return (db.prepare('SELECT member_pubkey, amount, frozen, set_by, set_at FROM known_floor_exceptions ORDER BY set_at DESC').all() as any[])
        .map(r => ({ memberPubkey: r.member_pubkey, amount: r.amount, frozen: r.frozen === 1, setBy: r.set_by, setAt: r.set_at }));
}

export function readKnownFloorLog(limit = 100): KnownFloorLogLine[] {
    return (db.prepare('SELECT * FROM known_floor_log ORDER BY at DESC, rowid DESC LIMIT ?').all(Math.max(1, Math.min(500, limit))) as any[])
        .map(r => ({ id: r.id, actor: r.actor_pubkey, action: r.action, memberPubkey: r.member_pubkey, oldValue: r.old_value, newValue: r.new_value, at: r.at }));
}

/** One member's lines in the log, newest first, each naming who made the change: what every admin reads on their panel. */
export function readKnownFloorLogFor(pk: string, limit = 20) {
    return (db.prepare('SELECT * FROM known_floor_log WHERE member_pubkey = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(pk, Math.max(1, Math.min(100, limit))) as any[])
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
        knownFloor: knownFloor(db),
        creditCap: savedCreditCap(db),
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
 */
export function setKnownFloorException(actor: string, body: { memberPubkey?: unknown; amount?: unknown; frozen?: unknown; clear?: unknown }) {
    const pk = body.memberPubkey;
    if (typeof pk !== 'string' || !pk) throw new KnownFloorError(400, 'bad_member', 'memberPubkey is required.');
    const m = getMember(pk);
    if (!m || m.status !== 'active' || m.isTreasury) throw new KnownFloorError(404, 'not_member', 'Only an active member of this community has a known floor.');
    if (pk === actor) throw new KnownFloorError(403, 'own_floor', 'Another admin or the owner sets your own known floor.');
    const old = db.prepare('SELECT amount, frozen FROM known_floor_exceptions WHERE member_pubkey = ?').get(pk) as { amount: number | null; frozen: number } | undefined;
    const describe = (r: { amount: number | null; frozen: number | boolean } | undefined) =>
        !r ? 'default' : (r.frozen ? 'frozen' : String(r.amount));
    if (body.clear === true) {
        db.transaction(() => {
            db.prepare('DELETE FROM known_floor_exceptions WHERE member_pubkey = ?').run(pk);
            log(actor, 'exception_cleared', pk, describe(old), 'default');
        })();
    } else {
        if (body.frozen !== undefined && typeof body.frozen !== 'boolean') throw new KnownFloorError(400, 'bad_frozen', 'frozen must be true or false.');
        const frozen = body.frozen === true;
        // Unfreezing with no amount goes back to the kept one; with none kept, back to the community's known floor.
        const unfreeze = body.frozen === false && body.amount === undefined;
        if (unfreeze && !old?.frozen) throw new KnownFloorError(409, 'not_frozen', "This member's known floor isn't frozen.");
        let amount: number | null = null;
        if (unfreeze) {
            amount = old!.amount;
        } else if (!frozen) {
            amount = wholeBeans(body.amount, 'The amount');
            const cap = savedCreditCap(db);
            if (amount > cap) throw new KnownFloorError(400, 'above_cap', `A member's known floor can't be more than the cap (${cap.toLocaleString('en')} Beans).`);
        }
        db.transaction(() => {
            if (unfreeze && amount === null) {
                db.prepare('DELETE FROM known_floor_exceptions WHERE member_pubkey = ?').run(pk);
            } else {
                // A freeze leaves the amount as it is (a fresh row's is NULL); anything else writes it.
                db.prepare(`INSERT INTO known_floor_exceptions (member_pubkey, amount, frozen, set_by, set_at) VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                    ON CONFLICT(member_pubkey) DO UPDATE SET amount = CASE WHEN excluded.frozen = 1 THEN amount ELSE excluded.amount END,
                        frozen = excluded.frozen, set_by = excluded.set_by, set_at = excluded.set_at`)
                    .run(pk, amount, frozen ? 1 : 0, actor);
            }
            // A raise above the community's known floor is its own line, so every admin sees it (design §7.3).
            const action = frozen ? 'exception_frozen' : unfreeze ? 'exception_unfrozen' : amount! > knownFloor(db) ? 'exception_raised' : 'exception_lowered';
            log(actor, action, pk, describe(old), frozen ? 'frozen' : amount === null ? 'default' : String(amount));
        })();
    }
    clearEnterpriseFloorCache(db);
    return { memberPubkey: pk, confirmed: isConfirmed(db, pk), exception: knownFloorExceptions().find(e => e.memberPubkey === pk) ?? null };
}
