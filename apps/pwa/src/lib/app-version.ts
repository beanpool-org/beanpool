/**
 * Version comparison and normalization logic for PWA minimum version gating.
 * Reference: apps/native/utils/app-version.ts
 */

/**
 * Drop the decoration we actually understand, then insist on a real dotted version.
 * Strips leading 'v' or 'V' and ensures 1 to 3 numeric dot-separated segments.
 */
export function normaliseVersion(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim().replace(/^[vV]\s*/, '');
    if (!/^\d+(\.\d+){0,2}$/.test(trimmed)) return null;
    return trimmed;
}

/**
 * Compares two semantic version strings.
 * Returns true if `local` is strictly older than `required`.
 * If either version cannot be parsed, returns false (safe fallback to avoid false banners).
 */
export function isVersionOlder(local: string, required: string): boolean {
    const a = normaliseVersion(local);
    const b = normaliseVersion(required);
    if (!a || !b) return false;

    const parse = (v: string) => v.split('.').map(n => parseInt(n, 10));
    const localParts = parse(a);
    const requiredParts = parse(b);

    for (let i = 0; i < 3; i++) {
        const l = localParts[i] || 0;
        const r = requiredParts[i] || 0;
        if (l < r) return true;
        if (l > r) return false;
    }
    return false;
}
