import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelemetryModule } from './TelemetryModule';
import type { NodeProfile } from '../../lib/profiles';

describe('TelemetryModule', () => {
    const mockProfiles: NodeProfile[] = [
        {
            id: 'node-1',
            name: 'Primary Node',
            url: 'http://localhost:8080',
            adminPassword: 'secret1',
        },
        {
            id: 'node-2',
            name: 'Secondary Node',
            url: 'http://localhost:8081',
            adminPassword: 'secret2',
        },
    ];

    const mockFleetDiags = {
        'node-1': {
            diag: {
                callsign: 'NODE-1',
                status: 'online',
                communityName: 'Test Community',
                uptimeSeconds: 7200,
                activeWsConnections: 12,
                p2pActivePeers: 5,
                dbSizeBytes: 10485760, // 10 MB
                walSizeBytes: 102400,
                cpuLoadPercent: 25,
                memoryUsageMb: 256,
                totalMemoryMb: 2048,
                userCount: 42,
            },
            loading: false,
            error: null,
        },
        'node-2': {
            diag: null,
            loading: false,
            error: '401 Unauthorized',
        },
    };

    const mockHandlers = {
        onSelectNode: vi.fn(),
        onInspectNodeThreats: vi.fn(),
        onEditNode: vi.fn(),
        onRefreshFleet: vi.fn(),
        onSelectTab: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
    });

    it('renders empty state when no node profiles exist', () => {
        render(
            <TelemetryModule
                profiles={[]}
                activeProfileId=""
                fleetDiags={{}}
                {...mockHandlers}
            />
        );

        expect(screen.getByText('No active node profiles found')).toBeInTheDocument();
        expect(screen.getByText('0 Nodes Fleet')).toBeInTheDocument();
    });

    it('renders fleet summary ribbon metrics accurately', () => {
        render(
            <TelemetryModule
                profiles={mockProfiles}
                activeProfileId="node-1"
                fleetDiags={mockFleetDiags}
                {...mockHandlers}
            />
        );

        // 1 of 2 nodes online (node-1 has diag, node-2 has error)
        expect(screen.getByText('1 / 2 Online')).toBeInTheDocument();
        // 42 total users
        expect(screen.getByText('42 Users')).toBeInTheDocument();
        // 10.00 MB storage
        expect(screen.getByText('10.00 MB')).toBeInTheDocument();
        // 12 active websockets
        expect(screen.getByText('12 Streams')).toBeInTheDocument();
        // 5 P2P peers
        expect(screen.getByText('5 Peers')).toBeInTheDocument();
    });

    it('triggers refresh fleet handler when refresh button is clicked', () => {
        render(
            <TelemetryModule
                profiles={mockProfiles}
                activeProfileId="node-1"
                fleetDiags={mockFleetDiags}
                {...mockHandlers}
            />
        );

        const refreshBtn = screen.getByText('Refresh Fleet Telemetry');
        fireEvent.click(refreshBtn);

        expect(mockHandlers.onRefreshFleet).toHaveBeenCalledTimes(1);
    });

    it('allows toggling between condensed grid view and expanded cards view', () => {
        render(
            <TelemetryModule
                profiles={mockProfiles}
                activeProfileId="node-1"
                fleetDiags={mockFleetDiags}
                {...mockHandlers}
            />
        );

        // By default, Condensed Grid is active
        expect(screen.getByText('Condensed Grid')).toBeInTheDocument();

        // Switch to Expanded Cards
        const expandedBtn = screen.getByText('Expanded Cards');
        fireEvent.click(expandedBtn);

        expect(localStorage.getItem('bp_telemetry_view_mode')).toBe('expanded');
        expect(screen.getByText('PRIMARY TARGET')).toBeInTheDocument();
        expect(screen.getByText('2h 0m 0s')).toBeInTheDocument(); // uptime formatted
    });

    it('triggers node selection and edit callbacks in condensed view', () => {
        render(
            <TelemetryModule
                profiles={mockProfiles}
                activeProfileId="node-1"
                fleetDiags={mockFleetDiags}
                {...mockHandlers}
            />
        );

        // Click node card
        const primaryNodeCard = screen.getByText('Primary Node').closest('div');
        if (primaryNodeCard) {
            fireEvent.click(primaryNodeCard);
        }

        expect(mockHandlers.onSelectNode).toHaveBeenCalledWith('node-1');
        expect(mockHandlers.onInspectNodeThreats).toHaveBeenCalledWith('node-1');

        // Click configure node button (settings gear)
        const gearBtns = screen.getAllByTitle('Configure Node Settings');
        fireEvent.click(gearBtns[0]);

        expect(mockHandlers.onEditNode).toHaveBeenCalledWith(mockProfiles[0]);
    });

    it('triggers tab navigation when dedicated peak analytics button is clicked', () => {
        render(
            <TelemetryModule
                profiles={mockProfiles}
                activeProfileId="node-1"
                fleetDiags={mockFleetDiags}
                {...mockHandlers}
            />
        );

        const analyticsBtn = screen.getByText('Open Peak Analytics');
        fireEvent.click(analyticsBtn);

        expect(mockHandlers.onSelectTab).toHaveBeenCalledWith('analytics');
    });
});
