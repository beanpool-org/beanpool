import { Tabs, ErrorBoundary } from 'expo-router';
export { ErrorBoundary };
import { StatusBar } from 'expo-status-bar';
import { GlobalHeader } from '../../components/GlobalHeader';
import { View, Text, Platform, DeviceEventEmitter, useWindowDimensions } from 'react-native';
import { useState, useEffect, useRef } from 'react';
import { useIdentity } from '../IdentityContext';
import { usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getGlobalUnreadCount, syncMessages, getPosts, getMarketplaceTransactions } from '../../utils/db';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../ThemeContext';

// Tab bar sits under the brand header, so its height is fixed here rather than left to
// the library, which would add the status-bar inset a second time (GlobalHeader already
// consumes it). The column inside is vertically centred by the library's icon wrapper, so
// this height is the only lever on the gap between the banner and the label: the leftover
// space splits evenly above and below. 58 leaves ~5 either side.
const TAB_BAR_HEIGHT = 58;

// Label sits ABOVE the icon. The focused icon grows by raising its own fontSize rather than
// by transform: scale. A scaled child overflows its wrapper's bounds and Android clips it,
// which is what was cutting the bottom off. Growing the glyph enlarges the line box instead,
// and because the column is top-aligned that growth goes downwards, away from the text.
const ICON_SIZE = 24;
const ICON_SIZE_FOCUSED = 31;
// Six tabs share the width. At the 320dp floor that is ~53dp each, where the full-size glyph
// plus the badge padding overflows the cell and Android clips the icon's right edge. Below
// this much room per tab, everything steps down a size.
const VISIBLE_TABS = 6;
const COMPACT_TAB_WIDTH = 58;

function TabItem({ label, icon, focused, color, count, badge }: {
    label: string;
    icon: string;
    focused: boolean;
    color: string;
    /** Unread/pending count, drawn against the icon. */
    count?: number;
    badge?: React.ReactNode;
}) {
    const { width } = useWindowDimensions();
    const compact = width / VISIBLE_TABS < COMPACT_TAB_WIDTH;
    const iconSize = compact
        ? (focused ? ICON_SIZE_FOCUSED - 7 : ICON_SIZE - 5)
        : (focused ? ICON_SIZE_FOCUSED : ICON_SIZE);
    const iconBoxHeight = (compact ? ICON_SIZE_FOCUSED - 7 : ICON_SIZE_FOCUSED) + 2;

    return (
        <View style={{ alignItems: 'center', width: '100%', paddingTop: 2 }}>
            {/* adjustsFontSizeToFit rather than a hard cap: "Commons" is the longest label and
                truncated to "Comm..." at 320dp. Shrinking beats an ellipsis on a nav label. */}
            <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.75}
                maxFontSizeMultiplier={1.15}
                style={{ fontSize: compact ? 9 : 10, fontWeight: '700', marginBottom: 0, color }}
            >
                {label}
            </Text>
            {/* includeFontPadding strips Android's extra glyph padding, which was most of the
                gap between the text and the icon. Tightening it here buys the headroom the
                focused size needs. */}
            {/* Fixed to the focused size so the column's height never changes. The icon lives
                inside an absolutely-centred wrapper, so a taller focused item would otherwise
                re-centre and visibly nudge the label up on selection. */}
            <View style={{ height: iconBoxHeight, justifyContent: 'flex-start', paddingHorizontal: compact ? 7 : 11 }}>
                <Text allowFontScaling={false} style={{
                    fontSize: iconSize,
                    lineHeight: iconSize + 2,
                    includeFontPadding: false,
                }}>
                    {icon}
                </Text>
                {/* The library anchors tabBarBadge to the icon wrapper, and tabBarIconStyle
                    stretches that wrapper to the whole tab — so the built-in badge lands in the
                    tab top-right corner level with the label, colliding with a long label like
                    Commons and crowding the next tab at 320dp. Drawn here instead, inside the
                    wrapper padding, since Android clips children that overflow their parent. */}
                {count !== undefined && count > 0 && (
                    <View style={{
                        position: 'absolute', top: -2, right: 0, minWidth: compact ? 14 : 16, height: compact ? 14 : 16,
                        borderRadius: 8, paddingHorizontal: 4, backgroundColor: '#dc2626',
                        alignItems: 'center', justifyContent: 'center',
                    }}>
                        <Text allowFontScaling={false} style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>
                            {count > 99 ? '99+' : count}
                        </Text>
                    </View>
                )}
            </View>
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
    // GlobalHeader. Mirrors its own `Math.max(insets.top + 10, 40) + 56`.
    const headerHeight = Math.max(insets.top + 10, 40) + 56;
    const isMapScreen = pathname === '/map';
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
        checkUnread(true);
        // Local badge refresh every 5s; full network message-sync only as a 30s
        // backstop — real-time arrival is covered by the ws_activity nudge below
        // (throttled, so a chatty session doesn't turn into a sync-per-message).
        const iv = setInterval(() => checkUnread(false), 5000);
        const netIv = setInterval(() => checkUnread(true), 30000);
        const wsSub = DeviceEventEmitter.addListener('ws_activity', () => {
            if (Date.now() - lastNetSyncAtRef.current > 10000) checkUnread(true);
        });
        return () => {
            clearInterval(iv);
            clearInterval(netIv);
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
            <View style={isMapScreen ? { height: headerHeight } : undefined}>
                <GlobalHeader />
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
                        tabBarIcon: ({ focused, color }) => <TabItem label="Market" icon="🤝" focused={focused} color={color} count={dealsCount} />
                    }}
                />
                <Tabs.Screen
                    name="map"
                    options={{
                        title: 'Map',
                        tabBarIcon: ({ focused, color }) => <TabItem label="Map" icon="🗺️" focused={focused} color={color} />
                    }}
                />

                {/* Talk hosts Messages + People behind a segmented control. Merging them frees
                    the slot Pulse needs — six labelled tabs is the ceiling at 320dp. */}
                <Tabs.Screen
                    name="chats"
                    options={{
                        title: 'Talk',
                        tabBarIcon: ({ focused, color }) => <TabItem label="Talk" icon="💬" focused={focused} color={color} count={unread} />
                    }}
                />
                {/* Still a route: GlobalHeader and public-profile deep-link here with a `view`
                    param, so it stays mounted. Hidden from the bar — Talk is its home now. */}
                <Tabs.Screen
                    name="people"
                    options={{
                        title: 'People',
                        href: null,
                        tabBarIcon: ({ focused, color }) => <TabItem label="People" icon="👥" focused={focused} color={color} />
                    }}
                />
                <Tabs.Screen
                    name="pulse"
                    options={{
                        title: 'Pulse',
                        tabBarIcon: ({ focused, color }) => <TabItem label="Pulse" icon="📡" focused={focused} color={color} />
                    }}
                />
                <Tabs.Screen 
                    name="projects" 
                    options={{ 
                        title: 'Commons',
                        tabBarIcon: ({ focused, color }) => <TabItem label="Commons" icon={Platform.OS === 'ios' ? '🌱' : '🌳'} focused={focused} color={color} /> 
                    }} 
                />
                <Tabs.Screen 
                    name="ledger" 
                    options={{ 
                        title: 'Ledger',
                        tabBarIcon: ({ focused, color }) => <TabItem label="Ledger" icon="📊" focused={focused} color={color} /> 
                    }} 
                />
                <Tabs.Screen 
                    name="settings" 
                    options={{ 
                        title: 'Settings',
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
