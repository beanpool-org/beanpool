/**
 * MapPage — Community Map with Leaflet/OSM
 *
 * Matches the Lattice Self-Managed Wallet map design:
 *  - Light mode (default) with CSS invert for dark mode
 *  - Zoom controls (+/-) positioned bottom-left
 *  - GPS crosshair button for current location
 *  - Marketplace post pins with category emoji
 *  - User location marker (pulsing purple dot)
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import type { BeanPoolIdentity } from '../lib/identity';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import { getMarketplacePosts, createMarketplacePost, getNodeInfo, getRemotePosts, getNodeConfig, getBalance, type MarketplacePost } from '../lib/api';
import { haversineDistance } from '../lib/geo';
import { MARKETPLACE_CATEGORIES, POST_TYPE_COLORS } from '../lib/marketplace';
import { loadEnabledPeers } from '../lib/peer-prefs';
import { CommonsInfoModal } from '../components/CommonsInfoModal';

// Simple deterministic hash for consistent pin placement
function simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

// Default to Mullumbimby, Australia
const DEFAULT_CENTER: [number, number] = [-28.5495, 153.5005];
const DEFAULT_ZOOM = 13;

interface Props {
    identity: BeanPoolIdentity;
    openNewPost?: boolean;
    onOpenNewPostHandled?: () => void;
    onNavigate?: (tab: string, contextId?: string) => void;
}

export function MapPage({ identity, openNewPost, onOpenNewPostHandled, onNavigate }: Props) {
    const mapContainer = useRef<HTMLDivElement>(null);
    const mapRef = useRef<L.Map | null>(null);
    const markersRef = useRef<L.LayerGroup | null>(null);
    const userMarkerRef = useRef<L.Marker | null>(null);
    const radiusCircleRef = useRef<L.Circle | null>(null);

    const [locating, setLocating] = useState(false);
    const [posts, setPosts] = useState<MarketplacePost[]>([]);
    const [showNewPost, setShowNewPost] = useState(false);
    const [showCommonsInfo, setShowCommonsInfo] = useState(false);
    const [newPostType, setNewPostType] = useState<'offer' | 'need'>('need');
    const [newPostCategory, setNewPostCategory] = useState('general');
    const [newPostTitle, setNewPostTitle] = useState('');
    const [newPostDescription, setNewPostDescription] = useState('');
    const [newPostCredits, setNewPostCredits] = useState('');
    const [newPostPriceType, setNewPostPriceType] = useState<'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly'>('fixed');
    const [newPostRepeatable, setNewPostRepeatable] = useState(false);
    const [newPostPhotos, setNewPostPhotos] = useState<string[]>([]);
    const [posting, setPosting] = useState(false);
    const [validationErrors, setValidationErrors] = useState<Set<string>>(new Set());
    const [postLat, setPostLat] = useState<number | null>(null);
    const [postLng, setPostLng] = useState<number | null>(null);
    const [pinDropMode, setPinDropMode] = useState(false);
    const pinDropMarkerRef = useRef<L.Marker | null>(null);
    const [nodeRadius, setNodeRadius] = useState<{lat: number, lng: number, radiusKm: number} | null>(null);
    const [previewPost, setPreviewPost] = useState<MarketplacePost | null>(null);
    const [useModernMarkers, setUseModernMarkers] = useState(() => {
        return localStorage.getItem('beanpool_modern_markers') !== 'false';
    });
    // Contribution-first gate: until the member has listed an Offer they can't post
    // Needs. Default the form to Offer and warn if they switch to Need while blocked.
    const [blockedFromTrading, setBlockedFromTrading] = useState(false);

    useEffect(() => {
        let cancelled = false;
        getBalance(identity.publicKey)
            .then(b => {
                if (cancelled) return;
                const blocked = !!b.isBlockedFromTrading;
                setBlockedFromTrading(blocked);
                if (blocked) setNewPostType('offer');
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [identity.publicKey]);

    const needBlocked = blockedFromTrading && newPostType === 'need';

    useEffect(() => {
        const handleStorage = () => {
            setUseModernMarkers(localStorage.getItem('beanpool_modern_markers') !== 'false');
        };
        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, []);

    // Auto-open post form when navigated from marketplace
    useEffect(() => {
        if (openNewPost) {
            setShowNewPost(true);
            onOpenNewPostHandled?.();
        }
    }, [openNewPost, onOpenNewPostHandled]);

    // Initialize map
    useEffect(() => {
        if (!mapContainer.current || mapRef.current) return;

        const map = L.map(mapContainer.current, {
            center: DEFAULT_CENTER,
            zoom: DEFAULT_ZOOM,
            zoomControl: false, // We add custom controls
            attributionControl: false,
        });

        // OSM tiles
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
        }).addTo(map);

        // We use custom controls instead of Leaflet's built-in zoom
        // L.control.zoom removed — custom FAB pill provides zoom + dark + locate

        // Attribution bottom-right (small)
        L.control.attribution({ position: 'bottomright', prefix: false })
            .addAttribution('© <a href="https://openstreetmap.org">OSM</a>')
            .addTo(map);

        // Map click to dismiss preview
        map.on('click', () => {
            setPreviewPost(null);
        });

        // Markers layer
        markersRef.current = L.markerClusterGroup({
            showCoverageOnHover: false,
            maxClusterRadius: 40,
            iconCreateFunction: (cluster) => {
                return L.divIcon({
                    html: `<div style="background-color: #1f2937; color: white; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; border-radius: 18px; font-weight: bold; border: 3px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.2);">${cluster.getChildCount()}</div>`,
                    className: 'custom-cluster-icon',
                    iconSize: [36, 36],
                });
            }
        }).addTo(map);

        mapRef.current = map;

        // Light mode by default — no filter needed

        // We specifically DO NOT request location on init here anymore
        // map.locate({ setView: false });
        // map.on('locationfound', (e) => {
        //     setUserMarker(map, e.latlng);
        // });

        // We specifically DO NOT request location on init here anymore
        // map.locate({ setView: false });
        // map.on('locationfound', (e) => {
        //     setUserMarker(map, e.latlng);
        // });

        // Draw service radius circle from node config & center map on node location
        getNodeConfig().then(config => {
            if (config.serviceRadius && typeof config.serviceRadius.lat === 'number' && typeof config.serviceRadius.lng === 'number' && mapRef.current) {
                setNodeRadius(config.serviceRadius);
                const { lat, lng, radiusKm } = config.serviceRadius;
                if (radiusCircleRef.current) {
                    mapRef.current.removeLayer(radiusCircleRef.current);
                    radiusCircleRef.current = null;
                }
                if (radiusKm && radiusKm > 0) {
                    radiusCircleRef.current = L.circle([lat, lng], {
                        radius: radiusKm * 1000,
                        color: '#f59e0b',
                        fillColor: '#f59e0b',
                        fillOpacity: 0.06,
                        weight: 2,
                        dashArray: '8 5',
                        interactive: false,
                    }).addTo(mapRef.current);

                    // Frame the map around the radius so it touches the edges
                    mapRef.current.fitBounds(radiusCircleRef.current.getBounds(), { padding: [10, 10] });
                } else {
                    // Radius is 0 or unassigned — center map on node lat/lng directly
                    mapRef.current.setView([lat, lng], DEFAULT_ZOOM);
                }
            }
        }).catch(() => {});

        return () => {
            map.remove();
            mapRef.current = null;
        };
    }, []);

    function handleLocate() {
        if (!mapRef.current) return;
        setLocating(true);
        
        const map = mapRef.current;
        const onLocationFound = (e: L.LocationEvent) => {
            setUserMarker(map, e.latlng);
            setLocating(false);
            cleanupLocate();
        };
        const onLocationError = () => {
            setLocating(false);
            cleanupLocate();
        };
        function cleanupLocate() {
            map.off('locationfound', onLocationFound);
            map.off('locationerror', onLocationError);
        }

        map.on('locationfound', onLocationFound);
        map.on('locationerror', onLocationError);
        map.locate({ setView: true, maxZoom: 16 });
    }

    // User location marker (pulsing purple dot)
    function setUserMarker(map: L.Map, latlng: L.LatLng) {
        if (userMarkerRef.current) {
            userMarkerRef.current.setLatLng(latlng);
            return;
        }
        const icon = L.divIcon({
            className: '',
            html: `<div class="user-marker-pulse"></div>`,
            iconSize: [18, 18],
            iconAnchor: [9, 9],
        });
        userMarkerRef.current = L.marker(latlng, { icon, zIndexOffset: 1000 }).addTo(map);
    }

    // Load marketplace posts (home + enabled peers from localStorage)
    const refreshPosts = useCallback(async () => {
        try {
            const localData = await getMarketplacePosts();
            let allPosts: MarketplacePost[] = [...localData];

            // Only fetch from peers the user has toggled on
            const enabledPeers = loadEnabledPeers();
            if (enabledPeers.size > 0) {
                const nodeInfo = await getNodeInfo('');
                const peersToFetch = (nodeInfo.peerNodes || [])
                    .filter((n: any) => n.publicUrl && enabledPeers.has(n.publicUrl));

                if (peersToFetch.length > 0) {
                    const remoteResults = await Promise.allSettled(
                        peersToFetch.map(async (n: any) => {
                            const remotePosts = await getRemotePosts(n.publicUrl);
                            return remotePosts.map((p: any) => ({ ...p, _remoteNode: n.publicUrl, _remoteCallsign: n.callsign }));
                        })
                    );
                    for (const result of remoteResults) {
                        if (result.status === 'fulfilled') allPosts = allPosts.concat(result.value);
                    }
                }
            }
            setPosts(allPosts);
        } catch { /* offline */ }
    }, []);

    useEffect(() => {
        refreshPosts();
        const interval = setInterval(refreshPosts, 30_000);
        return () => clearInterval(interval);
    }, [refreshPosts]);

    // Create a new post from the map
    async function handleCreatePost() {
        // Validate all fields
        const errors = new Set<string>();
        if (!newPostTitle.trim()) errors.add('title');
        if (newPostCredits.trim() === '' || isNaN(Number(newPostCredits)) || Number(newPostCredits) < 0) errors.add('credits');
        if (!newPostDescription.trim()) errors.add('description');
        if (postLat == null || postLng == null) errors.add('location');
        if (newPostPhotos.length < 1) errors.add('photos');
        setValidationErrors(errors);
        if (errors.size > 0) return;

        if (nodeRadius && postLat != null && postLng != null) {
            const dist = haversineDistance(postLat, postLng, nodeRadius.lat, nodeRadius.lng);
            if (dist > nodeRadius.radiusKm) {
                const proceed = window.confirm(`This listing is ${Math.round(dist)}km away, which is outside your community's ${nodeRadius.radiusKm}km service area. Are you sure you want to post it here?`);
                if (!proceed) return;
            }
        }

        setPosting(true);
        try {
            await createMarketplacePost({
                type: newPostType,
                category: newPostCategory,
                title: newPostTitle.trim(),
                description: newPostDescription.trim(),
                credits: Number(newPostCredits) || 0,
                priceType: newPostPriceType,
                authorPublicKey: identity.publicKey || '',
                repeatable: newPostRepeatable,
                ...(postLat != null && postLng != null ? { lat: postLat, lng: postLng } : {}),
                ...(newPostPhotos.length > 0 ? { photos: newPostPhotos } : {}),
            });
            setNewPostTitle('');
            setNewPostDescription('');
            setNewPostCredits('');
            setNewPostPriceType('fixed');
            setNewPostRepeatable(false);
            setNewPostPhotos([]);
            setPostLat(null);
            setPostLng(null);
            setPinDropMode(false);
            if (pinDropMarkerRef.current) {
                pinDropMarkerRef.current.remove();
                pinDropMarkerRef.current = null;
            }
            setShowNewPost(false);
            refreshPosts();
            if (onNavigate) onNavigate('marketplace', 'deals_active');
        } catch (e: any) {
            alert(e.message || 'Failed to create post. Are you offline?');
        }
        setPosting(false);
    }

    // Use current GPS location for the post
    function useMyLocation() {
        if (!mapRef.current) return;

        const map = mapRef.current;
        const onLocationFound = (e: L.LocationEvent) => {
            setPostLat(Math.round(e.latlng.lat * 10000) / 10000);
            setPostLng(Math.round(e.latlng.lng * 10000) / 10000);
            setPinDropMode(false);
            // Place preview pin
            placePreviewPin(e.latlng.lat, e.latlng.lng);
            cleanupLocate();
        };
        const onLocationError = () => {
            // Fall back to pin drop
            setPinDropMode(true);
            cleanupLocate();
        };
        function cleanupLocate() {
            map.off('locationfound', onLocationFound);
            map.off('locationerror', onLocationError);
        }

        map.on('locationfound', onLocationFound);
        map.on('locationerror', onLocationError);
        map.locate({ setView: false, maxZoom: 16 });
    }

    // Enter pin-drop mode — tap map to place location
    function enterPinDrop() {
        setPinDropMode(true);
        setPostLat(null);
        setPostLng(null);
        if (pinDropMarkerRef.current) {
            pinDropMarkerRef.current.remove();
            pinDropMarkerRef.current = null;
        }
    }

    // Place a preview pin on the map
    function placePreviewPin(lat: number, lng: number) {
        if (!mapRef.current) return;
        if (pinDropMarkerRef.current) {
            pinDropMarkerRef.current.setLatLng([lat, lng]);
        } else {
            const icon = L.divIcon({
                className: 'custom-preview-pin',
                html: `
                <div style="position: relative; width: 36px; height: 46px; display: flex; flex-direction: column; align-items: center; opacity: 0.8;">
                    <div style="
                        width: 36px; height: 36px; border-radius: 50%;
                        background: #fff; border: 2.5px dashed #d97757;
                        box-shadow: 0 4px 8px rgba(0,0,0,0.15);
                        z-index: 2; box-sizing: border-box;
                    "></div>
                    <div style="
                        width: 0; height: 0;
                        border-left: 6px solid transparent;
                        border-right: 6px solid transparent;
                        border-top: 10px solid #d97757;
                        margin-top: -2px; z-index: 1;
                    "></div>
                </div>`,
                iconSize: [36, 46],
                iconAnchor: [18, 46],
            });
            pinDropMarkerRef.current = L.marker([lat, lng], { icon }).addTo(mapRef.current);
        }
    }

    // Listen for map clicks in pin-drop mode
    useEffect(() => {
        if (!mapRef.current) return;
        const map = mapRef.current;
        function onMapClick(e: L.LeafletMouseEvent) {
            if (!pinDropMode) return;
            const lat = Math.round(e.latlng.lat * 10000) / 10000;
            const lng = Math.round(e.latlng.lng * 10000) / 10000;
            setPostLat(lat);
            setPostLng(lng);
            placePreviewPin(lat, lng);
        }
        map.on('click', onMapClick);
        return () => { map.off('click', onMapClick); };
    }, [pinDropMode]);

    // Render marketplace post pins on the map
    useEffect(() => {
        if (!markersRef.current || !mapRef.current) return;
        markersRef.current.clearLayers();

        posts.filter(post => !post.status || post.status === 'active').forEach((post) => {
            const cat = MARKETPLACE_CATEGORIES.find(c => c.id === post.category);
            const emoji = cat?.emoji || '📌';
            const typeColor = POST_TYPE_COLORS[post.type] || '#888';
            const isRemote = !!(post as any)._remoteNode;
            const remoteCallsign = (post as any)._remoteCallsign || '';
            // Remote pins get indigo border; local pins get type color
            const borderColor = isRemote ? '#6366f1' : typeColor;

            // Use real coordinates if available, otherwise deterministic fallback
            let lat: number, lng: number;
            if (post.lat != null && post.lng != null) {
                lat = post.lat;
                lng = post.lng;
            } else {
                const hash = simpleHash(post.id || post.title);
                const centerLat = nodeRadius?.lat ?? DEFAULT_CENTER[0];
                const centerLng = nodeRadius?.lng ?? DEFAULT_CENTER[1];
                lat = centerLat + ((hash % 1000) - 500) * 0.00004;
                lng = centerLng + ((Math.floor(hash / 1000) % 1000) - 500) * 0.00004;
            }

            const typeLabel = post.type === 'offer' ? 'Offer' : 'Need';
            // Elder Glow: highlight established community members
            const hasElderGlow = (post.authorEnergyCycled ?? 0) >= 10000;
            
            let html: string;
            if (useModernMarkers) {
                html = `
                <div style="position: relative; width: 40px; height: 48px; display: flex; flex-direction: column; align-items: center; filter: drop-shadow(0 3px 4px rgba(0, 0, 0, 0.15));">
                    <div style="
                        width: 40px; height: 40px; border-radius: 50%;
                        background: rgba(255,255,255,0.95); border: 2.5px solid ${borderColor};
                        display: flex; align-items: center; justify-content: center;
                        box-sizing: border-box; z-index: 2; position: relative;
                        ${hasElderGlow ? 'border-color: #fbbf24; box-shadow: 0 0 6px rgba(251,191,36,0.8);' : ''}
                    ">
                        <span style="font-size: 22px; line-height: 1; padding-bottom: 2px;">${emoji}</span>
                    </div>
                    <div style="
                        position: absolute; bottom: 0; width: 0; height: 0;
                        border-left: 6px solid transparent;
                        border-right: 6px solid transparent;
                        border-top: 10px solid ${borderColor};
                        z-index: 1;
                    "></div>
                </div>`;
            } else {
                html = `
                <div style="position: relative; width: 44px; height: 56px; display: flex; flex-direction: column; align-items: center; filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.15));">
                    <div style="
                        width: 44px; height: 44px; border-radius: 50%;
                        background: rgba(255,255,255,0.95); border: 2.5px solid ${borderColor};
                        display: flex; flex-direction: column; align-items: center; justify-content: center;
                        box-sizing: border-box; z-index: 2; position: relative;
                    ">
                        <span style="font-size: 18px; line-height: 1.1;">${emoji}</span>
                        <span style="font-size: 8px; font-weight: 800; color: ${borderColor}; text-transform: uppercase; letter-spacing: -0.5px; opacity: 0.9; margin-top: -2px;">${typeLabel}</span>
                    </div>
                    <div style="
                        width: 0; height: 0;
                        border-left: 8px solid transparent;
                        border-right: 8px solid transparent;
                        border-top: 12px solid ${borderColor};
                        margin-top: -3px; z-index: 1; position: relative;
                    "></div>
                </div>`;
            }
            
            const iconSize = useModernMarkers ? [40, 48] as [number, number] : [44, 56] as [number, number];
            const iconAnchor = useModernMarkers ? [20, 48] as [number, number] : [22, 56] as [number, number];
            
            const icon = L.divIcon({
                className: 'custom-map-pin hover:scale-110 transition-transform origin-bottom',
                html,
                iconSize,
                iconAnchor
            });

            const marker = L.marker([lat, lng], { icon });
            marker.on('click', () => {
                setPreviewPost(post);
                if (mapRef.current) {
                    mapRef.current.setView([lat, lng], mapRef.current.getZoom(), { animate: true });
                }
            });
            marker.addTo(markersRef.current!);
        });
    }, [posts, useModernMarkers]);

    return (
        <>
        <div className="relative w-full h-full">
            {/* Map custom styles overrides for glassmorphism and Earth-tone palettes */}
            <style>{`
                .leaflet-container {
                    z-index: 0 !important;
                }
                .leaflet-top.leaflet-right {
                    display: none !important;
                }
                .user-marker-pulse {
                    width: 18px; height: 18px;
                    background: rgba(16, 185, 129, 0.9); /* emerald-500 */
                    border: 2px solid #fff;
                    border-radius: 50%;
                    box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.6);
                    animation: pulse 2s ease-out infinite;
                }
                @keyframes pulse {
                    0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.6); }
                    100% { box-shadow: 0 0 0 16px rgba(16, 185, 129, 0); }
                }
                .leaflet-control-zoom a {
                    background: rgba(255, 255, 255, 0.9) !important;
                    color: #4b5563 !important; /* text-nature-600 */
                    border-color: #e5e7eb !important; /* border-nature-200 */
                }
                .leaflet-control-zoom a:hover {
                    background: rgba(249, 250, 251, 0.95) !important; /* bg-nature-50 */
                }
                .leaflet-control-attribution {
                    background: rgba(255, 255, 255, 0.7) !important;
                    color: #6b7280 !important; /* text-nature-500 */
                    font-size: 10px !important;
                    border-top-left-radius: 8px;
                }
                .leaflet-control-attribution a {
                    color: #4b5563 !important;
                }
                .leaflet-popup-content-wrapper {
                    background: rgba(255, 255, 255, 0.95) !important;
                    color: #111827 !important; /* text-nature-950 */
                    border-radius: 16px !important;
                    box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1) !important; /* shadow-soft */
                    border: 1px solid #e5e7eb !important; /* border-nature-200 */
                }
                .leaflet-popup-tip {
                    background: rgba(255, 255, 255, 0.95) !important;
                }
            `}</style>

            {/* Map container */}
            <div ref={mapContainer} className="w-full h-full" />

            {/* FAB Pill - Bottom Left (avoids header overlap) */}
            <div className="absolute bottom-[6.5rem] left-3 flex flex-col items-center bg-white/95 dark:bg-nature-900/95 backdrop-blur-md shadow-[0_8px_30px_rgb(0,0,0,0.15)] border border-nature-200 dark:border-nature-700 rounded-2xl z-[100] overflow-hidden">
                <button
                    onClick={handleLocate}
                    aria-label="My location"
                    className={`w-12 h-12 flex items-center justify-center transition-colors ${
                        locating 
                            ? 'text-blue-600 bg-blue-50/80 dark:bg-blue-900/30' 
                            : 'text-nature-800 dark:text-oat-50 hover:bg-black/5 dark:hover:bg-white/10'
                    }`}
                    title="My location"
                >
                    {locating ? '⏳' : (
                        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <circle cx="12" cy="12" r="3" fill="currentColor" fillOpacity="0.15" />
                            <circle cx="12" cy="12" r="7" strokeDasharray="2 2" />
                            <line x1="12" y1="1" x2="12" y2="5" />
                            <line x1="12" y1="19" x2="12" y2="23" />
                            <line x1="1" y1="12" x2="5" y2="12" />
                            <line x1="19" y1="12" x2="23" y2="12" />
                        </svg>
                    )}
                </button>
                <div className="w-8 h-[1px] bg-nature-200 dark:bg-nature-700" />
                <button
                    onClick={() => mapRef.current?.zoomIn()}
                    aria-label="Zoom in"
                    className="w-12 h-10 flex items-center justify-center text-nature-800 dark:text-oat-50 text-xl font-bold hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                    title="Zoom in"
                >
                    +
                </button>
                <div className="w-8 h-[1px] bg-nature-200 dark:bg-nature-700" />
                <button
                    onClick={() => mapRef.current?.zoomOut()}
                    aria-label="Zoom out"
                    className="w-12 h-10 flex items-center justify-center text-nature-800 dark:text-oat-50 text-xl font-bold hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                    title="Zoom out"
                >
                    −
                </button>
            </div>

            {/* Floating Add Button — bottom right */}
            {!showNewPost && (
                <button
                    onClick={() => setShowNewPost(true)}
                    aria-label="New Post"
                    className="fixed bottom-[5.5rem] right-3 w-14 h-14 rounded-full bg-terra-500 hover:bg-terra-600 text-white text-3xl font-light z-[101] shadow-[0_8px_30px_rgb(226,114,91,0.4)] flex items-center justify-center transition-transform transform hover:scale-105 border-2 border-white/20"
                    title="New Post"
                >
                    +
                </button>
            )}
        </div>

        {/* Map Preview Card */}
        {previewPost && (
            <div className="absolute bottom-0 left-0 right-0 z-[150] flex flex-col justify-end pointer-events-none pb-[4.5rem]">
                <div className="bg-white dark:bg-nature-900 m-4 rounded-[24px] p-4 flex flex-row shadow-[0_10px_20px_rgba(0,0,0,0.15)] pointer-events-auto relative border border-nature-200 dark:border-nature-800 transition-colors">
                    <button 
                        onClick={() => setPreviewPost(null)}
                        aria-label="Close preview"
                        className="absolute top-3 right-3 w-7 h-7 rounded-full bg-black/5 dark:bg-white/10 flex items-center justify-center border-none text-xs font-extrabold text-gray-500 dark:text-gray-400 cursor-pointer hover:bg-black/10 dark:hover:bg-white/20 transition-colors"
                    >
                        ✕
                    </button>
                    {previewPost.photos && previewPost.photos.length > 0 ? (
                        <img src={previewPost.photos[0]} alt="thumb" className="w-[90px] h-[90px] rounded-2xl object-cover bg-gray-100 dark:bg-nature-800" />
                    ) : (
                        <div className="w-[90px] h-[90px] rounded-2xl bg-gray-100 dark:bg-nature-800 flex items-center justify-center transition-colors">
                            <span className="text-4xl">{MARKETPLACE_CATEGORIES.find(c => c.id === previewPost.category)?.emoji || '📦'}</span>
                        </div>
                    )}
                    <div className="flex-1 ml-4 flex flex-col justify-center">
                        <div className="flex justify-between items-center mb-1">
                            <span className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider truncate mr-2 flex-1">
                                {MARKETPLACE_CATEGORIES.find(c => c.id === previewPost.category)?.label || previewPost.category}
                            </span>
                            <span className="text-sm font-extrabold text-emerald-500 dark:text-emerald-400 mr-6">
                                {previewPost.credits}B
                            </span>
                        </div>
                        <span className="text-lg font-extrabold text-gray-900 dark:text-white mb-1 leading-tight line-clamp-1 transition-colors">
                            {previewPost.title}
                        </span>
                        <span className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3 truncate transition-colors">
                            {previewPost.authorCallsign} {(previewPost as any)._remoteNode ? '🌐' : ''}{(previewPost.authorEnergyCycled ?? 0) >= 10000 ? ' ⛰️ Elder' : ''}
                        </span>
                        <button
                            onClick={() => onNavigate && onNavigate('marketplace', previewPost.id)}
                            className={`py-2 px-4 rounded-xl border-none font-bold text-white text-sm cursor-pointer shadow-sm transition-transform hover:scale-[1.02] active:scale-[0.98] ${
                                previewPost.type === 'offer' ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-terra-600 hover:bg-terra-700'
                            }`}
                        >
                            View Details
                        </button>
                    </div>
                </div>
            </div>
        )}

        {/* Quick Post Panel — rendered OUTSIDE the map div so Leaflet touch handlers don't interfere */}
        {showNewPost && (
            <div className="fixed bottom-[4.5rem] left-3 right-3 max-h-[60vh] overflow-y-auto bg-white/95 dark:bg-nature-900/95 backdrop-blur-xl rounded-3xl p-5 z-[1000] shadow-soft border border-nature-200 dark:border-nature-800 overscroll-contain">
                <div className="flex justify-between items-center mb-4">
                    <span className="font-bold text-lg text-nature-950 dark:text-white tracking-tight">New Post</span>
                    <button onClick={() => {
                        setShowNewPost(false);
                        setPinDropMode(false);
                        setPostLat(null);
                        setPostLng(null);
                        if (pinDropMarkerRef.current) {
                            pinDropMarkerRef.current.remove();
                            pinDropMarkerRef.current = null;
                        }
                    }} aria-label="Close new post" className="bg-transparent border-none text-nature-400 hover:text-nature-600 text-2xl cursor-pointer transition-colors leading-none w-8 h-8 flex items-center justify-center rounded-full hover:bg-nature-50">
                        ✕
                    </button>
                </div>

                {/* Type toggle */}
                <div className="flex gap-2 mb-4">
                    {(['offer', 'need'] as const).map(t => (
                        <button key={t} onClick={() => setNewPostType(t)} className={`flex-1 py-3 rounded-xl border text-[15px] font-bold capitalize transition-all shadow-sm ${
                            newPostType === t
                                ? (t === 'offer' ? 'bg-blue-600 border-blue-600 text-white shadow-md scale-[1.02]' : 'bg-orange-600 border-orange-600 text-white shadow-md scale-[1.02]')
                                : 'bg-white dark:bg-nature-800 border-nature-200 dark:border-nature-700 text-nature-500 dark:text-nature-300 hover:bg-oat-50 dark:hover:bg-nature-700'
                        }`}>
                            {t === 'offer' ? '🔵 Offer' : '🟠 Need'}
                        </button>
                    ))}
                </div>

                {needBlocked && (
                    <div className="mb-4 p-3 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-200 text-sm">
                        <p className="font-bold mb-1">💡 Contributions First</p>
                        <p className="text-[13px] leading-snug">
                            BeanPool is a mutual-credit community. To encourage a culture of giving, new members must list at least one Offer before they can post Needs. Let the community know what you can give back — switch to <span className="font-bold">🔵 Offer</span> above. (Or ask an Elder to vouch for you.)
                        </p>
                    </div>
                )}

                {/* Category */}
                <select
                    value={newPostCategory}
                    onChange={e => setNewPostCategory(e.target.value)}
                    className="w-full mb-3 py-3 px-4 rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[15px] focus:outline-none focus:ring-2 focus:ring-terra-300 shadow-sm appearance-auto cursor-pointer"
                >
                    {MARKETPLACE_CATEGORIES.map(c => (
                        <option key={c.id} value={c.id}>{c.emoji} {c.label}</option>
                    ))}
                </select>

                {/* Location picker */}
                <div className="flex gap-2 mb-2">
                    <button onClick={() => { useMyLocation(); setValidationErrors(prev => { const n = new Set(prev); n.delete('location'); return n; }); }} className={`flex-1 flex flex-col items-center justify-center gap-1 py-3 rounded-xl border transition-all text-sm font-bold shadow-sm ${
                        validationErrors.has('location') ? 'border-red-400 bg-red-50 text-red-600 shadow-md ring-1 ring-red-400' 
                        : (postLat != null && !pinDropMode) ? 'border-emerald-500 bg-emerald-50 text-emerald-700 shadow-md ring-1 ring-emerald-500' : 'border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-600 dark:text-nature-300 hover:bg-nature-50 dark:hover:bg-nature-700'
                    }`}>
                        <span className="text-xl leading-none">📍</span> My location
                    </button>
                    <button onClick={() => { enterPinDrop(); setValidationErrors(prev => { const n = new Set(prev); n.delete('location'); return n; }); }} className={`flex-1 flex flex-col items-center justify-center gap-1 py-3 rounded-xl border transition-all text-sm font-bold shadow-sm ${
                        validationErrors.has('location') ? 'border-red-400 bg-red-50 text-red-600 shadow-md ring-1 ring-red-400' 
                        : pinDropMode ? 'border-blue-500 bg-blue-50 text-blue-700 shadow-md ring-1 ring-blue-500' : 'border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-600 dark:text-nature-300 hover:bg-nature-50 dark:hover:bg-nature-700'
                    }`}>
                        <span className="text-xl leading-none">📌</span> Drop a pin
                    </button>
                </div>
                {pinDropMode && postLat == null && (
                    <p className="m-0 mb-3 text-blue-600 text-sm font-semibold text-center animate-pulse">
                        Tap the map to place your pin
                    </p>
                )}
                {postLat != null && postLng != null && (
                    <p className="m-0 mb-3 text-emerald-600 text-sm font-semibold text-center flex items-center justify-center gap-1">
                        ✓ Location set
                    </p>
                )}

                {/* Title + Credits */}
                <div className="flex gap-2 mb-3">
                    <input
                        placeholder="What do you need/offer?"
                        value={newPostTitle}
                        onChange={e => { setNewPostTitle(e.target.value); setValidationErrors(prev => { const n = new Set(prev); n.delete('title'); return n; }); }}
                        className={`flex-1 py-3 px-4 rounded-xl border bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[15px] focus:outline-none focus:ring-2 focus:ring-terra-300 shadow-sm transition-all ${
                            validationErrors.has('title') ? 'border-red-400 bg-red-50 ring-1 ring-red-400' : 'border-nature-200 dark:border-nature-700'
                        }`}
                    />
                    <input
                        placeholder="B"
                        type="number"
                        min="0"
                        step="0.01"
                        value={newPostCredits}
                        onChange={e => { setNewPostCredits(e.target.value); setValidationErrors(prev => { const n = new Set(prev); n.delete('credits'); return n; }); }}
                        className={`w-20 py-3 px-2 rounded-xl border bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[15px] focus:outline-none focus:ring-2 focus:ring-terra-300 shadow-sm text-center font-bold tracking-tight transition-all ${
                            validationErrors.has('credits') ? 'border-red-400 bg-red-50 ring-1 ring-red-400' : 'border-nature-200 dark:border-nature-700'
                        }`}
                    />
                    <select
                        value={newPostPriceType}
                        onChange={e => setNewPostPriceType(e.target.value as 'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly')}
                        className="w-24 py-3 px-2 rounded-xl border bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[14px] font-semibold focus:outline-none focus:ring-2 focus:ring-terra-300 shadow-sm transition-all border-nature-200 dark:border-nature-700 cursor-pointer appearance-auto"
                    >
                        <option value="fixed">Total</option>
                        <option value="hourly">/ Hr</option>
                        <option value="daily">/ Dy</option>
                        <option value="weekly">/ Wk</option>
                        <option value="monthly">/ Mo</option>
                    </select>
                </div>

                <p 
                    onClick={() => setShowCommonsInfo(true)}
                    className="text-[13.5px] text-nature-700 dark:text-nature-300 mt-1 mb-3 font-semibold cursor-pointer hover:text-nature-900 dark:hover:text-white transition-colors"
                >
                    {(() => {
                        const parsed = parseFloat(newPostCredits);
                        if (!isNaN(parsed) && parsed > 0) {
                            const net = Math.round(parsed * 0.985 * 100) / 100;
                            return `1.5% fee: ${newPostType === 'offer' ? 'You will receive' : 'Fulfiller receives'} ${net.toFixed(2)} B. `;
                        }
                        return '1.5% transaction fee funds community projects & solvency. ';
                    })()}<span className="text-amber-600 dark:text-amber-500 font-bold underline decoration-dotted underline-offset-2 ml-1">Learn more ⓘ</span>
                    <span className="text-emerald-600 dark:text-emerald-500 font-bold ml-1">(100% community owned)</span>
                </p>

                {/* Repeatable toggle */}
                <label className="flex items-center gap-3 text-sm font-medium text-nature-700 cursor-pointer py-2 px-1 mb-1">
                    <input
                        type="checkbox"
                        checked={newPostRepeatable}
                        onChange={e => setNewPostRepeatable(e.target.checked)}
                        className="w-5 h-5 rounded border-nature-300 text-blue-600 focus:ring-blue-500 shadow-sm accent-blue-600 cursor-pointer transition-all"
                    />
                    🔁 Repeatable — keep listing active for ongoing bookings
                </label>

                {/* Description */}
                <textarea
                    placeholder="Describe what you need/offer..."
                    value={newPostDescription}
                    onChange={e => { setNewPostDescription(e.target.value); setValidationErrors(prev => { const n = new Set(prev); n.delete('description'); return n; }); }}
                    rows={2}
                    className={`w-full mb-4 py-3 px-4 rounded-xl border bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[15px] focus:outline-none focus:ring-2 focus:ring-terra-300 shadow-sm min-h-[90px] resize-y transition-all ${
                        validationErrors.has('description') ? 'border-red-400 bg-red-50 ring-1 ring-red-400' : 'border-nature-200 dark:border-nature-700'
                    }`}
                />

                {/* Photos */}
                <div className="mb-5">
                    <div className="flex gap-2 flex-wrap items-center">
                        {newPostPhotos.map((photo, i) => (
                            <div key={i} className="relative">
                                <img src={photo} alt={`photo ${i+1}`} className="w-16 h-16 object-cover rounded-xl border border-nature-200 shadow-sm" />
                                <button
                                    onClick={() => setNewPostPhotos(prev => prev.filter((_, j) => j !== i))}
                                    aria-label="Remove photo"
                                    className="absolute -top-1.5 -right-1.5 w-6 h-6 bg-red-500 border-none rounded-full text-white text-[11px] font-bold cursor-pointer flex items-center justify-center shadow-md hover:bg-red-600 transition-colors transform hover:scale-110"
                                >
                                    ✕
                                </button>
                            </div>
                        ))}
                        {newPostPhotos.length < 5 && (
                            <label className="w-16 h-16 rounded-xl border-2 border-dashed border-nature-300 flex items-center justify-center cursor-pointer bg-nature-50 text-2xl text-nature-400 hover:text-nature-500 hover:border-nature-400 hover:bg-oat-50 transition-all shadow-sm">
                                📷
                                <input
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                    onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        if (!file) return;
                                        const reader = new FileReader();
                                        reader.onload = () => {
                                            const img = new Image();
                                            img.onload = () => {
                                                const canvas = document.createElement('canvas');
                                                const MAX = 800;
                                                let w = img.width, h = img.height;
                                                if (w > h) { if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; } }
                                                else { if (h > MAX) { w = Math.round(w * MAX / h); h = MAX; } }
                                                canvas.width = w; canvas.height = h;
                                                canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
                                                const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
                                                setNewPostPhotos(prev => [...prev.slice(0, 4), dataUrl]);
                                            };
                                            img.src = reader.result as string;
                                        };
                                        reader.readAsDataURL(file);
                                        e.target.value = '';
                                    }}
                                />
                            </label>
                        )}
                    </div>
                    <p className={`text-xs font-semibold mt-2 uppercase tracking-wide ${validationErrors.has('photos') && newPostPhotos.length === 0 ? 'text-red-500' : 'text-nature-400'}`}>
                        {newPostPhotos.length}/5 photos {newPostPhotos.length === 0 ? '(at least 1 required)' : ''}
                    </p>
                </div>

                <button
                    onClick={handleCreatePost}
                    disabled={needBlocked || posting || !newPostTitle.trim() || !newPostDescription.trim() || newPostCredits === '' || postLat == null || newPostPhotos.length === 0}
                    className={`w-full p-3 rounded-xl font-semibold transition-all ${
                        needBlocked || posting || !newPostTitle.trim() || !newPostDescription.trim() || newPostCredits === '' || postLat == null || newPostPhotos.length === 0
                            ? 'bg-oat-200 text-oat-500 cursor-not-allowed'
                            : 'bg-nature-600 text-white hover:bg-nature-700 shadow-md'
                    }`}
                >
                    {posting ? 'Posting...' :
                     needBlocked ? '🔵 List an Offer first to post Needs' :
                     postLat == null ? '📍 Map location required' :
                     !newPostTitle.trim() || !newPostDescription.trim() || newPostCredits === '' ? '✏️ Fill required fields' :
                     `Post ${newPostType === 'offer' ? 'Offer' : 'Need'}`}
                </button>
            </div>
        )}
        <CommonsInfoModal 
            isOpen={showCommonsInfo} 
            onClose={() => setShowCommonsInfo(false)} 
        />
    </>
    );
}
