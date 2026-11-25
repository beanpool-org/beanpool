/**
 * Shared form controls for Offer/Need create (app/new-listing.tsx) and edit (app/post/[id].tsx).
 *
 * One copy of the cash-also-needed toggle + Need/Offer nudge, the federation reach chooser, the
 * location chips, and the pin-drop map modal, so create and edit always carry the same words,
 * rules, and central colour tokens (dark mode + 320 dp × 1.3 font).
 */
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { t, upperCase, word } from '@beanpool/core';
import { Alert } from '../utils/keyboard-alert';
import { useStyles, useTheme } from '../app/ThemeContext';
import { HAS_MAPS_KEY } from '../utils/maps';
import { darkMapStyle, mapSchemeKey } from '../utils/map-scheme';

/** Shared read-only reason lines for fields the node keeps fixed on edit. */
export const EDIT_LOCK_LINES = {
    typeFixed: word('Listing type stays as posted. To switch between Offer and Need, create a new post.'),
    priceFrozen: word('This post has a deal in progress, so its price can’t change until that deal is finished. To change the price, cancel or decline the deal first.'),
    lendableRepeatable: word('Lendable offers stay active for repeat loans.'),
    audienceFixed: word('Who can see it stays as it is.'),
} as const;

export type ReachChoice = 'local' | 'peers' | 'everywhere';
export interface ReachPeerOption { peerId: string; callsign: string | null }

/** Parse a stored reach_peers value (JSON string or string[]) into a clean string array. */
export function parseStoredReachPeers(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string' && x.length > 0);
    if (typeof raw === 'string' && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
        } catch {}
    }
    return [];
}

/** Round a GPS coordinate to four decimal places (~11 m), matching the create form. */
const roundCoord = (deg: number) => Math.round(deg * 10000) / 10000;

/**
 * Request the device's GPS position rounded to 4 decimals (~11 m), matching the create form.
 * Loads expo-location dynamically so screens importing this helper stay safe in non-native test envs.
 */
export async function requestDeviceLocation(): Promise<{ lat: number; lng: number } | null> {
    const Location = await import('expo-location');
    const { status: initStatus, canAskAgain } = await Location.getForegroundPermissionsAsync();
    let status = initStatus;
    if (status !== 'granted') {
        if (canAskAgain) {
            const res = await Location.requestForegroundPermissionsAsync();
            status = res.status;
        } else {
            Alert.alert(
                t('Permission Denied'),
                t('Location permission was denied. Please enable it in your device settings to use your current location.'),
                [
                    { text: t('Cancel'), style: 'cancel' },
                    { text: t('Open Settings'), onPress: () => Linking.openSettings() },
                ],
            );
            return null;
        }
    }
    if (status !== 'granted') return null;
    try {
        const loc = await Location.getCurrentPositionAsync({});
        return {
            lat: roundCoord(loc.coords.latitude),
            lng: roundCoord(loc.coords.longitude),
        };
    } catch {
        Alert.alert(t('Error'), t("Could not get your location. Try 'Drop a pin' instead."));
        return null;
    }
}

/**
 * #108 Cash-also-needed toggle + Need/Offer-aware nudge.
 * No amount field by design: the app can escrow Beans, not cash, so terms live in chat.
 * On a Need the poster is the one who pays, so the wording flips (Marty, 14 Nov 2026).
 */
