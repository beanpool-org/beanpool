/**
 * BeanPool Protocol Constants & Functions
 * 
 * This is the single source of truth for all economic rules in the
 * Social Capital Ledger. These constants are protocol-level — they are
 * identical across all nodes in the federated network.
 * 
 * @see docs/protocol-rules.md for the full specification.
 */

export const PROTOCOL_VERSION = 1;

export const PROTOCOL_CONSTANTS = {
    // === Reference Rate ===
    REFERENCE_RATE: 40,                // Beans per hour of community time
    REFERENCE_LABEL: 'hour',

    // === Credit Formula (Sliding Scale) ===
    // No automatic overdraft: the floor starts at 0 and deepens with a vouch + earned trust +
    // any grants. floor = -min(CREDIT_FLOOR_CAP, vouchCredit + earned + granted). A member has
    // no credit line at all until an appointed voucher vouches (vouchCredit > 0) or an admin/
    // genesis grant graduates them (granted > 0). See getMemberTrustProfile.
    CREDIT_BASE_FLOOR: 0,              // no baked-in credit — every bean of the floor is explicit
    CREDIT_MAX_EARNED: 1920,           // asymptote of the earned-trust curve (see earnedCreditFromValue)
    CREDIT_FLOOR_CAP: 2000,            // deepest possible floor is -2000 (≈ 50 hours) across ALL sources

    // === Vouch Levels — the credit floor an appointed voucher hands a newcomer (voucher picks one) ===
    VOUCH_CREDIT_LIGHT: 25,            // level 1 — a light vouch (-25 floor)
    VOUCH_CREDIT_STANDARD: 50,         // level 2 — a standard vouch (-50 floor)
    VOUCH_CREDIT_DEEP: 100,            // level 3 — a deep vouch (-100 floor)

    // === Trust Curve (Trust Model v2 — value-based, saturating) ===
    // Earned credit is a saturating function of qualified, diversity-capped value cycled (V):
    //   earnedCredit = floor(CREDIT_MAX_EARNED * V / (V + TRUST_CURVE_K))
    // Integer-only → deterministic across all federated nodes (no float log/√).
    // Proportional at the low end (a tiny trade earns ~nothing → kills the 3-bean cliff),
    // saturating at the top (no single account runs away toward the cap).
    // Tuning: lower K = credit reached with less value (more generous); higher K = stricter.
    TRUST_CURVE_K: 5000,

    // Growth Weights — LEGACY (count-based; superseded by the value curve above in Trust Model v2).
    // Retained only for the deprecated calculateDynamicFloor() mirror; not used at runtime.
    CREDIT_WEIGHT_TRADES: 8,           // Each organic trade adds 8 Beans of credit
    CREDIT_WEIGHT_PARTNERS: 40,        // Each unique partner adds 40 Beans (1 hour of credit)
    CREDIT_WEIGHT_AGE_DAYS: 2,         // Each day of account age adds 2 Beans


    // === Community Circulation (formerly Demurrage) ===
    CIRCULATION_RATE: 0.000,           // 0.0% per month (base rate - Green Zone)
    CIRCULATION_EPOCH_DAYS: 30,

    // === Tier Thresholds ===
    GHOST_THRESHOLD: -200,             // floor > this = Ghost
    RESIDENT_THRESHOLD: -600,          // -200 ≥ floor > -600 = Resident
    STEWARD_THRESHOLD: -1400,          // -600 ≥ floor > -1400 = Steward
    // floor ≤ -1400 = Elder

    // === Admin Tier-Badge / Genesis Grants ===
    // Pre-seeded GRANTED credit that places a member at a tier's ENTRY floor. An admin can assign
    // a tier badge (adminSetTier), or a genesis invite can pre-seed it. On this granted path the
    // grant IS the whole floor (no separate vouch component): floor = -(granted + earned).
    //   Resident: -200 → granted = 200
    //   Steward:  -600 → granted = 600
    //   Elder:   -1400 → granted = 1400
    GENESIS_TRUSTED_EARNED: 200,       // Resident badge — floor -200
    GENESIS_AMBASSADOR_EARNED: 600,    // Steward badge — floor -600
    GENESIS_ELDER_EARNED: 1400,        // Elder badge — floor -1400

    // === Transaction Guardrails ===
    TRANSACTION_WARNING_THRESHOLD: 0.5, // Warn when using >50% of remaining credit
} as const;

// ===================== TYPES =====================

export type TierName = 'Newcomer' | 'Resident' | 'Steward' | 'Elder';
export type GenesisInviteType = 'standard' | 'trusted' | 'ambassador' | 'elder';

export interface TierInfo {
    name: TierName;
    emoji: string;
    color: string;
    canGift: boolean;
    canInvite: boolean;
}

export interface TrustStats {
    tradeCount: number;
    uniquePartners: number;
    ageDays: number;
}

// ===================== CORE FUNCTIONS =====================

