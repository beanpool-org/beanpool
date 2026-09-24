/**
 * The routes a node profile switch turns off (config/node-profile.ts): 404 `feature_off`, before any handler runs.
 *
 * One table rather than a check in each handler, so a route added under one of these prefixes is off with its
 * feature without anyone remembering to say so. Reads stay 404 too: the apps treat a failed treasury or crowdfund
 * read as "none" (native `getTreasuries`, `pillar-sync`), and a node doesn't serve what it doesn't do.
 *
 * Not here, on purpose:
 * - `POST /api/ledger/transfer` answers 403 `profile_no_beans` itself (routes/community.ts): a send is refused, not
 *   missing. Posts with a Beans price and pool-money Decisions are refused in the engine, with the same code.
 * - `GET /api/marketplace/transactions`, `GET /api/ledger/transactions`, `GET /api/ledger/balance/:pk` and
 *   `GET /api/commons/balance` answer as always: a member's own history and balance, which on a node with Beans off
 *   are empty and 0. The apps read them on every sync, and an empty list is the truth.
 *
 * Underneath every route, the ledger primitives refuse on their own (transfer, moveToCommons, payFromCommons, the
 * crowdfund pledge, the escrow engine's request/accept/approve), so this table is the plain answer, not the guard.
 */
import type { Context, Next } from 'koa';
import {
    getProfileSwitches, featureOffMessage, BeansOffError, FeatureOffError, FEATURE_OFF,
    type ProfileSwitch, type ProfileSwitches,
} from '../config/node-profile.js';

interface GatedRoutes {
    /** On only while every one of these switches is on. */
    needs: ProfileSwitch[];
    /** Matched against the path, any method. */
    paths: RegExp[];
}

export const PROFILE_GATED_ROUTES: readonly GatedRoutes[] = [
    // Opening, funding, settling, refunding or ruling on an escrow. With escrow off none can exist (the ledger lock
    // keeps escrow on wherever one ever did), so there is nothing to complete, cancel or dispute either.
    {
        needs: ['escrow'],
        paths: [
            /^\/api\/marketplace\/posts\/(accept|request)\/?$/,
            /^\/api\/marketplace\/transactions\/(approve|reject|cancel-request|complete|cancel)\/?$/,
            /^\/api\/local\/admin\/(disputes|stranded-escrows)(\/|$)/,
        ],
    },
    // Treasuries and enterprises are one construct under two names in this build (routes/treasury.ts serves both
    // from the same handlers), so they are on only while both switches are.
    {
        needs: ['enterprises', 'treasuries'],
        paths: [
            /^\/api\/(treasury|treasuries|enterprise|enterprises)(\/|$)/,
            /^\/api\/map\/enterprises\/?$/,
            /^\/api\/local\/admin\/treasury(\/|$)/,
            /^\/api\/local\/admin\/users\/[^/]+\/operator\/?$/,
        ],
    },
    // Crowdfunds, and Commons projects (a project proposal IS a bounded enterprise raising Beans, state-engine
    // createProject).
    {
        needs: ['crowdfund'],
        paths: [
            /^\/api\/crowdfund(\/|$)/,
            /^\/api\/commons\/projects(\/|$)/,
            /^\/api\/local\/admin\/commons\/(projects|reject)\/?$/,
        ],
    },
    // Cross-community purchases and commissions move Beans between two ledgers.
    {
        needs: ['beans'],
        paths: [/^\/api\/federation\/(purchase|commission)(\/|$)/],
    },
];

/** The switch that has this path off right now, or null when it is served. Reads the switches only for a gated path. */
export function featureOffFor(path: string, switches?: ProfileSwitches): ProfileSwitch | null {
    for (const group of PROFILE_GATED_ROUTES) {
        if (!group.paths.some((re) => re.test(path))) continue;
        switches ??= getProfileSwitches();
        const off = group.needs.find((k) => !switches![k]);
        if (off) return off;
    }
    return null;
}

/** Koa middleware: 404 `feature_off` for a route whose switch is off. Mounted before the route modules (https-server.ts). */
export async function profileFeatureGate(ctx: Context, next: Next): Promise<void> {
    if (!ctx.path.startsWith('/api/')) return next();
    const off = featureOffFor(ctx.path);
    if (!off) return next();
    ctx.status = 404;
    ctx.body = { error: featureOffMessage(off), code: FEATURE_OFF, feature: off };
}

/** For a route's catch: answers a Beans-off or feature-off refusal with its own status and code. True when it did. */
export function respondProfileRefusal(ctx: { status: number; body: unknown }, e: unknown): boolean {
    if (e instanceof BeansOffError || e instanceof FeatureOffError) {
        ctx.status = e.status;
        ctx.body = e instanceof FeatureOffError
            ? { error: e.message, code: e.code, feature: e.feature }
            : { error: e.message, code: e.code };
        return true;
    }
    return false;
}
