// Pledges to a project that ended short of its goal, back to their backers a week after its end date (Marty, board,
// 27 Oct 2026: "Return them a week after the end date", unless the leader moves the date in that week; backers are told
// either way).
//
// WHY. An unfunded project's pledges stayed in its escrow after its end date until its leader cancelled it (db.ts
// deleteCrowdfundProject) or moved the date, so a leader who walked away left the backers' Beans held for good.
//
// WHICH. A project still ACTIVE (it never reached its goal: the pledge that reaches it marks it FUNDED and sweeps the escrow
// to the enterprise, db.ts pledgeToProject) whose escrow holds more than dust, once its end date is a week gone: core's
// isPledgeReturnDue, the deadline's instant + 7 days. That is #2500's day rule: a deadline is a day starting at its instant,
// over a day later, when pledges stop (isPastDeadline); the return falls at the start of the end date + 7, the day both apps'
// project page names. The end date is the one pledgeToProject reads: the project's row's, else its enterprise's. A node that
// was off on the day returns them at its first tick after it. An enterprise winding up or paused changes nothing: the Beans
// are the backers'. One whose rows say it reached its goal (its raised figure, or its enterprise's status) is left alone.
//
// WHO GETS WHAT. Exactly what the stranded-pledges return works out (engine/stranded-pledges.ts attributeProjectEscrow): the
// escrow's own history, replayed; each backer is owed the sum of their own pledges since it last stood at 0. Any doubt (a
// history that does not add up, a Bean in it that is not a member's pledge, a backer who can't be paid here) leaves that
// project exactly as it is, with a log line once a process for the operator, and every one of its backers waits: all or
// nothing, as there.
//
// HOW. As the stranded return does: transfer() from the escrow to each backer (the escrow floor, fee-exempt, the backer's
// demurrage settled before the credit), all of a project's payments inside ONE conservingTransaction, each row stamped with
// the project, its raised figure lowered by what went back. The leader's cancel (db.ts deleteCrowdfundProject) sends the
// same pledges back to the same backers, but by raw balance SQL and a resync before it deletes the project, which the ledger
// rules keep out of anything new; and this keeps the project, whose page says what happened. Every decision is made before
// the transaction opens (guards outside, mutation inside); inside it only a transfer the ledger refuses can throw, and that
// unwinds the whole project.
//
// ONCE. The escrow empties in the commit that pays the backers, so the project is not found again. A crash before the commit
// leaves nothing moved, and the next tick (or the next boot's) returns it all. Never on a standby (its ledger is its main
// server's, and the main server's return reaches it with the next copy), nor where this node's Beans are switched off. The
// project stays ACTIVE, so its leader can still cancel it, or move its date and take pledges again: the cancel refunds only
// the pledges its escrow still holds (db.ts HELD_PLEDGES_SQL), never one that went back here.
//
// TOLD. Each backer and the leader. Their copies are kept (engine/kept-notices.ts) in the same transaction as the money, so
// the web app shows them at its next open and the phone's background sync posts them, whatever happens after the commit.
// Once committed, each goes live to its member's own sockets with that copy's id, and out as a push of kind community.notice
// on the escrow category ("Held in Trust & System"), whose words are only "Your community has a notice for you". The notices
// name the project; the leader's counts the backers and the Beans and names nobody. The leader's end date moved in that week
// (POST /api/crowdfund/projects/update) tells the backers too (noticeEndDateMoved).

import { DUST_THRESHOLD, isPastDeadline, isPledgeReturnDue, wordsFor, type PushNoticeKind } from '@beanpool/core';
import { db, getCrowdfundProject } from '../db/db.js';
import { getNodeRole } from '../config/node-role.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { keepNotice } from './kept-notices.js';
import {
    attributeProjectEscrow, owedFromProjectEscrow, type StrandedPledgeLedger, type StrandedPledgeReturn, type StrandedProjectEscrow,
} from './stranded-pledges.js';

// The notices are kept in English, as every kept notice is, each sentence marked for the catalogs.
const { t: tr, tn: trn } = wordsFor('en');

/** What the return needs of the node besides the ledger: a member's live notice and the push (state-engine.ts passes its own). */
export interface UnfundedPledgeHooks extends StrandedPledgeLedger {
    broadcast: (event: any, recipients?: string[]) => unknown;
    dispatchPushNotification: (
        targetPubkeys: string[], actorPubkey: string, title: string, body: string, data: Record<string, any>,
        categoryId: 'chat' | 'marketplace' | 'escrow' | 'recovery', kind: PushNoticeKind,
    ) => unknown;
}

