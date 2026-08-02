/**
 * Commissioning across a boundary — Half B, the redemption (#143, slice step 5).
 *
 * Spec: docs/federation-connector.md §3 (Half B), §7 (second round of resolutions), §8 step 5.
 *
 * WHY THIS EXISTS AT ALL, in the spec's own words: **"Half A without Half B is a number that only grows."**
 * A bridge tab records that one community has delivered real work and had none back. That tally is worth
 * nothing unless the community holding it can *use* it — which it does by commissioning work from its
 * partner's members, paid in beans it now effectively holds. The tab then nets down as a side effect of
 * ordinary trade; there is no "settlement transaction" to write, and this module writes none.
 *
 * MECHANICALLY THIS IS AN ORDINARY CROSS-NODE PURCHASE IN THE REVERSE DIRECTION. Everything under it —
 * escrow, the receipt exchange, compensating reversals, boot recovery, the peer's own cap check — is Half A
 * and is reused unchanged. What is new is only *who buys* and *where the beans come from*:
 *
 *   the buyer   the link's own enterprise (`is_treasury=1`), acting for the community
 *   the funding the Commons pot, because §2.2 is explicit that the bridge row itself cannot be spent
 *   the limit   the keeper's commissioning ceiling, measured against the tab
 *
 * ─── THE ALLOWANCE, which is the one piece of arithmetic worth reading twice ───────────────────────────
 *
 *     allowance = ceiling − energyBalanceExact(peerId)
 *
 * One expression, and every case it has to cover falls out of it. Remember the sign: **positive = we owe
 * them**, negative = they owe us.
 *
 *   | tab   | ceiling | allowance | why that is right                                                    |
 *   |-------|---------|-----------|----------------------------------------------------------------------|
 *   | −480  | 0       | 480       | pure redemption. Calling in a favour we are owed needs no permission. |
 *   | 0     | 0       | 0         | square with them and no ceiling set → the keeper may do nothing.      |
 *   | 0     | 500     | 500       | the ceiling is discretion to open a *fresh* tab.                      |
 *   | +500  | 500     | 0         | ceiling reached. This is the cumulative bound.                        |
 *   | −480  | 500     | 980       | redeem the 480, plus 500 of discretion.                               |
 *
 * IT HAD TO BE CUMULATIVE, not per-commission, and that is not a stylistic preference. `settlementCapacity`
 * bounds only the NEGATIVE side of a bridge — credit we extend — and says so emphatically, because a check
 * on the absolute value would freeze a drained community permanently. Commissioning drives the tab POSITIVE,
 * so it passes that check untouched at any size. A per-commission ceiling of 500 would therefore permit 500
 * a thousand times over: not a safety, a formality. Subtracting the live tab makes each commission consume
 * the allowance it used, which is what "the ceiling is the safety" has to mean to be true.
 *
 * A ceiling of 0 — the default every link is created with — still permits redemption, and that is
 * deliberate. Redemption is the behaviour the whole document is arguing for; making it wait on an operator
 * setting a number would leave every new link a ratchet, which is the exact failure Half B exists to fix.
 * What a 0 ceiling forbids is going *beyond* what we are owed.
 *
 * `energyBalanceExact`, never `getEnergyBalance`: the 2dp display rounding is what let a cap be exceeded
 * once already (see that function's docstring), and this is an enforcement path.
 */

import { db } from './db/db.js';
import { energyBalanceExact } from './federation-bridge.js';
import { getFederationLink, type FederationLink } from './federation-link.js';
import { getConnectors } from './connector-manager.js';
import { payFromCommons, getCommonsBalanceExact } from './state-engine.js';
import { crossNodeFee } from './federation-settlement-exchange.js';
import { logger } from './logger.js';

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface CommissionCapacity {
    peerId: string;
    treasuryPubkey: string;
    /** The link's display name — "eastgippy Link". */
    name: string;
    /**
     * The peer's public URL, which is what a cached listing carries in `origin_node`.
     *
     * Here so the client can match a listing on its board to the link that could commission it. The peer id
     * cannot do that job: a post records where it came from, not who it came from, and asking the client to
     * derive one from the other would put a second copy of that mapping in the browser.
     *
     * Null for a peer configured by multiaddr with no derivable URL — in which case its listings could not
     * have been cached under an origin_node either, so nothing is lost.
     */
    originNode: string | null;
    /** The tab, SIGNED and exact. Positive = we owe them, negative = they owe us. */
    energyBalance: number;
    ceiling: number;
    /** `ceiling − energyBalance`, floored at 0. The most that may be commissioned right now, fee included. */
    allowance: number;
    /** Of that allowance, how much is credit we have already earned rather than fresh discretion. */
    redeemable: number;
    /** Beans the link enterprise already holds — spent before the Commons is touched. */
    treasuryBalance: number;
    commonsBalance: number;
}

