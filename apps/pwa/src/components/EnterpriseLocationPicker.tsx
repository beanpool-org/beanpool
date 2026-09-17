/**
 * Keeper-facing enterprise map pin picker (docs/the-commons.md §2.2, §10).
 *
 * PORTED from the settings app. The REFERENCE is apps/manager/src/components/modules/EnterpriseLocationPicker.tsx:
 * copy and behaviour here must stay identical to it (EnterpriseKeepers.test.tsx checks the visible copy of both).
 * What differs on purpose: this one saves through the keeper route signed by the member's own identity rather
 * than the admin route, and its classes follow the web app's light/dark theme.
 */
import React, { useEffect, useRef, useState, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { approximateLocation } from '../lib/geo';
import { setEnterpriseLocation, clearEnterpriseLocation } from '../lib/api';

interface EnterpriseLocationPickerProps {
    treasury: { publicKey: string; lat?: number | null; lng?: number | null };
    onLocationSaved: (lat: number | null, lng: number | null) => void;
    onClose: () => void;
}

export const EnterpriseLocationPicker: React.FC<EnterpriseLocationPickerProps> = ({
    treasury,
    onLocationSaved,
    onClose,
}) => {
    const [lat, setLat] = useState<number | null>(treasury.lat ?? null);
    const [lng, setLng] = useState<number | null>(treasury.lng ?? null);
    const [latInput, setLatInput] = useState<string>(treasury.lat != null ? String(treasury.lat) : '');
    const [lngInput, setLngInput] = useState<string>(treasury.lng != null ? String(treasury.lng) : '');
    const [saving, setSaving] = useState(false);
    const [clearing, setClearing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isApproximate, setIsApproximate] = useState(false);

    const mapContainerRef = useRef<HTMLDivElement>(null);
    const mapInstanceRef = useRef<L.Map | null>(null);
    const markerRef = useRef<L.Marker | null>(null);

    const enterpriseIcon = useMemo(() => {
        return L.divIcon({
            html: '<div style="width:16px;height:16px;background:#e06d53;border-radius:50%;border:2px solid #ffffff;box-shadow:0 0 10px rgba(224,109,83,0.8)"></div>',
            className: 'bp-enterprise-pin',
            iconSize: [16, 16],
            iconAnchor: [8, 8],
        });
    }, []);

    // Initialize Leaflet Map
    useEffect(() => {
        if (!mapContainerRef.current) return;
        if (mapInstanceRef.current) return;

        const hasInitialCoord = lat != null && lng != null && !isNaN(lat) && !isNaN(lng);
        const initialCenter: L.LatLngExpression = hasInitialCoord ? [lat!, lng!] : [-28.55, 153.50];
        const initialZoom = hasInitialCoord ? 13 : 3;

        try {
            const map = L.map(mapContainerRef.current, {
                scrollWheelZoom: false,
            }).setView(initialCenter, initialZoom);
            mapInstanceRef.current = map;

            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
                maxZoom: 18,
            }).addTo(map);

            map.on('click', (e: L.LeafletMouseEvent) => {
                const newLat = parseFloat(e.latlng.lat.toFixed(6));
                const newLng = parseFloat(e.latlng.lng.toFixed(6));
                setLat(newLat);
                setLng(newLng);
                setLatInput(String(newLat));
                setLngInput(String(newLng));
                setIsApproximate(false);
                setError(null);
            });
        } catch (err) {
            console.warn('Leaflet map initialization skipped or failed:', err);
        }

        return () => {
            if (mapInstanceRef.current) {
                mapInstanceRef.current.remove();
                mapInstanceRef.current = null;
                markerRef.current = null;
            }
        };
    }, []);

    // Sync marker with coordinates
    useEffect(() => {
        const map = mapInstanceRef.current;
        if (!map) return;

        if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
            const pos: L.LatLngExpression = [lat, lng];
            if (markerRef.current) {
                markerRef.current.setLatLng(pos);
            } else {
                try {
                    const m = L.marker(pos, { icon: enterpriseIcon, draggable: true }).addTo(map);
                    m.on('dragend', (e: any) => {
                        const next = e.target.getLatLng();
                        const nextLat = parseFloat(next.lat.toFixed(6));
                        const nextLng = parseFloat(next.lng.toFixed(6));
                        setLat(nextLat);
                        setLng(nextLng);
                        setLatInput(String(nextLat));
                        setLngInput(String(nextLng));
                        setIsApproximate(false);
                        setError(null);
                    });
                    markerRef.current = m;
                    map.setView(pos, 13);
                } catch {}
            }
        } else if (markerRef.current) {
            markerRef.current.remove();
            markerRef.current = null;
        }
    }, [lat, lng, enterpriseIcon]);

    // One-tap approximate (~100m)
    const handleApproximate = () => {
        if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
            const approx = approximateLocation(lat, lng);
            setLat(approx.lat);
            setLng(approx.lng);
            setLatInput(String(approx.lat));
            setLngInput(String(approx.lng));
            setIsApproximate(true);
        }
    };

    const handleSave = async () => {
        if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) {
            setError('Please pick a spot on the map or enter coordinates');
            return;
        }
        if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
            setError('Latitude must be between -90 and 90, longitude between -180 and 180');
            return;
        }

        setSaving(true);
        setError(null);
        try {
            const res = await setEnterpriseLocation(treasury.publicKey, { lat, lng });
            onLocationSaved(res.lat, res.lng);
            onClose();
        } catch (err: any) {
            setError(err?.message || 'Failed to save location');
        } finally {
            setSaving(false);
        }
    };

    const handleClear = async () => {
        setClearing(true);
        setError(null);
        try {
            await clearEnterpriseLocation(treasury.publicKey);
            setLat(null);
            setLng(null);
            setLatInput('');
            setLngInput('');
            onLocationSaved(null, null);
            onClose();
        } catch (err: any) {
            setError(err?.message || 'Failed to clear location');
        } finally {
            setClearing(false);
        }
    };

    return (
        <div className="p-3.5 rounded-xl bg-white dark:bg-nature-950 border border-nature-200 dark:border-nature-800 space-y-3">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-xs font-bold text-nature-900 dark:text-white">
                    <span>📍</span>
                    <span>Enterprise Map Location</span>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="min-h-[44px] min-w-[44px] text-xs text-nature-500 dark:text-nature-400 hover:text-nature-900 dark:hover:text-white transition-colors"
                    aria-label="Close location picker"
                >
                    ✕
                </button>
            </div>

            {/* Plain-words visibility statement & privacy guidance. Enterprise pins are public, exactly like
                marketplace post pins (docs/the-commons.md §2.2, §10), so the warning must say so — and the
                Approximate option stays right beside it. */}
            <div
                data-testid="enterprise-location-visibility"
                className="p-2.5 rounded-lg bg-terra-50 dark:bg-terra-950/40 border border-terra-200 dark:border-terra-800/60 text-xs text-terra-800 dark:text-terra-200 space-y-1.5"
            >
                <p className="font-semibold text-terra-900 dark:text-terra-100 m-0">
                    Anyone who opens this node&apos;s map will see this spot.
                </p>
                <p className="text-[11px] text-nature-700 dark:text-nature-300 m-0">
                    The flock, shed, or garden is often at someone’s house. Use <strong>Approximate</strong> to round the location to roughly 100&nbsp;m.
                </p>
                <button
                    type="button"
                    onClick={handleApproximate}
                    disabled={lat == null || lng == null}
                    className="min-h-[44px] px-3 py-1 rounded-md bg-terra-100 dark:bg-terra-900/40 hover:bg-terra-200 dark:hover:bg-terra-900/70 disabled:opacity-40 disabled:pointer-events-none text-xs font-semibold text-terra-700 dark:text-terra-300 border border-terra-300 dark:border-terra-700/60 transition-colors"
                >
                    Approximate (~100m)
                </button>
            </div>

            {/* Interactive Leaflet Map container */}
            <div
                id={`enterprise-map-${treasury.publicKey}`}
                ref={mapContainerRef}
                className="w-full h-48 rounded-lg border border-nature-200 dark:border-nature-800 bg-nature-100 dark:bg-nature-900 overflow-hidden relative shadow-inner z-0"
            />

            {/* Coordinates */}
            <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-nature-600 dark:text-nature-300">
                        <span>Lat: {lat != null ? lat.toFixed(isApproximate ? 3 : 5) : '—'}</span>
                        <span>Lng: {lng != null ? lng.toFixed(isApproximate ? 3 : 5) : '—'}</span>
                        {isApproximate && (
                            <span className="px-1.5 py-0.5 rounded bg-terra-100 dark:bg-terra-900/60 text-terra-700 dark:text-terra-300 text-[10px] font-sans font-semibold border border-terra-300 dark:border-terra-700/50">
                                ~100m
                            </span>
                        )}
                    </div>
                </div>

                {/* Direct coordinate inputs for accessibility / testing */}
                <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="min-w-0">
                        <label className="block text-[10px] uppercase font-bold text-nature-500 dark:text-nature-400 mb-0.5" htmlFor={`lat-input-${treasury.publicKey}`}>
                            Latitude
                        </label>
                        <input
                            id={`lat-input-${treasury.publicKey}`}
                            type="text"
                            inputMode="decimal"
                            value={latInput}
                            onChange={(e) => {
                                const str = e.target.value;
                                setLatInput(str);
                                setIsApproximate(false);
                                const val = parseFloat(str);
                                if (!isNaN(val) && str.trim() !== '' && str !== '-') {
                                    setLat(val);
                                } else if (str.trim() === '') {
                                    setLat(null);
                                }
                            }}
                            placeholder="-28.549"
                            className="w-full min-h-[44px] px-2 py-1 rounded bg-white dark:bg-nature-900 border border-nature-300 dark:border-nature-700 text-nature-900 dark:text-white font-mono text-xs focus:outline-none focus:border-terra-500"
                        />
                    </div>
                    <div className="min-w-0">
                        <label className="block text-[10px] uppercase font-bold text-nature-500 dark:text-nature-400 mb-0.5" htmlFor={`lng-input-${treasury.publicKey}`}>
                            Longitude
                        </label>
                        <input
                            id={`lng-input-${treasury.publicKey}`}
                            type="text"
                            inputMode="decimal"
                            value={lngInput}
                            onChange={(e) => {
                                const str = e.target.value;
                                setLngInput(str);
                                setIsApproximate(false);
                                const val = parseFloat(str);
                                if (!isNaN(val) && str.trim() !== '' && str !== '-') {
                                    setLng(val);
                                } else if (str.trim() === '') {
                                    setLng(null);
                                }
                            }}
                            placeholder="153.501"
                            className="w-full min-h-[44px] px-2 py-1 rounded bg-white dark:bg-nature-900 border border-nature-300 dark:border-nature-700 text-nature-900 dark:text-white font-mono text-xs focus:outline-none focus:border-terra-500"
                        />
                    </div>
                </div>
            </div>

            {error && (
                <div role="alert" aria-live="assertive" className="text-xs text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/50 p-2 rounded-lg">
                    {error}
                </div>
            )}

            {/* Actions — wrap rather than overflow on a 320dp screen */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                <div>
                    {(treasury.lat != null || lat != null) && (
                        <button
                            type="button"
                            onClick={handleClear}
                            disabled={clearing || saving}
                            className="min-h-[44px] px-3 py-1.5 rounded-lg bg-rose-50 dark:bg-rose-950/40 hover:bg-rose-100 dark:hover:bg-rose-900/60 text-xs font-semibold text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800/60 transition-colors disabled:opacity-50"
                        >
                            {clearing ? 'Clearing...' : 'Clear Location'}
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="min-h-[44px] px-3 py-1.5 rounded-lg bg-nature-100 dark:bg-nature-900 hover:bg-nature-200 dark:hover:bg-nature-800 text-xs font-semibold text-nature-700 dark:text-nature-300 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={saving || clearing || lat == null || lng == null}
                        className="min-h-[44px] px-3.5 py-1.5 rounded-lg bg-terra-600 hover:bg-terra-500 disabled:opacity-50 disabled:pointer-events-none text-xs font-bold text-white shadow transition-all"
                    >
                        {saving ? 'Saving...' : 'Save Location'}
                    </button>
                </div>
            </div>
        </div>
    );
};
