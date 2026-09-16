import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StandbyReplicationPanel } from './StandbyReplicationPanel';
import type { NodeProfile } from '../../lib/profiles';

describe('StandbyReplicationPanel Component (Bucket 2 Item 3)', () => {
    const mockNode: NodeProfile = {
        id: 'node-standby-1',
        name: 'Standby Replica Node',
        url: 'https://standby.example.com',
        adminPassword: 'test-admin-secret',
    };

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('renders with a real payload, supports saving configuration, and executes resync with confirmation', async () => {
        const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.includes('/api/local/admin/backup-status')) {
                return {
                    ok: true,
                    json: async () => ({
                        role: 'backup',
                        primaryUrl: 'https://primary.example.com',
                        intervalMs: 30000,
                        lastSuccess: '2026-09-15T12:00:00.000Z',
                        failStreak: 0,
                        isSynced: true,
                    }),
                };
            }
            if (url.includes('/api/local/admin/replication-config/get')) {
                return {
                    ok: true,
                    json: async () => ({
                        primaryUrl: 'https://primary.example.com',
                        hasPassword: true,
                        hasToken: true,
                    }),
                };
            }
            if (url.includes('/api/local/admin/replication-config/save')) {
                return {
                    ok: true,
                    json: async () => ({ success: true }),
                };
            }
            if (url.includes('/api/local/admin/replication-resync')) {
                return {
                    ok: true,
                    json: async () => ({ success: true }),
                };
            }
            return { ok: true, json: async () => ({}) };
        });
        vi.stubGlobal('fetch', fetchMock);

        const handleRefreshDiag = vi.fn();

        render(
            <StandbyReplicationPanel
                activeNode={mockNode}
                onRefreshDiag={handleRefreshDiag}
            />
        );

        // Header & Role Badge
        expect(screen.getByText('Live Backup Server & Hot-Standby Replication')).toBeInTheDocument();
        await waitFor(() => {
            expect(screen.getByText('Standby Replica')).toBeInTheDocument();
        });

        // Telemetry metrics
        expect(screen.getByText('🟢 Healthy')).toBeInTheDocument();
        expect(screen.getByText('Every 30s')).toBeInTheDocument();

        // Check primary URL input populated
        const urlInput = screen.getByLabelText(/Primary Node HTTPS URL/i) as HTMLInputElement;
        expect(urlInput.value).toBe('https://primary.example.com');

        // Update primary URL and submit configuration form
        await userEvent.clear(urlInput);
        await userEvent.type(urlInput, 'https://new-primary.example.com');

        const saveBtn = screen.getByRole('button', { name: /Save Connection/i });
        await userEvent.click(saveBtn);

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining('/api/local/admin/replication-config/save'),
                expect.objectContaining({
                    method: 'POST',
                    body: expect.stringContaining('https://new-primary.example.com'),
                })
            );
            expect(screen.getByText(/Replication configuration saved successfully/i)).toBeInTheDocument();
        });

        // Trigger Resync with confirmation
        const resyncTriggerBtn = screen.getByRole('button', { name: /Force Full Resync/i });
        await userEvent.click(resyncTriggerBtn);

        // Confirmation modal appears
        expect(screen.getByText('Confirm Full Replication Resync')).toBeInTheDocument();
        expect(screen.getByText(/Rebuild replica tables from primary snapshot\?/i)).toBeInTheDocument();

        // Confirm resync
        const confirmBtn = screen.getByRole('button', { name: /Force Resync/i });
        await userEvent.click(confirmBtn);

        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining('/api/local/admin/replication-resync'),
                expect.objectContaining({ method: 'POST' })
            );
            expect(screen.getByText(/Resync complete/i)).toBeInTheDocument();
        });
    });

    it('renders safely with an empty payload', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({}),
            })
        );

        render(
            <StandbyReplicationPanel
                activeNode={mockNode}
            />
        );

        expect(screen.getByText('Live Backup Server & Hot-Standby Replication')).toBeInTheDocument();
        await waitFor(() => {
            expect(screen.getByText('Primary Node')).toBeInTheDocument();
        });
        expect(screen.getByText('Never')).toBeInTheDocument();
    });

    it('renders safely with wrong-typed fields and malformed data', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    role: 99999 as any,
                    primaryUrl: 12345 as any,
                    intervalMs: 'not-a-number' as any,
                    lastSuccess: false as any,
                    failStreak: 'bad-streak' as any,
                }),
            })
        );

        render(
            <StandbyReplicationPanel
                activeNode={mockNode}
            />
        );

        expect(screen.getByText('Live Backup Server & Hot-Standby Replication')).toBeInTheDocument();
        await waitFor(() => {
            expect(screen.getByText('Primary Node')).toBeInTheDocument();
        });
    });

    it('allows cancelling the resync confirmation modal', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ role: 'backup' }),
            })
        );

        render(
            <StandbyReplicationPanel
                activeNode={mockNode}
            />
        );

        const resyncTriggerBtn = screen.getByRole('button', { name: /Force Full Resync/i });
        await userEvent.click(resyncTriggerBtn);

        expect(screen.getByText('Confirm Full Replication Resync')).toBeInTheDocument();

        // Click Cancel
        await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByText('Confirm Full Replication Resync')).not.toBeInTheDocument();
    });
});