export function CashAlsoNeededField({
    checked,
    onChange,
    type,
    testID = 'cash-also-needed-toggle',
}: {
    checked: boolean;
    onChange: (next: boolean) => void;
    type: 'offer' | 'need';
    testID?: string;
}) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, minHeight: 44, marginBottom: 4 },
        checkbox: { width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: colors.border.strong, backgroundColor: 'transparent', justifyContent: 'center', alignItems: 'center' },
        checkboxCash: { backgroundColor: colors.feedback.warning.solid, borderColor: colors.feedback.warning.solid },
        checkboxTick: { color: colors.text.onGold, fontSize: 14, fontWeight: '800' },
        label: { flex: 1, flexShrink: 1, color: colors.text.secondary, fontSize: 13, fontWeight: '500', lineHeight: 18 },
        nudge: {
            color: colors.feedback.warning.fg,
            backgroundColor: colors.feedback.warning.bg,
            borderColor: colors.feedback.warning.border,
            borderWidth: 1,
            borderRadius: 10,
            paddingHorizontal: 10,
            paddingVertical: 8,
            fontSize: 12,
            lineHeight: 17,
            marginBottom: 8,
        },
    }));

    return (
        <View>
            <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked, selected: checked }}
                style={styles.row}
                onPress={() => onChange(!checked)}
                testID={testID}
            >
                <View style={[styles.checkbox, checked && styles.checkboxCash]}>
                    {checked && <Text style={styles.checkboxTick}>✓</Text>}
                </View>
                <Text style={styles.label}>
                    {type === 'need'
                        ? t("💸 I'll pay cash too — for fuel or materials")
                        : t('💸 Cash also needed — for fuel or materials')}
                </Text>
            </Pressable>
            {checked && (
                <Text style={styles.nudge} testID={`${testID}-nudge`}>
                    {type === 'need'
                        ? t('Cash covers fuel or materials the helper buys — at cost, not their time or tools.')
                        : t('Cash is for fuel and consumables you paid for — not your time, not your tools. At cost, no markup. Agree the details in chat; the app never handles the money.')}
                </Text>
            )}
        </View>
    );
}

/**
 * #143 step 4 — per-listing reach chooser ("Where does this travel?").
 * Shown only when this community actually has trading partners (`peerList.length > 0`).
 */
export function ListingReachField({
    reach,
    onReachChange,
    reachPeers,
    onReachPeersChange,
    peerList,
    testID = 'listing-reach-field',
}: {
    reach: ReachChoice;
    onReachChange: (next: ReachChoice) => void;
    reachPeers: string[];
    onReachPeersChange: (next: string[]) => void;
    peerList: readonly ReachPeerOption[];
    testID?: string;
}) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        section: { marginTop: 8, marginBottom: 8 },
        label: { color: colors.text.secondary, fontSize: 13, fontWeight: '600', marginBottom: 6 },
        buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
        button: {
            flexGrow: 1, flexBasis: '28%', paddingVertical: 10, paddingHorizontal: 6, borderRadius: 12, borderWidth: 1,
            borderColor: colors.border.default, backgroundColor: colors.surface.app,
            alignItems: 'center', justifyContent: 'center', minHeight: 44,
        },
        buttonActive: { backgroundColor: colors.brand.fill, borderColor: colors.brand.primary },
        buttonText: { fontSize: 12, fontWeight: '600', color: colors.text.secondary, textAlign: 'center' },
        buttonTextActive: { color: colors.text.onBrand, fontWeight: '700' },
        peerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
        peerChip: {
            paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20, borderWidth: 1,
            borderColor: colors.border.default, backgroundColor: colors.surface.app, minHeight: 44, justifyContent: 'center',
        },
        peerChipActive: { backgroundColor: colors.brand.fill, borderColor: colors.brand.primary },
        peerChipText: { fontSize: 12, fontWeight: '600', color: colors.text.secondary },
        peerChipTextActive: { color: colors.text.onBrand, fontWeight: '700' },
        peerHint: { color: colors.text.muted, fontSize: 11, fontWeight: '500', fontStyle: 'italic', paddingVertical: 4 },
    }));

    if (peerList.length === 0) return null;

    return (
        <View style={styles.section} testID={testID}>
            <Text style={styles.label}>{t('Where does this travel?')}</Text>
            <View style={styles.buttonRow}>
                {([
                    { value: 'local' as const, label: t('🏠 Stays here') },
                    { value: 'peers' as const, label: t('🤝 Chosen') },
                    { value: 'everywhere' as const, label: t('🌏 Everywhere') },
                ]).map(opt => (
                    <Pressable
                        key={opt.value}
                        accessibilityRole="button"
                        accessibilityState={{ selected: reach === opt.value }}
                        testID={`${testID}-${opt.value}`}
                        style={[styles.button, reach === opt.value && styles.buttonActive]}
                        onPress={() => onReachChange(opt.value)}
                    >
                        <Text style={[styles.buttonText, reach === opt.value && styles.buttonTextActive]}>{opt.label}</Text>
                    </Pressable>
                ))}
            </View>
            {reach === 'peers' && (
                <View style={styles.peerRow}>
                    {peerList.map((p, index) => {
                        const on = reachPeers.includes(p.peerId);
                        const peerLabel = p.callsign || (p.peerId ? t('Peer {id}', { id: p.peerId.slice(-8) }) : t('Peer'));
                        return (
                            <Pressable
                                key={p.peerId || index}
                                accessibilityRole="button"
                                accessibilityLabel={t('Community {name}', { name: peerLabel })}
                                accessibilityState={{ selected: on }}
                                style={[styles.peerChip, on && styles.peerChipActive]}
                                onPress={() => onReachPeersChange(on ? reachPeers.filter(x => x !== p.peerId) : [...reachPeers, p.peerId])}
                            >
                                <Text style={[styles.peerChipText, on && styles.peerChipTextActive]}>
                                    {on ? '✓ ' : ''}{peerLabel}
                                </Text>
                            </Pressable>
                        );
                    })}
                    {reachPeers.length === 0 && (
                        <Text style={styles.peerHint}>{t('Tap a community to include it')}</Text>
                    )}
                </View>
            )}
        </View>
    );
}

