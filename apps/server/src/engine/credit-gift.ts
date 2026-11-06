/**
 * A member gives part of their credit line to another member (slice G1; scratch/fable-design/
 * DESIGN-invites-and-names-list-amend2-fable.md §6, the tracking of §5 pick (a)). The second tab beside Beans on Send.
 *
 * What moves is room (`room_gifts`): credit line someone gave the giver, a voucher's vouch or another member's gift, split
 * and passed on. Never the known floor (the admins' word about the giver), never earned credit (their record), never a
 * Bean. The giver's line shrinks by what they give and the recipient's grows by it, for good (engine trust.ts roomHeldOf).
 *
 * ## The rules, each checked in the gift's own transaction before its first write
 *   - Beans on, on a main server (a standby's plain tables are its main server's).
 *   - The community's setting (`member_gift`, engine/vouchers.ts memberGiftSetting): 0 is off; otherwise a gift is at most
 *     that many Beans (default 100, never above VOUCH_MAX).
 *   - A whole number of Beans, 1 or more.
 *   - The giver: an active member here (not a visitor's row, not an enterprise), whose credit line and known floor aren't
 *     frozen, past their first completed trade (the gate sending Beans has: state-engine.ts transfer, `earnedCredit > 0`).
 *   - Only room someone gave them: at most what they hold of it.
 *   - Only room they aren't using: the line their live offers unlock after the gift still covers what they owe (usable
 *     line ≥ debt, the spending gate's own line: freeRoom), so a gift never pauses their spending.
 *   - The recipient: never the giver, an active member here (not paused, not frozen, not a visitor's row, not an
 *     enterprise), whose line, every source counted, stays within the community's cap with the gift. Checked only once
 *     the giver has passed every rule of theirs, so a key that may give nothing learns nothing about the member it
 *     names; paused and frozen answer alike (`not_receiving`), so a refusal never says which (a freeze is the admins').
 *   - Never back to its root: a piece rooted at the recipient (their vouch, or a gift split from it) can't go to them,
 *     so a voucher can't pool their budget into their own line through accounts they vouched for (#2912's review;
 *     Marty, 6 Nov: "Block it"). The split skips those pieces; if the rest can't cover the amount, the gift is refused.
 *
 * ## The split (§5 pick (a): the voucher's name on every piece)
 * A gift takes the giver's received pieces oldest first and writes one `room_gifts` row per piece it takes from, kind
 * 'gift', with that piece's `root_pubkey` copied and `source_gift_id` naming it. A piece's open part is its amount less
 * what was split from it, so a giver's open parts sum to their room, and room rooted at a voucher is only ever split,
 * never made: Σ room rooted at a voucher stays what their vouches gave, never above their grants and top-ups.
 *
 * ## Ledger rules (memory ledger-transaction-rules)
 * Nothing here is a Bean: no `accounts` row is written, nothing goes through transfer, nothing opens
 * conservingTransaction. One plain db.transaction; its one read of a balance is the giver's own, for their debt.
 */
import crypto from 'node:crypto';
import { word, wordsFor, usableAllowance, offerCapForCount } from '@beanpool/core';
import { db } from '../db/db.js';
import { getMember, isVisitorKey, getBalance, getMemberTrustProfile } from '../state-engine.js';
import { creditCap } from '@beanpool/engine';
import { assertPlainTablesWritable } from '../config/node-role.js';
import { assertBeansOn, getProfileSwitches } from '../config/node-profile.js';
import { memberGiftSetting, type VoucherNotice } from './vouchers.js';
import { keepNotice } from './kept-notices.js';

const { t: tr } = wordsFor('en');

export class CreditGiftError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = 'CreditGiftError';
    }
}

