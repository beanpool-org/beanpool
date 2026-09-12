/**
 * Add ±20% random jitter to a base millisecond interval.
 * For baseMs = 10,000, returns between 8,000 and 12,000.
 */
export function withJitter(baseMs: number, fraction = 0.2): number {
    const min = baseMs * (1 - fraction);
    const max = baseMs * (1 + fraction);
    return Math.floor(min + Math.random() * (max - min));
}
