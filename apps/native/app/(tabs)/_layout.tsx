import { Tabs, ErrorBoundary } from 'expo-router';
export { ErrorBoundary };
import { StatusBar } from 'expo-status-bar';
import { GlobalHeader, HEADER_ROW_HEIGHT } from '../../components/GlobalHeader';
import { View, Text, Platform, DeviceEventEmitter, AppState, type AppStateStatus } from 'react-native';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useIdentity } from '../IdentityContext';
import { usePathname, router } from 'expo-router';
import { useMemo } from 'react';
import { dealsNeedingMe, helpSheetFor, messageBackstopDue, MESSAGE_BACKSTOP_TICK_MS, phoneHelpKey, tourStepForTab, tourSteps as coreTourSteps, word } from '@beanpool/core';
import { webSocketAliveSince } from '../../services/ws-client';
import { useWords } from '../../components/LanguageProvider';
import { TourBar, tourSceneInset } from '../../components/TourBar';
import { HelpSheet } from '../../components/HelpSheet';
import { OPEN_HELP_EVENT, closeTour, helpContext, moveTour, startTour, useTour } from '../../utils/tour-store';
import { useGuide } from '../../utils/use-guide';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getGlobalUnreadCount, syncMessages, getMarketplaceTransactions } from '../../utils/db';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme } from '../ThemeContext';
import { useNodeStatus } from '../NodeStatusContext';
import { withJitter } from '../../utils/jitter';
import { fetchNodeProfile, getCachedNodeProfile, hiddenTabsFor, type HideableTab } from '../../utils/node-profile';
import { UNKNOWN_NODE_PROFILE, anchorRead, profileArrived, type AnchoredNodeProfile } from '../../utils/node-profile-anchor';
import { keepCommunityIdentity } from '../../utils/address-follow';

/** Each tour step's tab as a route, written out so every link into the app is checked (deep-links-resolve.test.ts). */
const TOUR_ROUTES: Record<string, '/(tabs)' | '/(tabs)/market' | '/(tabs)/map' | '/(tabs)/chats' | '/(tabs)/projects' | '/(tabs)/ledger'> = {
    index: '/(tabs)', market: '/(tabs)/market', map: '/(tabs)/map', chats: '/(tabs)/chats', projects: '/(tabs)/projects', ledger: '/(tabs)/ledger',
};

/**
 * Each tab's name, in the member's language: the label over its icon, the screen's title and what a screen reader says.
 * The `tab` context lets a language choose a shorter word for the strip than it uses elsewhere (six tabs share 320dp;
 * translation design §5 (c)).
 */
const TAB = {
    index: word('Home', 'tab'),
    market: word('Market', 'tab'),
    map: word('Map', 'tab'),
    chats: word('Talk', 'tab'),
    people: word('People', 'tab'),
    pulse: word('Pulse', 'tab'),
    projects: word('Commons', 'tab'),
    ledger: word('Ledger', 'tab'),
    settings: word('Settings', 'tab'),
};

// A small label sits ABOVE each icon,
// so the text is buffered from the busy page below. Height is fixed here because the library
// would add the status-bar inset a second time (GlobalHeader already consumes it).
const TAB_BAR_HEIGHT = 52;
const ICON_SIZE = 24;
const LABEL_SIZE = 10;
// Six tabs share 320dp, ~53dp each. "Commons" is the widest label; this cap was measured on
// the emulator at 320dp + 1.3x text as the largest scale that keeps it on one unclipped line.
const LABEL_MAX_SCALE = 1.1;
// A longer word in another language shrinks to fit its tab rather than being cut off, down to this (as the welcome
// screen's two big buttons do); the label stays one line, as the strip's fixed height needs. 0.6 (6.6 dp) is only the
// safety net that keeps a label whole: every catalog's tab word must fit at 0.8, 8.8 dp, so a translator gives the
// short `tab` word, never a full one that needs more shrink (tab-bar-words-render.test.ts; deciding review of #2152).
const LABEL_MIN_SCALE = 0.6;
const UNDERLINE_HEIGHT = 3;
const TAB_BUTTON_INSET = 5;
/** A doorbell this soon after the last network read of the messages waits for the gap to pass (TabLayout's ws_activity). */
const DOORBELL_READ_GAP_MS = 10_000;

