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

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { BeanPoolIdentity } from '../lib/identity';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import {
    getMarketplacePosts, createMarketplacePost, getNodeInfo, getRemotePosts,
    getNodeConfig, getBalance, getReachablePeers, getTreasuries, getEnterpriseStatuses,
    getEnterpriseMapPins, type EnterpriseMapPin,
    getGroups, type MarketplacePost, type PostReach, type ReachablePeer, type Group
} from '../lib/api';
import { haversineDistance } from '../lib/geo';
import { MARKETPLACE_CATEGORIES, MARKETPLACE_CATEGORIES_BY_ID, POST_TYPE_COLORS } from '../lib/marketplace';
import { loadEnabledPeers } from '../lib/peer-prefs';
import { CommonsInfoModal } from '../components/CommonsInfoModal';
import { ProfileGateModal } from '../components/ProfileGateModal';
import { getProfileStatus, describeMissing } from '../lib/profile-status';
import { getBlockedUsers, onBlocklistUpdated } from '../lib/blocklist';
import { withJitter } from '../lib/jitter';
import { onSyncActivity } from '../lib/sync';
import { ImageLightbox } from '../components/ImageLightbox';
import { EventCard } from '../components/EventCard';
import { approximateLocation } from '@beanpool/core';
import { CLIENT_POST_TYPES, EVENT_WINDOWS, buildEventCopy, eventInWindow, isEventOpen, localInputToIso, type EventWindow } from '../lib/events';

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
    initialGroupId?: string;
    onOpenNewPostHandled?: () => void;
    onNavigate?: (tab: string, contextId?: string) => void;
    onOpenTreasury?: (pubkey: string) => void;
    /**
     * Whether the viewer is a member of this node. False for a guest (a local key the node has no member
     * for), so the viewer's balance is never requested. Null while App is still checking, so the request
     * waits for the answer. Omitted means a member.
     */
    isMember?: boolean | null;
    /**
     * True while App shows the enterprise or profile page over the map. Those pages stack at z-[110], and the
     * preview card (z-[150]) and New Post panel (z-[1000]) are in the same root stacking context, so they are
     * hidden — not closed — while covered: Back brings them back with the draft intact.
     */
    covered?: boolean;
    /** An event opened from its detail with "Show on map": centre on it and show its card. */
    focusPostId?: string | null;
    onFocusPostHandled?: () => void;
    /**
     * "Copy to a new date" from an event's host panel (docs/events-on-the-map.md §3, slice 5): open the event
     * form filled from this event, with Starts and Ends blank.
     */
    copyEventPostId?: string | null;
    onCopyEventHandled?: () => void;
}

/** Event form limits, as the node enforces them (docs/events-on-the-map.md §2.2). */
const EVENT_PLACE_NAME_MAX = 80;
const EVENT_PRIVATE_NOTE_MAX = 1000;

