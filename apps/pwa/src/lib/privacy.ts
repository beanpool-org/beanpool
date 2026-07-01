/**
 * 4-Tier Location Privacy Model
 *
 * Tier 0: Ghost   — No GPS, manual pin drop only (DEFAULT)
 * Tier 1: Post    — GPS captured once per marketplace post
 * Tier 2: Zone    — Session-stable ±2km fuzzing
 * Tier 3: Live    — Real-time foreground-only tracking
 */

export type PrivacyTier = 0 | 1 | 2 | 3;

export interface PrivacyState {
    tier: PrivacyTier;
    zoneOffset: { lat: number; lng: number } | null;
}

export const TIER_CONFIG = [
    { tier: 0 as const, name: 'Ghost', emoji: '👻', color: '#6b7280', description: 'Invisible. No location shared.' },
    { tier: 1 as const, name: 'Post-Only', emoji: '📍', color: '#10b981', description: 'Location at time of posting only.' },
    { tier: 2 as const, name: 'Zone', emoji: '🔵', color: '#3b82f6', description: 'Fuzzed ±2km neighborhood.' },
    { tier: 3 as const, name: 'Live', emoji: '🔴', color: '#ef4444', description: 'Real-time (foreground only).' },
] as const;

const STORAGE_KEY = 'beanpool-privacy-tier';

/**
 * Generate a session-stable fuzzing offset for Zone mode.
 * This is calculated once per session to prevent averaging attacks.
 */
function generateZoneOffset(): { lat: number; lng: number } {
    return {
        lat: (Math.random() - 0.5) * 0.036, // ~2km
        lng: (Math.random() - 0.5) * 0.036,
    };
}

/**
 * Load the saved privacy tier from localStorage.
 */
export function loadPrivacyState(): PrivacyState {
    const saved = localStorage.getItem(STORAGE_KEY);
    const tier = saved ? (Number(saved) as PrivacyTier) : 0; // Default: Ghost
    return {
        tier,
        zoneOffset: tier === 2 ? generateZoneOffset() : null,
    };
}

/**
 * Save and cycle to the next privacy tier.
 */
export function cycleTier(current: PrivacyState): PrivacyState {
    const nextTier = ((current.tier + 1) % 4) as PrivacyTier;
    localStorage.setItem(STORAGE_KEY, String(nextTier));
    return {
        tier: nextTier,
        zoneOffset: nextTier === 2 ? generateZoneOffset() : null,
    };
}

/**
 * Apply the privacy model to raw coordinates.
 */
export function applyPrivacy(
    raw: { lat: number; lng: number },
    state: PrivacyState
): { lat: number; lng: number } | null {
    switch (state.tier) {
        case 0: return null; // Ghost — no location
        case 1: return raw;  // Post-Only — exact at time of post
        case 2: // Zone — fuzzy
            if (!state.zoneOffset) return raw;
            return {
                lat: raw.lat + state.zoneOffset.lat,
                lng: raw.lng + state.zoneOffset.lng,
            };
        case 3: return raw;  // Live — exact real-time
        default: return null;
    }
}
