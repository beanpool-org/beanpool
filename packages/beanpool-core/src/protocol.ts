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
    CREDIT_BASE_FLOOR: -80,            // Ghost starts here (≈ 2 hours of credit)
    CREDIT_MAX_EARNED: 1920,           // Max additional earned (total cap: -2000 ≈ 50 hours)

    // Growth Weights
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

    // === Admin Genesis Invite Pre-seeds ===
    // These are pre-seeded earnedCredit values that place the new member
    // at the target tier threshold. The formula is:
    //   floor = BASE_FLOOR - earnedCredit → solve for earnedCredit
    //   Trusted:   -200 = -80 - earned → earned = 120
    //   Ambassador: -600 = -80 - earned → earned = 520
    GENESIS_TRUSTED_EARNED: 120,       // Places new member at -200 floor (Resident)
    GENESIS_AMBASSADOR_EARNED: 520,    // Places new member at -600 floor (Steward)
    GENESIS_ELDER_EARNED: 1320,        // Places new member at -1400 floor (Elder)

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
 * Calculates the dynamic credit floor for a member based on their trade history.
 * 
 * Formula: floor = BASE_FLOOR − min(MAX_EARNED, earnedCredit)
 * where:   earnedCredit = (tradeCount × 8) + (uniquePartners × 40) + (ageDays × 2)
 * 
 * @returns A negative number representing the member's borrowing limit (e.g. -420)
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
