import React, { act } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TopologyModule } from './TopologyModule';
import type { NodeProfile } from '../../lib/profiles';

const mockFetchHarvesterStatus = vi.fn();
const mockGetRegistrarPending = vi.fn();
const mockApproveRegistrarClaim = vi.fn();
const mockRevokeRegistrarClaim = vi.fn();
const mockFetchNodeSnapshots = vi.fn();
const mockCreateNodeSnapshot = vi.fn();

vi.mock('../../lib/node-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/node-client')>();
    return {
        ...actual,
        fetchHarvesterStatus: (...args: any[]) => mockFetchHarvesterStatus(...args),
        getRegistrarPending: (...args: any[]) => mockGetRegistrarPending(...args),
        approveRegistrarClaim: (...args: any[]) => mockApproveRegistrarClaim(...args),
        revokeRegistrarClaim: (...args: any[]) => mockRevokeRegistrarClaim(...args),
        fetchNodeSnapshots: (...args: any[]) => mockFetchNodeSnapshots(...args),
        createNodeSnapshot: (...args: any[]) => mockCreateNodeSnapshot(...args),
    };
});

describe('TopologyModule Component', () => {
    const mockNode: NodeProfile = {
        id: 'node-1',
        name: 'Local Sovereign Node',
        url: 'http://localhost:3001',
        adminPassword: 'admin',
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockFetchHarvesterStatus.mockResolvedValue({ harvestState: {} });
        mockGetRegistrarPending.mockResolvedValue([]);
        mockFetchNodeSnapshots.mockResolvedValue([]);
    });

    it('renders empty state when no fleet nodes are present', async () => {
        await act(async () => {
            render(
                <TopologyModule
                    activeNode={null as unknown as NodeProfile}
                    profiles={[]}
                    diag={null}
                    onRefresh={() => {}}
                />
            );
        });

        expect(screen.getByText('No Fleet Nodes Configured')).toBeInTheDocument();
        expect(
            screen.getByText(
                'Configure or select a sovereign node profile in Fleet Settings to view harvested fleet backups.'
            )
        ).toBeInTheDocument();
    });

    it('renders node backup row when fleet nodes are configured', async () => {
        await act(async () => {
            render(
                <TopologyModule
                    activeNode={mockNode}
                    profiles={[mockNode]}
                    diag={null}
                    onRefresh={() => {}}
                />
            );
        });

        expect(await screen.findByText('Local Sovereign Node')).toBeInTheDocument();
        expect(await screen.findByText('http://localhost:3001')).toBeInTheDocument();
    });

    it('switches tabs between fleet backups, snapshots, replication, domain claims, and runbook', async () => {
        await act(async () => {
            render(
                <TopologyModule
                    activeNode={mockNode}
                    profiles={[mockNode]}
                    diag={null}
                    onRefresh={() => {}}
                />
            );
        });

        // Switch to On-Node Snapshots tab
        await act(async () => {
            fireEvent.click(screen.getByText('On-Node Snapshots'));
        });
        expect(await screen.findByText('On-Device SQLite Snapshots (Local Sovereign Node)')).toBeInTheDocument();

        // Switch to Replication & Standby tab
        await act(async () => {
            fireEvent.click(screen.getByText('Replication & Standby'));
        });
        expect(await screen.findByText('Replication Pull & Reconcile Cadence (Local Sovereign Node)')).toBeInTheDocument();

        // Switch to Domain Name Claims tab
        await act(async () => {
            fireEvent.click(screen.getByText('Domain Name Claims'));
        });
        expect(await screen.findByText('Sovereign Node DNS Registrar Management')).toBeInTheDocument();

        // Switch to Disaster Recovery Runbook tab
        await act(async () => {
            fireEvent.click(screen.getByText('Disaster Recovery Runbook'));
        });
        expect(await screen.findByText('🛠️ Turnkey Disaster Recovery Runbook')).toBeInTheDocument();
    });

    it('loads and approves pending domain name claims', async () => {
        mockGetRegistrarPending.mockResolvedValueOnce([
            {
                name: 'testdomain',
                hostname: 'testdomain.beanpool.org',
                status: 'pending',
                node_pubkey: 'pubkey1234567890abcdef',
                community_name: 'Test Community',
                contact: 'admin@test.org',
                mode: 'tunnel',
                tier: 'gated',
                requested_at: '2026-09-10T12:00:00Z',
            },
        ]);
        mockApproveRegistrarClaim.mockResolvedValueOnce({ ok: true });

        await act(async () => {
            render(
                <TopologyModule
                    activeNode={mockNode}
                    profiles={[mockNode]}
                    diag={null}
                    onRefresh={() => {}}
                />
            );
        });

        // Switch to Domain Name Claims
        await act(async () => {
            fireEvent.click(screen.getByText('Domain Name Claims'));
        });

        // Verify pending claim renders
        expect(await screen.findByText('testdomain.beanpool.org')).toBeInTheDocument();
        expect(screen.getByText('Test Community')).toBeInTheDocument();

        // Click Approve
        await act(async () => {
            fireEvent.click(screen.getByText('Approve'));
        });

        // Confirm Approve
        expect(screen.getByText('Confirm Approve?')).toBeInTheDocument();
        await act(async () => {
            fireEvent.click(screen.getByText('Yes, Approve'));
        });

        await waitFor(() => {
            expect(mockApproveRegistrarClaim).toHaveBeenCalledWith(
                mockNode.url,
                'testdomain',
                mockNode.adminPassword,
                undefined
            );
        });
    });

    it('loads and creates node snapshots', async () => {
        mockFetchNodeSnapshots.mockResolvedValueOnce([
            {
                name: 'snapshot-20260915.sqlite',
                sizeBytes: 1048576,
                createdAt: '2026-09-15 10:00:00',
            },
        ]);
        mockCreateNodeSnapshot.mockResolvedValueOnce({ success: true });

        await act(async () => {
            render(
                <TopologyModule
                    activeNode={mockNode}
                    profiles={[mockNode]}
                    diag={null}
                    onRefresh={() => {}}
                />
            );
        });

        // Switch to On-Node Snapshots
        await act(async () => {
            fireEvent.click(screen.getByText('On-Node Snapshots'));
        });

        // Verify snapshot list renders
        expect(await screen.findByText('snapshot-20260915.sqlite')).toBeInTheDocument();

        // Click Create Snapshot Now
        await act(async () => {
            fireEvent.click(screen.getByText('Create Snapshot Now'));
        });

        await waitFor(() => {
            expect(mockCreateNodeSnapshot).toHaveBeenCalledWith(
                mockNode.url,
                mockNode.adminPassword,
                undefined
            );
        });
    });
});
