import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalyticsModule } from './AnalyticsModule';
import type { NodeProfile } from '../../lib/profiles';
import type { TelemetryHistoryPoint } from './AnalyticsModule';

describe('AnalyticsModule Component', () => {
    const mockProfiles: NodeProfile[] = [
        {
            id: 'node-1',
            name: 'Primary Node',
            url: 'http://localhost:8080',
            adminPassword: 'pass1',
        },
        {
            id: 'node-2',
            name: 'Secondary Node',
            url: 'http://localhost:8081',
            adminPassword: 'pass2',
        },
    ];

    const mockFleetDiags = {
        'node-1': { diag: null, loading: false, error: null },
        'node-2': { diag: null, loading: false, error: null },
    };

    const mockHistoryMap: Record<string, TelemetryHistoryPoint[]> = {
        'node-1': [
            { timestamp: 1000, cpu: 20, memMb: 500, totalMemMb: 1024, ws: 2, p2p: 3, walMb: 2.5, dbMb: 10 },
            { timestamp: 2000, cpu: 85, memMb: 900, totalMemMb: 1024, ws: 5, p2p: 5, walMb: 11.2, dbMb: 12 },
        ],
        'node-2': [
            { timestamp: 1000, cpu: 10, memMb: 200, totalMemMb: 2048, ws: 1, p2p: 1, walMb: 0.5, dbMb: 5 },
            { timestamp: 2000, cpu: 15, memMb: 250, totalMemMb: 2048, ws: 2, p2p: 1, walMb: 0.8, dbMb: 6 },
        ],
    };

    const mockHandlers = {
        onSelectNode: vi.fn(),
        onEditNode: vi.fn(),
        onRefreshFleet: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders empty state when no profiles are provided', () => {
        render(
            <AnalyticsModule
                profiles={[]}
                activeProfileId=""
                fleetDiags={{}}
                historyMap={{}}
                {...mockHandlers}
            />
        );

        expect(screen.getByText('No Node Profiles Active')).toBeInTheDocument();
        expect(
            screen.getByText(/Add one or more sovereign node profiles to begin monitoring/i)
        ).toBeInTheDocument();
    });

    it('renders peak threshold analytics and detects critical threshold breaches', () => {
        render(
            <AnalyticsModule
                profiles={mockProfiles}
                activeProfileId="node-1"
                fleetDiags={mockFleetDiags}
                historyMap={mockHistoryMap}
                {...mockHandlers}
            />
        );

        // Memory is default selected. node-1 has 900MB memory on 1024MB total (threshold ~819MB).
        // Peak breached -> CRITICAL PEAK DETECTED header badge
        expect(screen.getByText('CRITICAL PEAK DETECTED')).toBeInTheDocument();
        expect(screen.getAllByText('900 MB').length).toBeGreaterThan(0);
        expect(screen.getByText('Peak Node: Primary Node')).toBeInTheDocument();
        expect(screen.getByText('2 Sovereign Nodes')).toBeInTheDocument();
    });

    it('allows switching between metric types (CPU, Mesh Streams, SQLite WAL)', () => {
        render(
            <AnalyticsModule
                profiles={mockProfiles}
                activeProfileId="node-1"
                fleetDiags={mockFleetDiags}
                historyMap={mockHistoryMap}
                {...mockHandlers}
            />
        );

        // Switch to CPU Load
        const cpuBtn = screen.getByRole('button', { name: /CPU Load/i });
        fireEvent.click(cpuBtn);

        // Peak CPU is 85.0% (node-1 pt 2) -> Exceeds 80% threshold
        expect(screen.getAllByText('85.0%').length).toBeGreaterThan(0);
        expect(screen.getByText('Threshold: 80% CPU Load')).toBeInTheDocument();

        // Switch to Mesh Streams
        const streamsBtn = screen.getByRole('button', { name: /Mesh Streams/i });
        fireEvent.click(streamsBtn);

        // Peak Streams = 10 (ws 5 + p2p 5) -> Safe (< 50 threshold)
        expect(screen.getAllByText('10 Streams').length).toBeGreaterThan(0);
        expect(screen.getByText('Threshold: 50 Streams')).toBeInTheDocument();

        // Switch to SQLite WAL
        const walBtn = screen.getByRole('button', { name: /SQLite WAL/i });
        fireEvent.click(walBtn);

        // Peak WAL = 11.20 MB (node-1 pt 2) -> Exceeds 10.0 MB threshold
        expect(screen.getAllByText('11.20 MB').length).toBeGreaterThan(0);
        expect(screen.getByText('Threshold: 10.0 MB WAL')).toBeInTheDocument();
    });

    it('triggers refresh fleet, target node selection, and edit node callbacks', () => {
        render(
            <AnalyticsModule
                profiles={mockProfiles}
                activeProfileId="node-1"
                fleetDiags={mockFleetDiags}
                historyMap={mockHistoryMap}
                {...mockHandlers}
            />
        );

        // Refresh Fleet Analytics button
        const refreshBtn = screen.getByRole('button', { name: /Refresh Analytics/i });
        fireEvent.click(refreshBtn);
        expect(mockHandlers.onRefreshFleet).toHaveBeenCalledTimes(1);

        // Click Target Node button in capacity breakdown
        const targetBtns = screen.getAllByRole('button', { name: /Target Node/i });
        fireEvent.click(targetBtns[0]);
        expect(mockHandlers.onSelectNode).toHaveBeenCalledWith('node-1');

        // Click Settings button in capacity breakdown
        const settingsBtns = screen.getAllByRole('button', { name: /Settings/i });
        fireEvent.click(settingsBtns[0]);
        expect(mockHandlers.onEditNode).toHaveBeenCalledWith(mockProfiles[0]);
    });
});