/**
 * Location chip row ("My location" / "Drop a pin" / "✓ Set") shared by create and edit.
 */
export function ListingLocationRow({
    hasLocation,
    pinDropActive = false,
    invalid = false,
    required = true,
    onUseMyLocation,
    onDropPin,
    testID = 'listing-location-row',
}: {
    hasLocation: boolean;
    pinDropActive?: boolean;
    invalid?: boolean;
    required?: boolean;
    onUseMyLocation: () => void;
    onDropPin: () => void;
    testID?: string;
}) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        sectionLabel: { color: colors.text.secondary, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4, marginTop: 4 },
        requiredStar: { color: colors.feedback.danger.fg, fontSize: 12 },
        row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8, alignItems: 'center' },
        chip: {
            flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingHorizontal: 12,
            minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.app,
        },
        chipActive: { borderColor: colors.brand.primary, backgroundColor: colors.brand.tint },
        chipInvalid: { borderColor: colors.feedback.danger.fg, borderWidth: 2 },
        icon: { fontSize: 15 },
        label: { fontSize: 13, fontWeight: '700', color: colors.text.secondary },
        confirm: { color: colors.brand.primary, fontSize: 13, fontWeight: '800' },
    }));

    return (
        <View testID={testID}>
            <Text style={styles.sectionLabel}>
                {upperCase(t('Location'))}
                {required ? <Text style={styles.requiredStar}> *</Text> : null}
            </Text>
            <View style={styles.row}>
                <Pressable
                    accessibilityRole="button"
                    testID={`${testID}-my-location`}
                    style={[styles.chip, hasLocation && !pinDropActive && styles.chipActive, invalid && styles.chipInvalid]}
                    onPress={onUseMyLocation}
                >
                    <Text style={styles.icon}>📍</Text>
                    <Text style={styles.label}>{t('My location')}</Text>
                </Pressable>
                <Pressable
                    accessibilityRole="button"
                    testID={`${testID}-drop-pin`}
                    style={[styles.chip, pinDropActive && styles.chipActive, invalid && styles.chipInvalid]}
                    onPress={onDropPin}
                >
                    <Text style={styles.icon}>📌</Text>
                    <Text style={styles.label}>{t('Drop a pin')}</Text>
                </Pressable>
                {hasLocation && (
                    <Text style={styles.confirm} testID={`${testID}-set`}>{t('✓ Set')}</Text>
                )}
            </View>
        </View>
    );
}

const PIN_MAP_DEFAULT = { latitude: -28.5398, longitude: 153.4996, latitudeDelta: 0.0922, longitudeDelta: 0.0421 };

