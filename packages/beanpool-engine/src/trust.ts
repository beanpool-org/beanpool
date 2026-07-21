// Trust & fraud read core — the trust-floor formula and the wash/Sybil trade
// analysis that feeds it. Pure reads: nothing here mutates the database, so it
// is safe to run against a live node DB or a read-only replica alike.
//
// Extracted verbatim from apps/server/src/state-engine.ts (TRUST STATS section)
// so the node and the fleet manager compute an identical floor instead of the
// manager keeping a hand-copied, drift-prone reimplementation.
import type Database from 'better-sqlite3';
import { earnedCreditFromValue, getTier, PROTOCOL_CONSTANTS } from '@beanpool/core';
import type { TrustStats, TierInfo } from '@beanpool/core';

type Db = Database.Database;

// A2-26: cap how much volume to a SINGLE counterparty counts toward earned credit /
// governance credit, so a Sybil pair can't wash-trade between themselves to inflate
// either (earned credit deepens the overdraft floor; governance credit buys votes).
// Tuning (owner decision 2026-07-05): Lowered cap from 5000 to 500. One solid trade
// banks a partner; repeat trades add nothing. Legitimate users need more distinct
// counterparties to build deep credit.
// CANONICAL tuning knob — single source of truth for volume caps (do not duplicate in manager or server).
export const PER_COUNTERPARTY_VOLUME_CAP = 500;

export interface WashAnalysis {
    flaggedPairs: Set<string>;
    flaggedClusters: Map<string, number>;
    clusterDetails: {
        members: string[];
        internalVol: number;
        totalVol: number;
        insularity: number;
        newRatio: number;
        size: number;
        newMembers: number;
    }[];
    pairDetails: {
        a: string;
        b: string;
        gross: number;
        r: number;
    }[];
}

// Memoized per database handle (10s). Keyed by the handle itself so the node's
// single live DB keeps its original 10s memo AND the manager can run the same
// analysis against many replica DBs without cross-contamination.
const washCache = new WeakMap<Db, { analysis: WashAnalysis; time: number }>();

