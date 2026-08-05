import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { DeviceEventEmitter } from 'react-native';
import { reportAbuse } from './db';

const BLOCKLIST_STORAGE_KEY = 'beanpool_blocked_users';
const PENDING_REPORTS_KEY = 'beanpool_pending_abuse_reports';
export const BLOCKLIST_UPDATED_EVENT = 'beanpool_blocklist_updated';

let cachedBlocklist: string[] | null = null;

interface PendingReport {
    reporterPubkey: string;
    targetPubkey: string;
    reason: string;
    postId?: string;
    timestamp: number;
}

/**
 * Retrieves the current array of blocked user public keys.
 * Uses AsyncStorage for unbounded capacity (avoiding SecureStore 2KB limits).
 */
export async function getBlockedUsers(): Promise<string[]> {
    if (cachedBlocklist !== null) return cachedBlocklist;
    try {
        let data = await AsyncStorage.getItem(BLOCKLIST_STORAGE_KEY);
        // Fallback / migration check from legacy SecureStore key
        if (!data) {
            const legacyData = await SecureStore.getItemAsync(BLOCKLIST_STORAGE_KEY).catch(() => null);
            if (legacyData) {
                data = legacyData;
                await AsyncStorage.setItem(BLOCKLIST_STORAGE_KEY, legacyData);
                await SecureStore.deleteItemAsync(BLOCKLIST_STORAGE_KEY).catch(() => {});
            }
        }
        if (data) {
            const parsed = JSON.parse(data);
            cachedBlocklist = Array.isArray(parsed) ? parsed : [];
            return cachedBlocklist;
        }
    } catch (e) {
        console.error('[blocklist] Failed to read blocked users from AsyncStorage', e);
    }
    return [];
}



/**
 * Asynchronously checks if a given user is blocked.
 */
export async function isUserBlocked(pubkey: string): Promise<boolean> {
    const list = await getBlockedUsers();
    return list.includes(pubkey);
}

/**
 * Blocks a user, saves to AsyncStorage, notifies server moderation (per Apple Guideline 1.2),
 * queues failed network reports for retry, and dispatches a global event for immediate UI updates.
 */
export async function blockUser(
    targetPubkey: string,
    reporterPubkey?: string,
    reason: string = 'User Blocked by Member',
    postId?: string
): Promise<boolean> {
    if (!targetPubkey) return false;

    try {
        const list = await getBlockedUsers();
        if (!list.includes(targetPubkey)) {
            const newList = [...list, targetPubkey];
            await AsyncStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify(newList));
            cachedBlocklist = newList;
            
            // Apple Guideline 1.2: Blocking must notify developer of inappropriate content
            if (reporterPubkey) {
                try {
                    await reportAbuse(reporterPubkey, targetPubkey, reason, postId);
                } catch (err) {
                    console.warn('[blocklist] Failed to send reportAbuse to server on block, queuing for retry:', err);
                    await queueReportForRetry({
                        reporterPubkey,
                        targetPubkey,
                        reason,
                        postId,
                        timestamp: Date.now()
                    });
                }
            }

            DeviceEventEmitter.emit(BLOCKLIST_UPDATED_EVENT, newList);
            return true;
        }
    } catch (e) {
        console.error('[blocklist] Failed to block user', e);
    }
    return false;
}

/**
 * Unblocks a single user, updates AsyncStorage, and dispatches a global event.
 */
export async function unblockUser(targetPubkey: string): Promise<boolean> {
    if (!targetPubkey) return false;

    try {
        const list = await getBlockedUsers();
        if (list.includes(targetPubkey)) {
            const newList = list.filter(pk => pk !== targetPubkey);
            await AsyncStorage.setItem(BLOCKLIST_STORAGE_KEY, JSON.stringify(newList));
            cachedBlocklist = newList;
            DeviceEventEmitter.emit(BLOCKLIST_UPDATED_EVENT, newList);
            return true;
        }
    } catch (e) {
        console.error('[blocklist] Failed to unblock user', e);
    }
    return false;
}

/**
 * Clears the entire blocklist atomically in a single operation.
 * Prevents thread blocking and O(N) storage writes when unblocking all users.
 */
export async function clearBlocklist(): Promise<boolean> {
    try {
        await AsyncStorage.removeItem(BLOCKLIST_STORAGE_KEY);
        await SecureStore.deleteItemAsync(BLOCKLIST_STORAGE_KEY).catch(() => {});
        cachedBlocklist = [];
        DeviceEventEmitter.emit(BLOCKLIST_UPDATED_EVENT, []);
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
async function queueReportForRetry(report: PendingReport) {
    try {
        const raw = await AsyncStorage.getItem(PENDING_REPORTS_KEY);
        let pending: PendingReport[] = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(pending)) pending = [];
        // TTL: drop reports older than 7 days
        const now = Date.now();
        pending = pending.filter(p => now - p.timestamp < REPORT_TTL_MS);
        // Deduplicate: keep only the latest report per target
        pending = pending.filter(p => p.targetPubkey !== report.targetPubkey);
        // Cap queue size
        if (pending.length >= MAX_PENDING_REPORTS) pending.shift();
        pending.push(report);
        await AsyncStorage.setItem(PENDING_REPORTS_KEY, JSON.stringify(pending));
    } catch (e) {
        console.error('[blocklist] Failed to queue report for retry', e);
    }
}

/**
 * Retries sending any queued offline reports to the server.
 */
export async function retryPendingReports(): Promise<void> {
    try {
        const raw = await AsyncStorage.getItem(PENDING_REPORTS_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        let pending: PendingReport[] = Array.isArray(parsed) ? parsed : [];
        if (!pending.length) {
            await AsyncStorage.removeItem(PENDING_REPORTS_KEY);
            return;
        }

        // Prune stale reports before retrying
        const now = Date.now();
        pending = pending.filter(p => now - p.timestamp < REPORT_TTL_MS);
        if (!pending.length) {
            await AsyncStorage.removeItem(PENDING_REPORTS_KEY);
            return;
        }

        const remaining: PendingReport[] = [];
        for (const item of pending) {
            try {
                await reportAbuse(item.reporterPubkey, item.targetPubkey, item.reason, item.postId);
            } catch (e) {
                remaining.push(item);
            }
        }

        if (remaining.length === 0) {
            await AsyncStorage.removeItem(PENDING_REPORTS_KEY);
        } else if (remaining.length !== pending.length) {
            await AsyncStorage.setItem(PENDING_REPORTS_KEY, JSON.stringify(remaining));
        }
    } catch (e) {
        console.error('[blocklist] Error retrying pending reports', e);
    }
}