/** A project whose pledges are due back, with who is owed what or why nobody can be paid, its end date and its leader. */
export type UnfundedProjectDue = StrandedProjectEscrow & { deadline: string; leader: string | null };

interface ProjectRow {
    id: string;
    title: string | null;
    status: string | null;
    goal_amount: number | null;
    current_amount: number | null;
    creator_pubkey: string | null;
    deadline: string | null;
    enterprise: string;
    enterprise_status: string | null;
    balance: number | null;
}

/** A project's rows as the return reads them: its end date as pledgeToProject reads it (its own row's, else its enterprise's). */
const PROJECT_SQL = `
    SELECT p.id, p.title, p.status, p.goal_amount, p.current_amount, p.creator_pubkey,
           COALESCE(p.deadline_at, m.deadline_at) AS deadline,
           COALESCE(NULLIF(p.enterprise_pubkey, ''), p.id) AS enterprise, m.status AS enterprise_status,
           a.balance
    FROM projects p
    LEFT JOIN members m ON m.public_key = COALESCE(NULLIF(p.enterprise_pubkey, ''), p.id)
    LEFT JOIN accounts a ON a.public_key = 'escrow_' || p.id`;

/** The project's lead keeper (its leader), else the member who made it. */
function leaderOf(projectId: string, creator: string | null): string | null {
    const lead = db.prepare("SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = ? AND role = 'lead' LIMIT 1").get(projectId) as
        { member_pubkey: string } | undefined;
    return lead?.member_pubkey ?? creator ?? null;
}

/** Whether its rows say it reached its goal: in cents, as pledgeToProject decides it, or its enterprise's row says so. */
function readsFunded(p: ProjectRow): boolean {
    const goal = Math.round(Number(p.goal_amount || 0) * 100);
    return goal <= 0 || Math.round(Number(p.current_amount || 0) * 100) >= goal || p.enterprise_status === 'funded';
}

/**
 * Every ACTIVE project whose escrow holds more than dust and whose pledges are due back at `now`, each with who is owed what
 * or why nobody can be paid. Reads only.
 */
export function findUnfundedProjectsDue(now: number = Date.now()): UnfundedProjectDue[] {
    const rows = db.prepare(`${PROJECT_SQL} WHERE p.status = 'ACTIVE' AND a.balance > ? ORDER BY p.id`).all(DUST_THRESHOLD) as ProjectRow[];
    return rows.filter((p) => isPledgeReturnDue(p.deadline, now)).map((p) => {
        const extra = { deadline: p.deadline as string, leader: leaderOf(p.id, p.creator_pubkey) };
        if (readsFunded(p)) {
            return {
                projectId: p.id, title: p.title ?? '', status: p.status ?? '', escrow: `escrow_${p.id}`, held: Number(p.balance), ok: false as const,
                reason: `its rows say it reached its goal (raised ${p.current_amount} of ${p.goal_amount}, its enterprise ${p.enterprise_status}), so nothing goes back`,
                ...extra,
            };
        }
        return { ...attributeProjectEscrow(p.id, p.title ?? '', p.status ?? '', Number(p.balance)), ...extra };
    });
}

/** A project's name as a notice quotes it, cut to a line. */
function named(title: string): string {
    const t = (title || '').trim();
    return t.length > 80 ? `${t.slice(0, 79)}…` : t;
}

/** Beans as a notice writes them: to the cent, no trailing zeros. */
const beans = (n: number) => String(Math.round(n * 100) / 100);

interface Notice { to: string; title: string; body: string; id: string | null }

/** Each project left for the operator, by what was logged for it: once a process, as the tick runs every minute. */
const logged = new Map<string, string>();
let loggedBeansOff = false;

function leaveForOperator(projectId: string, line: string): void {
    if (logged.get(projectId) === line) return;
    logged.set(projectId, line);
    console.error(`[Pledges] LEFT FOR THE OPERATOR: ${line}`);
}

/**
 * Give the backers of every unfunded project whose pledges are due back their Beans, and tell them and its leader. On a main
 * server, from its minute tick (state-engine.ts returnUnfundedProjectPledges). Never throws: a project whose return the
 * ledger refuses is rolled back and logged, and the next is tried.
 */
