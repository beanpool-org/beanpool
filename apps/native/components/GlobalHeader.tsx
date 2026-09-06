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
import { evaluateUpdate, normaliseVersion, pickStoreVersion } from '../utils/app-version';

// The floor is a property of the COMMUNITY, not of the phone: two nodes can disagree about
// which builds they still work with. Cached per node so switching community — or being
// offline on a different one — cannot carry the wrong floor across.
const minVersionKey = (nodeUrl: string) => `beanpool_min_app_version_${nodeUrl}`;

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
    // The installed build is below the node's declared floor — a banner you cannot dismiss,
    // because the app genuinely will not behave against this node until it is updated.
    const [updateRequired, setUpdateRequired] = useState(false);
    const [switching, setSwitching] = useState(false);
    const [activeNode, setActiveNode] = useState<string | null>(null);
    const [activeSyncTime, setActiveSyncTime] = useState<number | null>(null);
    const membershipCache = useRef<Record<string, boolean>>({});
    const [isGuestOnActive, setIsGuestOnActive] = useState(false);
    const [isOffline, setIsOffline] = useState(false);
    const [hasAnchorUrl, setHasAnchorUrl] = useState(true);
    // In-memory mirror of the version facts already on disk. Storage is read once and written
    // only when something actually changes. The node refreshes its store lookup every 6 hours
    // and the app's own version cannot change while it is running, so the 30-second ping was
    // re-writing byte-identical values roughly 2,880 times a day for nothing.
    const versionRef = useRef<{
        latestLoaded: boolean;
        latest: string | null;
        minKey: string | null;
        minimum: string | null;
        dismissed: Map<string, boolean>;
        attemptAt: number;
    }>({ latestLoaded: false, latest: null, minKey: null, minimum: null, dismissed: new Map(), attemptAt: 0 });
    // Consecutive failed health pings — see the ping effect below (debounce + recent-sync grace).
    const healthFailuresRef = useRef(0);

    useEffect(() => {
        let isMounted = true;
        // A single failed health ping shouldn't paint the node "offline": phone radios
        // wake slowly (a cold TLS handshake can exceed a short timeout) and the JS thread
        // can be busy applying a sync. Only show offline after 2 consecutive misses AND
        // when no pillar sync landed recently — a recent sync proves the node is reachable
        // regardless of what this lightweight ping does.
        const markHealthFailure = async (nodeUrl: string) => {
            if (!isMounted) return;
            // A ping that resolves after the user switched community is answering about a
            // node they have left. An 8-second timeout on a slow node used to land after a
            // fast one had already answered, and painted the fast one offline.
            try {
                if ((await AsyncStorage.getItem('beanpool_anchor_url')) !== nodeUrl) return;
            } catch { /* storage unavailable — fall through and count it */ }
            healthFailuresRef.current += 1;
            let syncedRecently = false;
            try {
                const st = await getLastSyncTime();
                syncedRecently = !!st && (Date.now() - st) < 90_000;
            } catch {}
            if (isMounted && healthFailuresRef.current >= 2 && !syncedRecently) {
                setIsOffline(true);
            }
        };
        // ── Update banner ────────────────────────────────────────────────────────────
        // The store lookup now happens on the NODE (apps/server/src/app-store-versions.ts)
        // and rides along in the health payload this ping already fetches. The phone
        // compares two short strings; it no longer downloads the 1.1 MB Play Store
        // listing page over its own connection to read one number out of it.
        // How often the "we checked" timestamp is worth persisting. Nothing reads it on a hot
        // path — it is a diagnostic — so writing it on every 30-second tick was 2,880 SQLite
        // transactions a day to record the same fact.
        const ATTEMPT_RECORD_MS = 30 * 60 * 1000;

        // Only a positive is remembered. Caching "not dismissed" would freeze a transient read
        // failure into the session — and each tab screen builds its own header, so one tab
        // caching a stale negative would keep showing a banner another tab had just cleared.
        // A miss costs one read, and only while a banner is actually on screen.
        const isDismissed = async (version: string) => {
            const cache = versionRef.current.dismissed;
            if (cache.get(version)) return true;
            try {
                if ((await AsyncStorage.getItem(`beanpool_dismissed_update_${version}`)) === 'true') {
                    cache.set(version, true);
                    return true;
                }
            } catch { /* storage unavailable — treat as not dismissed, and ask again next tick */ }
            return false;
        };

        const applyVersionState = async (latest: string | null, minimum: string | null) => {
            const state = evaluateUpdate(appConfig.expo.version, latest, minimum);
            if (state.kind === 'none') {
                if (isMounted) { setSoftUpdateVersion(null); setUpdateRequired(false); }
                return;
            }
            if (state.kind === 'available' && await isDismissed(state.version)) {
                if (isMounted) { setSoftUpdateVersion(null); setUpdateRequired(false); }
                return;
            }
            if (isMounted) { setSoftUpdateVersion(state.version); setUpdateRequired(state.kind === 'required'); }
        };

        // Everything the banner touches in storage lives in here, deliberately OUTSIDE the
        // try whose catch marks the node offline: these writes used to sit inside it, so a
        // storage failure would have painted a perfectly healthy community red.
        //
        // Fresh values win; anything the node did not send falls back to what it told us last
        // time. That matters in two directions: an older node sends neither field and should
        // not clear a banner it has nothing to say about, and a phone with no anchor, an
        // offline node, or guest mode should still show what it already knows. The whole check
        // used to sit inside `if (r.ok)`, so none of those states checked at all.
        const updateVersionBanner = async (nodeUrl: string | null, data: any | null) => {
            try {
                // A community switch can land while a ping is in flight. Applying the old
                // node's floor to the new one would be wrong, so drop the stale answer.
                if (nodeUrl && (await AsyncStorage.getItem('beanpool_anchor_url')) !== nodeUrl) return;
                const v = versionRef.current;
                const now = Date.now();
                const minKey = nodeUrl ? minVersionKey(nodeUrl) : null;

                // Seed the mirror from disk once — and again for a community we have not seen
                // this session, since the floor is per node.
                if (!v.latestLoaded) {
                    v.latest = await AsyncStorage.getItem('beanpool_latest_known_version');
                    v.latestLoaded = true;
                }
                if (minKey !== v.minKey) {
                    // Read FIRST, then commit both together. Assigning the key before the read
                    // means a storage error leaves the new node's key paired with the previous
                    // node's floor — the cross-community poisoning this key exists to prevent,
                    // reintroduced through the error path. Failing here retries next tick.
                    const loaded = minKey ? await AsyncStorage.getItem(minKey) : null;
                    v.minKey = minKey;
                    v.minimum = loaded;
                }

                const latest = data ? pickStoreVersion(data?.appVersions, Platform.OS) : null;
                const minimum = data ? normaliseVersion(data?.minAppVersion) : null;

                // Recorded whatever the outcome — the old code wrote this only inside the
                // success branch, so a failed check looked like no check at all and the app
                // retried on every ping, 1.1 MB a time on a metered connection. Rate-limited
                // because it is the only one of these writes with nothing to compare against.
                if (now - v.attemptAt > ATTEMPT_RECORD_MS) {
                    v.attemptAt = now;
                    await AsyncStorage.setItem('beanpool_last_version_check_time', String(now));
                }
                // Commit the mirror only once the write has landed — the same rule as the read
                // path above, and for the same reason. Marking it written first means a storage
                // throw leaves memory claiming a value disk does not have, the next tick sees no
                // difference and never retries, and a restart silently reverts to the old one.
                if (latest && latest !== v.latest) {
                    await AsyncStorage.setItem('beanpool_latest_known_version', latest);
                    v.latest = latest;
                }
                if (minimum && minKey && minimum !== v.minimum) {
                    await AsyncStorage.setItem(minKey, minimum);
                    v.minimum = minimum;
                }

                await applyVersionState(latest ?? v.latest, minimum ?? v.minimum);
            } catch { /* storage unavailable — the banner keeps whatever it already had */ }
        };

        const pingActive = async () => {
            const active = await AsyncStorage.getItem('beanpool_anchor_url');
            if (!active) {
                if (isMounted) { setIsOffline(true); setHasAnchorUrl(false); }
                await updateVersionBanner(null, null);
                return;
            }
            if (isMounted) setHasAnchorUrl(true);
            try {
                const r = await fetchWithTimeout(`${active}/api/community/health`, { timeout: 8000 });
                if (r.ok) {
                    healthFailuresRef.current = 0;
                    if (isMounted) setIsOffline(false);
                    const data = await r.json();
                    await updateVersionBanner(active, data);
                } else {
                    await markHealthFailure(active);
                    await updateVersionBanner(active, null);
                }
            } catch (e) {
                await markHealthFailure(active);
                await updateVersionBanner(active, null);
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

    // The header ROW's height. Deliberately not applied to the wrapper below: the wrapper
    // is `overflow: hidden`, so pinning it to this height clipped the update banner out of
    // existence — the banner rendered, on both platforms, and could never be seen. The
    // wrapper now sizes to its children (header row + banner, when there is one).
    const headerHeight = Math.max(insets.top + 10, 40) + 56;
    const isMapScreen = pathname === '/map';

    return (
        <View style={[styles.headerWrapper, isMapScreen && styles.headerAbsolute]}>
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
                        accessibilityLabel={!hasAnchorUrl ? 'Connect to community' : isGuestOnActive ? 'Join community' : 'Invite friends'}
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
                        <Text style={{ fontSize: 18 }}>{updateRequired ? '⚠️' : '💡'}</Text>
                        <Text style={styles.softUpdateText} numberOfLines={2}>
                            {updateRequired
                                ? `Your app is too old for this community — update to v${softUpdateVersion}.`
                                : `Update available — v${softUpdateVersion} has the latest community features.`}
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
                        {/* No dismiss below the node's floor: clearing it would hide the reason
                            the app is misbehaving, and the next ping would raise it again anyway. */}
                        {!updateRequired && (
                            <TouchableOpacity
                                accessibilityRole="button"
                                accessibilityLabel="Close"
                                style={styles.softUpdateDismissBtn}
                                onPress={async () => {
                                    // Remember it in memory too, so the next 30-second ping does not
                                    // read the same key back off disk to re-learn what we just did.
                                    if (softUpdateVersion) versionRef.current.dismissed.set(softUpdateVersion, true);
                                    setSoftUpdateVersion(null);
                                    // A failed write should cost you the MEMORY of the dismissal,
                                    // not the ability to dismiss: an unhandled rejection here left
                                    // the banner on screen with its close button doing nothing.
                                    try {
                                        await AsyncStorage.setItem(`beanpool_dismissed_update_${softUpdateVersion}`, 'true');
                                    } catch { /* dismissed for this session only */ }
                                }}
                            >
                                <MaterialCommunityIcons name="close" size={16} color="#ffffff" />
                            </TouchableOpacity>
                        )}
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

