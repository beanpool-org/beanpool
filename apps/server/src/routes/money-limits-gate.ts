/**
 * Every member route that moves Beans out of an account or starts a deal, whose account it counts against, and what it
 * counts (engine/money-limits.ts; the numbers are config/writer-limits.ts MONEY_LIMITS). One table in front of the
 * handlers, as routes/standby-ledger-gate.ts is, so an alias can't be missed; mounted after the feature and standby gates
 * (https-server.ts), whose 404 and 409 answer first.
 *
 * The account is the signer's own, or the enterprise the PATH names when the signer keeps it (enterpriseActingFor): never a
 * key in the body. A request here is checked, and its acts recorded, before the handler runs, outside any ledger
 * transaction; when the handler then answers 4xx or 5xx (it refused: not a keeper, a bad body, a deal already actioned) the
 * acts are taken back, so only what happened counts. A refused request moves nothing: the handler never runs.
 *
 * What each counts (P payment, with who it pays; R marketplace request; L pledge change):
 *   POST /api/ledger/transfer                               P to `to`                       the sender
 *   POST /api/marketplace/posts/accept                      P to the seller, R              the buyer (a one-step buy of an offer)
 *   POST /api/marketplace/posts/request                     P to the seller on an offer, R  the one asking: on an offer the
 *                                                                                           buyer, whose Beans go into escrow
 *                                                                                           when the seller says yes (the
 *                                                                                           seller's act, which counts nothing
 *                                                                                           of the buyer's); on a need the
 *                                                                                           helper, who is paid, so R only
 *   POST /api/marketplace/transactions/approve              R, and P to the helper on the   the listing's author
 *                                                           author's own need
 *   POST /api/(treasury|enterprise)/:id/approve             R, and P to the helper on its   the enterprise
 *                                                           need
 *   POST /api/(treasury|enterprise)/:id/sweep               P (to the Commons: nobody new)  the enterprise
 *   POST /api/(treasury|enterprise)/:id/pledge              L, and P when it is a crowdfund the member (pledges are a
 *                                                           pledge (pledgeDispatchKind)     member's act)
 *   POST /api/(treasury|enterprise)/:id/backing             L                               the member
 *   POST .../release, .../pledge/release, .../backing/release, DELETE .../pledge, .../backing
 *                                                           L                               the member
 *   POST /api/crowdfund/projects/:id/pledge                 P (into its escrow), L          the member
 *   POST /api/federation/purchase, /api/federation/commission: checked in the route itself, just before the settlement
 *     escrows the Beans (a purchase: the buyer; a commission: the link's enterprise, known only once the route has found
 *     the listing's link), and counted from the settlements row that escrow writes.
 *
 * Not counted, on purpose:
 *   - completing a trade (/api/marketplace/transactions/complete, /api/(treasury|enterprise)/:id/complete): it pays out of
 *     the escrow the buyer's step above already counted, and refusing it would hold back a seller's earned Beans;
 *   - turning a request down or cancelling (reject, cancel-request, cancel): Beans come back, which is receiving;
 *   - a member deleting their own account (/api/member/purge) or moving it to a new key (/api/member/re-enroll), and an
 *     enterprise's wind-up (/api/(treasury|enterprise)/:id/wind-up/finalise): each closes an account once, and is never
 *     put off for a day's count;
 *   - Decisions (/api/commons/decisions): the Commons pays by a community's vote, not an account's act;
 *   - the admin surface (/api/local/admin/*): an operator's act, under its own limiter;
 *   - receiving, anywhere.
 */
import type { Context, Next } from 'koa';
import { canOperateTreasury } from '../state-engine.js';
import { db } from '../db/db.js';
import { getNodeRole } from '../config/node-role.js';
import { admitMoneyActs, assertMoneyActsAllowed, MoneyLimitError, type MoneyAct, type MoneyActHold } from '../engine/money-limits.js';
import { pledgeDispatchKind } from './treasury.js';

type Plan = { account: string; acts: MoneyAct[] } | null;

