/**
 * Add ±20% random jitter to a base millisecond interval.
 * For baseMs = 10,000, returns between 8,000 and 12,000.
 */
export function withJitter(baseMs: number, fraction = 0.2): number {
    // Clamped, because both timer APIs treat a non-positive delay as "as soon as possible" and
    // would spin at ~1-4 ms instead of erroring — the exact opposite of what this helper is for.
    // A fraction of 1 or more would make `min` zero or negative on its own.
    const safeBase = Math.max(1, Math.floor(baseMs) || 0);
    const safeFraction = Math.min(Math.max(fraction, 0), 0.9);
    const min = safeBase * (1 - safeFraction);
    const max = safeBase * (1 + safeFraction);
    return Math.max(1, Math.floor(min + Math.random() * (max - min)));
}