export function returnUnfundedPledges(hooks: UnfundedPledgeHooks, now: number = Date.now()): { returned: number; left: number } {
    if (getNodeRole() === 'backup') return { returned: 0, left: 0 };
    let due: UnfundedProjectDue[];
    try {
        due = findUnfundedProjectsDue(now);
    } catch (e) {
        console.warn('[Pledges] Could not look for unfunded projects whose pledges are due back:', e);
        return { returned: 0, left: 0 };
    }
    if (due.length === 0) return { returned: 0, left: 0 };
    if (!getProfileSwitches().beans) {
        if (!loggedBeansOff) {
            loggedBeansOff = true;
            console.warn(`[Pledges] ${due.length} unfunded project(s) have pledges due back to their backers; Beans are switched off here, so they stay where they are.`);
        }
        return { returned: 0, left: due.length };
    }

    let returned = 0;
    let left = 0;
    for (const s of due) {
        if (!s.ok) {
            left++;
            leaveForOperator(s.projectId, `${s.escrow} (project ${s.projectId}, ended ${s.deadline}) holds ${s.held} Beans of pledges due back, not returned: ${s.reason}.`);
            continue;
        }
        if (returnOne(hooks, s)) returned++;
        else left++;
    }
    return { returned, left };
}

function returnOne(hooks: UnfundedPledgeHooks, s: UnfundedProjectDue & { ok: true; returns: StrandedPledgeReturn[] }): boolean {
    const project = named(s.title);
    const total = s.returns.reduce((sum, o) => sum + o.amount, 0);
    const memo = `Pledge returned: "${project}" didn't reach its goal by its end date`;
    const data = { kind: 'pledges_returned', enterprise: s.projectId };
    // The leader hears it once, in their own words, whether or not they backed it too.
    const backers = s.returns.map((o) => o.backer).filter((pk) => pk !== s.leader);
    const backerTitle = tr('🫘 Your pledge came back');
    const backerBody = tr('"{project}" didn\'t reach its goal by its end date, so the Beans you pledged to it went back to you.', { project });
    const leaderTitle = tr('🫘 Pledges went back to their backers');
    const leaderBody = trn(s.returns.length,
        '"{project}" didn\'t reach its goal by its end date, so the pledge of its {n} backer went back to them: {amount} Beans.',
        '"{project}" didn\'t reach its goal by its end date, so the pledges of its {n} backers went back to them: {amount} Beans in all.',
        { project, amount: beans(total) });

    let told: Notice[] = [];
    try {
        hooks.conservingTransaction(() => {
            for (const o of s.returns) {
                const txn = hooks.transfer(s.escrow, o.backer, o.amount, memo, 'escrow', true);
                if (!txn) throw new Error(`the ledger refused to return ${o.amount} to a backer`);
                // The row names the project, as the delete path's refunds and the stranded return's do: its history shows it went back.
                db.prepare('UPDATE transactions SET project_id = ? WHERE id = ?').run(s.projectId, txn.id);
            }
            db.prepare('UPDATE projects SET current_amount = MAX(0, current_amount - ?) WHERE id = ?').run(total, s.projectId);
            // Kept with the money: a crash after the commit still leaves every one of them to read.
            told = [
                ...backers.map((to) => ({ to, title: backerTitle, body: backerBody, id: keepNotice(to, backerTitle, backerBody, data) })),
                ...(s.leader ? [{ to: s.leader, title: leaderTitle, body: leaderBody, id: keepNotice(s.leader, leaderTitle, leaderBody, data) }] : []),
            ];
        });
    } catch (e: any) {
        leaveForOperator(s.projectId, `returning the pledges held in ${s.escrow} (project ${s.projectId}) failed and was rolled back: ${e?.message || e}`);
        return false;
    }
    logged.delete(s.projectId);
    console.log(`[Pledges] Returned the pledges held for project ${s.projectId}, which didn't reach its goal by its end date (${s.deadline}): `
        + `${s.returns.length} backer(s), ${beans(total)} Beans.`);
    tell(hooks, told, data);
    try {
        hooks.broadcast({ type: 'project_updated', project: getCrowdfundProject(s.projectId) });
    } catch (e: any) {
        console.warn('[Pledges] Could not announce the project after its return:', e?.message || e);
    }
    return true;
}