export const CREDIT_GIFT_WORDS = {
    off: word('Giving part of your credit line is off in this community.'),
    badAmount: word('A credit-line gift is a whole number of Beans, 1 or more.'),
    ownGift: word('You can’t give your credit line to yourself.'),
    notMember: word('Only an active member of this community can be given part of a credit line.'),
    enterprise: word('An enterprise can’t be given part of a credit line.'),
    notGiver: word('Only an active member of this community can give part of their credit line.'),
    giverFrozen: word('Your credit line is frozen, so you can’t give part of it until an admin unfreezes it.'),
    noTrade: word('You can give part of your credit line after your first completed trade, as with sending Beans.'),
    // True for someone who never held any and for someone who passed all theirs on (round 2: it said "nobody has given you any").
    noRoom: word('You’ve no credit line left to give: only credit line someone gave you can be passed on. Your known floor and the credit you earned stay yours.'),
    allInUse: word('You’re using the credit line someone gave you, so none of it is free to give now.'),
    noticeTitle: word('Part of a credit line, for you'),
} as const;

const overSetting = (max: number) => tr('You can give up to {max} Beans of your credit line at once here.', { max });
const notEnoughRoom = (room: number, amount: number) => tr('You hold {room} Beans of credit line someone gave you, so you can’t give {amount}.', { room, amount });
const inUse = (free: number) => tr('You’re using part of your credit line, so you can give {free} Beans of it at most now.', { free });
const notReceiving = (name: string) => tr('@{name} can’t be given part of a credit line right now.', { name });
const overCap = (name: string, cap: number) => tr('This gift would take @{name}’s credit line past the most this community allows ({cap} Beans), so it can’t be given.', { name, cap });
const backToRoot = (name: string) => tr('Your credit line came from @{name}, so it can’t be given back to them.', { name });
const partBackToRoot = (name: string, most: number) => tr('Part of your credit line came from @{name} and can’t go back to them, so you can give them {most} Beans at most.', { name, most });
const noticeBody = (name: string, amount: number) => tr('@{name} gave you {amount} Beans of their credit line. It’s yours for good.', { name, amount });

const now = () => new Date().toISOString();
const newId = () => crypto.randomBytes(16).toString('hex');

/** Their credit line frozen by an admin, or their known floor by an exception (as engine/vouchers.ts reads a freeze). */
function isFrozen(pk: string): boolean {
    return !!db.prepare(`SELECT 1 FROM members m WHERE m.public_key = ? AND (COALESCE(m.credit_frozen, 0) = 1
        OR EXISTS (SELECT 1 FROM known_floor_exceptions e WHERE e.member_pubkey = m.public_key AND e.frozen = 1))`).get(pk);
}

/** A piece of room someone gave this member, and the part of it not passed on yet. */
interface Piece { id: string; root: string; open: number }

/** The member's received pieces with an open part, oldest first: what a gift splits, in that order. */
function openPieces(pk: string): Piece[] {
    return (db.prepare(`SELECT g.id AS id, g.root_pubkey AS root,
            g.amount - COALESCE((SELECT SUM(c.amount) FROM room_gifts c WHERE c.source_gift_id = g.id), 0) AS open
        FROM room_gifts g WHERE g.to_pubkey = ? ORDER BY g.at ASC, g.rowid ASC`).all(pk) as Piece[]).filter((p) => p.open > 0);
}

/** The giver's side: what they may give now, and why not, before any recipient is named. */
interface GiverState { setting: number; room: number; free: number; canGive: number; why: string | null; code: string | null }

function giverState(giver: string): GiverState {
    const setting = memberGiftSetting();
    const m = getMember(giver);
    const room = openPieces(giver).reduce((s, p) => s + p.open, 0);
    const state = (canGive: number, free: number, code: string | null, why: string | null): GiverState => ({ setting, room, free, canGive, why, code });
    if (setting <= 0) return state(0, 0, 'gift_off', CREDIT_GIFT_WORDS.off);
    if (!m || m.status !== 'active' || isVisitorKey(giver) || m.isTreasury) return state(0, 0, 'not_giver', CREDIT_GIFT_WORDS.notGiver);
    if (isFrozen(giver)) return state(0, 0, 'frozen', CREDIT_GIFT_WORDS.giverFrozen);
    const p = getMemberTrustProfile(giver);
    if (p.earnedCredit <= 0) return state(0, 0, 'no_trade_yet', CREDIT_GIFT_WORDS.noTrade);
    if (room <= 0) return state(0, 0, 'no_room', CREDIT_GIFT_WORDS.noRoom);
    const free = freeRoom(giver, p, room);
    if (free <= 0) return state(0, 0, 'in_use', CREDIT_GIFT_WORDS.allInUse);
    return state(Math.min(setting, free), free, null, null);
}

