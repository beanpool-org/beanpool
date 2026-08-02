/**
 * Community Treasury routes.
 *
 * A treasury is a real member account (the Commons' trading face for an enterprise). Three tiers:
 *   - Admin (password, /api/local/admin/*): create a treasury, grant/revoke the operator capability.
 *   - Operator (signed member holding can_operate): drive a treasury — post its Offer/Need, approve
 *     a bid, release escrow, sweep surplus to the Commons. The treasury id rides the URL path (not
 *     the body) so it dodges the requireSignature spoof-guard, which pins body *pubkey fields to the
 *     signer; here the signer is the operator acting *on behalf of* the treasury.
 *   - Public reads: list treasuries + one treasury's detail (community transparency).
 */

import Router from '@koa/router';
import {
    createTreasury, adminSetOperator, canOperateTreasury,
    treasuryKeepers, adminAssignTreasuryOperator, adminRevokeTreasuryOperator,
    createPost, approvePostRequest, completePostTransaction,
    getBalance, moveToCommons, conservingTransaction,
} from '../state-engine.js';
import { db } from '../db/db.js';
import { getLinkByTreasury } from '../federation-link.js';
import type { RouteDeps } from './types.js';

export function createTreasuryRoutes(deps: RouteDeps): Router {
    const router = new Router();
    const { checkAdminAuth } = deps;

    const isTreasury = (pk: string): boolean =>
        !!(db.prepare('SELECT is_treasury FROM members WHERE public_key=?').get(pk) as any)?.is_treasury;

    /**
     * The link fields for one enterprise, or null when it is an ordinary treasury (#143 step 3).
     *
     * `peerId` is included on the detail read because it is what the ceiling route is keyed on, so a
     * keeper's screen can act on the link it is already showing without a second lookup.
     */
    const linkDetail = (pk: string) => {
        const link = getLinkByTreasury(pk);
        return link && {
            peerId: link.peerId,
            energyBalance: link.energyBalance,
            commissionCeiling: link.commissionCeiling,
        };
    };

    // Gate an operator action: a signed member bound to THIS treasury (#106).
    // Returns the operator pubkey, or null after having written the error response.
    //
    // Before #106 this checked only that the actor was *an* operator and the target was *a*
    // treasury — never that the two were related, so any keeper could drive every enterprise on
    // the node. The 404-before-403 order is deliberate: a non-treasury target is not a permission
    // problem, and reporting it as one sends people hunting for the wrong thing.
    //
    // It also checks that both parties are ACTIVE (review finding). Most operator actions reach that check
    // by accident, inside `createPost`/`approvePostRequest`/`completePostTransaction` — but the sweep does
    // not: it moved through `transfer()`, which begins with `assertMemberActive(from)`, and #126 replaced
    // that with `moveToCommons()`, whose job is plumbing rather than policy. So the check has to be stated
    // here, where the *authority* to act is decided, rather than left to whichever primitive happens to
    // repeat it. A pruned enterprise's funds are settled by the prune itself; a suspended keeper has had
    // their authority withdrawn. Neither should be able to move value.
    const statusOf = (pk: string): string | undefined =>
        (db.prepare('SELECT status FROM members WHERE public_key=?').get(pk) as any)?.status;
    const requireOperator = (ctx: any, treasury: string): string | null => {
        const actor = ctx.state?.actor;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return null; }
        if (!actor || !canOperateTreasury(actor, treasury)) {
            ctx.status = 403;
            ctx.body = { error: 'You are not a keeper of this enterprise' };
            return null;
        }
        // Only an EXPLICIT suspension refuses. A missing row means "not a suspended member" — the admin
        // override in canOperateTreasury does not require the admin to hold a member row, and reading a
        // missing status as inactive would lock them out of their own node.
        const blocked = (s?: string) => s === 'disabled' || s === 'pruned';
        if (blocked(statusOf(treasury))) {
            ctx.status = 403;
            ctx.body = { error: 'This enterprise has been closed, so its funds can no longer be moved.' };
            return null;
        }
        if (blocked(statusOf(actor))) {
            ctx.status = 403;
            ctx.body = { error: 'Your account is not active, so you cannot act for this enterprise.' };
            return null;
        }
        return actor;
    };

    // ---- Public transparency reads ------------------------------------------------------
    router.get('/api/treasuries', async (ctx) => {
        const rows = db.prepare(
            "SELECT public_key, callsign, avatar_url, earned_credit FROM members WHERE is_treasury=1 ORDER BY callsign COLLATE NOCASE"
        ).all() as any[];
        ctx.body = {
            treasuries: rows.map(r => {
                const b = getBalance(r.public_key);
                // #143 step 3: a federation link is an enterprise, so it appears in this list like any
                // other — but it carries a SECOND number that must never be added to its balance. The
                // energy balance is the `bridge_<peer>` tab: what the two communities owe each other, and
                // not spendable (federation-economics.md §2.2). `link` is null for an ordinary enterprise.
                const link = getLinkByTreasury(r.public_key);
                return {
                    publicKey: r.public_key, name: r.callsign, avatar: r.avatar_url,
                    balance: b.balance, creditLine: r.earned_credit, liveOffers: b.liveOffers,
                    // #106: lets the Commons list say "Kept by doone" / "No steward yet"
                    // without an extra round trip per enterprise.
                    keepers: treasuryKeepers(r.public_key),
                    link: link && {
                        peerId: link.peerId,
                        energyBalance: link.energyBalance,
                        commissionCeiling: link.commissionCeiling,
                    },
                };
            }),
        };
    });

    router.get('/api/treasury/:treasury', async (ctx) => {
        const { treasury } = ctx.params;
        const m = db.prepare('SELECT callsign, avatar_url FROM members WHERE public_key=? AND is_treasury=1').get(treasury) as any;
        if (!m) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        const b = getBalance(treasury);
        const posts = db.prepare(
            "SELECT id, type, category, title, description, credits, price_type, status, repeatable, created_at FROM posts WHERE author_pubkey=? AND status IN ('active','pending') ORDER BY created_at DESC"
        ).all(treasury) as any[];
        const flow = (db.prepare(
            'SELECT from_pubkey, to_pubkey, amount, memo, timestamp FROM transactions WHERE from_pubkey=? OR to_pubkey=? ORDER BY timestamp DESC LIMIT 20'
        ).all(treasury, treasury) as any[]).map(f => ({
            amount: f.amount, memo: f.memo, timestamp: f.timestamp, incoming: f.to_pubkey === treasury,
        }));
        ctx.body = {
            publicKey: treasury, name: m.callsign, avatar: m.avatar_url,
            balance: b.balance, creditLine: b.earnedCredit, floor: b.floor, usableFloor: b.usableFloor,
            liveOffers: b.liveOffers, posts, flow,
            // #106: who is accountable for this enterprise, public by design — a community should be
            // able to see who keeps what without asking an admin.
            keepers: treasuryKeepers(treasury),
            // #143 step 3 — see the note in /api/treasuries. Null for an ordinary enterprise.
            link: linkDetail(treasury),
        };
    });

    // ---- Admin (password-gated) ---------------------------------------------------------
    router.post('/api/local/admin/treasury', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        const { name, avatar, creditLine } = (ctx as any).requestBody || {};
        if (!name || !avatar) { ctx.status = 400; ctx.body = { error: 'name and avatar are required' }; return; }
        try {
            ctx.body = { success: true, ...createTreasury(String(name), String(avatar), Number(creditLine) || 0) };
        } catch (e: any) { ctx.status = 400; ctx.body = { error: e.message || 'Failed to create treasury' }; }
    });

    // Master switch per member: may they steward anything at all. Retained for the fleet manager,
    // and useful as a suspend that keeps a steward's per-enterprise assignments intact. It grants no
    // authority on its own — since #106 that requires a treasury_operators binding as well.
    router.post('/api/local/admin/users/:pubkey/operator', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        const { pubkey } = ctx.params;
        const { granted } = (ctx as any).requestBody || {};
        try { adminSetOperator(pubkey, !!granted); ctx.body = { success: true }; }
        catch (e: any) { ctx.status = 400; ctx.body = { error: e.message || 'Failed' }; }
    });

    // ---- Per-enterprise keepership (#106) ----------------------------------------------
    // Assign and revoke are the same primitive inverted, per docs/community-governance.md
    // (appoint/remove as one symmetric operation, so removal needs no separate workflow).
    // Both take effect on the next request — the check reads the table, nothing is cached.

    router.get('/api/local/admin/treasury/:treasury/operators', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        const { treasury } = ctx.params;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        ctx.body = { keepers: treasuryKeepers(treasury) };
    });

    router.post('/api/local/admin/treasury/:treasury/operators', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        const { treasury } = ctx.params;
        const { pubkey } = (ctx as any).requestBody || {};
        if (!pubkey) { ctx.status = 400; ctx.body = { error: 'pubkey is required' }; return; }
        try {
            adminAssignTreasuryOperator(treasury, String(pubkey), 'admin');
            ctx.body = { success: true, keepers: treasuryKeepers(treasury) };
        } catch (e: any) { ctx.status = 400; ctx.body = { error: e.message || 'Failed to assign keeper' }; }
    });

    router.delete('/api/local/admin/treasury/:treasury/operators/:pubkey', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        const { treasury, pubkey } = ctx.params;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        try {
            adminRevokeTreasuryOperator(treasury, pubkey);
            ctx.body = { success: true, keepers: treasuryKeepers(treasury) };
        } catch (e: any) { ctx.status = 400; ctx.body = { error: e.message || 'Failed to revoke keeper' }; }
    });

    // Admin (password): post an Offer / Need as a treasury — a bootstrap convenience so a community
    // can be seeded without an operator's signing key on hand. Operators normally use the signed
    // /api/treasury/:treasury/{offer,need} routes above; these mirror them behind the admin password.
    router.post('/api/local/admin/treasury/:treasury/offer', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        const { treasury } = ctx.params;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        const b = (ctx as any).requestBody || {};
        if (!b.title || !b.category) { ctx.status = 400; ctx.body = { error: 'title and category are required' }; return; }
        try {
            const post = createPost('offer', String(b.category), String(b.title), String(b.description || ''), Number(b.credits) || 0, b.priceType || 'fixed', treasury, b.lat !== undefined ? Number(b.lat) : undefined, b.lng !== undefined ? Number(b.lng) : undefined, b.photos, b.repeatable !== false);
            if (!post) { ctx.status = 400; ctx.body = { error: 'Failed to create offer' }; return; }
            ctx.body = { success: true, post };
        } catch (e: any) { ctx.status = 400; ctx.body = { error: e.message }; }
    });

    router.post('/api/local/admin/treasury/:treasury/need', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        const { treasury } = ctx.params;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        const b = (ctx as any).requestBody || {};
        if (!b.title || !b.category) { ctx.status = 400; ctx.body = { error: 'title and category are required' }; return; }
        try {
            const post = createPost('need', String(b.category), String(b.title), String(b.description || ''), Number(b.credits) || 0, b.priceType || 'fixed', treasury, b.lat !== undefined ? Number(b.lat) : undefined, b.lng !== undefined ? Number(b.lng) : undefined, b.photos, !!b.repeatable);
            if (!post) { ctx.status = 400; ctx.body = { error: 'Failed — the treasury needs a live Offer first (offer covenant)' }; return; }
            ctx.body = { success: true, post };
        } catch (e: any) { ctx.status = 400; ctx.body = { error: e.message }; }
    });

    // ---- Operator (signed member with can_operate) --------------------------------------
    // Post the treasury's recurring Offer (e.g. "a dozen eggs"). Defaults repeatable=true.
    router.post('/api/treasury/:treasury/offer', async (ctx) => {
        const { treasury } = ctx.params;
        if (!requireOperator(ctx, treasury)) return;
        const b = (ctx as any).requestBody || {};
        if (!b.title || !b.category) { ctx.status = 400; ctx.body = { error: 'title and category are required' }; return; }
        try {
            const post = createPost('offer', String(b.category), String(b.title), String(b.description || ''), Number(b.credits) || 0, b.priceType || 'fixed', treasury, b.lat !== undefined ? Number(b.lat) : undefined, b.lng !== undefined ? Number(b.lng) : undefined, b.photos, b.repeatable !== false);
            if (!post) { ctx.status = 400; ctx.body = { error: 'Failed to create offer' }; return; }
            ctx.body = { success: true, post };
        } catch (e: any) { ctx.status = 400; ctx.body = { error: e.message }; }
    });

    // Post the treasury's Need (e.g. "tend the chickens"). Requires the treasury to already hold a
    // live Offer (the offer covenant) before it can run the need at a deficit.
    router.post('/api/treasury/:treasury/need', async (ctx) => {
        const { treasury } = ctx.params;
        if (!requireOperator(ctx, treasury)) return;
        const b = (ctx as any).requestBody || {};
        if (!b.title || !b.category) { ctx.status = 400; ctx.body = { error: 'title and category are required' }; return; }
        try {
            const post = createPost('need', String(b.category), String(b.title), String(b.description || ''), Number(b.credits) || 0, b.priceType || 'fixed', treasury, b.lat !== undefined ? Number(b.lat) : undefined, b.lng !== undefined ? Number(b.lng) : undefined, b.photos, !!b.repeatable);
            if (!post) { ctx.status = 400; ctx.body = { error: 'Failed — the treasury needs a live Offer first (offer covenant)' }; return; }
            ctx.body = { success: true, post };
        } catch (e: any) { ctx.status = 400; ctx.body = { error: e.message }; }
    });

    // Approve a bid on the treasury's Need — funds escrow from the treasury (its credit line).
    router.post('/api/treasury/:treasury/approve', async (ctx) => {
        const { treasury } = ctx.params;
        if (!requireOperator(ctx, treasury)) return;
        const { transactionId } = (ctx as any).requestBody || {};
        if (!transactionId) { ctx.status = 400; ctx.body = { error: 'transactionId is required' }; return; }
        try {
            const tx = approvePostRequest(String(transactionId), treasury);
            if (!tx) { ctx.status = 400; ctx.body = { error: 'Could not approve (not this treasury’s deal, or already actioned)' }; return; }
            ctx.body = { success: true, transaction: tx };
        } catch (e: any) { ctx.status = 400; ctx.body = { error: e.message }; }
    });

    // Release escrow on a treasury Need it is the buyer of (e.g. pay the tender on completion).
    // Egg *sales* are released by the buyer through the normal marketplace route, not here.
    router.post('/api/treasury/:treasury/complete', async (ctx) => {
        const { treasury } = ctx.params;
        if (!requireOperator(ctx, treasury)) return;
        const { transactionId } = (ctx as any).requestBody || {};
        if (!transactionId) { ctx.status = 400; ctx.body = { error: 'transactionId is required' }; return; }
        try {
            const tx = completePostTransaction(String(transactionId), treasury);
            if (!tx) { ctx.status = 400; ctx.body = { error: 'Could not release (not this treasury’s deal to confirm)' }; return; }
            ctx.body = { success: true, transaction: tx };
        } catch (e: any) { ctx.status = 400; ctx.body = { error: e.message }; }
    });

    // Sweep surplus from the treasury into the shared Commons pool.
    router.post('/api/treasury/:treasury/sweep', async (ctx) => {
        const { treasury } = ctx.params;
        if (!requireOperator(ctx, treasury)) return;
        const amt = Number((ctx as any).requestBody?.amount);
        if (!amt || amt <= 0) { ctx.status = 400; ctx.body = { error: 'amount must be positive' }; return; }
        if (amt > getBalance(treasury).balance) { ctx.status = 400; ctx.body = { error: 'Cannot sweep more than the treasury holds' }; return; }
        // moveToCommons, NOT transfer(..., 'COMMONS_POOL', ...) — #126. The latter debited the treasury and
        // then had the Commons credit overwritten by the next persistCommonsBalance() flush, DESTROYING the
        // beans and breaking the node's zero-sum invariant. Measured: 40 in, 40 gone.
        //
        // Wrapped in `conservingTransaction` like the prune and federation callers (review finding).
        // `moveToCommons` mutates the in-memory ledger and the COMMONS_BALANCE global BEFORE its several
        // SQLite writes, so a failure part-way through would otherwise leave memory mutated against partial
        // rows — and the next flush would make the phantom credit durable. The wrapper makes the whole move
        // atomic in both halves, so a failure really does mean nothing moved.
        //
        // The two failure kinds are answered differently. `moveToCommons` returns null for a REFUSAL (the
        // balance will not cover it) and THROWS for an invariant violation (wrong account type) or a storage
        // error. A refusal is the caller's problem: 400. A throw is ours: the message names internal detail
        // the caller has no use for, so it goes to the log and the caller gets a 500 — reporting a storage
        // failure as a 400 would tell someone their input was wrong when the node is what is broken.
        let ok;
        try {
            ok = conservingTransaction(() =>
                moveToCommons(treasury, amt, `Surplus swept to Commons from ${treasury.slice(0, 8)}`));
        } catch (e: any) {
            const invariant = /moveToCommons is for/.test(e?.message || '');
            console.error(`[Treasury] Sweep from ${treasury.slice(0, 8)} failed:`, e?.message || e);
            ctx.status = invariant ? 400 : 500;
            ctx.body = {
                error: invariant
                    ? 'That sweep could not be completed. Nothing has been moved.'
                    : 'Something went wrong saving that sweep. Nothing has been moved — please try again.',
            };
            return;
        }
        if (!ok) {
            ctx.status = 400;
            ctx.body = { error: 'That sweep could not be completed — check the treasury still holds that much.' };
            return;
        }
        ctx.body = { success: true, swept: amt, balance: getBalance(treasury).balance };
    });

    return router;
}
