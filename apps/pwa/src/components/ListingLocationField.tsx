/**
 * Location editor for Offer/Need Edit Post (pages/MarketplacePage.tsx), matching the create
 * form's My location, Drop a pin, ✓ Location set, and (on open-membership nodes) Approximate (~100m)
 * / Use the exact spot controls.
 *
 * Loads Leaflet dynamically only when the member taps "Drop a pin" so listing views and tests
 * that never open the pin map pay no Leaflet cost.
 */
import { useEffect, useRef, useState } from 'react';
import { approximateLocation, t } from '@beanpool/core';

export function ListingLocationField({
    lat,
    lng,
    onChange,
    openMembership = false,
    testId = 'edit-location',
}: {
    lat: number | null;
    lng: number | null;
    onChange: (nextLat: number, nextLng: number) => void;
    openMembership?: boolean;
    testId?: string;
}) {
    const [pinDropOpen, setPinDropOpen] = useState(false);
    const [locating, setLocating] = useState(false);
    const [geoError, setGeoError] = useState<string | null>(null);
    const [approximate, setApproximate] = useState(false);
    const exactPinRef = useRef<{ lat: number; lng: number } | null>(null);
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<any>(null);
    const markerRef = useRef<any>(null);
    const leafletRef = useRef<any>(null);

    const hasPin = lat != null && lng != null && !Number.isNaN(lat) && !Number.isNaN(lng);

    const applyFreshPin = (nextLat: number, nextLng: number) => {
        const rLat = Math.round(nextLat * 10000) / 10000;
        const rLng = Math.round(nextLng * 10000) / 10000;
        if (openMembership) {
            exactPinRef.current = { lat: rLat, lng: rLng };
            const approx = approximateLocation(rLat, rLng);
            setApproximate(true);
            onChange(approx.lat, approx.lng);
        } else {
            exactPinRef.current = null;
            setApproximate(false);
            onChange(rLat, rLng);
        }
    };

    const handleMyLocation = () => {
        setGeoError(null);
        if (typeof navigator === 'undefined' || !navigator.geolocation) {
            setPinDropOpen(true);
            return;
        }
        setLocating(true);
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                setLocating(false);
                applyFreshPin(pos.coords.latitude, pos.coords.longitude);
                setPinDropOpen(false);
            },
            () => {
                setLocating(false);
                setGeoError(t("Could not get your location. Try 'Drop a pin' instead."));
                setPinDropOpen(true);
            },
            { enableHighAccuracy: false, timeout: 10000 },
        );
    };

    const handleApproximate = () => {
        if (!hasPin) return;
        if (!approximate) exactPinRef.current = { lat: lat!, lng: lng! };
        const approx = approximateLocation(lat!, lng!);
        setApproximate(true);
        onChange(approx.lat, approx.lng);
    };

    const handleExactSpot = () => {
        const exact = exactPinRef.current;
        if (!exact) return;
        setApproximate(false);
        onChange(exact.lat, exact.lng);
    };

    useEffect(() => {
        if (!pinDropOpen || !mapContainerRef.current) return;
        let cancelled = false;
        void import('leaflet').then((mod) => {
            if (cancelled || !mapContainerRef.current || mapRef.current) return;
            const L = mod.default ?? mod;
            leafletRef.current = L;
            const center: [number, number] = hasPin ? [lat!, lng!] : [-28.55, 153.50];
            const zoom = hasPin ? 13 : 4;
            try {
                const map = L.map(mapContainerRef.current, { scrollWheelZoom: false, zoomControl: false }).setView(center, zoom);
                mapRef.current = map;
                L.control.zoom({ zoomInTitle: t('Zoom in'), zoomOutTitle: t('Zoom out') }).addTo(map);
                L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                    attribution: '&copy; OpenStreetMap',
                    maxZoom: 18,
                }).addTo(map);
                map.on('click', (e: any) => {
                    applyFreshPin(e.latlng.lat, e.latlng.lng);
                });
                if (hasPin) {
                    const m = L.marker(center, { draggable: true }).addTo(map);
                    m.on('dragend', (e: any) => {
                        const next = e.target.getLatLng();
                        applyFreshPin(next.lat, next.lng);
                    });
                    markerRef.current = m;
                }
            } catch {
                // Non-browser test environments skip map canvas setup cleanly.
            }
        }).catch(() => {});

        return () => {
            cancelled = true;
            if (mapRef.current) {
                try { mapRef.current.remove(); } catch {}
                mapRef.current = null;
                markerRef.current = null;
            }
        };
    }, [pinDropOpen]);

    useEffect(() => {
        const map = mapRef.current;
        const L = leafletRef.current;
        if (!map || !L || !hasPin) return;
        const pos: [number, number] = [lat!, lng!];
        try {
            if (markerRef.current) {
                markerRef.current.setLatLng(pos);
            } else {
                const m = L.marker(pos, { draggable: true }).addTo(map);
                m.on('dragend', (e: any) => {
                    const next = e.target.getLatLng();
                    applyFreshPin(next.lat, next.lng);
                });
                markerRef.current = m;
            }
            map.setView(pos, Math.max(map.getZoom() || 13, 13));
        } catch {}
    }, [lat, lng, hasPin]);

    return (
        <div className="mb-3" data-testid={testId}>
            <div className="flex flex-wrap gap-2 mb-2">
                <button
                    type="button"
                    data-testid={`${testId}-my-location`}
                    onClick={handleMyLocation}
                    disabled={locating}
                    className={`flex-1 min-w-[7.5rem] min-h-[48px] flex flex-col items-center justify-center gap-1 py-2.5 px-3 rounded-xl border transition-all text-sm font-bold shadow-sm ${
                        hasPin && !pinDropOpen
                            ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500'
                            : 'border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-600 dark:text-nature-200 hover:bg-nature-50 dark:hover:bg-nature-700'
                    }`}
                >
                    <span className="text-lg leading-none" aria-hidden="true">📍</span>
                    <span>{t('My location')}</span>
                </button>
                <button
                    type="button"
                    data-testid={`${testId}-drop-pin`}
                    onClick={() => setPinDropOpen((v) => !v)}
                    aria-expanded={pinDropOpen}
                    className={`flex-1 min-w-[7.5rem] min-h-[48px] flex flex-col items-center justify-center gap-1 py-2.5 px-3 rounded-xl border transition-all text-sm font-bold shadow-sm ${
                        pinDropOpen
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 ring-1 ring-blue-500'
                            : 'border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-600 dark:text-nature-200 hover:bg-nature-50 dark:hover:bg-nature-700'
                    }`}
                >
                    <span className="text-lg leading-none" aria-hidden="true">📌</span>
                    <span>{t('Drop a pin')}</span>
                </button>
            </div>

            {geoError && (
                <p className="m-0 mb-2 text-xs font-semibold text-amber-700 dark:text-amber-300 break-words">{geoError}</p>
            )}

            {pinDropOpen && (
                <div className="mb-2">
                    <p className="m-0 mb-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400">
                        {t('Tap the map to place your pin')}
                    </p>
                    <div
                        ref={mapContainerRef}
                        data-testid={`${testId}-map`}
                        className="w-full h-52 rounded-xl overflow-hidden border border-nature-200 dark:border-nature-700 bg-nature-100 dark:bg-nature-800"
                    />
                </div>
            )}

            {hasPin && (
                <p data-testid={`${testId}-set`} className="m-0 mb-2 text-emerald-700 dark:text-emerald-400 text-sm font-semibold text-center">
                    {t('✓ Location set')}
                </p>
            )}

            {openMembership && hasPin && (
                <div data-testid={`${testId}-precision`} className="mb-2 flex items-center gap-2 flex-wrap">
                    <p className="m-0 flex-1 min-w-0 text-xs text-nature-600 dark:text-nature-300 break-words">
                        {approximate
                            ? t('Saved to about 100 m. Other members see about 1 km.')
                            : t('Saved at the exact spot. Other members see about 1 km.')}
                    </p>
                    {approximate ? (
                        exactPinRef.current && (
                            <button
                                type="button"
                                onClick={handleExactSpot}
                                className="min-h-[48px] px-3 rounded-md border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-800 text-sm font-semibold text-nature-800 dark:text-nature-100"
                            >
                                {t('Use the exact spot')}
                            </button>
                        )
                    ) : (
                        <button
                            type="button"
                            onClick={handleApproximate}
                            className="min-h-[48px] px-3 rounded-md border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-800 text-sm font-semibold text-nature-800 dark:text-nature-100"
                        >
                            {t('Approximate (~100m)')}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
