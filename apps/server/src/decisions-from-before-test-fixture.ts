/**
 * A community removal of a node owner or admin, as a node running the code from before 2026-10-01 could hold one.
 *
 * Since then no Decision may remove or suspend an owner or admin (docs/the-commons.md §3.8; decisions-engine
 * NODE_OPERATOR_EFFECTS, from FABLE-sec-roles' LOW): proposing one is refused, and one whose subject has come to hold the
 * role is blocked before it is carried out, so no removal of one reaches its grace window any more. One that did on a
 * node that ran the older code can still be there, and the guards that answer for it — the owner-only halt and
 * accelerate, a held role handed from an emergency suspension to the removal — stay tested through this fixture rather
 * than through a proposal that can no longer be made. It writes exactly what the older executeDecision wrote.
 */
import crypto from 'node:crypto';
import { db } from './db/db.js';
import { setUserStatusRow } from './state-engine.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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
