import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EnterpriseLocationPicker } from './EnterpriseLocationPicker';
import * as nodeClient from '../../lib/node-client';
import type { NodeProfile } from '../../lib/profiles';
import type { NodeTreasury } from '../../lib/node-client';

vi.mock('../../lib/node-client', async () => {
    const actual = await vi.importActual('../../lib/node-client');
    return {
        ...actual,
        updateEnterpriseLocation: vi.fn(),
        clearEnterpriseLocation: vi.fn(),
    };
});

vi.mock('leaflet', () => {
    const mockMap = {
        setView: vi.fn().mockReturnThis(),
        on: vi.fn(),
        remove: vi.fn(),
    };
    const mockMarker = {
        addTo: vi.fn().mockReturnThis(),
        on: vi.fn(),
        setLatLng: vi.fn().mockReturnThis(),
        remove: vi.fn(),
    };
    const mockTileLayer = {
        addTo: vi.fn().mockReturnThis(),
    };

    return {
        default: {
            map: vi.fn(() => mockMap),
            marker: vi.fn(() => mockMarker),
            tileLayer: vi.fn(() => mockTileLayer),
            divIcon: vi.fn(() => ({})),
        },
    };
});

const mockActiveNode: NodeProfile = {
    id: 'test-node-1',
    name: 'Test Node',
    url: 'https://test-node.local',
    adminPassword: 'secret-admin-password',
};

const mockTreasuryWithCoords: NodeTreasury = {
    publicKey: 'pubkey-12345',
    name: 'Mullum Enterprise',
    balance: 1000,
    creditLine: 500,
    liveOffers: 2,
    lat: -28.55,
    lng: 153.50,
};

const mockTreasuryWithoutCoords: NodeTreasury = {
    publicKey: 'pubkey-67890',
    name: 'Unlocated Enterprise',
    balance: 500,
    creditLine: 0,
    liveOffers: 0,
    lat: null,
    lng: null,
};

