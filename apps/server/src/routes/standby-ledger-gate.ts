/**
 * On a standby, the routes that move Beans or step a trade answer 409 `standby` before any handler runs, and so do the
 * routes that write in-flight money and governance or members' devices and conveniences (STANDBY_WRITE_ROUTES).
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
import { getNodeRole, STANDBY_CODE, STANDBY_LEDGER_MESSAGE, STANDBY_WRITE_MESSAGE } from '../config/node-role.js';

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

/**
 * The routes that write the plain tables (engine/replication-manifest.ts, design G3, G4): their
 * rows are the main server's, and a standby writes none of its own (config/node-role.ts assertPlainTablesWritable, which
 * the writers under these call too). Decisions and their ballots are above, with the Beans they can move.
 */
export const STANDBY_WRITE_ROUTES: readonly RegExp[] = [
    // An invite made, redeemed (a paper ticket's too), or made by answering a request to join with one.
    /^\/api\/invite\/(generate|redeem|redeem-offline)\/?$/,
    /^\/api\/admin\/seed-invite\/?$/,
    /^\/api\/join\/knocks\/[^/]+\/approve\/?$/,
    // An enterprise's keepers: a request to join and its answer, a removal and an objection to one, a step-down; and a
    // vote for a new lead.
    /^\/api\/(treasury|enterprise)\/[^/]+\/keepers\/(request|requests\/[^/]+\/(approve|decline)|[^/]+\/remove|changes\/[^/]+\/object|step-down)\/?$/,
    /^\/api\/(treasury|enterprise)\/[^/]+\/succession\/(propose|[^/]+\/vote)\/?$/,
    // A vote for a group's new convenor.
    /^\/api\/groups\/[^/]+\/succession\/(propose|[^/]+\/vote)\/?$/,
    // An admin's emergency suspension and its lift (a Decision, and the role it holds aside), and a replacement phone's code.
    /^\/api\/local\/admin\/users\/[^/]+\/(suspend|status)\/?$/,
    /^\/api\/local\/admin\/members\/[^/]+\/rekey\/issue-code\/?$/,
    // A recovery fragment released: the log of which fragments left the community.
    /^\/api\/recovery\/collect\/(hub|sso)\/?$/,
    // A link's commissioning ceiling.
    /^\/api\/local\/federation\/links\/ceiling\/?$/,
    // Members' devices and conveniences (design G4): a phone registered or removed, a leave statement, a chat muted or
    // unmuted, and the pricing guide's items, prices and reports. A keeper's read mark on an enterprise thread is refused
    // by its route's engine call (the same route marks group chats read, conversation_participants).
    /^\/api\/push-tokens(\/leave\/[^/]+)?\/?$/,
    /^\/api\/messages\/mute\/?$/,
    /^\/api\/pricing-guide\/(report|reports\/[^/]+\/status|admin\/(item(\/[^/]+)?|pin|reset|aggregate))\/?$/,
];

/** What a standby answers this request here: a write to a route above, refused with its message; null when it goes on. */
export function standbyRefusal(path: string, method: string): string | null {
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
    if (STANDBY_LEDGER_ROUTES.some((re) => re.test(path))) return STANDBY_LEDGER_MESSAGE;
    if (STANDBY_WRITE_ROUTES.some((re) => re.test(path))) return STANDBY_WRITE_MESSAGE;
    return null;
}

/** Would a standby refuse this request here: a write to a route that moves Beans, steps a trade, or writes a plain table. */
export function standbyRefuses(path: string, method: string): boolean {
    return standbyRefusal(path, method) !== null;
}

/** Koa middleware: on a standby, 409 `standby` for such a request. Mounted before the route modules (https-server.ts). */
export async function standbyLedgerGate(ctx: Context, next: Next): Promise<void> {
    const refusal = getNodeRole() === 'backup' ? standbyRefusal(ctx.path, ctx.method.toUpperCase()) : null;
    if (refusal === null) return next();
    ctx.status = 409;
    ctx.body = { error: refusal, code: STANDBY_CODE };
}
