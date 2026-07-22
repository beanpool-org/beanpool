import 'fast-text-encoding';
import { useEffect, useState, useRef } from 'react';
import { Stack, useRouter, useSegments, useGlobalSearchParams } from 'expo-router';
import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import { Alert, LogBox, AppState, AppStateStatus, View, Text, TextInput, Pressable, Platform, StyleSheet, DeviceEventEmitter } from 'react-native';
import { MAX_FONT_SCALE } from '../constants/responsive';
import { registerPillarSync } from '../services/background-task';
import { requestSync } from '../services/pillar-sync';
import { startWebSocketSync, stopWebSocketSync } from '../services/ws-client';
import { registerForPushNotifications, setupNotificationResponseHandler } from '../services/push-notifications';
import { initDB, clearDB, closeDB, redeemInvite } from '../utils/db';
import { normaliseInviteCode, extractInviteToken, extractNodeOrigin } from '../utils/invite-parser';
import { shouldBlockCleartextNodeUrl } from '../utils/node-url';
import { IdentityProvider, useIdentity } from './IdentityContext';
import { NodeStatusProvider, useNodeStatus } from './NodeStatusContext';
import { getPendingOnboarding, subscribePendingOnboarding } from '../utils/onboarding-state';
import { ThemeProvider, useTheme } from './ThemeContext';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import appConfig from '../app.json';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { authenticateUser, getAppLockEnabled } from '../utils/LocalAuth';
import { installNodeRequestSigning } from '../utils/node-request-signing';

LogBox.ignoreLogs(['ProgressBarAndroid', 'Clipboard', 'PushNotificationIOS', 'has been extracted']);

// Forward-compatible read signing (SRV-2/SRV-4): sign GET requests to the anchor
// node so read-auth can be enforced server-side later without another app-store
// release. Installed at module load, before any component renders or fetches.
installNodeRequestSigning();

// Cap OS font scaling app-wide so enlarged system fonts (common on low-end
// devices in our target markets) can't shatter row layouts.
//
// NOTE: React 19 removed `defaultProps` on functional components, and modern
// React Native Text/TextInput are plain functional components without a `.render`
// method, so legacy overrides are silent no-ops. We intercept the exports on
// the mutable `react-native` module object, wrapping them with `React.forwardRef`
// to automatically inject the `maxFontSizeMultiplier` prop unless overridden.
const RN = require('react-native');
const React = require('react');

const OriginalText = RN.Text;
const OriginalTextInput = RN.TextInput;

const PatchedText = React.forwardRef((props: any, ref: any) => {
    const maxFontSizeMultiplier = props.maxFontSizeMultiplier !== undefined
        ? props.maxFontSizeMultiplier
        : MAX_FONT_SCALE;
    return React.createElement(OriginalText, { ...props, ref, maxFontSizeMultiplier });
});
Object.assign(PatchedText, OriginalText);

const PatchedTextInput = React.forwardRef((props: any, ref: any) => {
    const maxFontSizeMultiplier = props.maxFontSizeMultiplier !== undefined
        ? props.maxFontSizeMultiplier
        : MAX_FONT_SCALE;
    return React.createElement(OriginalTextInput, { ...props, ref, maxFontSizeMultiplier });
});
Object.assign(PatchedTextInput, OriginalTextInput);

Object.defineProperty(RN, 'Text', {
    configurable: true,
    enumerable: true,
    get() {
        return PatchedText;
    }
});

Object.defineProperty(RN, 'TextInput', {
    configurable: true,
    enumerable: true,
    get() {
        return PatchedTextInput;
    }
});

