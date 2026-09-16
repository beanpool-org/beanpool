import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { HomeScreen } from './HomeScreen';

describe('HomeScreen Component', () => {
    const defaultProps = {
        communityName: 'Mullumbimby Commons',
        publicDomain: 'mullum.local',
        version: '1.4.2',
        diag: null,
        nodeData: null,
        onNavigate: vi.fn(),
        onInviteMember: vi.fn(),
        onCreateEnterprise: vi.fn(),
        onDownloadBackup: vi.fn().mockResolvedValue(undefined),
        onRunLedgerAudit: vi.fn().mockResolvedValue(undefined),
        auditState: { running: false, result: { ok: true, drift: 0, sumBalances: 100 } },
    };

    it('renders 0 enterprises and 0.0 circulation beans on cold start / empty node data', () => {
        render(<HomeScreen {...defaultProps} nodeData={{ members: [] }} />);

        // Enterprise card should render 0
        const enterpriseCard = screen.getByRole('button', { name: /Shared Enterprises/i });
        expect(enterpriseCard).toHaveTextContent('0');

        // Circulation card should render 0.0 beans
        const circulationCard = screen.getByRole('button', { name: /Circulation/i });
        expect(circulationCard).toHaveTextContent('0.0 beans');
    });

    it('derives enterprises count and circulation volume dynamically from nodeData', () => {
        const mockNodeData = {
            members: [
                { publicKey: 'pk-user1', name: 'Alice', isTreasury: false },
                { publicKey: 'pk-corp1', name: 'Community Bakery', isTreasury: true },
                { publicKey: 'pk-corp2', name: 'Tool Library', isTreasury: true },
            ],
            memberStats: {
                'pk-user1': { posts: 1, messages: 2, deals: 3, volume: 50.4, cancelled: 0 },
                'pk-corp1': { posts: 4, messages: 0, deals: 3, volume: 50.4, cancelled: 0 },
            },
        };

        render(<HomeScreen {...defaultProps} nodeData={mockNodeData} />);

        // 2 enterprises (isTreasury: true)
        const enterpriseCard = screen.getByRole('button', { name: /Shared Enterprises/i });
        expect(enterpriseCard).toHaveTextContent('2');

        // Total completed volume is 50.4 (100.8 / 2)
        const circulationCard = screen.getByRole('button', { name: /Circulation/i });
        expect(circulationCard).toHaveTextContent('50.4 beans');
    });

    it('renders plain-language reassurance card on clean recovery after unclean shutdown', async () => {
        const mockDiag: any = {
            shutdownStatus: {
                uncleanShutdown: true,
                recovered: true,
                ok: true,
                powerLossAt: '04:12',
                message: 'Recovered from power loss at 04:12. Database verified, no corruption.',
                acknowledged: false,
            },
        };

        const onAcknowledge = vi.fn().mockResolvedValue(undefined);

        render(<HomeScreen {...defaultProps} diag={mockDiag} onAcknowledgeShutdown={onAcknowledge} />);

        // Should display the plain-language card
        expect(screen.getByText(/Recovered from power loss at 04:12\. Database verified, no corruption\./i)).toBeInTheDocument();
        expect(screen.getByText(/PRAGMA integrity_check: ok/i)).toBeInTheDocument();

        // Dismissing card
        const dismissBtn = screen.getByRole('button', { name: /Dismiss/i });
        await act(async () => {
            dismissBtn.click();
        });
        expect(onAcknowledge).toHaveBeenCalled();
    });

    it('renders loud critical alert card when database corruption is detected after unclean shutdown', () => {
        const mockDiag: any = {
            shutdownStatus: {
                uncleanShutdown: true,
                recovered: false,
                ok: false,
                powerLossAt: '04:12',
                error: 'Page 42 is corrupted',
                message: 'Database corruption detected after power loss at 04:12!',
                acknowledged: false,
            },
        };

        render(<HomeScreen {...defaultProps} diag={mockDiag} />);

        expect(screen.getByText(/CRITICAL ALERT · DATABASE CORRUPTION DETECTED/i)).toBeInTheDocument();
        expect(screen.getByText(/Database corruption detected after power loss at 04:12!/i)).toBeInTheDocument();
        expect(screen.getByText(/Page 42 is corrupted/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Restore from Backup/i })).toBeInTheDocument();
    });

    it('shows storage warning at 80% or greater in Action Required', () => {
        const mockDiag: any = {
            diskHealth: {
                usedPercent: 82,
                warning: true,
            },
        };

        render(<HomeScreen {...defaultProps} diag={mockDiag} />);

        expect(screen.getByText(/Storage 82%/i)).toBeInTheDocument();
    });

    it('resets shutdownDismissed state when active node communityName or diagnostic status changes', async () => {
        const mockDiag1: any = {
            shutdownStatus: {
                uncleanShutdown: true,
                recovered: true,
                ok: true,
                powerLossAt: '04:12',
                powerLossTimestamp: '2026-09-17T04:12:00.000Z',
                checkedAt: '2026-09-17T04:15:00.000Z',
                message: 'Recovered from power loss at 04:12.',
                acknowledged: false,
            },
        };

        const { rerender } = render(<HomeScreen {...defaultProps} communityName="Node Alpha" diag={mockDiag1} />);
        expect(screen.getByTestId('unclean-shutdown-reassurance')).toBeInTheDocument();

        // Dismiss on Node Alpha
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /Dismiss/i }));
        });
        expect(screen.queryByTestId('unclean-shutdown-reassurance')).not.toBeInTheDocument();

        // Switch to Node Beta
        rerender(<HomeScreen {...defaultProps} communityName="Node Beta" diag={mockDiag1} />);
        expect(screen.getByTestId('unclean-shutdown-reassurance')).toBeInTheDocument();
    });
});

