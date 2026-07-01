import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Image, Alert, Linking, Modal, Pressable, Platform, DeviceEventEmitter } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, usePathname } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSavedNodes, SavedNode, removeSavedNode } from '../utils/nodes';
import { getMemberProfile } from '../utils/db';
import { MemberAvatar } from './MemberAvatar';
import { getLastSyncTime } from '../services/pillar-sync';
import { useIdentity } from '../app/IdentityContext';
import { useTheme, useStyles } from '../app/ThemeContext';
import Constants from 'expo-constants';
import appConfig from '../app.json';

// React Native's fetch doesn't support AbortSignal.timeout natively
const fetchWithTimeout = async (resource: RequestInfo, options: RequestInit & { timeout?: number } = {}) => {
    const { timeout = 3000, ...fetchOptions } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(resource, { ...fetchOptions, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
};

function isVersionOlder(local: string, latest: string): boolean {
    const parse = (v: string) => v.split('.').map(Number);
    const localParts = parse(local);
    const latestParts = parse(latest);
    for (let i = 0; i < 3; i++) {
        const localPart = localParts[i] || 0;
        const latestPart = latestParts[i] || 0;
        if (localPart < latestPart) return true;
        if (localPart > latestPart) return false;
    }
    return false;
}

export function GlobalHeader() {
    const insets = useSafeAreaInsets();
    const pathname = usePathname();
    const { colors } = useTheme();
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        headerWrapper: {
            width: '100%',
            backgroundColor: colors.surface.card,
            borderBottomWidth: 1,
            borderBottomColor: colors.border.default,
            overflow: 'hidden',
        },
        headerAbsolute: {
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            backgroundColor: 'transparent',
            borderBottomWidth: 0,
            zIndex: 100,
            elevation: 100,
        },
        headerContainer: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: 16,
        },
        headerLeft: { flex: 1, alignItems: 'flex-start' },
        headerCenter: { flex: 2, alignItems: 'center', justifyContent: 'center' },
        headerRight: { flex: 1, alignItems: 'flex-end' },
        headerTitle: {
            color: '#ffffff',
            fontSize: 22,
            fontWeight: '900',
            letterSpacing: 0.5,
            textShadowColor: 'rgba(0,0,0,0.75)',
            textShadowOffset: { width: 0, height: 2 },
            textShadowRadius: 6,
        },
        headerLeftControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface.card, borderRadius: 20, borderWidth: 1, borderColor: theme === 'dark' ? colors.brand.primary : 'rgba(16, 185, 129, 0.3)', height: 32, width: 80, overflow: 'hidden' },
        headerLeftControlsGuest: { borderColor: colors.feedback.warning.border, backgroundColor: colors.feedback.warning.bg },
        headerLeftControlsDisconnected: { borderColor: colors.feedback.danger.border, backgroundColor: colors.feedback.danger.bg },
        headerRightControls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface.card, borderRadius: 20, borderWidth: 1, borderColor: colors.border.default, height: 32, width: 72, overflow: 'hidden' },
        controlPillBtn: { flex: 1, height: '100%', justifyContent: 'center', alignItems: 'center' },
        modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center' },
        modalContent: { backgroundColor: colors.surface.card, width: '85%', borderRadius: 16, padding: 16, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 10, shadowOffset: { width: 0, height: 10 }, elevation: 5 },
        modalVersion: { fontSize: 14, fontWeight: '900', color: colors.text.muted, letterSpacing: 1, textAlign: 'right', marginBottom: 4 },
        modalHeader: { fontSize: 13, fontWeight: '800', color: colors.text.secondary, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 12 },
        nodeBtn: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 14, paddingHorizontal: 12, borderRadius: 8, marginBottom: 4 },
        activeNodeBtn: { backgroundColor: colors.accent.tint },
        nodeTitle: { fontSize: 16, color: colors.text.heading, fontWeight: '800' },
        nodeSubText: { fontSize: 13, color: colors.text.muted, marginTop: 2 },
        activeNodeText: { color: colors.accent.primary },
        softUpdateBanner: {
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: '#064e3b',
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderBottomWidth: 1,
            borderBottomColor: '#059669',
            gap: 12,
        },
        softUpdateText: {
            color: '#ffffff',
            fontSize: 13,
            fontWeight: '700',
            flex: 1,
        },
        softUpdateUpgradeBtn: {
            backgroundColor: '#10b981',
            paddingHorizontal: 12,
            paddingVertical: 6,
            borderRadius: 8,
            justifyContent: 'center',
            alignItems: 'center',
        },
        softUpdateUpgradeText: {
            color: '#022c22',
            fontSize: 12,
            fontWeight: '900',
        },
        softUpdateDismissBtn: {
            padding: 4,
            justifyContent: 'center',
            alignItems: 'center',
        },
    }));

    const { identity } = useIdentity();
    const [myAvatar, setMyAvatar] = useState<string | null>(null);
    const [dropdownVisible, setDropdownVisible] = useState(false);
    const [savedNodes, setSavedNodes] = useState<(SavedNode & { status: 'pinging' | 'online' | 'guest' | 'offline' })[]>([]);
    const [softUpdateVersion, setSoftUpdateVersion] = useState<string | null>(null);
    const [switching, setSwitching] = useState(false);
    const [activeNode, setActiveNode] = useState<string | null>(null);
    const [activeSyncTime, setActiveSyncTime] = useState<number | null>(null);
    const membershipCache = useRef<Record<string, boolean>>({});
    const [isGuestOnActive, setIsGuestOnActive] = useState(false);
    const [isOffline, setIsOffline] = useState(false);
    const [hasAnchorUrl, setHasAnchorUrl] = useState(true);

    useEffect(() => {
        let isMounted = true;
        const pingActive = async () => {
            const active = await AsyncStorage.getItem('beanpool_anchor_url');
            if (!active) {
                if (isMounted) { setIsOffline(true); setHasAnchorUrl(false); }
                return;
            }
            if (isMounted) setHasAnchorUrl(true);
            try {
                const r = await fetchWithTimeout(`${active}/api/community/health`, { timeout: 3000 });
                if (r.ok) {
                    if (isMounted) setIsOffline(false);
                    const data = await r.json();
                    
                    const now = Date.now();
                    const lastCheckStr = await AsyncStorage.getItem('beanpool_last_version_check_time');
                    const lastChecked = lastCheckStr ? parseInt(lastCheckStr, 10) : 0;
                    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
                    
                    if (now - lastChecked > ONE_DAY_MS || !lastCheckStr) {
                        let latestVersion: string | null = null;
                        
                        if (Platform.OS === 'ios') {
                            try {
                                const iosRes = await fetchWithTimeout('https://itunes.apple.com/lookup?bundleId=org.beanpool.pillar&_t=' + now, { timeout: 4000 });
                                if (iosRes.ok) {
                                    const iosData = await iosRes.json();
                                    if (iosData.results && iosData.results.length > 0) {
                                        latestVersion = iosData.results[0].version;
                                    }
                                }
                            } catch (err) {
                                console.warn('[VersionCheck] Apple Store check failed:', err);
                            }
                        } else {
                            try {
                                const androidRes = await fetchWithTimeout('https://play.google.com/store/apps/details?id=org.beanpool.pillar&hl=en&_t=' + now, { timeout: 4000 });
                                if (androidRes.ok) {
                                    const html = await androidRes.text();
                                    const match = html.match(/\[\[\["([0-9]+\.[0-9]+\.[0-9]+)"\]\]/);
                                    if (match) {
                                        latestVersion = match[1];
                                    }
                                }
                            } catch (err) {
                                console.warn('[VersionCheck] Google Play check failed:', err);
                            }
                        }
                        
                        if (latestVersion && isMounted) {
                            const localVersion = appConfig.expo.version;
                            if (isVersionOlder(localVersion, latestVersion)) {
                                const dismissedKey = `beanpool_dismissed_update_${latestVersion}`;
                                const isDismissed = await AsyncStorage.getItem(dismissedKey);
                                if (!isDismissed && isMounted) {
                                    setSoftUpdateVersion(latestVersion);
                                } else if (isMounted) {
                                    setSoftUpdateVersion(null);
                                }
                            } else if (isMounted) {
                                setSoftUpdateVersion(null);
                            }
                            await AsyncStorage.setItem('beanpool_last_version_check_time', String(now));
                            await AsyncStorage.setItem('beanpool_latest_known_version', latestVersion);
                        }
                    } else {
                        const latestKnown = await AsyncStorage.getItem('beanpool_latest_known_version');
                        if (latestKnown && isVersionOlder(appConfig.expo.version, latestKnown)) {
                            const dismissedKey = `beanpool_dismissed_update_${latestKnown}`;
                            const isDismissed = await AsyncStorage.getItem(dismissedKey);
                            if (!isDismissed && isMounted) {
                                setSoftUpdateVersion(latestKnown);
                            } else if (isMounted) {
                                setSoftUpdateVersion(null);
                            }
                        } else if (isMounted) {
                            setSoftUpdateVersion(null);
                        }
                    }
                } else {
                    if (isMounted) setIsOffline(true);
                }
            } catch (e) {
                if (isMounted) setIsOffline(true);
            }
        };
        pingActive();
        const iv = setInterval(pingActive, 30000);
        return () => { isMounted = false; clearInterval(iv); };
    }, []);

    useEffect(() => {
        if (!identity?.publicKey) return;
        getMemberProfile(identity.publicKey)
            .then(p => { if (p?.avatar_url) setMyAvatar(p.avatar_url); })
            .catch(() => {});
    }, [identity?.publicKey]);

    useEffect(() => {
        if (!identity?.publicKey) { setIsGuestOnActive(true); return; }
        (async () => {
            const active = await AsyncStorage.getItem('beanpool_anchor_url');
            if (!active) { setIsGuestOnActive(true); return; }
            try {
                const url = `${active}/api/community/membership/${identity.publicKey}`;
                const r = await fetchWithTimeout(url, { timeout: 8000 });
                const text = await r.text();
                
                const data = JSON.parse(text);
                membershipCache.current[active] = !!data.isMember;
                setIsGuestOnActive(!data.isMember);
            } catch (err: any) {
            }
        })();
    }, [identity?.publicKey, pathname]);

    const openDropdown = async () => {
        const nodes = await getSavedNodes();
        const active = await AsyncStorage.getItem('beanpool_anchor_url');
        setActiveNode(active);
        const st = await getLastSyncTime();
        setActiveSyncTime(st);
        
        const enriched = nodes.map(n => ({ ...n, status: 'pinging' as const }));
        setSavedNodes(enriched);
        setDropdownVisible(true);

        enriched.forEach((node, idx) => {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 3000);
            fetch(`${node.url}/api/community/health`, { signal: controller.signal })
                .then(r => r.ok ? r.json() : null)
                .catch(() => null)
                .then(async (data) => {
                    clearTimeout(t);
                    if (!data) {
                        setSavedNodes(prev => {
                            const copy = [...prev];
                            copy[idx] = { ...copy[idx], status: 'offline' };
                            return copy;
                        });
                        return;
                    }

                    const remoteName = data.nodeName || data.name;
                    const cType = data.currency?.type || 'image';
                    const cVal = data.currency?.value || 'bean';

                    let isMember = false;
                    if (identity?.publicKey) {
                        try {
                            const mr = await fetchWithTimeout(`${node.url}/api/community/membership/${identity.publicKey}`, { timeout: 8000 });
                            const md = await mr.json();
                            isMember = !!md.isMember;
                            membershipCache.current[node.url] = isMember;
                        } catch (e: any) {
                            isMember = membershipCache.current[node.url] ?? false;
                        }
                    }

                    if (node.url === active) {
                        setIsGuestOnActive(!isMember);
                    }

                    const resolvedStatus = isMember ? 'online' as const : 'guest' as const;

                    setSavedNodes(prev => {
                        const copy = [...prev];
                        const changed = copy[idx].alias !== remoteName || copy[idx].currencyType !== cType || copy[idx].currencyValue !== cVal;
                        if (remoteName && changed) {
                            copy[idx] = { ...copy[idx], status: resolvedStatus, alias: remoteName, currencyType: cType, currencyValue: cVal };
                            import('../utils/nodes').then(m => m.addSavedNode(node.url, remoteName, cType, cVal));
                        } else {
                            copy[idx] = { ...copy[idx], status: resolvedStatus };
                        }
                        return copy;
                    });
                });
        });
    };

    const handleQuickSwitch = async (targetUrl: string) => {
        if (targetUrl === activeNode) {
            setDropdownVisible(false);
            return;
        }
        setSwitching(true);
        try {
            const { closeDB, initDB } = await import('../utils/db');
            await closeDB(); 
            await AsyncStorage.setItem('beanpool_anchor_url', targetUrl);
            await initDB();

            const cached = membershipCache.current[targetUrl];
            setIsGuestOnActive(cached === undefined ? true : !cached);
            if (identity?.publicKey) {
                fetchWithTimeout(`${targetUrl}/api/community/membership/${identity.publicKey}`, { timeout: 3000 })
                    .then(r => r.json())
                    .then(d => {
                        membershipCache.current[targetUrl] = !!d.isMember;
                        setIsGuestOnActive(!d.isMember);
                    })
                    .catch(() => {});
            }

            setDropdownVisible(false);
            setSwitching(false);
            router.replace('/welcome');
        } catch (e: any) {
            setSwitching(false);
            Alert.alert("Pivot Failed", e.message);
        }
    };

    const headerHeight = Math.max(insets.top + 10, 40) + 56;
    const isMapScreen = pathname === '/map';

    return (
        <View style={[styles.headerWrapper, isMapScreen && styles.headerAbsolute, { height: headerHeight }]}>
            <View style={StyleSheet.absoluteFillObject}>
                <Image
                    source={require('../assets/images/neon-vines-banner.jpg')}
                    style={[StyleSheet.absoluteFillObject, { width: '100%', height: '100%', transform: [{ scale: 1.5 }] }]}
                    resizeMode="cover"
                    accessibilityElementsHidden={true}
                    importantForAccessibility="no-hide-descendants"
                />
                <View style={[StyleSheet.absoluteFillObject, { backgroundColor: 'rgba(0,0,0,0.5)' }]} />
            </View>

            <View style={[styles.headerContainer, { paddingTop: Math.max(insets.top + 10, 40), height: headerHeight }]} pointerEvents="box-none">
                <View style={styles.headerLeft}>
                    <TouchableOpacity
                        accessibilityRole="button"
                        style={[styles.headerLeftControls, !hasAnchorUrl ? styles.headerLeftControlsDisconnected : isGuestOnActive ? styles.headerLeftControlsGuest : undefined]}
                        onPress={() => {
                            if (!hasAnchorUrl) {
                                router.push({ pathname: '/(tabs)/settings', params: { section: 'advanced' } });
                            } else {
                                DeviceEventEmitter.emit('set_people_view', { view: 'invites' });
                                router.push({ pathname: '/(tabs)/people', params: { view: 'invites' } });
                            }
                        }}
                    >
                        <MaterialCommunityIcons 
                            name={!hasAnchorUrl ? 'link-off' : isGuestOnActive ? 'account-alert-outline' : 'account-plus-outline'} 
                            size={16} 
                            color={!hasAnchorUrl ? colors.feedback.danger.fg : isGuestOnActive ? colors.feedback.warning.fg : colors.feedback.success.fg} 
                        />
                        <Text style={{ fontSize: 13, fontWeight: '700', color: !hasAnchorUrl ? colors.feedback.danger.fg : isGuestOnActive ? colors.feedback.warning.fg : colors.feedback.success.fg, marginLeft: 4 }}>
                            {!hasAnchorUrl ? 'Connect' : isGuestOnActive ? 'Join' : 'Invite'}
                        </Text>
                    </TouchableOpacity>
                </View>

                <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Switch community"
                    style={[styles.headerCenter, { zIndex: 10 }]}
                    activeOpacity={0.7}
                    onPress={openDropdown}
                >
                    <View style={{ flexDirection: 'column', alignItems: 'center', position: 'relative', transform: [{ translateX: isMapScreen ? -12 : -6 }, { translateY: isMapScreen ? -12 : 0 }] }}>
                        {isMapScreen ? (
                            <View style={{ position: 'relative' }}>
                                <Image 
                                    source={require('../assets/images/logo.png')} 
                                    style={{ width: 280, height: 76, marginTop: -8, marginBottom: -12 }} 
                                    resizeMode="contain" 
                                />
                                <View style={{ position: 'absolute', bottom: -10, right: 90, flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                                    <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: isOffline ? colors.feedback.danger.solid : isGuestOnActive ? colors.feedback.warning.solid : colors.feedback.success.solid, borderWidth: 1, borderColor: '#fff' }} />
                                    <MaterialCommunityIcons 
                                        name="chevron-down" 
                                        size={20} 
                                        color="#ffffff" 
                                        style={{ opacity: 0.9 }} 
                                    />
                                </View>
                            </View>
                        ) : (
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                <Text 
                                    style={[styles.headerTitle, { fontSize: 20, marginBottom: 0 }]}
                                    numberOfLines={1}
                                    ellipsizeMode="tail"
                                >
                                    {pathname === '/' || pathname === '/market' ? 'Marketplace' :
                                     pathname === '/projects' ? 'Projects' :
                                     pathname === '/chats' ? 'Messages' :
                                     pathname === '/people' ? 'People' :
                                     pathname === '/ledger' ? 'Ledger' :
                                     pathname === '/settings' ? 'Settings' : 'BeanPool'}
                                </Text>
                                <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: isOffline ? colors.feedback.danger.solid : isGuestOnActive ? colors.feedback.warning.solid : colors.feedback.success.solid, borderWidth: 1, borderColor: '#fff' }} />
                                <MaterialCommunityIcons name="chevron-down" size={20} color="#ffffff" style={{ opacity: 0.8, marginTop: 2 }} />
                            </View>
                        )}
                    </View>
                </TouchableOpacity>
 
                <View style={styles.headerRight}>
                    <View style={styles.headerRightControls}>
                        <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel="Open profile"
                            style={[styles.controlPillBtn, { borderRightWidth: 1, borderColor: colors.border.default }]}
                            onPress={() => {
                                if (identity?.publicKey) {
                                    router.push({ pathname: '/public-profile', params: { publicKey: identity.publicKey, callsign: identity.callsign } });
                                }
                            }}
                        >
                            <MemberAvatar avatarUrl={myAvatar} pubkey={identity?.publicKey || ''} callsign={identity?.callsign || '?'} size={24} />
                        </TouchableOpacity>
                        <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel="Settings"
                            style={styles.controlPillBtn}
                            onPress={() => {
                                if (pathname === '/settings') {
                                    if (router.canGoBack()) {
                                        router.back();
                                    } else {
                                        router.replace('/(tabs)/');
                                    }
                                } else {
                                    router.push('/(tabs)/settings');
                                }
                            }}
                        >
                            <MaterialCommunityIcons name="tune" size={17} color={pathname === '/settings' ? colors.accent.primary : colors.text.secondary} />
                        </TouchableOpacity>
                    </View>
                </View>
            </View>

            {softUpdateVersion && (
                <View style={styles.softUpdateBanner}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 8 }}>
                        <Text style={{ fontSize: 18 }}>💡</Text>
                        <Text style={styles.softUpdateText} numberOfLines={2}>
                            Update available: upgrade to v{softUpdateVersion} for the latest community features!
                        </Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <TouchableOpacity
                            accessibilityRole="button"
                            style={styles.softUpdateUpgradeBtn}
                            onPress={() => {
                                const storeUrl = Platform.OS === 'ios'
                                    ? 'itms-apps://itunes.apple.com/app/id6761870086'
                                    : 'market://details?id=org.beanpool.pillar';
                                Linking.openURL(storeUrl).catch(() => {
                                    const webUrl = Platform.OS === 'ios'
                                        ? 'https://apps.apple.com/us/app/bean-pool/id6761870086'
                                        : 'https://play.google.com/store/apps/details?id=org.beanpool.pillar';
                                    Linking.openURL(webUrl);
                                });
                            }}
                        >
                            <Text style={styles.softUpdateUpgradeText}>Upgrade</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel="Close"
                            style={styles.softUpdateDismissBtn}
                            onPress={async () => {
                                const dismissedKey = `beanpool_dismissed_update_${softUpdateVersion}`;
                                await AsyncStorage.setItem(dismissedKey, 'true');
                                setSoftUpdateVersion(null);
                            }}
                        >
                            <MaterialCommunityIcons name="close" size={16} color="#ffffff" />
                        </TouchableOpacity>
                    </View>
                </View>
            )}

            <Modal visible={dropdownVisible} transparent animationType="fade">
                <Pressable accessibilityRole="button" accessibilityLabel="Close" style={styles.modalBg} onPress={() => setDropdownVisible(false)}>
                    <View style={[styles.modalContent, { marginTop: insets.top + 80 }]}>
                        <Text style={styles.modalVersion}>v{appConfig.expo.version} ({Platform.OS === 'ios' ? appConfig.expo.ios.buildNumber : appConfig.expo.android.versionCode})</Text>
                        <Text style={styles.modalHeader}>Select Community</Text>
                        {savedNodes.length === 0 && (
                            <View style={{ padding: 14 }}>
                                <Text style={{ fontSize: 14, color: colors.text.body, lineHeight: 20 }}>
                                    {!hasAnchorUrl
                                        ? '🔴 No community connected.\n\nAsk a friend for an invite link, or tap the Connect button to add a node manually.'
                                        : 'No saved communities.'}
                                </Text>
                            </View>
                        )}
                        {savedNodes.map((n, i) => {
                            const isCurrent = activeNode === n.url;
                            const isGuest = n.status === 'guest';
                            
                            let activeStatusText = 'Syncing...';
                            if (isCurrent && activeSyncTime && !isGuest) {
                                const seconds = Math.floor((Date.now() - activeSyncTime) / 1000);
                                if (seconds < 60) activeStatusText = `${seconds}s ago`;
                                else if (seconds < 3600) activeStatusText = `${Math.floor(seconds / 60)}m ago`;
                                else activeStatusText = `${Math.floor(seconds / 3600)}h ago`;
                            }

                            const dotColor = n.status === 'pinging' ? colors.text.muted 
                                : n.status === 'online' ? colors.feedback.success.solid 
                                : n.status === 'guest' ? colors.feedback.warning.solid 
                                : colors.feedback.danger.solid;

                            return (
                                <TouchableOpacity
                                    accessibilityRole="button"
                                    key={i}
                                    style={[styles.nodeBtn, isCurrent && styles.activeNodeBtn]}
                                    onPress={() => handleQuickSwitch(n.url)}
                                    onLongPress={() => {
                                        Alert.alert(
                                            "Remove Community?",
                                            "Do you want to remove this community from your saved list?",
                                            [
                                                { text: "Cancel", style: "cancel" },
                                                { text: "Remove", style: "destructive", onPress: async () => {
                                                    await removeSavedNode(n.url);
                                                    setSavedNodes(prev => prev.filter(node => node.url !== n.url));
                                                }}
                                            ]
                                        );
                                    }}
                                    delayLongPress={500}
                                    disabled={switching}
                                >
                                    <View style={{ flex: 1 }}>
                                        <Text style={[styles.nodeTitle, isCurrent && styles.activeNodeText]} numberOfLines={1}>
                                            {n.alias || "Local Discovery"}
                                        </Text>
                                        <Text style={[styles.nodeSubText, isCurrent && styles.activeNodeText]} numberOfLines={1}>
                                            {n.url}
                                        </Text>
                                    </View>
                                    <View style={{ alignItems: 'flex-end', justifyContent: 'center' }}>
                                        {isCurrent ? (
                                            <View style={{ alignItems: 'flex-end' }}>
                                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                                    <Text style={{ fontSize: 13, color: isGuest ? colors.feedback.warning.fg : colors.feedback.success.fg, fontWeight: 'bold' }}>
                                                        {isGuest ? 'Guest Mode' : activeStatusText}
                                                    </Text>
                                                    <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: dotColor }} />
                                                </View>
                                                {isGuest && (
                                                    <Text style={{ fontSize: 11, color: colors.feedback.warning.fg, marginTop: 2 }}>Tap Join to register</Text>
                                                )}
                                            </View>
                                        ) : (
                                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                                {isGuest && <Text style={{ fontSize: 11, color: colors.feedback.warning.fg, fontWeight: '600' }}>Guest</Text>}
                                                <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: dotColor }} />
                                            </View>
                                        )}
                                    </View>
                                </TouchableOpacity>
                            );
                        })}
                    </View>
                </Pressable>
            </Modal>
        </View>
    );
}