export function runWashTradingAnalysis(db: Db): WashAnalysis {
    const flaggedPairs = new Set<string>();
    const flaggedClusters = new Map<string, number>();
    const clusterDetails: any[] = [];
    const pairDetails: any[] = [];

    // --- 1. Net-flow ratio (per counterparty pair) ---
    try {
        const rows = db.prepare(`
            SELECT buyer_pubkey, seller_pubkey, SUM(credits) as vol
            FROM marketplace_transactions
            WHERE status = 'completed' AND buyer_pubkey != seller_pubkey
            GROUP BY buyer_pubkey, seller_pubkey
        `).all() as { buyer_pubkey: string; seller_pubkey: string; vol: number }[];

        const pairVolumes = new Map<string, { u: string; v: string; volUtoV: number; volVtoU: number }>();
        for (const row of rows) {
            const u = row.buyer_pubkey;
            const v = row.seller_pubkey;
            const key = u < v ? `${u}|${v}` : `${v}|${u}`;
            let data = pairVolumes.get(key);
            if (!data) {
                data = { u: u < v ? u : v, v: u < v ? v : u, volUtoV: 0, volVtoU: 0 };
                pairVolumes.set(key, data);
            }
            if (row.buyer_pubkey === data.u) {
                data.volUtoV += row.vol;
            } else {
                data.volVtoU += row.vol;
            }
        }

        for (const [key, data] of pairVolumes.entries()) {
            const gross = data.volUtoV + data.volVtoU;
            if (gross >= PER_COUNTERPARTY_VOLUME_CAP) {
                const r = Math.abs(data.volUtoV - data.volVtoU) / gross;
                pairDetails.push({ a: data.u, b: data.v, gross, r });
                if (r < 0.15) {
                    flaggedPairs.add(key);
                }
            }
        }
    } catch (e) {
        console.error('Wash analysis (pair net flow) failed:', e);
    }

    // --- 2. Cluster insularity (connected components over rolling 30 days) ---
    try {
        const txs30 = db.prepare(`
            SELECT buyer_pubkey, seller_pubkey, credits
            FROM marketplace_transactions
            WHERE status = 'completed' AND buyer_pubkey != seller_pubkey
              AND completed_at > datetime('now', '-30 days')
        `).all() as { buyer_pubkey: string; seller_pubkey: string; credits: number }[];

        const adj = new Map<string, Set<string>>();
        const edgeVol30 = new Map<string, number>();
        const nodes30 = new Set<string>();

        for (const tx of txs30) {
            const u = tx.buyer_pubkey;
            const v = tx.seller_pubkey;
            nodes30.add(u);
            nodes30.add(v);

            if (!adj.has(u)) adj.set(u, new Set());
            if (!adj.has(v)) adj.set(v, new Set());
            adj.get(u)!.add(v);
            adj.get(v)!.add(u);

            const key = u < v ? `${u}|${v}` : `${v}|${u}`;
            edgeVol30.set(key, (edgeVol30.get(key) || 0) + tx.credits);
        }

        const visited = new Set<string>();
        const components: string[][] = [];

        for (const node of nodes30) {
            if (visited.has(node)) continue;
            const comp: string[] = [];
            const queue = [node];
            visited.add(node);

            while (queue.length > 0) {
                const curr = queue.shift()!;
                comp.push(curr);
                const neighbors = adj.get(curr) || new Set();
                for (const next of neighbors) {
                    if (!visited.has(next)) {
                        visited.add(next);
                        queue.push(next);
                    }
                }
            }
            components.push(comp);
        }

        if (components.length > 0) {
            const uniqueNodes = Array.from(nodes30);
            const memberAges = new Map<string, number>();

            for (let i = 0; i < uniqueNodes.length; i += 999) {
                const chunk = uniqueNodes.slice(i, i + 999);
                const placeholders = chunk.map(() => '?').join(',');
                const membersRows = db.prepare(`
                    SELECT public_key, joined_at FROM members WHERE public_key IN (${placeholders})
                `).all(...chunk) as { public_key: string; joined_at: string }[];

                for (const m of membersRows) {
                    const joined = m.joined_at ? new Date(m.joined_at) : new Date();
                    const ageDays = (Date.now() - joined.getTime()) / (1000 * 60 * 60 * 24);
                    memberAges.set(m.public_key, ageDays);
                }
            }

            let compIdx = 0;
            for (const comp of components) {
                if (comp.length <= 12) {
                    const compSet = new Set(comp);
                    let internalVol = 0;
                    for (const [key, vol] of edgeVol30.entries()) {
                        const [u, v] = key.split('|');
                        if (compSet.has(u) && compSet.has(v)) {
                            internalVol += vol;
                        }
                    }

                    const placeholders = comp.map(() => '?').join(',');
                    let totalVol = 0;
                    try {
                        const allTimeRes = db.prepare(`
                            SELECT COALESCE(SUM(credits), 0) as s FROM marketplace_transactions
                            WHERE status = 'completed' AND (buyer_pubkey IN (${placeholders}) OR seller_pubkey IN (${placeholders}))
                        `).get(...comp, ...comp) as any;
                        totalVol = allTimeRes ? allTimeRes.s : 0;
                    } catch (e) {
                        console.error('Failed to query all-time volume for component:', e);
                        totalVol = internalVol;
                    }

                    const insularity = totalVol > 0 ? (internalVol / totalVol) : 0;
                    let newMembersCount = 0;
                    for (const m of comp) {
                        const age = memberAges.get(m) ?? 0;
                        if (age < 14) {
                            newMembersCount++;
                        }
                    }

                    const newRatio = comp.length > 0 ? (newMembersCount / comp.length) : 0;

                    clusterDetails.push({
                        members: comp,
                        internalVol,
                        totalVol,
                        insularity,
                        newRatio,
                        size: comp.length,
                        newMembers: newMembersCount
                    });

                    if (insularity >= 0.8 && newMembersCount >= comp.length / 2) {
                        for (const m of comp) {
                            flaggedClusters.set(m, compIdx);
                        }
                    }
                    compIdx++;
                }
            }
        }
    } catch (e) {
        console.error('Wash analysis (cluster insularity) failed:', e);
    }

    return { flaggedPairs, flaggedClusters, clusterDetails, pairDetails };
}

export function getWashTradingEnforcement(db: Db): WashAnalysis {
    const cached = washCache.get(db);
    if (cached && (Date.now() - cached.time < 10000)) {
        return cached.analysis;
    }
    const analysis = runWashTradingAnalysis(db);
    washCache.set(db, { analysis, time: Date.now() });
    return analysis;
}

export function clearWashTradingCache(db: Db): void {
    washCache.delete(db);
}

/**
 * F3 — value that counts toward EARNED TRUST: only COMPLETED marketplace (escrow) trades.
 *
 * Attributed to the REAL counterparty (buyer↔seller), not the intermediating escrow account,
 * and capped per counterparty (PER_COUNTERPARTY_VOLUME_CAP) so diverse trade counts for more
 * than repeat trade with one partner. BOTH sides of a completed trade earn the value (the seller
 * delivered, the buyer paid). Direct peer-to-peer "send credits" are gifts/helping-a-friend —
 * they are deliberately NOT trades and build NO trust (per product decision, 2026-07).
 *
 * Enforcement (soft haircut — Change 3): Excludes flagged wash-trading pairs and intra-cluster trades
 * for flagged insular clusters from the trust sum.
 */
