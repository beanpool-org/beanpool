import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    getBlockedUsers,
    isUserBlocked,
    blockUser,
    unblockUser,
    clearBlocklist,
    BLOCKLIST_STORAGE_KEY,
    LEGACY_BLOCKLIST_KEY,
    PENDING_REPORTS_KEY,
    retryPendingReports,
} from './blocklist';
import * as api from './api';

describe('blocklist', () => {
    beforeEach(() => {
        localStorage.clear();
        clearBlocklist();
        vi.restoreAllMocks();
    });

    it('returns empty array when nothing stored', () => {
        expect(getBlockedUsers()).toEqual([]);
        expect(isUserBlocked('pk_123')).toBe(false);
    });

    it('blocks a user and persists to both current and legacy keys', async () => {
        const success = await blockUser('pk_target');
        expect(success).toBe(true);
        expect(isUserBlocked('pk_target')).toBe(true);
        expect(getBlockedUsers()).toContain('pk_target');
        expect(JSON.parse(localStorage.getItem(BLOCKLIST_STORAGE_KEY)!)).toContain('pk_target');
        expect(JSON.parse(localStorage.getItem(LEGACY_BLOCKLIST_KEY)!)).toContain('pk_target');
    });

    it('does not duplicate pubkeys in blocklist', async () => {
        await blockUser('pk_target');
        await blockUser('pk_target');
        expect(getBlockedUsers()).toEqual(['pk_target']);
    });

    it('unblocks a user', async () => {
        await blockUser('pk_1');
        await blockUser('pk_2');
        expect(getBlockedUsers()).toEqual(['pk_1', 'pk_2']);

        const unblocked = unblockUser('pk_1');
        expect(unblocked).toBe(true);
        expect(isUserBlocked('pk_1')).toBe(false);
        expect(isUserBlocked('pk_2')).toBe(true);
        expect(getBlockedUsers()).toEqual(['pk_2']);
    });

    it('reports abuse to API when reporterPubkey is provided', async () => {
        const spy = vi.spyOn(api, 'reportAbuse').mockResolvedValue({ success: true });
        await blockUser('pk_target', 'pk_reporter', 'Harassment', 'post_99');

        expect(spy).toHaveBeenCalledWith('pk_reporter', 'pk_target', 'Harassment', 'post_99');
        expect(localStorage.getItem(PENDING_REPORTS_KEY)).toBeNull();
    });

    it('queues report for retry when network report fails', async () => {
        vi.spyOn(api, 'reportAbuse').mockRejectedValue(new Error('Network error'));
        await blockUser('pk_target', 'pk_reporter', 'Spam', 'post_88');

        const pending = JSON.parse(localStorage.getItem(PENDING_REPORTS_KEY)!);
        expect(pending).toHaveLength(1);
        expect(pending[0].targetPubkey).toBe('pk_target');
        expect(pending[0].reason).toBe('Spam');
    });

    it('retries pending reports when retryPendingReports is called', async () => {
        const reportSpy = vi.spyOn(api, 'reportAbuse').mockResolvedValue({ success: true });
        localStorage.setItem(
            PENDING_REPORTS_KEY,
            JSON.stringify([
                { reporterPubkey: 'rep1', targetPubkey: 'tgt1', reason: 'Abuse', timestamp: Date.now() },
            ])
        );

        await retryPendingReports();
        expect(reportSpy).toHaveBeenCalledWith('rep1', 'tgt1', 'Abuse', undefined);
        expect(localStorage.getItem(PENDING_REPORTS_KEY)).toBeNull();
    });
});
