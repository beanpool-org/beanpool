import { Tabs, ErrorBoundary } from 'expo-router';
export { ErrorBoundary };
import { StatusBar } from 'expo-status-bar';
import { GlobalHeader, HEADER_ROW_HEIGHT } from '../../components/GlobalHeader';
import { View, Text, Platform, DeviceEventEmitter, AppState, type AppStateStatus } from 'react-native';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useIdentity } from '../IdentityContext';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getGlobalUnreadCount, syncMessages, getPosts, getMarketplaceTransactions } from '../../utils/db';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../ThemeContext';
import { withJitter } from '../../utils/jitter';

// MOCK v3 (mock/header-slim): a small label sits ABOVE each icon again, as in today's app,
// so the text is buffered from the busy page below. Height is fixed here because the library
// would add the status-bar inset a second time (GlobalHeader already consumes it).
const TAB_BAR_HEIGHT = 52;
const ICON_SIZE = 24;
const LABEL_SIZE = 10;
// Six tabs share 320dp, ~53dp each. "Commons" is the widest label; this cap was measured on
// the emulator at 320dp + 1.3x text as the largest scale that keeps it on one unclipped line.
const LABEL_MAX_SCALE = 1.1;
const UNDERLINE_HEIGHT = 3;

function TabItem({ label, icon, focused, color, count, badge }: {
    label: string;
    icon: string;
    focused: boolean;
    color: string;
    /** Unread/pending count, drawn against the icon. */
    count?: number;
    badge?: React.ReactNode;
}) {
    return (
        <View style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', paddingBottom: UNDERLINE_HEIGHT }}>
            {/* The emoji can't take a tint, so the inactive tabs are dimmed instead and the
                active one gets full opacity, the accent label colour and the underline. */}
            <View style={{ alignItems: 'center', opacity: focused ? 1 : 0.6 }}>
                <Text
                    numberOfLines={1}
                    maxFontSizeMultiplier={LABEL_MAX_SCALE}
                    style={{ fontSize: LABEL_SIZE, lineHeight: 13, fontWeight: '700', color, includeFontPadding: false }}
                >
                    {label}
                </Text>
                <Text allowFontScaling={false} style={{
                    fontSize: ICON_SIZE,
                    lineHeight: ICON_SIZE + 4,
                    marginTop: 1,
                    includeFontPadding: false,
                }}>
                    {icon}
                </Text>
            </View>
            {/* Drawn here rather than via tabBarBadge: the library anchors that to the icon
                wrapper, which tabBarIconStyle stretches to the whole tab. Sits on the icon's
                top-right, below the label. */}
            {count !== undefined && count > 0 && (
                <View style={{
                    position: 'absolute', top: 16, left: '50%', marginLeft: 6, minWidth: 16, height: 16,
                    borderRadius: 8, paddingHorizontal: 4, backgroundColor: '#dc2626',
                    alignItems: 'center', justifyContent: 'center',
                }}>
                    <Text allowFontScaling={false} style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>
                        {count > 99 ? '99+' : count}
                    </Text>
                </View>
            )}
            {focused && (
                <View style={{
                    position: 'absolute', bottom: 0, left: '18%', right: '18%', height: UNDERLINE_HEIGHT,
                    borderTopLeftRadius: UNDERLINE_HEIGHT, borderTopRightRadius: UNDERLINE_HEIGHT, backgroundColor: color,
                }} />
            )}
            {badge}
        </View>
    );
}