/**
 * The room the giver isn't using: the most they may give so that the line their live offers unlock still covers what they
 * owe, so a gift never pauses their spending (DESIGN-invites-and-names-list-fable.md: "so a gift never freezes the giver").
 * The line is the one the spending gate reads (state-engine usableFloor, core usableAllowance), never the whole floor: one
 * live offer unlocks the known grant and the room whole, the offer bands meter earned and granted credit (one offer: 200).
 * With no live offer the line unlocks nothing, so only a giver who owes nothing gives (it changes no spend of theirs).
 * Whole Beans. Round 2 of #2912: the floor counted earned and granted credit past the band, and a gift the tab offered
 * left the giver owing more than their offers unlock, "Spending paused".
 */
function freeRoom(giver: string, p: ReturnType<typeof getMemberTrustProfile>, room: number): number {
    const b = getBalance(giver);
    const debt = Math.max(0, -b.balance);
    const cap = creditCap(db);
    const usableAfter = (g: number) => usableAllowance({ knownGrant: p.knownGrant, roomHeld: p.roomHeld - g, otherAllowance: p.otherAllowance, cap, liveOffers: b.liveOffers });
    const most = b.liveOffers >= 1
        ? Math.floor(p.knownGrant + p.roomHeld + Math.min(p.otherAllowance, offerCapForCount(b.liveOffers)) - debt)
        : (debt > 0 ? 0 : room);
    const free = Math.max(0, Math.min(room, most));
    // Past the cap no part of the room covers anything more: the same line, read whole, must still cover the debt.
    return free > 0 && usableAfter(free) >= debt ? free : 0;
}

/**
 * GET /api/credit/gift: what the signer may give now, for the Credit line tab on Send. `offered`: the tab is shown (Beans
 * on, the setting on, and they hold room someone gave them); `canGive`: the most they may give now; `why`: the sentence
 * a gift would be refused with, when `canGive` is 0. Their own numbers only, never anyone else's.
 */
export function creditGiftOffer(pk: string) {
    const beans = getProfileSwitches().beans;
    const s = beans ? giverState(pk) : { setting: 0, room: 0, canGive: 0, why: null, code: 'profile_no_beans' };
    return {
        offered: beans && s.setting > 0 && s.room > 0 && s.code !== 'not_giver',
        max: s.setting,
        room: s.room,
        canGive: s.canGive,
        why: s.canGive > 0 ? null : s.why,
    };
}

function memberKey(raw: unknown): string {
    const pk = typeof raw === 'string' ? raw.toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(pk)) throw new CreditGiftError(400, 'bad_member', "A member's key is 64 hexadecimal characters.");
    return pk;
}