/**
 * Full-screen pin-drop modal for the Edit Post form.
 * Dynamically imports `react-native-maps` and `MapAreaRing` only when opened so non-map screens
 * and jsdom render tests never pull in native map bindings at module load time.
 */
export function ListingPinDropModal({
    visible,
    initialLat,
    initialLng,
    postType,
    onConfirm,
    onCancel,
}: {
    visible: boolean;
    initialLat: number | null;
    initialLng: number | null;
    postType: 'offer' | 'need';
    onConfirm: (lat: number, lng: number) => void;
    onCancel: () => void;
}) {
    const { theme, colors } = useTheme();
    const insets = useSafeAreaInsets();
    const [pickedLat, setPickedLat] = useState<number | null>(initialLat);
    const [pickedLng, setPickedLng] = useState<number | null>(initialLng);
    const [nodeRadius, setNodeRadius] = useState<{ lat: number; lng: number; radiusKm: number } | null>(null);
    const [mapKit, setMapKit] = useState<{ MapView: any; Marker: any; PROVIDER_DEFAULT: any; MapAreaRing: any } | null>(null);
    const mapRef = useRef<any>(null);

    useEffect(() => {
        if (!visible) return;
        setPickedLat(initialLat);
        setPickedLng(initialLng);
        let cancelled = false;
        void Promise.all([import('react-native-maps'), import('./MapAreaRing')])
            .then(([maps, ring]) => {
                if (!cancelled) {
                    setMapKit({
                        MapView: maps.default,
                        Marker: maps.Marker,
                        PROVIDER_DEFAULT: maps.PROVIDER_DEFAULT,
                        MapAreaRing: ring.MapAreaRing,
                    });
                }
            })
            .catch(() => {});
        void (async () => {
            try {
                const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
                if (!anchorUrl) return;
                const res = await fetch(`${anchorUrl}/api/node/config`);
                if (!res.ok) return;
                const config = await res.json();
                if (!cancelled && config?.serviceRadius && typeof config.serviceRadius.lat === 'number' && typeof config.serviceRadius.lng === 'number') {
                    setNodeRadius(config.serviceRadius);
                }
            } catch {}
        })();
        return () => { cancelled = true; };
    }, [visible, initialLat, initialLng]);

    useEffect(() => {
        if (visible && nodeRadius && initialLat == null && pickedLat == null) {
            mapRef.current?.animateToRegion({
                latitude: nodeRadius.lat,
                longitude: nodeRadius.lng,
                latitudeDelta: 0.0922,
                longitudeDelta: 0.0421,
            }, 300);
        }
    }, [visible, nodeRadius, initialLat, pickedLat]);

    const styles = useStyles(({ colors }) => StyleSheet.create({
        wrap: { flex: 1, backgroundColor: colors.surface.app },
        map: { flex: 1 },
        banner: {
            position: 'absolute', left: 20, right: 20, backgroundColor: colors.feedback.info.solid,
            borderRadius: 12, paddingVertical: 10, paddingHorizontal: 16, alignItems: 'center', zIndex: 20,
        },
        bannerText: { color: colors.text.inverse, fontWeight: '700', fontSize: 14, textAlign: 'center' },
        footerWrap: { position: 'absolute', bottom: 0, left: 0, right: 0 },
        footer: {
            backgroundColor: colors.surface.card, padding: 16, borderTopLeftRadius: 20, borderTopRightRadius: 20,
            flexDirection: 'row', alignItems: 'center', gap: 12, elevation: 20,
        },
        cancelBtn: { flex: 1, minHeight: 48, justifyContent: 'center', backgroundColor: colors.surface.subtle, borderRadius: 12, alignItems: 'center' },
        cancelText: { color: colors.text.body, fontWeight: '700', fontSize: 14 },
        confirmBtn: { flex: 1, minHeight: 48, justifyContent: 'center', backgroundColor: colors.brand.fill, borderRadius: 12, alignItems: 'center' },
        confirmBtnDisabled: { backgroundColor: colors.surface.subtle },
        confirmText: { color: colors.text.onBrand, fontWeight: '800', fontSize: 14 },
        confirmTextDisabled: { color: colors.text.muted },
        fallback: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.surface.subtle, padding: 24 },
        fallbackTitle: { color: colors.text.body, fontWeight: '700', textAlign: 'center' },
        fallbackSub: { marginTop: 4, color: colors.text.secondary, fontSize: 12, textAlign: 'center' },
    }));

    if (!visible) return null;

    const initialRegion = initialLat != null && initialLng != null
        ? { latitude: initialLat, longitude: initialLng, latitudeDelta: 0.04, longitudeDelta: 0.02 }
        : nodeRadius
            ? { latitude: nodeRadius.lat, longitude: nodeRadius.lng, latitudeDelta: 0.0922, longitudeDelta: 0.0421 }
            : PIN_MAP_DEFAULT;

    const handlePress = (e: any) => {
        const { latitude, longitude } = e.nativeEvent.coordinate;
        setPickedLat(roundCoord(latitude));
        setPickedLng(roundCoord(longitude));
    };

    const MapViewComp = mapKit?.MapView;
    const MarkerComp = mapKit?.Marker;
    const RingComp = mapKit?.MapAreaRing;

    return (
        <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
            <View style={styles.wrap} testID="edit-pin-drop-modal">
                {!HAS_MAPS_KEY ? (
                    <View style={styles.fallback}>
                        <Text style={styles.fallbackTitle}>{t('Google Maps is not configured')}</Text>
                        <Text style={styles.fallbackSub}>{t('API key is missing in build config.')}</Text>
                    </View>
                ) : !MapViewComp ? (
                    <View style={styles.fallback} testID="edit-pin-drop-loading">
                        <ActivityIndicator color={colors.brand.primary} />
                    </View>
                ) : (
                    <MapViewComp
                        key={mapSchemeKey(Platform.OS, theme === 'dark')}
                        ref={mapRef}
                        style={styles.map}
                        provider={mapKit.PROVIDER_DEFAULT}
                        userInterfaceStyle={theme === 'dark' ? 'dark' : 'light'}
                        customMapStyle={theme === 'dark' ? darkMapStyle : undefined}
                        showsUserLocation={true}
                        showsMyLocationButton={false}
                        toolbarEnabled={false}
                        initialRegion={initialRegion}
                        onPress={handlePress}
                        onLongPress={handlePress}
                    >
                        {nodeRadius && nodeRadius.radiusKm > 0 && RingComp && (
                            <RingComp area={nodeRadius} darkMap={theme === 'dark'} />
                        )}
                        {pickedLat != null && pickedLng != null && MarkerComp && (
                            <MarkerComp
                                coordinate={{ latitude: pickedLat, longitude: pickedLng }}
                                pinColor={postType === 'offer' ? colors.brand.fill : colors.action.fab}
                                draggable
                                onDragEnd={handlePress}
                            />
                        )}
                    </MapViewComp>
                )}

                {HAS_MAPS_KEY && MapViewComp && (
                    <View style={[styles.banner, { top: insets.top + 16 }]} pointerEvents="none">
                        <Text style={styles.bannerText}>{t('📌 Tap the map to place your pin')}</Text>
                    </View>
                )}

                <SafeAreaView style={styles.footerWrap} edges={['bottom']} pointerEvents="box-none">
                    <View style={styles.footer}>
                        <Pressable accessibilityRole="button" style={styles.cancelBtn} onPress={onCancel}>
                            <Text style={styles.cancelText}>{t('Cancel')}</Text>
                        </Pressable>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ disabled: pickedLat == null || pickedLng == null }}
                            style={[styles.confirmBtn, pickedLat == null && styles.confirmBtnDisabled]}
                            disabled={pickedLat == null || pickedLng == null}
                            onPress={() => { if (pickedLat != null && pickedLng != null) onConfirm(pickedLat, pickedLng); }}
                        >
                            <Text style={[styles.confirmText, pickedLat == null && styles.confirmTextDisabled]}>
                                {pickedLat != null ? t('Confirm Pin ✓') : t('Confirm Pin')}
                            </Text>
                        </Pressable>
                    </View>
                </SafeAreaView>
            </View>
        </Modal>
    );
}
