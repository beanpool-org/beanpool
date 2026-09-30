// Pledges stranded in a project's escrow, returned to their backers at boot (FABLE-sec-money MEDIUM 1, 2026-10-01).
//
// WHY. Until this change `pledgeToProject` (db.ts) took a pledge to a project that had already reached its goal. The
// backer's Beans went into `escrow_<project>`, but only the pledge that REACHES the goal sweeps the escrow into the
// enterprise's account, and nothing else ever drains a project's escrow: delete refuses a project that isn't ACTIVE, the
// hygiene sweep takes only sub-1e-6 dust, and the escrow write-off covers only a NEGATIVE trade escrow. So every later
// pledge sat there for good: the backer had lost it and the project never got it. Pledges now stop at the goal; this
// hands back the ones already stuck.
//
// WHAT IS STRANDED. A project that is not ACTIVE (FUNDED, or any other state, none of which takes a pledge) whose escrow
// holds more than dust. Found with one query (`findStrandedProjectEscrows`), which the boot step and the tests share.
//
// WHO IS OWED WHAT. The escrow's own ledger history, oldest first, is replayed. The last point at which it stood at 0 is
// the sweep that paid the goal to the enterprise (or the start, if it never had one); every pledge after that point is
// still in the escrow. Each backer is owed exactly the sum of their own pledges after it, less anything already sent
// back to them after it. Nothing is estimated and nothing is split pro rata.
//
// WHEN IT STOPS INSTEAD. Any doubt about who is owed what leaves that project's escrow exactly as it is, with a log line
// naming the project and the reason, for the operator: a history that does not add up to what the escrow holds, a Bean
// in it after that zero point that is not a member's pledge to this project, a payment out of it to anyone who did not
// pledge after that point, or a backer who can't be paid here (pruned, re-keyed away, a visitor's row, or a wound-up
// enterprise). A project's return is all or nothing: every backer is paid, or none is.
//
// HOW. Each backer is paid through `transfer()` from the escrow (the ledger's own primitive: the escrow floor, fee-exempt,
// the demurrage window on the backer settled before the credit), all of one project's payments inside ONE
// `conservingTransaction`, with the project's raised figure lowered by what went back. The ledger row of each payment
// names the project and says why in its memo: that is the audit trail, and the boot log names each project and total.
// Every decision is made before the transaction opens (guards outside, mutation inside); inside it, only a transfer the
// ledger itself refuses can throw, and that unwinds the whole project.
//
// ONCE. A project it has emptied reads 0 at the next boot, and a project that isn't ACTIVE takes no new pledge, so there
// is nothing to find again. One it stopped on is looked at again at every boot, and logged again, until the operator
// deals with it. Never on a standby (its ledger is its main server's; the main server's return reaches it with the next
// copy), and not while this node's Beans are switched off (nothing moves then).

import { DUST_THRESHOLD, isSyntheticAccount } from '@beanpool/core';
import { isNodeMember } from '@beanpool/engine';
import { db } from '../db/db.js';
import { getNodeRole } from '../config/node-role.js';
import { getProfileSwitches } from '../config/node-profile.js';

/** What one backer gets back: the sum of their stranded pledges, net of anything already sent back to them. */
export interface StrandedPledgeReturn {
    backer: string;
    amount: number;
    /** The pledge rows (transactions.id) this amount is made of. */
    pledgeIds: string[];
}

interface StrandedBase {
    projectId: string;
    title: string;
    status: string;
    escrow: string;
    /** What the escrow holds now (accounts.balance). */
    held: number;
}

export type StrandedProjectEscrow =
    | (StrandedBase & { ok: true; returns: StrandedPledgeReturn[] })
    | (StrandedBase & { ok: false; reason: string });

interface EscrowRow {
    id: string;
    from_pubkey: string;
    to_pubkey: string;
    amount: number;
    tax_fee: number | null;
    project_id: string | null;
}

/** The ledger's own primitives, passed in: state-engine imports this module, so importing them back would be a cycle. */
export interface StrandedPledgeLedger {
    transfer: (from: string, to: string, amount: number, memo: string, method?: 'direct' | 'escrow', isFeeExempt?: boolean) => { id: string } | null;
    conservingTransaction: <T>(fn: () => T) => T;
}

const near = (a: number, b: number) => Math.abs(a - b) <= DUST_THRESHOLD;

/** Every project that isn't ACTIVE and whose escrow holds more than dust, with who is owed what or why nobody can be. Reads only. */
export function findStrandedProjectEscrows(): StrandedProjectEscrow[] {
    const projects = db.prepare(`
        SELECT p.id, p.title, p.status, a.balance
        FROM projects p
        JOIN accounts a ON a.public_key = 'escrow_' || p.id
        WHERE COALESCE(p.status, '') != 'ACTIVE' AND a.balance > ?
        ORDER BY p.id
    `).all(DUST_THRESHOLD) as { id: string; title: string | null; status: string | null; balance: number }[];
    return projects.map((p) => attribute(p.id, p.title ?? '', p.status ?? '', Number(p.balance)));
}

