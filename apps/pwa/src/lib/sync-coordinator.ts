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
    // A cursor in the FUTURE means the device clock was wrong when it was written (or the clock
    // has since been corrected backwards). Left alone it asks the server for rows updated after a
    // time that has not happened yet, so the delta is empty forever and the client goes blind
    // with no error anywhere. Fall back to a full pull instead — the same allowance as the drift
    // subtraction below, in the other direction.
    if (cursor > Date.now() + 300_000) {
        return null;
    }
    // Incorporate a 5-minute time buffer to account for clock drift between client and server
    const driftAdjusted = Math.max(0, cursor - 300_000);
    return new Date(driftAdjusted).toISOString();
}

/**
 * What a run reads. 'all' is every run but one kind: a socket opening, the tab coming back, a message, a trade, a listing
 * that is the member's own. 'listings' is a run asked for only by new listings by someone else (@beanpool/core
 * isOthersListingDoorbell): it changes no chat, no unread count and no group, so the listeners that read those
 * (registered with `chats`) sit it out, and the listing views, Home and the rest run as before. Any 'all' request in the
 * same window, or while a run is in flight, makes the next run 'all'.
 */
export type SyncScope = 'all' | 'listings';

/** What a listener is told of the run it takes part in. */
export interface SyncRunInfo {
    scope: SyncScope;
}

/**
 * Activity callback type. Listeners can be sync or async.
 */
export type SyncActivityCallback = (run?: SyncRunInfo) => void | Promise<void>;

export interface SyncListenerOptions {
    /** Reads the member's chats, their unread count or their groups: left out of a 'listings' run. */
    chats?: boolean;
}

let activityListeners: Array<{ cb: SyncActivityCallback; chats: boolean }> = [];
let onSyncCompletedCallback: ((time: number) => void) | null = null;

/**
 * Register a listener to be notified when a coordinated sync cycle runs.
 * Returns an unregister function.
 */
export function registerSyncActivityListener(cb: SyncActivityCallback, options: SyncListenerOptions = {}): () => void {
    const entry = { cb, chats: !!options.chats };
    activityListeners.push(entry);
    return () => {
        activityListeners = activityListeners.filter((l) => l !== entry);
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
/** When the last run started (0 before any): a wide doorbell's deferred sync is dropped when one started after it (lib/sync). */
let lastRunStartedAt = 0;
export function lastSyncStartedAt(): number {
    return lastRunStartedAt;
}
let debounceTimeoutId: ReturnType<typeof setTimeout> | null = null;
let cooldownTimeoutId: ReturnType<typeof setTimeout> | null = null;
let pendingResolvers: Array<() => void> = [];
/** What the run being set up, or the trailing one, will read: any 'all' request makes it 'all'. Null when none is asked for. */
let pendingScope: SyncScope | null = null;

/**
 * Default performSync implementation: executes the registered activity
 * listeners (all of them, or for a 'listings' run those that do not read chats)
 * and updates the delta cursor upon completion.
 */
async function defaultPerformSync(scope: SyncScope = 'all'): Promise<void> {
    const run: SyncRunInfo = { scope };
    const listeners = activityListeners.filter((l) => scope === 'all' || !l.chats).map((l) => l.cb);
    // The mappers deliberately do NOT swallow their own rejections. They did, which meant
    // allSettled saw nothing but `fulfilled` and the cursor advanced even when every listener
    // had failed — an offline drop or a 500 would move the cursor past rows that never arrived,
    // and once Stage 4 sends `updatedAfter` from it those rows are skipped permanently, with
    // nothing anywhere reporting a problem. A run only earns the cursor if it actually worked.
    const results = await Promise.allSettled(listeners.map((cb) => Promise.resolve(cb(run))));

    const failed = results.filter((r) => r.status === 'rejected');
    for (const f of failed) {
        console.warn('[Sync Coordinator] Activity listener failed:', (f as PromiseRejectedResult).reason);
    }
    if (failed.length > 0) {
        // Cursor deliberately left where it was: the next run re-covers this window.
        return;
    }

    // NOTE FOR STAGE 4, where this cursor starts gating `updatedAfter`: listener success is a
    // proxy, not proof. Listeners have heterogeneous error semantics — App's unread poller
    // deliberately tolerates one endpoint failing (it uses allSettled), so it resolves even
    // when half its data did not arrive. When a real delta fetch exists, advance the cursor
    // from THAT fetch's own success and the server's notion of time, not from whether some
    // side-effecting listener happened to resolve.

    const now = Date.now();
    // A 'listings' run left the chats listeners out, so it covers less than the cursor claims: only a run of 'all' moves it.
    if (scope === 'all') saveSyncCursor(now);
    try {
        onSyncCompletedCallback?.(now);
    } catch {}
}

let performSyncImpl: (scope?: SyncScope) => Promise<void> = defaultPerformSync;

/**
 * Hook to override performSync implementation in tests.
 */
export function setPerformSyncImplForTest(fn: ((scope?: SyncScope) => Promise<void>) | null): void {
    performSyncImpl = fn || defaultPerformSync;
}

/**
 * Coordinated request wrapper.
 * Ensures only one performSync executes at a time, debounces rapid consecutive calls
 * with a 150ms window, queues exactly one trailing sync if requested during an active sync,
 * and enforces a 2000ms cooldown before the trailing sync executes.
 *
 * `scope` says what the run must read (SyncScope): 'all' unless every request joined to it was for a new listing by
 * someone else. A run, and the trailing one, is the widest of the requests it stands for.
 */
export function requestSync(scope: SyncScope = 'all'): Promise<void> {
    pendingScope = pendingScope === 'all' || scope === 'all' ? 'all' : 'listings';
    // A run in flight, OR a cooldown already armed, both mean "a run is coming — join it".
    // Only `syncPromise` was checked, so a request arriving during the cooldown saw a null
    // syncPromise, skipped the wait entirely and started its own run ~150ms later. The armed
    // cooldown was never cancelled either, so it fired into the middle of that run, set
    // needsAnotherSync, and armed another cooldown on completion — a self-sustaining loop under
    // continuous events, which is precisely what the cooldown exists to prevent.
    if (syncPromise || cooldownTimeoutId) {
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

            // Cleared as the run STARTS, not only when one is queued at the end: this run
            // observes server state as of now, so it already covers everything requested before
            // it began. Anything arriving while it is in flight sets the flag again and still
            // gets its trailing run — so nothing is missed, and a request that merely waited out
            // the cooldown no longer buys a second redundant run behind the one it triggered.
            needsAnotherSync = false;
            const runScope: SyncScope = pendingScope ?? 'all';
            pendingScope = null;

            lastRunStartedAt = Date.now();
            syncPromise = performSyncImpl(runScope)
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
                            requestSync(pendingScope ?? 'all').catch(() => {});
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
    pendingScope = null;
    lastRunStartedAt = 0;
    pendingResolvers.forEach((r) => r());
    pendingResolvers = [];
    activityListeners = [];
    performSyncImpl = defaultPerformSync;
    onSyncCompletedCallback = null;
}