/** Live to each member's own sockets, with their kept copy's id, then one push for each wording to all who have it. */
function tell(hooks: Pick<UnfundedPledgeHooks, 'broadcast' | 'dispatchPushNotification'>, notices: Notice[], data: Record<string, unknown>): void {
    for (const n of notices) {
        try {
            hooks.broadcast({ type: 'system_announcement', title: n.title, body: n.body, severity: 'info', ...data, ...(n.id ? { noticeId: n.id } : {}) }, [n.to]);
        } catch (e: any) {
            console.warn('[Pledges] A live notice failed:', e?.message || e);
        }
    }
    const byWords = new Map<string, Notice[]>();
    for (const n of notices) {
        const key = `${n.title}\n${n.body}`;
        byWords.set(key, [...(byWords.get(key) ?? []), n]);
    }
    for (const group of byWords.values()) {
        try {
            hooks.dispatchPushNotification(group.map((n) => n.to), 'SYSTEM', group[0].title, group[0].body, data, 'escrow', 'community.notice');
        } catch (e: any) {
            console.warn('[Pledges] A push failed:', e?.message || e);
        }
    }
}

/** A project's end date as pledgeToProject and the return read it, or null for none: read it before a change to compare after. */
export function projectEndDate(projectId: string): string | null {
    const p = db.prepare(`${PROJECT_SQL} WHERE p.id = ?`).get(projectId) as ProjectRow | undefined;
    return p?.deadline ?? null;
}

/**
 * The leader moved a project's end date (POST /api/crowdfund/projects/update), `before` being the one it had. When that end
 * date was over and its pledges still held, in the week before they would go back, each backer is told, and nothing goes back
 * on the old day: the return reads the new one. Not `actor`, who moved it. Before its end date is over a move is an ordinary
 * edit, and nobody is told. Returns how many it told. Never throws.
 */
export function noticeEndDateMoved(
    hooks: Pick<UnfundedPledgeHooks, 'broadcast' | 'dispatchPushNotification'>, projectId: string, before: string | null, actor: string | null,
    now: number = Date.now(),
): number {
    try {
        if (getNodeRole() === 'backup') return 0;
        const p = db.prepare(`${PROJECT_SQL} WHERE p.id = ?`).get(projectId) as ProjectRow | undefined;
        if (!p || p.status !== 'ACTIVE' || (p.deadline ?? null) === (before ?? null)) return 0;
        if (!isPastDeadline(before, now) || !(Number(p.balance) > DUST_THRESHOLD)) return 0;
        const owed = owedFromProjectEscrow(p.id, p.title ?? '', p.status, Number(p.balance));
        if (!owed.ok) {
            console.warn(`[Pledges] The end date of project ${projectId} moved, but who holds its pledges can't be worked out, so nobody was told: ${owed.reason}.`);
            return 0;
        }
        const project = named(p.title ?? '');
        const title = tr('🫘 A project you backed changed its end date');
        const body = p.deadline
            ? tr('"{project}" didn\'t reach its goal by its end date, and its leader has moved the date. Your pledge stays with it: if the goal isn\'t reached by the new date, your Beans go back to you a week after it.', { project })
            : tr('"{project}" didn\'t reach its goal by its end date, and its leader has taken the end date off. Your pledge stays with it until the goal is reached or the project is cancelled.', { project });
        const data = { kind: 'project_end_date_moved', enterprise: projectId };
        const backers = [...new Set(owed.returns.map((o) => o.backer))].filter((pk) => pk !== actor);
        const told = backers.map((to) => ({ to, title, body, id: keepNotice(to, title, body, data) }));
        tell(hooks, told, data);
        return told.length;
    } catch (e: any) {
        console.warn(`[Pledges] Could not tell the backers of project ${projectId} that its end date moved:`, e?.message || e);
        return 0;
    }
}

/**
 * When the node gave a project's backers their Beans back for its present end date, for its page (GET /api/treasury/:id):
 * the latest row out of its escrow to anyone but its enterprise, at or after that end date. Only this return writes such a
 * row for a project still ACTIVE (one that reached its goal is FUNDED, and the leader's cancel deletes the project). Null
 * when it hasn't, and again once its end date moves on past a return, until the new one has its own.
 */
export function pledgesReturnedAt(projectId: string): string | null {
    const p = db.prepare(`${PROJECT_SQL} WHERE p.id = ?`).get(projectId) as ProjectRow | undefined;
    if (!p || p.status !== 'ACTIVE' || !p.deadline) return null;
    const at = (db.prepare('SELECT MAX(timestamp) AS at FROM transactions WHERE from_pubkey = ? AND project_id = ? AND to_pubkey != ?')
        .get(`escrow_${projectId}`, projectId, p.enterprise) as { at: string | null } | undefined)?.at ?? null;
    if (!at) return null;
    const atMs = Date.parse(at);
    const deadlineMs = Date.parse(p.deadline);
    return Number.isFinite(atMs) && Number.isFinite(deadlineMs) && atMs >= deadlineMs ? at : null;
}
