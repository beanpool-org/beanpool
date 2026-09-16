import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FleetSidebar, NodeHealthStatus, AlertCounts, TabId } from './FleetSidebar';
import type { NodeProfile } from '../../lib/profiles';

describe('FleetSidebar Component', () => {
    const mockProfiles: NodeProfile[] = [
        { id: 'node-1', name: 'Alpha Node', url: 'http://alpha.local' },
        { id: 'node-2', name: 'Beta Node', url: 'http://beta.local' },
    ];

    const defaultProps = {
        profiles: mockProfiles,
        activeProfileId: 'node-1',
        onSelectNode: vi.fn(),
        onOpenAddModal: vi.fn(),
        onEditNode: vi.fn(),
        onRemoveNode: vi.fn(),
        onReorderNodes: vi.fn(),
        activeTab: 'overview' as TabId,
        onSelectTab: vi.fn(),
        isFleetMode: true,
    };

    it('renders fleet sidebar with brand title and connected profiles', () => {
        render(<FleetSidebar {...defaultProps} />);

        expect(screen.getByText('BeanPool')).toBeInTheDocument();
        expect(screen.getByText('Fleet Manager v1.2')).toBeInTheDocument();
        expect(screen.getAllByText('Alpha Node').length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText('Beta Node')).toBeInTheDocument();
        expect(screen.getByText('Connected Fleet (2)')).toBeInTheDocument();
    });

    it('calls onSelectTab when a navigation tab button is clicked', () => {
        const onSelectTab = vi.fn();
        render(<FleetSidebar {...defaultProps} onSelectTab={onSelectTab} />);

        const gatewayTab = screen.getByRole('button', { name: /gateway security/i });
        fireEvent.click(gatewayTab);

        expect(onSelectTab).toHaveBeenCalledWith('gateway');
    });

    it('calls onSelectNode when clicking a node card', () => {
        const onSelectNode = vi.fn();
        render(<FleetSidebar {...defaultProps} onSelectNode={onSelectNode} />);

        const betaNodeCard = screen.getByText('Beta Node');
        fireEvent.click(betaNodeCard);

        expect(onSelectNode).toHaveBeenCalledWith('node-2');
    });

    it('calls onOpenAddModal when clicking + Add Node button', () => {
        const onOpenAddModal = vi.fn();
        render(<FleetSidebar {...defaultProps} onOpenAddModal={onOpenAddModal} />);

        const addButton = screen.getByRole('button', { name: /\+ add node/i });
        fireEvent.click(addButton);

        expect(onOpenAddModal).toHaveBeenCalledTimes(1);
    });

    it('calls onEditNode when clicking the gear icon for a node', () => {
        const onEditNode = vi.fn();
        render(<FleetSidebar {...defaultProps} onEditNode={onEditNode} />);

        const editButtons = screen.getAllByTitle('Configure Node Credentials & Admin Password');
        fireEvent.click(editButtons[0]);

        expect(onEditNode).toHaveBeenCalledWith(mockProfiles[0]);
    });

    it('calls onRemoveNode when clicking remove button on a node profile', () => {
        const onRemoveNode = vi.fn();
        render(<FleetSidebar {...defaultProps} onRemoveNode={onRemoveNode} />);

        const removeButtons = screen.getAllByTitle('Remove Node Profile');
        fireEvent.click(removeButtons[0]);

        expect(onRemoveNode).toHaveBeenCalledWith('node-1');
    });

    it('renders alert counts badges on navigation tabs when specified', () => {
        const tabAlertCounts: Partial<Record<TabId, AlertCounts>> = {
            gateway: { critical: 2, warning: 1 },
        };

        render(<FleetSidebar {...defaultProps} tabAlertCounts={tabAlertCounts} />);

        expect(screen.getByTitle('2 Critical Alerts')).toBeInTheDocument();
        expect(screen.getByTitle('1 Warnings')).toBeInTheDocument();
    });

    it('renders node health status indicators correctly', () => {
        const nodeHealthMap: Record<string, NodeHealthStatus> = {
            'node-1': 'online',
            'node-2': 'auth_required',
        };

        render(<FleetSidebar {...defaultProps} nodeHealthMap={nodeHealthMap} />);

        expect(screen.getByTitle('Admin password needed')).toBeInTheDocument();
    });

    it('renders empty state when profiles array is empty', () => {
        const onOpenAddModal = vi.fn();
        render(<FleetSidebar {...defaultProps} profiles={[]} onOpenAddModal={onOpenAddModal} />);

        expect(screen.getByText('No Connected Nodes')).toBeInTheDocument();
        expect(screen.getByText('Add your first sovereign node profile to begin managing your fleet.')).toBeInTheDocument();

        const addSovereignButton = screen.getByRole('button', { name: /\+ add sovereign node/i });
        fireEvent.click(addSovereignButton);
        expect(onOpenAddModal).toHaveBeenCalledTimes(1);
    });

    describe('Single Node Mode (isFleetMode = false)', () => {
        const singleNodeProps = {
            ...defaultProps,
            isFleetMode: false,
            activeTab: 'home' as TabId,
        };

        it('renders single-node sidebar with Node Settings brand and 4 plain-English sections + Home', () => {
            render(<FleetSidebar {...singleNodeProps} />);

            expect(screen.getByText('BeanPool')).toBeInTheDocument();
            expect(screen.getByText('Node Settings')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /home/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /people & safety/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /shared projects & economy/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /bulletin & news/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /appliance & data/i })).toBeInTheDocument();

            // Omits fleet controls
            expect(screen.queryByText(/connected fleet/i)).not.toBeInTheDocument();
            expect(screen.queryByRole('button', { name: /\+ add node/i })).not.toBeInTheDocument();
            expect(screen.queryByText(/multi-server control plane/i)).not.toBeInTheDocument();
        });

        it('calls onSelectTab when a single-node section is clicked', () => {
            const onSelectTab = vi.fn();
            render(<FleetSidebar {...singleNodeProps} onSelectTab={onSelectTab} />);

            fireEvent.click(screen.getByRole('button', { name: /people & safety/i }));
            expect(onSelectTab).toHaveBeenCalledWith('people');

            fireEvent.click(screen.getByRole('button', { name: /appliance & data/i }));
            expect(onSelectTab).toHaveBeenCalledWith('appliance');
        });

        it('renders single node status card and legacy settings link', () => {
            render(<FleetSidebar {...singleNodeProps} />);

            expect(screen.getByText('Node Status')).toBeInTheDocument();
            expect(screen.getByText('Alpha Node')).toBeInTheDocument();
            expect(screen.getByText('Legacy Settings')).toHaveAttribute('href', '/settings-legacy');
        });

        it('renders community name in header brand and logo aria-label when provided', () => {
            render(<FleetSidebar {...singleNodeProps} communityName="Mullumbimby Commons" />);

            expect(screen.getAllByText('Mullumbimby Commons').length).toBe(2);
            expect(screen.getByRole('img', { name: 'Mullumbimby Commons — Node Settings' })).toBeInTheDocument();
        });
    });
});
