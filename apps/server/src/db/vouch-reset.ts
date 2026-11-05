/**
 * The vouching reset (slice R0, scratch/fable-design/DESIGN-invites-and-names-list-amend2-fable.md §1; Marty, 5 Nov
 * 2026: "reset them to off and then we are free to reset all the code behind that also"). The old vouch model,
 * members.can_vouch, members.vouch_credit, members.elder_vouched_by and invite_codes.vouch_level, is turned off on every
 * row and its four columns dropped at the first boot of this release, after counting what it touches. The counts live
 * here alone, so the boot (db.ts initSchema) and the script an operator runs on each node before the deploy
 * (vouch-reset-measure.ts) read exactly the same thing.
 *
 * The counts, numbers only, never a name or a key:
 *   A  members holding the old appointed-voucher switch (can_vouch = 1);
 *   B  members carrying a vouch (elder_vouched_by set: the vouch term of their credit line);
 *   C  invites carrying a vouch, unused and still within their 30 days (engine/invites.ts redeemInvite);
 *   D  invites redeemed with a vouch;
 *   E  people (not enterprises) whose stored balance is below zero;
 *   F  the harm count: people carrying a vouch whose stored balance is below the line they keep without it;
 *   G  Decisions that would still give or take away vouching (grant_voucher / revoke_voucher, not yet ended).
 * F or G above zero and the reset refuses, before it writes anything: the boot stops, and the previous release boots the
 * same data untouched.
 *
 * Balances are the stored column (accounts.balance), never getBalance: at boot the ledger isn't loaded, and a read through
 * it charges demurrage before the treasuries are exempt (memory boot-getbalance-before-exemptions). The line someone keeps
 * without the vouch is the engine's own (getMemberTrustProfile, SQL only, which has no vouch term any more). An
 * enterprise's line never had one (its keepers' pledges), so F counts people only.
 *
 * Nothing here calls a function registered on a connection (memory no-connection-functions-in-file-schema), and the
 * reset writes no Bean: no accounts row, no transfer, no conservingTransaction (ledger-transaction-rules).
 */

import type Database from 'better-sqlite3';
import { getMemberTrustProfile } from '@beanpool/engine';

/** The three columns of members the reset drops, in the order it drops them. */
export const OLD_VOUCH_MEMBER_COLUMNS = ['can_vouch', 'vouch_credit', 'elder_vouched_by'] as const;
/** The column of invite_codes it drops. */
export const OLD_VOUCH_INVITE_COLUMN = 'vouch_level';
/** An invite admits for 30 days from its making (engine/invites.ts redeemInvite). */
const INVITE_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
/** A Decision that can still carry out its effect: every status but the ended ones (decisions-engine.ts DecisionStatus). */
const STILL_LIVE = `status IN ('open', 'passed', 'passed_queued_for_funds', 'execution_pending_grace', 'execution_blocked')`;

export interface VouchResetCounts {
    /** A: members with can_vouch = 1. */
    appointedVouchers: number;
    /** B: members with a vouch (elder_vouched_by set). */
    vouchedMembers: number;
    /** C: invites with a vouch, unused and in date. */
    vouchedInvitesOpen: number;
    /** D: invites redeemed with a vouch. */
    vouchedInvitesRedeemed: number;
    /** E: people whose stored balance is below zero. */
    belowZero: number;
    /** F: people with a vouch whose stored balance is below the line they keep without it. */
    wouldLoseCredit: number;
    /** G: Decisions still able to give or take away vouching. */
    openVoucherDecisions: number;
}

/** What the reset did: the counts it read first, and the rows it changed. */
export interface VouchResetReport {
    counts: VouchResetCounts;
    /** Members rows the UPDATE turned off (every row with a vouch or the switch). */
    membersReset: number;
    /** Unused invites with a vouch deleted (a promise of a vouch it would no longer keep: never false success). */
    invitesDeleted: number;
}

/** The refusal: F or G above zero. Thrown before any write; its message is the operator's sentence. */
export class VouchResetRefused extends Error {
    readonly counts: VouchResetCounts;
    constructor(counts: VouchResetCounts) {
        super(refusalSentence(counts));
        this.name = 'VouchResetRefused';
        this.counts = counts;
    }
}

export function refusalSentence(c: VouchResetCounts): string {
    return `The vouching reset stopped before writing anything: ${c.wouldLoseCredit} member(s) with a vouch owe more than `
        + `the credit line they keep without it (F), and ${c.openVoucherDecisions} Decision(s) could still give or take away `
        + `vouching (G). Nothing was changed: the previous release boots this data untouched. Settle these first `
        + `(apps/server/src/vouch-reset-measure.ts counts them), then deploy again.`;
}

