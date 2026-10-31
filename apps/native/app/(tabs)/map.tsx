import React, { useEffect, useState, useRef, useCallback, useMemo, useReducer } from 'react';
import { StyleSheet, View, Text, Platform, Alert, TouchableOpacity, ScrollView, Pressable, Image as RNImage, Linking, DeviceEventEmitter, Animated, PixelRatio } from 'react-native';
import * as Location from 'expo-location';
import MapView, { Marker, Circle, PROVIDER_DEFAULT } from '../../components/Map';
import { useFocusEffect, router, useLocalSearchParams } from 'expo-router';
import { t, upperCase } from '@beanpool/core';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MemberAvatar } from '../../components/MemberAvatar';
import { getPosts } from '../../utils/db';
import { CurrencyDisplay, useCurrencyString } from '../../components/CurrencyDisplay';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { FilterChipRow } from '../../components/FilterChipRow';
import { FilterChipPicker } from '../../components/FilterChipPicker';
import { PinVisual, MapMarkerManager, getCachedMarkerImage, buildVariantList, PIN_ANCHOR, PIN_RENDER_W, PIN_RENDER_H, pinCacheKey, ClusterCaptureManager, getCachedClusterImage, CLUSTER_ANCHOR, EVENT_PIN } from '../../components/UnifiedMapPin';
import { useTheme, useStyles } from '../ThemeContext';
import { EVENT_ACCENT } from '../../components/EventCard';
import { eventPinCard, type EventWindow } from '../../utils/events';
import {
    mapSecondRow, visibleMarketPins, visibleEventPins, mapFiltersActive, categoryChipLabel, categoryPanelReducer,
    eventFitCoordinates, eventFitPadding, type MapTypeFilter,
} from '../../utils/map-filters';
import { parseNewPostParam } from '../../utils/compose-options';
import { palette } from '../../constants/colors';
import { HAS_MAPS_KEY } from '../../utils/maps';
import { POST_CATEGORIES, categoryEmoji, categoryLabel, normalizeCategory } from '../../constants/categories';
import { useNodeProfile } from '../../utils/use-node-profile';
import { marketShowsBeans } from '../../utils/market-global';

const CATEGORIES = POST_CATEGORIES;
// ⚡ Bolt: O(1) Map lookup for marketplace categories instead of repeated O(C) .find() scans
const CATEGORIES_BY_ID = new Map(CATEGORIES.map(c => [c.id, c]));

// Hide Google Maps POI markers
const hidePoisStyle = [
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "poi.business", stylers: [{ visibility: "off" }] },
  { featureType: "poi.park", elementType: "labels", stylers: [{ visibility: "off" }] },
  { featureType: "transit", elementType: "labels.icon", stylers: [{ visibility: "off" }] },
];