export function qualifiedTradeValue(db: Db, publicKey: string): number {
    const { flaggedPairs, flaggedClusters } = getWashTradingEnforcement(db);

    const rows = db.prepare(`
        SELECT counterparty, COALESCE(SUM(credits), 0) as v FROM (
            SELECT seller_pubkey AS counterparty, credits FROM marketplace_transactions
                WHERE buyer_pubkey = ? AND status = 'completed' AND seller_pubkey != ?
            UNION ALL
            SELECT buyer_pubkey AS counterparty, credits FROM marketplace_transactions
                WHERE seller_pubkey = ? AND status = 'completed' AND buyer_pubkey != ?
        ) GROUP BY counterparty
    `).all(publicKey, publicKey, publicKey, publicKey) as { counterparty: string; v: number }[];

    return rows.reduce((sum, r) => {
        const pairKey = publicKey < r.counterparty ? `${publicKey}|${r.counterparty}` : `${r.counterparty}|${publicKey}`;
        // Haircut check:
        // 1. Exclude if pair is flagged as wash trading
        if (flaggedPairs.has(pairKey)) {
            return sum;
        }
        // 2. Exclude if both members are in the same flagged cluster component
        const clusterIdA = flaggedClusters.get(publicKey);
        const clusterIdB = flaggedClusters.get(r.counterparty);
        if (clusterIdA !== undefined && clusterIdA === clusterIdB) {
            return sum;
        }
        return sum + Math.min(r.v, PER_COUNTERPARTY_VOLUME_CAP);
    }, 0);
}

/**
 * Calculates trust metrics for a member used by the dynamic credit formula.
 * Excludes escrow system wallets and self-transactions.
 */
export function getMemberTrustStats(db: Db, publicKey: string): TrustStats {
    // Inlined member lookup: the node's rowToMember maps joined_at → joinedAt with
    // no transformation, so reading joined_at directly is behaviour-identical and
    // keeps this module free of the Member domain type.
    const member = db.prepare("SELECT joined_at FROM members WHERE public_key = ?").get(publicKey) as { joined_at: string } | undefined;
    if (!member) return { tradeCount: 0, uniquePartners: 0, ageDays: 0 };

    // Trade count: completed transactions (direct and marketplace completed)
    const tradeCountRow = db.prepare(`
        SELECT (
            SELECT COUNT(*) FROM transactions
            WHERE (from_pubkey = ? OR to_pubkey = ?)
            AND from_pubkey != to_pubkey
            AND from_pubkey NOT LIKE 'escrow_%'
            AND to_pubkey NOT LIKE 'escrow_%'
            AND from_pubkey != 'SYSTEM'
            AND to_pubkey != 'SYSTEM'
        ) + (
            SELECT COUNT(*) FROM marketplace_transactions
            WHERE (buyer_pubkey = ? OR seller_pubkey = ?)
            AND status = 'completed'
        ) as count
    `).get(publicKey, publicKey, publicKey, publicKey) as any;

    // Unique trade partners: distinct counterparties (direct and marketplace completed)
    const uniquePartnersRow = db.prepare(`
        SELECT COUNT(DISTINCT partner) as count FROM (
            SELECT to_pubkey as partner FROM transactions
            WHERE from_pubkey = ?
            AND to_pubkey NOT LIKE 'escrow_%'
            AND to_pubkey != 'SYSTEM'
            AND to_pubkey != ?
            UNION
            SELECT from_pubkey as partner FROM transactions
            WHERE to_pubkey = ?
            AND from_pubkey NOT LIKE 'escrow_%'
            AND from_pubkey != 'SYSTEM'
            AND from_pubkey != ?
            UNION
            SELECT seller_pubkey as partner FROM marketplace_transactions
            WHERE buyer_pubkey = ? AND status = 'completed' AND seller_pubkey != ?
            UNION
            SELECT buyer_pubkey as partner FROM marketplace_transactions
            WHERE seller_pubkey = ? AND status = 'completed' AND buyer_pubkey != ?
        )
    `).get(publicKey, publicKey, publicKey, publicKey, publicKey, publicKey, publicKey, publicKey) as any;

    // Account age in days
    const joinedAt = member.joined_at ? new Date(member.joined_at) : new Date();
    const ageDays = Math.floor((Date.now() - joinedAt.getTime()) / (1000 * 60 * 60 * 24));

    return {
        tradeCount: tradeCountRow?.count || 0,
        uniquePartners: uniquePartnersRow?.count || 0,
        ageDays: Math.max(0, ageDays),
    };
}

/**
 * Returns the full trust profile for a member: stats, floor, ceiling, and tier.
 * Incorporates any pre-seeded earned_credit from admin genesis invites.
 */