function TabItem({ label, icon, focused, color, count, badge }: {
    label: string;
    icon: string;
    focused: boolean;
    color: string;
    /** Unread/pending count, drawn against the icon. */
    count?: number;
    badge?: React.ReactNode;
}) {
    const { colors } = useTheme();
    return (
        <View style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', paddingBottom: UNDERLINE_HEIGHT }}>
            {/* The emoji can't take a tint, so the inactive tabs are dimmed instead and the
                active one gets full opacity, the accent label colour and the underline. */}
            <View style={{ alignItems: 'center', opacity: focused ? 1 : 0.6 }}>
                <Text
                    numberOfLines={1}
                    adjustsFontSizeToFit
                    minimumFontScale={LABEL_MIN_SCALE}
                    maxFontSizeMultiplier={LABEL_MAX_SCALE}
                    // The library's tab button pads 5dp a side (tabVerticalUiKit, not reachable via
                    // tabBarItemStyle), which left "Commons" 43dp of a 53dp tab at 320dp. The negative
                    // margin gives the centred label the tab's full width back.
                    style={{ marginHorizontal: -TAB_BUTTON_INSET, fontSize: LABEL_SIZE, lineHeight: 13, fontWeight: '700', color, includeFontPadding: false }}
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
                    borderRadius: 8, paddingHorizontal: 4, backgroundColor: colors.feedback.danger.solid,
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
    const { t } = useWords();
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
    const { nodeUrl } = useNodeStatus();
    // Commons and Ledger are money: a node with Beans off (the global community) hides them when Decisions are off too
    // (with Decisions on, Commons stays for Decisions and groups). What this phone
    // last heard from the node first, so the strip doesn't jump, then the node's own answer. Read from the phone's
    // community itself at each screen change, not from `nodeUrl` alone: switching in Settings, from the community
    // list or by joining another one doesn't recheck the node status, and the strip must never keep the community
    // before (utils/node-profile-anchor.ts). The node is asked only when the community changed.
    const [strip, setStrip] = useState<AnchoredNodeProfile>(UNKNOWN_NODE_PROFILE);
    const stripReadFor = useRef<string | null | undefined>(undefined);
    const hiddenTabs: HideableTab[] = hiddenTabsFor(strip.profile?.features);
    useEffect(() => {
        // No `cancelled`: an answer is kept only while the phone is still on the community it is for, so one still
        // out when the screen changes lands as it should, and one for the community before never does.
        (async () => {
            const url = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => undefined);
            if (url === undefined || url === stripReadFor.current) return;
            stripReadFor.current = url;
            setStrip(s => anchorRead(s, url));
            if (!url) return;
            const cached = await getCachedNodeProfile(url);
            setStrip(s => profileArrived(s, url, cached));
            const fresh = await fetchNodeProfile(url);
            setStrip(s => profileArrived(s, url, fresh));
            // Who the community is at this address, kept the first time it answers here, before any move to follow is on
            // offer (utils/address-follow.ts keepCommunityIdentity): once per address, and the strip doesn't wait for it.
            if (fresh) keepCommunityIdentity(url).catch(() => {});
            // Nothing known of it (offline, and no copy yet): read it again at the next screen change rather than
            // show Commons and Ledger for the rest of the session. Only while the phone is still on it.
            if (!cached && !fresh && stripReadFor.current === url) stripReadFor.current = undefined;
        })().catch(() => {});
    }, [nodeUrl, pathname]);

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
                const myTxns = await getMarketplaceTransactions(identity.publicKey);
                const active = dealsNeedingMe(myTxns, identity.publicKey).length;
                setDealsCount(active);
            } catch (e) {}
        };

        let iv: ReturnType<typeof setInterval> | null = null;
        let netIv: ReturnType<typeof setInterval> | null = null;

        const startPolling = () => {
            if (!iv) {
                checkUnread(true);
                // Local badge refresh every 5s; full network message-sync only as a backstop — real-time arrival is
                // covered by the ws_activity nudge below. Every 120 s while the member's socket is alive, every 30 s
                // while it is not (@beanpool/core messageBackstopDue, slice L0). A socket that opened after the last read
                // doesn't count yet: a line sent while it was down never rang, so the next tick reads (review of #2558).
                iv = setInterval(() => checkUnread(false), withJitter(5000));
                netIv = setInterval(() => {
                    const lastRead = lastNetSyncAtRef.current;
                    if (messageBackstopDue(lastRead, Date.now(), webSocketAliveSince(lastRead))) checkUnread(true);
                }, withJitter(MESSAGE_BACKSTOP_TICK_MS));
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

        // A doorbell within 10 s of the last network read doesn't read again at once. But that read may already have passed
        // the doorbell's line (it was done, or past the list), and while the socket is alive the backstop is up to 120 s
        // away, so the held doorbell reads once when the 10 s is up, unless a read has started since it rang (review of #2558).
        let heldDoorbell: ReturnType<typeof setTimeout> | null = null;
        let lastDoorbellAt = 0;
        const readForDoorbell = () => {
            if (AppState.currentState !== 'active') return;
            const sinceRead = Date.now() - lastNetSyncAtRef.current;
            if (sinceRead > DOORBELL_READ_GAP_MS) {
                if (heldDoorbell) { clearTimeout(heldDoorbell); heldDoorbell = null; }
                checkUnread(true);
                return;
            }
            if (!heldDoorbell) heldDoorbell = setTimeout(() => {
                heldDoorbell = null;
                if (lastNetSyncAtRef.current <= lastDoorbellAt) readForDoorbell();
            }, DOORBELL_READ_GAP_MS - sinceRead + 1);
        };
        const wsSub = DeviceEventEmitter.addListener('ws_activity', () => {
            lastDoorbellAt = Date.now();
            readForDoorbell();
        });

        return () => {
            stopPolling();
            appStateSub.remove();
            wsSub.remove();
            if (heldDoorbell) clearTimeout(heldDoorbell);
        };
    }, [identity]);

    // ── The tour (scratch/global-node/DESIGN-getting-started-fable.md §2) and the "?" (§4) ──
    // The bar lives here, over the real tabs; Home starts it and owns what it writes (utils/tour-store.ts).
    const { run: tour, home: tourHomeNow } = useTour();
    const guide = useGuide();
    const isGlobal = strip.profile?.profile === 'global';
    const moneyShown = !hiddenTabs.includes('ledger');
    const steps = useMemo(() => coreTourSteps('phone', { global: isGlobal, beans: moneyShown }), [isGlobal, moneyShown]);
    const tourRunning = !!tour && !!identity && tour.publicKey === identity.publicKey;
    const tourIndex = tour ? Math.min(tour.step, steps.length - 1) : 0;
    const tourTab = tourRunning ? steps[tourIndex]?.tab ?? null : null;
    // The bar's height, so the tabs end at its top and their bottom buttons ride above it (tourSceneInset).
    const [tourBarHeight, setTourBarHeight] = useState(0);
    // The account left the phone: its tour goes with it.
    useEffect(() => { if (tour && (!identity || tour.publicKey !== identity.publicKey)) closeTour(); }, [identity?.publicKey, tour?.publicKey]);
    // Each step shows its own tab.
    useEffect(() => {
        if (!tourTab) return;
        const path = tourTab === 'index' ? '/' : `/${tourTab}`;
        if (pathname !== path) router.navigate(TOUR_ROUTES[tourTab] ?? '/(tabs)');
    }, [tourTab]);
    // A tab the member taps during the tour moves the tour to that tab's step: it follows, never scolds.
    useEffect(() => {
        if (!tourRunning) return;
        const tab = pathname === '/' ? 'index' : pathname.replace(/^\//, '').split('/')[0];
        if (tab === tourTab) return;
        const at = tourStepForTab(steps, tab);
        if (at >= 0) moveTour(at);
    }, [pathname]);
    const endTour = useCallback((kind: 'done' | 'skipped') => {
        tourHomeNow?.end(kind);
        closeTour();
        if (pathname !== '/') router.navigate('/(tabs)');
    }, [tourHomeNow, pathname]);

    const [helpOpen, setHelpOpen] = useState(false);
    useEffect(() => {
        const sub = DeviceEventEmitter.addListener(OPEN_HELP_EVENT, () => setHelpOpen(true));
        return () => sub.remove();
    }, []);
    const helpWords = helpSheetFor(guide.guide, phoneHelpKey(pathname, helpContext()));

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
            <View style={{ flex: 1, marginBottom: tourSceneInset(tourRunning, tourBarHeight) }} testID="tab-scenes">
            <Tabs backBehavior="none" screenOptions={{
                tabBarPosition: 'top',
                headerShown: false,
                // Tab screens paint nothing of their own so the wallpaper behind the
                // navigator shows through; the icon strip below stays a solid fill.
                sceneStyle: { backgroundColor: 'transparent' },
                // The vine banner stays in GlobalHeader above; the icon strip is a flat fill so
                // the two do not fight. green950 is what the vine read as under its 65% black
                // overlay, so losing the image is not a colour change.
                tabBarStyle: { 
                    backgroundColor: colors.surface.chrome,
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
                {/* Home (scratch/global-node/DESIGN-home-dashboard-fable.md, slice H2): the screen the app opens on, a
                    short list of cards. `index` stays the tabs' first route, so every link to `/(tabs)` or `/` lands
                    here; the Market has its own route since. */}
                <Tabs.Screen
                    name="index"
                    options={{
                        title: t(TAB.index),
                        tabBarAccessibilityLabel: t(TAB.index),
                        tabBarButtonTestID: 'tab-home',
                        tabBarIcon: ({ focused, color }) => <TabItem label={t(TAB.index)} icon="🏠" focused={focused} color={color} />
                    }}
                />
                <Tabs.Screen
                    name="market"
                    options={{
                        title: t(TAB.market),
                        tabBarAccessibilityLabel: t(TAB.market),
                        tabBarButtonTestID: 'tab-market',
                        tabBarIcon: ({ focused, color }) => <TabItem label={t(TAB.market)} icon="🤝" focused={focused} color={color} count={dealsCount} />
                    }}
                />
                <Tabs.Screen
                    name="map"
                    options={{
                        title: t(TAB.map),
                        tabBarAccessibilityLabel: t(TAB.map),
                        tabBarButtonTestID: 'tab-map',
                        tabBarIcon: ({ focused, color }) => <TabItem label={t(TAB.map)} icon="🗺️" focused={focused} color={color} />
                    }}
                />

                {/* Talk hosts Messages + People behind a segmented control. Merging them freed
                    a slot — six labelled tabs is the ceiling at 320dp. */}
                <Tabs.Screen
                    name="chats"
                    options={{
                        title: t(TAB.chats),
                        tabBarAccessibilityLabel: t(TAB.chats),
                        tabBarButtonTestID: 'tab-talk',
                        tabBarIcon: ({ focused, color }) => <TabItem label={t(TAB.chats)} icon="💬" focused={focused} color={color} count={unread} />
                    }}
                />
                {/* Still a route: GlobalHeader and public-profile deep-link here with a `view`
                    param, so it stays mounted. Hidden from the bar — Talk is its home now. */}
                <Tabs.Screen
                    name="people"
                    options={{
                        title: t(TAB.people),
                        tabBarAccessibilityLabel: t(TAB.people),
                        href: null,
                        tabBarIcon: ({ focused, color }) => <TabItem label={t(TAB.people)} icon="👥" focused={focused} color={color} />
                    }}
                />
                {/* A card on Home since H2 (its slot went to Home), and still a route: the card's "See all" opens it. */}
                <Tabs.Screen
                    name="pulse"
                    options={{
                        title: t(TAB.pulse),
                        tabBarAccessibilityLabel: t(TAB.pulse),
                        href: null,
                        tabBarIcon: ({ focused, color }) => <TabItem label={t(TAB.pulse)} icon="📡" focused={focused} color={color} />
                    }}
                />
                <Tabs.Screen
                    name="projects"
                    options={{
                        ...(hiddenTabs.includes('projects') ? { href: null } : {}),
                        title: t(TAB.projects),
                        tabBarAccessibilityLabel: t(TAB.projects),
                        tabBarButtonTestID: 'tab-commons',
                        tabBarIcon: ({ focused, color }) => <TabItem label={t(TAB.projects)} icon={Platform.OS === 'ios' ? '🌱' : '🌳'} focused={focused} color={color} /> 
                    }} 
                />
                <Tabs.Screen
                    name="ledger"
                    options={{
                        ...(hiddenTabs.includes('ledger') ? { href: null } : {}),
                        title: t(TAB.ledger),
                        tabBarAccessibilityLabel: t(TAB.ledger),
                        tabBarButtonTestID: 'tab-ledger',
                        tabBarIcon: ({ focused, color }) => <TabItem label={t(TAB.ledger)} icon="📊" focused={focused} color={color} /> 
                    }} 
                />
                <Tabs.Screen 
                    name="settings" 
                    options={{ 
                        title: t(TAB.settings),
                        tabBarAccessibilityLabel: t(TAB.settings),
                        href: null,
                        tabBarIcon: ({ focused, color }) => (
                            <TabItem
                                label={t(TAB.settings)}
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
            {tourRunning && (
                <TourBar
                    steps={steps}
                    index={tourIndex}
                    home={tourHomeNow}
                    colors={colors}
                    bottomInset={insets.bottom}
                    onHeight={setTourBarHeight}
                    onNext={() => moveTour(tourIndex + 1)}
                    onSkip={() => endTour('skipped')}
                    onDone={() => endTour('done')}
                />
            )}
            <HelpSheet
                visible={helpOpen}
                sheet={helpWords}
                tourOpen={tourRunning}
                canTour={!!identity && !!tourHomeNow}
                colors={colors}
                onClose={() => setHelpOpen(false)}
                onReadPage={() => {
                    setHelpOpen(false);
                    if (helpWords.slug) router.push({ pathname: '/guide/[slug]', params: { slug: helpWords.slug } });
                    else if (helpWords.section) router.push({ pathname: '/guide/section/[id]', params: { id: helpWords.section } });
                }}
                onSearch={() => { setHelpOpen(false); router.push('/beanpool'); }}
                onTour={() => {
                    setHelpOpen(false);
                    if (!identity) return;
                    // Pick up where it is, or (Take the tour again) open it on the account from step 1.
                    if (tourRunning) return;
                    if (tourHomeNow?.restart) tourHomeNow.restart();
                    else startTour(identity.publicKey, 0);
                }}
            />
        </View>
    );
}
