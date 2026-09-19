import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TouchableOpacity, Image, Linking, Pressable, Platform, DeviceEventEmitter, AppState, type AppStateStatus } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, usePathname } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { withJitter } from '../utils/jitter';
import { getMemberProfile } from '../utils/db';
import { MemberAvatar } from './MemberAvatar';
import { getLastSyncTime } from '../services/pillar-sync';
import { useIdentity } from '../app/IdentityContext';
import { useTheme, useStyles } from '../app/ThemeContext';
import { NeedsYouIcons } from './NeedsYouIcons';
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

// The whole header is one 48dp row below the status bar.
export const HEADER_ROW_HEIGHT = 48;
const BEAN_SIZE = 38;
const AVATAR_SIZE = 32;

/**
 * `onMeasure` reports the header's real rendered height — including the update banner,
 * which appears and disappears. The map screen floats this header absolutely and has to
 * reserve the equivalent space for the tab bar below it; a constant would be wrong the
 * moment a banner shows.
 */
export function GlobalHeader({ onMeasure }: { onMeasure?: (height: number) => void } = {}) {
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
            paddingLeft: 8,
            paddingRight: 4,
        },
        beanBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
        statusBadge: { position: 'absolute', right: 5, bottom: 6, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: '#ffffff' },
        headerRightIcons: { flexDirection: 'row', alignItems: 'center' },
        iconBtn: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
        // Guests and phones with no community have nothing that "needs you" yet; the slot says what to do instead.
        statePillWrap: { flex: 1, minWidth: 0, height: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
        statePill: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 48, justifyContent: 'center' },
        statePillInner: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 34, paddingHorizontal: 14, borderRadius: 17, borderWidth: 1 },
        statePillText: { fontSize: 14, fontWeight: '800' },
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
    const [softUpdateVersion, setSoftUpdateVersion] = useState<string | null>(null);
    // The installed build is below the node's declared floor — a banner you cannot dismiss,
    // because the app genuinely will not behave against this node until it is updated.
    const [updateRequired, setUpdateRequired] = useState(false);
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
        let iv: ReturnType<typeof setInterval> | null = null;

        const startPolling = () => {
            if (!iv) {
                pingActive();
                iv = setInterval(pingActive, withJitter(30000));
            }
        };

        const stopPolling = () => {
            if (iv) {
                clearInterval(iv);
                iv = null;
            }
        };

        const handleAppStateChange = (nextState: AppStateStatus) => {
            if (nextState === 'active') {
                startPolling();
            } else {
                stopPolling();
            }
        };

        if (AppState.currentState === 'active') {
            startPolling();
        }

        const sub = AppState.addEventListener('change', handleAppStateChange);

        return () => {
            isMounted = false;
            stopPolling();
            sub.remove();
        };
    }, []);

    useEffect(() => {
        if (!identity?.publicKey) return;
        // Assign whatever the profile says, including null. Guarding on truthiness meant
        // clearing your avatar left the old image in the header until an app restart.
        const load = () => getMemberProfile(identity.publicKey)
            .then(p => setMyAvatar(p?.avatar_url ?? null))
            .catch(() => {});
        load();
        // Without this the pill kept the old picture until the header happened to remount.
        const sub = DeviceEventEmitter.addListener('profile_updated', load);
        return () => sub.remove();
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
                setIsGuestOnActive(!data.isMember);
            } catch (err: any) {
            }
        })();
    }, [identity?.publicKey, pathname]);

    // The header ROW's height. Deliberately not applied to the wrapper below: the wrapper
    // is `overflow: hidden`, so pinning it to this height clipped the update banner out of
    // existence — the banner rendered, on both platforms, and could never be seen. The
    // wrapper now sizes to its children (header row + banner, when there is one).
    const headerHeight = insets.top + HEADER_ROW_HEIGHT;
    const isMapScreen = pathname === '/map';
    const needsJoinOrConnect = !hasAnchorUrl || isGuestOnActive;
    const joinOrConnect = () => {
        if (!hasAnchorUrl) {
            router.push({ pathname: '/(tabs)/settings', params: { section: 'advanced' } });
        } else {
            DeviceEventEmitter.emit('set_people_view', { view: 'invites' });
            router.push({ pathname: '/(tabs)/people', params: { view: 'invites' } });
        }
    };

    return (
        <View
            style={[styles.headerWrapper, isMapScreen && styles.headerAbsolute]}
            onLayout={onMeasure ? (e) => onMeasure(e.nativeEvent.layout.height) : undefined}
        >
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

            {/* One 48dp row: the bean (opens the BeanPool sheet; wears the connection dot, whose white ring keeps
                it visible against the bean's dark rim) | what needs you, or the Join / Connect pill | invite,
                Settings, avatar. */}
            <View style={[styles.headerContainer, { paddingTop: insets.top, height: headerHeight }]} pointerEvents="box-none">
                <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`BeanPool: your community and help, ${!hasAnchorUrl ? 'not connected' : isOffline ? 'offline' : isGuestOnActive ? 'guest' : 'connected'}`}
                    style={styles.beanBtn}
                    activeOpacity={0.7}
                    onPress={() => router.push('/beanpool')}
                >
                    <Image
                        source={require('../assets/images/header-electric-bean.png')}
                        style={{ width: BEAN_SIZE, height: BEAN_SIZE }}
                        resizeMode="contain"
                    />
                    <View style={[styles.statusBadge, { backgroundColor: isOffline ? colors.feedback.danger.solid : isGuestOnActive ? colors.feedback.warning.solid : colors.feedback.success.solid }]} />
                </TouchableOpacity>

                {needsJoinOrConnect ? (
                    // A guest or a phone with no community has nothing that "needs you" yet. The slot names the
                    // next step in words, where main's Join / Connect pill was, so onboarding stays obvious.
                    <View style={styles.statePillWrap}>
                        <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={!hasAnchorUrl ? 'Connect to a community' : 'Join this community'}
                            style={styles.statePill}
                            onPress={joinOrConnect}
                        >
                            <View style={[styles.statePillInner, !hasAnchorUrl
                                ? { backgroundColor: colors.feedback.danger.bg, borderColor: colors.feedback.danger.border }
                                : { backgroundColor: colors.feedback.warning.bg, borderColor: colors.feedback.warning.border }]}>
                                <MaterialCommunityIcons name={!hasAnchorUrl ? 'link-off' : 'account-alert-outline'} size={18}
                                    color={!hasAnchorUrl ? colors.feedback.danger.fg : colors.feedback.warning.fg} />
                                <Text numberOfLines={1} style={[styles.statePillText, { color: !hasAnchorUrl ? colors.feedback.danger.fg : colors.feedback.warning.fg }]}>
                                    {!hasAnchorUrl ? 'Connect' : 'Join'}
                                </Text>
                            </View>
                        </Pressable>
                    </View>
                ) : (
                    // Small icons for what needs you, only while something does, stacked from the right.
                    <NeedsYouIcons sheetTop={headerHeight + 4} />
                )}

                <View style={styles.headerRightIcons}>
                    {/* The pill already says Join / Connect, so the invite icon only shows for members. */}
                    {!needsJoinOrConnect && (
                        <TouchableOpacity
                            accessibilityRole="button"
                            accessibilityLabel="Invite friends"
                            style={styles.iconBtn}
                            onPress={() => {
                                DeviceEventEmitter.emit('set_people_view', { view: 'invites' });
                                router.push({ pathname: '/(tabs)/people', params: { view: 'invites' } });
                            }}
                        >
                            <MaterialCommunityIcons name="account-plus-outline" size={24} color="#ffffff" />
                        </TouchableOpacity>
                    )}
                    <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel="Settings"
                        style={styles.iconBtn}
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
                        <MaterialCommunityIcons name="tune" size={24} color={pathname === '/settings' ? colors.accent.primary : '#ffffff'} />
                    </TouchableOpacity>
                    <TouchableOpacity
                        accessibilityRole="button"
                        accessibilityLabel="Open profile"
                        style={styles.iconBtn}
                        onPress={() => {
                            if (identity?.publicKey) {
                                router.push({ pathname: '/public-profile', params: { publicKey: identity.publicKey, callsign: identity.callsign } });
                            }
                        }}
                    >
                        <MemberAvatar avatarUrl={myAvatar} pubkey={identity?.publicKey || ''} callsign={identity?.callsign || '?'} size={AVATAR_SIZE} />
                    </TouchableOpacity>
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

        </View>
    );
}