export function MapPage({ identity, openNewPost, initialGroupId, onOpenNewPostHandled, onNavigate, onOpenTreasury, isMember, covered = false, focusPostId, onFocusPostHandled, copyEventPostId, onCopyEventHandled }: Props) {
    const mapContainer = useRef<HTMLDivElement>(null);
    const mapRef = useRef<L.Map | null>(null);
    const markersRef = useRef<L.LayerGroup | null>(null);
    const userMarkerRef = useRef<L.Marker | null>(null);
    const radiusCircleRef = useRef<L.Circle | null>(null);

    const [locating, setLocating] = useState(false);
    const [posts, setPosts] = useState<MarketplacePost[]>([]);
    const [showNewPost, setShowNewPost] = useState(false);
    const [userGroups, setUserGroups] = useState<Group[]>([]);
    const [audienceScope, setAudienceScope] = useState<'public' | 'group'>('public');
    const [targetGroupId, setTargetGroupId] = useState<string>('');
    const [profileGateMsg, setProfileGateMsg] = useState<string | null>(null);
    const [showCommonsInfo, setShowCommonsInfo] = useState(false);
    const [newPostType, setNewPostType] = useState<'offer' | 'need' | 'poll' | 'event'>('need');
    // Events (docs/events-on-the-map.md §3). Start and end hold <input type="datetime-local"> values.
    const [eventStart, setEventStart] = useState('');
    const [eventEnd, setEventEnd] = useState('');
    const [eventPlaceName, setEventPlaceName] = useState('');
    const [eventNote, setEventNote] = useState('');
    const [postApproximate, setPostApproximate] = useState(false);
    // Who hosts: 'me', `ent:<enterprise pubkey>` for a keeper, or `group:<id>` for a convenor.
    const [eventHost, setEventHost] = useState('me');
    const [keeperOf, setKeeperOf] = useState<string[]>([]);
    const [keeperNames, setKeeperNames] = useState<Record<string, string>>({});
    const [eventWindow, setEventWindow] = useState<EventWindow>('all');
    /** True while the event form holds a copy of an existing event, so the form can say what did not come with it. */
    const [eventIsCopy, setEventIsCopy] = useState(false);
    const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
    const [pollOptions, setPollOptions] = useState<string[]>(['', '']);
    const [pollDurationDays, setPollDurationDays] = useState<3 | 7 | 14>(7);
    const [newPostCategory, setNewPostCategory] = useState('general');
    const [newPostTitle, setNewPostTitle] = useState('');
    const [newPostDescription, setNewPostDescription] = useState('');
    const [newPostCredits, setNewPostCredits] = useState('');
    const [newPostPriceType, setNewPostPriceType] = useState<'fixed' | 'hourly' | 'daily' | 'weekly' | 'monthly'>('fixed');
    const [newPostRepeatable, setNewPostRepeatable] = useState(false);
    const [newPostCashAlsoNeeded, setNewPostCashAlsoNeeded] = useState(false);  // #108
    // #143 step 4 — per-listing reach. 'local' is the default and stays the default.
    const [newPostReach, setNewPostReach] = useState<PostReach>('local');
    const [newPostReachPeers, setNewPostReachPeers] = useState<string[]>([]);
    const [reachablePeerList, setReachablePeerList] = useState<ReachablePeer[]>([]);
    const [newPostPhotos, setNewPostPhotos] = useState<string[]>([]);
    const [posting, setPosting] = useState(false);
    const [validationErrors, setValidationErrors] = useState<Set<string>>(new Set());
    const [postLat, setPostLat] = useState<number | null>(null);
    const [postLng, setPostLng] = useState<number | null>(null);
    const [pinDropMode, setPinDropMode] = useState(false);
    const pinDropMarkerRef = useRef<L.Marker | null>(null);
    const [nodeRadius, setNodeRadius] = useState<{lat: number, lng: number, radiusKm: number} | null>(null);
    const [previewPost, setPreviewPost] = useState<MarketplacePost | null>(null);
    const [lightboxState, setLightboxState] = useState<{
        isOpen: boolean;
        photos: string[];
        initialIndex: number;
        title?: string;
        triggerElement?: HTMLElement | null;
    } | null>(null);
    const [blocklistVersion, setBlocklistVersion] = useState(0);
    const [inactiveEnterpriseKeys, setInactiveEnterpriseKeys] = useState<Set<string>>(new Set());
    const [enterprises, setEnterprises] = useState<EnterpriseMapPin[]>([]);

    // Keyboard accessibility: Escape closes preview card (defers to lightbox if open)
    useEffect(() => {
        if (!previewPost || covered) return;
        const handleKeyDown = (e: globalThis.KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (lightboxState?.isOpen) return;
                e.preventDefault();
                e.stopPropagation();
                setPreviewPost(null);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [previewPost, lightboxState?.isOpen, covered]);

    useEffect(() => {
        return onBlocklistUpdated(() => {
            setBlocklistVersion(v => v + 1);
        });
    }, []);

    const blockedSet = useMemo(() => new Set(getBlockedUsers()), [blocklistVersion]);

    useEffect(() => {
        if (previewPost && (blockedSet.has(previewPost.authorPublicKey) || inactiveEnterpriseKeys.has(previewPost.authorPublicKey))) {
            setPreviewPost(null);
        }
    }, [previewPost, blockedSet, inactiveEnterpriseKeys]);

    const [useModernMarkers, setUseModernMarkers] = useState(() => {
        return localStorage.getItem('beanpool_modern_markers') !== 'false';
    });
    // Contribution-first gate: until the member has listed an Offer they can't post
    // Needs. Default the form to Offer and warn if they switch to Need while blocked.
    const [blockedFromTrading, setBlockedFromTrading] = useState(false);
    // A guest has no balance on the node, so it is only asked once App knows the viewer is a member.
    const canLoadBalance = isMember !== false && isMember !== null;

    useEffect(() => {
        if (!canLoadBalance) return;
        let cancelled = false;
        getBalance(identity.publicKey)
            .then(b => {
                if (cancelled) return;
                const blocked = !!b.isBlockedFromTrading;
                setBlockedFromTrading(blocked);
                setKeeperOf(Array.isArray(b.keeperOf) ? b.keeperOf : []);
                if (blocked) setNewPostType('offer');
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [identity.publicKey, canLoadBalance]);

    const needBlocked = blockedFromTrading && newPostType === 'need';

    // Names for the "Post as" choices, fetched only when a keeper opens the event form.
    useEffect(() => {
        if (newPostType !== 'event' || keeperOf.length === 0 || Object.keys(keeperNames).length > 0) return;
        let cancelled = false;
        getTreasuries()
            .then(res => {
                if (cancelled) return;
                const names: Record<string, string> = {};
                for (const t of res?.treasuries || []) if (keeperOf.includes(t.publicKey)) names[t.publicKey] = t.name;
                setKeeperNames(names);
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [newPostType, keeperOf, keeperNames]);
    const convenorGroups = userGroups.filter(g => g.viewerRole === 'convenor');

    // #143 step 4 — which communities a listing could be aimed at. Fetched once; failure is silent and
    // leaves the list empty, which hides the reach chooser. That is the right failure: a member should not be
    // shown a partner they might not have, and 'local' is what they get, which is the safe answer anyway.
    useEffect(() => {
        let cancelled = false;
        getReachablePeers()
            .then(r => { if (!cancelled) setReachablePeerList(r.peers ?? []); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        const handleStorage = () => {
            setUseModernMarkers(localStorage.getItem('beanpool_modern_markers') !== 'false');
        };
        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, []);

    // Listing requires a name + photo — checked up front (here and at the FAB) so
    // nobody fills in a whole post first. Incomplete → a prompt that opens the wizard.
    const tryOpenComposer = useCallback(async () => {
        const status = await getProfileStatus(identity);
        if (!status.complete) {
            setProfileGateMsg(`Your community likes to know who they're dealing with, so you need ${describeMissing(status)} before you can post. It only takes a moment.`);
            return;
        }
        setShowNewPost(true);
    }, [identity]);

    // Fetch user groups for audience scoping (Item 10)
    useEffect(() => {
        if (identity?.publicKey) {
            getGroups().then(groups => {
                const active = groups.filter(g => g.viewerStatus === 'active');
                setUserGroups(active);
                if (initialGroupId && active.some(g => g.id === initialGroupId)) {
                    setAudienceScope('group');
                    setTargetGroupId(initialGroupId);
                }
            }).catch(console.error);
        }
    }, [identity, initialGroupId]);

    // Auto-open post form when navigated from marketplace or groups
    useEffect(() => {
        if (openNewPost) {
            onOpenNewPostHandled?.();
            if (initialGroupId) {
                setAudienceScope('group');
                setTargetGroupId(initialGroupId);
            }
            tryOpenComposer();
        }
    }, [openNewPost, initialGroupId, onOpenNewPostHandled, tryOpenComposer]);

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

    function locateOnce(
        map: L.Map,
        setView: boolean,
        onFound: (latlng: L.LatLng) => void,
        onError: () => void
    ) {
        const onLocationFound = (e: L.LocationEvent) => {
            cleanup();
            onFound(e.latlng);
        };
        const onLocationError = () => {
            cleanup();
            onError();
        };
        function cleanup() {
            map.off('locationfound', onLocationFound);
            map.off('locationerror', onLocationError);
        }

        map.on('locationfound', onLocationFound);
        map.on('locationerror', onLocationError);
        map.locate({ setView, maxZoom: 16 });
    }

    function handleLocate() {
        if (!mapRef.current) return;
        setLocating(true);
        const map = mapRef.current;
        locateOnce(
            map,
            true,
            (latlng) => {
                setUserMarker(map, latlng);
                setUserLocation({ lat: latlng.lat, lng: latlng.lng });
                setLocating(false);
            },
            () => {
                setLocating(false);
            }
        );
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

    const lastRefreshTimeRef = useRef<number>(0);
    const refreshPromiseRef = useRef<Promise<void> | null>(null);

    // Load marketplace posts (home + enabled peers from localStorage)
    const refreshPosts = useCallback(async () => {
        if (refreshPromiseRef.current) return refreshPromiseRef.current;
        const p = (async () => {
            try {
                getEnterpriseStatuses().then(res => {
                    const inactiveKeys = new Set(
                        (res?.enterprises || [])
                            .filter((t: any) => t.paused || t.status === 'winding_up' || t.status === 'completed')
                            .map((t: any) => t.publicKey)
                    );
                    setInactiveEnterpriseKeys(inactiveKeys);
                }).catch(() => {
                    getTreasuries().then(res => {
                        const inactiveKeys = new Set(
                            (res?.treasuries || [])
                                .filter((t: any) => t.paused || t.status === 'winding_up' || t.status === 'completed')
                                .map((t: any) => t.publicKey)
                        );
                        setInactiveEnterpriseKeys(inactiveKeys);
                    }).catch(() => {});
                });
                const [pinsRes, localData] = await Promise.all([
                    getEnterpriseMapPins().catch(() => ({ enterprises: [] })),
                    // Events are opt-in on the node (docs/events-on-the-map.md §2.6); this page pins them.
                    getMarketplacePosts({ types: CLIENT_POST_TYPES }),
                ]);
                setEnterprises(pinsRes?.enterprises || []);
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
                                // Events are this community only in v1 (§2.4).
                                return remotePosts.filter((p: any) => p.type !== 'event').map((p: any) => ({ ...p, _remoteNode: n.publicUrl, _remoteCallsign: n.callsign }));
                            })
                        );
                        for (const result of remoteResults) {
                            if (result.status === 'fulfilled') allPosts = allPosts.concat(result.value);
                        }
                    }
                }
                setPosts(allPosts);
                // Stamped on SUCCESS only. In `finally` a FAILED refresh counted as a refresh,
                // so the cooldown then suppressed the retry — a blip could leave the view stale
                // until the 300s backstop, which is exactly the window this stage widened.
                lastRefreshTimeRef.current = Date.now();
            } finally {
                refreshPromiseRef.current = null;
            }
        })();
        refreshPromiseRef.current = p;
        return p;
    }, []);

    useEffect(() => {
        let interval: ReturnType<typeof setInterval> | null = null;

        const startPolling = () => {
            if (!interval) {
                refreshPosts().catch(() => {});
                interval = setInterval(() => {
                    refreshPosts().catch(() => {});
                }, withJitter(300_000));
            }
        };

        const stopPolling = () => {
            if (interval) {
                clearInterval(interval);
                interval = null;
            }
        };

        const handleVisibilityChange = () => {
            if (document.hidden) {
                stopPolling();
            } else {
                startPolling();
            }
        };

        if (!document.hidden) {
            startPolling();
        }

        document.addEventListener('visibilitychange', handleVisibilityChange);

        // Fast path: WebSocket broadcasts trigger coordinated sync.
        // Returns the in-flight or fresh promise to coordinator so delta cursor advances only on success.
        // Coalesces with visibilitychange / reconnect sync if already in-flight or refreshed within 2000ms.
        const unsubscribe = onSyncActivity(() => {
            if (document.hidden) return;
            if (refreshPromiseRef.current) return refreshPromiseRef.current;
            if (Date.now() - lastRefreshTimeRef.current < 2000) return;
            return refreshPosts();
        });

        return () => {
            stopPolling();
            document.removeEventListener('visibilitychange', handleVisibilityChange);
            unsubscribe();
        };
    }, [refreshPosts]);

    // Create a new post from the map
    function resetEventForm() {
        setEventStart('');
        setEventEnd('');
        setEventPlaceName('');
        setEventNote('');
        setEventHost('me');
        setPostApproximate(false);
        setEventIsCopy(false);
    }

    async function handleCreateEvent() {
        const errors = new Set<string>();
        const startIso = localInputToIso(eventStart);
        const endIso = localInputToIso(eventEnd);
        if (!newPostTitle.trim()) errors.add('title');
        if (!startIso || Date.parse(startIso) <= Date.now()) errors.add('event_start');
        if (eventEnd && (!endIso || !startIso || Date.parse(endIso) <= Date.parse(startIso))) errors.add('event_end');
        if (postLat == null || postLng == null) errors.add('location');
        if (eventPlaceName.trim().length > EVENT_PLACE_NAME_MAX) errors.add('event_place');
        if (eventNote.trim().length > EVENT_PRIVATE_NOTE_MAX) errors.add('event_note');
        setValidationErrors(errors);
        if (errors.size > 0) return;

        const hostEnterprise = eventHost.startsWith('ent:') ? eventHost.slice(4) : null;
        setPosting(true);
        try {
            const res = await createMarketplacePost({
                type: 'event',
                category: 'community',
                title: newPostTitle.trim(),
                description: newPostDescription.trim(),
                credits: 0,
                priceType: 'fixed',
                authorPublicKey: hostEnterprise || identity.publicKey || '',
                repeatable: false,
                lat: postLat!,
                lng: postLng!,
                ...(newPostPhotos.length > 0 ? { photos: newPostPhotos } : {}),
                audienceScope,
                ...(audienceScope === 'group' && targetGroupId ? { targetGroupId } : {}),
                eventStartAt: startIso!,
                ...(endIso ? { eventEndAt: endIso } : {}),
                ...(eventPlaceName.trim() ? { eventPlaceName: eventPlaceName.trim() } : {}),
                ...(eventNote.trim() ? { eventPrivateNote: eventNote.trim() } : {}),
            });
            setNewPostTitle('');
            setNewPostDescription('');
            setNewPostPhotos([]);
            resetEventForm();
            setAudienceScope('public');
            setTargetGroupId('');
            setPostLat(null);
            setPostLng(null);
            setPinDropMode(false);
            if (pinDropMarkerRef.current) {
                pinDropMarkerRef.current.remove();
                pinDropMarkerRef.current = null;
            }
            setShowNewPost(false);
            refreshPosts();
            if (onNavigate) onNavigate('marketplace', res?.post?.id);
        } catch (e: any) {
            alert(e.message || 'Failed to create the event.');
        }
        setPosting(false);
    }

    async function handleCreatePost() {
        if (newPostType === 'event') {
            await handleCreateEvent();
            return;
        }
        if (newPostType === 'poll') {
            const errors = new Set<string>();
            if (!newPostTitle.trim()) errors.add('title');
            const cleanOptions = pollOptions.map(o => o.trim());
            if (cleanOptions.some(o => !o)) {
                errors.add('options_empty');
            }
            const validOptions = cleanOptions.filter(Boolean);
            const uniqueOptions = new Set(validOptions.map(o => o.toLowerCase()));
            if (uniqueOptions.size !== validOptions.length) {
                errors.add('options_duplicate');
            }
            if (validOptions.length < 2 || validOptions.length > 4) errors.add('options');
            setValidationErrors(errors);
            if (errors.size > 0) return;

            setPosting(true);
            try {
                await createMarketplacePost({
                    type: 'poll',
                    category: 'community',
                    title: newPostTitle.trim(),
                    description: newPostDescription.trim(),
                    credits: 0,
                    priceType: 'fixed',
                    authorPublicKey: identity.publicKey || '',
                    repeatable: false,
                    pollOptions: validOptions.map((text, idx) => ({ id: `opt_${idx + 1}`, text })),
                    durationDays: pollDurationDays,
                    audienceScope,
                    ...(audienceScope === 'group' && targetGroupId ? { targetGroupId } : {}),
                });
                setNewPostTitle('');
                setNewPostDescription('');
                setPollOptions(['', '']);
                setPollDurationDays(7);
                setAudienceScope('public');
                setTargetGroupId('');
                setShowNewPost(false);
                refreshPosts();
                if (onNavigate) onNavigate('marketplace');
            } catch (e: any) {
                alert(e.message || 'Failed to create poll.');
            }
            setPosting(false);
            return;
        }

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
                cashAlsoNeeded: newPostCashAlsoNeeded,
                reach: audienceScope === 'group' ? 'local' : newPostReach,
                ...(audienceScope !== 'group' && newPostReach === 'peers' ? { reachPeers: newPostReachPeers } : {}),
                ...(postLat != null && postLng != null ? { lat: postLat, lng: postLng } : {}),
                ...(newPostPhotos.length > 0 ? { photos: newPostPhotos } : {}),
                audienceScope,
                ...(audienceScope === 'group' && targetGroupId ? { targetGroupId } : {}),
            });
            setNewPostTitle('');
            setNewPostDescription('');
            setNewPostCredits('');
            setNewPostPriceType('fixed');
            setNewPostRepeatable(false);
            setNewPostCashAlsoNeeded(false);
            setNewPostReach('local');
            setNewPostReachPeers([]);
            setNewPostPhotos([]);
            setAudienceScope('public');
            setTargetGroupId('');
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
        locateOnce(
            mapRef.current,
            false,
            (latlng) => {
                setPostLat(Math.round(latlng.lat * 10000) / 10000);
                setPostLng(Math.round(latlng.lng * 10000) / 10000);
                setPostApproximate(false);
                setPinDropMode(false);
                placePreviewPin(latlng.lat, latlng.lng);
            },
            () => {
                setPinDropMode(true);
            }
        );
    }

    // Enter pin-drop mode — tap map to place location
    function enterPinDrop() {
        setPinDropMode(true);
        setPostLat(null);
        setPostLng(null);
        setPostApproximate(false);
        if (pinDropMarkerRef.current) {
            pinDropMarkerRef.current.remove();
            pinDropMarkerRef.current = null;
        }
    }

    // One tap rounds the pin to roughly 100 m before it is sent, as for enterprise pins (§2.3).
    function approximatePin() {
        if (postLat == null || postLng == null) return;
        const approx = approximateLocation(postLat, postLng);
        setPostLat(approx.lat);
        setPostLng(approx.lng);
        setPostApproximate(true);
        placePreviewPin(approx.lat, approx.lng);
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
            setPostApproximate(false);
            placePreviewPin(lat, lng);
        }
        map.on('click', onMapClick);
        return () => { map.off('click', onMapClick); };
    }, [pinDropMode]);

    // Render marketplace post pins on the map
    useEffect(() => {
        if (!markersRef.current || !mapRef.current) return;
        markersRef.current.clearLayers();

        posts
            .filter(post => post.type !== 'poll' && post.type !== 'event' && (!post.status || post.status === 'active') && !blockedSet.has(post.authorPublicKey) && !inactiveEnterpriseKeys.has(post.authorPublicKey))
            .forEach((post) => {
            const cat = MARKETPLACE_CATEGORIES_BY_ID.get(post.category);
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

        // Event pins (docs/events-on-the-map.md §3): purple with a calendar glyph, filtered by the chips.
        // Cancelled and ended events never pin.
        posts
            .filter(post => post.type === 'event' && post.lat != null && post.lng != null
                && eventInWindow(post, eventWindow)
                && !(post as any)._remoteNode
                && !blockedSet.has(post.authorPublicKey) && !inactiveEnterpriseKeys.has(post.authorPublicKey))
            .forEach(post => {
                const html = `
                <div style="position: relative; width: 40px; height: 48px; display: flex; flex-direction: column; align-items: center; filter: drop-shadow(0 3px 4px rgba(0, 0, 0, 0.2));">
                    <div style="
                        width: 40px; height: 40px; border-radius: 50%;
                        background: ${POST_TYPE_COLORS.event}; border: 2.5px solid #ffffff;
                        display: flex; align-items: center; justify-content: center;
                        box-sizing: border-box; z-index: 2; position: relative;
                    ">
                        <span style="font-size: 20px; line-height: 1; padding-bottom: 1px;">📅</span>
                    </div>
                    <div style="
                        position: absolute; bottom: 0; width: 0; height: 0;
                        border-left: 6px solid transparent;
                        border-right: 6px solid transparent;
                        border-top: 10px solid ${POST_TYPE_COLORS.event};
                        z-index: 1;
                    "></div>
                </div>`;
                const icon = L.divIcon({
                    className: 'custom-event-pin hover:scale-110 transition-transform origin-bottom',
                    html,
                    iconSize: [40, 48],
                    iconAnchor: [20, 48],
                });
                const label = `Event: ${post.title}`;
                const marker = L.marker([post.lat!, post.lng!], { icon, title: label, alt: label });
                marker.on('click', () => {
                    setPreviewPost(post);
                    if (mapRef.current) {
                        mapRef.current.setView([post.lat!, post.lng!], mapRef.current.getZoom(), { animate: true });
                    }
                });
                marker.addTo(markersRef.current!);
            });

        // Render enterprise pins (docs/the-commons.md §2.2, Slice 6)
        const escapeHtml = (str: string) =>
            str.replace(/[&<>"']/g, (m) => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;',
            }[m] || m));

        enterprises
            .filter(ent => ent.lat != null && ent.lng != null && ent.status !== 'completed')
            .forEach(ent => {
                const isPaused = ent.paused || ent.status === 'paused';
                const borderColor = isPaused ? '#f59e0b' : '#e06d53';
                const bgColor = isPaused ? '#451a03' : '#7c2d12';
                const shadowColor = isPaused ? 'rgba(245,158,11,0.5)' : 'rgba(224,109,83,0.5)';

                // Sanitize name and avatar for Leaflet HTML
                const safeName = escapeHtml(ent.name || '');

                // Avatar or fallback icon
                let avatarContent = `<span style="font-size: 20px; line-height: 1;">🌾</span>`;
                if (ent.avatar) {
                    if (ent.avatar.startsWith('bundled://') || (ent.avatar.startsWith('data:image/') && !ent.avatar.includes('"')) || ent.avatar.startsWith('/')) {
                        avatarContent = `<img src="${escapeHtml(ent.avatar)}" alt="${safeName}" style="width: 28px; height: 28px; border-radius: 8px; object-fit: cover;" />`;
                    } else if (ent.avatar.length <= 4) {
                        avatarContent = `<span style="font-size: 20px; line-height: 1;">${escapeHtml(ent.avatar)}</span>`;
                    }
                }

                const pausedBadge = isPaused
                    ? `<span style="
                        position: absolute; top: -8px; left: 50%; transform: translateX(-50%);
                        background: #b45309; color: #fef3c7; font-size: 8px; font-weight: 900;
                        padding: 1px 5px; border-radius: 4px; text-transform: uppercase;
                        letter-spacing: 0.5px; border: 1px solid #f59e0b; white-space: nowrap;
                        box-shadow: 0 1px 3px rgba(0,0,0,0.4); z-index: 3;
                    ">PAUSED</span>`
                    : '';

                const html = `
                <div style="position: relative; width: 44px; height: 54px; display: flex; flex-direction: column; align-items: center; filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.25)); cursor: pointer;" title="${safeName}${isPaused ? ' (Paused)' : ''}">
                    ${pausedBadge}
                    <div style="
                        width: 42px; height: 42px; border-radius: 12px;
                        background: ${bgColor}; border: 2.5px solid ${borderColor};
                        display: flex; flex-direction: column; align-items: center; justify-content: center;
                        box-sizing: border-box; z-index: 2; position: relative;
                        box-shadow: 0 0 8px ${shadowColor};
                    ">
                        ${avatarContent}
                    </div>
                    <div style="
                        width: 0; height: 0;
                        border-left: 7px solid transparent;
                        border-right: 7px solid transparent;
                        border-top: 10px solid ${borderColor};
                        margin-top: -2px; z-index: 1; position: relative;
                    "></div>
                </div>`;

                const icon = L.divIcon({
                    className: 'custom-enterprise-pin hover:scale-110 transition-transform origin-bottom',
                    html,
                    iconSize: [44, 54],
                    iconAnchor: [22, 54],
                });

                const markerLabel = `${ent.name}${isPaused ? ' (Paused Enterprise)' : ' (Enterprise)'}`;
                const marker = L.marker([ent.lat, ent.lng], {
                    icon,
                    title: markerLabel,
                    alt: markerLabel,
                });
                marker.on('click', () => {
                    if (onOpenTreasury) {
                        onOpenTreasury(ent.publicKey);
                    } else if (onNavigate) {
                        onNavigate('enterprise', ent.publicKey);
                    }
                });
                marker.addTo(markersRef.current!);
            });
    }, [posts, enterprises, useModernMarkers, blockedSet, inactiveEnterpriseKeys, onOpenTreasury, onNavigate, eventWindow]);

    // "Copy to a new date": fetch the event signed and fill the form from it. Fetched rather than taken from
    // `posts`, because the copy is most useful once the event has already run — and an event that has ended is
    // out of the feed list, readable only by id, and only to its host and the people who were going (§2.2).
    // Everything carries over except the two dates and the photo (see buildEventCopy).
    // Each id is handled once, by a ref rather than by clearing the prop first: clearing it up front would
    // change this effect's deps and cancel the fetch it had only just started. The parent is told when the
    // form is filled, not when the tap arrived.
    const handledCopyId = useRef<string | null>(null);
    useEffect(() => {
        if (!copyEventPostId || handledCopyId.current === copyEventPostId) return;
        const id = copyEventPostId;
        handledCopyId.current = id;
        (async () => {
            let source: MarketplacePost | undefined;
            try {
                source = (await getMarketplacePosts({ id, types: CLIENT_POST_TYPES }))[0];
            } catch {
                source = posts.find(p => p.id === id);
            }
            onCopyEventHandled?.();
            if (!source || source.type !== 'event') {
                alert('That event could not be loaded, so there is nothing to copy.');
                return;
            }
            const copy = buildEventCopy(source, identity?.publicKey);
            setNewPostType('event');
            setNewPostTitle(copy.title);
            setNewPostDescription(copy.description);
            setNewPostPhotos([]);
            setEventStart('');
            setEventEnd('');
            setEventPlaceName(copy.placeName);
            setEventNote(copy.privateNote);
            setEventHost(copy.enterprisePubkey ? `ent:${copy.enterprisePubkey}` : copy.groupId ? `group:${copy.groupId}` : 'me');
            setAudienceScope(copy.groupId ? 'group' : 'public');
            setTargetGroupId(copy.groupId ?? '');
            setPostLat(copy.lat);
            setPostLng(copy.lng);
            setPostApproximate(false);
            setPinDropMode(false);
            setValidationErrors(new Set());
            setEventIsCopy(true);
            if (copy.lat != null && copy.lng != null) {
                placePreviewPin(copy.lat, copy.lng);
                mapRef.current?.setView([copy.lat, copy.lng], Math.max(mapRef.current.getZoom?.() ?? DEFAULT_ZOOM, 15));
            }
            setShowNewPost(true);
        })();
        // `posts` is only a fallback for an offline fetch; re-running on every poll would reopen the form.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [copyEventPostId, identity?.publicKey, onCopyEventHandled]);

    // "Show on map" from an event's detail: centre on it and open its card once it has loaded.
    useEffect(() => {
        if (!focusPostId) return;
        const target = posts.find(p => p.id === focusPostId);
        if (!target) return;
        if (target.lat != null && target.lng != null && mapRef.current) {
            mapRef.current.setView([target.lat, target.lng], Math.max(mapRef.current.getZoom?.() ?? DEFAULT_ZOOM, 16));
        }
        setEventWindow('all');
        setPreviewPost(target);
        onFocusPostHandled?.();
    }, [focusPostId, posts, onFocusPostHandled]);

    const hasOpenEvents = posts.some(p => p.type === 'event' && isEventOpen(p) && !(p as any)._remoteNode);

    // Shared by the offer/need and event forms.
    function renderLocationPicker() {
        return (
            <>
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
            </>
        );
    }

    function renderPhotoPicker(required: boolean) {
        return (
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
                <p className={`text-xs font-semibold mt-2 uppercase tracking-wide ${required && validationErrors.has('photos') && newPostPhotos.length === 0 ? 'text-red-500' : 'text-nature-400'}`}>
                    {newPostPhotos.length}/5 photos {newPostPhotos.length === 0 ? (required ? '(at least 1 required)' : '(optional)') : ''}
                </p>
            </div>
        );
    }

    const submitDisabled = newPostType === 'event'
        ? (posting || !newPostTitle.trim() || !eventStart || postLat == null)
        : newPostType === 'poll'
            ? (posting || !newPostTitle.trim() || pollOptions.filter(o => o.trim()).length < 2)
            : (needBlocked || posting || !newPostTitle.trim() || !newPostDescription.trim() || newPostCredits === '' || postLat == null || newPostPhotos.length === 0);


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

            {/* Event chips (docs/events-on-the-map.md §3). They filter event pins only, by start time. One row
                that scrolls sideways rather than wraps, so it holds at 320px with large text, and only as wide as its chips so the rest of the map still pans. Shown once this
                community has an upcoming event. */}
            {/* Hidden while composing: at 320px the New Post panel leaves only a strip of map to drop a pin in. */}
            {hasOpenEvents && !showNewPost && (
                <div
                    data-testid="event-window-chips"
                    role="group"
                    aria-label="Show events"
                    className="absolute top-[4.25rem] md:top-3 left-0 z-[100] w-fit max-w-full px-3 py-1 flex flex-nowrap gap-2 overflow-x-auto overscroll-x-contain"
                    style={{ scrollbarWidth: 'none' }}
                >
                    {EVENT_WINDOWS.map(w => (
                        <button
                            key={w.id}
                            type="button"
                            aria-pressed={eventWindow === w.id}
                            onClick={() => { setEventWindow(w.id); setPreviewPost(null); }}
                            className={`flex-shrink-0 whitespace-nowrap min-h-[48px] px-3.5 rounded-full border text-sm font-bold shadow-md transition-colors ${
                                eventWindow === w.id
                                    ? 'bg-violet-700 border-violet-700 text-white'
                                    : 'bg-white/95 dark:bg-nature-900/95 border-nature-200 dark:border-nature-700 text-nature-800 dark:text-oat-50'
                            }`}
                        >
                            {w.id === 'all' ? '📅 All' : w.label}
                        </button>
                    ))}
                </div>
            )}

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
                    onClick={tryOpenComposer}
                    aria-label="New Post"
                    className="fixed bottom-[calc(var(--bottom-nav-offset)+1.5rem)] md:bottom-6 right-3 w-14 h-14 rounded-full bg-terra-500 hover:bg-terra-600 text-white text-3xl font-light z-[101] shadow-[0_8px_30px_rgb(226,114,91,0.4)] flex items-center justify-center transition-transform transform hover:scale-105 border-2 border-white/20"
                    style={{ bottom: 'calc(var(--bottom-nav-offset) + 1.5rem)' }}
                    title="New Post"
                >
                    +
                </button>
            )}

            {profileGateMsg && (
                <ProfileGateModal
                    message={profileGateMsg}
                    onSetup={() => { setProfileGateMsg(null); onNavigate?.('profile-setup'); }}
                    onClose={() => setProfileGateMsg(null)}
                />
            )}
        </div>

        {/* Map Preview Card — an event shows its own card (§3) */}
        {previewPost && previewPost.type === 'event' && (
            <div data-testid="map-preview-card" className="absolute bottom-0 left-0 right-0 z-[150] flex flex-col justify-end pointer-events-none" style={{ paddingBottom: 'calc(var(--bottom-nav-offset) + 0.5rem)', ...(covered ? { display: 'none' } : {}) }}>
                <div className="m-3 pointer-events-auto relative flex flex-col gap-2 bg-white dark:bg-nature-900 rounded-[24px] p-2 shadow-[0_10px_20px_rgba(0,0,0,0.15)] border border-nature-200 dark:border-nature-800">
                    <EventCard
                        post={previewPost}
                        identity={identity}
                        distanceKm={userLocation && previewPost.lat != null && previewPost.lng != null
                            ? haversineDistance(userLocation.lat, userLocation.lng, previewPost.lat, previewPost.lng)
                            : null}
                        onOpen={() => onNavigate && onNavigate('marketplace', previewPost.id)}
                        onRsvpChange={(p) => { setPreviewPost(p); refreshPosts().catch(() => {}); }}
                    />
                    <div className="flex gap-2">
                        <button
                            type="button"
                            onClick={() => onNavigate && onNavigate('marketplace', previewPost.id)}
                            className="flex-1 min-h-[48px] rounded-xl border-none font-bold text-white text-sm bg-violet-700 hover:bg-violet-800"
                        >
                            View Details
                        </button>
                        <button
                            type="button"
                            onClick={() => setPreviewPost(null)}
                            aria-label="Close preview"
                            className="flex-shrink-0 min-h-[48px] min-w-[48px] rounded-xl bg-black/5 dark:bg-white/10 border-none text-sm font-extrabold text-gray-600 dark:text-gray-300"
                        >
                            ✕
                        </button>
                    </div>
                </div>
            </div>
        )}
        {previewPost && previewPost.type !== 'event' && (
            <div data-testid="map-preview-card" className="absolute bottom-0 left-0 right-0 z-[150] flex flex-col justify-end pointer-events-none pb-[calc(var(--bottom-nav-offset)+0.5rem)] md:pb-4" style={{ paddingBottom: 'calc(var(--bottom-nav-offset) + 0.5rem)', ...(covered ? { display: 'none' } : {}) }}>
                <div className="bg-white dark:bg-nature-900 m-4 rounded-[24px] p-4 flex flex-row shadow-[0_10px_20px_rgba(0,0,0,0.15)] pointer-events-auto relative border border-nature-200 dark:border-nature-800 transition-colors">
                    <button 
                        onClick={() => setPreviewPost(null)}
                        aria-label="Close preview"
                        className="absolute top-3 right-3 w-7 h-7 rounded-full bg-black/5 dark:bg-white/10 flex items-center justify-center border-none text-xs font-extrabold text-gray-500 dark:text-gray-400 cursor-pointer hover:bg-black/10 dark:hover:bg-white/20 transition-colors"
                    >
                        ✕
                    </button>
                    {previewPost.photos && previewPost.photos.length > 0 ? (
                        <button
                            type="button"
                            onClick={(e) =>
                                setLightboxState({
                                    isOpen: true,
                                    photos: previewPost.photos!,
                                    initialIndex: 0,
                                    title: previewPost.title,
                                    triggerElement: e.currentTarget,
                                })
                            }
                            aria-label={`View enlarged photo: ${previewPost.title}`}
                            className="w-[90px] h-[90px] rounded-2xl overflow-hidden cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-500 shrink-0"
                        >
                            <img src={previewPost.photos[0]} alt="thumb" className="w-full h-full object-cover bg-gray-100 dark:bg-nature-800" />
                        </button>
                    ) : (
                        <div className="w-[90px] h-[90px] rounded-2xl bg-gray-100 dark:bg-nature-800 flex items-center justify-center transition-colors">
                            <span className="text-4xl">{MARKETPLACE_CATEGORIES_BY_ID.get(previewPost.category)?.emoji || '📦'}</span>
                        </div>
                    )}
                    <div className="flex-1 ml-4 flex flex-col justify-center">
                        <div className="flex justify-between items-center mb-1">
                            <span className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider truncate mr-2 flex-1">
                                {MARKETPLACE_CATEGORIES_BY_ID.get(previewPost.category)?.label || previewPost.category}
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
            <div 
                data-testid="map-new-post-panel"
                className="fixed bottom-[calc(var(--bottom-nav-offset)+0.5rem)] md:bottom-4 left-3 right-3 max-h-[60vh] overflow-y-auto bg-white/95 dark:bg-nature-900/95 backdrop-blur-xl rounded-3xl p-5 z-[1000] shadow-soft border border-nature-200 dark:border-nature-800 overscroll-contain"
                style={{ bottom: 'calc(var(--bottom-nav-offset) + 0.5rem)', ...(covered ? { display: 'none' } : {}) }}
            >
                <div className="flex justify-between items-center mb-4">
                    <span className="font-bold text-lg text-nature-950 dark:text-white tracking-tight">{eventIsCopy ? 'Copy Event' : 'New Post'}</span>
                    <button onClick={() => {
                        setShowNewPost(false);
                        setPostApproximate(false);
                        setAudienceScope('public');
                        setTargetGroupId('');
                        setPinDropMode(false);
                        setPostLat(null);
                        setPostLng(null);
                        setEventIsCopy(false);
                        if (pinDropMarkerRef.current) {
                            pinDropMarkerRef.current.remove();
                            pinDropMarkerRef.current = null;
                        }
                    }} aria-label="Close new post" className="bg-transparent border-none text-nature-400 hover:text-nature-600 text-2xl cursor-pointer transition-colors leading-none w-8 h-8 flex items-center justify-center rounded-full hover:bg-nature-50">
                        ✕
                    </button>
                </div>

                {/* Type toggle */}
                <div className="grid grid-cols-2 min-[400px]:grid-cols-4 gap-2 mb-4">
                    {(['offer', 'need', 'poll', 'event'] as const).map(t => (
                        <button
                            key={t}
                            type="button"
                            aria-pressed={newPostType === t}
                            onClick={() => { setNewPostType(t); setValidationErrors(new Set()); if (t !== 'event') setEventIsCopy(false); }}
                            className={`flex-1 py-3 rounded-xl border text-[15px] font-bold capitalize transition-all shadow-sm ${
                                newPostType === t
                                    ? (t === 'offer' ? 'bg-blue-600 border-blue-600 text-white shadow-md scale-[1.02]' : t === 'need' ? 'bg-orange-600 border-orange-600 text-white shadow-md scale-[1.02]' : t === 'event' ? 'bg-violet-700 border-violet-700 text-white shadow-md scale-[1.02]' : 'bg-purple-600 border-purple-600 text-white shadow-md scale-[1.02]')
                                    : 'bg-white dark:bg-nature-800 border-nature-200 dark:border-nature-700 text-nature-500 dark:text-nature-300 hover:bg-oat-50 dark:hover:bg-nature-700'
                            }`}
                        >
                            {t === 'offer' ? '🔵 Offer' : t === 'need' ? '🟠 Need' : t === 'event' ? '📅 Event' : '🗳️ Poll'}
                        </button>
                    ))}
                </div>

                {/* Audience Scope Selector — scope must be unmistakable before posting (Item 10) */}
                <div className="mb-4">
                    <label className="block text-xs font-bold text-nature-600 dark:text-nature-300 uppercase tracking-wider mb-1.5">
                        Audience Scope
                    </label>
                    <div className="flex gap-2 mb-2">
                        <button
                            type="button"
                            aria-pressed={audienceScope === 'public'}
                            onClick={() => { setAudienceScope('public'); setTargetGroupId(''); if (eventHost.startsWith('group:')) setEventHost('me'); }}
                            className={`flex-1 py-2 px-3 rounded-xl border text-xs font-bold transition-all ${
                                audienceScope === 'public'
                                    ? 'bg-nature-850 dark:bg-white text-white dark:text-nature-950 border-nature-900 shadow-sm'
                                    : 'bg-white dark:bg-nature-800 border-nature-200 dark:border-nature-700 text-nature-600 dark:text-nature-300 hover:bg-oat-50'
                            }`}
                        >
                            🌍 Everyone (Public)
                        </button>
                        {userGroups.length > 0 && (
                            <button
                                type="button"
                                aria-pressed={audienceScope === 'group'}
                                onClick={() => {
                                    setAudienceScope('group');
                                    if (!targetGroupId && userGroups[0]) {
                                        setTargetGroupId(userGroups[0].id);
                                    }
                                }}
                                className={`flex-1 py-2 px-3 rounded-xl border text-xs font-bold transition-all ${
                                    audienceScope === 'group'
                                        ? 'bg-emerald-600 border-emerald-600 text-white shadow-sm'
                                        : 'bg-white dark:bg-nature-800 border-nature-200 dark:border-nature-700 text-nature-600 dark:text-nature-300 hover:bg-oat-50'
                                }`}
                            >
                                👥 Group ({userGroups.length})
                            </button>
                        )}
                    </div>

                    {audienceScope === 'group' && userGroups.length > 0 && (
                        <div className="mb-2">
                            <select
                                value={targetGroupId}
                                onChange={(e) => setTargetGroupId(e.target.value)}
                                className="w-full py-2 px-3 rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-xs font-bold focus:outline-none focus:ring-2 focus:ring-emerald-400"
                            >
                                {userGroups.map((g) => (
                                    <option key={g.id} value={g.id}>
                                        {g.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}

                    {/* Unmistakable Scope Notice */}
                    {audienceScope === 'public' ? (
                        <div className="p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800/60 rounded-xl text-xs text-blue-900 dark:text-blue-200">
                            <p className="font-bold flex items-center gap-1.5 mb-0.5">
                                <span>🌍</span>
                                <span>Public — visible to everyone on BeanPool</span>
                            </p>
                            <p className="m-0 leading-relaxed text-[11px] opacity-90">
                                Anyone in the community can discover and respond to this listing.
                            </p>
                        </div>
                    ) : (
                        <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 border-2 border-emerald-500 rounded-xl text-xs text-emerald-950 dark:text-emerald-200">
                            <p className="font-black text-sm flex items-center gap-1.5 mb-1 text-emerald-800 dark:text-emerald-300">
                                <span>🔒</span>
                                <span>Only {userGroups.find(g => g.id === targetGroupId)?.name || 'Group'} can see this</span>
                            </p>
                            <p className="m-0 leading-relaxed text-[11px]">
                                This post will be visible <strong>only to active members of {userGroups.find(g => g.id === targetGroupId)?.name || 'this group'}</strong>. It will not appear in the public marketplace feed or on the public map.
                            </p>
                        </div>
                    )}
                </div>

                {newPostType === 'event' ? (
                    <div className="space-y-4 mb-4">
                        {eventIsCopy && (
                            <p data-testid="event-copy-hint" className="m-0 p-3 rounded-xl bg-violet-50 dark:bg-violet-950/40 border border-violet-200 dark:border-violet-800 text-sm text-nature-800 dark:text-nature-200">
                                Copied from your last one. Pick the new date and time. The photo is not copied — add one again if you want.
                            </p>
                        )}
                        {(keeperOf.length > 0 || convenorGroups.length > 0) && (
                            <div>
                                <label htmlFor="event-host" className="block text-xs font-bold text-nature-600 dark:text-nature-300 uppercase tracking-wider mb-1">Post as</label>
                                <select
                                    id="event-host"
                                    value={eventHost}
                                    onChange={e => {
                                        const v = e.target.value;
                                        setEventHost(v);
                                        if (v.startsWith('group:')) {
                                            setAudienceScope('group');
                                            setTargetGroupId(v.slice(6));
                                        }
                                    }}
                                    className="w-full py-3 px-4 rounded-xl border bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[15px] focus:outline-none focus:ring-2 focus:ring-violet-300 shadow-sm transition-all border-nature-200 dark:border-nature-700 appearance-auto cursor-pointer"
                                >
                                    <option value="me">Me</option>
                                    {keeperOf.map(pk => (
                                        <option key={pk} value={`ent:${pk}`}>{keeperNames[pk] || `Enterprise ${pk.slice(0, 6)}`}</option>
                                    ))}
                                    {convenorGroups.map(g => (
                                        <option key={g.id} value={`group:${g.id}`}>{g.name}</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        <div>
                            <label htmlFor="event-title" className="block text-xs font-bold text-nature-600 dark:text-nature-300 uppercase tracking-wider mb-1">What's happening</label>
                            <input
                                id="event-title"
                                placeholder="Working bee at the hall"
                                value={newPostTitle}
                                onChange={e => { setNewPostTitle(e.target.value); setValidationErrors(prev => { const n = new Set(prev); n.delete('title'); return n; }); }}
                                className={`w-full py-3 px-4 rounded-xl border bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[15px] focus:outline-none focus:ring-2 focus:ring-violet-300 shadow-sm transition-all ${validationErrors.has('title') ? 'border-red-400 bg-red-50 ring-1 ring-red-400' : 'border-nature-200 dark:border-nature-700'}`}
                            />
                        </div>

                        <div>
                            <label htmlFor="event-start" className="block text-xs font-bold text-nature-600 dark:text-nature-300 uppercase tracking-wider mb-1">Starts</label>
                            <input
                                id="event-start"
                                type="datetime-local"
                                value={eventStart}
                                onChange={e => { setEventStart(e.target.value); setValidationErrors(prev => { const n = new Set(prev); n.delete('event_start'); return n; }); }}
                                className={`w-full py-3 px-4 rounded-xl border bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[15px] focus:outline-none focus:ring-2 focus:ring-violet-300 shadow-sm transition-all min-w-0 ${validationErrors.has('event_start') ? 'border-red-400 bg-red-50 ring-1 ring-red-400' : 'border-nature-200 dark:border-nature-700'}`}
                            />
                            {validationErrors.has('event_start') && (
                                <p className="m-0 mt-1 text-xs font-semibold text-red-600">Pick a start time in the future.</p>
                            )}
                        </div>

                        <div>
                            <label htmlFor="event-end" className="block text-xs font-bold text-nature-600 dark:text-nature-300 uppercase tracking-wider mb-1">Ends (optional, 2 hours after start if blank)</label>
                            <input
                                id="event-end"
                                type="datetime-local"
                                value={eventEnd}
                                onChange={e => { setEventEnd(e.target.value); setValidationErrors(prev => { const n = new Set(prev); n.delete('event_end'); return n; }); }}
                                className={`w-full py-3 px-4 rounded-xl border bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[15px] focus:outline-none focus:ring-2 focus:ring-violet-300 shadow-sm transition-all min-w-0 ${validationErrors.has('event_end') ? 'border-red-400 bg-red-50 ring-1 ring-red-400' : 'border-nature-200 dark:border-nature-700'}`}
                            />
                            {validationErrors.has('event_end') && (
                                <p className="m-0 mt-1 text-xs font-semibold text-red-600">The end must be after the start.</p>
                            )}
                        </div>

                        <div>
                            <label htmlFor="event-place" className="block text-xs font-bold text-nature-600 dark:text-nature-300 uppercase tracking-wider mb-1">Place name</label>
                            <input
                                id="event-place"
                                placeholder="The old bowls club"
                                maxLength={EVENT_PLACE_NAME_MAX}
                                value={eventPlaceName}
                                onChange={e => { setEventPlaceName(e.target.value); setValidationErrors(prev => { const n = new Set(prev); n.delete('event_place'); return n; }); }}
                                className={`w-full py-3 px-4 rounded-xl border bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[15px] focus:outline-none focus:ring-2 focus:ring-violet-300 shadow-sm transition-all ${validationErrors.has('event_place') ? 'border-red-400 bg-red-50 ring-1 ring-red-400' : 'border-nature-200 dark:border-nature-700'}`}
                            />
                        </div>

                        <div>
                            {renderLocationPicker()}
                            {/* The pin is public like every post and enterprise pin; Approximate is one tap away with the
                                same plain warning enterprise pins carry (§1, §2.3). Exact details go in the note. */}
                            <div
                                data-testid="event-location-visibility"
                                className="p-2.5 rounded-lg bg-terra-50 dark:bg-terra-950/40 border border-terra-200 dark:border-terra-800/60 text-xs text-terra-800 dark:text-terra-200 space-y-1.5"
                            >
                                <p className="font-semibold text-terra-900 dark:text-terra-100 m-0">
                                    Anyone who opens this node&apos;s map will see this spot.
                                </p>
                                <p className="text-[12px] text-nature-700 dark:text-nature-300 m-0">
                                    If it&apos;s at someone&apos;s house, use <strong>Approximate</strong> to round the location to roughly 100&nbsp;m, and put the exact spot in the note for people who are going.
                                </p>
                                <div className="flex items-center gap-2 flex-wrap">
                                    <button
                                        type="button"
                                        onClick={approximatePin}
                                        disabled={postLat == null || postLng == null}
                                        aria-pressed={postApproximate}
                                        className="min-h-[48px] px-3 py-1 rounded-md bg-terra-100 dark:bg-terra-900/40 hover:bg-terra-200 dark:hover:bg-terra-900/70 disabled:opacity-40 disabled:pointer-events-none text-sm font-semibold text-terra-700 dark:text-terra-300 border border-terra-300 dark:border-terra-700/60 transition-colors"
                                    >
                                        Approximate (~100m)
                                    </button>
                                    {postApproximate && (
                                        <span className="px-1.5 py-0.5 rounded bg-terra-100 dark:bg-terra-900/60 text-terra-700 dark:text-terra-300 text-[11px] font-semibold border border-terra-300 dark:border-terra-700/50">
                                            ~100m
                                        </span>
                                    )}
                                </div>
                            </div>
                        </div>

                        <div>
                            <label htmlFor="event-description" className="block text-xs font-bold text-nature-600 dark:text-nature-300 uppercase tracking-wider mb-1">Description (optional)</label>
                            <textarea
                                id="event-description"
                                placeholder="What to expect, who it's for…"
                                value={newPostDescription}
                                onChange={e => setNewPostDescription(e.target.value)}
                                rows={3}
                                className="w-full py-3 px-4 rounded-xl border bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[15px] focus:outline-none focus:ring-2 focus:ring-violet-300 shadow-sm transition-all border-nature-200 dark:border-nature-700 resize-y"
                            />
                        </div>

                        {renderPhotoPicker(false)}

                        <div>
                            <label htmlFor="event-note" className="block text-xs font-bold text-nature-600 dark:text-nature-300 uppercase tracking-wider mb-1">Note for people who are going</label>
                            <textarea
                                id="event-note"
                                placeholder="Gate code, parking, what to bring"
                                maxLength={EVENT_PRIVATE_NOTE_MAX}
                                value={eventNote}
                                onChange={e => { setEventNote(e.target.value); setValidationErrors(prev => { const n = new Set(prev); n.delete('event_note'); return n; }); }}
                                rows={2}
                                className={`w-full py-3 px-4 rounded-xl border bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[15px] focus:outline-none focus:ring-2 focus:ring-violet-300 shadow-sm transition-all resize-y ${validationErrors.has('event_note') ? 'border-red-400 bg-red-50 ring-1 ring-red-400' : 'border-nature-200 dark:border-nature-700'}`}
                            />
                            <p className="m-0 mt-1 text-xs text-nature-500 dark:text-nature-400">Only people who tap Going see this.</p>
                        </div>
                    </div>
                ) : newPostType === 'poll' ? (
                    <div className="space-y-4 mb-4">
                        <div>
                            <label className="block text-xs font-bold text-nature-600 dark:text-nature-300 uppercase tracking-wider mb-1">
                                Question
                            </label>
                            <input
                                placeholder="What should our community decide?"
                                value={newPostTitle}
                                onChange={e => { setNewPostTitle(e.target.value); setValidationErrors(prev => { const n = new Set(prev); n.delete('title'); return n; }); }}
                                className={`w-full py-3 px-4 rounded-xl border bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[15px] focus:outline-none focus:ring-2 focus:ring-purple-300 shadow-sm transition-all ${
                                    validationErrors.has('title') ? 'border-red-400 bg-red-50 ring-1 ring-red-400' : 'border-nature-200 dark:border-nature-700'
                                }`}
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-nature-600 dark:text-nature-300 uppercase tracking-wider mb-1">
                                Background / Context (Optional)
                            </label>
                            <textarea
                                placeholder="Add context or notes for members..."
                                value={newPostDescription}
                                onChange={e => setNewPostDescription(e.target.value)}
                                rows={2}
                                className="w-full py-2.5 px-3.5 rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
                            />
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-nature-600 dark:text-nature-300 uppercase tracking-wider mb-1">
                                Options (2–4)
                            </label>
                            <div className="space-y-2">
                                {pollOptions.map((opt, idx) => (
                                    <div key={idx} className="flex gap-2 items-center">
                                        <span className="w-6 text-center text-sm font-bold text-nature-500">{idx + 1}.</span>
                                        <input
                                            placeholder={`Option ${idx + 1}`}
                                            value={opt}
                                            maxLength={80}
                                            onChange={e => {
                                                const next = [...pollOptions];
                                                next[idx] = e.target.value;
                                                setPollOptions(next);
                                                setValidationErrors(prev => { const n = new Set(prev); n.delete('options'); return n; });
                                            }}
                                            className="flex-1 py-2.5 px-3.5 rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"
                                        />
                                        {pollOptions.length > 2 && (
                                            <button
                                                type="button"
                                                onClick={() => setPollOptions(pollOptions.filter((_, i) => i !== idx))}
                                                className="text-nature-400 hover:text-red-500 min-w-[44px] min-h-[44px] flex items-center justify-center text-lg leading-none rounded-lg"
                                                title="Remove option"
                                                aria-label={`Remove option ${idx + 1}`}
                                            >
                                                ✕
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                            {pollOptions.length < 4 && (
                                <button
                                    type="button"
                                    onClick={() => setPollOptions([...pollOptions, ''])}
                                    className="mt-2 text-sm text-purple-600 dark:text-purple-400 hover:underline font-semibold flex items-center gap-1 min-h-[44px] py-2 px-1"
                                >
                                    + Add option
                                </button>
                            )}
                            {validationErrors.has('options_empty') && (
                                <p className="text-red-500 text-xs mt-1">Please fill or remove blank options.</p>
                            )}
                            {validationErrors.has('options_duplicate') && (
                                <p className="text-red-500 text-xs mt-1">Options must be distinct.</p>
                            )}
                            {validationErrors.has('options') && (
                                <p className="text-red-500 text-xs mt-1">Please provide at least 2 non-empty options.</p>
                            )}
                        </div>

                        <div>
                            <label className="block text-xs font-bold text-nature-600 dark:text-nature-300 uppercase tracking-wider mb-1">
                                Duration
                            </label>
                            <div className="flex gap-2">
                                {([3, 7, 14] as const).map(days => (
                                    <button
                                        key={days}
                                        type="button"
                                        aria-pressed={pollDurationDays === days}
                                        onClick={() => setPollDurationDays(days)}
                                        className={`flex-1 min-h-[44px] py-2 rounded-xl border text-sm font-semibold transition-all ${
                                            pollDurationDays === days
                                                ? 'bg-purple-600 border-purple-600 text-white shadow-sm'
                                                : 'bg-white dark:bg-nature-800 border-nature-200 dark:border-nature-700 text-nature-600 dark:text-nature-300'
                                        }`}
                                    >
                                        {days} Days
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="p-3 bg-purple-50 dark:bg-purple-950/20 rounded-xl border border-purple-200 dark:border-purple-800 text-xs text-purple-800 dark:text-purple-300">
                            <p className="font-bold mb-0.5">🗳️ Transparent Village Polling</p>
                            <p className="m-0 leading-relaxed">
                                Votes are signed and publicly visible to all community members. Open accountability creates trust.
                            </p>
                        </div>
                    </div>
                ) : (
                    <>
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

                        {renderLocationPicker()}

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

                        {/* #108 Cash-also-needed toggle. The nudge sits directly under the box, because the
                            moment of ticking is where the rule actually lands. No amount field by design:
                            the app can escrow beans, not cash, and a figure would imply it settles money it
                            never touches. */}
                        <label className="flex items-center gap-3 text-sm font-medium text-nature-700 cursor-pointer py-2 px-1">
                            <input
                                type="checkbox"
                                checked={newPostCashAlsoNeeded}
                                onChange={e => setNewPostCashAlsoNeeded(e.target.checked)}
                                className="w-5 h-5 rounded border-nature-300 text-amber-600 focus:ring-amber-500 shadow-sm accent-amber-600 cursor-pointer transition-all"
                            />
                            💸 Cash also needed — for fuel or materials
                        </label>
                        {newPostCashAlsoNeeded && (
                            <p className="text-[13px] leading-snug text-amber-700 dark:text-amber-500 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl px-3 py-2 mb-1">
                                Cash is for fuel and consumables you paid for — <strong>not your time, not your tools</strong>.
                                At cost, no markup. Agree the details in chat; the app never handles the money.
                            </p>
                        )}

                        {/* #143 step 4 — how far this listing travels. Shown ONLY when this community actually has
                            trading partners: a reach chooser on a node with no peers is a decision about nothing.
                            Default stays "Stays here", because a member who has never heard of federation has not
                            agreed to their listing appearing somewhere else.

                            THE COPY IS ABOUT TRAVEL, NOT VISIBILITY, and that distinction is the whole point. This
                            read "Who can see this?" over a "Just here" button, which promises more than the code
                            keeps: reach decides what this node hands a PEER that asks over libp2p, and every board
                            has always been a public HTTPS read, so anyone with the node's URL can list every active
                            listing regardless. That is by design (Rule 9 — reach is a discovery filter, not an
                            access control), so the honest fix is the words, not a guarantee we cannot make. */}
                        {audienceScope !== 'group' && reachablePeerList.length > 0 && (
                            <div className="py-2 px-1">
                                <label id="reach-chooser-label" className="block text-sm font-medium text-nature-700 dark:text-nature-300 mb-1.5">Where does this travel?</label>
                                {/* role="group" with aria-pressed toggles, NOT role="radiogroup" with role="radio"
                                    (review suggestion, departed from deliberately): a radiogroup promises arrow-key
                                    navigation between options, and implementing the role without the keys leaves a
                                    screen-reader user told "1 of 3" by a control that does not respond to arrows.
                                    A labelled group of pressed-state buttons is complete exactly as written. */}
                                <div className="flex gap-2" role="group" aria-labelledby="reach-chooser-label">
                                    {([
                                        { value: 'local' as const, label: '🏠 Stays here' },
                                        { value: 'peers' as const, label: '🤝 Chosen' },
                                        { value: 'everywhere' as const, label: '🌏 Everywhere' },
                                    ]).map(opt => (
                                        <button
                                            key={opt.value}
                                            type="button"
                                            onClick={() => setNewPostReach(opt.value)}
                                            aria-pressed={newPostReach === opt.value}
                                            className={`flex-1 text-xs font-medium rounded-xl px-2 py-2.5 border transition-all min-h-[44px] ${
                                                newPostReach === opt.value
                                                    ? 'bg-nature-700 dark:bg-nature-600 text-white border-nature-700 dark:border-nature-500 shadow-sm'
                                                    : 'bg-white dark:bg-nature-800 text-nature-700 dark:text-nature-300 border-nature-300 dark:border-nature-700'
                                            }`}
                                        >
                                            {opt.label}
                                        </button>
                                    ))}
                                </div>
                                {newPostReach === 'peers' && (
                                    <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label="Communities this listing is aimed at">
                                        {reachablePeerList.map(p => {
                                            const on = newPostReachPeers.includes(p.peerId);
                                            return (
                                                <button
                                                    key={p.peerId}
                                                    type="button"
                                                    onClick={() => setNewPostReachPeers(prev =>
                                                        on ? prev.filter(x => x !== p.peerId) : [...prev, p.peerId])}
                                                    aria-pressed={on}
                                                    className={`text-xs rounded-full px-3 py-2 border transition-all min-h-[36px] ${
                                                        on
                                                            ? 'bg-nature-700 dark:bg-nature-600 text-white border-nature-700 dark:border-nature-500'
                                                            : 'bg-white dark:bg-nature-800 text-nature-700 dark:text-nature-300 border-nature-300 dark:border-nature-700'
                                                    }`}
                                                >
                                                    {on ? '✓ ' : ''}{p.callsign || `Peer ${p.peerId.slice(-8)}`}
                                                </button>
                                            );
                                        })}
                                    </div>
                                )}
                                {/* "Chosen" with nothing ticked is a real dead end — the listing silently stays home —
                                    so it reads as a warning rather than as neutral help text. Not a blocking error:
                                    staying home is a valid outcome, and refusing the post would be worse than
                                    honouring the safe default. */}
                                <p className={`text-[13px] leading-snug mt-1.5 ${
                                    newPostReach === 'peers' && newPostReachPeers.length === 0
                                        ? 'text-amber-600 dark:text-amber-400 font-medium'
                                        : 'text-nature-500 dark:text-nature-400'
                                }`}>
                                    {newPostReach === 'local'
                                        ? 'Stays on this community\'s board.'
                                        : newPostReach === 'everywhere'
                                            ? 'Appears on the board of every community you trade with, and they can buy it.'
                                            : newPostReachPeers.length > 0
                                                ? 'Appears on the board of the communities you ticked.'
                                                : '⚠️ Tick at least one community, or it stays here.'}
                                </p>
                            </div>
                        )}

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

                        {renderPhotoPicker(true)}
                    </>
                )}

                <button
                    onClick={handleCreatePost}
                    disabled={submitDisabled}
                    className={`w-full p-3 min-h-[48px] rounded-xl font-semibold transition-all ${
                        submitDisabled
                            ? 'bg-oat-200 text-oat-500 cursor-not-allowed'
                            : (newPostType === 'poll' ? 'bg-purple-600 hover:bg-purple-700 text-white shadow-md' : newPostType === 'event' ? 'bg-violet-700 hover:bg-violet-800 text-white shadow-md' : 'bg-nature-600 text-white hover:bg-nature-700 shadow-md')
                    }`}
                >
                    {posting ? 'Posting...' :
                     newPostType === 'event' ? (postLat == null ? '📍 Map location required' : !newPostTitle.trim() || !eventStart ? '✏️ Add a title and start time' : '📅 Create Event') :
                     newPostType === 'poll' ? '🗳️ Create Poll' :
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
        {lightboxState?.isOpen && (
            <ImageLightbox
                isOpen={lightboxState.isOpen}
                photos={lightboxState.photos}
                initialIndex={lightboxState.initialIndex}
                title={lightboxState.title}
                triggerElement={lightboxState.triggerElement}
                onClose={() => setLightboxState(null)}
            />
        )}
    </>
    );
}