interface MoneyRoute {
    method: 'POST' | 'DELETE';
    path: RegExp;
    /** The account and its acts, or null when this request counts nothing (the handler refuses it). */
    plan: (actor: string, match: RegExpMatchArray, body: Record<string, unknown>) => Plan;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** A path segment as the router hands it to the handler (decoded), or null when it can't be. */
function segment(raw: string): string | null {
    try { return decodeURIComponent(raw); } catch { return null; }
}

/**
 * The enterprise a signed request acts for by its path (`/api/treasury/:id/…`, `/api/enterprise/:id/…`,
 * `/api/enterprises/:id/…`): a real enterprise, still running (not wound up, pruned, disabled or suspended), that the
 * signer keeps (canOperateTreasury). Null for anything else: a made-up id, another's enterprise, one wound up. What such
 * a request writes is then counted against the signer, as any request of theirs (the gateway's day budget).
 */
export function enterpriseActingFor(actor: string | null | undefined, path: string): string | null {
    if (!actor) return null;
    const m = /^\/api\/(?:treasury|enterprise|enterprises)\/([^/]+)(?:\/|$)/.exec(path);
    const id = m ? segment(m[1]) : null;
    if (!id) return null;
    const row = db.prepare('SELECT is_treasury, status FROM members WHERE public_key = ?').get(id) as { is_treasury: number | null; status: string | null } | undefined;
    if (row?.is_treasury !== 1 || ['completed', 'pruned', 'disabled', 'suspended'].includes(row.status ?? '')) return null;
    return canOperateTreasury(actor, id) ? id : null;
}

/** A listing's author and kind, for a request or a one-step buy. */
function listing(postId: unknown): { author: string; type: string } | null {
    const id = str(postId);
    if (!id) return null;
    return (db.prepare('SELECT author_pubkey AS author, type FROM posts WHERE id = ?').get(id) as { author: string; type: string } | undefined) ?? null;
}

/** A request waiting on its listing's author: who would pay (the buyer) and who would be paid (the seller). */
function waiting(transactionId: unknown): { buyer: string; seller: string } | null {
    const id = str(transactionId);
    if (!id) return null;
    return (db.prepare(`SELECT buyer_pubkey AS buyer, seller_pubkey AS seller FROM marketplace_transactions WHERE id = ? AND status = 'requested'`)
        .get(id) as { buyer: string; seller: string } | undefined) ?? null;
}

/** Approving a request on `account`'s listing: a request, and a payment when `account` is the buyer (its own need). */
function approval(account: string, transactionId: unknown): MoneyAct[] {
    const tx = waiting(transactionId);
    return tx?.buyer === account ? [{ kind: 'request' }, { kind: 'payment', recipient: tx.seller }] : [{ kind: 'request' }];
}

const ENTERPRISE = '/api/(?:treasury|enterprise)/([^/]+)';
const at = (tail: string) => new RegExp(`^${ENTERPRISE}/${tail}/?$`);
const pledge = (actor: string): Plan => ({ account: actor, acts: [{ kind: 'pledge' }] });

export const MONEY_ROUTES: readonly MoneyRoute[] = [
    { method: 'POST', path: /^\/api\/ledger\/transfer\/?$/, plan: (actor, _m, b) => ({ account: actor, acts: [{ kind: 'payment', recipient: str(b.to) }] }) },
    {
        method: 'POST', path: /^\/api\/marketplace\/posts\/accept\/?$/,
        plan: (actor, _m, b) => ({ account: actor, acts: [{ kind: 'payment', recipient: listing(b.postId)?.author ?? null }, { kind: 'request' }] }),
    },
    {
        method: 'POST', path: /^\/api\/marketplace\/posts\/request\/?$/,
        plan: (actor, _m, b) => {
            const post = listing(b.postId);
            return { account: actor, acts: post?.type === 'offer' ? [{ kind: 'payment', recipient: post.author }, { kind: 'request' }] : [{ kind: 'request' }] };
        },
    },
    { method: 'POST', path: /^\/api\/marketplace\/transactions\/approve\/?$/, plan: (actor, _m, b) => ({ account: actor, acts: approval(actor, b.transactionId) }) },
    {
        method: 'POST', path: at('approve'),
        plan: (actor, m, b) => {
            const ent = enterpriseActingFor(actor, m[0]);
            return ent ? { account: ent, acts: approval(ent, b.transactionId) } : null;
        },
    },
    {
        method: 'POST', path: at('sweep'),
        plan: (actor, m) => {
            const ent = enterpriseActingFor(actor, m[0]);
            return ent ? { account: ent, acts: [{ kind: 'payment', recipient: null }] } : null;
        },
    },
    {
        method: 'POST', path: at('pledge'),
        plan: (actor, m, b) => {
            const ent = segment(m[1]);
            if (!ent) return null;
            return pledgeDispatchKind(ent, b) === 'crowdfund'
                ? { account: actor, acts: [{ kind: 'payment', recipient: null }, { kind: 'pledge' }] }
                : pledge(actor);
        },
    },
    { method: 'POST', path: at('backing'), plan: (actor) => pledge(actor) },
    { method: 'POST', path: at('(?:release|pledge/release|backing/release)'), plan: (actor) => pledge(actor) },
    { method: 'DELETE', path: at('(?:pledge|backing)'), plan: (actor) => pledge(actor) },
    {
        method: 'POST', path: /^\/api\/crowdfund\/projects\/[^/]+\/pledge\/?$/,
        plan: (actor) => ({ account: actor, acts: [{ kind: 'payment', recipient: null }, { kind: 'pledge' }] }),
    },
];

/** What this request counts, and against whom: null when it counts nothing. */
export function moneyPlanFor(method: string, path: string, actor: string | null | undefined, body: Record<string, unknown>): Plan {
    if (!actor) return null;
    for (const route of MONEY_ROUTES) {
        if (route.method !== method) continue;
        const m = path.match(route.path);
        if (m) return route.plan(actor, m, body);
    }
    return null;
}

/** Answer a money limit's refusal: 429, its code, its words and when it lets up. True when `e` was one. */
export function respondMoneyLimit(ctx: { status: number; body: unknown; set?: (field: string, value: string) => void }, e: unknown): boolean {
    if (!(e instanceof MoneyLimitError)) return false;
    ctx.status = e.status;
    ctx.body = { error: e.message, code: e.code, resetsAt: e.resetsAt };
    ctx.set?.('Retry-After', String(Math.max(1, Math.ceil((Date.parse(e.resetsAt) - Date.now()) / 1000))));
    return true;
}

/**
 * For the two federation routes: answers the refusal and returns true when `account` may not make `acts` now. Checks
 * only: the settlement the route goes on to open is the record.
 */
export function refuseOverMoneyLimits(ctx: { status: number; body: unknown; set?: (field: string, value: string) => void }, account: string, acts: readonly MoneyAct[]): boolean {
    try {
        assertMoneyActsAllowed(account, acts);
        return false;
    } catch (e) {
        if (respondMoneyLimit(ctx, e)) return true;
        throw e;
    }
}

/** Koa middleware: the money limits for the routes above, on a main server. Mounted after requireSignature (the actor). */
export async function moneyLimitsGate(ctx: Context, next: Next): Promise<void> {
    // A standby makes no money move of its own and has refused these already (standbyLedgerGate): it counts nothing.
    if (getNodeRole() === 'backup') return next();
    const plan = moneyPlanFor(ctx.method.toUpperCase(), ctx.path, ctx.state?.actor as string | undefined, ((ctx as any).requestBody ?? {}) as Record<string, unknown>);
    if (!plan) return next();
    let hold: MoneyActHold;
    try {
        hold = admitMoneyActs(plan.account, plan.acts);
    } catch (e) {
        if (respondMoneyLimit(ctx, e)) return;
        throw e;
    }
    let happened = false;
    try {
        await next();
        happened = ctx.status < 400;
    } finally {
        if (!happened) hold.release();
    }
}