function RootLayoutNav() {
    const { identity, isLoading } = useIdentity();
    const { recognition, recheck } = useNodeStatus();
    const { theme } = useTheme();
    const segments = useSegments();
    const router = useRouter();
    const [deepLinkUrl, setDeepLinkUrl] = useState<string | null>(null);
    const isComponentMounted = useRef(true);
    const lastBackgroundTime = useRef<number | null>(null);
    const recoveryNavPrompted = useRef(false); // NAT-20: one-shot guard for the recovery confirmation

    const [isLocked, setIsLocked] = useState(false);
    const [appLockChecked, setAppLockChecked] = useState(false);

    // null = not yet loaded; true = a join wizard was interrupted after the
    // keypair was created but before the invite was redeemed. While true, the
    // identity is a stranger to every node BY DESIGN — route back into the
    // wizard, never to node-mismatch (see utils/onboarding-state.ts).
    const [pendingOnboarding, setPendingOnboardingFlag] = useState<boolean | null>(null);
    useEffect(() => {
        let mounted = true;
        const refresh = () => {
            getPendingOnboarding().then(p => { if (mounted) setPendingOnboardingFlag(!!p); });
        };
        refresh();
        const unsubscribe = subscribePendingOnboarding(refresh);
        return () => { mounted = false; unsubscribe(); };
    }, []);

    const triggerUnlock = async () => {
        const success = await authenticateUser('Unlock BeanPool');
        if (success) {
            setIsLocked(false);
        }
    };

    // Check on startup
    useEffect(() => {
        async function checkAppLock() {
            const enabled = await getAppLockEnabled();
            if (enabled && identity) {
                setIsLocked(true);
                const success = await authenticateUser('Unlock BeanPool');
                if (success) {
                    setIsLocked(false);
                }
            }
            setAppLockChecked(true);
        }
        checkAppLock();
    }, [identity]);

    // Check when returning to foreground
    useEffect(() => {
        const sub = AppState.addEventListener('change', async (next) => {
            if (next === 'background' || next === 'inactive') {
                lastBackgroundTime.current = Date.now();
            } else if (next === 'active' && identity) {
                const bgTime = lastBackgroundTime.current;
                lastBackgroundTime.current = null; // reset

                const enabled = await getAppLockEnabled();
                if (enabled) {
                    const gracePeriodMs = 15000; // 15 seconds grace period
                    if (bgTime && (Date.now() - bgTime) < gracePeriodMs) {
                        return;
                    }
                    setIsLocked(true);
                    const success = await authenticateUser('Unlock BeanPool');
                    if (success) {
                        setIsLocked(false);
                    }
                }
            }
        });
        return () => sub.remove();
    }, [identity]);

    // Set up deep-link listeners for both cold starts and warm starts
    useEffect(() => {
        let active = true;

        // 1. Cold start deep link
        Linking.getInitialURL().then(url => {
            if (active && url) {
                setDeepLinkUrl(url);
            }
        });

        // 2. Warm start deep link (app in background/foreground)
        const subscription = Linking.addEventListener('url', ({ url }) => {
            if (active && url) {
                setDeepLinkUrl(url);
            }
        });

        return () => {
            active = false;
            subscription.remove();
        };
    }, []);

    // Process incoming deep links (multi-node support and onboarding redirects)
    useEffect(() => {
        if (isLoading || !deepLinkUrl) return;

        const currentUrl = deepLinkUrl;
        // Immediately clear state to prevent double execution or infinite loops
        setDeepLinkUrl(null);

        const inviteToken = extractInviteToken(currentUrl);
        // Valid invite tokens must be present, and not be full HTTP URLs or paths
        if (!inviteToken || inviteToken.startsWith('http') || inviteToken.includes('/') || inviteToken.length < 5) {
            return;
        }
        const parsedCode = normaliseInviteCode(inviteToken);

        // Parse node origin / server address from deep link
        let extractedNodeOrigin: string | null = extractNodeOrigin(currentUrl);
        if (!extractedNodeOrigin) {
            const parsed = Linking.parse(currentUrl);
            const rawServer = parsed.queryParams?.server;
            const serverParam = typeof rawServer === 'string'
                ? rawServer
                : Array.isArray(rawServer)
                    ? rawServer[0]
                    : undefined;
            if (serverParam) {
                let decoded = decodeURIComponent(serverParam).trim();
                if (decoded && !decoded.startsWith('http')) {
                    const isIpOrLocal = /^(?:\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(decoded) || decoded.startsWith('localhost');
                    decoded = (isIpOrLocal ? 'http://' : 'https://') + decoded;
                }
                extractedNodeOrigin = decoded;
            }
        }

        // NAT-21 / NAT-4: never act on a deep-link node origin that would be
        // cleartext to a PUBLIC host — a malicious `beanpool://` link (the scheme
        // is unverifiable/claimable by any app) could point us at an MITM-able
        // node. LAN/private cleartext origins are still allowed.
        if (extractedNodeOrigin && shouldBlockCleartextNodeUrl(extractedNodeOrigin)) {
            console.warn('[DeepLink] Ignoring cleartext-public node origin from deep link:', extractedNodeOrigin);
            extractedNodeOrigin = null;
        }

        const routeToWelcomeWithInvite = () => {
            if (!isComponentMounted.current) return;
            const rootSegment = (segments as string[])[0];
            if (rootSegment === 'welcome') {
                router.setParams({
                    invite: parsedCode,
                    server: extractedNodeOrigin || undefined,
                    t: Date.now().toString()
                });
            } else {
                router.replace({
                    pathname: '/welcome',
                    params: {
                        invite: parsedCode,
                        server: extractedNodeOrigin || undefined,
                        t: Date.now().toString()
                    }
                });
            }
        };

        // Case 1: No active identity (New user onboarding or completely wiped DB)
        if (!identity) {
            routeToWelcomeWithInvite();
            return;
        }

        // Case 2: User has active identity (Logged in)
        AsyncStorage.getItem('beanpool_anchor_url').then(async current => {
            if (!isComponentMounted.current) return;

            // Half-finished join wizard: the identity exists on-device but was
            // never registered with any node, so a fresh invite should flow into
            // the wizard like a new user's — not the member node-switch dialogs.
            if (await getPendingOnboarding()) {
                routeToWelcomeWithInvite();
                return;
            }

            const targetOrigin = extractedNodeOrigin || current;
            if (!targetOrigin) return;

            if (current !== targetOrigin) {
                setTimeout(() => {
                    if (!isComponentMounted.current) return;
                    Alert.alert(
                        'Switch Nodes?',
                        `You have been invited to a community node at ${targetOrigin}. Would you like to switch your active connection to this node and redeem your invite code?`,
                        [
                            { text: 'Cancel', style: 'cancel' },
                            {
                                text: 'Switch & Join',
                                onPress: () => {
                                    closeDB()
                                        .then(() => AsyncStorage.setItem('beanpool_anchor_url', targetOrigin))
                                        .then(() => initDB())
                                        .then(async () => {
                                            if (!isComponentMounted.current) return;
                                            
                                            // Redeem!
                                            await redeemInvite(parsedCode, identity?.callsign || 'Unknown', identity);

                                            // Fetch and save new node details
                                            try {
                                                const healthRes = await fetch(`${targetOrigin}/api/community/health`, { method: 'GET' });
                                                if (healthRes.ok) {
                                                    const healthData = await healthRes.json();
                                                    const remoteName = healthData.nodeName || healthData.name || targetOrigin;
                                                    const cType = healthData.currency?.type || 'image';
                                                    const cVal = healthData.currency?.value || 'bean';
                                                    const { addSavedNode } = await import('../utils/nodes');
                                                    await addSavedNode(targetOrigin, remoteName, cType, cVal);
                                                }
                                            } catch (e) {
                                                console.warn('Failed to fetch node details for saving in deep link', e);
                                            }

                                            Alert.alert('Success', 'Node switched and invite redeemed successfully!');
                                            requestSync().catch(console.error);
                                            // Refresh membership for the new node before routing, so a stale
                                            // 'stranger' verdict can't bounce us to the wrong-node screen.
                                            await recheck();
                                            router.replace('/(tabs)');
                                        })
                                        .catch(err => {
                                            Alert.alert('Redemption Failed', err.message || String(err));
                                        });
                                }
                            }
                        ]
                    );
                }, 200);
            } else {
                // Same-node deep link check (Guest mode or stale launch URL)
                const showUnregisteredMemberDialog = () => {
                    setTimeout(() => {
                        if (!isComponentMounted.current) return;
                        Alert.alert(
                            'Active Connection Invite',
                            `You scanned an invite for your active community (${targetOrigin}). How would you like to proceed?`,
                            [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                    text: 'Wipe & Join Fresh',
                                    style: 'destructive',
                                    onPress: () => {
                                        Alert.alert(
                                            'Confirm Wipe',
                                            'This will permanently delete your local database and transaction cache for this community. Your key will be preserved, and you will be routed back to the welcome screen to register with this invite.',
                                            [
                                                { text: 'Cancel', style: 'cancel' },
                                                {
                                                    text: 'Wipe',
                                                    style: 'destructive',
                                                    onPress: async () => {
                                                        try {
                                                            await clearDB();
                                                            await AsyncStorage.removeItem('beanpool_anchor_url');
                                                            const { removeSavedNode } = await import('../utils/nodes');
                                                            await removeSavedNode(targetOrigin);
                                                            router.replace({ pathname: '/welcome', params: { invite: parsedCode, server: targetOrigin } });
                                                        } catch (err: any) {
                                                            Alert.alert('Wipe Failed', err.message);
                                                        }
                                                    }
                                                }
                                            ]
                                        );
                                    }
                                },
                                {
                                    text: 'Join Node',
                                    onPress: () => {
                                        redeemInvite(parsedCode, identity?.callsign || 'Unknown', identity)
                                            .then(async () => {
                                                Alert.alert('Success', 'Invite redeemed! Your connection is registered.');
                                                requestSync().catch(console.error);
                                                await recheck();
                                                router.replace('/(tabs)');
                                            })
                                            .catch(err => {
                                                Alert.alert('Redemption Failed', err.message || String(err));
                                            });
                                    }
                                }
                            ]
                        );
                    }, 200);
                };

                fetch(`${targetOrigin}/api/community/membership/${identity.publicKey}`)
                    .then(res => res.ok ? res.json() : null)
                    .then(data => {
                        if (!isComponentMounted.current) return;
                        const isMember = !!(data && data.isMember);
                        if (isMember) {
                            console.log('[DeepLink] User is already an active member of current node. Ignoring stale invite link.');
                            return;
                        }
                        showUnregisteredMemberDialog();
                    })
                    .catch(err => {
                        console.warn('Failed to check membership on same-node deep link', err);
                        if (!isComponentMounted.current) return;
                        // Active node already saved & connected locally - ignore stale link
                        console.log('[DeepLink] Active node locally connected. Ignoring stale invite link.');
                    });
            }
        });
    }, [deepLinkUrl, identity, isLoading]);

    useEffect(() => {
        if (isLoading) return;
        const root = (segments as string[])[0];

        // If we have no identity and we aren't already on the welcome screen, kick us out
        if (!identity) {
            if (root !== 'welcome') {
                setTimeout(() => {
                    router.replace('/welcome');
                }, 50);
            }
            return;
        }

        // Identity exists but the join wizard never finished (the invite is only
        // redeemed at the final step), so no node recognises this key yet. Send
        // the user back into the wizard to finish joining — a brand-new user on
        // node-mismatch ("this community doesn't recognise you") reads it as
        // "my account is gone". Don't route at all until the flag has loaded.
        if (pendingOnboarding === null) return;
        if (pendingOnboarding) {
            if (root !== 'welcome') router.replace('/welcome');
            return;
        }

        // Reset the one-shot recovery prompt whenever we're no longer in a
        // 'recovering' state, so a future genuine recovery alert can prompt again.
        if (recognition !== 'recovering') recoveryNavPrompted.current = false;

        if (recognition === 'recovering') {
            // NAT-20: the node's `isRecovering` claim is UNSIGNED — a malicious node
            // could use it to silently teleport a logged-in user into the recovery
            // screen (confusion / social-engineering). A user WITHOUT an identity
            // never reaches here (they go to /welcome above), so this is really an
            // "someone is recovering your account" alert, not a recovery flow. So
            // confirm once instead of force-navigating.
            if (root !== 'recover-identity' && !recoveryNavPrompted.current) {
                recoveryNavPrompted.current = true;
                Alert.alert(
                    'Account recovery reported',
                    'The node you are connected to reports a recovery in progress for your account. This may be a legitimate guardian recovery — or a node trying to mislead you. Open the recovery screen to review?',
                    [
                        { text: 'Not now', style: 'cancel' },
                        { text: 'Review', onPress: () => { if (isComponentMounted.current) router.replace('/recover-identity'); } },
                    ],
                );
            }
            return;
        }

        // Identity present, but the active node is reachable and definitively does NOT
        // recognise us (wrong/typo'd node). Divert to the recovery screen — we keep the
        // identity; they just fix or switch the node. Only 'stranger' acts; 'unknown'
        // (unreachable / not yet checked) is left alone so a flaky network never diverts.
        if (recognition === 'stranger') {
            if (root !== 'node-mismatch' && root !== 'welcome') {
                router.replace('/node-mismatch');
            }
            return;
        }

        // Recognised again while sitting on the recovery screen → back into the app.
        if (recognition === 'member' && (root === 'node-mismatch' || root === 'recover-identity')) {
            router.replace('/(tabs)');
            return;
        }

        // Stuck on the welcome screen or root with a valid identity → into the secure area
        if ((segments as string[]).length === 0 || root === 'welcome') {
            router.replace('/(tabs)');
        }
    }, [identity, isLoading, segments, recognition, pendingOnboarding]);

    // Register for push notifications when identity is available
    useEffect(() => {
        if (!identity?.publicKey) return;
        registerForPushNotifications(identity.publicKey).catch(console.warn);
    }, [identity?.publicKey]);

    // Set up notification deep-link handler
    useEffect(() => {
        const subscription = setupNotificationResponseHandler();
        return () => subscription.remove();
    }, []);

    if (isLoading || !appLockChecked) return null; // Or a splash screen

    const isDark = theme === 'dark';

    return (
        <View style={{ flex: 1 }}>
            <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
            <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="(tabs)" options={{ gestureEnabled: false }} />
                <Stack.Screen name="welcome" />
                <Stack.Screen name="node-mismatch" options={{ gestureEnabled: false }} />
                <Stack.Screen name="post/[id]" options={{ presentation: 'modal' }} />
                <Stack.Screen name="propose-project" options={{ presentation: 'modal' }} />
                <Stack.Screen name="public-profile" options={{ presentation: 'modal' }} />
                <Stack.Screen name="new-message" options={{ headerShown: false, animation: 'slide_from_right' }} />
                <Stack.Screen name="chat/[id]" />
            </Stack>

            {isLocked && identity && (
                <View style={[StyleSheet.absoluteFill, {
                    backgroundColor: isDark ? '#0a0a0a' : '#FAF9F6',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 24,
                    zIndex: 99999
                }]}>
                    <StatusBar style={isDark ? 'light' : 'dark'} />
                    <View style={{
                        backgroundColor: isDark ? '#141414' : '#FFFFFF',
                        padding: 32,
                        borderRadius: 24,
                        alignItems: 'center',
                        borderWidth: 1,
                        borderColor: isDark ? '#2e2e2e' : '#EBEBE6',
                        shadowColor: '#000',
                        shadowOffset: { width: 0, height: 4 },
                        shadowOpacity: 0.1,
                        shadowRadius: 12,
                        elevation: 5,
                        width: '100%',
                        maxWidth: 320
                    }}>
                        <Text style={{ fontSize: 48, marginBottom: 16 }}>🔒</Text>
                        <Text style={{
                            fontSize: 22,
                            fontWeight: 'bold',
                            color: isDark ? '#ffffff' : '#1C1D1A',
                            marginBottom: 8,
                            textAlign: 'center'
                        }}>
                            BeanPool Secure
                        </Text>
                        <Text style={{
                            fontSize: 14,
                            color: isDark ? '#a0a0a0' : '#646660',
                            marginBottom: 32,
                            textAlign: 'center',
                            lineHeight: 20
                        }}>
                            Unlock with your device security to access your wallet.
                        </Text>
                        <Pressable
                            style={{
                                backgroundColor: '#10b981',
                                paddingVertical: 14,
                                paddingHorizontal: 28,
                                borderRadius: 12,
                                width: '100%',
                                alignItems: 'center'
                            }}
                            onPress={triggerUnlock}
                            accessibilityRole="button"
                        >
                            <Text style={{ color: '#ffffff', fontSize: 16, fontWeight: 'bold' }}>
                                Unlock App
                            </Text>
                        </Pressable>
                    </View>
                </View>
            )}
        </View>
    );
}

