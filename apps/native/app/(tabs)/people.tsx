import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { MemberAvatar } from '../../components/MemberAvatar';
import { View, Text, StyleSheet, FlatList, Pressable, SafeAreaView, Image, ActivityIndicator, Platform, DeviceEventEmitter } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { getDb, getFriendsLocal, addFriendLocal, removeFriendLocal, createConversationApi, setGuardianApi } from '../../utils/db';
import { useIdentity } from '../IdentityContext';
import { hexToBytes, encodeUtf8, encodeBase64, signData, buildSignedHeaders } from '../../utils/crypto';
import QRCode from 'react-native-qrcode-svg';
import { TextInput, Alert, ScrollView, Share, Keyboard } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';

import { router, useLocalSearchParams } from 'expo-router';
import { extractNodeOrigin, normaliseInviteCode } from '../../utils/invite-parser';
import { palette } from '../../constants/colors';
import { useTheme, useStyles } from '../ThemeContext';

type SubView = 'friends' | 'community' | 'invites' | 'guardians';
type SortOption = 'newest' | 'name' | 'friends' | 'trusted' | 'active';

const MEMBER_ROW_HEIGHT = 66;

/** Cache-busting avatar URI keyed to profile timestamp */

function formatJoinDate(dateStr: string | null) {
    if (!dateStr) return 'Member';
    try {
        const d = new Date(dateStr);
        const now = new Date();
        const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
        if (diffDays < 1) return 'Joined today';
        if (diffDays < 7) return `Joined ${diffDays}d ago`;
        if (diffDays < 30) return `Joined ${Math.floor(diffDays / 7)}w ago`;
        return `Joined ${d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
    } catch {
        return 'Member';
    }
};

export default function PeopleScreen() {
    const { theme, colors } = useTheme();
    
    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        safeArea: { flex: 1, backgroundColor: colors.surface.app },
        navRow: { flexDirection: 'row', padding: 12, backgroundColor: colors.surface.card, borderBottomWidth: 1, borderBottomColor: colors.border.default },
        pill: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 8, marginHorizontal: 2 },
        pillActive: { backgroundColor: colors.surface.subtle, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2, elevation: 1, borderWidth: 1, borderColor: colors.border.default },
        pillText: { fontSize: 11, fontWeight: '600', color: colors.text.secondary },
        pillTextActive: { color: colors.text.body, fontWeight: '800' },
        
        emptyContainer: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
        emptyEmoji: { fontSize: 56, marginBottom: 16 },
        emptyTitle: { fontSize: 18, fontWeight: 'bold', color: colors.text.heading, marginBottom: 8 },
        emptyDesc: { fontSize: 14, color: colors.text.secondary, textAlign: 'center', lineHeight: 20 },

        list: { padding: 16 },
        infoBanner: { backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.green50, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.green100, marginBottom: 16 },
        infoText: { color: theme === 'dark' ? colors.text.body : palette.green800, fontSize: 13, lineHeight: 18 },
        boldGreen: { fontWeight: 'bold', color: colors.brand.primary },

        card: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.surface.card, padding: 16, borderRadius: 16, marginBottom: 12, borderWidth: 1, borderColor: colors.border.default, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.02, shadowRadius: 4, elevation: 1 },
        cardHeader: { flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 },
        avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface.subtle, alignItems: 'center', justifyContent: 'center', marginRight: 12, borderWidth: 1, borderColor: colors.border.default },
        avatarEmoji: { fontSize: 20 },
        textStack: { justifyContent: 'center', flex: 1, minWidth: 0 },
        callsign: { fontSize: 16, fontWeight: '700', color: colors.text.heading, flexShrink: 1 },
        dateText: { fontSize: 12, color: colors.text.muted, marginTop: 2, fontWeight: '500' },
        addBtn: { backgroundColor: colors.brand.dark, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 10, flexShrink: 0, marginLeft: 8, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 2, elevation: 2 },
        addBtnText: { color: colors.text.inverse, fontWeight: 'bold', fontSize: 12 },

        searchWrap: { paddingHorizontal: 16, paddingTop: 16, backgroundColor: colors.surface.app },
        searchInput: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 12, fontSize: 15, color: colors.text.heading, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2, elevation: 1 },
        sortRow: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4, backgroundColor: colors.surface.app, gap: 6 },
        sortPill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 16, backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.default },
        sortPillActive: { backgroundColor: colors.brand.dark, borderColor: colors.brand.dark },
        sortPillText: { fontSize: 11, fontWeight: '600', color: colors.text.secondary },
        sortPillTextActive: { color: colors.text.inverse },

        sectionHeader: { fontSize: 20, fontWeight: '800', color: colors.text.heading, marginBottom: 6 },
        sectionDesc: { fontSize: 13, color: colors.text.secondary, marginBottom: 20, lineHeight: 18 },
        input: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, padding: 16, borderRadius: 12, fontSize: 15, fontWeight: '500', marginBottom: 16, color: colors.text.heading },
        btnGenerate: { backgroundColor: colors.brand.dark, padding: 16, borderRadius: 12, alignItems: 'center', marginBottom: 24, shadowColor: colors.brand.dark, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 6, elevation: 4 },
        btnGenerateText: { color: colors.text.inverse, fontSize: 15, fontWeight: 'bold' },

        qrCard: { backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.green50, borderWidth: 2, borderColor: colors.brand.primary, borderRadius: 16, padding: 20, alignItems: 'center', marginBottom: 24 },
        qrTitle: { color: theme === 'dark' ? colors.text.body : palette.emerald700, fontSize: 14, fontWeight: '600', marginBottom: 16 },
        qrBox: { backgroundColor: colors.surface.card, padding: 16, borderRadius: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2, marginBottom: 16 },
        btnCopyQR: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, paddingVertical: 12, paddingHorizontal: 24, borderRadius: 10 },
        btnCopyQRText: { color: colors.text.body, fontSize: 14, fontWeight: '700' },

        pendingHeader: { fontSize: 12, fontWeight: '800', color: colors.text.muted, marginBottom: 12, letterSpacing: 1 },
        pendingCard: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 14, marginBottom: 10, flexDirection: 'row', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.03, shadowRadius: 3, elevation: 1 },
        pendingFor: { fontSize: 12, fontWeight: '700', color: colors.brand.dark, marginBottom: 4 },
        pendingCode: { fontSize: 13, fontFamily: 'monospace', color: colors.text.heading, fontWeight: '600' },
        btnCopySmall: { backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.default, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 8, marginLeft: 12 },
        btnCopySmallText: { fontSize: 12, fontWeight: '600', color: colors.text.secondary },

        // Friend-specific styles
        friendChip: { fontSize: 10, fontWeight: '800', color: palette.amber500, backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : palette.amber50, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: 'hidden', flexShrink: 0 },
        addBtnFriended: { backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.strong, shadowOpacity: 0 },
        addBtnTextFriended: { color: colors.brand.dark },
        friendActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
        msgBtn: { backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.green50, width: 40, height: 40, borderRadius: 12, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.green100 },
        msgBtnText: { fontSize: 18 },
        removeFriendBtn: { backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.red50, width: 40, height: 40, borderRadius: 12, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: theme === 'dark' ? colors.border.default : palette.red200 },
        removeFriendBtnText: { fontSize: 16, color: colors.feedback.danger.solid, fontWeight: '700' },

        // Community virtualized row (fixed height)
        communityRow: {
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            height: MEMBER_ROW_HEIGHT,
            paddingHorizontal: 16,
            borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.surface.subtle,
            backgroundColor: colors.surface.card,
        },
        peopleRow: {
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            paddingVertical: 10,
            paddingHorizontal: 16,
            borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.surface.subtle,
            backgroundColor: colors.surface.card,
        },
        communityFriendDot: {
            position: 'absolute', bottom: -2, right: -2, width: 16, height: 16, borderRadius: 8,
            backgroundColor: palette.amber500, justifyContent: 'center', alignItems: 'center',
            borderWidth: 2, borderColor: colors.text.inverse,
        },
    }));

    const params = useLocalSearchParams<{ view: string }>();
    const [view, setView] = useState<SubView>((params.view as SubView) || 'community');
    const [keyboardHeight, setKeyboardHeight] = useState(0);

    useEffect(() => {
        if (params.view && ['friends', 'community', 'invites', 'guardians'].includes(params.view)) {
            setView(params.view as SubView);
        }
    }, [params.view]);

    useEffect(() => {
        const sub = DeviceEventEmitter.addListener('set_people_view', (data) => {
            if (data && data.view && ['friends', 'community', 'invites', 'guardians'].includes(data.view)) {
                setView(data.view as SubView);
                router.setParams({ view: data.view });
            }
        });
        return () => sub.remove();
    }, []);

    useEffect(() => {
        const showSub = Keyboard.addListener('keyboardDidShow', (e) => setKeyboardHeight(e.endCoordinates.height));
        const hideSub = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
        return () => { showSub.remove(); hideSub.remove(); };
    }, []);
    const [invites, setInvites] = useState<any[]>([]);
    const [generating, setGenerating] = useState(false);
    const [intendedFor, setIntendedFor] = useState('');
    const [newCode, setNewCode] = useState('');
    
    const [redeemCode, setRedeemCode] = useState('');
    const [redeemNodeUrl, setRedeemNodeUrl] = useState('');
    const [redeeming, setRedeeming] = useState(false);
    const [anchorUrl, setAnchorUrl] = useState('');
    const [canInvite, setCanInvite] = useState(true);
    const [tierName, setTierName] = useState('');
    const [isGuest, setIsGuest] = useState(false);
    const [isOnline, setIsOnline] = useState(true);

    const [members, setMembers] = useState<any[]>([]);
    const { identity } = useIdentity();

    const [searchQuery, setSearchQuery] = useState('');
    const [sortOption, setSortOption] = useState<SortOption>('newest');
    const [guardianSyncing, setGuardianSyncing] = useState<string | null>(null);

    const [friends, setFriends] = useState<any[]>([]);
    const [friendPubkeys, setFriendPubkeys] = useState<Set<string>>(new Set());
    const [friendsLoading, setFriendsLoading] = useState(false);

    useEffect(() => {
        if (view === 'friends' || view === 'guardians') {
            loadFriends();
        } else {
            loadFriends(true); // background load to keep "+ Add" / "✓ Added" indicators fresh
        }

        // Reset and reload when switching back to community view
        if (view === 'community') {
            setSearchQuery('');
            loadMembers('', sortOption);
        }
        if (view === 'invites') {
            loadOfflineInvites();
            checkOnlineStatus();
        }
        AsyncStorage.getItem('beanpool_anchor_url').then(async val => {
            if (val) {
                setAnchorUrl(val);
                if (identity?.publicKey) {
                    try {
                        const res = await fetch(`${val}/api/community/membership/${identity.publicKey}`);
                        if (res.ok) {
                            const data = await res.json();
                            setIsGuest(!data.isMember);
                        }
                    } catch (e) {
                        console.warn('Failed to probe guest state in people.tsx', e);
                    }
                }
            }
        }).catch(() => {});
        // Load tier data for invite gating
        if (identity?.publicKey) {
            AsyncStorage.getItem(`bp_tier_${identity.publicKey}`).then(cached => {
                if (cached) {
                    const parsed = JSON.parse(cached);
                    setCanInvite(parsed.tier?.canInvite ?? true);
                    setTierName(parsed.tier?.name ?? '');
                }
            }).catch(() => {});
        }
    }, [view]);

    useEffect(() => {
        const sub = DeviceEventEmitter.addListener('sync_data_updated', () => {
            if (view === 'community') {
                loadMembers(searchQuery, sortOption);
            } else if (view === 'friends' || view === 'guardians') {
                loadFriends(true); // background refresh — silent, no spinner toggle
            }
        });
        return () => sub.remove();
    }, [view, searchQuery]);

    // `background` refreshes (triggered by sync_data_updated) must NOT toggle the loading
    // spinner — syncs fire on every WebSocket broadcast, so flipping friendsLoading on each
    // one swaps the whole list for a spinner and back, which reads as constant flicker. Only
    // the foreground load (entering the tab) shows the spinner.
    const loadFriends = async (background = false) => {
        if (!identity?.publicKey) return;
        if (!background) setFriendsLoading(true);
        try {
            const result = await getFriendsLocal(identity.publicKey);
            setFriends(result);
            setFriendPubkeys(new Set(result.map((f: any) => f.publicKey)));
        } catch (e) {
            console.error('[People] Failed to load friends:', e);
        } finally {
            if (!background) setFriendsLoading(false);
        }
    };

    const loadOfflineInvites = async () => {
        if (!identity?.publicKey) return;
        try {
            const stored = await AsyncStorage.getItem(`bp_offline_invites_${identity.publicKey}`);
            let localInvites = [];
            if (stored) {
                localInvites = JSON.parse(stored);
                setInvites(localInvites);
            }

            const activeAnchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
            if (activeAnchorUrl) {
                const res = await fetch(`${activeAnchorUrl}/api/invite/mine/${identity.publicKey}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.invites) {
                        const serverInvites = data.invites;
                        const updatedInvites = localInvites.map((localInv: any) => {
                            const match = serverInvites.find((si: any) => si.code.toLowerCase() === localInv.code.toLowerCase());
                            if (match) {
                                return {
                                    ...localInv,
                                    usedBy: match.usedBy,
                                    usedAt: match.usedAt
                                };
                            }
                            return localInv;
                        });

                        serverInvites.forEach((si: any) => {
                            const exists = updatedInvites.some((li: any) => li.code.toLowerCase() === si.code.toLowerCase());
                            if (!exists) {
                                updatedInvites.push({
                                    code: si.code,
                                    createdBy: si.createdBy,
                                    createdAt: si.createdAt,
                                    intendedFor: si.intendedFor,
                                    usedBy: si.usedBy,
                                    usedAt: si.usedAt
                                });
                            }
                        });

                        setInvites(updatedInvites);
                        await AsyncStorage.setItem(`bp_offline_invites_${identity.publicKey}`, JSON.stringify(updatedInvites));
                    }
                }
            }
        } catch (e) {
            console.warn('[People] Failed to sync invites from server:', e);
        }
    };

    const checkOnlineStatus = async () => {
        try {
            const url = await AsyncStorage.getItem('beanpool_anchor_url');
            if (!url) {
                setIsOnline(false);
                return;
            }
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);
            const res = await fetch(`${url}/api/community/health`, {
                method: 'GET',
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            setIsOnline(res.ok);
        } catch {
            setIsOnline(false);
        }
    };

    const handleGenerate = async () => {
        if (!identity) return;
        setGenerating(true);
        try {
            // First attempt Online generation via API
            try {
                const apiPayload = {
                    publicKey: identity.publicKey,
                    intendedFor: intendedFor || undefined
                };
                const apiPayloadStr = JSON.stringify(apiPayload);
                const headers = await buildSignedHeaders('POST', '/api/invite/generate', apiPayloadStr, identity.privateKey, identity.publicKey);

                const res = await fetch(`${anchorUrl}/api/invite/generate`, {
                    method: 'POST',
                    headers,
                    body: apiPayloadStr
                });
                
                if (res.ok) {
                    const data = await res.json();
                    if (data.success && data.invite) {
                        const code = data.invite.code;
                        setNewCode(code);
                        setIntendedFor('');
                        
                        const inviteObj = {
                            code,
                            createdBy: identity.publicKey,
                            createdAt: new Date().toISOString(),
                            intendedFor: intendedFor || undefined
                        };
                        
                        const updated = [inviteObj, ...invites];
                        setInvites(updated);
                        await AsyncStorage.setItem(`bp_offline_invites_${identity.publicKey}`, JSON.stringify(updated));
                        setGenerating(false);
                        return;
                    }
                }
            } catch (err) {
                console.log('Online invite generation failed. Falling back to offline ticket...', err);
            }

            // Offline Fallback
            Alert.alert(
                'Offline Mode',
                'You are currently offline. A temporary cryptographic offline invite ticket (valid for 7 days) will be generated instead.',
                [{ text: 'OK' }]
            );

            const payloadObj = {
                i: identity.publicKey,
                t: Date.now(),
                f: intendedFor || undefined
            };
            const payloadStr = JSON.stringify(payloadObj);
            
            const messageBytes = encodeUtf8(payloadStr);
            const privateKeyBytes = hexToBytes(identity.privateKey);
            const signatureBytes = await signData(messageBytes, privateKeyBytes);
            
            const signatureBase64 = encodeBase64(signatureBytes);
            const payloadBase64 = encodeBase64(messageBytes);
            
            const ticketObj = { p: payloadBase64, s: signatureBase64 };
            const ticketBytes = encodeUtf8(JSON.stringify(ticketObj));
            const ticketB64 = encodeBase64(ticketBytes);
            
            const code = `BP-${ticketB64}`;
            setNewCode(code);
            setIntendedFor('');

            const inviteObj = {
                code,
                createdBy: identity.publicKey,
                createdAt: new Date().toISOString(),
                intendedFor: payloadObj.f
            };
            
            const updated = [inviteObj, ...invites];
            setInvites(updated);
            await AsyncStorage.setItem(`bp_offline_invites_${identity.publicKey}`, JSON.stringify(updated));
        } catch (e: any) {
            Alert.alert('Error', e.message || 'Failed to generate ticket');
        } finally {
            setGenerating(false);
        }
    };

    const shareInvite = async (codeToShare: string) => {
        const magicLink = `${anchorUrl}/?invite=${codeToShare}`;
        
        let message = `Join my private BeanPool Node! ✨\n\n`;
        message += `Click this secure link to join automatically:\n${magicLink}\n\n`;
        message += `Or if you prefer, you can download the BeanPool App at https://beanpool.org and enter this Invite Code manually:\n${codeToShare}\n\n`;
        message += `Node URL: ${anchorUrl}`;

        await Share.share({ message });
    };

    const handleRedeem = async () => {
        const rawInvite = redeemCode.trim();
        if (!rawInvite) return;
        setRedeeming(true);
        try {
            const extractedOrigin = extractNodeOrigin(rawInvite);
            let targetNodeUrl = anchorUrl;

            if (extractedOrigin) {
                targetNodeUrl = extractedOrigin;
            } else {
                let nodeUrl = redeemNodeUrl.trim();
                if (nodeUrl && !nodeUrl.startsWith('http')) {
                    const isIpOrLocal = /^(?:\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(nodeUrl) || nodeUrl.startsWith('localhost');
                    nodeUrl = (isIpOrLocal ? 'http://' : 'https://') + nodeUrl;
                }
                if (nodeUrl) targetNodeUrl = nodeUrl;
            }

            if (targetNodeUrl === anchorUrl) {
                let isMember = false;
                try {
                    const res = await fetch(`${targetNodeUrl}/api/community/membership/${identity?.publicKey}`);
                    if (res.ok) {
                        const data = await res.json();
                        isMember = !!data.isMember;
                    }
                } catch (e) {
                    console.warn('Membership check failed, assuming Guest', e);
                }

                if (isMember) {
                    Alert.alert('Already a Member', 'You are already a member of this community node.');
                    setRedeeming(false);
                    return;
                }

                // If they are in Guest Mode on the active node, redeem directly without database swap!
                const parsedCode = normaliseInviteCode(rawInvite);
                const { redeemInvite } = await import('../../utils/db');
                await redeemInvite(parsedCode, identity?.callsign || 'Unknown', identity);

                const { requestSync } = await import('../../services/pillar-sync');
                requestSync().catch(console.error);

                Alert.alert('Success', 'Invite redeemed! You have successfully registered as a member on this community.');
                setIsGuest(false);
                setRedeemCode('');
                setRedeemNodeUrl('');
                router.replace('/');
                setRedeeming(false);
                return;
            }

            const parsedCode = normaliseInviteCode(rawInvite);

            const { closeDB, initDB, redeemInvite } = await import('../../utils/db');
            
            // Switch DB context temporarily or permanently
            await closeDB();
            await AsyncStorage.setItem('beanpool_anchor_url', targetNodeUrl);
            await initDB();

            try {
                await redeemInvite(parsedCode, identity?.callsign || 'Unknown', identity);
                
                const { requestSync } = await import('../../services/pillar-sync');
                requestSync().catch(console.error);

                try {
                    const healthRes = await fetch(`${targetNodeUrl}/api/community/health`, { method: 'GET' });
                    if (healthRes.ok) {
                        const healthData = await healthRes.json();
                        const remoteName = healthData.nodeName || healthData.name || targetNodeUrl;
                        const cType = healthData.currency?.type || 'image';
                        const cVal = healthData.currency?.value || 'bean';
                        const { addSavedNode } = await import('../../utils/nodes');
                        await addSavedNode(targetNodeUrl, remoteName, cType, cVal);
                    }
                } catch (e) {
                    console.warn('Failed to fetch node details for saving', e);
                }

                Alert.alert('Success', 'Invite redeemed! You have successfully switched to the new community.');
                setRedeemCode('');
                setRedeemNodeUrl('');
                router.replace('/');
            } catch (err: any) {
                // Revert DB on failure
                await closeDB();
                await AsyncStorage.setItem('beanpool_anchor_url', anchorUrl);
                await initDB();
                throw err;
            }
        } catch (e: any) {
            Alert.alert('Redemption Failed', e.message);
        } finally {
            setRedeeming(false);
        }
    };

    const handleTroubleWipe = () => {
        Alert.alert(
            'Wipe Connection?',
            'This will permanently delete the local database and transaction cache for this community. Your key will be preserved, and you will be routed back to the welcome screen to register with a new invite link.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Wipe & Restart',
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            const { clearDB } = await import('../../utils/db');
                            await clearDB();
                            
                            const activeUrl = anchorUrl;
                            await AsyncStorage.removeItem('beanpool_anchor_url');
                            
                            if (activeUrl) {
                                const { removeSavedNode } = await import('../../utils/nodes');
                                await removeSavedNode(activeUrl);
                            }
                            
                            setIsGuest(false);
                            router.replace('/welcome');
                        } catch (err: any) {
                            Alert.alert('Wipe Failed', err.message);
                        }
                    }
                }
            ]
        );
    };


    // Debounced Search Effect
    useEffect(() => {
        if (view !== 'community') return;
        const timeout = setTimeout(() => {
            loadMembers(searchQuery, sortOption);
        }, 400);
        return () => clearTimeout(timeout);
    }, [searchQuery, sortOption]);

    const loadMembers = async (query = '', sort: SortOption = 'newest') => {
        try {
            const database = await getDb();
            
            let sql = 'SELECT * FROM members WHERE public_key NOT LIKE \'escrow_%\' AND public_key NOT LIKE \'project_%\'';
            const params: any[] = [];
            
            if (query.trim()) {
                sql += ' AND (callsign LIKE ? OR public_key LIKE ?)';
                const likeTerm = `%${query.trim()}%`;
                params.push(likeTerm, likeTerm);
            }
            
            // Apply SQL sort (Friends First is handled client-side below)
            switch (sort) {
                case 'name':
                    sql += ' ORDER BY callsign COLLATE NOCASE ASC';
                    break;
                case 'trusted':
                    sql += ' ORDER BY earned_credit DESC, joined_at DESC';
                    break;
                case 'active':
                    sql += ' ORDER BY last_active_at DESC NULLS LAST, joined_at DESC';
                    break;
                default: // 'newest' and 'friends' (friends sorted client-side)
                    sql += ' ORDER BY joined_at DESC';
                    break;
            }
            
            const rows = await database.getAllAsync<any>(sql, params);

            // Client-side sort: friends first, then everyone else by joined date
            if (sort === 'friends') {
                rows.sort((a, b) => {
                    const aFriend = friendPubkeys.has(a.public_key) ? 1 : 0;
                    const bFriend = friendPubkeys.has(b.public_key) ? 1 : 0;
                    if (aFriend !== bFriend) return bFriend - aFriend;
                    return new Date(b.joined_at).getTime() - new Date(a.joined_at).getTime();
                });
            }

            setMembers(rows);
        } catch (e) {
            console.error('Error loading members:', e);
        }
    };

    const pendingInvites = invites.filter((i: any) => !i.usedBy);

    return (
        <SafeAreaView style={styles.safeArea}>
            {/* Header sub-nav */}
            <View style={styles.navRow}>
                {(['friends', 'community', 'invites', 'guardians'] as SubView[]).map(v => {
                    const isActive = view === v;
                    return (
                        <Pressable
                            key={v}
                            accessibilityRole="button"
                            accessibilityState={{ selected: isActive }}
                            style={[styles.pill, isActive && styles.pillActive]}
                            onPress={() => { setView(v); router.setParams({ view: v }); }}
                        >
                            <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={[styles.pillText, isActive && styles.pillTextActive]}>
                                {v === 'friends' && '👫 Friends'}
                                {v === 'community' && '🏘️ Community'}
                                {v === 'invites' && (isGuest ? '🎟️ Register' : '🎟️ Invites')}
                                {v === 'guardians' && '🛡️ Guardians'}
                            </Text>
                        </Pressable>
                    );
                })}
            </View>

            {/* Views */}
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                keyboardVerticalOffset={88}
                style={{ flex: 1 }}
            >
            {view === 'friends' && (
                friendsLoading ? (
                    <View style={styles.emptyContainer}>
                        <ActivityIndicator size="large" color={colors.accent.primary} />
                    </View>
                ) : friends.length === 0 ? (
                    <View style={styles.emptyContainer}>
                        <Text style={styles.emptyEmoji}>👫</Text>
                        <Text style={styles.emptyTitle}>No friends yet</Text>
                        <Text style={styles.emptyDesc}>Go to Community to browse members and add friends.</Text>
                    </View>
                ) : (
                    <FlatList
                        data={friends}
                        keyExtractor={(item, index) => `${item.publicKey}_${index}`}
                        contentContainerStyle={[styles.list, { paddingBottom: keyboardHeight > 0 ? keyboardHeight + 20 : 16 }]}
                        renderItem={({ item, index }) => {
                            const isFirst = index === 0;
                            const isLast = index === friends.length - 1;
                            return (
                            <View style={[
                                styles.peopleRow,
                                isFirst && { borderTopLeftRadius: 12, borderTopRightRadius: 12 },
                                isLast && { borderBottomLeftRadius: 12, borderBottomRightRadius: 12, borderBottomWidth: 0 },
                                { overflow: 'hidden' }
                            ]}>
                                <Pressable
                                    accessibilityRole="button"
                                    style={styles.cardHeader}
                                    onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: item.publicKey, callsign: item.callsign || 'Unknown' } })}
                                >
                                    <View style={styles.avatar}>
                                        <MemberAvatar avatarUrl={item.avatar_url} pubkey={item.publicKey} callsign={item.callsign || '?'} size={44} />
                                    </View>
                                    <View style={styles.textStack}>
                                        <Text style={styles.callsign} numberOfLines={1}>{item.callsign}</Text>
                                        <Text style={styles.dateText}>
                                            Added {item.addedAt ? new Date(item.addedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'recently'}
                                        </Text>
                                    </View>
                                </Pressable>
                                <View style={styles.friendActions}>
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel="Message"
                                        style={styles.msgBtn}
                                        onPress={async () => {
                                            if (!identity?.publicKey) return;
                                            try {
                                                const conv = await createConversationApi('dm', [identity.publicKey, item.publicKey], identity.publicKey);
                                                router.push(`/chat/${conv.id}`);
                                            } catch (e: any) {
                                                Alert.alert('Error', e.message);
                                            }
                                        }}
                                    >
                                        <Text style={styles.msgBtnText}>💬</Text>
                                    </Pressable>
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityLabel="Remove friend"
                                        accessibilityHint="Removes this person from your friends"
                                        style={styles.removeFriendBtn}
                                        onPress={() => {
                                            Alert.alert('Remove Friend', `Remove ${item.callsign} from your friends?`, [
                                                { text: 'Cancel', style: 'cancel' },
                                                { text: 'Remove', style: 'destructive', onPress: async () => {
                                                    if (!identity?.publicKey) return;
                                                    await removeFriendLocal(identity.publicKey, item.publicKey);
                                                    loadFriends();
                                                }}
                                            ]);
                                        }}
                                    >
                                        <Text style={styles.removeFriendBtnText}>✕</Text>
                                    </Pressable>
                                </View>
                            </View>
                        );}}
                    />
                )
            )}

            {view === 'community' && (
                <>
                    <View style={styles.searchWrap}>
                        <TextInput
                            accessibilityLabel="Search callsign or public key"
                            style={styles.searchInput}
                            placeholder="🔍 Search callsign or public key..."
                            value={searchQuery}
                            onChangeText={setSearchQuery}
                            placeholderTextColor={colors.text.muted}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                    </View>
                    <View style={styles.sortRow}>
                        {([['newest', 'clock-outline', 'Newest'], ['name', 'sort-alphabetical-ascending', 'Name'], ['friends', 'account-heart-outline', 'Friends'], ['trusted', 'shield-star-outline', 'Trusted'], ['active', 'lightning-bolt', 'Active']] as [SortOption, string, string][]).map(([key, icon, label]) => (
                            <Pressable
                                key={key}
                                accessibilityRole="button"
                                accessibilityState={{ selected: sortOption === key }}
                                style={[styles.sortPill, sortOption === key && styles.sortPillActive]}
                                onPress={() => setSortOption(key)}
                            >
                                <MaterialCommunityIcons name={icon as any} size={14} color={sortOption === key ? colors.text.inverse : colors.text.secondary} />
                                <Text style={[styles.sortPillText, sortOption === key && styles.sortPillTextActive]}>{label}</Text>
                            </Pressable>
                        ))}
                    </View>
                    <FlatList
                        data={members}
                        keyExtractor={item => item.public_key}
                        contentContainerStyle={[styles.list, { paddingBottom: keyboardHeight > 0 ? keyboardHeight + 20 : 16 }]}
                        getItemLayout={(_data, index) => ({
                            length: MEMBER_ROW_HEIGHT,
                            offset: MEMBER_ROW_HEIGHT * index,
                            index,
                        })}
                        initialNumToRender={20}
                        maxToRenderPerBatch={30}
                        windowSize={7}
                        removeClippedSubviews={Platform.OS !== 'web'}
                        keyboardShouldPersistTaps="handled"
                        keyboardDismissMode="on-drag"
                        ListHeaderComponent={
                            <View style={styles.infoBanner}>
                                <Text style={styles.infoText}>
                                    {members.length} members on this node. Tap <Text style={styles.boldGreen}>+ Add</Text> to follow as a friend.
                                </Text>
                            </View>
                        }
                        ListEmptyComponent={
                            <View style={{ padding: 40, alignItems: 'center' }}>
                                <Text style={{ color: colors.text.muted, fontSize: 15, fontWeight: '500' }}>
                                    {searchQuery ? 'No members match your search.' : 'Loading community...'}
                                </Text>
                            </View>
                        }
                        renderItem={({ item, index }) => {
                        const isFriend = friendPubkeys.has(item.public_key);
                        const isSelf = item.public_key === identity?.publicKey;
                        const joinDateText = formatJoinDate(item.joined_at);
                        const isFirst = index === 0;
                        const isLast = index === members.length - 1;
                        return (
                        <View style={[
                            styles.communityRow,
                            isFirst && { borderTopLeftRadius: 12, borderTopRightRadius: 12 },
                            isLast && { borderBottomLeftRadius: 12, borderBottomRightRadius: 12, borderBottomWidth: 0 },
                            { overflow: 'hidden' }
                        ]}>
                            <Pressable
                                accessibilityRole="button"
                                style={styles.cardHeader}
                                onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: item.public_key, callsign: item.callsign || 'Unknown' } })}
                            >
                                <View style={styles.avatar}>
                                    <MemberAvatar avatarUrl={item.avatar_url} pubkey={item.public_key} callsign={item.callsign || '?'} size={44} />
                                    {isFriend && (
                                        <View style={styles.communityFriendDot}>
                                            <Text style={{ fontSize: 8, color: colors.text.inverse, fontWeight: '800' }}>★</Text>
                                        </View>
                                    )}
                                </View>
                                <View style={styles.textStack}>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                                        <Text style={styles.callsign} numberOfLines={1}>{item.callsign}</Text>
                                        {isFriend && <Text style={styles.friendChip}>Friend</Text>}
                                    </View>
                                    <Text style={styles.dateText} numberOfLines={1}>
                                        {joinDateText}
                                    </Text>
                                </View>
                            </Pressable>
                            {!isSelf && (
                                <Pressable
                                    accessibilityRole="button"
                                    accessibilityState={{ selected: isFriend }}
                                    style={[styles.addBtn, isFriend && styles.addBtnFriended]}
                                    onPress={async () => {
                                        if (!identity?.publicKey) return;
                                        if (isFriend) {
                                            await removeFriendLocal(identity.publicKey, item.public_key);
                                        } else {
                                            await addFriendLocal(identity.publicKey, item.public_key);
                                        }
                                        loadFriends();
                                    }}
                                >
                                    <Text style={[styles.addBtnText, isFriend && styles.addBtnTextFriended]}>
                                        {isFriend ? '✓ Added' : '+ Add'}
                                    </Text>
                                </Pressable>
                            )}
                        </View>
                    );
                    }}
                />
                </>
            )}

            {view === 'invites' && (
                <ScrollView contentContainerStyle={[styles.list, { paddingBottom: keyboardHeight > 0 ? keyboardHeight + 20 : 16 }]}>
                    {isGuest ? (
                        <View style={{ backgroundColor: theme === 'dark' ? colors.feedback.warning.bg : palette.amber50, borderRadius: 12, padding: 16, marginBottom: 24, borderWidth: 1, borderColor: theme === 'dark' ? colors.feedback.warning.border : palette.amber200 }}>
                            <Text style={{ color: theme === 'dark' ? colors.feedback.warning.fg : palette.amber600, fontSize: 15, fontWeight: '700', marginBottom: 4 }}>
                                ⚠️ Guest Connection Mode
                            </Text>
                            <Text style={{ color: theme === 'dark' ? colors.text.body : palette.amber700, fontSize: 13, lineHeight: 18 }}>
                                You are currently connected to this node in **Guest Mode**. You cannot generate invites or participate in community trade until you register your identity.
                            </Text>
                        </View>
                    ) : (
                        <>
                            {/* GENERATE INVITE SECTION */}
                            <Text style={styles.sectionHeader}>📤 Invite Someone</Text>
                            <Text style={styles.sectionDesc}>Invite links are single-use and valid for 7 days. If you are offline, a cryptographic voucher ticket will be generated instead.</Text>

                            {!canInvite && (
                                <View style={{ backgroundColor: colors.surface.subtle, borderRadius: 12, padding: 14, marginBottom: 12, borderWidth: 1, borderColor: colors.border.default }}>
                                    <Text style={{ color: colors.text.secondary, fontSize: 13, fontWeight: '600', textAlign: 'center' }}>
                                        👻 Invite generation unlocks at <Text style={{ color: colors.accent.primary, fontWeight: '800' }}>Resident</Text> tier.
                                        Trade on the Marketplace to build trust.
                                    </Text>
                                </View>
                            )}

                            <TextInput
                                placeholder="Who is this invite for? (Optional)"
                                value={intendedFor}
                                onChangeText={setIntendedFor}
                                style={styles.input}
                                placeholderTextColor={colors.text.muted}
                                editable={canInvite}
                            />

                            <Pressable
                                accessibilityRole="button"
                                style={[styles.btnGenerate, (generating || !canInvite) && { opacity: 0.6 }]}
                                onPress={handleGenerate}
                                disabled={generating || !canInvite}
                            >
                                <Text style={styles.btnGenerateText}>{!canInvite ? '🔒 Invites Locked' : generating ? 'Generating...' : isOnline ? '✨ Generate Ticket' : '✨ Generate Offline Ticket'}</Text>
                            </Pressable>

                            {newCode ? (
                                <View style={styles.qrCard}>
                                    <Text style={styles.qrTitle}>Share this cryptographic code</Text>
                                    <View style={styles.qrBox}>
                                        <QRCode
                                            value={`${anchorUrl}/?invite=${newCode}`}
                                            size={180}
                                        />
                                    </View>
                                    <Pressable
                                        accessibilityRole="button"
                                        style={styles.btnCopyQR}
                                        onPress={() => shareInvite(newCode)}
                                    >
                                        <Text style={styles.btnCopyQRText}>📤 Share Invite</Text>
                                    </Pressable>
                                </View>
                            ) : null}

                            {pendingInvites.length > 0 && (
                                <View style={{ marginTop: 24 }}>
                                    <Text style={styles.pendingHeader}>⏳ PENDING ({pendingInvites.length})</Text>
                                    {pendingInvites.map((inv) => (
                                        <View key={inv.code} style={styles.pendingCard}>
                                            <View style={{ flex: 1 }}>
                                                {inv.intendedFor ? (
                                                    <Text style={styles.pendingFor}>For: {inv.intendedFor}</Text>
                                                ) : null}
                                                <Text style={styles.pendingCode} numberOfLines={1} ellipsizeMode="middle">
                                                    {inv.code}
                                                </Text>
                                            </View>
                                            <Pressable
                                                accessibilityRole="button"
                                                style={styles.btnCopySmall}
                                                onPress={() => shareInvite(inv.code)}
                                            >
                                                <Text style={styles.btnCopySmallText}>Share</Text>
                                            </Pressable>
                                        </View>
                                    ))}
                                </View>
                            )}
                        </>
                    )}

                    <View style={{ height: 1, backgroundColor: colors.border.default, marginVertical: 32 }} />

                    {/* REDEEM INVITE SECTION */}
                    <Text style={styles.sectionHeader}>{isGuest ? '🎟️ Complete Registration' : '🎟️ Join Another Community'}</Text>
                    <Text style={styles.sectionDesc}>
                        {isGuest 
                            ? `You are currently connected to this node (${anchorUrl}) in Guest Mode. Enter a valid invite code to register your identity and unlock full membership features.`
                            : 'Enter an invite code to join a different node. Once registered, you can switch between your accounts by tapping the title in the top banner.'
                        }
                    </Text>
                    
                    <View style={{ flexDirection: 'column', gap: 8, marginBottom: 32 }}>
                        <TextInput 
                            style={[styles.input, { marginBottom: 0 }]}
                            placeholder="Invite URL or token"
                            placeholderTextColor={colors.text.muted}
                            value={redeemCode}
                            onChangeText={setRedeemCode}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        {redeemCode && !redeemCode.startsWith('http') && (
                            <TextInput
                                style={[styles.input, { marginBottom: 0 }]}
                                placeholder="Community Node URL (Optional)"
                                placeholderTextColor={colors.text.muted}
                                value={redeemNodeUrl}
                                onChangeText={setRedeemNodeUrl}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="url"
                            />
                        )}
                        <Pressable
                            accessibilityRole="button"
                            style={{ backgroundColor: colors.brand.primary, paddingVertical: 14, borderRadius: 12, alignItems: 'center', marginTop: 8 }}
                            onPress={handleRedeem}
                            disabled={redeeming || !redeemCode.trim()}
                        >
                            <Text style={{ color: colors.text.inverse, fontWeight: 'bold', fontSize: 16 }}>
                                {redeeming 
                                    ? (isGuest ? 'Registering...' : 'Joining...') 
                                    : (isGuest ? 'Complete Registration' : 'Join Community')
                                }
                            </Text>
                        </Pressable>
                    </View>

                    {isGuest && (
                        <View style={{ marginTop: 8, backgroundColor: theme === 'dark' ? colors.feedback.danger.bg : palette.red50, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: theme === 'dark' ? colors.feedback.danger.border : palette.red300, marginBottom: 32 }}>
                            <Text style={{ color: theme === 'dark' ? colors.feedback.danger.fg : palette.red600, fontSize: 15, fontWeight: '700', marginBottom: 4 }}>
                                🛠️ Connection Troubleshooting
                            </Text>
                            <Text style={{ color: theme === 'dark' ? colors.text.body : palette.red800, fontSize: 13, lineHeight: 18, marginBottom: 12 }}>
                                If your local profile data is mismatched or out of sync with the node's server (e.g. if the node was completely wiped or reinstalled), you can wipe this community's local database cache and start fresh. Your master key and other saved communities are safe.
                            </Text>
                            <Pressable
                                accessibilityRole="button"
                                accessibilityHint="Permanently deletes this community's local data"
                                style={{ backgroundColor: colors.feedback.danger.solid, paddingVertical: 12, borderRadius: 8, alignItems: 'center' }}
                                onPress={handleTroubleWipe}
                            >
                                <Text style={{ color: colors.text.inverse, fontWeight: 'bold', fontSize: 14 }}>
                                    Wipe Local Node Data & Start Fresh
                                </Text>
                            </Pressable>
                        </View>
                    )}
                </ScrollView>
            )}

            {view === 'guardians' && (
                <ScrollView contentContainerStyle={[styles.list, { paddingBottom: keyboardHeight > 0 ? keyboardHeight + 20 : 16 }]}>
                    {friends.length === 0 ? (
                        <View style={styles.emptyContainer}>
                            <Text style={styles.emptyEmoji}>🛡️</Text>
                            <Text style={styles.emptyTitle}>Social Recovery Ready</Text>
                            <Text style={styles.emptyDesc}>Add some friends first, then come back here to choose your guardians.</Text>
                        </View>
                    ) : (
                        <>
                            <Text style={styles.sectionHeader}>🛡️ Choose Guardians</Text>
                            <Text style={styles.sectionDesc}>
                                Select 3 to 5 trusted friends to act as your guardians. If you lose your device, they can help you recover your identity.
                            </Text>

                            {friends.filter(f => f.isGuardian).length >= 3 && (
                                <View style={styles.infoBanner}>
                                    <Text style={styles.infoText}>
                                        <Text style={styles.boldGreen}>✅ Social Recovery Ready.</Text> You have enough guardians selected to recover your account if you lose access.
                                    </Text>
                                </View>
                            )}

                            <View style={{ marginBottom: 16 }}>
                                <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text.secondary, textTransform: 'uppercase' }}>
                                    Selected ({friends.filter(f => f.isGuardian).length}/5)
                                </Text>
                            </View>

                            {friends.map((friend, index) => {
                                const isFirst = index === 0;
                                const isLast = index === friends.length - 1;
                                return (
                                <View key={friend.publicKey} style={[
                                    styles.peopleRow,
                                    isFirst && { borderTopLeftRadius: 12, borderTopRightRadius: 12 },
                                    isLast && { borderBottomLeftRadius: 12, borderBottomRightRadius: 12, borderBottomWidth: 0 },
                                    { overflow: 'hidden' }
                                ]}>
                                    <Pressable
                                        accessibilityRole="button"
                                        style={styles.cardHeader}
                                        onPress={() => router.push({ pathname: '/public-profile', params: { publicKey: friend.publicKey, callsign: friend.callsign || 'Unknown' } })}
                                    >
                                        <View style={styles.avatar}>
                                            <MemberAvatar avatarUrl={friend.avatar_url} pubkey={friend.publicKey} callsign={friend.callsign || '?'} size={44} />
                                        </View>
                                        <View style={styles.textStack}>
                                            <Text style={styles.callsign} numberOfLines={1}>{friend.callsign}</Text>
                                            <Text style={styles.dateText}>Friend</Text>
                                        </View>
                                    </Pressable>
                                    
                                    <Pressable
                                        accessibilityRole="button"
                                        accessibilityState={{ selected: !!friend.isGuardian }}
                                        style={[styles.addBtn, friend.isGuardian && styles.addBtnFriended]}
                                        disabled={guardianSyncing === friend.publicKey || (!friend.isGuardian && friends.filter(f => f.isGuardian).length >= 5)}
                                        onPress={async () => {
                                            setGuardianSyncing(friend.publicKey);
                                            const newStatus = !friend.isGuardian;
                                            const success = await setGuardianApi(friend.publicKey, newStatus);
                                            if (success) {
                                                setFriends(prev => prev.map(f => f.publicKey === friend.publicKey ? { ...f, isGuardian: newStatus } : f));
                                            } else {
                                                Alert.alert('Error', 'Failed to update guardian status. Check your connection.');
                                            }
                                            setGuardianSyncing(null);
                                        }}
                                    >
                                        {guardianSyncing === friend.publicKey ? (
                                            <ActivityIndicator size="small" color={friend.isGuardian ? colors.brand.dark : colors.text.inverse} />
                                        ) : (
                                            <Text style={[styles.addBtnText, friend.isGuardian && styles.addBtnTextFriended]}>
                                                {friend.isGuardian ? 'Remove' : 'Make Guardian'}
                                            </Text>
                                        )}
                                    </Pressable>
                                </View>
                            );})}
                        </>
                    )}
                </ScrollView>
            )}
            </KeyboardAvoidingView>

        </SafeAreaView>
    );
}
