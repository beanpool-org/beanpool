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
    setEnterpriseLocation, clearEnterpriseLocation,
    getEnterpriseFloor, getAvailableBacking, getEnterprisePledges, getKeeperPledges,
    pledgeEnterpriseBacking, releaseEnterpriseBacking,
    isLeadOrSoleKeeperOrAdmin, requestToJoinEnterprise, getKeeperRequests, approveKeeperRequest, declineKeeperRequest,
    getLeadInactivity, proposeLeadSuccession, voteLeadSuccession, getSuccessionProposals,
    ensureEnterpriseThread, getEnterpriseThreadMessages, postEnterpriseThreadMessage, removeEnterpriseThreadMessage,
    isKeeperOfEnterprise,
} from '../state-engine.js';
import { db, pledgeToProject, getCrowdfundProject } from '../db/db.js';
import { getLinkByTreasury, listFederationLinks } from '../federation-link.js';
import { commissionAllowanceFor } from '../federation-commission.js';
import { blockCrossNodeSettlement } from '../federation-settlement.js';
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
    // Only an EXPLICIT suspension refuses. A missing row means "not a suspended member".
    const blocked = (s?: string) => s === 'disabled' || s === 'suspended' || s === 'pruned';
    const requireOperator = (ctx: any, treasury: string): string | null => {
        const actor = ctx.state?.actor;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return null; }
        if (!actor || !canOperateTreasury(actor, treasury)) {
            ctx.status = 403;
            ctx.body = { error: 'You are not a keeper of this enterprise' };
            return null;
        }
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

    /**
     * Authorisation guard for lifecycle mutations (pause, resume, initiateWindUp, cancelWindUp, finaliseWindUp).
     * Requires the actor to be an authorised keeper or node admin.
     * Also checks that both enterprise and actor are not explicitly suspended or pruned.
     */
    const requireKeeperOrAdmin = (ctx: any, treasury: string) => {
        const actor = ctx.state?.actor;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return null; }
        if (!actor || !canAdministerTreasury(actor, treasury)) {
            ctx.status = 403;
            ctx.body = { error: 'Only a keeper of this enterprise (or node admin) may perform this action' };
            return null;
        }
        const blocked = (s?: string) => s === 'disabled' || s === 'suspended' || s === 'pruned' || s === 'completed';
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
        const includeBounded = ctx.query?.includeBounded === 'true';
        const whereClause = includeBounded
            ? "is_treasury = 1 AND status NOT IN ('pruned', 'deleted')"
            : "is_treasury = 1 AND (lifecycle IS NULL OR lifecycle != 'bounded') AND status NOT IN ('pruned', 'deleted')";
        const rows = db.prepare(
            `SELECT public_key, callsign, avatar_url, earned_credit, legacy_credit_floor, earned_surplus, working_capital_ceiling, purpose, goal_amount, deadline_at, lifecycle, status, paused, paused_at, paused_by, paused_floor_snapshot, wind_up_initiated_at, wind_up_initiated_by, wind_up_finalised_at, lat, lng, location_auth_signer, auth_signer, location_updated_at FROM members WHERE ${whereClause} ORDER BY callsign COLLATE NOCASE`
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

                const floorInfo = getEnterpriseFloor(r.public_key);
                // #143 step 3: a federation link is an enterprise, so it appears in this list like any
                // other — but it carries a SECOND number that must never be added to its balance. The
                // energy balance is the `bridge_<peer>` tab: what the two communities owe each other, and
                // not spendable (federation-economics.md §2.2). `link` is undefined for an ordinary
                // enterprise, which serialises to an absent field — same thing to a client as the null the
                // detail read returns.
                const link = linksByTreasury.get(r.public_key);
                let currentAmount: number | null = null;
                if (r.goal_amount != null) {
                    const pRow = db.prepare("SELECT current_amount FROM projects WHERE id = ?").get(r.public_key) as any;
                    const escBal = (db.prepare("SELECT balance FROM accounts WHERE public_key = ?").get(`escrow_${r.public_key}`) as any)?.balance || 0;
                    currentAmount = Math.max(Number(pRow?.current_amount || 0), Number(escBal));
                }
                return {
                    publicKey: r.public_key, name: r.callsign,
                    callsign: r.callsign,
                    avatar: r.avatar_url
                        ? (r.avatar_url.startsWith('bundled://')
                            ? r.avatar_url
                            : `/api/avatar/${r.public_key}?size=thumb`)
                        : null,
                    avatarUrl: r.avatar_url,
                    balance: b.balance, creditLine: b.earnedCredit, floor: b.floor, usableFloor: b.usableFloor,
                    allowance: floorInfo.allowance,
                    derivedAllowance: floorInfo.derivedAllowance,
                    legacyFloor: floorInfo.legacyFloor,
                    legacyCreditFloor: floorInfo.legacyFloor,
                    liveOffers: b.liveOffers,
                    earnedSurplus: r.earned_surplus ?? 0,
                    workingCapitalCeiling: r.working_capital_ceiling ?? null,
                    purpose: r.purpose ?? null,
                    goalAmount: r.goal_amount != null ? Number(r.goal_amount) : null,
                    currentAmount,
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
                    lat: r.lat != null ? Number(r.lat) : null,
                    lng: r.lng != null ? Number(r.lng) : null,
                    locationAuthSigner: r.location_auth_signer ?? r.auth_signer ?? null,
                    locationUpdatedAt: r.location_updated_at ?? null,
                    // #106: lets the Commons list say "Kept by doone" / "No steward yet"
                    // without an extra round trip per enterprise.
                    keepers: treasuryKeepers(r.public_key),
                    pledges: getEnterprisePledges(r.public_key),
                    link: link && linkShape(link),
                };
            }),
        };
    };
    router.get('/api/treasuries', listTreasuriesHandler);
    router.get('/api/enterprises', listTreasuriesHandler);

    // Lightweight statuses endpoint for marketplace / search / map filtering without balance computation & keeper lookups
    const listEnterpriseStatusesHandler = async (ctx: any) => {
        const rows = db.prepare(
            "SELECT public_key, callsign, paused, status FROM members WHERE is_treasury = 1 AND (status IS NULL OR status NOT IN ('pruned', 'deleted'))"
        ).all() as any[];
        ctx.body = {
            enterprises: rows.map(r => ({
                publicKey: r.public_key,
                name: r.callsign || 'Unnamed',
                paused: r.paused === 1,
                status: r.status || 'active',
            })),
        };
    };
    router.get('/api/enterprises/statuses', listEnterpriseStatusesHandler);
    router.get('/api/treasuries/statuses', listEnterpriseStatusesHandler);

    // Enterprise map endpoint (docs/the-commons.md §2.2, Slice 6)
    // Only includes enterprises with a set location; excludes completed enterprises
    const listEnterpriseMapPinsHandler = async (ctx: any) => {
        const rows = db.prepare(
            `SELECT public_key, callsign, avatar_url, purpose, lat, lng, paused, status, wind_up_finalised_at
             FROM members
             WHERE is_treasury = 1
               AND lat IS NOT NULL
               AND lng IS NOT NULL
               AND wind_up_finalised_at IS NULL
               AND (status IS NULL OR status NOT IN ('completed', 'pruned', 'deleted'))
             ORDER BY callsign COLLATE NOCASE`
        ).all() as any[];
        ctx.body = {
            enterprises: rows.map(r => ({
                publicKey: r.public_key,
                name: r.callsign || 'Unnamed',
                callsign: r.callsign || 'Unnamed',
                avatar: r.avatar_url
                    ? (r.avatar_url.startsWith('bundled://')
                        ? r.avatar_url
                        : `/api/avatar/${r.public_key}?size=thumb`)
                    : null,
                avatarUrl: r.avatar_url,
                purpose: r.purpose ?? null,
                lat: Number(r.lat),
                lng: Number(r.lng),
                paused: r.paused === 1,
                status: r.status || (r.paused === 1 ? 'paused' : 'active'),
            })),
        };
    };
    router.get('/api/enterprises/map', listEnterpriseMapPinsHandler);
    router.get('/api/map/enterprises', listEnterpriseMapPinsHandler);
    router.get('/api/treasuries/map', listEnterpriseMapPinsHandler);

    const getTreasuryHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        const m = db.prepare("SELECT callsign, avatar_url, earned_surplus, working_capital_ceiling, purpose, goal_amount, deadline_at, lifecycle, status, paused, paused_at, paused_by, paused_floor_snapshot, wind_up_initiated_at, wind_up_initiated_by, wind_up_finalised_at, lat, lng, location_auth_signer, auth_signer, location_updated_at FROM members WHERE public_key=? AND is_treasury=1 AND status NOT IN ('pruned', 'deleted')").get(treasury) as any;
        if (!m) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        const b = getBalance(treasury);
        const floorInfo = getEnterpriseFloor(treasury);

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
        let currentAmount: number | null = null;
        if (m.goal_amount != null) {
            const pRow = db.prepare("SELECT current_amount FROM projects WHERE id = ?").get(treasury) as any;
            const escBal = (db.prepare("SELECT balance FROM accounts WHERE public_key = ?").get(`escrow_${treasury}`) as any)?.balance || 0;
            currentAmount = Math.max(Number(pRow?.current_amount || 0), Number(escBal));
        }

        ctx.body = {
            publicKey: treasury, name: m.callsign,
            callsign: m.callsign,
            avatar: m.avatar_url
                ? (m.avatar_url.startsWith('bundled://')
                    ? m.avatar_url
                    : `/api/avatar/${treasury}?size=thumb`)
                : null,
            avatarUrl: m.avatar_url,
            balance: b.balance, creditLine: b.earnedCredit, floor: b.floor, usableFloor: b.usableFloor,
            allowance: floorInfo.allowance,
            derivedAllowance: floorInfo.derivedAllowance,
            legacyFloor: floorInfo.legacyFloor,
            legacyCreditFloor: floorInfo.legacyFloor,
            liveOffers: b.liveOffers, posts, flow, pendingBids, activeDeals,
            earnedSurplus: m.earned_surplus ?? 0,
            workingCapitalCeiling: m.working_capital_ceiling ?? null,
            purpose: m.purpose ?? null,
            goalAmount: m.goal_amount != null ? Number(m.goal_amount) : null,
            currentAmount,
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
            lat: m.lat != null ? Number(m.lat) : null,
            lng: m.lng != null ? Number(m.lng) : null,
            locationAuthSigner: m.location_auth_signer ?? m.auth_signer ?? null,
            locationUpdatedAt: m.location_updated_at ?? null,
            deferredClaims,
            // #106: who is accountable for this enterprise, public by design — a community should be
            // able to see who keeps what without asking an admin.
            keepers: treasuryKeepers(treasury),
            pledges: getEnterprisePledges(treasury),
            isLeadOrSoleKeeperOrAdmin: actor ? isLeadOrSoleKeeperOrAdmin(treasury, actor) : false,
            availableToBack: actor ? getAvailableBacking(actor, treasury) : null,
            keeperRequests: actor && isLeadOrSoleKeeperOrAdmin(treasury, actor)
                ? getKeeperRequests(treasury, 'pending')
                : [],
            myPendingRequest: actor
                ? (getKeeperRequests(treasury, 'pending').find(r => r.memberPubkey === actor) || null)
                : null,
            leadInactivity: getLeadInactivity(treasury),
            succession: getSuccessionProposals(treasury),
            // #143 step 3 — see the note in /api/treasuries. Null for an ordinary enterprise.
            link: linkDetail(treasury),
        };
    };
    router.get('/api/treasury/:treasury', getTreasuryHandler);
    router.get('/api/enterprise/:treasury', getTreasuryHandler);

    const crowdfundPledgeHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return;
        }
        if (statusOf(treasury) !== 'active') {
            ctx.status = 403;
            ctx.body = { error: 'This enterprise has been closed, so its funds can no longer be moved.' };
            return;
        }
        if (statusOf(actor) !== 'active') {
            ctx.status = 403;
            ctx.body = { error: 'Only active community members can pledge.' };
            return;
        }
        if (blockCrossNodeSettlement(ctx, actor)) return;

        const body = (ctx as any).requestBody || {};
        const { amount, memo } = body;
        const parsedAmount = Number(amount);
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            ctx.status = 400;
            ctx.body = { error: 'A positive amount is required' };
            return;
        }
        try {
            const txId = crypto.randomUUID();
            pledgeToProject(txId, treasury, actor, parsedAmount, memo || 'Enterprise Pledge', (ctx.state as any)?.authSig);
            deps.broadcast?.({ type: 'project_updated', project: getCrowdfundProject(treasury) });
            ctx.body = { success: true, txId };
        } catch (err: any) {
            ctx.status = 400;
            ctx.body = { error: err.message };
        }
    };

    // ---- Authenticated Enterprise Creation (docs/the-commons.md §2.1) -------------------
    const createEnterpriseHandler = async (ctx: any) => {
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return;
        }

        const memberStatus = statusOf(actor);
        if (memberStatus !== 'active') {
            ctx.status = 403;
            ctx.body = { error: 'Only active community members can create an enterprise' };
            return;
        }

        const body = (ctx as any).requestBody || {};
        const { name, title, avatar, photos, workingCapitalCeiling, purpose, description, lifecycle, goalAmount, deadlineAt, lat, lng } = body;
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
        const parsedLat = lat != null && lat !== '' ? Number(lat) : null;
        const parsedLng = lng != null && lng !== '' ? Number(lng) : null;

        try {
            const res = createTreasury(
                enterpriseName,
                photoUrl || '',
                0, // Member-created enterprises must start with 0 credit line (Rule 1)
                {
                    systemCreated: !photoUrl,
                    workingCapitalCeiling: workingCapitalCeiling != null ? Number(workingCapitalCeiling) : null,
                    purpose: enterprisePurpose,
                    lifecycle: parsedLifecycle,
                    goalAmount: parsedGoal,
                    deadlineAt: parsedDeadline,
                    leadKeeperPubkey: actor,
                    lat: parsedLat,
                    lng: parsedLng,
                    locationAuthSigner: parsedLat != null ? actor : undefined,
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
        const { name, avatar, creditLine, workingCapitalCeiling, purpose } = (ctx as any).requestBody || {};
        if (!name || !avatar) { ctx.status = 400; ctx.body = { error: 'name and avatar are required' }; return; }
        try {
            ctx.body = {
                success: true,
                ...createTreasury(
                    String(name),
                    String(avatar),
                    Number(creditLine) || 0,
                    {
                        workingCapitalCeiling: workingCapitalCeiling !== undefined && workingCapitalCeiling !== null ? Number(workingCapitalCeiling) : null,
                        purpose: purpose ? String(purpose) : undefined,
                    }
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

    // Set or clear enterprise location (keeper / admin)
    const setLocationHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        let actor = ctx.state?.actor;
        let authSigner = (ctx.state as any)?.auth_signer || actor;
        if (ctx.path?.startsWith('/api/local/admin/')) {
            if (!(await checkAdminAuth(ctx))) return;
            authSigner = ctx.state?.auth_signer || ctx.state?.actor || 'admin';
            actor = ctx.state?.actor || authSigner;
            if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        } else {
            actor = requireKeeperOrAdmin(ctx, treasury);
            if (!actor) return;
            authSigner = authSigner || actor;
        }

        const body = (ctx as any).requestBody || {};
        let { lat, lng } = body;
        if (lat === '' || lat === undefined) lat = null;
        if (lng === '' || lng === undefined) lng = null;

        try {
            const res = setEnterpriseLocation(
                treasury,
                authSigner,
                (lat != null || lng != null) ? { lat, lng } : null
            );
            ctx.body = {
                success: true,
                lat: res.lat,
                lng: res.lng,
                locationAuthSigner: res.locationAuthSigner,
                locationUpdatedAt: res.locationUpdatedAt,
            };
        } catch (e: any) {
            const isAuth = /Only a keeper/.test(e?.message || '') || /Not authorised/.test(e?.message || '');
            ctx.status = isAuth ? 403 : 400;
            ctx.body = { error: e.message || 'Failed to update enterprise location' };
        }
    };

    const clearLocationHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        let actor = ctx.state?.actor;
        let authSigner = (ctx.state as any)?.auth_signer || actor;
        if (ctx.path?.startsWith('/api/local/admin/')) {
            if (!(await checkAdminAuth(ctx))) return;
            authSigner = ctx.state?.auth_signer || ctx.state?.actor || 'admin';
            actor = ctx.state?.actor || authSigner;
            if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        } else {
            actor = requireKeeperOrAdmin(ctx, treasury);
            if (!actor) return;
            authSigner = authSigner || actor;
        }

        try {
            const res = clearEnterpriseLocation(treasury, authSigner);
            ctx.body = {
                success: true,
                lat: null,
                lng: null,
                locationAuthSigner: res.locationAuthSigner,
                locationUpdatedAt: res.locationUpdatedAt,
            };
        } catch (e: any) {
            const isAuth = /Only a keeper/.test(e?.message || '') || /Not authorised/.test(e?.message || '');
            ctx.status = isAuth ? 403 : 400;
            ctx.body = { error: e.message || 'Failed to clear enterprise location' };
        }
    };

    router.post('/api/enterprise/:treasury/location', setLocationHandler);
    router.post('/api/treasury/:treasury/location', setLocationHandler);
    router.delete('/api/enterprise/:treasury/location', clearLocationHandler);
    router.delete('/api/treasury/:treasury/location', clearLocationHandler);
    router.post('/api/local/admin/treasury/:treasury/location', setLocationHandler);
    router.delete('/api/local/admin/treasury/:treasury/location', clearLocationHandler);

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

    // ---- Backing pledges (docs/the-commons.md §2.4 Rules 1-4, §6 Slice 4) ----------------
    // Get active backing pledges for an enterprise
    const getPledgesHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        const actor = ctx.state?.actor;
        const floorInfo = getEnterpriseFloor(treasury);
        ctx.body = {
            pledges: getEnterprisePledges(treasury),
            floor: floorInfo.floor,
            allowance: floorInfo.allowance,
            derivedAllowance: floorInfo.derivedAllowance,
            legacyFloor: floorInfo.legacyFloor,
            availableToBack: actor ? getAvailableBacking(actor, treasury) : null,
        };
    };
    router.get('/api/treasury/:treasury/pledges', getPledgesHandler);
    router.get('/api/treasury/:treasury/backing', getPledgesHandler);

    // Pledge backing from a keeper's earned credit
    const backingPledgeHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        const actor = requireOperator(ctx, treasury);
        if (!actor) return;
        const { amount } = (ctx as any).requestBody || {};
        const parsedAmount = Number(amount);
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            ctx.status = 400;
            ctx.body = { error: 'amount must be a positive number' };
            return;
        }
        try {
            const pledge = pledgeEnterpriseBacking(treasury, actor, parsedAmount);
            const floorInfo = getEnterpriseFloor(treasury);
            ctx.body = {
                success: true,
                pledge,
                floor: floorInfo.floor,
                allowance: floorInfo.allowance,
                derivedAllowance: floorInfo.derivedAllowance,
                legacyFloor: floorInfo.legacyFloor,
                availableToBack: getAvailableBacking(actor, treasury),
            };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to pledge backing' };
        }
    };

    // Unified pledge handler: dispatches to crowdfund pledge or keeper backing pledge
    const pledgeDispatchHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        const body = (ctx as any).requestBody || {};
        if (body.type === 'backing') {
            return backingPledgeHandler(ctx);
        }
        if (body.memo !== undefined) {
            return crowdfundPledgeHandler(ctx);
        }
        const ent = db.prepare('SELECT goal_amount, lifecycle FROM members WHERE public_key=? AND is_treasury=1').get(treasury) as any;
        if (ent && ent.goal_amount != null) {
            return crowdfundPledgeHandler(ctx);
        }
        return backingPledgeHandler(ctx);
    };

    router.post('/api/treasury/:treasury/pledge', pledgeDispatchHandler);
    router.post('/api/enterprise/:treasury/pledge', pledgeDispatchHandler);
    router.post('/api/treasury/:treasury/backing', backingPledgeHandler);
    router.post('/api/enterprise/:treasury/backing', backingPledgeHandler);

    // Release backing pledge (gated by keepership or active pledge, and deficit covenant)
    const releaseHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        if (!isTreasury(treasury)) {
            ctx.status = 404;
            ctx.body = { error: 'Not a treasury' };
            return;
        }
        const actor = ctx.state?.actor;
        if (!actor) {
            ctx.status = 403;
            ctx.body = { error: 'You are not an authorized keeper or pledge holder of this enterprise' };
            return;
        }

        const isOp = canOperateTreasury(actor, treasury);
        const hasActivePledge = !!db.prepare(
            "SELECT 1 FROM enterprise_pledges WHERE enterprise = ? AND keeper = ? AND released_at IS NULL"
        ).get(treasury, actor);

        if (!isOp && !hasActivePledge) {
            ctx.status = 403;
            ctx.body = { error: 'You are not an authorized keeper or pledge holder of this enterprise' };
            return;
        }

        const blocked = (s?: string) => s === 'disabled' || s === 'suspended' || s === 'pruned';
        if (blocked(statusOf(actor))) {
            ctx.status = 403;
            ctx.body = { error: 'Your account is not active, so you cannot act for this enterprise.' };
            return;
        }

        const { amount } = (ctx as any).requestBody || {};
        const parsedAmount = (amount !== undefined && amount !== null) ? Number(amount) : undefined;
        if (parsedAmount !== undefined && (!Number.isFinite(parsedAmount) || parsedAmount <= 0)) {
            ctx.status = 400;
            ctx.body = { error: 'amount must be a positive number' };
            return;
        }
        try {
            const res = releaseEnterpriseBacking(treasury, actor, parsedAmount);
            const floorInfo = getEnterpriseFloor(treasury);
            ctx.body = {
                success: true,
                releasedAmount: res.releasedAmount,
                remainingPledge: res.remainingPledge,
                floor: floorInfo.floor,
                allowance: floorInfo.allowance,
                derivedAllowance: floorInfo.derivedAllowance,
                legacyFloor: floorInfo.legacyFloor,
                availableToBack: getAvailableBacking(actor, treasury),
            };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to release backing' };
        }
    };
    router.post('/api/treasury/:treasury/release', releaseHandler);
    router.delete('/api/treasury/:treasury/pledge', releaseHandler);
    router.post('/api/treasury/:treasury/pledge/release', releaseHandler);
    router.delete('/api/treasury/:treasury/backing', releaseHandler);
    router.post('/api/treasury/:treasury/backing/release', releaseHandler);
    router.post('/api/enterprise/:treasury/release', releaseHandler);
    router.delete('/api/enterprise/:treasury/pledge', releaseHandler);
    router.post('/api/enterprise/:treasury/pledge/release', releaseHandler);
    router.delete('/api/enterprise/:treasury/backing', releaseHandler);
    router.post('/api/enterprise/:treasury/backing/release', releaseHandler);

    // ---- Keeper Join Requests (docs/the-commons.md §2.3, §2.4 Rule 3) ------------------
    const requestJoinHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        const actor = ctx.state?.actor;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        if (!actor) { ctx.status = 401; ctx.body = { error: 'Authentication required' }; return; }
        if (blocked(statusOf(treasury))) {
            ctx.status = 403;
            ctx.body = { error: 'This enterprise has been closed, so it can no longer be joined.' };
            return;
        }
        if (blocked(statusOf(actor))) {
            ctx.status = 403;
            ctx.body = { error: 'Your account is not active, so you cannot act for this enterprise.' };
            return;
        }
        const { pledgedBacking, amount, backing } = (ctx as any).requestBody || {};
        const pledge = pledgedBacking ?? amount ?? backing ?? 0;
        try {
            const req = requestToJoinEnterprise(treasury, actor, pledge);
            ctx.body = { success: true, request: req };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to submit join request' };
        }
    };
    router.post('/api/treasury/:treasury/keepers/request', requestJoinHandler);
    router.post('/api/enterprise/:treasury/keepers/request', requestJoinHandler);

    const listKeeperRequestsHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        const actor = ctx.state?.actor;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        if (!actor) { ctx.status = 401; ctx.body = { error: 'Authentication required' }; return; }
        if (blocked(statusOf(treasury))) {
            ctx.status = 403;
            ctx.body = { error: 'This enterprise has been closed.' };
            return;
        }
        if (blocked(statusOf(actor))) {
            ctx.status = 403;
            ctx.body = { error: 'Your account is not active, so you cannot act for this enterprise.' };
            return;
        }
        if (!isLeadOrSoleKeeperOrAdmin(treasury, actor)) {
            ctx.status = 403;
            ctx.body = { error: 'Only the lead keeper, sole keeper, or admin may view keeper requests' };
            return;
        }
        const { status } = ctx.query;
        try {
            const requests = getKeeperRequests(treasury, status ? String(status) : undefined);
            ctx.body = { success: true, requests };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to list keeper requests' };
        }
    };
    router.get('/api/treasury/:treasury/keepers/requests', listKeeperRequestsHandler);
    router.get('/api/enterprise/:treasury/keepers/requests', listKeeperRequestsHandler);

    const approveKeeperRequestHandler = async (ctx: any) => {
        const { treasury, requestId } = ctx.params;
        const actor = ctx.state?.actor;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        if (!actor) { ctx.status = 401; ctx.body = { error: 'Authentication required' }; return; }
        if (blocked(statusOf(treasury))) {
            ctx.status = 403;
            ctx.body = { error: 'This enterprise has been closed, so its keepers can no longer be modified.' };
            return;
        }
        if (blocked(statusOf(actor))) {
            ctx.status = 403;
            ctx.body = { error: 'Your account is not active, so you cannot act for this enterprise.' };
            return;
        }
        try {
            const res = approveKeeperRequest(requestId, actor);
            ctx.body = { success: true, ...res };
        } catch (e: any) {
            const isAuth = /Only the lead keeper/.test(e?.message || '');
            ctx.status = isAuth ? 403 : 400;
            ctx.body = { error: e.message || 'Failed to approve keeper request' };
        }
    };
    router.post('/api/treasury/:treasury/keepers/requests/:requestId/approve', approveKeeperRequestHandler);
    router.post('/api/enterprise/:treasury/keepers/requests/:requestId/approve', approveKeeperRequestHandler);

    const declineKeeperRequestHandler = async (ctx: any) => {
        const { treasury, requestId } = ctx.params;
        const actor = ctx.state?.actor;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        if (!actor) { ctx.status = 401; ctx.body = { error: 'Authentication required' }; return; }
        if (blocked(statusOf(treasury))) {
            ctx.status = 403;
            ctx.body = { error: 'This enterprise has been closed, so its keepers can no longer be modified.' };
            return;
        }
        if (blocked(statusOf(actor))) {
            ctx.status = 403;
            ctx.body = { error: 'Your account is not active, so you cannot act for this enterprise.' };
            return;
        }
        try {
            const res = declineKeeperRequest(requestId, actor);
            ctx.body = { success: true, ...res };
        } catch (e: any) {
            const isAuth = /Only the lead keeper/.test(e?.message || '');
            ctx.status = isAuth ? 403 : 400;
            ctx.body = { error: e.message || 'Failed to decline keeper request' };
        }
    };
    router.post('/api/treasury/:treasury/keepers/requests/:requestId/decline', declineKeeperRequestHandler);
    router.post('/api/enterprise/:treasury/keepers/requests/:requestId/decline', declineKeeperRequestHandler);

    // ---- Lead Succession (docs/the-commons.md §2.3) -------------------------------------
    const getSuccessionHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        try {
            const data = getSuccessionProposals(treasury);
            ctx.body = { success: true, ...data };
        } catch (e: any) {
            ctx.status = 400;
            ctx.body = { error: e.message || 'Failed to get succession information' };
        }
    };
    router.get('/api/treasury/:treasury/succession', getSuccessionHandler);
    router.get('/api/enterprise/:treasury/succession', getSuccessionHandler);

    const proposeSuccessionHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        const actor = ctx.state?.actor;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        if (!actor) { ctx.status = 401; ctx.body = { error: 'Authentication required' }; return; }
        if (blocked(statusOf(treasury))) {
            ctx.status = 403;
            ctx.body = { error: 'This enterprise has been closed, so its lead role can no longer be modified.' };
            return;
        }
        if (blocked(statusOf(actor))) {
            ctx.status = 403;
            ctx.body = { error: 'Your account is not active, so you cannot act for this enterprise.' };
            return;
        }
        const { candidatePubkey } = (ctx as any).requestBody || {};
        if (!candidatePubkey) { ctx.status = 400; ctx.body = { error: 'candidatePubkey is required' }; return; }
        try {
            const res = proposeLeadSuccession(treasury, actor, candidatePubkey);
            ctx.body = {
                success: true,
                ...res,
                leadMoved: res.executed,
                votesCount: res.proposal.votesCount,
                votesRequired: res.proposal.requiredVotes,
                status: res.proposal.status,
            };
        } catch (e: any) {
            const isAuth = /Only an active keeper|Lead keeper cannot/.test(e?.message || '');
            ctx.status = isAuth ? 403 : 400;
            ctx.body = { error: e.message || 'Failed to propose lead succession' };
        }
    };
    router.post('/api/treasury/:treasury/succession/propose', proposeSuccessionHandler);
    router.post('/api/enterprise/:treasury/succession/propose', proposeSuccessionHandler);

    const voteSuccessionHandler = async (ctx: any) => {
        const { treasury, proposalId } = ctx.params;
        const actor = ctx.state?.actor;
        if (!isTreasury(treasury)) { ctx.status = 404; ctx.body = { error: 'Not a treasury' }; return; }
        if (!actor) { ctx.status = 401; ctx.body = { error: 'Authentication required' }; return; }
        if (blocked(statusOf(treasury))) {
            ctx.status = 403;
            ctx.body = { error: 'This enterprise has been closed, so its lead role can no longer be modified.' };
            return;
        }
        if (blocked(statusOf(actor))) {
            ctx.status = 403;
            ctx.body = { error: 'Your account is not active, so you cannot act for this enterprise.' };
            return;
        }
        try {
            const res = voteLeadSuccession(proposalId, actor);
            ctx.body = {
                success: true,
                ...res,
                leadMoved: res.executed,
                votesCount: res.proposal.votesCount,
                votesRequired: res.proposal.requiredVotes,
                status: res.proposal.status,
            };
        } catch (e: any) {
            const isAuth = /Only active keepers|Lead keeper cannot/.test(e?.message || '');
            ctx.status = isAuth ? 403 : 400;
            ctx.body = { error: e.message || 'Failed to vote on succession' };
        }
    };
    router.post('/api/treasury/:treasury/succession/:proposalId/vote', voteSuccessionHandler);
    router.post('/api/enterprise/:treasury/succession/:proposalId/vote', voteSuccessionHandler);

    // =========================================================================
    // Enterprise Discussion Thread (docs/the-commons.md §2.2, §9, Slice 6)
    // =========================================================================

    const threadGetHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        if (!isTreasury(treasury)) {
            ctx.status = 404;
            ctx.body = { error: 'Enterprise not found' };
            return;
        }
        const rawLimit = Number(ctx.query.limit);
        const rawOffset = Number(ctx.query.offset);
        const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(1, rawLimit), 100) : 50;
        const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

        const enterprise = db.prepare("SELECT status FROM members WHERE public_key = ?").get(treasury) as any;
        const readOnly = enterprise?.status === 'completed';

        const conversation = ensureEnterpriseThread(treasury);
        const messages = getEnterpriseThreadMessages(treasury, limit, offset);

        ctx.body = {
            conversation,
            messages,
            readOnly,
        };
    };
    router.get('/api/treasury/:treasury/thread', threadGetHandler);
    router.get('/api/enterprise/:treasury/thread', threadGetHandler);
    router.get('/api/enterprises/:treasury/thread', threadGetHandler);

    const threadPostHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        if (!isTreasury(treasury)) {
            ctx.status = 404;
            ctx.body = { error: 'Enterprise not found' };
            return;
        }
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return;
        }
        const blocked = (s?: string) => s === 'disabled' || s === 'suspended' || s === 'pruned' || s === 'completed';
        const actorStatus = statusOf(actor);
        if (!actorStatus || blocked(actorStatus)) {
            ctx.status = 403;
            ctx.body = { error: 'Your account is not active, so you cannot post in this thread.' };
            return;
        }
        const mRow = db.prepare("SELECT credit_frozen FROM members WHERE public_key = ?").get(actor) as any;
        if (mRow?.credit_frozen === 1) {
            ctx.status = 403;
            ctx.body = { error: 'Frozen members cannot post in discussion threads' };
            return;
        }

        const body = (ctx as any).requestBody || (ctx.request as any).body || {};
        const text = typeof body.text === 'string' ? body.text : (typeof body.message === 'string' ? body.message : '');

        let clientId: string | undefined;
        if (body.clientId !== undefined && body.clientId !== null) {
            if (typeof body.clientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.clientId)) {
                ctx.status = 400;
                ctx.body = { error: 'clientId must be a UUID v4' };
                return;
            }
            clientId = body.clientId.toLowerCase();
        }

        if (!text.trim()) {
            ctx.status = 400;
            ctx.body = { error: 'Message text cannot be empty' };
            return;
        }

        try {
            const message = postEnterpriseThreadMessage(treasury, actor, text, clientId);
            ctx.status = 201;
            ctx.body = {
                success: true,
                message,
            };
        } catch (e: any) {
            const msg = e?.message || 'Failed to post message';
            if (e?.code === 'ID_CONFLICT' || msg.includes('already exists')) {
                ctx.status = 409;
                ctx.body = { error: msg };
                return;
            }
            if (msg.includes('Enterprise not found')) {
                ctx.status = 404;
            } else if (msg.includes('Frozen') || msg.includes('disabled') || msg.includes('suspended') || msg.includes('pruned') || msg.includes('Device key has been invalidated') || msg.includes('Member not found')) {
                ctx.status = 403;
            } else if (msg.includes('read-only') || msg.includes('wound up')) {
                ctx.status = 400;
            } else {
                ctx.status = 400;
            }
            ctx.body = { error: msg };
        }
    };
    router.post('/api/treasury/:treasury/thread/message', threadPostHandler);
    router.post('/api/enterprise/:treasury/thread/message', threadPostHandler);
    router.post('/api/enterprises/:treasury/thread/message', threadPostHandler);

    const threadRemoveHandler = async (ctx: any) => {
        const { treasury } = ctx.params;
        if (!isTreasury(treasury)) {
            ctx.status = 404;
            ctx.body = { error: 'Enterprise not found' };
            return;
        }
        const actor = ctx.state?.actor as string | undefined;
        if (!actor) {
            ctx.status = 401;
            ctx.body = { error: 'Authentication required' };
            return;
        }
        if (!isKeeperOfEnterprise(actor, treasury)) {
            ctx.status = 403;
            ctx.body = { error: 'Only a keeper of this enterprise can remove messages from its thread' };
            return;
        }
        const blocked = (s?: string) => s === 'disabled' || s === 'suspended' || s === 'pruned' || s === 'completed';
        if (blocked(statusOf(actor))) {
            ctx.status = 403;
            ctx.body = { error: 'Your account is not active, so you cannot act for this enterprise.' };
            return;
        }

        const body = (ctx as any).requestBody || (ctx.request as any).body || {};
        const messageId = ctx.params.messageId || body.messageId || body.id;
        if (!messageId) {
            ctx.status = 400;
            ctx.body = { error: 'messageId is required' };
            return;
        }

        try {
            const message = removeEnterpriseThreadMessage(treasury, String(messageId), actor);
            ctx.body = {
                success: true,
                message,
            };
        } catch (e: any) {
            const msg = e?.message || 'Failed to remove message';
            if (msg.includes('Enterprise not found')) {
                ctx.status = 404;
            } else if (msg.includes('Only a keeper')) {
                ctx.status = 403;
            } else if (msg.includes('Message not found')) {
                ctx.status = 404;
            } else {
                ctx.status = 400;
            }
            ctx.body = { error: msg };
        }
    };
    router.post('/api/treasury/:treasury/thread/remove', threadRemoveHandler);
    router.post('/api/enterprise/:treasury/thread/remove', threadRemoveHandler);
    router.post('/api/enterprises/:treasury/thread/remove', threadRemoveHandler);
    router.delete('/api/treasury/:treasury/thread/message/:messageId', threadRemoveHandler);
    router.delete('/api/enterprise/:treasury/thread/message/:messageId', threadRemoveHandler);
    router.delete('/api/enterprises/:treasury/thread/message/:messageId', threadRemoveHandler);

    return router;
}