/**
 * `ceiling − tab`, floored at 0. THE one definition of the allowance.
 *
 * Exported because the Commons list needs the same number on every link card and must not recompute it: the
 * card is where a keeper decides whether to press the button, and a card disagreeing with the route that
 * enforces it is worse than a card showing nothing. The list path reads its balances in a single batched
 * query and passes them here, so sharing the rule costs it no extra round trip.
 *
 * Floored rather than allowed negative: a tab already past the ceiling — an operator LOWERED it after
 * commissioning, which is a legitimate thing to do — must read as "nothing available", not as a negative a
 * caller might subtract somewhere and turn back into room.
 */
export function commissionAllowanceFor(ceiling: number, energyBalance: number): number {
    return Math.max(0, round4(ceiling - energyBalance));
}

/** What a keeper of this link may commission right now, or null when the peer has no link. */
export function commissionCapacity(peerId: string): CommissionCapacity | null {
    const link = getFederationLink(peerId);
    if (!link) return null;
    return capacityFor(link);
}

function capacityFor(link: FederationLink): CommissionCapacity {
    const tab = energyBalanceExact(link.peerId);
    return {
        peerId: link.peerId,
        treasuryPubkey: link.treasuryPubkey,
        name: link.name,
        originNode: getConnectors().find(c => c.peerId === link.peerId)?.publicUrl ?? null,
        energyBalance: round4(tab),
        ceiling: link.commissionCeiling,
        allowance: commissionAllowanceFor(link.commissionCeiling, tab),
        redeemable: Math.max(0, round4(-tab)),
        treasuryBalance: link.treasuryBalance,
        commonsBalance: round2(getCommonsBalanceExact()),
    };
}

export type CommissionRefusal =
    | { ok: false; reason: 'no_link'; message: string }
    | { ok: false; reason: 'over_allowance'; allowance: number; needed: number; message: string }
    | { ok: false; reason: 'commons_short'; shortfall: number; commonsBalance: number; message: string };

export type CommissionFunding =
    | { ok: true; total: number; amount: number; fee: number; drawnFromCommons: number; capacity: CommissionCapacity }
    | CommissionRefusal;

export type CommissionAllowance =
    | { ok: true; total: number; amount: number; fee: number; capacity: CommissionCapacity }
    | CommissionRefusal;

/**
 * Is this commission within the allowance? A PURE READ — it moves nothing.
 *
 * Split out from `fundCommission` because of where the two belong in a route. Funding has to be the LAST
 * thing that happens, after even the transport check, so that nothing is drawn for a commission that cannot
 * start. But an over-allowance refusal is deterministic and actionable where "the transport is down" is
 * transient and is not — and a keeper who is over their allowance is over it whether the network is up or
 * not, so reporting the transient problem first hides the permanent one. Found by a test asserting a 409 and
 * getting a 503.
 *
 * `fundCommission` re-checks through this same function rather than trusting a caller to have done it: this
 * is a convenience for ordering, not the enforcement point.
 */
export function checkCommissionAllowance(peerId: string, amount: number): CommissionAllowance {
    const link = getFederationLink(peerId);
    if (!link) return noLink();

    const capacity = capacityFor(link);
    const fee = crossNodeFee(amount);
    const total = round4(amount + fee);

    if (total > capacity.allowance) {
        return {
            ok: false,
            reason: 'over_allowance',
            allowance: round2(capacity.allowance),
            needed: round2(total),
            // Named in terms of the two things a keeper can actually act on: what is owed, and the ceiling
            // somebody set. "Allowance exceeded" tells them a number moved without telling them which one.
            message: capacity.ceiling === 0 && capacity.redeemable === 0
                ? `${link.name} is square with us — there is no credit to call in, and no commissioning ceiling has been set for it. An operator can set one in Settings.`
                : `That is more than ${link.name} can commission right now (${round2(total)} needed, ${round2(capacity.allowance)} available — ${round2(capacity.redeemable)} of credit owed to us plus a ceiling of ${capacity.ceiling}).`,
        };
    }
    return { ok: true, total, amount: round4(amount), fee, capacity };
}

const noLink = (): CommissionRefusal => ({
    ok: false,
    reason: 'no_link',
    message: 'That community has no link enterprise, so there is nothing to commission from. An operator sets a credit limit for them in Settings, which creates one.',
});

