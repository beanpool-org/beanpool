import { Tabs } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GlobalHeader } from '../../components/GlobalHeader';
import { View, Image, StyleSheet, Text, Platform, DeviceEventEmitter } from 'react-native';
import { useState, useEffect, useRef } from 'react';
import { useIdentity } from '../IdentityContext';
import { getGlobalUnreadCount, syncMessages, getPosts, getMarketplaceTransactions } from '../../utils/db';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { palette } from '../../constants/colors';
import { useTheme } from '../ThemeContext';

export default function TabLayout() {
    const { theme, colors } = useTheme();
    const { identity } = useIdentity();
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
            <Tabs backBehavior="none" screenOptions={{
                header: () => <GlobalHeader />,
                tabBarBackground: () => (
                    <View style={{ 
                        position: 'absolute', 
                        top: 0, left: 0, right: 0, bottom: 0, 
                        backgroundColor: 'transparent',
                        overflow: 'hidden' 
                    }}>
                        <Image 
                            source={require('../../assets/images/neon-vines-banner.jpg')} 
                            style={[StyleSheet.absoluteFillObject, { width: '100%', height: '100%', transform: [{ scale: 1.5 }] }]}
                            resizeMode="cover"
                        />
                        <View style={[StyleSheet.absoluteFillObject, { backgroundColor: 'rgba(0,0,0,0.65)' }]} />
                    </View>
                ),
                tabBarStyle: { 
                    backgroundColor: 'transparent', 
                    borderTopWidth: 0,
                    elevation: 0,
                },
                tabBarActiveTintColor: colors.text.inverse,
                tabBarInactiveTintColor: 'rgba(255,255,255,0.6)',
                tabBarLabelStyle: {
                    textShadowColor: 'rgba(0,0,0,1)',
                    textShadowOffset: { width: 0, height: 0 },
                    textShadowRadius: 5,
                    fontWeight: '700',
                    fontSize: 10,
                },
            }}>
                <Tabs.Screen
                    name="index"
                    options={{
                        title: 'Market',
                        tabBarBadge: dealsCount > 0 ? dealsCount : undefined,
                        tabBarIcon: ({ focused }) => <Text style={{ fontSize: 24, transform: [{ scale: focused ? 1.3 : 1 }, { translateY: focused ? -4 : 0 }], opacity: 1, textShadowColor: 'rgba(0,0,0,1)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 8 }}>🤝</Text>
                    }}
                />
                <Tabs.Screen
                    name="map"
                    options={{
                        title: 'Map',
                        headerTransparent: true,
                        tabBarIcon: ({ focused }) => <Text style={{ fontSize: 24, transform: [{ scale: focused ? 1.3 : 1 }, { translateY: focused ? -4 : 0 }], opacity: 1, textShadowColor: 'rgba(0,0,0,1)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 8 }}>🗺️</Text>
                    }}
                />

                <Tabs.Screen 
                    name="chats" 
                    options={{ 
                        title: 'Chat',
                        tabBarBadge: unread > 0 ? unread : undefined,
                        tabBarIcon: ({ focused }) => <Text style={{ fontSize: 24, transform: [{ scale: focused ? 1.3 : 1 }, { translateY: focused ? -4 : 0 }], opacity: 1, textShadowColor: 'rgba(0,0,0,1)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 8 }}>💬</Text> 
                    }} 
                />
                <Tabs.Screen 
                    name="people" 
                    options={{ 
                        title: 'People',
                        tabBarIcon: ({ focused }) => <Text style={{ fontSize: 24, transform: [{ scale: focused ? 1.3 : 1 }, { translateY: focused ? -4 : 0 }], opacity: 1, textShadowColor: 'rgba(0,0,0,1)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 8 }}>👥</Text> 
                    }} 
                />
                <Tabs.Screen 
                    name="projects" 
                    options={{ 
                        title: 'Projects',
                        tabBarIcon: ({ focused }) => <Text style={{ fontSize: 24, transform: [{ scale: focused ? 1.3 : 1 }, { translateY: focused ? -4 : 0 }], opacity: 1, textShadowColor: 'rgba(0,0,0,1)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 8 }}>{Platform.OS === 'ios' ? '🌱' : '🌳'}</Text> 
                    }} 
                />
                <Tabs.Screen 
                    name="ledger" 
                    options={{ 
                        title: 'Ledger',
                        tabBarIcon: ({ focused }) => <Text style={{ fontSize: 24, transform: [{ scale: focused ? 1.3 : 1 }, { translateY: focused ? -4 : 0 }], opacity: 1, textShadowColor: 'rgba(0,0,0,1)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 8 }}>📊</Text> 
                    }} 
                />
                <Tabs.Screen 
                    name="settings" 
                    options={{ 
                        title: 'Settings',
                        href: null,
                        tabBarIcon: ({ focused }) => (
                            <View style={{ transform: [{ scale: focused ? 1.3 : 1 }, { translateY: focused ? -4 : 0 }] }}>
                                <Text style={{ fontSize: 24, opacity: 1, textShadowColor: 'rgba(0,0,0,1)', textShadowOffset: { width: 0, height: 2 }, textShadowRadius: 8 }}>⚙️</Text>
                                {needsBackup && (
                                    <View style={{ position: 'absolute', top: -5, right: -5, backgroundColor: colors.feedback.danger.solid, width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: palette.green950 }} />
                                )}
                            </View>
                        )
                    }} 
                />
            </Tabs>
        </View>
    );
}
