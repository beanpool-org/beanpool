import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import L from 'leaflet';
import { RadiusPickerPage } from './RadiusPickerPage';

vi.mock('leaflet', () => {
    const layer = () => ({
        addTo: vi.fn().mockReturnThis(),
        setLatLng: vi.fn(),
        on: vi.fn(),
        setRadius: vi.fn(),
        getBounds: vi.fn(() => ({})),
        getLatLng: vi.fn(() => ({ lat: 0, lng: 0 })),
    });
    return {
        default: {
            map: vi.fn((_container: unknown, opts: any) => ({
                opts,
                setView: vi.fn(),
                fitBounds: vi.fn(),
                on: vi.fn(),
                off: vi.fn(),
                remove: vi.fn(),
                getZoom: vi.fn(() => opts?.zoom ?? 11),
            })),
            tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
            marker: vi.fn(layer),
            circle: vi.fn(layer),
            divIcon: vi.fn((o) => o),
        },
    };
});
vi.mock('leaflet/dist/leaflet.css', () => ({}));

describe('RadiusPickerPage', () => {
    const noop = () => {};
    let getCurrentPosition: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        getCurrentPosition = vi.fn();
        Object.defineProperty(navigator, 'geolocation', {
            value: { getCurrentPosition },
            configurable: true,
            writable: true,
        });
    });

    it('rendering RadiusPickerPage with no initial does NOT call getCurrentPosition', () => {
        render(<RadiusPickerPage onApply={noop} onCancel={noop} onReset={noop} />);
        expect(getCurrentPosition).not.toHaveBeenCalled();
    });

    it('centres on the node\'s place when one is given', () => {
        render(
            <RadiusPickerPage
                nodeCenter={{ lat: -37.8136, lng: 144.9631 }}
                onApply={noop}
                onCancel={noop}
                onReset={noop}
            />
        );
        const mapCall = vi.mocked(L.map).mock.calls[0];
        expect(mapCall?.[1]?.center).toEqual([-37.8136, 144.9631]);
    });

    it('never uses the old Mullumbimby point with no place', () => {
        render(<RadiusPickerPage onApply={noop} onCancel={noop} onReset={noop} />);
        const mapCall = vi.mocked(L.map).mock.calls[0];
        const center = mapCall?.[1]?.center;
        expect(center).not.toEqual([-28.5495, 153.5005]);
        expect(center).toEqual([20, 0]);
    });

    it('tapping the GPS button calls getCurrentPosition once', () => {
        render(<RadiusPickerPage onApply={noop} onCancel={noop} onReset={noop} />);
        const gpsButton = screen.getByRole('button', { name: /Center map on my location|Use my location to centre the circle/i });
        fireEvent.click(gpsButton);
        expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    });

    it('explains next to the GPS button why location is used', () => {
        render(<RadiusPickerPage onApply={noop} onCancel={noop} onReset={noop} />);
        expect(screen.getByText('Use my location to centre the circle')).toBeInTheDocument();
    });
});
