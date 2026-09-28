/**
 * On a standby, the routes that move Beans or step a trade answer 409 `standby` before any handler runs.
 *
 * A standby makes no Bean move of its own (config/node-role.ts assertLedgerWritable): its ledger is its main server's
 * rows, verbatim, and members use the main server. The ledger primitives refuse underneath whoever calls, so this table
 * is the plain answer, not the guard, as routes/profile-feature-gate.ts is for a switch that is off. It is here so the
 * refusal comes before a handler writes anything else (a trade request's row, a vote), and as one status and code
 * whatever each handler's own catch would make of the engine's throw.
 *
 * Writes only: every read still answers. Not here, on purpose:
 * - `POST /api/local/admin/stranded-escrows/:id/write-off` answers its own 409 `standby` (engine/escrow-write-off.ts).
 * - Routes that write no Bean: a listing, a profile, an enterprise's settings or keepers, a Commons project's proposal.
 *   A zero-balance account row that comes with a new member's or enterprise's row isn't refused (config/node-role.ts).
 *   A keeper's binding or unbinding that would write a pledge (an approval with backing, a step-down, a removal) is
 *   refused by the engine under it (state-engine.ts assertPledgeWritable), and its route answers the same 409.
 */
import type { Context, Next } from 'koa';
import { getNodeRole, STANDBY_CODE, STANDBY_LEDGER_MESSAGE } from '../config/node-role.js';

export const STANDBY_LEDGER_ROUTES: readonly RegExp[] = [
    // A member's send.
    /^\/api\/ledger\/transfer\/?$/,
    // Every step of a trade: buying, asking, approving (the Beans go into escrow), completing or cancelling (they come
    // out), and turning a request down; and an enterprise's, taken by a keeper.
    /^\/api\/marketplace\/posts\/(accept|request)\/?$/,
    /^\/api\/marketplace\/transactions\/(approve|reject|cancel-request|complete|cancel)\/?$/,
    /^\/api\/(treasury|enterprise)\/[^/]+\/(approve|complete|reject)\/?$/,
    // An enterprise's sweep to the Commons, a pledge to it (a crowdfund's moves Beans), and its wind-up's final sweep.
    /^\/api\/(treasury|enterprise)\/[^/]+\/(sweep|pledge|wind-up\/finalise)\/?$/,
    // A keeper's backing pledged or released (every alias, and DELETE .../pledge above): a pledge makes the enterprise's
    // credit floor, and a standby writes none of its own (state-engine.ts assertPledgeWritable).
    /^\/api\/(treasury|enterprise)\/[^/]+\/(backing|release|pledge\/release|backing\/release)\/?$/,
    // A crowdfund pledge, and a crowdfund's delete, which refunds its backers.
    /^\/api\/crowdfund\/projects\/(delete|[^/]+\/pledge)\/?$/,
    // Decisions: a vote can carry one out, and a Decision can grant Beans from the Commons, write them off or remove a
    // member; an admin's halt or accelerate acts on one. The admin's list (POST /api/local/admin/decisions) is a read.
    /^\/api\/commons\/decisions(\/|$)/,
    /^\/api\/local\/admin\/decisions\/[^/]+\/(halt|accelerate)\/?$/,
    // A member's own delete (their balance goes to or comes from the Commons) and a re-key (it moves to the new key),
    // theirs or an operator's, and an operator's offboarding.
    /^\/api\/member\/(purge|re-enroll)\/?$/,
    /^\/api\/local\/admin\/members\/[^/]+\/(offboard|rekey\/complete)\/?$/,
    // An admin's prune, and a post's removal (by itself, in bulk, or from a report), which refunds what its trades hold.
    /^\/api\/local\/admin\/(users|branches)\/[^/]+\/prune\/?$/,
    /^\/api\/local\/admin\/posts\/([^/]+\/delete|bulk-delete)\/?$/,
    /^\/api\/local\/admin\/reports\/[^/]+\/action\/?$/,
    // A ruling on a disputed trade.
    /^\/api\/local\/admin\/disputes\/[^/]+\/resolve\/?$/,
    // Cross-community purchases and commissions.
    /^\/api\/federation\/(purchase|commission)(\/|$)/,
];

/** Would a standby refuse this request here: a write to a route that moves Beans or steps a trade. */
export function standbyRefuses(path: string, method: string): boolean {
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
    return STANDBY_LEDGER_ROUTES.some((re) => re.test(path));
}

/** Koa middleware: on a standby, 409 `standby` for such a request. Mounted before the route modules (https-server.ts). */
export async function standbyLedgerGate(ctx: Context, next: Next): Promise<void> {
    if (getNodeRole() !== 'backup' || !standbyRefuses(ctx.path, ctx.method.toUpperCase())) return next();
    ctx.status = 409;
    ctx.body = { error: STANDBY_LEDGER_MESSAGE, code: STANDBY_CODE };
}