/**
 * Check the allowance and put the beans where the settlement path expects them. Nothing else.
 *
 * THE FEE IS INSIDE THE ALLOWANCE. `beginOutboundSettlement` escrows `amount + fee`, so funding only the
 * amount would refuse at the escrow with the beans already drawn from the Commons — and counting only the
 * amount against the ceiling would let a keeper spend slightly past it. Both are the same off-by-a-fee, and
 * they land in different places, so the total is what is checked and what is moved.
 *
 * THE ENTERPRISE'S OWN BALANCE IS SPENT FIRST, and this is what makes a refused commission self-correcting.
 * If settlement refuses or reverses after this point, escrow refunds to the enterprise rather than to the
 * Commons — beans nobody has lost (conservation holds and the card shows them) but which are sitting one
 * step from where they started. Drawing only the shortfall means the next commission consumes them before
 * touching the pot, so the residue drains itself instead of needing a sweep nobody would remember to run.
 *
 * CALL THIS LAST. It is the first thing in the whole flow that moves value, so every refusal that can be
 * decided without it belongs above it — the same ordering rule the purchase route states and for the same
 * reason: a refusal that costs the community nothing needs no compensating entry.
 */
export function fundCommission(peerId: string, amount: number): CommissionFunding {
    const link = getFederationLink(peerId);
    if (!link) return noLink();

    // Re-checked HERE and not trusted to the caller. The route calls the same function earlier so it can
    // report a deterministic refusal ahead of a transient one, but this is the point where value is drawn, so
    // this is where the allowance has to hold. Between the two calls a settlement could have moved the tab.
    const allowed = checkCommissionAllowance(peerId, amount);
    if (!allowed.ok) return allowed;
    const { total, fee, capacity } = allowed;

    // What the enterprise still needs on top of what it already holds.
    const shortfall = round4(Math.max(0, total - link.treasuryBalance));
    if (shortfall > 0 && shortfall > round4(getCommonsBalanceExact())) {
        return {
            ok: false,
            reason: 'commons_short',
            shortfall: round2(shortfall),
            commonsBalance: round2(getCommonsBalanceExact()),
            // NOT `allowDeficit`. A commission is a discretionary act by one person; pushing the community's
            // Commons into deficit for it is not theirs to decide, and unlike a reversal's stranded fee there
            // is no worse outcome on the other side of refusing. The pot is what the community has collected.
            message: `${link.name} needs ${round2(shortfall)} more than the Commons pot holds (${round2(getCommonsBalanceExact())}). The pot fills from fees and demurrage; nothing has been moved.`,
        };
    }

    let drawnFromCommons = 0;
    if (shortfall > 0) {
        const paid = payFromCommons(
            link.treasuryPubkey, shortfall,
            `Commissioning across the ${link.name} boundary`,
        );
        if (!paid) {
            // Re-checked above, so reaching here means the pot moved underneath us. Refuse rather than force
            // it: the caller has not escrowed anything yet.
            return {
                ok: false,
                reason: 'commons_short',
                shortfall: round2(shortfall),
                commonsBalance: round2(getCommonsBalanceExact()),
                message: `The Commons pot could not cover ${round2(shortfall)} just now. Nothing has been moved.`,
            };
        }
        drawnFromCommons = shortfall;
    }

    logger.info('P2P', `[Commission] ${link.name}: funding ${total} (${drawnFromCommons} from the Commons, `
        + `${round4(total - drawnFromCommons)} already held) — tab ${round2(capacity.energyBalance)}, ceiling ${capacity.ceiling}`);

    return { ok: true, total, amount: round4(amount), fee, drawnFromCommons, capacity };
}

/**
 * The peer a cached listing came from, resolved from its `origin_node`, or null.
 *
 * A commission names a listing, not a peer — the keeper is looking at a card on their own board. This maps
 * that back to the connector, and it is the reason a commission cannot be aimed at a community we do not
 * settle with: the mapping simply fails.
 *
 * Deliberately keyed on `posts.origin_node` rather than on anything in the request. The client may name a
 * post; which peer that charges against is ours to decide, exactly as the purchase route resolves the
 * connector itself rather than trusting the `nodeUrl` it was handed.
 */
export function originOfCachedPost(postId: string): { originNode: string; authorPublicKey: string; credits: number; title: string } | null {
    if (!postId) return null;
    const row = db.prepare(`
        SELECT origin_node, author_pubkey, credits, title
        FROM posts
        WHERE id = ? AND origin_node IS NOT NULL AND active = 1 AND status = 'active'
    `).get(postId) as any;
    if (!row?.origin_node) return null;
    return {
        originNode: row.origin_node,
        authorPublicKey: row.author_pubkey,
        credits: row.credits,
        title: row.title,
    };
}