const darkMapStyle = [
  ...hidePoisStyle,
  { elementType: "geometry", stylers: [{ color: "#242f3e" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
  { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#d59563" }] },
  { featureType: "poi.park", elementType: "geometry", stylers: [{ color: "#263c3f" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#38414e" }] },
  { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#212a37" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#9ca5b3" }] },
  { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#746855" }] },
  { featureType: "road.highway", elementType: "geometry.stroke", stylers: [{ color: "#1f2835" }] },
  { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#f3d19c" }] },
  { featureType: "transit", elementType: "geometry", stylers: [{ color: "#2f3948" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#17263c" }] },
  { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#515c6d" }] },
  { featureType: "water", elementType: "labels.text.stroke", stylers: [{ color: "#17263c" }] }
];

const ClusterMarker = ({ cluster, clustersReady }: any) => {
    const { geometry, onPress, properties } = cluster;
    const points = properties.point_count;
    // Cap at 99 for image lookup — counts ≥100 use the "99+" image
    const displayCount = Math.min(points, 99);

    const cachedImage = clustersReady ? getCachedClusterImage(displayCount) : null;

    // Platform fix: We start tracksViewChanges=true on Android.
    // It will be set to false ONLY when the RNImage's onLoad fires.
    const [tracksViewChanges, setTracksViewChanges] = useState(Platform.OS !== 'ios');

    const getCS = (p: number) => {
        if (p >= 50) return { size: 64, glow: 80, fontSize: 20 };
        if (p >= 25) return { size: 56, glow: 72, fontSize: 19 };
        if (p >= 15) return { size: 50, glow: 66, fontSize: 18 };
        if (p >= 10) return { size: 46, glow: 60, fontSize: 17 };
        if (p >= 5)  return { size: 42, glow: 54, fontSize: 16 };
        return { size: 36, glow: 48, fontSize: 15 };
    };

    if (cachedImage && Platform.OS !== 'web') {
        if (Platform.OS === 'android') {
            const { glow } = getCS(displayCount);
            return (
                <Marker
                    coordinate={{ longitude: geometry.coordinates[0], latitude: geometry.coordinates[1] }}
                    onPress={onPress}
                    tracksViewChanges={tracksViewChanges}
                    anchor={CLUSTER_ANCHOR}
                >
                    <View style={{ width: glow + 8, height: glow + 8, justifyContent: 'center', alignItems: 'center' }}>
                        <RNImage 
                            source={{ uri: cachedImage }} 
                            style={{ width: glow + 8, height: glow + 8 }} 
                            resizeMode="contain" 
                            fadeDuration={0}
                            onLoad={() => setTimeout(() => setTracksViewChanges(false), 400)}
                        />
                    </View>
                </Marker>
            );
        }
        return (
            <Marker
                coordinate={{ longitude: geometry.coordinates[0], latitude: geometry.coordinates[1] }}
                onPress={onPress}
                tracksViewChanges={tracksViewChanges}
                anchor={CLUSTER_ANCHOR}
                image={{ uri: cachedImage }}
            />
        );
    }

    // Fallback (web, or while capturing)
    const { size, glow, fontSize } = getCS(points);

    return (
        <Marker
            coordinate={{ longitude: geometry.coordinates[0], latitude: geometry.coordinates[1] }}
            onPress={onPress}
            tracksViewChanges={true}
            style={{ zIndex: points + 1 }}
            anchor={CLUSTER_ANCHOR}
        >
            <View collapsable={false} style={{ width: glow, height: glow, justifyContent: 'center', alignItems: 'center' }}>
                <View collapsable={false} style={{ position: 'absolute', width: glow, height: glow, borderRadius: glow / 2, backgroundColor: 'rgba(59, 130, 246, 0.25)' }} />
                <View collapsable={false} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: palette.blue600, justifyContent: 'center', alignItems: 'center', borderColor: '#ffffff', borderWidth: 3 }}>
                    <Text style={{ color: '#ffffff', fontWeight: '800', fontSize }}>{points}</Text>
                </View>
            </View>
        </Marker>
    );
};

const CustomMapMarker = React.memo(({ coordinate, post, catObj, isSelected, onPress, opacity = 1, markersReady = false }: any) => {

    const postType = (post.type || '').toLowerCase();
    const isOffer = postType === 'offer';
    // An event wears the one event pin (UnifiedMapPin's EVENT_PIN): the event violet, a calendar, no elder ring.
    const isEvent = postType === 'event';
    const bgColor = isEvent ? EVENT_PIN.bgColor : isOffer ? '#10b981' : '#ea580c';
    const markerEmoji = isEvent ? EVENT_PIN.emoji : catObj?.emoji || (isOffer ? '📦' : '❤️');
    const isElder = !isEvent && (post.author_energy_cycled || 0) >= 10000;
    const glyph = isEvent ? EVENT_PIN.glyph : undefined;
    const cachedImage = markersReady ? getCachedMarkerImage(markerEmoji, bgColor, isElder, glyph) : null;

    // Platform fix: We start tracksViewChanges=true on Android.
    // It will be set to false ONLY when the RNImage's onLoad fires.
    const [tracksViewChanges, setTracksViewChanges] = useState(Platform.OS !== 'ios');

    useEffect(() => {
        if (Platform.OS === 'android') {
            setTracksViewChanges(true);
        }
    }, [cachedImage]);

    if (cachedImage && Platform.OS !== 'web') {
        if (Platform.OS === 'android') {
            return (
                <Marker
                    coordinate={coordinate}
                    tracksViewChanges={tracksViewChanges}
                    opacity={opacity}
                    anchor={PIN_ANCHOR}
                    onPress={(e) => { e.stopPropagation(); onPress(post); }}
                >
                    <View style={{ width: PIN_RENDER_W, height: PIN_RENDER_H, justifyContent: 'center', alignItems: 'center' }}>
                        <RNImage 
                            key={cachedImage}
                            source={{ uri: cachedImage }} 
                            style={{ width: PIN_RENDER_W, height: PIN_RENDER_H }} 
                            resizeMode="contain" 
                            fadeDuration={0}
                            onLoad={() => setTimeout(() => setTracksViewChanges(false), 400)}
                        />
                    </View>
                </Marker>
            );
        }
        return (
            <Marker
                coordinate={coordinate}
                tracksViewChanges={tracksViewChanges}
                opacity={opacity}
                anchor={PIN_ANCHOR}
                image={{ uri: cachedImage }}
                onPress={(e) => { e.stopPropagation(); onPress(post); }}
            />
        );
    }

    // Fallback: inline SVG (web, or while images are still being captured)
    return (
        <Marker
            coordinate={coordinate}
            tracksViewChanges={false}
            opacity={opacity}
            anchor={PIN_ANCHOR}
            onPress={(e) => { e.stopPropagation(); onPress(post); }}
        >
            <View collapsable={false} style={{ width: PIN_RENDER_W, height: PIN_RENDER_H }}>
                <PinVisual
                    emoji={markerEmoji}
                    bgColor={bgColor}
                    isElder={isElder}
                    glyph={glyph}
                />
            </View>
        </Marker>
    );
});

export default function MapScreen() {
    const currencyStr = useCurrencyString();
    const { theme, colors } = useTheme();
    const [isDarkMap, setIsDarkMap] = useState(theme === 'dark');

    useEffect(() => {
        setIsDarkMap(theme === 'dark');
    }, [theme]);

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: colors.surface.page },
        map: { width: '100%', height: '100%' },

        // Floating Filter Bar
        filterBarWrapper: { position: 'absolute', top: 8, left: 0, right: 0, alignItems: 'center', zIndex: 90 },
        // The scroll container shrink-wraps the pills and caps at the screen, so the row centres when it
        // fits and scrolls when it does not. The pill look (fill, radius, shadow) stays on the content.
        filterBarScroll: { maxWidth: '92%', flexGrow: 0, borderRadius: 24 },
        filterBar: { flexDirection: 'row', alignItems: 'center', backgroundColor: theme === 'dark' ? 'rgba(26,26,26,0.85)' : 'rgba(255,255,255,0.85)', padding: 2, borderRadius: 26, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 8 },
        // Slim, as before #892 (~34dp; the pill is the tap target). The active variants below only add colour.
        filterChip: { paddingVertical: 8, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 24 },
        filterChipActive: { backgroundColor: colors.border.strong },
        filterChipActiveOffers: { backgroundColor: colors.brand.fill },
        filterChipActiveNeeds: { backgroundColor: colors.action.fab },
        // The event violet — the same one the event card and the web map's pin use.
        filterChipActiveEvents: { backgroundColor: EVENT_ACCENT },
        filterChipText: { fontSize: 13, fontWeight: '600', color: colors.text.secondary },
        filterChipTextActive: { color: colors.text.heading, fontWeight: '800' },
        filterChipTextOnGreen: { fontSize: 13, color: '#ffffff', fontWeight: '800' },
        filterChipTextOnOrange: { fontSize: 13, color: '#ffffff', fontWeight: '800' },
        filterChipTextOnViolet: { fontSize: 13, color: '#ffffff', fontWeight: '800' },
        // The second row, always under the pills: categories, or the date chips under Events.
        filterSecondRow: { marginTop: 6, maxWidth: '92%' },
        // The screen less 8dp a side, so the open panel's tiles get the width (four per row at 320dp + 1.3x);
        // the collapsed chip centres inside it.
        filterCategoryPicker: { marginTop: 6, alignSelf: 'stretch', marginHorizontal: 8 },
        filterClear: { paddingVertical: 8, minWidth: 40, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 8 },
        filterClearText: { fontSize: 14, color: colors.text.muted, fontWeight: '800' },

        // FAB Pill (Right side)
        fabPill: { position: 'absolute', width: 48, backgroundColor: theme === 'dark' ? 'rgba(26,26,26,0.95)' : 'rgba(255,255,255,0.95)', borderRadius: 24, paddingVertical: 8, alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 8, zIndex: 100 },
        pillBtn: { width: 48, height: 44, justifyContent: 'center', alignItems: 'center' },
        pillDivider: { width: 32, height: 1, backgroundColor: theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)', marginVertical: 2 },
        pillBtnEmoji: { fontSize: 20 },
        pillBtnIcon: { fontSize: 22, fontWeight: '300', color: colors.text.body },

        // Map Preview Card
        previewCardWrapper: { position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 150, justifyContent: 'flex-end' },
        previewCardOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'transparent' },
        eventPreviewCard: { borderLeftWidth: 4, borderLeftColor: EVENT_ACCENT },
        eventPreviewBody: { flex: 1, padding: 16, paddingRight: 48 },
        eventPreviewWhenRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
        eventPreviewWhen: { flexShrink: 1, fontSize: 17, fontWeight: '800', color: colors.event.ink },
        eventPreviewBadge: { fontSize: 11, fontWeight: '800', color: colors.event.ink, borderWidth: 1, borderColor: EVENT_ACCENT, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
        eventPreviewMeta: { fontSize: 14, color: colors.text.secondary, marginTop: 2 },
        previewCard: { backgroundColor: colors.surface.card, margin: 16, borderRadius: 24, padding: 0, flexDirection: 'row', shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.15, shadowRadius: 20, elevation: 20, overflow: 'hidden' },
        previewThumb: { width: 125, height: '100%', minHeight: 125, borderTopLeftRadius: 24, borderBottomLeftRadius: 24, borderTopRightRadius: 0, borderBottomRightRadius: 0, backgroundColor: colors.surface.subtle },
        previewThumbPlaceholder: { width: 125, height: '100%', minHeight: 125, borderTopLeftRadius: 24, borderBottomLeftRadius: 24, borderTopRightRadius: 0, borderBottomRightRadius: 0, justifyContent: 'center', alignItems: 'center' },
        previewInfo: { flex: 1, padding: 14, justifyContent: 'center' },
        previewHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, paddingRight: 32 },
        previewCategory: { fontSize: 12, fontWeight: '700', color: colors.text.secondary, textTransform: 'uppercase', letterSpacing: 0.5, flex: 1 },
        previewCredits: { fontSize: 14, fontWeight: '800', color: colors.brand.primary },
        previewTitle: { fontSize: 18, fontWeight: '800', color: colors.text.heading, marginBottom: 4 },
        previewAuthor: { fontSize: 14, fontWeight: '500', color: colors.text.secondary },
        previewActionBtn: { paddingVertical: 7, paddingHorizontal: 16, borderRadius: 12, alignItems: 'center' },
        previewActionText: { color: '#fff', fontSize: 14, fontWeight: '700' },
        previewClose: { position: 'absolute', top: 12, right: 12, width: 28, height: 28, borderRadius: 14, backgroundColor: theme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)', justifyContent: 'center', alignItems: 'center' },
        previewCloseText: { fontSize: 12, fontWeight: '800', color: colors.text.secondary },

        // FAB
        fab: { position: 'absolute', bottom: 32, right: 24, backgroundColor: colors.action.fab, paddingVertical: 14, paddingHorizontal: 20, borderRadius: 28, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 6, elevation: 8, zIndex: 100 },

    }));

    const [posts, setPosts] = useState<any[]>([]);
    const mapRef = useRef<any>(null);
    const [currentRegion, setCurrentRegion] = useState({
        latitude: -28.5398, longitude: 153.4996,
        latitudeDelta: 0.0922, longitudeDelta: 0.0421,
    });

    const params = useLocalSearchParams<{ newPost?: string }>();

    useFocusEffect(
        useCallback(() => {
            // `newPost=true` is the long-standing link and still opens the chooser; a named type opens
            // that form directly. The form is a screen of its own (app/new-listing.tsx), so the link is
            // passed on to it as it came.
            const wanted = parseNewPostParam(params.newPost);
            if (!wanted) return;
            router.setParams({ newPost: '' });
            router.push({ pathname: '/new-listing', params: { newPost: params.newPost } });
        }, [params.newPost])
    );

    // Where the community has Beans off (the global one), the form has no price and the preview no amount.
    const nodeFeatures = useNodeProfile()?.features;
    const showsBeans = marketShowsBeans(nodeFeatures);

    // Map UI State
    const [selectedPostPreview, setSelectedPostPreview] = useState<any>(null);
    const [markersReady, setMarkersReady] = useState(false);
    const [clustersReady, setClustersReady] = useState(false);

    // Pre-compute unique marker variants for off-screen capture. The list holds the one event pin (EVENT_PIN) too,
    // captured with the listings' pins so it is ready before any pin shows.
    const markerVariants = useMemo(
        () => buildVariantList(posts, CATEGORIES),
        [posts]
    );

    // Pre-compute cluster counts to capture (2 through 99, plus a "99+" variant)
    const clusterCounts = useMemo(
        () => Array.from({ length: 98 }, (_, i) => i + 2),
        []
    );

    // Filter state
    const [mapTypeFilter, setMapTypeFilter] = useState<MapTypeFilter>('all');
    /**
     * The category chip and the date chips share the second row (utils/map-filters.ts). Both are remembered
     * across type switches, and each filters only while its row is showing. The category is one chip that
     * opens a panel of every category; the panel's open/closed state lives with the category so picking a
     * tile applies it and closes the panel in one step.
     */
    const [categoryPanel, dispatchCategoryPanel] = useReducer(categoryPanelReducer, { category: 'all', open: false });
    const mapCategoryFilter = categoryPanel.category;
    const closeCategoryPanel = () => dispatchCategoryPanel({ kind: 'dismiss' });
    const selectMapType = (t: MapTypeFilter) => {
        setMapTypeFilter(t);
        // Events takes the second row for its date chips, so an open category panel goes with it.
        if (t === 'events') {
            closeCategoryPanel();
            fitEventPins(eventWindow);
        }
    };
    /**
     * Picking Events or a date chip brings the matching events into view BELOW the filter rows, so a member who
     * asks for events always sees one — at 320dp with 1.3x text a pin fitted to the top edge sat under the
     * date chips (events round 2, B2). Android takes edge padding in pixels, iOS in points.
     */
    const fitEventPins = (window: EventWindow) => {
        const coords = eventFitCoordinates(visibleEventPins(posts, { type: 'events', category: mapCategoryFilter, eventWindow: window }));
        if (coords.length === 0 || !mapRef.current) return;
        const scale = Platform.OS === 'android' ? PixelRatio.get() : 1;
        const pad = eventFitPadding(filterBottom);
        mapRef.current.fitToCoordinates(coords, {
            edgePadding: { top: pad.top * scale, right: pad.right * scale, bottom: pad.bottom * scale, left: pad.left * scale },
            animated: true,
        });
    };
    // The filter bar hides behind a pin preview; the panel does not come back with it.
    useEffect(() => {
        if (selectedPostPreview) closeCategoryPanel();
    }, [selectedPostPreview]);
    // Leaving the tab closes it too, so coming back to the Map shows the map, not the panel.
    useFocusEffect(useCallback(() => () => dispatchCategoryPanel({ kind: 'dismiss' }), []));
    const [eventWindow, setEventWindow] = useState<EventWindow>('all');
    const mapFilterState = { type: mapTypeFilter, category: mapCategoryFilter, eventWindow };
    const secondRow = mapSecondRow(mapTypeFilter);
    /**
     * The zoom pill sits at bottom 120, which on a 320dp phone at 1.3x text runs up under the two filter
     * rows. Measure the screen, the rows and the pill, and drop the pill just far enough to clear them —
     * never lower than 36, where it would cover the Google logo.
     */
    const [mapAreaH, setMapAreaH] = useState(0);
    const [filterBottom, setFilterBottom] = useState(0);
    const [fabPillH, setFabPillH] = useState(0);
    const fabPillBottom = mapAreaH && filterBottom && fabPillH
        ? Math.max(36, Math.min(120, mapAreaH - filterBottom - 8 - fabPillH))
        : 120;
    const [nodeRadius, setNodeRadius] = useState<{ lat: number; lng: number; radiusKm: number } | null>(null);

    const fetchNodeLocation = async () => {
        try {
            const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
            if (!anchorUrl) return;
            const res = await fetch(`${anchorUrl}/api/node/config`);
            if (!res.ok) return;
            const config = await res.json();
            if (config?.serviceRadius && typeof config.serviceRadius.lat === 'number' && typeof config.serviceRadius.lng === 'number') {
                setNodeRadius(config.serviceRadius);
                const nextRegion = {
                    latitude: config.serviceRadius.lat,
                    longitude: config.serviceRadius.lng,
                    latitudeDelta: 0.0922,
                    longitudeDelta: 0.0421,
                };
                setCurrentRegion(nextRegion);
                mapRef.current?.animateToRegion(nextRegion, 500);
            }
        } catch (e) {
            console.warn('Failed to fetch node config for map center:', e);
        }
    };

    useFocusEffect(
        React.useCallback(() => { 
            loadPosts();
            fetchNodeLocation();
        }, [])
    );

    useEffect(() => {
        const sub = DeviceEventEmitter.addListener('sync_data_updated', () => loadPosts());
        return () => sub.remove();
    }, []);

    const initialClusterTriggered = useRef(false);

    const loadPosts = async () => {
        try {
            // Events are opt-in on this query as they are on the node's list route, so a client that
            // cannot draw them never receives one. This map draws them, so it asks for them.
            const p = await getPosts({ includeEvents: true });
            setPosts(p); 
            
            // Workaround for react-native-map-clustering: 
            // Force a microscopic region change to trigger supercluster after initial async data load
            if (p.length > 0 && mapRef.current && !initialClusterTriggered.current) {
                initialClusterTriggered.current = true;
                setTimeout(() => {
                    mapRef.current?.animateToRegion({
                        latitude: currentRegion.latitude,
                        longitude: currentRegion.longitude,
                        latitudeDelta: currentRegion.latitudeDelta + 0.000001,
                        longitudeDelta: currentRegion.longitudeDelta + 0.000001,
                    }, 1);
                }, 500);
            }
        } catch (e: any) { 
            console.error('Failed to load map points', e); 
        }
    };

    // We no longer automatically request permissions on init.
    // The user must explicitly request location via the GPS button.

    const centerOnUser = async () => {
        const { status: initStatus, canAskAgain } = await Location.getForegroundPermissionsAsync();
        let status = initStatus;
        if (status !== 'granted') {
            if (canAskAgain) {
                const res = await Location.requestForegroundPermissionsAsync();
                status = res.status;
            } else {
                Alert.alert(t("Permission Denied"), t("Location permission was denied. Please enable it in your device settings to center the map."), [
                    { text: t("Cancel"), style: "cancel" },
                    { text: t("Open Settings"), onPress: () => Linking.openSettings() }
                ]);
                return;
            }
        }
        if (status !== 'granted') return;
        try {
            const location = await Location.getCurrentPositionAsync({});
            mapRef.current?.animateToRegion({
                latitude: location.coords.latitude, longitude: location.coords.longitude,
                latitudeDelta: 0.05, longitudeDelta: 0.02,
            }, 1000);
        } catch (err) { console.log("Failed to fetch current location", err); }
    };

    const renderCluster = (cluster: any) => {
        return <ClusterMarker key={`cluster-${cluster.id}-${clustersReady}`} cluster={cluster} clustersReady={clustersReady} />;
    };

    return (
        <View style={styles.container} onLayout={e => setMapAreaH(e.nativeEvent.layout.height)}>
            {/* Off-screen pin capture layer */}
            {Platform.OS !== 'web' && markerVariants.length > 0 && (
                <MapMarkerManager
                    variants={markerVariants}
                    onReady={() => {
                        console.log('[MapScreen] ✅ All marker images captured!');
                        setMarkersReady(true);
                    }}
                />
            )}
            {/* Off-screen cluster capture layer */}
            {Platform.OS !== 'web' && !clustersReady && (
                <ClusterCaptureManager
                    counts={clusterCounts}
                    onReady={() => {
                        console.log('[MapScreen] ✅ All cluster images captured!');
                        setClustersReady(true);
                    }}
                />
            )}
            {HAS_MAPS_KEY ? (
                <MapView
                    ref={mapRef}
                    style={styles.map}
                    provider={PROVIDER_DEFAULT}
                    customMapStyle={isDarkMap ? darkMapStyle : hidePoisStyle}
                    userInterfaceStyle={isDarkMap ? "dark" : "light"}
                    showsUserLocation={true}
                    // Google's own locate button (top right, Android) doubled the one in the left pill. The pill's is the only one.
                    showsMyLocationButton={false}
                    onRegionChangeComplete={(r: any) => {
                        setCurrentRegion(r);
                    }}
                    onPress={() => {
                        if (selectedPostPreview) setSelectedPostPreview(null);
                        // A tap on the map closes the category panel without changing the filter.
                        closeCategoryPanel();
                    }}
                    initialRegion={currentRegion}
                    renderCluster={renderCluster}
                    spiralEnabled={true}
                    animationEnabled={false}
                    radius={15}
                >
                    {/* Offer, Need and event pins, one marker for all three. Events are clustered with the
                        listings and counted in their bubbles (Marty, 31 Oct: an event is part of what the map
                        already has, not a layer of its own). They show under All and under the Events pill,
                        filtered by the date chips; `eventInWindow` applies the slice-1 feed rule first, so an
                        event that has ended or been cancelled never pins — the sync pull is a replica of the
                        list, not the list, and carries both. */}
                    {[...visibleMarketPins(posts, mapFilterState), ...visibleEventPins(posts, mapFilterState)].map(post => {
                        const catObj = CATEGORIES_BY_ID.get(post.category) || { id: normalizeCategory(post.category), emoji: categoryEmoji(post.category), label: categoryLabel(post.category) };
                        const safePost = { ...post, lat: Number(post.lat), lng: Number(post.lng) };
                        const isSelected = selectedPostPreview?.id === post.id;
                        return (
                            <CustomMapMarker
                                key={`${post.id}-${isSelected}-${markersReady}`}
                                coordinate={{ latitude: safePost.lat, longitude: safePost.lng }}
                                post={safePost}
                                catObj={catObj}

                                isSelected={isSelected}
                                onPress={setSelectedPostPreview}
                                markersReady={markersReady}
                            />
                        );
                    })}

                    {/* Service radius circle overlay */}
                    {nodeRadius && nodeRadius.radiusKm > 0 && (
                        <Circle
                            center={{ latitude: nodeRadius.lat, longitude: nodeRadius.lng }}
                            radius={nodeRadius.radiusKm * 1000}
                            strokeColor="#f59e0b"
                            fillColor="rgba(245, 158, 11, 0.06)"
                            strokeWidth={2}
                        />
                    )}
                </MapView>
            ) : (
                <View style={[styles.map, { justifyContent: 'center', alignItems: 'center', backgroundColor: colors.surface.subtle, padding: 24 }]}>
                    <MaterialCommunityIcons name="map-marker-off" size={48} color={colors.text.muted} />
                    <Text style={{ marginTop: 12, color: colors.text.body, fontWeight: '700', textAlign: 'center' }}>{t('Google Maps is not configured')}</Text>
                    <Text style={{ marginTop: 4, color: colors.text.secondary, fontSize: 12, textAlign: 'center' }}>{t('API key is missing in build config.')}</Text>
                </View>
            )}

            {/* Floating Filter Bar — the type pills, and under them one contextual row that stays in
                the same place: category chips for All / Offers / Needs, date chips for Events. */}
            {!selectedPostPreview && (
                <View
                    style={styles.filterBarWrapper}
                    pointerEvents="box-none"
                    // Measured with the panel closed: the zoom pill clears the rows, and hides while the panel is open.
                    onLayout={e => { if (!categoryPanel.open) setFilterBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height); }}
                >
                    {/* Scrollable: at 320dp with 1.3x text the pills run past the screen; it still
                        shrink-wraps and centres at normal sizes. */}
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        style={styles.filterBarScroll}
                        contentContainerStyle={styles.filterBar}
                    >
                        <Pressable accessibilityRole="button" accessibilityState={{ selected: mapTypeFilter === 'all' }} style={[styles.filterChip, mapTypeFilter === 'all' && styles.filterChipActive]} onPress={() => selectMapType('all')}>
                            <Text style={[styles.filterChipText, mapTypeFilter === 'all' && styles.filterChipTextActive]}>{t('All')}</Text>
                        </Pressable>
                        <Pressable accessibilityRole="button" accessibilityState={{ selected: mapTypeFilter === 'offers' }} style={[styles.filterChip, mapTypeFilter === 'offers' && styles.filterChipActiveOffers]} onPress={() => selectMapType('offers')}>
                            <Text style={[styles.filterChipText, mapTypeFilter === 'offers' && styles.filterChipTextOnGreen]}>{t('Offers')}</Text>
                        </Pressable>
                        <Pressable accessibilityRole="button" accessibilityState={{ selected: mapTypeFilter === 'needs' }} style={[styles.filterChip, mapTypeFilter === 'needs' && styles.filterChipActiveNeeds]} onPress={() => selectMapType('needs')}>
                            <Text style={[styles.filterChipText, mapTypeFilter === 'needs' && styles.filterChipTextOnOrange]}>{t('Needs')}</Text>
                        </Pressable>
                        <Pressable accessibilityRole="button" accessibilityState={{ selected: mapTypeFilter === 'events' }} style={[styles.filterChip, mapTypeFilter === 'events' && styles.filterChipActiveEvents]} onPress={() => selectMapType('events')}>
                            <Text style={[styles.filterChipText, mapTypeFilter === 'events' && styles.filterChipTextOnViolet]}>{t('Events')}</Text>
                        </Pressable>
                        {mapFiltersActive(mapFilterState) && (
                            <Pressable accessibilityRole="button" accessibilityLabel={t('Clear filters')} style={styles.filterClear} onPress={() => { setMapTypeFilter('all'); dispatchCategoryPanel({ kind: 'pick', category: 'all' }); setEventWindow('all'); }}>
                                <Text style={styles.filterClearText}>✕</Text>
                            </Pressable>
                        )}
                    </ScrollView>

                    {/* Categories: one chip, and every category as tiles under it while open. Events: the
                        date chips, in the same place. */}
                    {secondRow.kind === 'categories' ? (
                        <FilterChipPicker
                            chips={secondRow.chips}
                            selected={mapCategoryFilter}
                            chipLabel={categoryChipLabel(mapCategoryFilter, categoryPanel.open)}
                            open={categoryPanel.open}
                            onToggle={() => dispatchCategoryPanel({ kind: 'toggle' })}
                            onSelect={(id) => dispatchCategoryPanel({ kind: 'pick', category: id })}
                            activeColor={mapTypeFilter === 'offers' ? colors.brand.fill : mapTypeFilter === 'needs' ? colors.action.fab : colors.brand.fill}
                            style={styles.filterCategoryPicker}
                            panelMaxHeight={mapAreaH && filterBottom ? Math.max(120, mapAreaH - filterBottom - 6 - 12) : undefined}
                            accessibilityLabel={t('Filter by category')}
                        />
                    ) : (
                        <FilterChipRow
                            key="eventWindows"
                            chips={secondRow.chips}
                            selected={eventWindow}
                            onSelect={(w) => { setEventWindow(w); fitEventPins(w); }}
                            activeColor={EVENT_ACCENT}
                            style={styles.filterSecondRow}
                            accessibilityLabel={t('Filter events by date')}
                        />
                    )}
                </View>
            )}

            {/* Map Action FABs - Left Pill */}
            {!selectedPostPreview && !categoryPanel.open && (
                <View style={[styles.fabPill, { bottom: fabPillBottom, left: 16 }]} pointerEvents="box-none" onLayout={e => setFabPillH(e.nativeEvent.layout.height)}>
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('Toggle dark mode')} style={styles.pillBtn} onPress={() => setIsDarkMap(!isDarkMap)}>
                        <Text style={styles.pillBtnEmoji}>{isDarkMap ? '☀️' : '🌙'}</Text>
                    </TouchableOpacity>
                    <View style={styles.pillDivider} />
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('Recenter map')} style={styles.pillBtn} onPress={centerOnUser}>
                        <MaterialCommunityIcons name="crosshairs-gps" size={24} color={colors.text.body} />
                    </TouchableOpacity>
                    <View style={styles.pillDivider} />
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('Zoom in')} style={styles.pillBtn} onPress={() => mapRef.current?.animateToRegion({ ...currentRegion, latitudeDelta: currentRegion.latitudeDelta / 2, longitudeDelta: currentRegion.longitudeDelta / 2 }, 300)}>
                        <Text style={styles.pillBtnIcon}>+</Text>
                    </TouchableOpacity>
                    <View style={styles.pillDivider} />
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('Zoom out')} style={styles.pillBtn} onPress={() => mapRef.current?.animateToRegion({ ...currentRegion, latitudeDelta: currentRegion.latitudeDelta * 2, longitudeDelta: currentRegion.longitudeDelta * 2 }, 300)}>
                        <Text style={styles.pillBtnIcon}>−</Text>
                    </TouchableOpacity>
                </View>
            )}

            {/* An event's pin card: date and time first, the place and how many are going. An event is not a
                listing — no category and no bean amount (events round 2, B1). */}
            {selectedPostPreview && selectedPostPreview.type === 'event' && (() => {
                const card = eventPinCard(selectedPostPreview);
                return (
                    <SafeAreaView style={styles.previewCardWrapper} pointerEvents="box-none">
                        <Pressable accessibilityRole="button" accessibilityLabel={t('Close preview')} style={styles.previewCardOverlay} onPress={() => setSelectedPostPreview(null)} />
                        <Animated.View style={[styles.previewCard, styles.eventPreviewCard]}>
                            <View style={styles.eventPreviewBody}>
                                <View style={styles.eventPreviewWhenRow}>
                                    <Text style={styles.eventPreviewWhen} numberOfLines={2}>{card.when}</Text>
                                    {card.badge && <Text style={styles.eventPreviewBadge} numberOfLines={1}>{card.badge === 'CANCELLED' ? t('CANCELLED', undefined, 'event') : t('UPDATED', undefined, 'event')}</Text>}
                                </View>
                                <Text style={styles.previewTitle} numberOfLines={2}>{card.title}</Text>
                                {card.place && <Text style={styles.eventPreviewMeta} numberOfLines={1}>📍 {card.place}</Text>}
                                <Text style={styles.eventPreviewMeta} numberOfLines={1}>👥 {card.going}</Text>
                                <Pressable
                                    accessibilityRole="button"
                                    style={[styles.previewActionBtn, { backgroundColor: EVENT_ACCENT, marginTop: 10 }]}
                                    onPress={() => {
                                        setSelectedPostPreview(null);
                                        router.push(`/post/${selectedPostPreview.id}`);
                                    }}
                                >
                                    <Text style={styles.previewActionText}>{t('View event')}</Text>
                                </Pressable>
                            </View>
                            <Pressable accessibilityRole="button" accessibilityLabel={t('Close')} style={styles.previewClose} onPress={() => setSelectedPostPreview(null)} hitSlop={15}>
                                <Text style={styles.previewCloseText}>✕</Text>
                            </Pressable>
                        </Animated.View>
                    </SafeAreaView>
                );
            })()}

            {/* Map Preview Card (Bottom Sheet style) */}
            {selectedPostPreview && selectedPostPreview.type !== 'event' && (
                <SafeAreaView style={styles.previewCardWrapper} pointerEvents="box-none">
                    <Pressable accessibilityRole="button" accessibilityLabel={t('Close preview')} style={styles.previewCardOverlay} onPress={() => setSelectedPostPreview(null)} />
                    <Animated.View style={styles.previewCard}>
                        {selectedPostPreview.photos && selectedPostPreview.photos.length > 0 && 
                         typeof selectedPostPreview.photos[0] === 'string' &&
                         selectedPostPreview.photos[0].trim() !== '' &&
                         selectedPostPreview.photos[0] !== 'null' &&
                         selectedPostPreview.photos[0] !== 'undefined' ? (
                            <RNImage source={{ uri: selectedPostPreview.photos[0] }} style={styles.previewThumb} />
                        ) : (
                            <View style={[styles.previewThumbPlaceholder, { backgroundColor: selectedPostPreview.type === 'offer' ? colors.market.offer.bg : colors.market.need.bg }]}>
                                <Text style={{ fontSize: 36, color: '#000', lineHeight: 44, textAlign: 'center' }}>{categoryEmoji(selectedPostPreview.category)}</Text>
                            </View>
                        )}
                        <View style={styles.previewInfo}>
                            <View style={styles.previewHeader}>
                                <Text style={styles.previewCategory} numberOfLines={1}>
                                    {upperCase(categoryLabel(selectedPostPreview.category))}
                                </Text>
                                {showsBeans && (
                                <CurrencyDisplay
                                    asView={true}
                                    style={styles.previewCredits}
                                    amount={selectedPostPreview.credits}
                                />
                                )}
                            </View>
                            <Text style={styles.previewTitle} numberOfLines={1}>
                                {selectedPostPreview.title}
                            </Text>
                            <Pressable
                                accessibilityRole="button"
                                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 12 }}
                                onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: selectedPostPreview.author_pubkey, callsign: selectedPostPreview.author_callsign || t('Unknown') } })}
                            >
                                <MemberAvatar 
                                    avatarUrl={selectedPostPreview.author_avatar}
                                    pubkey={selectedPostPreview.author_pubkey || ''}
                                    callsign={selectedPostPreview.author_callsign || '?'}
                                    size={20}
                                />
                                <Text style={[styles.previewAuthor, { color: colors.brand.primary }]} numberOfLines={1}>
                                    {selectedPostPreview.author_energy_cycled && selectedPostPreview.author_energy_cycled >= 10000
                                        ? t('{name} ✨ Elder', { name: selectedPostPreview.author_callsign || selectedPostPreview.author_pubkey?.slice(0, 6) || t('Unknown') })
                                        : selectedPostPreview.author_callsign || selectedPostPreview.author_pubkey?.slice(0, 6) || t('Unknown')}
                                </Text>
                            </Pressable>
                            <Pressable
                                accessibilityRole="button"
                                style={[styles.previewActionBtn, { backgroundColor: selectedPostPreview.type === 'offer' ? colors.brand.fill : colors.action.fab }]}
                                onPress={() => {
                                    setSelectedPostPreview(null);
                                    router.push(`/post/${selectedPostPreview.id}`);
                                }}
                            >
                                <Text style={styles.previewActionText}>{t('View Details')}</Text>
                            </Pressable>
                        </View>
                        <Pressable accessibilityRole="button" accessibilityLabel={t('Close')} style={styles.previewClose} onPress={() => setSelectedPostPreview(null)} hitSlop={15}>
                            <Text style={styles.previewCloseText}>✕</Text>
                        </Pressable>
                    </Animated.View>
                </SafeAreaView>
            )}


            {/* FAB — New Post Button */}
            {!selectedPostPreview && (
                <SafeAreaView style={StyleSheet.absoluteFill} pointerEvents="box-none">
                    <TouchableOpacity
                        accessibilityRole="button"
                        style={styles.fab}
                        onPress={async () => {
                            const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
                            if (!anchorUrl) {
                                Alert.alert(
                                    t('Not Connected'),
                                    t('You need to connect to a BeanPool community before posting. Go to Settings → Advanced to add a node.'),
                                    [
                                        { text: t('Cancel'), style: 'cancel' },
                                        { text: t('Connect'), onPress: () => router.push({ pathname: '/(tabs)/settings', params: { section: 'advanced' } }) }
                                    ]
                                );
                                return;
                            }
                            // The same chooser the Market tab's + opens — one way to post — on the form's own screen.
                            router.push({ pathname: '/new-listing', params: { newPost: 'true' } });
                        }}
                        activeOpacity={0.8}
                    >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Text style={{ color: '#fff', fontSize: 20, fontWeight: '400', marginTop: -2 }}>+</Text>
                            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '800', letterSpacing: 0.5 }}>{t('ADD POST')}</Text>
                        </View>
                    </TouchableOpacity>
                </SafeAreaView>
            )}

        </View>
    );
}
