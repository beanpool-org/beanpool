import { reportAbuse } from './api';

export const BLOCKLIST_STORAGE_KEY = 'bp_blocked_users';
export const LEGACY_BLOCKLIST_KEY = 'beanpool_blocked_users';
export const PENDING_REPORTS_KEY = 'bp_pending_abuse_reports';
export const BLOCKLIST_UPDATED_EVENT = 'bp_blocklist_updated';

let cachedBlocklist: string[] | null = null;

export interface PendingReport {
    reporterPubkey: string;
    targetPubkey: string;
    reason: string;
    postId?: string;
    timestamp: number;
}

/**
 * Retrieves the current array of blocked user public keys from localStorage.
 */
export function getBlockedUsers(): string[] {
    if (cachedBlocklist !== null) return cachedBlocklist;
    try {
        let raw = typeof localStorage !== 'undefined' ? localStorage.getItem(BLOCKLIST_STORAGE_KEY) : null;
        if (!raw && typeof localStorage !== 'undefined') {
            raw = localStorage.getItem(LEGACY_BLOCKLIST_KEY);
            if (raw) {
                localStorage.setItem(BLOCKLIST_STORAGE_KEY, raw);
            }
        }
        if (raw) {
            const parsed = JSON.parse(raw);
            cachedBlocklist = Array.isArray(parsed) ? parsed : [];
            return cachedBlocklist;
        }
    } catch (e) {
        console.error('[blocklist] Failed to read blocked users from localStorage', e);
    }
    cachedBlocklist = [];
    return [];
}

/**
 * Synchronously checks if a given user is blocked.
 */
export function isUserBlocked(pubkey: string): boolean {
    if (!pubkey) return false;
    const list = getBlockedUsers();
    return list.includes(pubkey);
}

function persistBlocklist(newList: string[]) {
    cachedBlocklist = newList;
    if (typeof localStorage !== 'undefined') {
        const json = JSON.stringify(newList);
        localStorage.setItem(BLOCKLIST_STORAGE_KEY, json);
        localStorage.setItem(LEGACY_BLOCKLIST_KEY, json);
    }
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(BLOCKLIST_UPDATED_EVENT, { detail: newList }));
    }
}

/**
 * Blocks a user, saves to localStorage, notifies server moderation (matching native semantics),
 * queues failed network reports for retry, and dispatches an event for immediate UI updates.
 */
export async function blockUser(
    targetPubkey: string,
    reporterPubkey?: string,
    reason: string = 'User Blocked by Member',
    postId?: string
): Promise<boolean> {
    if (!targetPubkey) return false;

    try {
        const list = getBlockedUsers();
        if (!list.includes(targetPubkey)) {
            const newList = [...list, targetPubkey];
            persistBlocklist(newList);

            if (reporterPubkey) {
                try {
                    await reportAbuse(reporterPubkey, targetPubkey, reason, postId);
                } catch (err) {
                    console.warn('[blocklist] Failed to send reportAbuse on block, queuing for retry:', err);
                    queueReportForRetry({
                        reporterPubkey,
                        targetPubkey,
                        reason,
                        postId,
                        timestamp: Date.now(),
                    });
                }
            }
            return true;
        }
    } catch (e) {
        console.error('[blocklist] Failed to block user', e);
    }
    return false;
}

/**
 * Unblocks a single user, updates localStorage, and dispatches an event.
 */
export function unblockUser(targetPubkey: string): boolean {
    if (!targetPubkey) return false;

    try {
        const list = getBlockedUsers();
        if (list.includes(targetPubkey)) {
            const newList = list.filter(pk => pk !== targetPubkey);
            persistBlocklist(newList);
            return true;
        }
    } catch (e) {
        console.error('[blocklist] Failed to unblock user', e);
    }
    return false;
}

/**
 * Clears the entire blocklist.
 */
export function clearBlocklist(): boolean {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(BLOCKLIST_STORAGE_KEY);
            localStorage.removeItem(LEGACY_BLOCKLIST_KEY);
        }
        cachedBlocklist = [];
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent(BLOCKLIST_UPDATED_EVENT, { detail: [] }));
        }
        return true;
    } catch (e) {
        console.error('[blocklist] Failed to clear blocklist', e);
        return false;
    }
}

const REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_PENDING_REPORTS = 50;

/**
 * Queues a moderation report locally to retry when network is restored.
 * Deduplicates by targetPubkey, enforces a 7-day TTL, and caps at 50 entries.
 */
export function queueReportForRetry(report: PendingReport) {
    if (typeof localStorage === 'undefined') return;
    try {
        const raw = localStorage.getItem(PENDING_REPORTS_KEY);
        let pending: PendingReport[] = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(pending)) pending = [];
        const now = Date.now();
        // TTL: drop reports older than 7 days
        pending = pending.filter(p => now - p.timestamp < REPORT_TTL_MS);
        // Deduplicate: keep only the latest report per target
        pending = pending.filter(p => p.targetPubkey !== report.targetPubkey);
        // Cap queue size
        if (pending.length >= MAX_PENDING_REPORTS) pending.shift();
        pending.push(report);
        localStorage.setItem(PENDING_REPORTS_KEY, JSON.stringify(pending));
    } catch (e) {
        console.error('[blocklist] Failed to queue report for retry', e);
    }
}

/**
 * Retries sending queued offline reports to the server.
 */
export async function retryPendingReports(): Promise<void> {
    if (typeof localStorage === 'undefined') return;
    try {
        const raw = localStorage.getItem(PENDING_REPORTS_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        let pending: PendingReport[] = Array.isArray(parsed) ? parsed : [];
        if (!pending.length) {
            localStorage.removeItem(PENDING_REPORTS_KEY);
            return;
        }

        const now = Date.now();
        pending = pending.filter(p => now - p.timestamp < REPORT_TTL_MS);
        if (!pending.length) {
            localStorage.removeItem(PENDING_REPORTS_KEY);
            return;
        }

        const remaining: PendingReport[] = [];
        for (const item of pending) {
            try {
                await reportAbuse(item.reporterPubkey, item.targetPubkey, item.reason, item.postId);
            } catch {
                remaining.push(item);
            }
        }

        if (remaining.length === 0) {
            localStorage.removeItem(PENDING_REPORTS_KEY);
        } else if (remaining.length !== pending.length) {
            localStorage.setItem(PENDING_REPORTS_KEY, JSON.stringify(remaining));
        }
    } catch (e) {
        console.error('[blocklist] Error retrying pending reports', e);
    }
}

/**
 * Subscribes to blocklist updates across the window and other browser tabs.
 */
export function onBlocklistUpdated(callback: (blocked: string[]) => void): () => void {
    if (typeof window === 'undefined') return () => {};

    const handleCustom = (e: Event) => {
        const detail = (e as CustomEvent).detail;
        callback(Array.isArray(detail) ? detail : getBlockedUsers());
    };

    const handleStorage = (e: StorageEvent) => {
        if (e.key === BLOCKLIST_STORAGE_KEY || e.key === LEGACY_BLOCKLIST_KEY) {
            cachedBlocklist = null;
            callback(getBlockedUsers());
        }
    };

    window.addEventListener(BLOCKLIST_UPDATED_EVENT, handleCustom);
    window.addEventListener('storage', handleStorage);

    return () => {
        window.removeEventListener(BLOCKLIST_UPDATED_EVENT, handleCustom);
        window.removeEventListener('storage', handleStorage);
    };
}
