/**
 * A community removal of a node owner or admin, as a node running the code from before 2026-10-01 could hold one.
 *
 * Since then no Decision may remove or suspend an owner or admin (docs/the-commons.md §3.8; decisions-engine
 * NODE_OPERATOR_EFFECTS, from FABLE-sec-roles' LOW): proposing one is refused, and one whose subject has come to hold the
 * role is blocked before it is carried out, so no removal of one reaches its grace window any more. One that did on a
 * node that ran the older code can still be there, and the guards that answer for it — the owner-only halt and
 * accelerate, a held role handed from an emergency suspension to the removal — stay tested through this fixture rather
 * than through a proposal that can no longer be made. It writes exactly what the older executeDecision wrote.
 *
 * And a removal a member proposed, as a node running the code from before removal by vote S3 could hold one open
 * (removalProposedFromBefore): since then only an admin's pause opens a vote on removing someone.
 */
import crypto from 'node:crypto';
import { db } from './db/db.js';
import { broadcast, setUserStatusRow } from './state-engine.js';
import { getDecision, publicDecision, removalBalanceParams, type Decision } from './decisions-engine.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A vote on removing a member that a member (or an admin) proposed, as a node running the code from before removal by vote
 * S3 could hold one open. Since then a removal vote opens only when an admin pauses the member (decisions-engine
 * pauseMember; Amendment A of scratch/fable-design/DESIGN-removal-by-vote-fable.md, point 1), and proposing one is
 * refused. One open at the upgrade still ends as any Decision does: tallied when it closes, a grace window if it passes,
 * and the member removed at its end. It writes exactly what the older createDecision wrote once its checks passed: the
 * member's name, balance and debt and the pot recorded for its voters, none of the node's pause marks, and the same
 * doorbell. Returns the Decision.
 */
export function removalProposedFromBefore(opts: {
    authorPubkey: string; title: string; description: string; subject: string; params?: Record<string, unknown>; closesAt?: string;
}): Decision {
    const id = crypto.randomUUID();
    const opensAt = new Date().toISOString();
    const closesAt = opts.closesAt || new Date(Date.now() + 7 * DAY_MS).toISOString();
    const params: Record<string, unknown> = { ...opts.params, ...removalBalanceParams(opts.subject, opts.params?.memberName) };
    for (const mark of ['rule', 'pausedBy', 'pausedAt']) delete params[mark];
    db.prepare(`
        INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params,
            franchise, status, opens_at, closes_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'member', 'remove_member', ?, ?, '1m1v', 'open', ?, ?, ?, ?)
    `).run(id, opts.authorPubkey, opts.title, opts.description, opts.subject, JSON.stringify(params), opensAt, closesAt, opensAt, opensAt);
    const decision = getDecision(id)!;
    broadcast({ type: 'decision_created', decision: publicDecision(decision) });
    return decision;
}

/**
 * A removal of `subject` that passed and is in its 7-day grace window, as the older executeDecision left it: the node
 * role they held set aside for this removal (none, when another hold already has it), the member suspended and their
 * credit frozen. Returns its id.
 */
export function removalInGraceFromBefore(authorPubkey: string, subject: string, title: string): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    const at = (ms: number) => new Date(ms).toISOString();
    db.transaction(() => {
        db.prepare(`
            INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, subject, params,
                franchise, status, opens_at, closes_at, grace_period_ends_at, execution_reason, created_at, updated_at)
            VALUES (?, ?, ?, 'Passed before §3.8 was enforced', 'member', 'remove_member', ?, '{}',
                '1m1v', 'execution_pending_grace', ?, ?, ?, 'Member suspended. 7-day grace period active before destructive removal.', ?, ?)
        `).run(id, authorPubkey, title, subject, at(now - 8 * DAY_MS), at(now - DAY_MS), at(now + 7 * DAY_MS),
            at(now - 8 * DAY_MS), at(now));
        db.prepare(`
            INSERT INTO suspended_node_roles (decision_id, member_pubkey, role, granted_at, granted_by, session_epoch, break_glass_hash)
            SELECT ?, member_pubkey, role, granted_at, granted_by, session_epoch, break_glass_hash
            FROM node_roles WHERE member_pubkey = ?
        `).run(id, subject);
        setUserStatusRow(subject, 'disabled');
        db.prepare('UPDATE members SET credit_frozen = 1 WHERE public_key = ?').run(subject);
    })();
    return id;
}
