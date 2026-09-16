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
    createTreasury, adminSetOperator, canOperateTreasury, canAdministerTreasury,
    treasuryKeepers, adminAssignTreasuryOperator, adminRevokeTreasuryOperator,
    createPost, approvePostRequest, completePostTransaction, rejectPostRequest,
    getBalance, moveToCommons, conservingTransaction,
    sweepEnterpriseCeiling,
    pauseEnterprise, resumeEnterprise, initiateWindUp, cancelWindUp, finaliseWindUp, getEnterpriseLedger,
} from '../state-engine.js';
import { db } from '../db/db.js';
import { getLinkByTreasury, listFederationLinks } from '../federation-link.js';
import { commissionAllowanceFor } from '../federation-commission.js';
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
    /**
     * The wire shape of a link, from the link row. One function so the list and the detail read cannot drift.
     *
     * `commissionAllowance` is here rather than left to the client (#143 step 5). The allowance is
     * `ceiling − tab`, so a client holding both could compute it — and a client that computes it is a second
     * definition of the rule the commission route enforces with. A card promising a keeper 480 while the route
     * refuses is worse than a card promising nothing.
     *
     * It also fixes a copy bug the cumulative model introduces: the card used to read "commissioning off"
     * whenever the ceiling was 0, which is now wrong in the case that matters most. A ceiling of 0 still
     * permits REDEMPTION up to the credit the community is owed — that is the whole argument of §3.
     */
    const linkShape = (link: { peerId: string; energyBalance: number; commissionCeiling: number }) => ({
        peerId: link.peerId,
        energyBalance: link.energyBalance,
        commissionCeiling: link.commissionCeiling,
        commissionAllowance: commissionAllowanceFor(link.commissionCeiling, link.energyBalance),
    });

    const linkDetail = (pk: string) => {
        const link = getLinkByTreasury(pk);
        return link && linkShape(link);
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
        // Only an EXPLICIT suspension refuses. A missing row means "not a suspended member".
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

    // Gate an administrative or lifecycle action: authorized for enterprise keepers or node admin.
    // Also checks that both enterprise and actor are not explicitly suspended or pruned.
    const requireKeeperOrAdmin = (ctx: any, treasury: string): string | null => {
        const actor = ctx.state?.actor;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return null; }
        if (!actor || !canAdministerTreasury(actor, treasury)) {
            ctx.status = 403;
            ctx.body = { error: 'Only a keeper of this enterprise (or node admin) may perform this action' };
            return null;
        }
        const blocked = (s?: string) => s === 'disabled' || s === 'pruned' || s === 'completed';
        if (blocked(statusOf(treasury))) {
            ctx.status = 403;
            ctx.body = { error: 'This enterprise has been closed, so it can no longer be modified.' };
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
    const listTreasuriesHandler = async (ctx: any) => {
        const rows = db.prepare(
            "SELECT public_key, callsign, avatar_url, earned_credit, earned_surplus, working_capital_ceiling, purpose, goal_amount, deadline_at, lifecycle, status, paused, paused_at, paused_by, paused_floor_snapshot, wind_up_initiated_at, wind_up_initiated_by, wind_up_finalised_at FROM members WHERE is_treasury=1 ORDER BY callsign COLLATE NOCASE"
        ).all() as any[];
        // Links fetched ONCE for the whole page, not per treasury (review finding). Called per row this was
        // 3N queries with a statement recompiled each time — and most nodes have zero links, so every
        // community with an egg flock and no federation was paying for a feature it does not use.
        const linksByTreasury = new Map(listFederationLinks().map(l => [l.treasuryPubkey, l]));
        ctx.body = {
            treasuries: rows.map(r => {
                const b = getBalance(r.public_key);
                let pauseExpiresAt: string | null = null;
                let pauseDaysRemaining: number | null = null;
                let pauseExpiringSoon = false;
                let pauseWarning: string | null = null;
                if (r.paused === 1 && r.paused_at) {
                    const expiresTime = new Date(r.paused_at).getTime() + 90 * 24 * 60 * 60 * 1000;
                    pauseExpiresAt = new Date(expiresTime).toISOString();
                    pauseDaysRemaining = Math.max(0, Math.ceil((expiresTime - Date.now()) / (24 * 60 * 60 * 1000)));
                    pauseExpiringSoon = pauseDaysRemaining <= 14;
                    pauseWarning = pauseDaysRemaining === 0
                        ? 'Pause credit floor snapshot has expired'
                        : pauseDaysRemaining <= 14
                            ? `Pause credit floor snapshot expires in ${pauseDaysRemaining} day${pauseDaysRemaining === 1 ? '' : 's'}`
                            : null;
                }

                let windUpGraceEndsAt: string | null = null;
                if (r.status === 'winding_up' && r.wind_up_initiated_at) {
                    windUpGraceEndsAt = new Date(new Date(r.wind_up_initiated_at).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
                }

                // #143 step 3: a federation link is an enterprise, so it appears in this list like any
                // other — but it carries a SECOND number that must never be added to its balance. The
                // energy balance is the `bridge_<peer>` tab: what the two communities owe each other, and
                // not spendable (federation-economics.md §2.2). `link` is undefined for an ordinary
                // enterprise, which serialises to an absent field — same thing to a client as the null the
                // detail read returns.
                const link = linksByTreasury.get(r.public_key);
                return {
                    publicKey: r.public_key, name: r.callsign,
                    avatar: r.avatar_url
                        ? (r.avatar_url.startsWith('bundled://')
                            ? r.avatar_url
                            : `/api/avatar/${r.public_key}?size=thumb`)
                        : null,
                    balance: b.balance, creditLine: r.earned_credit, floor: b.floor, usableFloor: b.usableFloor,
                    liveOffers: b.liveOffers,
                    earnedSurplus: r.earned_surplus ?? 0,
                    workingCapitalCeiling: r.working_capital_ceiling ?? null,
                    purpose: r.purpose ?? null,
                    goalAmount: r.goal_amount != null ? Number(r.goal_amount) : null,
                    deadlineAt: r.deadline_at ?? null,
                    lifecycle: r.lifecycle ?? 'ongoing',
                    status: r.status ?? 'active',
                    paused: !!r.paused,
                    pausedAt: r.paused_at ?? null,
                    pausedBy: r.paused_by ?? null,
                    pausedFloorSnapshot: r.paused_floor_snapshot != null ? Number(r.paused_floor_snapshot) : null,
                    pauseExpiresAt,
                    pauseDaysRemaining,
                    pauseExpiringSoon,
                    pauseWarning,
                    windUpInitiatedAt: r.wind_up_initiated_at ?? null,
                    windUpInitiatedBy: r.wind_up_initiated_by ?? null,
                    windUpFinalisedAt: r.wind_up_finalised_at ?? null,
                    windUpGraceEndsAt,
                    // #106: lets the Commons list say "Kept by doone" / "No steward yet"
                    // without an extra round trip per enterprise.
                    keepers: treasuryKeepers(r.public_key),
                    link: link && linkShape(link),
                };
            }),
        };
    };
    router.get('/api/treasuries', listTreasuriesHandler);
    router.get('/api/enterprises', listTreasuriesHandler);

    const getTreasuryHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        const m = db.prepare('SELECT callsign, avatar_url, earned_surplus, working_capital_ceiling, purpose, goal_amount, deadline_at, lifecycle, status, paused, paused_at, paused_by, paused_floor_snapshot, wind_up_initiated_at, wind_up_initiated_by, wind_up_finalised_at FROM members WHERE public_key=? AND is_treasury=1').get(treasury) as any;
        if (!m) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        const b = getBalance(treasury);

        let pauseExpiresAt: string | null = null;
        let pauseDaysRemaining: number | null = null;
        let pauseExpiringSoon = false;
        let pauseWarning: string | null = null;
        if (m.paused === 1 && m.paused_at) {
            const expiresTime = new Date(m.paused_at).getTime() + 90 * 24 * 60 * 60 * 1000;
            pauseExpiresAt = new Date(expiresTime).toISOString();
            pauseDaysRemaining = Math.max(0, Math.ceil((expiresTime - Date.now()) / (24 * 60 * 60 * 1000)));
            pauseExpiringSoon = pauseDaysRemaining <= 14;
            pauseWarning = pauseDaysRemaining === 0
                ? 'Pause credit floor snapshot has expired'
                : pauseDaysRemaining <= 14
                    ? `Pause credit floor snapshot expires in ${pauseDaysRemaining} day${pauseDaysRemaining === 1 ? '' : 's'}`
                    : null;
        }

        let windUpGraceEndsAt: string | null = null;
        if (m.status === 'winding_up' && m.wind_up_initiated_at) {
            windUpGraceEndsAt = new Date(new Date(m.wind_up_initiated_at).getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
        }

        const posts = db.prepare(
            "SELECT id, type, category, title, description, credits, price_type, status, repeatable, created_at FROM posts WHERE author_pubkey=? AND status IN ('active','pending') ORDER BY created_at DESC"
        ).all(treasury) as any[];
        const flow = (db.prepare(
            'SELECT from_pubkey, to_pubkey, amount, memo, timestamp FROM transactions WHERE from_pubkey=? OR to_pubkey=? ORDER BY timestamp DESC LIMIT 20'
        ).all(treasury, treasury) as any[]).map(f => ({
            amount: f.amount, memo: f.memo, timestamp: f.timestamp, incoming: f.to_pubkey === treasury,
        }));
        // Gate pending bids, active deals, and worker wage details so only verified operators of this treasury receive sensitive operational data
        const actor = ctx.state?.actor;
        const isOperator = !!(actor && canOperateTreasury(actor, treasury));

        // PR #775 review: Sensitive worker wage history (keeper_pubkey, transaction_id, historical payouts)
        // must not leak to unauthenticated / non-operator clients. Public view only sees pending claims without worker identifiers.
        const deferredClaims = isOperator ? (db.prepare(
            "SELECT id, keeper_pubkey, post_id, transaction_id, amount, status, created_at, paid_at FROM deferred_wage_claims WHERE enterprise_pubkey=? ORDER BY created_at ASC LIMIT 50"
        ).all(treasury) as any[]) : (db.prepare(
            "SELECT id, amount, status, created_at FROM deferred_wage_claims WHERE enterprise_pubkey=? AND status='pending' ORDER BY created_at ASC LIMIT 50"
        ).all(treasury) as any[]);

        const pendingBids = isOperator ? (db.prepare(`
            SELECT t.id, t.post_id, t.buyer_pubkey, t.seller_pubkey, t.credits, t.hours, t.status, t.created_at,
                   p.title as post_title, p.type as post_type, p.price_type,
                   m.callsign as peer_callsign, m.avatar_url as peer_avatar
            FROM marketplace_transactions t
            JOIN posts p ON t.post_id = p.id
            LEFT JOIN members m ON m.public_key = CASE WHEN t.buyer_pubkey = ? THEN t.seller_pubkey ELSE t.buyer_pubkey END
            WHERE (t.buyer_pubkey = ? OR t.seller_pubkey = ?) AND t.status = 'requested'
            ORDER BY t.created_at DESC
            LIMIT 50
        `).all(treasury, treasury, treasury) as any[]) : [];
        const activeDeals = isOperator ? (db.prepare(`
            SELECT t.id, t.post_id, t.buyer_pubkey, t.seller_pubkey, t.credits, t.hours, t.status, t.created_at,
                   p.title as post_title, p.type as post_type, p.price_type,
                   m.callsign as peer_callsign, m.avatar_url as peer_avatar,
                   CASE WHEN t.buyer_pubkey = ? THEN 'pay' ELSE 'fulfill' END as action_required
            FROM marketplace_transactions t
            JOIN posts p ON t.post_id = p.id
            LEFT JOIN members m ON m.public_key = CASE WHEN t.buyer_pubkey = ? THEN t.seller_pubkey ELSE t.buyer_pubkey END
            WHERE (t.buyer_pubkey = ? OR t.seller_pubkey = ?) AND t.status = 'pending'
            ORDER BY t.created_at DESC
            LIMIT 50
        `).all(treasury, treasury, treasury, treasury) as any[]) : [];
        ctx.body = {
            publicKey: treasury, name: m.callsign,
            avatar: m.avatar_url
                ? (m.avatar_url.startsWith('bundled://')
                    ? m.avatar_url
                    : `/api/avatar/${treasury}?size=thumb`)
                : null,
            balance: b.balance, creditLine: b.earnedCredit, floor: b.floor, usableFloor: b.usableFloor,
            liveOffers: b.liveOffers, posts, flow, pendingBids, activeDeals,
            earnedSurplus: m.earned_surplus ?? 0,
            workingCapitalCeiling: m.working_capital_ceiling ?? null,
            purpose: m.purpose ?? null,
            goalAmount: m.goal_amount != null ? Number(m.goal_amount) : null,
            deadlineAt: m.deadline_at ?? null,
            lifecycle: m.lifecycle ?? 'ongoing',
            status: m.status ?? 'active',
            paused: !!m.paused,
            pausedAt: m.paused_at ?? null,
            pausedBy: m.paused_by ?? null,
            pausedFloorSnapshot: m.paused_floor_snapshot != null ? Number(m.paused_floor_snapshot) : null,
            pauseExpiresAt,
            pauseDaysRemaining,
            pauseExpiringSoon,
            pauseWarning,
            windUpInitiatedAt: m.wind_up_initiated_at ?? null,
            windUpInitiatedBy: m.wind_up_initiated_by ?? null,
            windUpFinalisedAt: m.wind_up_finalised_at ?? null,
            windUpGraceEndsAt,
            deferredClaims,
            // #106: who is accountable for this enterprise, public by design — a community should be
            // able to see who keeps what without asking an admin.
            keepers: treasuryKeepers(treasury),
            // #143 step 3 — see the note in /api/treasuries. Null for an ordinary enterprise.
            link: linkDetail(treasury),
        };
    };
    router.get('/api/treasury/:treasury', getTreasuryHandler);
    router.get('/api/enterprise/:treasury', getTreasuryHandler);

    // ---- Authenticated Enterprise Creation (docs/the-commons.md §2.1) -------------------
    const createEnterpriseHandler = async (ctx: any) => {
        const body = (ctx as any).requestBody || {};
        const actor = (ctx.state?.actor as string) || body.creatorPubkey || body.creator_pubkey || body.proposerPubkey;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return;
        }
        const { name, title, avatar, photos, creditLine, workingCapitalCeiling, purpose, description, lifecycle, goalAmount, deadlineAt } = body;
        const enterpriseName = String(name || title || '').trim();
        if (!enterpriseName || enterpriseName.length < 2) {
            ctx.status = 400;
            ctx.body = { error: 'name must be at least 2 characters' };
            return;
        }
        let photoUrl = avatar;
        if (!photoUrl && Array.isArray(photos) && photos.length > 0) photoUrl = photos[0];
        const enterprisePurpose = String(purpose || description || enterpriseName).trim();
        const parsedLifecycle = (lifecycle === 'bounded' || goalAmount != null || deadlineAt) ? 'bounded' : 'ongoing';
        const parsedGoal = goalAmount != null ? Number(goalAmount) : null;
        const parsedDeadline = deadlineAt ? String(deadlineAt) : null;

        try {
            const res = createTreasury(
                enterpriseName,
                photoUrl || '',
                Number(creditLine) || 0,
                {
                    systemCreated: !photoUrl,
                    workingCapitalCeiling: workingCapitalCeiling != null ? Number(workingCapitalCeiling) : null,
                    purpose: enterprisePurpose,
                    lifecycle: parsedLifecycle,
                    goalAmount: parsedGoal,
                    deadlineAt: parsedDeadline,
                    leadKeeperPubkey: actor,
                }
            );

            if (parsedLifecycle === 'bounded') {
                try {
                    db.prepare(`
                        INSERT OR IGNORE INTO projects (id, creator_pubkey, title, description, photos, goal_amount, deadline_at, status, migrated_at, enterprise_pubkey, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                    `).run(
                        res.publicKey,
                        actor,
                        enterpriseName,
                        enterprisePurpose,
                        photoUrl ? JSON.stringify([photoUrl]) : '[]',
                        parsedGoal || 0,
                        parsedDeadline,
                        res.publicKey
                    );
                } catch { }
            }

            ctx.body = {
                success: true,
                publicKey: res.publicKey,
                name: enterpriseName,
                purpose: enterprisePurpose,
                lifecycle: parsedLifecycle,
                goalAmount: parsedGoal,
                deadlineAt: parsedDeadline,
            };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to create enterprise' };
        }
    };
    router.post('/api/treasury', createEnterpriseHandler);
    router.post('/api/enterprise', createEnterpriseHandler);

    // ---- Admin (password-gated) ---------------------------------------------------------
    router.post('/api/local/admin/treasury', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        const { name, avatar, creditLine, workingCapitalCeiling } = (ctx as any).requestBody || {};
        if (!name || !avatar) { ctx.status = 400; ctx.body = { error: 'name and avatar are required' }; return; }
        try {
            ctx.body = {
                success: true,
                ...createTreasury(
                    String(name),
                    String(avatar),
                    Number(creditLine) || 0,
                    { workingCapitalCeiling: workingCapitalCeiling !== undefined && workingCapitalCeiling !== null ? Number(workingCapitalCeiling) : null }
                ),
            };
        } catch (e: any) { ctx.status = 400; ctx.body = { error: e.message || 'Failed to create treasury' }; }
    });

    // docs/the-commons.md §2.4 Rule 7: Working capital ceiling is set at creation and
    // changed only by Decision (§3.6 — admin-only editable for now, with a code comment explaining
    // that it moves by community Decision once that engine exists).
    router.post('/api/local/admin/treasury/:treasury/ceiling', async (ctx) => {
        if (!(await checkAdminAuth(ctx))) return;
        const { treasury } = ctx.params;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        const { ceiling } = (ctx as any).requestBody || {};
        const parsedCeiling = ceiling === null || ceiling === undefined || ceiling === '' ? null : Number(ceiling);
        if (parsedCeiling !== null && (!Number.isFinite(parsedCeiling) || parsedCeiling < 0)) {
            ctx.status = 400;
            ctx.body = { error: 'Ceiling must be a non-negative finite number or null' };
            return;
        }
        db.prepare('UPDATE members SET working_capital_ceiling = ? WHERE public_key = ?').run(parsedCeiling, treasury);
        sweepEnterpriseCeiling(treasury);
        ctx.body = { success: true, workingCapitalCeiling: parsedCeiling };
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
        const actor = requireOperator(ctx, treasury);
        if (!actor) return;
        const b = (ctx as any).requestBody || {};
        if (!b.title || !b.category) { ctx.status = 400; ctx.body = { error: 'title and category are required' }; return; }
        try {
            const post = createPost('offer', String(b.category), String(b.title), String(b.description || ''), Number(b.credits) || 0, b.priceType || 'fixed', treasury, b.lat !== undefined ? Number(b.lat) : undefined, b.lng !== undefined ? Number(b.lng) : undefined, b.photos, b.repeatable !== false, undefined, undefined, { createdBy: actor });
            if (!post) { ctx.status = 400; ctx.body = { error: 'Failed to create offer' }; return; }
            ctx.body = { success: true, post };
        } catch (e: any) { ctx.status = 400; ctx.body = { error: e.message }; }
    });

    // Post the treasury's Need (e.g. "tend the chickens"). Requires the treasury to already hold a
    // live Offer (the offer covenant) before it can run the need at a deficit.
    router.post('/api/treasury/:treasury/need', async (ctx) => {
        const { treasury } = ctx.params;
        const actor = requireOperator(ctx, treasury);
        if (!actor) return;
        const b = (ctx as any).requestBody || {};
        if (!b.title || !b.category) { ctx.status = 400; ctx.body = { error: 'title and category are required' }; return; }
        try {
            const post = createPost('need', String(b.category), String(b.title), String(b.description || ''), Number(b.credits) || 0, b.priceType || 'fixed', treasury, b.lat !== undefined ? Number(b.lat) : undefined, b.lng !== undefined ? Number(b.lng) : undefined, b.photos, !!b.repeatable, undefined, undefined, { createdBy: actor });
            if (!post) { ctx.status = 400; ctx.body = { error: 'Failed — the treasury needs a live Offer first (offer covenant)' }; return; }
            ctx.body = { success: true, post };
        } catch (e: any) { ctx.status = 400; ctx.body = { error: e.message }; }
    });

    // Approve a bid on the treasury's Need — funds escrow from the treasury (its credit line).
    router.post('/api/treasury/:treasury/approve', async (ctx) => {
        const { treasury } = ctx.params;
        const actor = requireOperator(ctx, treasury);
        if (!actor) return;
        const { transactionId } = (ctx as any).requestBody || {};
        if (!transactionId) { ctx.status = 400; ctx.body = { error: 'transactionId is required' }; return; }
        try {
            const tx = approvePostRequest(String(transactionId), treasury, { authSigner: actor });
            if (!tx) { ctx.status = 400; ctx.body = { error: 'Could not approve (not this treasury’s deal, or already actioned)' }; return; }
            ctx.body = { success: true, transaction: tx };
        } catch (e: any) {
            ctx.status = e.status || e.statusCode || 400;
            ctx.body = { error: e.message };
        }
    });

    // Release escrow on a treasury Need it is the buyer of (e.g. pay the tender on completion).
    // Egg *sales* are released by the buyer through the normal marketplace route, not here.
    router.post('/api/treasury/:treasury/complete', async (ctx) => {
        const { treasury } = ctx.params;
        const actor = requireOperator(ctx, treasury);
        if (!actor) return;
        const { transactionId, finalHours, hours } = (ctx as any).requestBody || {};
        if (!transactionId) { ctx.status = 400; ctx.body = { error: 'transactionId is required' }; return; }
        const rawHours = finalHours !== undefined ? finalHours : hours;
        const parsedHours = rawHours != null && !isNaN(Number(rawHours)) ? Number(rawHours) : undefined;
        try {
            const tx = completePostTransaction(String(transactionId), treasury, parsedHours, { authSigner: actor });
            if (!tx) { ctx.status = 400; ctx.body = { error: 'Could not release (not this treasury’s deal to confirm)' }; return; }
            ctx.body = { success: true, transaction: tx };
        } catch (e: any) {
            ctx.status = e.status || e.statusCode || 400;
            ctx.body = { error: e.message };
        }
    });

    // Reject a bid on the treasury's Need
    router.post('/api/treasury/:treasury/reject', async (ctx) => {
        const { treasury } = ctx.params;
        const actor = requireOperator(ctx, treasury);
        if (!actor) return;
        const { transactionId } = (ctx as any).requestBody || {};
        if (!transactionId) { ctx.status = 400; ctx.body = { error: 'transactionId is required' }; return; }
        try {
            const tx = rejectPostRequest(String(transactionId), treasury);
            if (!tx) { ctx.status = 400; ctx.body = { error: 'Could not reject (not this treasury’s deal, or already actioned)' }; return; }
            ctx.body = { success: true, transaction: tx };
        } catch (e: any) {
            ctx.status = e.status || e.statusCode || 400;
            ctx.body = { error: e.message };
        }
    });

    // Sweep surplus from the treasury into the shared Commons pool.
    router.post('/api/treasury/:treasury/sweep', async (ctx) => {
        const { treasury } = ctx.params;
        const actor = requireOperator(ctx, treasury);
        if (!actor) return;
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
                moveToCommons(treasury, amt, `Surplus swept to Commons from ${treasury.slice(0, 8)}`, { authSigner: actor }));
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

    // ---- Enterprise Season / Lifecycle (docs/the-commons.md §2.2) -----------------------

    // Pause enterprise for a season (keeper / admin)
    const pauseHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        const actor = requireKeeperOrAdmin(ctx, treasury);
        if (!actor) return;
        try {
            const res = pauseEnterprise(treasury, actor);
            ctx.body = {
                success: true,
                paused: true,
                pausedAt: res.pausedAt,
                pausedFloorSnapshot: res.pausedFloorSnapshot,
                alreadyPaused: !!res.alreadyPaused,
            };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to pause enterprise' };
        }
    };
    router.post('/api/treasury/:treasury/pause', pauseHandler);
    router.post('/api/enterprise/:treasury/pause', pauseHandler);

    // Resume enterprise from pause (keeper / admin)
    const resumeHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        const actor = requireKeeperOrAdmin(ctx, treasury);
        if (!actor) return;
        try {
            const res = resumeEnterprise(treasury, actor);
            ctx.body = {
                success: true,
                paused: false,
                alreadyActive: !!res.alreadyActive,
            };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to resume enterprise' };
        }
    };
    router.post('/api/treasury/:treasury/resume', resumeHandler);
    router.post('/api/enterprise/:treasury/resume', resumeHandler);

    // Initiate wind-up (lead keeper only)
    const initiateWindUpHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        const actor = requireKeeperOrAdmin(ctx, treasury);
        if (!actor) return;
        try {
            const res = initiateWindUp(treasury, actor);
            ctx.body = {
                success: true,
                status: res.status,
                initiatedAt: res.initiatedAt,
                initiatedBy: res.initiatedBy,
                graceEndsAt: res.graceEndsAt,
                alreadyInitiated: !!res.alreadyInitiated,
            };
        } catch (e: any) {
            const isAuth = /Only the lead keeper/.test(e?.message || '');
            ctx.status = isAuth ? 403 : 400;
            ctx.body = { error: e.message || 'Failed to initiate wind-up' };
        }
    };
    router.post('/api/treasury/:treasury/wind-up/initiate', initiateWindUpHandler);
    router.post('/api/enterprise/:treasury/wind-up/initiate', initiateWindUpHandler);

    // Cancel wind-up during 7-day grace period (any keeper)
    const cancelWindUpHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        const actor = requireKeeperOrAdmin(ctx, treasury);
        if (!actor) return;
        try {
            const res = cancelWindUp(treasury, actor);
            ctx.body = {
                success: true,
                status: res.status,
            };
        } catch (e: any) {
            const isAuth = /Only a keeper/.test(e?.message || '');
            ctx.status = isAuth ? 403 : 400;
            ctx.body = { error: e.message || 'Failed to cancel wind-up' };
        }
    };
    router.post('/api/treasury/:treasury/wind-up/cancel', cancelWindUpHandler);
    router.post('/api/enterprise/:treasury/wind-up/cancel', cancelWindUpHandler);

    // Finalise wind-up after 7-day grace period and 0 open escrows (keeper / admin)
    const finaliseWindUpHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        const actor = requireKeeperOrAdmin(ctx, treasury);
        if (!actor) return;
        try {
            const res = finaliseWindUp(treasury, actor);
            ctx.body = {
                success: true,
                status: res.status,
                finalisedAt: res.finalisedAt,
                sweptAmount: res.sweptAmount,
                alreadyCompleted: !!res.alreadyCompleted,
            };
        } catch (e: any) {
            const isAuth = /Not authorised/.test(e?.message || '');
            ctx.status = isAuth ? 403 : 400;
            ctx.body = { error: e.message || 'Failed to finalise wind-up' };
        }
    };
    router.post('/api/treasury/:treasury/wind-up/finalise', finaliseWindUpHandler);
    router.post('/api/enterprise/:treasury/wind-up/finalise', finaliseWindUpHandler);

    // Read-only accountability ledger (public to all node members)
    const getLedgerHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        const { since, until, limit } = ctx.query;
        try {
            const ledger = getEnterpriseLedger(treasury, {
                since: since ? String(since) : undefined,
                until: until ? String(until) : undefined,
                limit: limit ? Number(limit) : undefined,
            });
            ctx.body = ledger;
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to retrieve enterprise ledger' };
        }
    };
    router.get('/api/treasury/:treasury/ledger', getLedgerHandler);
    router.get('/api/enterprise/:treasury/ledger', getLedgerHandler);

    return router;
}
