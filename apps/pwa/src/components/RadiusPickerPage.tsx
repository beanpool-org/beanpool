/**
 * RadiusPickerPage — Full-screen map for choosing location + radius
 *
 * Facebook-style: tap to set center, slider for radius, circle overlay.
 * No intermediate screen — straight to the map.
 */

import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { type RadiusSettings } from '../lib/geo';

interface Props {
    initial?: RadiusSettings | null;
    defaultRadius?: number;
    onApply: (settings: RadiusSettings) => void;
    onCancel: () => void;
    onReset: () => void;
}

const RADIUS_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 25, 50];

export function RadiusPickerPage({ initial, defaultRadius = 20, onApply, onCancel, onReset }: Props) {
    const mapContainer = useRef<HTMLDivElement>(null);
    const mapRef = useRef<L.Map | null>(null);
    const circleRef = useRef<L.Circle | null>(null);
    const markerRef = useRef<L.Marker | null>(null);

    const [center, setCenter] = useState<[number, number]>(
        initial ? [initial.lat, initial.lng] : [-28.5495, 153.5005] // Default: Mullumbimby
    );
    const [radiusKm, setRadiusKm] = useState(initial?.radiusKm ?? defaultRadius);
    const [radiusIdx, setRadiusIdx] = useState(() => {
        const km = initial?.radiusKm ?? defaultRadius;
        const idx = RADIUS_STEPS.findIndex(s => s >= km);
        return idx >= 0 ? idx : RADIUS_STEPS.length - 1;
    });

    // Init map
    useEffect(() => {
        if (!mapContainer.current || mapRef.current) return;

        const map = L.map(mapContainer.current, {
            center: center,
            zoom: 11,
            zoomControl: false,
            attributionControl: false,
        });

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 18,
        }).addTo(map);

        // Circle overlay
        const circle = L.circle(center, {
            radius: radiusKm * 1000,
            color: '#f59e0b',
            fillColor: '#f59e0b',
            fillOpacity: 0.12,
            weight: 2,
            dashArray: '6, 6',
        }).addTo(map);

        // Center marker
        const marker = L.marker(center, {
            draggable: true
        }).addTo(map);

        marker.on('dragend', (e) => {
            const { lat, lng } = marker.getLatLng();
            setCenter([lat, lng]);
            circle.setLatLng([lat, lng]);
        });

        // Tap to move center
        map.on('click', (e: L.LeafletMouseEvent) => {
            const { lat, lng } = e.latlng;
            setCenter([lat, lng]);
            circle.setLatLng([lat, lng]);
            marker.setLatLng([lat, lng]);
        });

        mapRef.current = map;
        circleRef.current = circle;
        markerRef.current = marker;

        // Try to get user's actual location
        if (!initial) {
            navigator.geolocation?.getCurrentPosition(
                (pos) => {
                    const userLat = pos.coords.latitude;
                    const userLng = pos.coords.longitude;
                    setCenter([userLat, userLng]);
                    map.setView([userLat, userLng], 11);
                    circle.setLatLng([userLat, userLng]);
                    marker.setLatLng([userLat, userLng]);
                },
                () => {}, // Ignore errors
                { timeout: 5000 }
            );
        }

        return () => {
            map.remove();
            mapRef.current = null;
        };
    }, []);

    // Update circle when radius changes
    useEffect(() => {
        const km = RADIUS_STEPS[radiusIdx];
        setRadiusKm(km);
        if (circleRef.current && mapRef.current) {
            circleRef.current.setRadius(km * 1000);
            // Fit map to show the full circle
            mapRef.current.fitBounds(circleRef.current.getBounds(), { padding: [20, 20] });
        }
    }, [radiusIdx]);

    const handleGpsLocate = () => {
        navigator.geolocation?.getCurrentPosition(
            (pos) => {
                const userLat = pos.coords.latitude;
                const userLng = pos.coords.longitude;
                setCenter([userLat, userLng]);
                if (mapRef.current && circleRef.current && markerRef.current) {
                    mapRef.current.setView([userLat, userLng], mapRef.current.getZoom());
                    circleRef.current.setLatLng([userLat, userLng]);
                    markerRef.current.setLatLng([userLat, userLng]);
                }
            },
            (err) => {
                alert("Could not access location services: " + err.message);
            },
            { timeout: 5000, enableHighAccuracy: true }
        );
    };

    return (
        <div style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            display: 'flex', flexDirection: 'column',
            background: 'var(--bg-primary)',
        }}>
            {/* Header */}
            <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '0.75rem 1rem',
                background: 'var(--bg-secondary)',
                borderBottom: '1px solid var(--border-secondary)',
                zIndex: 10,
            }}>
                <button
                    onClick={onCancel}
                    style={{
                        background: 'none', border: 'none', color: 'var(--text-muted)',
                        fontSize: '0.9rem', cursor: 'pointer', fontFamily: 'inherit',
                    }}
                >
                    Cancel
                </button>
                <h3 style={{ fontSize: '1rem', fontWeight: 700, margin: 0 }}>
                    📍 Set Location & Radius
                </h3>
                <button
                    onClick={onReset}
                    style={{
                        background: 'none', border: 'none', color: '#ef4444',
                        fontSize: '0.85rem', cursor: 'pointer', fontFamily: 'inherit',
                    }}
                >
                    Reset
                </button>
            </div>

            {/* Map Container */}
            <div style={{ flex: 1, position: 'relative' }}>
                <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
                
                {/* Floating GPS Button */}
                <button
                    onClick={handleGpsLocate}
                    style={{
                        position: 'absolute',
                        right: '1rem',
                        bottom: '1rem',
                        width: '2.75rem',
                        height: '2.75rem',
                        borderRadius: '50%',
                        background: '#ffffff',
                        border: '1px solid var(--border-secondary)',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.12)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        zIndex: 1000,
                        color: '#4b5563',
                        transition: 'transform 0.15s ease, background-color 0.15s ease, color 0.15s ease',
                    }}
                    onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'scale(1.08)';
                        e.currentTarget.style.color = '#111827';
                    }}
                    onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'scale(1)';
                        e.currentTarget.style.color = '#4b5563';
                    }}
                    title="Center on my location"
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <circle cx="12" cy="12" r="3" />
                        <line x1="12" y1="1" x2="12" y2="4" />
                        <line x1="12" y1="20" x2="12" y2="23" />
                        <line x1="1" y1="12" x2="4" y2="12" />
                        <line x1="20" y1="12" x2="23" y2="12" />
                    </svg>
                </button>
            </div>

            {/* Bottom controls */}
            <div style={{
                background: 'var(--bg-secondary)',
                borderTop: '1px solid var(--border-secondary)',
                padding: '1rem 1.25rem',
                paddingBottom: '2rem', // safe area
            }}>
                {/* Radius label */}
                <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    marginBottom: '0.5rem',
                }}>
                    <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Search radius</span>
                    <span style={{ fontSize: '1.1rem', fontWeight: 700, color: '#f59e0b' }}>
                        {radiusKm < 1 ? `${Math.round(radiusKm * 1000)}m` : `${radiusKm} km`}
                    </span>
                </div>

                {/* Slider */}
                <input
                    type="range"
                    min={0}
                    max={RADIUS_STEPS.length - 1}
                    value={radiusIdx}
                    onChange={(e) => setRadiusIdx(Number(e.target.value))}
                    style={{
                        width: '100%',
                        accentColor: '#f59e0b',
                        marginBottom: '0.75rem',
                    }}
                />

                {/* Step labels */}
                <div style={{
                    display: 'flex', justifyContent: 'space-between',
                    fontSize: '0.65rem', color: 'var(--text-faint)',
                    marginBottom: '1rem',
                    paddingLeft: '0.2rem', paddingRight: '0.2rem',
                }}>
                    <span>100m</span>
                    <span>1km</span>
                    <span>10km</span>
                    <span>50km</span>
                </div>

                {/* Tap hint */}
                <p style={{
                    textAlign: 'center', fontSize: '0.75rem', color: 'var(--text-faint)',
                    marginBottom: '0.75rem',
                }}>
                    Tap the map or drag the pin to move the center point
                </p>

                {/* Apply button */}
                <button
                    onClick={() => onApply({
                        lat: center[0],
                        lng: center[1],
                        radiusKm,
                        label: radiusKm < 1 ? `${Math.round(radiusKm * 1000)}m radius` : `${radiusKm}km radius`,
                    })}
                    style={{
                        width: '100%', padding: '0.85rem', borderRadius: '12px',
                        background: 'linear-gradient(135deg, #f59e0b, #d97706)',
                        border: 'none', color: '#fff', fontSize: '1rem',
                        fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                        boxShadow: '0 4px 16px rgba(245, 158, 11, 0.3)',
                    }}
                >
                    Apply — {radiusKm < 1 ? `${Math.round(radiusKm * 1000)}m` : `${radiusKm}km`} radius
                </button>
                {initial && (
                    <button
                        onClick={onReset}
                        style={{
                            width: '100%', padding: '0.85rem', borderRadius: '12px',
                            background: 'transparent',
                            border: '1px solid #ef4444', color: '#ef4444', fontSize: '1rem',
                            fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                            marginTop: '0.75rem',
                        }}
                    >
                        Clear Filter
                    </button>
                )}
            </div>
        </div>
    );
}
