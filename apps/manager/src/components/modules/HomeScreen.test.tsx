import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { HomeScreen, SERVER_ALERTS_ANCHOR } from './HomeScreen';

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
        // A cold-start node's real answer: no members yet, and trade totals of zero (every node sends tradeTotals). A 0
        // here is the node's; a payload without the field is "couldn't load" (below), never 0.
        render(<HomeScreen {...defaultProps} nodeData={{ members: [], tradeTotals: { deals: 0, volume: 0, cancelled: 0 } }} />);

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
                'pk-user1': { posts: 1, messages: 2 },
                'pk-corp1': { posts: 4, messages: 0 },
            },
            tradeTotals: { deals: 3, volume: 50.4, cancelled: 0 },
        };

        render(<HomeScreen {...defaultProps} nodeData={mockNodeData} />);

        // 2 enterprises (isTreasury: true)
        const enterpriseCard = screen.getByRole('button', { name: /Shared Enterprises/i });
        expect(enterpriseCard).toHaveTextContent('2');

        // The community's completed volume, from its trade totals (member stats carry no trades)
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

    it("shows the owners' banner while the standby needs them, and lets an owner stop watching one gone for good", async () => {
        const standbyHealth = {
            incident: {
                id: 'inc1', startedAt: Date.now(), pushed: true,
                lines: ['The standby at 203.0.113.9 has not made a copy of this server since 2026-09-28 01:34 UTC.'],
                whatToDo: ['Check the standby server is running and can reach this one.'],
            },
            standbys: [
                { id: 'a'.repeat(32), label: 'The standby at 203.0.113.9', lastPullAt: 1, lastCopyAt: 1, lastExactAt: 1, healthy: false },
                { id: 'b'.repeat(32), label: 'The standby at 203.0.113.10', lastPullAt: 1, lastCopyAt: 1, lastExactAt: 1, healthy: true },
            ],
        };
        const onForgetStandby = vi.fn().mockResolvedValue(undefined);
        const { rerender } = render(<HomeScreen {...defaultProps} diag={{ standbyHealth } as any} onForgetStandby={onForgetStandby} />);
        const banner = screen.getByTestId('standby-health-banner');
        expect(banner).toHaveTextContent('Your standby server needs attention');
        expect(banner).toHaveTextContent(standbyHealth.incident.lines[0]);
        expect(banner).toHaveTextContent(standbyHealth.incident.whatToDo[0]);
        // Only the standby that needs them can be let go from here.
        expect(screen.queryByRole('button', { name: /203\.0\.113\.10/ })).toBeNull();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'The standby at 203.0.113.9 is gone for good: stop watching it' }));
        });
        expect(onForgetStandby).toHaveBeenCalledWith('a'.repeat(32));

        // No incident (or a server before the watch, or someone not an owner): no banner.
        rerender(<HomeScreen {...defaultProps} diag={{ standbyHealth: { ...standbyHealth, incident: null } } as any} onForgetStandby={onForgetStandby} />);
        expect(screen.queryByTestId('standby-health-banner')).toBeNull();
        rerender(<HomeScreen {...defaultProps} diag={{ standbyHealth: null } as any} />);
        expect(screen.queryByTestId('standby-health-banner')).toBeNull();
    });

    it("shows the owners' banner when the standby's address redirects", () => {
        const standbyHealth = {
            incident: {
                id: 'inc2', startedAt: Date.now(), pushed: true,
                lines: ["The standby's address redirects to other.example: point it at the server itself."],
                whatToDo: ["Open the standby's own Settings, under Live Backup Server, for what it says; a force-resync there copies this server afresh."],
            },
            standbys: [
                { id: 'a'.repeat(32), label: 'The standby', lastPullAt: 1, lastCopyAt: 1, lastExactAt: 1, healthy: false },
            ],
        };
        render(<HomeScreen {...defaultProps} diag={{ standbyHealth } as any} />);
        const banner = screen.getByTestId('standby-health-banner');
        expect(banner).toHaveTextContent("The standby's address redirects to other.example: point it at the server itself.");
    });

    it("shows the owners' banner while backups off the server need them, and opens the Backups tab", async () => {
        const problems = ['Off-box backup to "Cloudflare R2" failed: HTTP 503. Last one that arrived: 2026-10-01 02:00 UTC. Next try: 2026-10-02 02:15 UTC.'];
        const onNavigate = vi.fn();
        const { rerender } = render(<HomeScreen {...defaultProps} onNavigate={onNavigate} diag={{ offboxBackups: { problems } } as any} />);
        const banner = screen.getByTestId('offbox-health-banner');
        expect(banner).toHaveTextContent('Backups off the server need attention');
        expect(banner).toHaveTextContent(problems[0]);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Open Backups & Restore' }));
        });
        expect(onNavigate).toHaveBeenCalledWith('appliance', 'backups');

        // Nothing to say, someone not an owner (null), or a server from before them: no banner.
        rerender(<HomeScreen {...defaultProps} diag={{ offboxBackups: { problems: [] } } as any} />);
        expect(screen.queryByTestId('offbox-health-banner')).toBeNull();
        rerender(<HomeScreen {...defaultProps} diag={{ offboxBackups: null } as any} />);
        expect(screen.queryByTestId('offbox-health-banner')).toBeNull();
        rerender(<HomeScreen {...defaultProps} diag={{} as any} />);
        expect(screen.queryByTestId('offbox-health-banner')).toBeNull();
    });

    describe("the server's alerts and figures that didn't load (Marty, 19 Oct: 'This server has alerts: 1' on the phone, 'All clear' and 0 members here)", () => {
        const loaded = {
            members: [{ publicKey: 'a', isTreasury: false }, { publicKey: 'b', isTreasury: false }, { publicKey: 'c', isTreasury: true }],
            reportCount: 0, escrowDisputesCount: 0, tradeTotals: { deals: 2, volume: 12.5, cancelled: 0 }, commonsBalance: 40.25,
        };
        const alertItems = [
            { key: 'backups.none', title: 'backups stay on this server', priority: 2, since: 1, detail: 'Backups stay on this server: no destination and no recovery code.' },
            { key: 'disk.90', title: 'disk 90% full', priority: 4, since: 2, detail: 'The disk is 91% full.' },
        ];
        const diagWith = (serverAlerts: unknown) => ({ activeWsConnections: 2, dbSizeBytes: 1, walSizeBytes: 0, serverAlerts }) as any;

        it('lists each alert the phone counts, in the node\'s words, linked to the Alerts card; no All clear', async () => {
            const onNavigate = vi.fn();
            render(<HomeScreen {...defaultProps} onNavigate={onNavigate} nodeData={loaded} diag={diagWith({ count: 2, items: alertItems })} />);
            const panel = screen.getByTestId('home-action-required');
            expect(panel).toHaveTextContent('This server has alerts: 2');
            for (const a of alertItems) expect(panel).toHaveTextContent(a.detail);
            expect(panel).not.toHaveTextContent(/All clear/);
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: /The disk is 91% full\./ }));
            });
            expect(onNavigate).toHaveBeenCalledWith('appliance', 'backups', SERVER_ALERTS_ANCHOR);
        });

        it('says All clear only when the alerts were read and there are none, and the data is in', () => {
            const { rerender } = render(<HomeScreen {...defaultProps} nodeData={loaded} diag={diagWith({ count: 0, items: [] })} />);
            expect(screen.getByText(/All clear/)).toBeInTheDocument();
            // Not an owner: the node sends them no alerts (null), as the phone shows them none; the rest was read.
            rerender(<HomeScreen {...defaultProps} nodeData={loaded} diag={diagWith(null)} />);
            expect(screen.getByText(/All clear/)).toBeInTheDocument();
            // A server from before the list (or one that couldn't read its alert book): unread, so not all clear.
            rerender(<HomeScreen {...defaultProps} nodeData={loaded} diag={diagWith(undefined)} />);
            expect(screen.queryByText(/All clear/)).toBeNull();
            expect(screen.getByRole('button', { name: /alerts couldn't be read here/ })).toBeInTheDocument();
            // Diagnostics not in yet: storage and alerts unchecked.
            rerender(<HomeScreen {...defaultProps} nodeData={loaded} diag={null} />);
            expect(screen.queryByText(/All clear/)).toBeNull();
            expect(screen.getByText(/Checking storage and the server's alerts/)).toBeInTheDocument();
            // The data not in: reports and disputes unchecked.
            rerender(<HomeScreen {...defaultProps} nodeData={null} nodeDataError="HTTP 500: Error" diag={diagWith({ count: 0, items: [] })} />);
            expect(screen.queryByText(/All clear/)).toBeNull();
            expect(screen.getByText(/Couldn't check reports and escrow disputes \(HTTP 500: Error\)/)).toBeInTheDocument();
        });

        it("a failed or refused data load says each figure couldn't load, with a retry; never 0", async () => {
            const onRetryNodeData = vi.fn();
            render(<HomeScreen {...defaultProps} nodeData={null} nodeDataError="HTTP 403: Forbidden" onRetryNodeData={onRetryNodeData} diag={diagWith({ count: 0, items: [] })} />);
            for (const id of ['members', 'pool', 'enterprises', 'circulation']) {
                const card = screen.getByTestId(`home-figure-${id}`);
                expect(card).toHaveTextContent("Couldn't load");
                expect(card).not.toHaveTextContent(/\b0(\.0)?\b/);
            }
            expect(screen.getByTestId('home-figures-unloaded')).toHaveTextContent("Members, the Commons pool, enterprises and circulation couldn't load (HTTP 403: Forbidden).");
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: 'Retry the figures' }));
            });
            expect(onRetryNodeData).toHaveBeenCalled();
        });

        it('while the data loads, the figures say so, not 0', () => {
            render(<HomeScreen {...defaultProps} nodeData={null} nodeDataLoading diag={null} />);
            for (const id of ['members', 'pool', 'enterprises', 'circulation']) {
                expect(screen.getByTestId(`home-figure-${id}`)).toHaveTextContent('Loading…');
            }
            expect(screen.getByTestId('home-connections')).toHaveTextContent('Connections loading…');
            expect(screen.queryByText(/All clear/)).toBeNull();
        });

        it("a figure an older server doesn't send says it couldn't load, not 0", () => {
            render(<HomeScreen {...defaultProps} nodeData={{ members: loaded.members, reportCount: 0, escrowDisputesCount: 0 }} diag={diagWith({ count: 0, items: [] })} />);
            expect(screen.getByTestId('home-figure-members')).toHaveTextContent('2');
            expect(screen.getByTestId('home-figure-pool')).toHaveTextContent("Couldn't load");
            expect(screen.getByTestId('home-figure-circulation')).toHaveTextContent("Couldn't load");
            expect(screen.getByTestId('home-figures-unloaded')).toHaveTextContent("The Commons pool and circulation couldn't load: this server doesn't send them yet, so update it.");
        });

        it("the Commons pool is the node's pot, not the ledger audit's sum of balances", () => {
            render(<HomeScreen {...defaultProps} auditState={{ running: false, result: { ok: true, drift: 0, sumBalances: -9.82 } }} nodeData={loaded} diag={diagWith({ count: 0, items: [] })} />);
            const pool = screen.getByTestId('home-figure-pool');
            expect(pool).toHaveTextContent('40.3 beans');
            expect(pool).not.toHaveTextContent('9.8');
        });

        it("diagnostics that failed: the connections couldn't load, with a retry; a loaded count is the node's", async () => {
            const onRetryDiag = vi.fn();
            const { rerender } = render(<HomeScreen {...defaultProps} nodeData={loaded} diag={null} diagError="HTTP 500: Error" onRetryDiag={onRetryDiag} />);
            expect(screen.getByTestId('home-connections')).toHaveTextContent("Connections couldn't load");
            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: 'Retry connections' }));
            });
            expect(onRetryDiag).toHaveBeenCalled();
            rerender(<HomeScreen {...defaultProps} nodeData={loaded} diag={diagWith({ count: 0, items: [] })} />);
            expect(screen.getByTestId('home-connections')).toHaveTextContent('2 active connections');
        });
    });
});