function attribute(projectId: string, title: string, status: string, held: number): StrandedProjectEscrow {
    const escrow = `escrow_${projectId}`;
    const base: StrandedBase = { projectId, title, status, escrow, held };
    const stop = (reason: string): StrandedProjectEscrow => ({ ...base, ok: false, reason });

    // Oldest first. A pledge and the sweep it triggers share a millisecond, so the row order breaks the tie: the sweep is
    // written after its pledge, in the same transaction (db.ts pledgeToProject).
    const rows = db.prepare(`
        SELECT id, from_pubkey, to_pubkey, amount, tax_fee, project_id
        FROM transactions
        WHERE from_pubkey = ? OR to_pubkey = ?
        ORDER BY timestamp ASC, rowid ASC
    `).all(escrow, escrow) as EscrowRow[];

    let running = 0;
    let lastZero = -1;
    rows.forEach((r, i) => {
        if (r.to_pubkey === escrow) running += Number(r.amount) - Number(r.tax_fee || 0);
        if (r.from_pubkey === escrow) running -= Number(r.amount);
        if (near(running, 0)) lastZero = i;
    });
    if (!near(running, held)) {
        return stop(`its ledger history adds up to ${running}, but the escrow holds ${held}`);
    }

    const owed = new Map<string, StrandedPledgeReturn>();
    for (const r of rows.slice(lastZero + 1)) {
        if (r.to_pubkey === escrow) {
            if (r.project_id !== projectId || isSyntheticAccount(r.from_pubkey)) {
                return stop(`transaction ${r.id} put Beans into it that are not a member's pledge to this project`);
            }
            const o = owed.get(r.from_pubkey) ?? { backer: r.from_pubkey, amount: 0, pledgeIds: [] };
            o.amount += Number(r.amount) - Number(r.tax_fee || 0);
            o.pledgeIds.push(r.id);
            owed.set(r.from_pubkey, o);
        } else {
            const o = owed.get(r.to_pubkey);
            if (!o) return stop(`transaction ${r.id} paid Beans out of it to someone who had not pledged since it last stood at 0`);
            o.amount -= Number(r.amount);
        }
    }

    const returns: StrandedPledgeReturn[] = [];
    for (const o of owed.values()) {
        if (o.amount < -DUST_THRESHOLD) return stop(`more went back to ${o.backer} than they pledged`);
        if (o.amount > DUST_THRESHOLD) returns.push(o);
    }
    const total = returns.reduce((s, o) => s + o.amount, 0);
    if (returns.length === 0 || !near(total, held)) {
        return stop(`the pledges since it last stood at 0 come to ${total}, but it holds ${held}`);
    }

    for (const o of returns) {
        const member = db.prepare('SELECT status FROM members WHERE public_key = ?').get(o.backer) as { status: string | null } | undefined;
        if (!isNodeMember(db, o.backer) || member?.status === 'completed') {
            return stop(`backer ${o.backer} can't be paid here (no member's row, pruned, re-keyed away, or a wound-up enterprise)`);
        }
    }
    return { ...base, ok: true, returns };
}

/**
 * Return every stranded pledge that can be attributed exactly, and log every escrow that can't. At boot, on a main server.
 * Never throws: a project whose return the ledger refuses is rolled back and logged, and the next is tried.
 */
export function returnStrandedPledges(ledger: StrandedPledgeLedger): { returned: number; left: number } {
    if (getNodeRole() === 'backup') return { returned: 0, left: 0 };
    let found: StrandedProjectEscrow[];
    try {
        found = findStrandedProjectEscrows();
    } catch (e) {
        console.warn('[Pledges] Could not look for pledges stranded in a funded project:', e);
        return { returned: 0, left: 0 };
    }
    if (found.length === 0) return { returned: 0, left: 0 };
    if (!getProfileSwitches().beans) {
        console.warn(`[Pledges] ${found.length} project escrow(s) hold pledges made after the goal was reached; Beans are switched off here, so they stay where they are.`);
        return { returned: 0, left: found.length };
    }

    let returned = 0;
    let left = 0;
    for (const s of found) {
        if (!s.ok) {
            left++;
            console.error(`[Pledges] LEFT FOR THE OPERATOR: ${s.escrow} (project "${s.title}", ${s.status}) holds ${s.held} Beans pledged after its goal, not returned: ${s.reason}.`);
            continue;
        }
        const memo = `Pledge returned: "${s.title}" had already reached its goal, so this pledge never reached it`;
        try {
            ledger.conservingTransaction(() => {
                for (const o of s.returns) {
                    const txn = ledger.transfer(s.escrow, o.backer, o.amount, memo, 'escrow', true);
                    if (!txn) throw new Error(`the ledger refused to return ${o.amount} to ${o.backer}`);
                    // The row names the project, as the delete path's refunds do: the project's history shows it went back.
                    db.prepare('UPDATE transactions SET project_id = ? WHERE id = ?').run(s.projectId, txn.id);
                }
                const total = s.returns.reduce((sum, o) => sum + o.amount, 0);
                db.prepare('UPDATE projects SET current_amount = MAX(0, current_amount - ?) WHERE id = ?').run(total, s.projectId);
            });
            returned++;
            const lines = s.returns.map((o) => `${o.amount} to ${o.backer} (${o.pledgeIds.join(', ')})`).join('; ');
            console.log(`[Pledges] Returned the pledges stranded in ${s.escrow} (project "${s.title}", ${s.status}): ${lines}.`);
        } catch (e: any) {
            left++;
            console.error(`[Pledges] LEFT FOR THE OPERATOR: returning the pledges in ${s.escrow} (project "${s.title}") failed and was rolled back: ${e?.message || e}`);
        }
    }
    return { returned, left };
}