function columnsOf(db: Database.Database, table: string): Set<string> {
    return new Set((db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map((c) => c.name));
}

/** The old columns still here: the members ones, and whether invite_codes still has vouch_level. Nothing to do when none. */
export function oldVouchColumns(db: Database.Database): { members: string[]; inviteLevel: boolean } {
    const members = columnsOf(db, 'members');
    return {
        members: OLD_VOUCH_MEMBER_COLUMNS.filter((c) => members.has(c)),
        inviteLevel: columnsOf(db, 'invite_codes').has(OLD_VOUCH_INVITE_COLUMN),
    };
}

function count(db: Database.Database, sql: string): number {
    return (db.prepare(sql).get() as { n: number }).n;
}

/**
 * A to G, read-only. A column or table this database doesn't have counts 0 (a node already reset reads all zeros; an
 * older shape reads what it has). F asks the engine for a line only for someone with a vouch whose stored balance is
 * below zero: a balance at or above zero is below no line.
 */
export function countVouchReset(db: Database.Database): VouchResetCounts {
    const members = columnsOf(db, 'members');
    const invites = columnsOf(db, 'invite_codes');
    const hasAccounts = columnsOf(db, 'accounts').has('balance');
    const decisions = columnsOf(db, 'decisions');
    const vouchedSql = members.has('elder_vouched_by') ? 'm.elder_vouched_by IS NOT NULL' : '0';
    const person = members.has('is_treasury') ? 'COALESCE(m.is_treasury, 0) = 0' : '1';

    let vouchedInvitesOpen = 0;
    if (invites.has(OLD_VOUCH_INVITE_COLUMN)) {
        const now = Date.now();
        const open = db.prepare(`SELECT created_at FROM invite_codes WHERE ${OLD_VOUCH_INVITE_COLUMN} IS NOT NULL AND used_by IS NULL`).all() as { created_at: string | null }[];
        // In date as the redeem reads it: made no more than 30 days ago.
        vouchedInvitesOpen = open.filter((r) => now - new Date(r.created_at ?? 0).getTime() <= INVITE_LIFE_MS).length;
    }

    let wouldLoseCredit = 0;
    if (hasAccounts && members.has('elder_vouched_by')) {
        const owing = db.prepare(`
            SELECT m.public_key AS pk, a.balance AS balance
              FROM members m JOIN accounts a ON a.public_key = m.public_key
             WHERE ${vouchedSql} AND ${person} AND a.balance < 0`).all() as { pk: string; balance: number }[];
        for (const o of owing) {
            // The engine's line, with no vouch term: what this member keeps after the reset.
            const { floor } = getMemberTrustProfile(db, o.pk);
            if (o.balance < floor) wouldLoseCredit++;
        }
    }

    return {
        appointedVouchers: members.has('can_vouch') ? count(db, 'SELECT COUNT(*) AS n FROM members WHERE can_vouch = 1') : 0,
        vouchedMembers: members.has('elder_vouched_by') ? count(db, `SELECT COUNT(*) AS n FROM members m WHERE ${vouchedSql}`) : 0,
        vouchedInvitesOpen,
        vouchedInvitesRedeemed: invites.has(OLD_VOUCH_INVITE_COLUMN)
            ? count(db, `SELECT COUNT(*) AS n FROM invite_codes WHERE ${OLD_VOUCH_INVITE_COLUMN} IS NOT NULL AND used_by IS NOT NULL`) : 0,
        belowZero: hasAccounts
            ? count(db, `SELECT COUNT(*) AS n FROM members m JOIN accounts a ON a.public_key = m.public_key WHERE ${person} AND a.balance < 0`) : 0,
        wouldLoseCredit,
        openVoucherDecisions: decisions.has('effect') && decisions.has('status')
            ? count(db, `SELECT COUNT(*) AS n FROM decisions WHERE effect IN ('grant_voucher', 'revoke_voucher') AND ${STILL_LIVE}`) : 0,
    };
}

/**
 * The reset, at boot (db.ts initSchema, where members_touch_updated_at is dropped, before schema.sql runs): nothing to do
 * on a database without the old columns (a fresh install, or one already reset), so null. Otherwise A to G first; F or G
 * above zero throws VouchResetRefused before any write. Then one transaction: every row's switch and vouch off, the
 * unused invites with a vouch deleted (`deleteInvites`, which the caller gives so a main server's deletes carry
 * tombstones to its standbys), and the four columns dropped. Its log line and the owners' alert come after the boot
 * (state-engine.ts initStateEngine), from the report this returns.
 */
export function resetVouching(db: Database.Database, deleteInvites: (where: string) => number): VouchResetReport | null {
    const old = oldVouchColumns(db);
    if (old.members.length === 0 && !old.inviteLevel) return null;
    const counts = countVouchReset(db);
    if (counts.wouldLoseCredit > 0 || counts.openVoucherDecisions > 0) throw new VouchResetRefused(counts);
    let membersReset = 0;
    let invitesDeleted = 0;
    db.transaction(() => {
        const sets: string[] = [];
        const touched: string[] = [];
        if (old.members.includes('can_vouch')) { sets.push('can_vouch = 0'); touched.push('can_vouch <> 0'); }
        if (old.members.includes('vouch_credit')) { sets.push('vouch_credit = 0'); touched.push('vouch_credit <> 0'); }
        if (old.members.includes('elder_vouched_by')) { sets.push('elder_vouched_by = NULL'); touched.push('elder_vouched_by IS NOT NULL'); }
        if (sets.length > 0) membersReset = db.prepare(`UPDATE members SET ${sets.join(', ')} WHERE ${touched.join(' OR ')}`).run().changes;
        if (old.inviteLevel) invitesDeleted = deleteInvites(`${OLD_VOUCH_INVITE_COLUMN} IS NOT NULL AND used_by IS NULL`);
        for (const c of old.members) db.exec(`ALTER TABLE members DROP COLUMN ${c}`);
        if (old.inviteLevel) db.exec(`ALTER TABLE invite_codes DROP COLUMN ${OLD_VOUCH_INVITE_COLUMN}`);
    })();
    return { counts, membersReset, invitesDeleted };
}

/** The counts as one line, numbers only: the boot's log line and alert, and the measure script's output. */
export function countsLine(c: VouchResetCounts): string {
    return `A appointed vouchers ${c.appointedVouchers} · B vouched members ${c.vouchedMembers} · C vouched invites unused ${c.vouchedInvitesOpen}`
        + ` · D vouched invites redeemed ${c.vouchedInvitesRedeemed} · E below zero ${c.belowZero} · F would lose credit ${c.wouldLoseCredit}`
        + ` · G open voucher Decisions ${c.openVoucherDecisions}`;
}