export function getMemberTrustProfile(db: Db, publicKey: string): {
    stats: TrustStats;
    floor: number;
    tier: TierInfo;
    earnedCredit: number;
    grantedCredit: number;
    qualifiedValue: number;
    avgRating: number;
    reviewCount: number;
    vouched: boolean;
    activated: boolean;
} {
    const stats = getMemberTrustStats(db, publicKey);

    // GRANTED-credit lane: genesis pre-seed + admin Elder grants (adminSetElder) + Elder vouch.
    // Stored in members.earned_credit (legacy column name). It is a credit-*limit* input only —
    // it mints/moves no beans — and it is kept SEPARATE from the earned score, so grants deepen
    // the floor but never count as "earned" (governance votes use earned/value only, not grants).
    const memberRow = db.prepare("SELECT earned_credit, elder_vouched_by, vouch_credit, COALESCE(credit_frozen, 0) as credit_frozen FROM members WHERE public_key = ?").get(publicKey) as any;
    const grantedCredit = memberRow?.earned_credit || 0;
    const elderVouched = !!memberRow?.elder_vouched_by;
    // The vouch level's credit floor (25/50/100). A vouch recorded before the level system, or
    // with no stored amount, defaults to the light level.
    const vouchCredit = elderVouched ? (memberRow?.vouch_credit > 0 ? memberRow.vouch_credit : PROTOCOL_CONSTANTS.VOUCH_CREDIT_LIGHT) : 0;
    const isCreditFrozen = memberRow?.credit_frozen === 1;

    const c = PROTOCOL_CONSTANTS;

    // EARNED-credit lane (Trust Model v2 / F3): a saturating function of qualified trade VALUE —
    // ONLY completed marketplace (escrow) trades, attributed to the real counterparty and capped
    // per-counterparty (A2-26 diversity), crediting both buyer and seller. Direct "send credits"
    // are gifts, not trades, and build no trust. Earning a deep floor requires real, diverse,
    // completed trade — not gifts or 1-bean pings across sock accounts.
    const value = qualifiedTradeValue(db, publicKey);
    const rawEarned = earnedCreditFromValue(value);

    // Star rating scales EARNED value only (0.5–1.0×); granted credit passes through intact.
    const ratingsRow = db.prepare(`
        SELECT AVG(stars) as avg, COUNT(*) as cnt
        FROM ratings
        WHERE target_pubkey = ?
    `).get(publicKey) as any;
    const reviewCount = ratingsRow?.cnt || 0;
    const avgRating = ratingsRow?.avg || 5.0;
    const multiplier = reviewCount > 0 ? (0.5 + 0.5 * (avgRating / 5.0)) : 1.0;
    const earnedCredit = Math.max(0, Math.floor(rawEarned * multiplier));

    // Activation gate — a member has NO credit line at all (floor stays at 0; no overdraft) until an
    // appointed voucher vouches for them, or an admin/genesis grant graduates a founding member.
    // Completing a trade NO LONGER activates: that was a Sybil faucet — N sock accounts each doing
    // one throwaway trade with a colluding creator would each mint themselves the -20 voucher (gift
    // 1 bean to N socks → 20N beans of unbacked credit). The -20 floor is now *handed out* by a
    // vouch: the one human-gated, admin-appointed way in (see vouchMember / can_vouch). Nice
    // property — when a member is finally vouched, any earned trust they'd already banked unlocks
    // alongside the welcome voucher, so their floor jumps straight to reflect their real trading.
    // Trust Model v3: a completed real trade (earnedCredit > 0) opens the floor on its own — no
    // vouch required. Restores the documented behaviour (docs/trust-model-shipped.md §1) that the
    // #15 vouch-gating pass dropped, which left earned-trust members showing "no credit line".
    const activated = elderVouched || grantedCredit > 0 || earnedCredit > 0;
    const allowance = (activated && !isCreditFrozen)
        ? Math.min(c.CREDIT_FLOOR_CAP, vouchCredit + earnedCredit + grantedCredit)
        : 0;

    // Floor = -(voucher + earned + granted) once activated, clamped so the deepest floor is
    // -CREDIT_FLOOR_CAP; 0 for an un-vouched member. CREDIT_BASE_FLOOR is 0 — no baked-in overdraft.
    const floor = c.CREDIT_BASE_FLOOR - allowance;

    const tier = getTier(floor);

    // qualifiedValue: raw diversity-capped trade value (drives the native "value traded"
    // achievement + value-to-next-tier estimate). avgRating/reviewCount: the reputation
    // multiplier inputs, surfaced so the client can show them honestly.
    return { stats, floor, tier, earnedCredit, grantedCredit, qualifiedValue: value, avgRating, reviewCount, vouched: elderVouched, activated };
}
