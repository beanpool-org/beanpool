import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TopologyModule } from './TopologyModule';
import type { NodeProfile } from '../../lib/profiles';

vi.mock('../../lib/node-client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../lib/node-client')>();
    return {
        ...actual,
        fetchHarvesterStatus: vi.fn().mockResolvedValue({ harvestState: {} }),
        getRegistrarPending: vi.fn().mockResolvedValue([]),
    };
});

describe('TopologyModule Component', () => {
    const mockNode: NodeProfile = {
        id: 'node-1',
        name: 'Local Sovereign Node',
        url: 'http://localhost:3001',
        adminPassword: 'admin',
    };

    it('renders empty state when no fleet nodes are present', () => {
        render(
            <TopologyModule
                activeNode={null as unknown as NodeProfile}
                profiles={[]}
                diag={null}
                onRefresh={() => {}}
            />
        );

        expect(screen.getByText('No Fleet Nodes Configured')).toBeInTheDocument();
        expect(
            screen.getByText(
                'Configure or select a sovereign node profile in Fleet Settings to view harvested fleet backups.'
            )
        ).toBeInTheDocument();
    });

    it('renders node backup row when fleet nodes are configured', async () => {
        render(
            <TopologyModule
                activeNode={mockNode}
                profiles={[mockNode]}
                diag={null}
                onRefresh={() => {}}
            />
        );

        expect(await screen.findByText('Local Sovereign Node')).toBeInTheDocument();
        expect(await screen.findByText('http://localhost:3001')).toBeInTheDocument();
    });
});
