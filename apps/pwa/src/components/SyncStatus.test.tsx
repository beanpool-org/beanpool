import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SyncStatus } from './SyncStatus';
import { checkMembership } from '../lib/api';
import { loadIdentity } from '../lib/identity';
import { onSyncChange } from '../lib/sync';

vi.mock('../lib/api', () => ({
    checkMembership: vi.fn(),
}));

vi.mock('../lib/identity', () => ({
    loadIdentity: vi.fn(),
}));

vi.mock('../lib/sync', () => ({
    onSyncChange: vi.fn((cb) => {
        cb({
            connected: false,
            lastSyncTime: null,
            merkleRoot: null,
            accountCount: 0,
        });
        return vi.fn();
    }),
}));

describe('SyncStatus Component', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.mocked(onSyncChange).mockImplementation((cb) => {
            cb({
                connected: false,
                lastSyncTime: null,
                merkleRoot: null,
                accountCount: 0,
            });
            return vi.fn();
        });
    });

    afterEach(() => {
        vi.clearAllTimers();
    });

    it('sets isHttpOnline to false when checkMembership rejects (probe error)', async () => {
        const mockIdentity = {
            publicKey: 'test-pubkey-123',
            privateKey: 'test-privkey',
            callsign: 'Alice',
            createdAt: new Date().toISOString(),
        };

        vi.mocked(loadIdentity).mockResolvedValue(mockIdentity);
        vi.mocked(checkMembership).mockRejectedValue(new Error('Network error'));

        render(<SyncStatus />);

        await waitFor(() => {
            expect(loadIdentity).toHaveBeenCalled();
            expect(checkMembership).toHaveBeenCalledWith('test-pubkey-123');
        });

        await waitFor(() => {
            expect(screen.getByText('Offline')).toBeInTheDocument();
        });
    });

    it('sets state to Online when checkMembership resolves with isMember true', async () => {
        const mockIdentity = {
            publicKey: 'test-pubkey-123',
            privateKey: 'test-privkey',
            callsign: 'Alice',
            createdAt: new Date().toISOString(),
        };

        vi.mocked(loadIdentity).mockResolvedValue(mockIdentity);
        vi.mocked(checkMembership).mockResolvedValue({ isMember: true, callsign: 'Alice' });

        render(<SyncStatus />);

        await waitFor(() => {
            expect(screen.getByText('Online')).toBeInTheDocument();
        });
    });

    it('sets state to Guest when checkMembership resolves with isMember false', async () => {
        const mockIdentity = {
            publicKey: 'test-pubkey-123',
            privateKey: 'test-privkey',
            callsign: 'Alice',
            createdAt: new Date().toISOString(),
        };

        vi.mocked(loadIdentity).mockResolvedValue(mockIdentity);
        vi.mocked(checkMembership).mockResolvedValue({ isMember: false, callsign: null });

        render(<SyncStatus />);

        await waitFor(() => {
            expect(screen.getByText('Guest')).toBeInTheDocument();
        });
    });

    it('does not call checkMembership when loadIdentity returns null', async () => {
        vi.mocked(loadIdentity).mockResolvedValue(null);

        render(<SyncStatus />);

        await waitFor(() => {
            expect(loadIdentity).toHaveBeenCalled();
        });

        expect(checkMembership).not.toHaveBeenCalled();
        expect(screen.getByText('Offline')).toBeInTheDocument();
    });

    it('handles component unmount cleanly during probe execution', async () => {
        let resolveCheckMembership!: (value: any) => void;
        const checkMembershipPromise = new Promise((resolve) => {
            resolveCheckMembership = resolve;
        });

        const mockIdentity = {
            publicKey: 'test-pubkey-123',
            privateKey: 'test-privkey',
            callsign: 'Alice',
            createdAt: new Date().toISOString(),
        };

        vi.mocked(loadIdentity).mockResolvedValue(mockIdentity);
        vi.mocked(checkMembership).mockReturnValue(checkMembershipPromise as any);

        const { unmount } = render(<SyncStatus />);

        await waitFor(() => {
            expect(checkMembership).toHaveBeenCalled();
        });

        unmount();

        resolveCheckMembership({ isMember: true, callsign: 'Alice' });
    });
});