export default function RootLayout() {
    const appState = useRef(AppState.currentState);

    useEffect(() => {
        async function handleAppUpgrade() {
            try {
                const lastRunVersion = await AsyncStorage.getItem('beanpool_last_run_version');
                const currentVersion = appConfig.expo.version;
                if (lastRunVersion !== currentVersion) {
                    await AsyncStorage.removeItem('beanpool_latest_known_version');
                    await AsyncStorage.removeItem('beanpool_last_version_check_time');
                    if (lastRunVersion) {
                        await AsyncStorage.removeItem(`beanpool_dismissed_update_${lastRunVersion}`);
                    }
                    await AsyncStorage.setItem('beanpool_last_run_version', currentVersion);
                }
            } catch (e) {
                console.warn('[Upgrade] Failed to handle app upgrade cache clear:', e);
            }
        }
        handleAppUpgrade();

        // Start the real-time WebSocket connection manager
        startWebSocketSync();

        // Listen for system announcements from the WebSocket connection
        const wsSub = DeviceEventEmitter.addListener('ws_activity', (data) => {
            if (data?.type === 'system_announcement') {
                const title = data.title || 'System Announcement';
                const body = data.body || '';
                Alert.alert(title, body, [{ text: 'Acknowledge', style: 'cancel' }]);
            }
        });

        initDB()
            .then(() => registerPillarSync())
            // Trigger Immediate foreground sync
            .then(() => requestSync())
            .catch(err => {
                console.error('[Init DB] Error:', err);
                Alert.alert('DB Error', String(err));
            });

        // Set up foreground polling fallback every 5 minutes (safety net)
        const intervalId = setInterval(() => {
            if (appState.current === 'active') {
                requestSync();
            }
        }, 300000);

        // App state listener to trigger sync when returning to foreground
        const subscription = AppState.addEventListener('change', nextAppState => {
            if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
                requestSync();
                // Clear app icon badge when user opens the app (only in custom client / standalone builds)
                if (Constants.appOwnership !== 'expo') {
                    try {
                        const Notif = require('expo-notifications');
                        Notif.setBadgeCountAsync(0).catch(() => {});
                    } catch {}
                }
            }
            appState.current = nextAppState;
        });

        return () => {
            clearInterval(intervalId);
            subscription.remove();
            wsSub.remove();
            // Stop and clean up the WebSocket connection
            stopWebSocketSync();
        };
    }, []);

    return (
        <SafeAreaProvider>
            <KeyboardProvider>
                <ThemeProvider>
                    <IdentityProvider>
                        <NodeStatusProvider>
                            <RootLayoutNav />
                        </NodeStatusProvider>
                    </IdentityProvider>
                </ThemeProvider>
            </KeyboardProvider>
        </SafeAreaProvider>
    );
}
