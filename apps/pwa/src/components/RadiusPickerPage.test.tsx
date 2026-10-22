import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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
        const gpsButton = screen.getByRole('button', { name: 'Center map on my location' });
        fireEvent.click(gpsButton);
        expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    });

    it('explains next to the GPS button why location is used', () => {
        render(<RadiusPickerPage onApply={noop} onCancel={noop} onReset={noop} />);
        expect(screen.getByText('Use my location to centre the circle')).toBeInTheDocument();
    });

    it('with no place and no pick, Apply is disabled and shows hint, and does not call onApply with [20, 0]', () => {
        const onApply = vi.fn();
        render(<RadiusPickerPage onApply={onApply} onCancel={noop} onReset={noop} />);
        const applyBtn = screen.getByRole('button', { name: /Apply/i });
        expect(applyBtn).toBeDisabled();
        expect(screen.getByText('Tap the map or use your location to choose a centre')).toBeInTheDocument();
        fireEvent.click(applyBtn);
        expect(onApply).not.toHaveBeenCalled();
    });

    it('late nodeCenter re-centres map, circle, and marker when user has not picked', () => {
        const { rerender } = render(<RadiusPickerPage onApply={noop} onCancel={noop} onReset={noop} />);
        const mapInstance = vi.mocked(L.map).mock.results[0]?.value;
        const circleInstance = vi.mocked(L.circle).mock.results[0]?.value;
        const markerInstance = vi.mocked(L.marker).mock.results[0]?.value;

        rerender(
            <RadiusPickerPage
                nodeCenter={{ lat: -37.07, lng: 144.22 }}
                onApply={noop}
                onCancel={noop}
                onReset={noop}
            />
        );

        expect(mapInstance.setView).toHaveBeenCalledWith([-37.07, 144.22], 11);
        expect(circleInstance.setLatLng).toHaveBeenCalledWith([-37.07, 144.22]);
        expect(markerInstance.setLatLng).toHaveBeenCalledWith([-37.07, 144.22]);
    });

    it('late nodeCenter does not overwrite a centre already picked by the user', () => {
        const { rerender } = render(<RadiusPickerPage onApply={noop} onCancel={noop} onReset={noop} />);
        const mapInstance = vi.mocked(L.map).mock.results[0]?.value;
        const markerInstance = vi.mocked(L.marker).mock.results[0]?.value;

        // User taps the map at [10, 20]
        const mapClickHandler = mapInstance.on.mock.calls.find((call: any[]) => call[0] === 'click')?.[1];
        expect(mapClickHandler).toBeDefined();
        act(() => {
            mapClickHandler({ latlng: { lat: 10, lng: 20 } });
        });

        mapInstance.setView.mockClear();
        markerInstance.setLatLng.mockClear();

        // Late nodeCenter arrives
        rerender(
            <RadiusPickerPage
                nodeCenter={{ lat: -37.07, lng: 144.22 }}
                onApply={noop}
                onCancel={noop}
                onReset={noop}
            />
        );

        expect(mapInstance.setView).not.toHaveBeenCalledWith([-37.07, 144.22], expect.anything());
        expect(markerInstance.setLatLng).not.toHaveBeenCalledWith([-37.07, 144.22]);
    });

    it('user pick via map tap enables Apply and sets chosen coordinates', () => {
        const onApply = vi.fn();
        render(<RadiusPickerPage onApply={onApply} onCancel={noop} onReset={noop} />);
        const mapInstance = vi.mocked(L.map).mock.results[0]?.value;
        const mapClickHandler = mapInstance.on.mock.calls.find((call: any[]) => call[0] === 'click')?.[1];
        act(() => {
            mapClickHandler({ latlng: { lat: -33.8688, lng: 151.2093 } });
        });

        const applyBtn = screen.getByRole('button', { name: /Apply/i });
        expect(applyBtn).not.toBeDisabled();
        fireEvent.click(applyBtn);
        expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
            lat: -33.8688,
            lng: 151.2093,
        }));
    });

    it('does not fitBounds on initial mount under StrictMode when no initial place is given', () => {
        render(
            <React.StrictMode>
                <RadiusPickerPage onApply={noop} onCancel={noop} onReset={noop} />
            </React.StrictMode>
        );
        const mapInstance = vi.mocked(L.map).mock.results[0]?.value;
        expect(mapInstance.fitBounds).not.toHaveBeenCalled();
    });

    it('tapping the location words calls getCurrentPosition and does not move the pin via map click', () => {
        render(<RadiusPickerPage onApply={noop} onCancel={noop} onReset={noop} />);
        const wordsButton = screen.getByRole('button', { name: 'Use my location to centre the circle' });
        const markerInstance = vi.mocked(L.marker).mock.results[0]?.value;
        fireEvent.click(wordsButton);
        expect(getCurrentPosition).toHaveBeenCalledTimes(1);
        expect(markerInstance.setLatLng).not.toHaveBeenCalled();
    });

    it('does not fitBounds on initial mount when no initial place is given', () => {
        render(<RadiusPickerPage onApply={noop} onCancel={noop} onReset={noop} />);
        const mapInstance = vi.mocked(L.map).mock.results[0]?.value;
        expect(mapInstance.fitBounds).not.toHaveBeenCalled();
    });

    it('handles malformed nodeCenter safely and defaults to neutral center and zoom', () => {
        render(
            <RadiusPickerPage
                nodeCenter={[] as any}
                onApply={noop}
                onCancel={noop}
                onReset={noop}
            />
        );
        const mapCall = vi.mocked(L.map).mock.calls[0];
        expect(mapCall?.[1]?.center).toEqual([20, 0]);
        expect(mapCall?.[1]?.zoom).toEqual(2);
    });
});
