/**
 * Fresh-listings social proof banner helper.
 *
 * A dismissal lasts the local calendar day, and more listings bring it back.
 * Stored on device storage (AsyncStorage on mobile, localStorage on web)
 * under 'bp_dismissed_fresh_count'.
 *
 * Stores the local day (YYYY-MM-DD) and the count at the time of dismissal.
 * An old plain number (legacy mobile storage format) or a stored value from
 * another day means no dismissal. Both apps use it; neither keeps its own rule.
 */

export interface FreshBannerDismissal {
    day: string;
    count: number;
}

const isDayString = (val: unknown): val is string =>
    typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val);

/** The device's local calendar day, YYYY-MM-DD. */
export function freshBannerDay(at: Date | number = new Date()): string {
    const d = typeof at === 'number' ? new Date(at) : at;
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Tolerantly parse a stored fresh banner dismissal value.
 * An old plain number (string or numeric) or corrupt data returns null (no dismissal).
 */
export function parseFreshBannerDismissal(stored: unknown): FreshBannerDismissal | null {
    if (!stored) return null;
    if (typeof stored === 'number') {
        // "An old plain number means no dismissal."
        return null;
    }
    if (typeof stored === 'string') {
        const trimmed = stored.trim();
        // A plain digit string like "3" or "0" is the legacy mobile format: no dismissal
        if (/^\d+$/.test(trimmed)) {
            return null;
        }
        try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'number' || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return null;
            }
            if (isDayString(parsed.day) && typeof parsed.count === 'number' && Number.isFinite(parsed.count) && parsed.count >= 0) {
                return { day: parsed.day, count: Math.floor(parsed.count) };
            }
        } catch {
            return null;
        }
    } else if (typeof stored === 'object' && !Array.isArray(stored)) {
        const obj = stored as Record<string, unknown>;
        if (isDayString(obj.day) && typeof obj.count === 'number' && Number.isFinite(obj.count) && obj.count >= 0) {
            return { day: obj.day, count: Math.floor(obj.count) };
        }
    }
    return null;
}

/**
 * Record a dismissal of the fresh listings banner for the current day.
 * Returns a serialized JSON string to persist in storage.
 */
export function recordFreshBannerDismissal(count: number, now: Date | number = new Date()): string {
    const day = freshBannerDay(now);
    const validCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    return JSON.stringify({ day, count: validCount });
}

/**
 * Answers whether the fresh banner should show.
 *
 * Rules:
 * - If freshCount <= 0, banner is hidden (false).
 * - An unparseable stored value, null, or old plain number means no dismissal (shows if freshCount > 0).
 * - A stored value from another day means no dismissal (shows if freshCount > 0).
 * - If dismissed on the same local day:
 *   - freshCount <= dismissedCount: banner is hidden (false).
 *   - freshCount > dismissedCount: more listings have arrived, so banner is shown (true).
 */
export function shouldShowFreshBanner(
    stored: unknown,
    freshCount: number,
    now: Date | number = new Date()
): boolean {
    if (freshCount <= 0) return false;
    const dismissal = parseFreshBannerDismissal(stored);
    if (!dismissal) return true;
    const currentDay = freshBannerDay(now);
    if (dismissal.day !== currentDay) {
        return true;
    }
    return freshCount > dismissal.count;
}

export const freshBanner = {
    day: freshBannerDay,
    parse: parseFreshBannerDismissal,
    record: recordFreshBannerDismissal,
    shouldShow: shouldShowFreshBanner,
};
