/**
 * Device-level preferences that must survive signing out.
 *
 * Signing out clears localStorage wholesale, which is right for identity material — but it
 * also destroyed things that are properties of the *browser*, not the account. The install
 * banner's dismissal was one: sign out, sign back in, and the banner returned, which read as
 * "dismissing it does nothing".
 *
 * Keys listed here are snapshotted and restored around a wipe. Only add a key if it holds no
 * account data and no secret — this survives sign-out by design.
 */
const DEVICE_KEYS = [
    'beanpool-install-dismissed',
    'beanpool-install-dismissed-forever',
] as const;

/**
 * Clear localStorage the way sign-out needs, without taking device preferences with it.
 * Everything else — identity, keys, cached account state — still goes.
 */
export function clearAccountStorage(): void {
    const keep = new Map<string, string>();
    for (const key of DEVICE_KEYS) {
        const value = localStorage.getItem(key);
        if (value !== null) keep.set(key, value);
    }
    localStorage.clear();
    for (const [key, value] of keep) {
        try { localStorage.setItem(key, value); } catch { /* quota/private mode — not worth failing sign-out over */ }
    }
}
