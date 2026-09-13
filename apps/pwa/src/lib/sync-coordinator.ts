/**
 * PWA Sync Coordinator — Mirrored from native's requestSync() and pillar-sync.
 *
 * Implements:
 * 1. Single-flight execution (only one performSync executes at a time)
 * 2. 150ms debounce coalescing rapid WebSocket bursts
 * 3. Exactly ONE queued trailing sync so no event is missed
 * 4. 2000ms protective cooldown before executing the trailing sync
 * 5. Delta cursor persisted in localStorage with 300s clock-drift subtraction
 *    and fallback to full pull when cursor is absent or invalid
 * 6. Try/catch guards around all localStorage reads and writes to survive
 *    private browsing and blocked storage.
 */

export const SYNC_CURSOR_KEY = 'bp_sync_last_sync';

/**
 * Read the stored delta sync cursor timestamp from localStorage.
 * Returns null if not stored, invalid, or if localStorage throws.
 */
export function getSyncCursor(): number | null {
    try {
        if (typeof localStorage === 'undefined') return null;
        const raw = localStorage.getItem(SYNC_CURSOR_KEY);
        if (!raw) return null;
        const ts = parseInt(raw, 10);
        return isNaN(ts) || ts <= 0 ? null : ts;
    } catch {
        // localStorage throws in private windows and when site data is blocked
        return null;
    }
}

/**
 * Persist the sync cursor timestamp to localStorage.
 * Wrapped in try/catch to ensure storage errors never break sync.
 */
export function saveSyncCursor(timestamp: number = Date.now()): void {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(SYNC_CURSOR_KEY, String(timestamp));
    } catch {
        // Silently ignore storage failures (private browsing, quota, blocked cookies)
    }
}

/**
 * Clear the persisted sync cursor (e.g. on force resync).
 */
export function clearSyncCursor(): void {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.removeItem(SYNC_CURSOR_KEY);
    } catch {}
}

/**
 * Compute the drift-adjusted ISO timestamp for incremental updates.
 * Applies a 300-second (5 minute) clock drift subtraction, matching native.
 * Returns null for full-pull fallback when:
 * - cursor is missing, 0, or negative
 * - localRowCount is explicitly 0 (matching native's local count guard)
 */
export function computeUpdatedAfter(cursor: number | null, localRowCount?: number): string | null {
    if (localRowCount !== undefined && localRowCount <= 0) {
        return null;
    }
    if (!cursor || isNaN(cursor) || cursor <= 0) {
        return null;
    }
    // Incorporate a 5-minute time buffer to account for clock drift between client and server
    const driftAdjusted = Math.max(0, cursor - 300_000);
    return new Date(driftAdjusted).toISOString();
}

/**
 * Activity callback type. Listeners can be sync or async.
 */
export type SyncActivityCallback = () => void | Promise<void>;

let activityListeners: SyncActivityCallback[] = [];
let onSyncCompletedCallback: ((time: number) => void) | null = null;

/**
 * Register a listener to be notified when a coordinated sync cycle runs.
 * Returns an unregister function.
 */
export function registerSyncActivityListener(cb: SyncActivityCallback): () => void {
    activityListeners.push(cb);
    return () => {
        activityListeners = activityListeners.filter((l) => l !== cb);
    };
}

/**
 * Hook to notify external subscribers (e.g. SyncStatus state in sync.ts) on sync completion.
 */
export function setOnSyncCompletedCallback(cb: ((time: number) => void) | null): void {
    onSyncCompletedCallback = cb;
}

let syncPromise: Promise<void> | null = null;
let needsAnotherSync = false;
let debounceTimeoutId: ReturnType<typeof setTimeout> | null = null;
let cooldownTimeoutId: ReturnType<typeof setTimeout> | null = null;
let pendingResolvers: Array<() => void> = [];

/**
 * Default performSync implementation: executes all registered activity
 * listeners and updates the delta cursor upon completion.
 */
async function defaultPerformSync(): Promise<void> {
    const listeners = [...activityListeners];
    await Promise.allSettled(
        listeners.map(async (cb) => {
            try {
                await cb();
            } catch (err) {
                console.warn('[Sync Coordinator] Activity listener failed:', err);
            }
        })
    );
    const now = Date.now();
    saveSyncCursor(now);
    try {
        onSyncCompletedCallback?.(now);
    } catch {}
}

let performSyncImpl: () => Promise<void> = defaultPerformSync;

/**
 * Hook to override performSync implementation in tests.
 */
export function setPerformSyncImplForTest(fn: (() => Promise<void>) | null): void {
    performSyncImpl = fn || defaultPerformSync;
}

/**
 * Coordinated request wrapper.
 * Ensures only one performSync executes at a time, debounces rapid consecutive calls
 * with a 150ms window, queues exactly one trailing sync if requested during an active sync,
 * and enforces a 2000ms cooldown before the trailing sync executes.
 */
export function requestSync(): Promise<void> {
    if (syncPromise) {
        needsAnotherSync = true;
        return new Promise<void>((resolve) => {
            pendingResolvers.push(resolve);
        });
    }

    if (debounceTimeoutId) {
        clearTimeout(debounceTimeoutId);
        debounceTimeoutId = null;
    }

    return new Promise<void>((resolve) => {
        pendingResolvers.push(resolve);

        debounceTimeoutId = setTimeout(() => {
            debounceTimeoutId = null;

            if (syncPromise) {
                needsAnotherSync = true;
                return;
            }

            const currentResolvers = [...pendingResolvers];
            pendingResolvers = [];

            syncPromise = performSyncImpl()
                .catch((err) => {
                    console.error('[Sync Coordinator] Sync failed:', err);
                })
                .finally(() => {
                    syncPromise = null;
                    currentResolvers.forEach((r) => r());

                    if (needsAnotherSync) {
                        needsAnotherSync = false;
                        // Protective 2000ms cooldown delay to prevent infinite consecutive trailing sync loops
                        cooldownTimeoutId = setTimeout(() => {
                            cooldownTimeoutId = null;
                            requestSync().catch(() => {});
                        }, 2000);
                    }
                });
        }, 150);
    });
}

/**
 * Test helper to reset internal coordinator state between test runs.
 */
export function resetCoordinatorForTest(): void {
    if (debounceTimeoutId) {
        clearTimeout(debounceTimeoutId);
        debounceTimeoutId = null;
    }
    if (cooldownTimeoutId) {
        clearTimeout(cooldownTimeoutId);
        cooldownTimeoutId = null;
    }
    syncPromise = null;
    needsAnotherSync = false;
    pendingResolvers.forEach((r) => r());
    pendingResolvers = [];
    activityListeners = [];
    performSyncImpl = defaultPerformSync;
    onSyncCompletedCallback = null;
}