/**
 * Trust Model v2 — earned credit as a saturating function of value cycled.
 *
 *   earnedCredit = floor(CREDIT_MAX_EARNED * V / (V + TRUST_CURVE_K))
 *
 * `value` is the caller's qualified, diversity-capped value cycled (e.g. countedOutboundVolume,
 * which already caps per-counterparty). Pure + integer-only → identical on every federated node.
 * This is a credit-*limit* input; it mints no beans.
 *
 * @param value  qualified value cycled (≥ 0)
 * @returns      earned credit (0 … CREDIT_MAX_EARNED), integer
 */
export function earnedCreditFromValue(value: number): number {
    const c = PROTOCOL_CONSTANTS;
    if (!(value > 0)) return 0;                       // guards NaN / negatives / 0
    const v = Math.floor(value);                      // integer domain for determinism
    return Math.floor((c.CREDIT_MAX_EARNED * v) / (v + c.TRUST_CURVE_K));
}

/**
 * LEGACY (Trust Model v1) — count-based dynamic floor. Superseded by the value curve
 * (earnedCreditFromValue). No live callers; retained for reference/back-compat only.
 *
 * Formula: floor = BASE_FLOOR − min(MAX_EARNED, earnedCredit)
 * where:   earnedCredit = (tradeCount × 8) + (uniquePartners × 40) + (ageDays × 2)
 */
export function calculateDynamicFloor(stats: TrustStats): number {
    const c = PROTOCOL_CONSTANTS;
    const earned = (stats.tradeCount * c.CREDIT_WEIGHT_TRADES)
                 + (stats.uniquePartners * c.CREDIT_WEIGHT_PARTNERS)
                 + (stats.ageDays * c.CREDIT_WEIGHT_AGE_DAYS);
    return c.CREDIT_BASE_FLOOR - Math.min(c.CREDIT_MAX_EARNED, earned);
}

/**
 * Returns the identity tier for a given dynamic floor value.
 */
export function getTier(floor: number): TierInfo {
    const c = PROTOCOL_CONSTANTS;

    if (floor > c.GHOST_THRESHOLD) {
        return { name: 'Newcomer', emoji: '🥚', color: '#6b7280', canGift: false, canInvite: true };
    }
    if (floor > c.RESIDENT_THRESHOLD) {
        return { name: 'Resident', emoji: '🏠', color: '#3b82f6', canGift: true, canInvite: true };
    }
    if (floor > c.STEWARD_THRESHOLD) {
        return { name: 'Steward', emoji: '🏛️', color: '#8b5cf6', canGift: true, canInvite: true };
    }
    return { name: 'Elder', emoji: '⛰️', color: '#f59e0b', canGift: true, canInvite: true };
}

/**
 * Returns the pre-seeded earnedCredit for an admin genesis invite type.
 * Standard invites return 0 (no boost — member starts as Ghost).
 */
export function getGenesisEarnedCredit(type: GenesisInviteType): number {
    const c = PROTOCOL_CONSTANTS;
    switch (type) {
        case 'trusted': return c.GENESIS_TRUSTED_EARNED;
        case 'ambassador': return c.GENESIS_AMBASSADOR_EARNED;
        case 'elder': return c.GENESIS_ELDER_EARNED;
        default: return 0;
    }
}

// Vouch level → the credit-floor beans an appointed voucher hands out (see vouchMember).
export type VouchLevel = 1 | 2 | 3;
export function vouchCreditForLevel(level: VouchLevel): number {
    const c = PROTOCOL_CONSTANTS;
    switch (level) {
        case 3: return c.VOUCH_CREDIT_DEEP;      // -100
        case 2: return c.VOUCH_CREDIT_STANDARD;  // -50
        default: return c.VOUCH_CREDIT_LIGHT;    // -25 (level 1)
    }
}

// Admin tier badge → the GRANTED credit that lands a member at that tier's entry floor.
// Newcomer clears the grant (0). Mirrors the genesis pre-seed values.
export function grantedCreditForTier(tier: TierName): number {
    const c = PROTOCOL_CONSTANTS;
    switch (tier) {
        case 'Elder': return c.GENESIS_ELDER_EARNED;        // 1400 → -1400
        case 'Steward': return c.GENESIS_AMBASSADOR_EARNED; // 600  → -600
        case 'Resident': return c.GENESIS_TRUSTED_EARNED;   // 200  → -200
        default: return 0;                                  // Newcomer — no grant
    }
}

/**
 * Formats a bean amount as an approximate time equivalent.
 * Examples: 5 → "≈ 8min", 40 → "≈ 1.0hr", 320 → "≈ 8hr"
 */
export function formatTimeEquivalent(beans: number): string {
    const hours = Math.abs(beans) / PROTOCOL_CONSTANTS.REFERENCE_RATE;
    if (hours < 0.5) return `≈ ${Math.round(hours * 60)}min`;
    if (hours < 10) return `≈ ${hours.toFixed(1)}hr`;
    return `≈ ${Math.round(hours)}hr`;
}