export default function TabLayout() {
    const { theme, colors } = useTheme();
    const { identity } = useIdentity();
    const pathname = usePathname();
    const insets = useSafeAreaInsets();
    // GlobalHeader positions itself absolutely on /map (styles.headerAbsolute) so it can float
    // over the map. Absolute means it reserves no layout space, so with the tab bar now beneath
    // it, the header painted straight over the tabs. Reserve the height here instead of touching
    // GlobalHeader. Mirrors its own `insets.top + HEADER_ROW_HEIGHT`.
    const headerHeight = insets.top + HEADER_ROW_HEIGHT;
    const isMapScreen = pathname === '/map';
    // Starts at the header-row height and grows if GlobalHeader renders an update banner.
    const [measuredHeaderHeight, setMeasuredHeaderHeight] = useState(headerHeight);
    const lastMeasuredRef = useRef(headerHeight);
    // GlobalHeader's onLayout can fire inside THIS component's own mount commit, and a
    // setState at that point is a render-phase update: React warns "state update on a
    // component that hasn't mounted yet" and drops it. Deferring past the commit fixes
    // that, and the equality guard stops every relayout from re-rendering the navigator.
    const onHeaderMeasure = useCallback((h: number) => {
        if (Math.abs(lastMeasuredRef.current - h) < 1) return;
        lastMeasuredRef.current = h;
        requestAnimationFrame(() => setMeasuredHeaderHeight(h));
    }, []);
    const [unread, setUnread] = useState(0);
    const [dealsCount, setDealsCount] = useState(0);
    const [needsBackup, setNeedsBackup] = useState(false);
    const lastNetSyncAtRef = useRef(0);

    useEffect(() => {
        if (!identity?.publicKey) return;

        const checkBackup = async () => {
            try {
                const backedUp = await AsyncStorage.getItem('beanpool_identity_backed_up');
                if (backedUp !== 'true') {
                    // Check if identity is older than 24 hours
                    const createdAt = new Date(identity.createdAt).getTime();
                    const now = new Date().getTime();
                    if (now - createdAt > 24 * 60 * 60 * 1000) {
                        setNeedsBackup(true);
                    } else {
                        setNeedsBackup(false);
                    }
                } else {
                    setNeedsBackup(false);
                }
            } catch (e) {}
        };
        checkBackup();
        // Badge math is all local reads and safe to run often. syncMessages is NOT:
        // it hits the network and takes the DB write lock per changed conversation,
        // and running it here every 5s (this layout stays mounted under pushed
        // screens) was a main feeder of the sync-lock queue (2026-07-18 logs).
        const checkUnread = async (withNetworkSync = false) => {
            try {
                if (withNetworkSync) {
                    lastNetSyncAtRef.current = Date.now();
                    // Discover new messages across active threads globally
                    await syncMessages(identity.publicKey);
                }
                // Calculate unread sum across the updated SQLite pool
                const count = await getGlobalUnreadCount(identity.publicKey);
                setUnread(count);

                // Count active deals — mirror usePendingDealsCount in MyDealsSheet so
                // the bottom-tab Market badge matches the in-app My Deals pill.
                const [allPosts, myTxns] = await Promise.all([
                    getPosts(),
                    getMarketplaceTransactions(identity.publicKey),
                ]);
                const active = allPosts.filter((p: any) => {
                    if (p.status === 'pending' && (p.author_pubkey === identity.publicKey || p.accepted_by === identity.publicKey)) return true;
                    return myTxns.some((t: any) => t.postId === p.id && (t.status === 'pending' || t.status === 'requested'));
                }).length;
                setDealsCount(active);
            } catch (e) {}
        };

        let iv: ReturnType<typeof setInterval> | null = null;
        let netIv: ReturnType<typeof setInterval> | null = null;

        const startPolling = () => {
            if (!iv) {
                checkUnread(true);
                // Local badge refresh every 5s; full network message-sync only as a 30s
                // backstop — real-time arrival is covered by the ws_activity nudge below
                iv = setInterval(() => checkUnread(false), withJitter(5000));
                netIv = setInterval(() => checkUnread(true), withJitter(30000));
            }
        };

        const stopPolling = () => {
            if (iv) {
                clearInterval(iv);
                iv = null;
            }
            if (netIv) {
                clearInterval(netIv);
                netIv = null;
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

        const appStateSub = AppState.addEventListener('change', handleAppStateChange);

        const wsSub = DeviceEventEmitter.addListener('ws_activity', () => {
            if (AppState.currentState === 'active' && Date.now() - lastNetSyncAtRef.current > 10000) {
                checkUnread(true);
            }
        });

        return () => {
            stopPolling();
            appStateSub.remove();
            wsSub.remove();
        };
    }, [identity]);

    return (
        <View style={{ flex: 1 }}>
            {/* Tab screens always sit under the dark-green vine header, so the status-bar
                text must be light regardless of the app's light/dark theme. */}
            <StatusBar style="light" />
            {/* EXPERIMENT (feat/top-tabs): tab bar moved to the top, UNDER the brand band.
                A top tab bar renders before the screen container, so a per-screen `header`
                would land above the tabs. Rendering GlobalHeader here instead keeps the
                logo on top; it reads its route from usePathname(), not navigator context,
                so it behaves identically outside the navigator. */}
            {/* On the map the header floats (position: absolute, zIndex 100), so it
                contributes no height and this spacer reserves the room the tab bar needs
                to sit below it. `headerHeight` alone measures the header ROW only — when
                the update banner appears the header grows, and the extra painted straight
                over the tab bar at zIndex 100, swallowing its touches and stranding anyone
                on the map. GlobalHeader reports what it actually measured instead. */}
            <View style={isMapScreen ? { height: measuredHeaderHeight } : undefined}>
                <GlobalHeader onMeasure={onHeaderMeasure} />
            </View>
            <Tabs backBehavior="none" screenOptions={{
                tabBarPosition: 'top',
                headerShown: false,
                // The vine banner stays in GlobalHeader above; the icon strip is a flat fill so
                // the two do not fight. green950 is what the vine read as under its 65% black
                // overlay, so losing the image is not a colour change.
                tabBarStyle: { 
                    backgroundColor: colors.surface.app, 
                    borderTopWidth: 0,
                    elevation: 0,
                    height: TAB_BAR_HEIGHT,
                    paddingTop: 0,
                },
                tabBarActiveTintColor: colors.accent.primary,
                tabBarInactiveTintColor: colors.text.secondary,
                // TabItem draws its own label above the icon, so the built-in one (which always
                // sits below) is turned off. Tint colours above still feed it via `color`.
                tabBarShowLabel: false,
                // The icon wrapper is hard-coded to 31x28 (ICON_SIZE_WIDE/TALL in TabBarIcon),
                // which clips any label longer than "Chat". tabBarIconStyle is merged last in
                // that component's style array, so this widens it to the whole tab.
                tabBarIconStyle: { width: '100%', height: '100%' },
            }}>
                <Tabs.Screen
                    name="index"
                    options={{
                        title: 'Market',
                        tabBarAccessibilityLabel: 'Market',
                        tabBarIcon: ({ focused, color }) => <TabItem label="Market" icon="🤝" focused={focused} color={color} count={dealsCount} />
                    }}
                />
                <Tabs.Screen
                    name="map"
                    options={{
                        title: 'Map',
                        tabBarAccessibilityLabel: 'Map',
                        tabBarIcon: ({ focused, color }) => <TabItem label="Map" icon="🗺️" focused={focused} color={color} />
                    }}
                />

                {/* Talk hosts Messages + People behind a segmented control. Merging them frees
                    the slot Pulse needs — six labelled tabs is the ceiling at 320dp. */}
                <Tabs.Screen
                    name="chats"
                    options={{
                        title: 'Talk',
                        tabBarAccessibilityLabel: 'Talk',
                        tabBarIcon: ({ focused, color }) => <TabItem label="Talk" icon="💬" focused={focused} color={color} count={unread} />
                    }}
                />
                {/* Still a route: GlobalHeader and public-profile deep-link here with a `view`
                    param, so it stays mounted. Hidden from the bar — Talk is its home now. */}
                <Tabs.Screen
                    name="people"
                    options={{
                        title: 'People',
                        tabBarAccessibilityLabel: 'People',
                        href: null,
                        tabBarIcon: ({ focused, color }) => <TabItem label="People" icon="👥" focused={focused} color={color} />
                    }}
                />
                <Tabs.Screen
                    name="pulse"
                    options={{
                        title: 'Pulse',
                        tabBarAccessibilityLabel: 'Pulse',
                        tabBarIcon: ({ focused, color }) => <TabItem label="Pulse" icon="📡" focused={focused} color={color} />
                    }}
                />
                <Tabs.Screen 
                    name="projects" 
                    options={{ 
                        title: 'Commons',
                        tabBarAccessibilityLabel: 'Commons',
                        tabBarIcon: ({ focused, color }) => <TabItem label="Commons" icon={Platform.OS === 'ios' ? '🌱' : '🌳'} focused={focused} color={color} /> 
                    }} 
                />
                <Tabs.Screen 
                    name="ledger" 
                    options={{ 
                        title: 'Ledger',
                        tabBarAccessibilityLabel: 'Ledger',
                        tabBarIcon: ({ focused, color }) => <TabItem label="Ledger" icon="📊" focused={focused} color={color} /> 
                    }} 
                />
                <Tabs.Screen 
                    name="settings" 
                    options={{ 
                        title: 'Settings',
                        tabBarAccessibilityLabel: 'Settings',
                        href: null,
                        tabBarIcon: ({ focused, color }) => (
                            <TabItem
                                label="Settings"
                                icon="⚙️"
                                focused={focused}
                                color={color}
                                badge={needsBackup ? (
                                    <View style={{ position: 'absolute', top: 4, right: '30%', backgroundColor: colors.feedback.danger.solid, width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: colors.surface.app }} />
                                ) : null}
                            />
                        )
                    }} 
                />
            </Tabs>
        </View>
    );
}