describe('EnterpriseLocationPicker Component', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders heading, visibility notice, map container, coordinate inputs, and actions', () => {
        render(
            <EnterpriseLocationPicker
                treasury={mockTreasuryWithCoords}
                activeNode={mockActiveNode}
                effectiveTfaToken="tfa-session-token"
                onLocationSaved={vi.fn()}
                onClose={vi.fn()}
            />
        );

        expect(screen.getByText('Enterprise Map Location')).toBeInTheDocument();
        expect(screen.getByTestId('enterprise-location-visibility')).toBeInTheDocument();
        expect(screen.getByText(/Anyone who opens this node's map will see this spot/i)).toBeInTheDocument();

        const latInput = screen.getByLabelText(/Latitude/i) as HTMLInputElement;
        const lngInput = screen.getByLabelText(/Longitude/i) as HTMLInputElement;

        expect(latInput.value).toBe('-28.55');
        expect(lngInput.value).toBe('153.5');

        expect(screen.getByRole('button', { name: /Approximate/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Clear Location/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Save Location/i })).toBeInTheDocument();
    });

    it('disables approximate button when coordinates are not set', () => {
        render(
            <EnterpriseLocationPicker
                treasury={mockTreasuryWithoutCoords}
                activeNode={mockActiveNode}
                onLocationSaved={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const approxBtn = screen.getByRole('button', { name: /Approximate/i });
        expect(approxBtn).toBeDisabled();
        expect(screen.queryByRole('button', { name: /Clear Location/i })).not.toBeInTheDocument();
    });

    it('updates lat and lng on direct text input changes', () => {
        render(
            <EnterpriseLocationPicker
                treasury={mockTreasuryWithoutCoords}
                activeNode={mockActiveNode}
                onLocationSaved={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const latInput = screen.getByLabelText(/Latitude/i) as HTMLInputElement;
        const lngInput = screen.getByLabelText(/Longitude/i) as HTMLInputElement;

        fireEvent.change(latInput, { target: { value: '-27.4698' } });
        fireEvent.change(lngInput, { target: { value: '153.0251' } });

        expect(latInput.value).toBe('-27.4698');
        expect(lngInput.value).toBe('153.0251');

        const saveBtn = screen.getByRole('button', { name: /Save Location/i });
        expect(saveBtn).not.toBeDisabled();
    });

    it('rounds coordinates when Approximate button is clicked', () => {
        render(
            <EnterpriseLocationPicker
                treasury={mockTreasuryWithCoords}
                activeNode={mockActiveNode}
                onLocationSaved={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const approxBtn = screen.getByRole('button', { name: /Approximate/i });
        fireEvent.click(approxBtn);

        expect(screen.getByText('~100m')).toBeInTheDocument();
    });

    it('calls updateEnterpriseLocation on Save Location and triggers callbacks', async () => {
        vi.mocked(nodeClient.updateEnterpriseLocation).mockResolvedValueOnce({
            success: true,
            lat: -28.55,
            lng: 153.50,
        });

        const onLocationSaved = vi.fn();
        const onClose = vi.fn();

        render(
            <EnterpriseLocationPicker
                treasury={mockTreasuryWithCoords}
                activeNode={mockActiveNode}
                effectiveTfaToken="tfa-session-token"
                onLocationSaved={onLocationSaved}
                onClose={onClose}
            />
        );

        const saveBtn = screen.getByRole('button', { name: /Save Location/i });
        await act(async () => {
            fireEvent.click(saveBtn);
        });

        expect(nodeClient.updateEnterpriseLocation).toHaveBeenCalledWith(
            'https://test-node.local',
            'pubkey-12345',
            { lat: -28.55, lng: 153.50 },
            'secret-admin-password',
            'tfa-session-token'
        );

        expect(onLocationSaved).toHaveBeenCalledWith(-28.55, 153.50);
        expect(onClose).toHaveBeenCalled();
    });

    it('shows error message if saving location fails', async () => {
        vi.mocked(nodeClient.updateEnterpriseLocation).mockRejectedValueOnce(
            new Error('Network error during save')
        );

        render(
            <EnterpriseLocationPicker
                treasury={mockTreasuryWithCoords}
                activeNode={mockActiveNode}
                onLocationSaved={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const saveBtn = screen.getByRole('button', { name: /Save Location/i });
        await act(async () => {
            fireEvent.click(saveBtn);
        });

        await waitFor(() => {
            expect(screen.getByRole('alert')).toHaveTextContent('Network error during save');
        });
    });

    it('shows validation error when coordinates are out of valid bounds', async () => {
        render(
            <EnterpriseLocationPicker
                treasury={mockTreasuryWithoutCoords}
                activeNode={mockActiveNode}
                onLocationSaved={vi.fn()}
                onClose={vi.fn()}
            />
        );

        const latInput = screen.getByLabelText(/Latitude/i);
        const lngInput = screen.getByLabelText(/Longitude/i);

        fireEvent.change(latInput, { target: { value: '95' } });
        fireEvent.change(lngInput, { target: { value: '200' } });

        const saveBtn = screen.getByRole('button', { name: /Save Location/i });
        await act(async () => {
            fireEvent.click(saveBtn);
        });

        expect(screen.getByRole('alert')).toHaveTextContent(
            'Latitude must be between -90 and 90, longitude between -180 and 180'
        );
        expect(nodeClient.updateEnterpriseLocation).not.toHaveBeenCalled();
    });

    it('calls clearEnterpriseLocation on Clear Location button click', async () => {
        vi.mocked(nodeClient.clearEnterpriseLocation).mockResolvedValueOnce({
            success: true,
            lat: null,
            lng: null,
        });

        const onLocationSaved = vi.fn();
        const onClose = vi.fn();

        render(
            <EnterpriseLocationPicker
                treasury={mockTreasuryWithCoords}
                activeNode={mockActiveNode}
                effectiveTfaToken="tfa-session-token"
                onLocationSaved={onLocationSaved}
                onClose={onClose}
            />
        );

        const clearBtn = screen.getByRole('button', { name: /Clear Location/i });
        await act(async () => {
            fireEvent.click(clearBtn);
        });

        expect(nodeClient.clearEnterpriseLocation).toHaveBeenCalledWith(
            'https://test-node.local',
            'pubkey-12345',
            'secret-admin-password',
            'tfa-session-token'
        );

        expect(onLocationSaved).toHaveBeenCalledWith(null, null);
        expect(onClose).toHaveBeenCalled();
    });

    it('calls onClose when close or cancel button is clicked', () => {
        const onClose = vi.fn();

        render(
            <EnterpriseLocationPicker
                treasury={mockTreasuryWithCoords}
                activeNode={mockActiveNode}
                onLocationSaved={vi.fn()}
                onClose={onClose}
            />
        );

        const closeBtn = screen.getByRole('button', { name: /Close location picker/i });
        fireEvent.click(closeBtn);
        expect(onClose).toHaveBeenCalledTimes(1);

        const cancelBtn = screen.getByRole('button', { name: /Cancel/i });
        fireEvent.click(cancelBtn);
        expect(onClose).toHaveBeenCalledTimes(2);
    });
});
