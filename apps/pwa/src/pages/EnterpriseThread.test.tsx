import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { TreasuryDetailPage } from './TreasuryDetailPage';
import type { BeanPoolIdentity } from '../lib/identity';
import * as api from '../lib/api';
import * as sync from '../lib/sync';

// Mock dependencies
vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn(() => () => {}),
}));

vi.mock('../lib/blocklist', () => ({
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));

vi.mock('../lib/profile-status', () => ({
    getProfileStatus: vi.fn(async () => ({ complete: true })),
    describeMissing: vi.fn(() => ''),
}));

vi.mock('../components/ActivityWaterfall', () => ({
    ActivityWaterfall: () => null,
}));

vi.mock('../components/DecideSection', () => ({
    DecideSection: () => null,
}));

vi.mock('../components/ProposeDecisionModal', () => ({
    ProposeDecisionModal: () => null,
}));

const mockKeeperIdentity: BeanPoolIdentity = {
    publicKey: 'keeper-alice-pubkey',
    privateKey: 'mock-private-key-hex',
    callsign: 'Alice',
    createdAt: '2026-01-01T00:00:00.000Z',
};

const mockCitizenIdentity: BeanPoolIdentity = {
    publicKey: 'citizen-dan-pubkey',
    privateKey: 'mock-dan-key-hex',
    callsign: 'DanActive',
    createdAt: '2026-01-01T00:00:00.000Z',
};

describe('Enterprise Discussion Thread (PWA)', () => {
    const mockTreasury = {
        publicKey: 'enterprise-bakery-pubkey',
        name: 'Community Bakery',
        purpose: 'Fresh sourdough for everyone',
        avatar: null,
        balance: 150,
        creditLine: 200,
        status: 'active',
        paused: false,
        keepers: [{ publicKey: 'keeper-alice-pubkey', callsign: 'Alice' }],
        posts: [],
        flow: [],
    };

    beforeEach(() => {
        vi.restoreAllMocks();
        vi.spyOn(api, 'getTreasury').mockResolvedValue(mockTreasury);
        vi.spyOn(api, 'getBalance').mockResolvedValue({
            balance: 50,
            keeperOf: ['enterprise-bakery-pubkey'],
        } as any);
        vi.spyOn(api, 'getEnterpriseLedger').mockResolvedValue({
            enterprise: { publicKey: 'enterprise-bakery-pubkey', name: 'Community Bakery', status: 'active', balance: 150 },
            period: { since: null, until: null },
            summary: { totalIncome: 0, totalSpend: 0, netChange: 0, startingBalance: 150, endingBalance: 150, transactionCount: 0 },
            entries: [],
        } as any);
    });

    it('renders discussion thread heading, messages, and decoded plaintext', async () => {
        const mockMessages: api.EnterpriseThreadMessage[] = [
            {
                id: 'msg-1',
                conversationId: 'enterprise-bakery-pubkey',
                authorPubkey: 'citizen-dan-pubkey',
                authorCallsign: 'DanActive',
                authorAvatar: null,
                ciphertext: btoa('Who has the flour sacks?'),
                nonce: 'plaintext-v1',
                type: 'text',
                timestamp: '2026-09-17T10:00:00.000Z',
            },
            {
                id: 'msg-2',
                conversationId: 'enterprise-bakery-pubkey',
                authorPubkey: 'keeper-alice-pubkey',
                authorCallsign: 'Alice',
                authorAvatar: null,
                ciphertext: btoa('I picked them up from the mill!'),
                nonce: 'plaintext-v1',
                type: 'text',
                timestamp: '2026-09-17T10:05:00.000Z',
            },
            {
                id: 'msg-3',
                conversationId: 'enterprise-bakery-pubkey',
                authorPubkey: 'citizen-dan-pubkey',
                authorCallsign: 'DanActive',
                authorAvatar: null,
                ciphertext: Buffer.from('🫘 Fresh sourdough available! 🌱', 'utf8').toString('base64'),
                nonce: 'plaintext-v1',
                type: 'text',
                timestamp: '2026-09-17T10:10:00.000Z',
            },
        ];

        vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({
            conversation: { id: 'enterprise-bakery-pubkey', type: 'enterprise_thread' },
            messages: mockMessages,
            readOnly: false,
        });

        render(
            <TreasuryDetailPage
                identity={mockKeeperIdentity}
                pubkey="enterprise-bakery-pubkey"
                onBack={() => {}}
            />
        );

        // Header exists
        await waitFor(() => {
            expect(screen.getByText('Enterprise Discussion')).toBeInTheDocument();
        });

        // Messages rendered
        expect(screen.getByText('Who has the flour sacks?')).toBeInTheDocument();
        expect(screen.getByText('I picked them up from the mill!')).toBeInTheDocument();
        expect(screen.getByText('🫘 Fresh sourdough available! 🌱')).toBeInTheDocument();
        expect(screen.getAllByText('DanActive').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Alice').length).toBeGreaterThanOrEqual(1);
    });

    it('displays "removed by a keeper" for removed messages without deleting the row', async () => {
        const mockMessages: api.EnterpriseThreadMessage[] = [
            {
                id: 'msg-1',
                conversationId: 'enterprise-bakery-pubkey',
                authorPubkey: 'citizen-dan-pubkey',
                authorCallsign: 'DanActive',
                ciphertext: btoa('removed by a keeper'),
                nonce: 'plaintext-v1',
                type: 'removed',
                metadata: JSON.stringify({ removed: true, removedBy: 'keeper-alice-pubkey' }),
                timestamp: '2026-09-17T10:00:00.000Z',
            },
        ];

        vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({
            conversation: { id: 'enterprise-bakery-pubkey', type: 'enterprise_thread' },
            messages: mockMessages,
            readOnly: false,
        });

        render(
            <TreasuryDetailPage
                identity={mockKeeperIdentity}
                pubkey="enterprise-bakery-pubkey"
                onBack={() => {}}
            />
        );

        await waitFor(() => {
            expect(screen.getByText('removed by a keeper')).toBeInTheDocument();
        });
        // The message is still rendered with its tombstone, never silently vanishing
        expect(screen.getByText('DanActive')).toBeInTheDocument();
    });

    it('shows Remove button to keepers and calls removeEnterpriseThreadMessage', async () => {
        const mockMessages: api.EnterpriseThreadMessage[] = [
            {
                id: 'msg-to-remove',
                conversationId: 'enterprise-bakery-pubkey',
                authorPubkey: 'citizen-dan-pubkey',
                authorCallsign: 'DanActive',
                ciphertext: btoa('Off-topic note'),
                nonce: 'plaintext-v1',
                type: 'text',
                timestamp: '2026-09-17T10:00:00.000Z',
            },
        ];

        vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({
            conversation: { id: 'enterprise-bakery-pubkey', type: 'enterprise_thread' },
            messages: mockMessages,
            readOnly: false,
        });
        const removeSpy = vi.spyOn(api, 'removeEnterpriseThreadMessage').mockResolvedValue({
            success: true,
            message: { ...mockMessages[0], type: 'removed' },
        });
        const confirmSpy = vi.spyOn(window, 'confirm');

        render(
            <TreasuryDetailPage
                identity={mockKeeperIdentity}
                pubkey="enterprise-bakery-pubkey"
                onBack={() => {}}
            />
        );

        await waitFor(() => {
            expect(screen.getByText('Off-topic note')).toBeInTheDocument();
        });

        const removeButton = screen.getByTitle('Remove message');
        expect(removeButton).toBeInTheDocument();

        // 1. Cancelling confirmation does not remove
        confirmSpy.mockReturnValueOnce(false);
        fireEvent.click(removeButton);
        expect(confirmSpy).toHaveBeenCalledWith('Are you sure you want to remove this message? It will show as "removed by a keeper".');
        expect(removeSpy).not.toHaveBeenCalled();

        // 2. Confirming calls remove
        confirmSpy.mockReturnValueOnce(true);
        fireEvent.click(removeButton);
        expect(removeSpy).toHaveBeenCalledWith('enterprise-bakery-pubkey', 'msg-to-remove');
    });

    it('does NOT show Remove button to non-keepers', async () => {
        const mockMessages: api.EnterpriseThreadMessage[] = [
            {
                id: 'msg-1',
                conversationId: 'enterprise-bakery-pubkey',
                authorPubkey: 'citizen-dan-pubkey',
                authorCallsign: 'DanActive',
                ciphertext: btoa('Hello world'),
                nonce: 'plaintext-v1',
                type: 'text',
                timestamp: '2026-09-17T10:00:00.000Z',
            },
        ];

        vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({
            conversation: { id: 'enterprise-bakery-pubkey', type: 'enterprise_thread' },
            messages: mockMessages,
            readOnly: false,
        });
        vi.spyOn(api, 'getBalance').mockResolvedValue({
            balance: 50,
            keeperOf: [], // Dan is not a keeper of Bakery
        } as any);

        render(
            <TreasuryDetailPage
                identity={mockCitizenIdentity}
                pubkey="enterprise-bakery-pubkey"
                onBack={() => {}}
            />
        );

        await waitFor(() => {
            expect(screen.getByText('Hello world')).toBeInTheDocument();
        });

        expect(screen.queryByTitle('Remove message')).not.toBeInTheDocument();
    });

    it('posts a new message when submitted by an active member', async () => {
        vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({
            conversation: { id: 'enterprise-bakery-pubkey', type: 'enterprise_thread' },
            messages: [],
            readOnly: false,
        });
        const postSpy = vi.spyOn(api, 'postEnterpriseThreadMessage').mockResolvedValue({
            success: true,
            message: {
                id: 'new-msg-1',
                conversationId: 'enterprise-bakery-pubkey',
                authorPubkey: 'citizen-dan-pubkey',
                ciphertext: btoa('Will volunteer for sourdough batch'),
                nonce: 'plaintext-v1',
                type: 'text',
                timestamp: new Date().toISOString(),
            },
        });

        render(
            <TreasuryDetailPage
                identity={mockCitizenIdentity}
                pubkey="enterprise-bakery-pubkey"
                onBack={() => {}}
            />
        );

        await waitFor(() => {
            expect(screen.getByPlaceholderText('Message the enterprise...')).toBeInTheDocument();
        });

        const input = screen.getByPlaceholderText('Message the enterprise...');
        fireEvent.change(input, { target: { value: 'Will volunteer for sourdough batch' } });

        const postButton = screen.getByRole('button', { name: 'Post' });
        fireEvent.click(postButton);

        expect(postSpy).toHaveBeenCalledWith('enterprise-bakery-pubkey', 'Will volunteer for sourdough batch');
    });

    it('renders read-only state for wound-up enterprise and hides posting form', async () => {
        vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({
            conversation: { id: 'enterprise-bakery-pubkey', type: 'enterprise_thread' },
            messages: [],
            readOnly: true,
        });

        render(
            <TreasuryDetailPage
                identity={mockCitizenIdentity}
                pubkey="enterprise-bakery-pubkey"
                onBack={() => {}}
            />
        );

        await waitFor(() => {
            expect(screen.getByText('Read-only (Wound up)')).toBeInTheDocument();
        });

        expect(screen.getByText(/This enterprise has wound up. Discussion is read-only for accountability/)).toBeInTheDocument();
        expect(screen.queryByPlaceholderText('Message the enterprise...')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Post' })).not.toBeInTheDocument();
    });

    it('subscribes to onSyncActivity for real-time live updates', async () => {
        let triggerSync: (() => void) | null = null;
        vi.spyOn(sync, 'onSyncActivity').mockImplementation((cb: any) => {
            triggerSync = cb;
            return () => {};
        });

        const threadSpy = vi.spyOn(api, 'getEnterpriseThread').mockResolvedValue({
            conversation: { id: 'enterprise-bakery-pubkey', type: 'enterprise_thread' },
            messages: [],
            readOnly: false,
        });

        render(
            <TreasuryDetailPage
                identity={mockCitizenIdentity}
                pubkey="enterprise-bakery-pubkey"
                onBack={() => {}}
            />
        );

        await waitFor(() => {
            expect(threadSpy).toHaveBeenCalledTimes(1);
        });

        // Trigger sync activity event
        expect(triggerSync).toBeTruthy();
        triggerSync!();

        await waitFor(() => {
            expect(threadSpy).toHaveBeenCalledTimes(2);
        });
    });
});
