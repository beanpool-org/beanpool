import React, { useState, useEffect, useRef, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { NodeProfile } from '../../lib/profiles';
import type { DiagnosticsResponse } from '../../lib/node-client';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken } from '../../lib/node-client';

export interface NodeIdentityPanelProps {
    activeNode: NodeProfile;
    diag: DiagnosticsResponse | null;
    onRefreshDiag: () => void;
}

export function NodeIdentityPanel({
    activeNode,
    diag,
    onRefreshDiag,
}: NodeIdentityPanelProps) {
    // Identity fields
    const [callsign, setCallsign] = useState(diag?.callsign || '');
    const [communityName, setCommunityName] = useState(diag?.communityName || '');
    const [contactEmail, setContactEmail] = useState('');
    const [contactPhone, setContactPhone] = useState('');

    // Coordinates & Service radius
    const [lat, setLat] = useState<number | null>(() => (diag as any)?.location?.lat ?? null);
    const [lng, setLng] = useState<number | null>(() => (diag as any)?.location?.lng ?? null);
    const [radiusKm, setRadiusKm] = useState<number>(0);

    // Geocoding location search
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResults, setSearchResults] = useState<Array<{ display_name: string; lat: string; lon: string; type: string }>>([]);
    const [searching, setSearching] = useState(false);
    const [showResults, setShowResults] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState<number>(-1);
    const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const searchWrapperRef = useRef<HTMLDivElement>(null);

    // Directory publishing flags
    const [publishLocation, setPublishLocation] = useState(true);
    const [publishMembers, setPublishMembers] = useState(true);
    const [publishContacts, setPublishContacts] = useState(true);
    const [publishHealth, setPublishHealth] = useState(true);
    const [directoryPushIntervalHours, setDirectoryPushIntervalHours] = useState(12);
    const [lastDirectoryPush, setLastDirectoryPush] = useState<number | string | null>(null);

    // Actions & status
    const [saving, setSaving] = useState(false);
    const [saveStatus, setSaveStatus] = useState<{ text: string; isError: boolean } | null>(null);
    const [publishingNow, setPublishingNow] = useState(false);
    const [publishStatus, setPublishStatus] = useState<string | null>(null);

    // Leaflet map refs
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const mapInstanceRef = useRef<L.Map | null>(null);
    const markerRef = useRef<L.Marker | null>(null);
    const circleRef = useRef<L.Circle | null>(null);

    const nodeIcon = useMemo(() => {
        return L.divIcon({
            html: '<div style="width:14px;height:14px;background:#10b981;border-radius:50%;border:2px solid #064e3b;box-shadow:0 0 10px rgba(16,185,129,0.6)"></div>',
            className: 'bp-node-pin',
            iconSize: [14, 14],
            iconAnchor: [7, 7],
        });
    }, []);

    // Load initial config and community info
    useEffect(() => {
        let mounted = true;

        const loadData = async () => {
            try {
                // 1. Community Info
                const infoUrl = resolveNodeApiUrl(activeNode.url, '/api/local/community-info');
                const infoRes = await fetch(infoUrl).catch(() => null);
                if (infoRes && infoRes.ok && mounted) {
                    const data = await infoRes.json().catch(() => ({}));
                    if (data.communityName !== undefined) setCommunityName(data.communityName || '');
                    if (data.contactEmail !== undefined) setContactEmail(data.contactEmail || '');
                    if (data.contactPhone !== undefined) setContactPhone(data.contactPhone || '');
                    if (data.callsign !== undefined) setCallsign(data.callsign || '');
                }

                // 2. Node Config (service radius, directory settings)
                const configUrl = resolveNodeApiUrl(activeNode.url, '/api/node/config');
                const configRes = await fetch(configUrl).catch(() => null);
                if (configRes && configRes.ok && mounted) {
                    const cfg = await configRes.json().catch(() => ({}));
                    if (cfg.serviceRadius) {
                        const km = Number(cfg.serviceRadius.radiusKm) || 0;
                        setRadiusKm(km);
                        if (cfg.serviceRadius.lat != null) setLat(Number(cfg.serviceRadius.lat));
                        if (cfg.serviceRadius.lng != null) setLng(Number(cfg.serviceRadius.lng));
                    }
                    if (cfg.publishLocation !== undefined) setPublishLocation(Boolean(cfg.publishLocation));
                    if (cfg.publishMembers !== undefined) setPublishMembers(Boolean(cfg.publishMembers));
                    if (cfg.publishContacts !== undefined) setPublishContacts(Boolean(cfg.publishContacts));
                    if (cfg.publishHealth !== undefined) setPublishHealth(Boolean(cfg.publishHealth));
                    if (cfg.directoryPushIntervalHours !== undefined) {
                        setDirectoryPushIntervalHours(Number(cfg.directoryPushIntervalHours));
                    }
                    if (cfg.lastDirectoryPush) {
                        setLastDirectoryPush(cfg.lastDirectoryPush);
                    }
                }
            } catch (err) {
                console.warn('Failed to load initial node identity config:', err);
            }
        };

        loadData();

        return () => {
            mounted = false;
        };
    }, [activeNode.id, activeNode.url]);

    // Initialize Leaflet Map
    useEffect(() => {
        if (!mapContainerRef.current) return;
        if (mapInstanceRef.current) return;

        const initialCenter: L.LatLngExpression = (lat != null && lng != null && !isNaN(lat) && !isNaN(lng))
            ? [lat, lng]
            : [0, 0];
        const initialZoom = (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) ? 10 : 2;

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
            });
        } catch (err) {
            console.warn('Leaflet map initialization skipped or failed:', err);
        }

        return () => {
            if (mapInstanceRef.current) {
                mapInstanceRef.current.remove();
                mapInstanceRef.current = null;
                markerRef.current = null;
                circleRef.current = null;
            }
        };
    }, []);

    // Synchronize marker and circle on map when coordinates or radius change
    useEffect(() => {
        const map = mapInstanceRef.current;
        if (!map) return;

        if (lat != null && lng != null && !isNaN(lat) && !isNaN(lng)) {
            const pos: L.LatLngExpression = [lat, lng];
            if (markerRef.current) {
                markerRef.current.setLatLng(pos);
            } else {
                try {
                    const m = L.marker(pos, { icon: nodeIcon, draggable: true }).addTo(map);
                    m.on('dragend', (e: any) => {
                        const next = e.target.getLatLng();
                        setLat(parseFloat(next.lat.toFixed(6)));
                        setLng(parseFloat(next.lng.toFixed(6)));
                    });
                    markerRef.current = m;
                    map.setView(pos, 10);
                } catch {}
            }

            if (radiusKm > 0) {
                if (circleRef.current) {
                    circleRef.current.setLatLng(pos);
                    circleRef.current.setRadius(radiusKm * 1000);
                } else {
                    try {
                        const c = L.circle(pos, {
                            radius: radiusKm * 1000,
                            color: '#f59e0b',
                            fillColor: '#f59e0b',
                            fillOpacity: 0.1,
                            weight: 2,
                            dashArray: '6 4',
                        }).addTo(map);
                        circleRef.current = c;
                    } catch {}
                }
            } else if (circleRef.current) {
                map.removeLayer(circleRef.current);
                circleRef.current = null;
            }
        } else {
            if (markerRef.current) {
                map.removeLayer(markerRef.current);
                markerRef.current = null;
            }
            if (circleRef.current) {
                map.removeLayer(circleRef.current);
                circleRef.current = null;
            }
        }
    }, [lat, lng, radiusKm, nodeIcon]);

    // Cleanup timers and abort controllers on unmount
    useEffect(() => {
        return () => {
            if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
            if (abortControllerRef.current) abortControllerRef.current.abort();
        };
    }, []);

    // Handle outside clicks to close search suggestions dropdown
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (searchWrapperRef.current && !searchWrapperRef.current.contains(e.target as Node)) {
                setShowResults(false);
                setSelectedIndex(-1);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const panMapTo = (targetLat: number, targetLng: number, zoom = 12) => {
        if (mapInstanceRef.current) {
            mapInstanceRef.current.setView([targetLat, targetLng], zoom);
        }
    };

    const handleSearchInput = (value: string) => {
        setSearchQuery(value);
        setSelectedIndex(-1);
        if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
        if (abortControllerRef.current) abortControllerRef.current.abort();

        const q = value.trim();
        if (q.length < 3) {
            setSearching(false);
            setSearchResults([]);
            setShowResults(false);
            return;
        }
        setSearching(true);
        searchTimeoutRef.current = setTimeout(async () => {
            try {
                const controller = new AbortController();
                abortControllerRef.current = controller;
                const res = await fetch(
                    `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5`,
                    { signal: controller.signal }
                );
                if (res.ok) {
                    const data = await res.json();
                    setSearchResults(Array.isArray(data) ? data : []);
                    setShowResults(true);
                }
            } catch (err: unknown) {
                if ((err as Error)?.name !== 'AbortError') {
                    console.error('Geocoding failed:', err);
                }
            } finally {
                setSearching(false);
            }
        }, 1000);
    };

    const handleSelectLocation = (item: { display_name: string; lat: string; lon: string }) => {
        const itemLat = parseFloat(parseFloat(item.lat).toFixed(6));
        const itemLng = parseFloat(parseFloat(item.lon).toFixed(6));
        setLat(itemLat);
        setLng(itemLng);
        setSearchQuery(item.display_name);
        setShowResults(false);
        setSelectedIndex(-1);
        panMapTo(itemLat, itemLng, 12);
    };

    const handleTriggerPublish = async () => {
        setPublishingNow(true);
        setPublishStatus('⏳ Publishing...');
        try {
            const url = resolveNodeApiUrl(activeNode.url, '/api/local/admin/directory/push');
            const res = await fetch(url, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({ password: activeNode.adminPassword }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.success) {
                setPublishStatus('✅ Published!');
                const ts = data.timestamp || Date.now();
                setLastDirectoryPush(ts);
            } else {
                setPublishStatus('❌ Failed');
            }
        } catch {
            setPublishStatus('❌ Failed');
        } finally {
            setPublishingNow(false);
            setTimeout(() => {
                setPublishStatus(null);
            }, 3000);
        }
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);
        setSaveStatus(null);

        try {
            // 1. Save identity info (/api/local/update-identity)
            const identityPayload: Record<string, unknown> = {
                password: activeNode.adminPassword,
                callsign: callsign.trim(),
                communityName: communityName.trim(),
                contactEmail: contactEmail.trim(),
                contactPhone: contactPhone.trim(),
            };
            if (lat !== null && lng !== null && !isNaN(lat) && !isNaN(lng)) {
                identityPayload.lat = lat;
                identityPayload.lng = lng;
            }

            const identityUrl = resolveNodeApiUrl(activeNode.url, '/api/local/update-identity');
            const identityRes = await fetch(identityUrl, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify(identityPayload),
            });

            // 2. Save node config (/api/local/admin/node/config)
            const configUrl = resolveNodeApiUrl(activeNode.url, '/api/local/admin/node/config');
            const configRes = await fetch(configUrl, {
                method: 'POST',
                headers: buildAdminHeaders(activeNode.adminPassword, getTfaSessionToken(activeNode.id)),
                body: JSON.stringify({
                    password: activeNode.adminPassword,
                    publishLocation,
                    publishMembers,
                    publishContacts,
                    publishHealth,
                    directoryPushIntervalHours,
                    serviceRadius: (lat !== null && lng !== null && !isNaN(lat) && !isNaN(lng))
                        ? { lat, lng, radiusKm: Math.max(0, radiusKm) }
                        : null,
                }),
            });

            if (identityRes.ok && configRes.ok) {
                setSaveStatus({ text: 'Saved!', isError: false });
                onRefreshDiag();
            } else {
                const failingRes = !identityRes.ok ? identityRes : configRes;
                const errData = await failingRes.json().catch(() => ({}));
                setSaveStatus({
                    text: errData.totpRequired
                        ? '2FA session expired. Please re-authenticate.'
                        : (errData.error || 'Save failed'),
                    isError: true,
                });
            }
        } catch (err: unknown) {
            setSaveStatus({ text: err instanceof Error ? err.message : 'Save failed', isError: true });
        } finally {
            setSaving(false);
        }
    };

    const lastPublishedText = useMemo(() => {
        if (directoryPushIntervalHours === 0) return 'Disabled';
        if (!lastDirectoryPush) return 'Never';
        try {
            return new Date(lastDirectoryPush).toLocaleString();
        } catch {
            return 'Never';
        }
    }, [directoryPushIntervalHours, lastDirectoryPush]);

    return (
        <div className="p-4 sm:p-6 rounded-2xl bg-nature-900/80 border border-nature-800 shadow-xl space-y-6 max-w-2xl w-full mx-auto font-sans">
            <div>
                <h3 className="text-base font-bold text-white m-0 flex items-center gap-2">
                    <span>📡</span>
                    <span>Node Identity</span>
                </h3>
                <p className="text-xs text-nature-400 m-0 mt-0.5">
                    Update the public identity, geographic location, service boundary, and global directory publishing for this node
                </p>
            </div>

            {saveStatus && (
                <div
                    id="identity-status"
                    role={saveStatus.isError ? 'alert' : 'status'}
                    aria-live={saveStatus.isError ? 'assertive' : 'polite'}
                    className={`p-3 rounded-xl border text-xs font-semibold ${
                        saveStatus.isError
                            ? 'bg-red-950 border-red-800 text-red-200'
                            : 'bg-emerald-950 border-emerald-800 text-emerald-300'
                    }`}
                >
                    <span aria-hidden="true">{saveStatus.isError ? '❌ ' : '✓ '}</span>
                    {saveStatus.text}
                </div>
            )}

            <form onSubmit={handleSave} className="space-y-6">
                {/* Callsign */}
                <div>
                    <label htmlFor="cfg-callsign" className="block text-xs font-bold text-nature-300 mb-1">
                        Callsign (Short Name)
                    </label>
                    <input
                        id="cfg-callsign"
                        type="text"
                        maxLength={20}
                        value={callsign}
                        onChange={(e) => setCallsign(e.target.value)}
                        placeholder="e.g. Mullumbimby BeanPool"
                        className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white font-mono focus:outline-none focus:border-terra-500"
                    />
                </div>

                {/* Operating Region Search & Leaflet Map */}
                <div className="space-y-3">
                    <label htmlFor="location-search" className="block text-xs font-bold text-nature-300 mb-1">
                        Operating Region
                    </label>
                    <div ref={searchWrapperRef} className="relative search-wrapper">
                        <div className="relative">
                            <input
                                id="location-search"
                                type="search"
                                role="combobox"
                                aria-autocomplete="list"
                                aria-expanded={showResults && searchResults.length > 0}
                                aria-controls="location-results"
                                aria-activedescendant={selectedIndex >= 0 ? `location-result-${selectedIndex}` : undefined}
                                value={searchQuery}
                                onChange={(e) => handleSearchInput(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        if (selectedIndex >= 0 && selectedIndex < searchResults.length) {
                                            handleSelectLocation(searchResults[selectedIndex]);
                                        }
                                    } else if (e.key === 'ArrowDown') {
                                        e.preventDefault();
                                        if (showResults && searchResults.length > 0) {
                                            setSelectedIndex((prev) => (prev + 1) % searchResults.length);
                                        }
                                    } else if (e.key === 'ArrowUp') {
                                        e.preventDefault();
                                        if (showResults && searchResults.length > 0) {
                                            setSelectedIndex((prev) => (prev <= 0 ? searchResults.length - 1 : prev - 1));
                                        }
                                    } else if (e.key === 'Escape') {
                                        setShowResults(false);
                                        setSelectedIndex(-1);
                                    }
                                }}
                                placeholder="Search for a location..."
                                autoComplete="off"
                                className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500 pr-10"
                            />
                            {searching && (
                                <span className="absolute right-3 top-2.5 text-nature-400 text-xs animate-spin">
                                    🔄
                                </span>
                            )}
                        </div>

                        {showResults && searchResults.length > 0 && (
                            <div
                                id="location-results"
                                role="listbox"
                                aria-label="Location suggestions"
                                className="absolute left-0 right-0 top-full mt-1 bg-nature-900 border border-nature-700 rounded-xl shadow-2xl z-30 max-h-56 overflow-y-auto custom-scrollbar divide-y divide-nature-800"
                            >
                                {searchResults.map((item, idx) => (
                                    <div
                                        key={idx}
                                        id={`location-result-${idx}`}
                                        role="option"
                                        aria-selected={selectedIndex === idx}
                                        tabIndex={-1}
                                        onClick={() => handleSelectLocation(item)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ' ') {
                                                e.preventDefault();
                                                handleSelectLocation(item);
                                            }
                                        }}
                                        className={`p-3 text-xs cursor-pointer transition-colors ${
                                            selectedIndex === idx ? 'bg-nature-800' : 'hover:bg-nature-800/80'
                                        }`}
                                    >
                                        <div className="text-white font-medium">{item.display_name}</div>
                                        <div className="text-[10px] text-terra-400 font-mono mt-0.5 capitalize">{item.type}</div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Interactive Leaflet Map */}
                    <div className="space-y-1.5">
                        <div
                            id="settings-map"
                            ref={mapContainerRef}
                            className="w-full h-64 sm:h-72 rounded-xl border border-nature-800 bg-nature-950 overflow-hidden relative shadow-inner z-10"
                        />
                        <div className="flex items-center justify-between text-[11px] text-nature-400 font-mono px-1">
                            <span>Lat: {lat !== null && !isNaN(lat) ? lat : 'Not set'}</span>
                            <span>Lng: {lng !== null && !isNaN(lng) ? lng : 'Not set'}</span>
                        </div>
                    </div>

                    {/* Hidden Coordinate Fields for Legacy ID Compatibility */}
                    <input type="hidden" id="cfg-lat" value={lat ?? ''} />
                    <input type="hidden" id="cfg-lng" value={lng ?? ''} />
                </div>

                {/* Service Radius */}
                <div id="radius-field" className="space-y-2 pt-2">
                    <label htmlFor="radius-slider" className="block text-xs font-bold text-nature-300">
                        Service Radius
                    </label>
                    <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                        <input
                            id="radius-slider"
                            type="range"
                            min="0"
                            max="500"
                            step="1"
                            value={radiusKm}
                            aria-label="Service radius slider in kilometers"
                            onChange={(e) => setRadiusKm(Number(e.target.value))}
                            className="flex-1 accent-terra-500 cursor-pointer h-2 bg-nature-950 rounded-lg appearance-none"
                        />
                        <div className="flex items-center gap-2 shrink-0">
                            <input
                                id="radius-km"
                                type="number"
                                min="0"
                                max="500"
                                step="1"
                                value={radiusKm}
                                aria-label="Service radius in kilometers"
                                onChange={(e) => {
                                    const v = Math.min(Math.max(0, parseInt(e.target.value, 10) || 0), 500);
                                    setRadiusKm(v);
                                }}
                                placeholder="km"
                                className="w-20 bg-nature-950 border border-nature-700 rounded-xl px-2.5 py-1.5 text-center text-xs text-white font-mono focus:outline-none focus:border-terra-500"
                            />
                            <span className="text-xs text-nature-400">km</span>
                        </div>
                    </div>
                </div>

                {/* Directory Publishing */}
                <div className="pt-6 border-t border-nature-800/80 space-y-4">
                    <div className="flex items-center justify-between">
                        <h4 className="text-sm font-bold text-white m-0">Directory Publishing</h4>
                        <a
                            href={resolveNodeApiUrl(activeNode.url, '/api/directory/info')}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-sky-400 hover:text-sky-300 font-semibold inline-flex items-center gap-1 transition-colors"
                        >
                            <span>🔍 Preview Public Output</span>
                        </a>
                    </div>
                    <p className="text-xs text-nature-400 leading-relaxed m-0">
                        <strong>How it works:</strong> Your node securely pushes directory data to{' '}
                        <a
                            href="https://beanpool.org"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sky-400 font-semibold hover:underline"
                        >
                            beanpool.org ↗
                        </a>{' '}
                        on a schedule. No inbound API access is required — your node only makes outbound requests.{' '}
                        <strong className="text-white">Your node&apos;s URL is NEVER published.</strong> This ensures your private network remains secure from the outside internet.
                    </p>

                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-nature-950 p-4 rounded-2xl border border-nature-800">
                        <div>
                            <label htmlFor="directory-push-interval" className="block text-xs font-bold text-nature-300 mb-1">
                                Update Schedule
                            </label>
                            <select
                                id="directory-push-interval"
                                value={directoryPushIntervalHours}
                                onChange={(e) => setDirectoryPushIntervalHours(Number(e.target.value))}
                                className="bg-nature-900 border border-nature-700 text-white rounded-xl px-3 py-1.5 text-xs focus:outline-none focus:border-terra-500"
                            >
                                <option value={0}>Never (Disabled)</option>
                                <option value={1}>Every 1 hour</option>
                                <option value={6}>Every 6 hours</option>
                                <option value={12}>Every 12 hours</option>
                                <option value={24}>Every 24 hours</option>
                            </select>
                        </div>
                        <div className="sm:text-right flex flex-col sm:items-end gap-1.5">
                            <div id="last-published" className="text-[11px] text-nature-400 font-mono">
                                Last published: {lastPublishedText}
                            </div>
                            <button
                                id="publish-now-btn"
                                type="button"
                                onClick={handleTriggerPublish}
                                disabled={publishingNow}
                                className="px-3.5 py-1.5 rounded-xl bg-nature-800 hover:bg-nature-700 border border-nature-700 text-xs font-bold text-white transition-all disabled:opacity-50"
                            >
                                {publishStatus || '📤 Publish Now'}
                            </button>
                        </div>
                    </div>

                    {/* Checkbox Toggles */}
                    <div className="space-y-3 pt-2">
                        <div>
                            <label className="flex items-start gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    id="publish-location"
                                    type="checkbox"
                                    checked={publishLocation}
                                    onChange={(e) => setPublishLocation(e.target.checked)}
                                    className="rounded border-nature-700 bg-nature-950 text-terra-500 mt-0.5 accent-terra-500"
                                />
                                <span>📍 Share Location &amp; Radius</span>
                            </label>
                            <p className="text-[11px] text-nature-400 ml-6 mt-0.5 leading-normal">
                                Helps other BeanPoolers avoid creating duplicate nodes in your area, and allows the global community to see our network grow. Your URL is not shared.
                            </p>
                        </div>

                        <div>
                            <label className="flex items-start gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    id="publish-members"
                                    type="checkbox"
                                    checked={publishMembers}
                                    onChange={(e) => setPublishMembers(e.target.checked)}
                                    className="rounded border-nature-700 bg-nature-950 text-terra-500 mt-0.5 accent-terra-500"
                                />
                                <span>👥 Share Member Count</span>
                            </label>
                            <p className="text-[11px] text-nature-400 ml-6 mt-0.5 leading-normal">
                                Shows the total number of users registered on your node to demonstrate community strength.
                            </p>
                        </div>

                        <div>
                            <label className="flex items-start gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    id="publish-contacts"
                                    type="checkbox"
                                    checked={publishContacts}
                                    onChange={(e) => setPublishContacts(e.target.checked)}
                                    className="rounded border-nature-700 bg-nature-950 text-terra-500 mt-0.5 accent-terra-500"
                                />
                                <span>📧 Share Community Contacts</span>
                            </label>
                            <p className="text-[11px] text-nature-400 ml-6 mt-0.5 leading-normal">
                                Makes your Community Name, Email, and Phone visible on the directory so potential new users from outside the trust network can contact the admin to request an invite.
                            </p>
                        </div>

                        <div>
                            <label className="flex items-start gap-2.5 text-xs font-bold text-white cursor-pointer select-none">
                                <input
                                    id="publish-health"
                                    type="checkbox"
                                    checked={publishHealth}
                                    onChange={(e) => setPublishHealth(e.target.checked)}
                                    className="rounded border-nature-700 bg-nature-950 text-terra-500 mt-0.5 accent-terra-500"
                                />
                                <span>🖥️ Share Node Health &amp; Version</span>
                            </label>
                            <p className="text-[11px] text-nature-400 ml-6 mt-0.5 leading-normal">
                                This information is <strong>not published</strong> on the website. It is used exclusively by the BeanPool development team for diagnostics, network health monitoring, and improving the protocol.
                            </p>
                        </div>
                    </div>
                </div>

                {/* Community Contacts */}
                <div className="pt-6 border-t border-nature-800/80 space-y-4">
                    <div>
                        <h4 className="text-sm font-bold text-white m-0">Community Contacts</h4>
                        <p className="text-xs text-nature-400 mt-0.5 m-0">
                            Public details displayed on your landing page. Helps new members find your community.
                        </p>
                    </div>

                    <div>
                        <label htmlFor="community-name" className="block text-xs font-bold text-nature-300 mb-1">
                            Community Name
                        </label>
                        <input
                            id="community-name"
                            type="text"
                            maxLength={60}
                            value={communityName}
                            onChange={(e) => setCommunityName(e.target.value)}
                            placeholder="e.g. Mullumbimby Community Exchange"
                            className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500"
                        />
                    </div>

                    <div>
                        <label htmlFor="contact-email" className="block text-xs font-bold text-nature-300 mb-1">
                            Contact Email
                        </label>
                        <input
                            id="contact-email"
                            type="email"
                            maxLength={100}
                            value={contactEmail}
                            onChange={(e) => setContactEmail(e.target.value)}
                            placeholder="e.g. admin@mycommunity.org"
                            className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500"
                        />
                    </div>

                    <div>
                        <label htmlFor="contact-phone" className="block text-xs font-bold text-nature-300 mb-1">
                            Contact Phone
                        </label>
                        <input
                            id="contact-phone"
                            type="tel"
                            maxLength={30}
                            value={contactPhone}
                            onChange={(e) => setContactPhone(e.target.value)}
                            placeholder="e.g. +61 400 123 456"
                            className="w-full bg-nature-950 border border-nature-700 rounded-xl px-3.5 py-2 text-sm text-white focus:outline-none focus:border-terra-500"
                        />
                    </div>
                </div>

                {/* Save Button */}
                <div className="pt-2">
                    <button
                        id="save-identity-btn"
                        type="submit"
                        disabled={saving}
                        className="w-full py-3 rounded-xl bg-terra-600 hover:bg-terra-500 text-sm font-bold text-white transition-all shadow-md disabled:opacity-50 active:scale-[0.99]"
                    >
                        {saving ? 'Saving...' : 'Save Identity'}
                    </button>
                </div>
            </form>
        </div>
    );
}
