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
});