/** Every rule, in order, with nothing written: the pieces the gift takes, oldest first, and the recipient's name. */
function planGift(giver: string, to: string, amount: unknown): { amount: number; takes: { piece: Piece; take: number }[]; callsign: string } {
    const setting = memberGiftSetting();
    if (setting <= 0) throw new CreditGiftError(403, 'gift_off', CREDIT_GIFT_WORDS.off);
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1) throw new CreditGiftError(400, 'bad_amount', CREDIT_GIFT_WORDS.badAmount);
    if (amount > setting) throw new CreditGiftError(400, 'over_setting', overSetting(setting));
    // The giver first, so a key that may give nothing learns nothing about the member it names.
    const g = giverState(giver);
    if (g.code === 'not_giver') throw new CreditGiftError(403, g.code, g.why!);
    if (g.code === 'frozen') throw new CreditGiftError(409, g.code, g.why!);
    if (g.code === 'no_trade_yet') throw new CreditGiftError(403, g.code, g.why!);
    if (g.code === 'no_room') throw new CreditGiftError(409, g.code, g.why!);
    if (amount > g.room) throw new CreditGiftError(409, 'not_enough_room', notEnoughRoom(g.room, amount));
    if (g.code === 'in_use') throw new CreditGiftError(409, g.code, g.why!);
    if (amount > g.free) throw new CreditGiftError(409, 'in_use', inUse(g.free));
    if (to === giver) throw new CreditGiftError(403, 'own_gift', CREDIT_GIFT_WORDS.ownGift);
    const r = getMember(to);
    if (!r || isVisitorKey(to)) throw new CreditGiftError(404, 'not_member', CREDIT_GIFT_WORDS.notMember);
    if (r.isTreasury) throw new CreditGiftError(409, 'enterprise', CREDIT_GIFT_WORDS.enterprise);
    // Paused or frozen: one sentence and one code for both, so a gift's refusal never says which (a freeze is the admins').
    const paused = r.status === 'disabled' || r.status === 'suspended';
    if (!paused && r.status !== 'active') throw new CreditGiftError(404, 'not_member', CREDIT_GIFT_WORDS.notMember);
    if (paused || isFrozen(to)) throw new CreditGiftError(409, 'not_receiving', notReceiving(r.callsign));
    // The recipient's line, every source counted, within the cap with the gift (their numbers never leave this function).
    const rp = getMemberTrustProfile(to);
    const cap = creditCap(db);
    if (rp.knownGrant + rp.roomHeld + rp.otherAllowance + amount > cap) throw new CreditGiftError(409, 'over_cap', overCap(r.callsign, cap));
    // Never back to its root: pieces rooted at the recipient stay out of the split.
    const pieces = openPieces(giver);
    const away = pieces.filter((p) => p.root !== to);
    if (away.length < pieces.length) {
        const most = away.reduce((s, p) => s + p.open, 0);
        if (most <= 0) throw new CreditGiftError(409, 'back_to_root', backToRoot(r.callsign));
        if (amount > most) throw new CreditGiftError(409, 'back_to_root', partBackToRoot(r.callsign, most));
    }
    // Oldest first, one take per piece, until the amount is covered.
    const takes: { piece: Piece; take: number }[] = [];
    let left = amount;
    for (const piece of away) {
        if (left <= 0) break;
        const take = Math.min(piece.open, left);
        takes.push({ piece, take });
        left -= take;
    }
    // The open parts sum to their room, checked above: never a gift that can't be covered piece by piece.
    if (left !== 0) throw new CreditGiftError(409, 'not_enough_room', notEnoughRoom(g.room, amount));
    return { amount, takes, callsign: r.callsign };
}

/**
 * POST /api/credit/gift `{ memberPubkey, amount }`: the signer gives `amount` Beans of the credit line someone gave them to
 * the member named. Every rule is checked in the gift's own transaction before its first write; then one room_gifts row
 * per piece taken, each with that piece's root, and the recipient's notice kept. `tell` sends the notice live and as a
 * push once the transaction has committed.
 */
export function giveCreditLine(giver: string, body: { memberPubkey?: unknown; amount?: unknown }, tell?: (n: VoucherNotice) => void) {
    assertPlainTablesWritable();
    assertBeansOn();
    const to = memberKey(body.memberPubkey);
    const { notice, rows } = db.transaction(() => {
        const plan = planGift(giver, to, body.amount);
        const at = now();
        const insert = db.prepare(`INSERT INTO room_gifts (id, from_pubkey, to_pubkey, root_pubkey, kind, amount, source_gift_id, at)
            VALUES (?, ?, ?, ?, 'gift', ?, ?, ?)`);
        const written: { id: string; root: string; amount: number; sourceGiftId: string }[] = [];
        for (const { piece, take } of plan.takes) {
            const id = newId();
            insert.run(id, giver, to, piece.root, take, piece.id, at);
            written.push({ id, root: piece.root, amount: take, sourceGiftId: piece.id });
        }
        const giverName = getMember(giver)?.callsign ?? '';
        const title = CREDIT_GIFT_WORDS.noticeTitle;
        const text = noticeBody(giverName, plan.amount);
        const data = { kind: 'credit_gift', amount: plan.amount, from: giver };
        return { notice: { to, title, body: text, data, id: keepNotice(to, title, text, data) } as VoucherNotice, rows: written };
    })();
    tell?.(notice);
    const after = creditGiftOffer(giver);
    return { memberPubkey: to, amount: rows.reduce((s, r) => s + r.amount, 0), pieces: rows.length, room: after.room, canGive: after.canGive };
}
