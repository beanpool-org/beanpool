import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, TextInput, ActivityIndicator, Alert, Image, Share, Linking, Platform, Keyboard, AppState } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import * as Clipboard from 'expo-clipboard';
import { useIdentity } from '../IdentityContext';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { processProfileImage } from '../../utils/image-processing';
import { AvatarPickerSheet } from '../../components/AvatarPickerSheet';
import { resolveBundledAvatar } from '../../utils/bundled-avatars';
import { updateCallsign, wipeIdentity } from '../../utils/identity';
import { buildSignedHeaders } from '../../utils/crypto';
import { updateMemberProfile, getMemberProfile, getPendingRecoveryRequests, approveRecoveryRequest, rejectRecoveryRequest, signedRequest } from '../../utils/db';
import { getSavedNodes, SavedNode, removeSavedNode, getDatabaseFilenameForNode } from '../../utils/nodes';
import * as FileSystem from 'expo-file-system/legacy';
import * as Location from 'expo-location';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import Constants from 'expo-constants';
import appConfig from '../../app.json';
import { palette } from '../../constants/colors';
import { useTheme, useStyles } from '../ThemeContext';
import { authenticateUser, getAppLockEnabled, setAppLockEnabled } from '../../utils/LocalAuth';


function getDatabaseFilePaths(dbFilename: string): string[] {
    if (!FileSystem.documentDirectory) return [];
    const docDir = FileSystem.documentDirectory;
    
    if (Platform.OS === 'android') {
        const path = docDir.endsWith('/files/')
            ? docDir.slice(0, -7) + '/databases/' + dbFilename
            : docDir.includes('/files')
                ? docDir.replace('/files', '/databases') + dbFilename
                : docDir + 'databases/' + dbFilename;
        return [path];
    } else if (Platform.OS === 'ios') {
        const devPath = docDir + 'SQLite/' + dbFilename;
        const prodPath = docDir.endsWith('/Documents/')
            ? docDir.slice(0, -11) + '/Library/Application Support/SQLite/' + dbFilename
            : docDir.includes('/Documents')
                ? docDir.replace('/Documents', '/Library/Application Support/SQLite') + dbFilename
                : docDir + 'SQLite/' + dbFilename;
        return [devPath, prodPath];
    }
    return [docDir + 'SQLite/' + dbFilename];
}

export default function SettingsScreen() {
    const { theme, colors, toggleTheme, lightPalette, setLightPalette } = useTheme();
    const { identity, setIdentity } = useIdentity();
    const [keyboardHeight, setKeyboardHeight] = useState(0);

    const styles = useStyles(({ theme, colors }) => StyleSheet.create({
        container: { flex: 1, backgroundColor: theme === 'dark' ? colors.surface.app : palette.grayAlt100 },
        content: { padding: 20, paddingTop: 16, paddingBottom: 48 },

        // ─── Identity Dashboard ───
        identityCard: {
            borderRadius: 20, marginBottom: 28, overflow: 'hidden',
            backgroundColor: palette.emerald950, // Premium very dark green
            shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.15, shadowRadius: 16, elevation: 6,
            borderWidth: 1, borderColor: palette.emerald800,
        },
        identityInner: {
            alignItems: 'center', paddingVertical: 28, paddingHorizontal: 20,
        },
        editBadge: {
            position: 'absolute', top: 16, right: 16,
            backgroundColor: palette.emerald800, paddingHorizontal: 12, paddingVertical: 6,
            borderRadius: 20, borderWidth: 1, borderColor: colors.brand.primary,
        },
        editBadgeText: { fontSize: 13, color: palette.emerald200, fontWeight: 'bold' },
        avatarWrap: {
            width: 96, height: 96, borderRadius: 48,
            marginBottom: 16, position: 'relative',
        },
        avatarImg: { width: 96, height: 96, borderRadius: 48, overflow: 'hidden' },
        avatarPlaceholder: {
            width: 96, height: 96, borderRadius: 48,
            backgroundColor: palette.emerald900, justifyContent: 'center', alignItems: 'center',
        },
        avatarRing: {
            position: 'absolute', top: -3, left: -3, right: -3, bottom: -3,
            borderRadius: 51, borderWidth: 2.5, borderColor: palette.emerald400,
        },
        callsignText: {
            fontSize: 24, fontWeight: '800', color: colors.text.inverse, letterSpacing: 0.5, marginBottom: 4,
        },
        bioText: {
            fontSize: 14, color: palette.emerald200, lineHeight: 20, textAlign: 'center',
            marginBottom: 12, paddingHorizontal: 12, fontStyle: 'italic',
        },
        contactRow: {
            flexDirection: 'row', alignItems: 'center', marginBottom: 16,
            backgroundColor: palette.emerald900, paddingHorizontal: 12, paddingVertical: 6,
            borderRadius: 16, borderWidth: 1, borderColor: palette.emerald800,
        },
        contactText: { fontSize: 13, color: palette.emerald100, marginLeft: 6, fontWeight: '600' },
        pubkeyRow: {
            flexDirection: 'row', alignItems: 'center',
            backgroundColor: palette.emerald950, paddingHorizontal: 14, paddingVertical: 8,
            borderRadius: 20, borderWidth: 1, borderColor: palette.emerald800,
        },
        pubkeyText: { fontSize: 13, color: palette.emerald300, fontFamily: 'Courier', letterSpacing: 1 },

        // ─── Section Headers ───
        sectionHeader: {
            fontSize: 11, fontWeight: '800', color: colors.text.muted, letterSpacing: 1,
            textTransform: 'uppercase', marginBottom: 8, marginTop: 24, marginLeft: 4,
        },

        // ─── Menu Groups ───
        menuGroup: {
            backgroundColor: colors.surface.card, borderRadius: 16,
            shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.04, shadowRadius: 8,
            elevation: 2, overflow: 'hidden',
        },
        menuBtn: {
            flexDirection: 'row', alignItems: 'center', padding: 14, paddingVertical: 13,
            borderBottomWidth: 1, borderBottomColor: colors.surface.subtle,
        },
        menuBtnLast: { borderBottomWidth: 0 },
        menuIconWrap: {
            width: 36, height: 36, borderRadius: 12,
            backgroundColor: theme === 'dark' ? 'rgba(34, 197, 94, 0.15)' : palette.green50,
            justifyContent: 'center', alignItems: 'center', marginRight: 12,
        },
        menuIcon: { fontSize: 18 },
        menuText: { fontSize: 15, fontWeight: '600', color: colors.text.body },
        menuSub: { fontSize: 12, color: colors.text.muted, marginTop: 1 },
        menuChevron: { fontSize: 22, color: colors.border.strong, fontWeight: '300', marginLeft: 8 },

        // ─── Toggle ───
        toggle: {
            width: 50, height: 28, borderRadius: 14,
            backgroundColor: colors.border.default, justifyContent: 'center', paddingHorizontal: 2,
        },
        toggleOn: { backgroundColor: colors.brand.primary },
        toggleThumb: {
            width: 24, height: 24, borderRadius: 12, backgroundColor: colors.surface.card,
            shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 2, elevation: 2,
        },
        toggleThumbOn: { transform: [{ translateX: 22 }] },

        // ─── Light Color Schemes ───
        colorSchemeContainer: {
            paddingHorizontal: 16,
            paddingBottom: 16,
            paddingTop: 8,
            borderBottomWidth: 1,
            borderBottomColor: colors.border.default,
        },
        colorSchemeLabel: {
            fontSize: 11,
            fontWeight: '700',
            color: colors.text.secondary,
            marginBottom: 8,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
        },
        colorSchemeRow: {
            flexDirection: 'row',
            gap: 8,
        },
        schemeChip: {
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderRadius: 20,
            borderWidth: 1,
            backgroundColor: colors.surface.subtle,
            gap: 6,
        },
        schemeChipSelected: {
            backgroundColor: colors.surface.card,
            borderWidth: 1,
        },
        schemeDot: {
            width: 10,
            height: 10,
            borderRadius: 5,
        },
        schemeText: {
            fontSize: 13,
            color: colors.text.body,
            fontWeight: '500',
        },
        schemeTextActive: {
            fontWeight: '700',
            color: colors.text.heading,
        },

        // ─── Danger Zone ───
        dangerGroup: {
            backgroundColor: colors.surface.card, borderRadius: 16, overflow: 'hidden',
            borderWidth: 1, borderColor: colors.feedback.danger.border,
        },

        // ─── Version ───
        versionText: {
            textAlign: 'center', marginTop: 32, fontSize: 12,
            color: colors.border.strong, fontWeight: '700', letterSpacing: 1.5,
        },

        // ─── Shared (sub-screens) ───
        card: {
            backgroundColor: colors.surface.card, borderRadius: 16, padding: 20,
            shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.05, shadowRadius: 8,
            elevation: 2, marginBottom: 24,
        },
        label: { fontSize: 11, fontWeight: 'bold', color: colors.text.secondary, letterSpacing: 1, marginBottom: 4, marginTop: 12 },
        value: { fontSize: 20, fontWeight: 'bold', color: colors.text.heading, marginBottom: 8 },
        sectionTitle: { fontSize: 18, fontWeight: 'bold', color: colors.text.heading, marginBottom: 16 },
        input: {
            backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.default,
            borderRadius: 12, padding: 14, color: colors.text.heading, fontSize: 16, marginBottom: 16,
        },
        primaryBtn: { backgroundColor: colors.text.heading, padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 8 },
        primaryBtnText: { color: colors.text.inverse, fontSize: 16, fontWeight: 'bold' },
        backBtn: { marginTop: 16, alignItems: 'center', padding: 10 },
        backBtnText: { color: colors.text.secondary, fontSize: 14, fontWeight: '600' },
        dangerBtn: { backgroundColor: colors.feedback.danger.bg, padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 16, borderWidth: 1, borderColor: colors.feedback.danger.border },
        dangerBtnText: { color: colors.feedback.danger.fg, fontSize: 14, fontWeight: 'bold' },
        infoText: { fontSize: 14, color: colors.text.secondary, marginBottom: 16, lineHeight: 20 },
        errorText: { color: colors.feedback.danger.solid, marginBottom: 16, textAlign: 'center' },
        
        // Seed UI
        seedGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 16 },
        seedWord: { width: '48%', backgroundColor: colors.surface.subtle, padding: 12, borderRadius: 8, marginBottom: 12, flexDirection: 'row', alignItems: 'center' },
        seedWordNum: { color: colors.text.muted, fontSize: 12, marginRight: 8, width: 20, textAlign: 'right' },
        seedWordText: { fontSize: 16, fontWeight: '600', color: colors.text.body },
        uriBox: {
            backgroundColor: theme === 'dark' ? colors.surface.subtle : palette.slate100,
            padding: 12, borderRadius: 8, borderWidth: 1,
            borderColor: theme === 'dark' ? colors.border.default : palette.slate200,
            marginBottom: 16, maxHeight: 100
        },
        uriText: { fontSize: 12, fontFamily: 'monospace', color: theme === 'dark' ? colors.text.secondary : palette.slate600 },

        // Contact visibility picker
        visibilitySection: { marginTop: 4, marginBottom: 16 },
        visibilityLabel: { fontSize: 13, fontWeight: '700', color: colors.text.secondary, marginBottom: 8 },
        visibilityOption: {
            flexDirection: 'row', alignItems: 'center', gap: 12,
            padding: 14, borderRadius: 12, borderWidth: 1,
            borderColor: colors.border.default, backgroundColor: colors.surface.card,
            marginBottom: 8,
        },
        visibilityOptionActive: {
            borderColor: colors.feedback.info.border, backgroundColor: colors.feedback.info.bg,
            shadowColor: colors.feedback.info.border, shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.15, shadowRadius: 4, elevation: 3,
        },
        visibilityEmoji: { fontSize: 20 },
        visibilityOptionLabel: { fontSize: 15, fontWeight: '700', color: colors.text.heading },
        visibilityOptionLabelActive: { color: theme === 'dark' ? colors.feedback.info.fg : palette.blue800 },
        visibilityOptionDesc: { fontSize: 12, color: colors.text.muted, marginTop: 1 },
        visibilityOptionDescActive: { color: colors.feedback.info.solid },
        visibilityCheck: { fontSize: 18, fontWeight: '800', color: colors.feedback.info.solid },
    }));

    useEffect(() => {
        const showSub = Keyboard.addListener('keyboardDidShow', (e) => setKeyboardHeight(e.endCoordinates.height));
        const hideSub = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
        return () => { showSub.remove(); hideSub.remove(); };
    }, []);
    const [mode, setMode] = useState<'menu' | 'profile' | 'seed' | 'advanced' | 'wipe' | 'notifications' | 'recovery-requests' | 'diagnostics'>('menu');
    const [dbStats, setDbStats] = useState<{ members: number, posts: number, transactions: number, messages: number, integrity: string } | null>(null);
    const [diagLoading, setDiagLoading] = useState(false);
    const [dbSize, setDbSize] = useState<string>('0.0 MB');
    const [remoteStats, setRemoteStats] = useState<{ members: number, posts: number, transactions: number } | null>(null);
    const params = useLocalSearchParams<{ section?: string }>();

    // Location permission (relocated here from the global header)
    const [locationEnabled, setLocationEnabled] = useState(false);
    useEffect(() => {
        const checkPerms = () => {
            Location.getForegroundPermissionsAsync().then(({ status }) => setLocationEnabled(status === 'granted')).catch(() => {});
        };
        checkPerms();
        const sub = AppState.addEventListener('change', (next) => {
            if (next === 'active') {
                checkPerms();
            }
        });
        return () => sub.remove();
    }, []);
    const handleLocationToggle = async () => {
        const { status, canAskAgain } = await Location.getForegroundPermissionsAsync();
        if (status === 'granted') {
            Alert.alert('Location Enabled', 'BeanPool currently has access to your location. To disable it, please visit your device Settings.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Open Settings', onPress: () => Linking.openSettings() },
            ]);
            return;
        }
        if (canAskAgain) {
            const res = await Location.requestForegroundPermissionsAsync();
            setLocationEnabled(res.status === 'granted');
        } else {
            Alert.alert('Permission Denied', 'Location permission was denied. Please enable it in your device settings to use location features.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Open Settings', onPress: () => Linking.openSettings() },
            ]);
        }
    };

    // Reset to the main menu when settings is focused, or auto-open deep-linked sections
    useFocusEffect(
        React.useCallback(() => {
            if (params.section === 'advanced') {
                setMode('advanced');
            } else if (params.section === 'profile') {
                setMode('profile');
            } else {
                setMode('menu');
            }
        }, [params.section])
    );

    // Notification preference state
    const [notifChat, setNotifChat] = useState(true);
    const [notifMarketplace, setNotifMarketplace] = useState(true);
    const [notifEscrow, setNotifEscrow] = useState(true);
    const [notifLoading, setNotifLoading] = useState(false);
    const [holidayMode, setHolidayMode] = useState(false);
    const [holidayLoading, setHolidayLoading] = useState(false);
    const [editCallsign, setEditCallsign] = useState(identity?.callsign || '');
    const [avatar, setAvatar] = useState<string | null>(null);
    const [bio, setBio] = useState('');
    const [contact, setContact] = useState('');
    const [contactVisibility, setContactVisibility] = useState<'hidden' | 'trade_partners' | 'friends' | 'community'>('community');
    const [loading, setLoading] = useState(false);
    const [showAvatarPicker, setShowAvatarPicker] = useState(false);
    const [anchorUrl, setAnchorUrl] = useState<string>('Detecting...');
    
    React.useEffect(() => {
        // Load profile data on mount
        if (identity?.publicKey) {
            getMemberProfile(identity.publicKey).then(profile => {
                if (profile) {
                    const cleaned = (profile.avatar_url && profile.avatar_url !== 'null' && profile.avatar_url !== 'undefined' && profile.avatar_url.trim() !== '') ? profile.avatar_url : null;
                    setAvatar(cleaned);
                    if (profile.bio) setBio(profile.bio);
                    if (profile.contact_value) setContact(profile.contact_value);
                    if (profile.contact_visibility) setContactVisibility(profile.contact_visibility);
                }
            }).catch(() => {});
        }
    }, []);

    // Load holiday-mode state on mount (queried so an unset flag reads as OFF, not the pref default).
    React.useEffect(() => {
        (async () => {
            try {
                const url = await AsyncStorage.getItem('beanpool_anchor_url');
                if (url && identity?.publicKey) {
                    const res = await fetch(`${url}/api/members/preferences?publicKey=${identity.publicKey}`);
                    if (res.ok) {
                        const prefs = await res.json();
                        setHolidayMode(prefs.holiday_mode === 'true');
                    }
                }
            } catch { }
        })();
    }, []);

    const handleToggleHoliday = async () => {
        if (!identity?.publicKey || holidayLoading) return;
        const next = !holidayMode;
        setHolidayLoading(true);
        try {
            await signedRequest('/api/members/holiday', { enabled: next });
            setHolidayMode(next);
            Alert.alert(
                next ? '🌴 Holiday mode on' : 'Welcome back',
                next
                    ? "Your offers are hidden and you won't get new trade requests. Turn this off anytime to come back."
                    : 'Your offers are live again.'
            );
        } catch (e: any) {
            // Server blocks turning it on while trades are in progress — surface that message.
            Alert.alert(next ? "Can't start holiday yet" : 'Update failed', e?.message || 'Please try again.');
        } finally {
            setHolidayLoading(false);
        }
    };

    const loadDiagnostics = async () => {
        setDiagLoading(true);
        setRemoteStats(null);
        try {
            try {
                const { requestSync } = await import('../../services/pillar-sync');
                await requestSync();
            } catch (e) {}
            const { getDatabaseStats } = await import('../../utils/db');
            const stats = await getDatabaseStats();
            setDbStats(stats);
            
            // Get database size with normalized review/prod checks
            const url = await AsyncStorage.getItem('beanpool_anchor_url');
            setAnchorUrl(url || 'Local discovery (or offline)');
            
            const dbFilename = getDatabaseFilenameForNode(url);
            const dbPaths = getDatabaseFilePaths(dbFilename);
            console.log('[Diagnostics] Computed Database Paths:', dbPaths);
            
            // Log local directory structures to diagnose exact database location
            try {
                const docDir = FileSystem.documentDirectory;
                console.log('[Diagnostics] FileSystem.documentDirectory:', docDir);
                if (docDir) {
                    const docFiles = await FileSystem.readDirectoryAsync(docDir);
                    console.log('[Diagnostics] Files in docDir:', docFiles);
                    try {
                        const sqFiles = await FileSystem.readDirectoryAsync(docDir + 'SQLite/');
                        console.log('[Diagnostics] Files in docDir/SQLite:', sqFiles);
                    } catch (e) {
                        console.log('[Diagnostics] No SQLite/ subfolder found in docDir');
                    }
                    if (Platform.OS === 'android') {
                        try {
                            const dbDir = docDir.replace('/files/', '/databases/');
                            const dbFiles = await FileSystem.readDirectoryAsync(dbDir);
                            console.log('[Diagnostics] Files in databases sibling dir:', dbFiles);
                        } catch (e) {
                            console.log('[Diagnostics] No databases sibling folder found');
                        }
                    }
                }
            } catch (err) {
                console.warn('[Diagnostics] Directory scan failed:', err);
            }

            let sizeBytes = 0;
            let fileFound = false;
            for (const p of dbPaths) {
                try {
                    const fileInfo = await FileSystem.getInfoAsync(p);
                    console.log(`[Diagnostics] File Info for ${p}:`, fileInfo);
                    if (fileInfo.exists) {
                        sizeBytes = fileInfo.size;
                        fileFound = true;
                        break;
                    }
                } catch {}
            }
            if (fileFound) {
                if (sizeBytes >= 1024 * 1024) {
                    setDbSize(`${(sizeBytes / 1024 / 1024).toFixed(2)} MB`);
                } else {
                    setDbSize(`${(sizeBytes / 1024).toFixed(1)} KB`);
                }
            } else {
                setDbSize('0.0 MB');
            }

            // Fetch remote health stats for visual compare
            if (url && url.startsWith('http')) {
                try {
                    let cleanUrl = url.trim();
                    if (cleanUrl.endsWith('/')) {
                        cleanUrl = cleanUrl.slice(0, -1);
                    }
                    const res = await fetch(`${cleanUrl}/api/community/info?_t=${Date.now()}`);
                     if (res.ok) {
                        const data = await res.json();
                        let remoteTxCount = data.transactionCount || 0;
                        
                        if (identity?.publicKey) {
                            try {
                                const txRes = await fetch(`${cleanUrl}/api/ledger/transactions?publicKey=${identity.publicKey}&limit=200&_t=${Date.now()}`);
                                if (txRes.ok) {
                                    const txData = await txRes.json();
                                    if (Array.isArray(txData)) {
                                        remoteTxCount = txData.length;
                                    }
                                }
                            } catch (e) {
                                console.warn('[Diagnostics] Failed fetching remote personal transactions count:', e);
                            }
                        }

                        setRemoteStats({
                            members: data.memberCount || 0,
                            posts: data.postCount || 0,
                            transactions: remoteTxCount
                        });
                    }
                } catch (err) {
                    console.warn('[Diagnostics] Could not fetch remote stats for comparison:', err);
                }
            }
        } catch (e) {
            console.error('Failed loading diagnostics:', e);
        } finally {
            setDiagLoading(false);
        }
    };
    
    // Advanced subsystem state
    const [newAnchorInput, setNewAnchorInput] = useState('');
    const [changeConfirm, setChangeConfirm] = useState('');
    const [wipeConfirm, setWipeConfirm] = useState('');
    const [seedConfirm, setSeedConfirm] = useState('');
    const [seedVisible, setSeedVisible] = useState(false);
    const [seedCopied, setSeedCopied] = useState(false);
    const [advancedLoading, setAdvancedLoading] = useState(false);
    const [resyncing, setResyncing] = useState(false);
    const [appLockEnabled, setAppLockEnabledState] = useState(false);

    useEffect(() => {
        getAppLockEnabled().then(setAppLockEnabledState);
    }, []);

    const handleToggleAppLock = async () => {
        const success = await authenticateUser(appLockEnabled ? 'Confirm your security to disable App Lock.' : 'Confirm your security to enable App Lock.');
        if (success) {
            const newValue = !appLockEnabled;
            await setAppLockEnabled(newValue);
            setAppLockEnabledState(newValue);
            Alert.alert('Success', newValue ? 'App Lock enabled.' : 'App Lock disabled.');
        }
    };

    const handleCopySeed = async () => {
        if (!identity?.mnemonic) return;
        await Clipboard.setStringAsync(identity.mnemonic.join(' '));
        setSeedCopied(true);
        setTimeout(() => setSeedCopied(false), 2000);
    };
    const [savedNodes, setSavedNodes] = useState<(SavedNode & { status: 'pinging' | 'online' | 'offline', sizeBytes: number })[]>([]);
    const [newNodeAlias, setNewNodeAlias] = useState('');
    const [redeemInviteCode, setRedeemInviteCode] = useState('');
    const [redeemLoading, setRedeemLoading] = useState(false);
    
    React.useEffect(() => {
        if (mode === 'advanced') {
            AsyncStorage.getItem('beanpool_anchor_url').then(val => {
                setAnchorUrl(val || 'Local discovery (or offline)');
                if (val) setNewAnchorInput(val);
            });
            
            // Load and ping all saved nodes
            getSavedNodes().then(async nodes => {
                const enriched = await Promise.all(nodes.map(async node => {
                    let size = 0;
                    try {
                        const filename = getDatabaseFilenameForNode(node.url);
                        const paths = getDatabaseFilePaths(filename);
                        for (const p of paths) {
                            const fileInfo = await FileSystem.getInfoAsync(p);
                            if (fileInfo.exists) {
                                size = fileInfo.size;
                                break;
                            }
                        }
                    } catch(e) {}
                    return { ...node, status: 'pinging' as const, sizeBytes: size };
                }));
                setSavedNodes(enriched);

                // Ping them
                enriched.forEach((node, i) => {
                    const c = new AbortController();
                    const t = setTimeout(() => c.abort(), 3000);
                    fetch(`${node.url}/api/community/health`, { signal: c.signal })
                        .then(r => r.ok ? 'online' : 'offline')
                        .catch(() => 'offline')
                        .then(status => {
                            clearTimeout(t);
                            setSavedNodes(prev => {
                                const nw = [...prev];
                                nw[i] = { ...nw[i], status: status as 'online' | 'offline' };
                                return nw;
                            });
                        });
                });
            });
        }
    }, [mode]);
    


    // Recovery logic
    const [recoveryReqs, setRecoveryReqs] = useState<any[]>([]);
    const [recoveryLoading, setRecoveryLoading] = useState(false);

    React.useEffect(() => {
        if (mode === 'recovery-requests') {
            setRecoveryLoading(true);
            getPendingRecoveryRequests()
                .then(setRecoveryReqs)
                .catch(console.error)
                .finally(() => setRecoveryLoading(false));
        }
    }, [mode]);

    if (!identity) {
        return (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.surface.app }}>
                <Text style={{ fontSize: 18, color: 'red' }}>Debug: Identity is null.</Text>
            </View>
        );
    }




    async function handlePickImage() {
        setShowAvatarPicker(true);
    }

    async function handleUpdateCallsign() {
        if (!identity) return;
        if (editCallsign.trim().length < 2) {
            Alert.alert('Error', 'Callsign must be at least 2 characters.');
            return;
        }
        setLoading(true);
        try {
            // Only include avatar_url in the update if we have one in local state.
            // If avatar state is null (e.g., profile fetch hasn't completed), do NOT
            // send avatar_url at all — otherwise we'd wipe the existing avatar on the server.
            const localUpdate: any = {
                callsign: editCallsign.trim(),
                bio: bio.trim(),
                contact_value: contact.trim(),
                contact_visibility: contact.trim() ? contactVisibility : 'hidden',
            };
            if (avatar) localUpdate.avatar_url = avatar;
            await updateMemberProfile(identity.publicKey, localUpdate);
            if (editCallsign.trim() !== identity.callsign) {
                const updated = await updateCallsign(editCallsign.trim());
                if (updated) setIdentity(updated);
            }

            // Push profile (including avatar) to the server so other devices see it
            try {
                const url = await AsyncStorage.getItem('beanpool_anchor_url');
                if (url && identity) {
                    // Same guard as local: don't send avatar=null if state hasn't loaded
                    const payloadObj: any = {
                        publicKey: identity.publicKey,
                        bio: bio.trim(),
                        contact: contact.trim() ? { value: contact.trim(), visibility: contactVisibility } : null,
                        callsign: editCallsign.trim(),
                    };
                    if (avatar) payloadObj.avatar = avatar;
                    const bodyString = JSON.stringify(payloadObj);
                    const headers = await buildSignedHeaders('POST', '/api/profile/update', bodyString, identity.privateKey, identity.publicKey);

                    const res = await fetch(`${url}/api/profile/update`, {
                        method: 'POST',
                        headers,
                        body: bodyString,
                    });
                    
                    if (!res.ok) {
                        throw new Error('Server rejected the profile update.');
                    }
                    await AsyncStorage.removeItem('pending_profile_sync');
                }
            } catch (e: any) {
                console.warn('[Profile] Server sync failed (offline?):', e);
                await AsyncStorage.setItem('pending_profile_sync', 'true');
                Alert.alert('Offline Mode', 'Profile saved locally. It will be published automatically in the background when you reconnect to the network.');
            }

            setMode('menu');
        } catch (e) {
            Alert.alert('Error', 'Could not update profile.');
        } finally {
            setLoading(false);
        }
    }

    async function handleSwitchNode(targetUrl: string) {
        if (targetUrl === anchorUrl) return;
        setAdvancedLoading(true);
        try {
            const { closeDB, initDB } = await import('../../utils/db');
            await closeDB(); 
            // The database is successfully suspended to Cold Storage.
            await AsyncStorage.setItem('beanpool_anchor_url', targetUrl);
            await initDB();
            
            // Hard bounce the Application State Tree via the Welcome resolver
            router.replace('/welcome');
        } catch (e: any) {
            Alert.alert("Pivot Failed", e.message);
        }
    }

    async function handleRedeemInvite() {
        if (!redeemInviteCode.trim()) return;
        setRedeemLoading(true);
        try {
            const { redeemInvite } = await import('../../utils/db');
            // Re-fetch the callsign just to be sure it's current
            await redeemInvite(redeemInviteCode.trim(), identity?.callsign || 'Unknown', identity);
            
            // Kick off a background sync immediately so they pull the node's ledger
            const { requestSync } = await import('../../services/pillar-sync');
            requestSync().catch(console.error);

            Alert.alert('Success', 'Invite redeemed successfully on current node! Syncing data...');
            setRedeemInviteCode('');
        } catch (e: any) {
            Alert.alert('Redemption Failed', e.message);
        } finally {
            setRedeemLoading(false);
        }
    }

    async function handleForgetNode(targetUrl: string) {
        if (targetUrl === anchorUrl) {
            const remainingNodes = savedNodes.filter(n => n.url !== targetUrl);
            if (remainingNodes.length === 0) {
                Alert.alert("Action Denied", "You cannot forget your only saved node. If you want to leave BeanPool completely, please use 'Delete Account' to destroy your identity.");
                return;
            }
            
            Alert.alert(
                "Forget Active Node",
                "You are currently connected to this node. To forget it, you will automatically be switched to your next saved node.",
                [
                    { text: "Cancel", style: "cancel" },
                    { 
                        text: "Forget & Switch", 
                        style: "destructive",
                        onPress: async () => {
                            await removeSavedNode(targetUrl);
                            setSavedNodes(remainingNodes);
                            try {
                                const filename = getDatabaseFilenameForNode(targetUrl);
                                const paths = getDatabaseFilePaths(filename);
                                for (const p of paths) {
                                    await FileSystem.deleteAsync(p, { idempotent: true });
                                }
                            } catch(e) {}
                            
                            // Automatically pivot to the next available node
                            await handleSwitchNode(remainingNodes[0].url);
                        }
                    }
                ]
            );
            return;
        }

        Alert.alert(
            "Forget Community?",
            `This removes "${targetUrl}" from your saved communities and deletes its local data from this phone. Your identity and other communities are not affected — you can rejoin later, but any unsynced local data for this community will be lost.`,
            [
                { text: "Cancel", style: "cancel" },
                {
                    text: "Forget",
                    style: "destructive",
                    onPress: async () => {
                        await removeSavedNode(targetUrl);
                        setSavedNodes(prev => prev.filter(n => n.url !== targetUrl));
                        // Physically delete the dormant .db file from the OS folder
                        try {
                            const filename = getDatabaseFilenameForNode(targetUrl);
                            const paths = getDatabaseFilePaths(filename);
                            for (const p of paths) {
                                    await FileSystem.deleteAsync(p, { idempotent: true });
                            }
                        } catch(e) {}
                    }
                }
            ]
        );
    }

    async function handleForceResync(targetUrl: string) {
        if (resyncing) return; // guard against re-entry from either resync button
        Alert.alert(
            "Force Resync",
            "This will delete your local database for this community and redownload everything from scratch.",
            [
                { text: "Cancel", style: "cancel" },
                {
                    text: "Clear & Resync",
                    style: "destructive",
                    onPress: async () => {
                        setResyncing(true);
                        setAdvancedLoading(true);
                        try {
                            const urlsToClear = [
                                targetUrl,
                                await AsyncStorage.getItem('beanpool_anchor_url'),
                                null,
                                'https://test.beanpool.org',
                                'https://review.beanpool.org:8443',
                                'https://beanpool.org:8443'
                            ];
                            const keysToRemove: string[] = [
                                'beanpool_last_version_check_time',
                                'beanpool_latest_known_version',
                                'pillar_sync_members_last_sync'
                            ];
                            for (const u of urlsToClear) {
                                const filename = getDatabaseFilenameForNode(u);
                                keysToRemove.push(`pillar_sync_${filename}_last-sync`);
                                keysToRemove.push(`pillar_sync_${filename}_checkpoint`);
                                keysToRemove.push(`pillar_sync_${filename}_members_last_sync`);
                            }
                            await AsyncStorage.multiRemove(keysToRemove);
                            const { clearDB, initDB } = await import('../../utils/db');
                            await clearDB();
                            await initDB();
                            
                            // Await the sync so the spinner stays up for the whole
                            // rebuild — previously this was fire-and-forget, so the
                            // loading state cleared before the (slow) re-download finished.
                            const { requestSync } = await import('../../services/pillar-sync');
                            await requestSync();
                            Alert.alert("Success", "Local database rebuilt and re-synced from the node.");
                            if (mode === 'diagnostics') {
                                loadDiagnostics();
                            }
                        } catch (e: any) {
                            Alert.alert("Resync Error", e?.message || String(e) || "Failed to rebuild and re-sync.");
                        } finally {
                            setResyncing(false);
                            setAdvancedLoading(false);
                        }
                    }
                }
            ]
        );
    }

    async function handleUpdateAnchor() {
        if (!newAnchorInput.trim()) {
            Alert.alert("Invalid URL", "Please enter a valid BeanPool Node IP address.");
            return;
        }

        setAdvancedLoading(true);
        try {
            let finalAnchorUrl = newAnchorInput.trim();
            if (finalAnchorUrl && !finalAnchorUrl.startsWith('http')) {
                const isIpOrLocal = /^(?:\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(finalAnchorUrl) || finalAnchorUrl.startsWith('localhost');
                finalAnchorUrl = (isIpOrLocal ? 'http://' : 'https://') + finalAnchorUrl;
            }
            await AsyncStorage.setItem('beanpool_anchor_url', finalAnchorUrl);
            // Inject alias to native node matrix
            const { addSavedNode } = await import('../../utils/nodes');
            await addSavedNode(finalAnchorUrl, newNodeAlias.trim() || undefined);

            const { closeDB, initDB } = await import('../../utils/db');
            await closeDB();
            await initDB();

            const { requestSync } = await import('../../services/pillar-sync');
            requestSync()
                .catch((err: any) => console.error("Sync caught an error:", err));

            Alert.alert("Node Added", "You have successfully connected to the new community.");
            setAnchorUrl(finalAnchorUrl);
        } catch (e: any) {
            Alert.alert("Update Failed", String(e.message || e));
        } finally {
            setAdvancedLoading(false);
        }
    }

    async function handleWipe() {
        if (wipeConfirm !== 'WIPE') {
            Alert.alert("Warning", "You must type exactly 'WIPE' to delete your mathematical identity.");
            return;
        }
        const success = await authenticateUser('Confirm your security to permanently wipe your identity.');
        if (!success) return;

        Alert.alert(
            "Wipe Everything",
            "This permanently erases your Ed25519 private key AND every saved community and its local data from this phone. You will lose access to all communities and ledger balances everywhere. This cannot be undone unless you have your 12-word recovery phrase.",
            [
                { text: "Cancel", style: "cancel" },
                { 
                    text: "Destroy Key", 
                    style: "destructive",
                    onPress: async () => {
                        setAdvancedLoading(true);
                        const { clearDB } = await import('../../utils/db');
                        await clearDB();
                        
                        // Purge sync engine cursors and the saved node matrix to force a clean slate
                        const allKeys = await AsyncStorage.getAllKeys();
                        const pillarKeys = allKeys.filter(k => k.startsWith('pillar_sync_') || k.startsWith('pillar:'));
                        await AsyncStorage.multiRemove([
                            'beanpool_anchor_url',
                            'beanpool_saved_nodes',
                            ...pillarKeys
                        ]);

                        // Physically delete dormant DB files for all saved nodes to reclaim disk space
                        for (const node of savedNodes) {
                            try {
                                const filename = getDatabaseFilenameForNode(node.url);
                                const paths = getDatabaseFilePaths(filename);
                                for (const p of paths) {
                                    await FileSystem.deleteAsync(p, { idempotent: true });
                                }
                            } catch (e) {}
                        }
                        
                        await wipeIdentity();
                        setIdentity(null);
                    }
                }
            ]
        );
    }





    return (
        <KeyboardAvoidingView 
            style={{ flex: 1 }} 
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={88}
        >
            <ScrollView style={styles.container} contentContainerStyle={[styles.content, { paddingBottom: keyboardHeight > 0 ? keyboardHeight + 48 : 48 }]}>
            {/* ─── Identity Dashboard Card ─── */}
            <View style={styles.identityCard}>
                <View style={styles.identityInner}>
                    {/* Edit button — top-right corner */}
                    <Pressable style={styles.editBadge} onPress={() => setMode('profile')} accessibilityRole="button">
                        <Text style={styles.editBadgeText}>✏️ Edit</Text>
                    </Pressable>

                    {/* Avatar */}
                    <Pressable onPress={() => setMode('profile')} style={styles.avatarWrap} accessibilityRole="button" accessibilityLabel="Edit profile">
                        {avatar && avatar !== 'null' && avatar !== 'undefined' && avatar.trim() !== '' ? (
                            <Image source={avatar.startsWith('bundled://') ? resolveBundledAvatar(avatar)! : { uri: avatar }} style={styles.avatarImg} accessibilityLabel="Your profile avatar" />
                        ) : (
                            <View style={styles.avatarPlaceholder}>
                                <Text style={{ fontSize: 42 }}>👤</Text>
                            </View>
                        )}
                        <View style={styles.avatarRing} />
                    </Pressable>

                    {/* Callsign */}
                    <Text style={styles.callsignText}>{identity.callsign}</Text>

                    {/* Bio */}
                    {bio ? <Text style={styles.bioText}>{bio}</Text> : null}

                    {/* Contact */}
                    {contact ? (
                        <View style={styles.contactRow}>
                            <Text style={{ fontSize: 13 }}>📱</Text>
                            <Text style={styles.contactText}>{contact}</Text>
                        </View>
                    ) : null}

                    {/* Public Key — truncated, tap to copy */}
                    <Pressable
                        style={styles.pubkeyRow}
                        accessibilityRole="button"
                        accessibilityLabel="Copy public key"
                        onPress={async () => {
                            await Clipboard.setStringAsync(identity.publicKey);
                            Alert.alert('Copied', 'Public key copied to clipboard.');
                        }}
                    >
                        <Text style={styles.pubkeyText}>
                            {identity.publicKey.slice(0, 6)}...{identity.publicKey.slice(-6)}
                        </Text>
                        <Text style={{ fontSize: 12, marginLeft: 6 }}>📋</Text>
                    </Pressable>
                </View>
            </View>

            {mode === 'menu' && (
                <>
                {/* ─── Account & Identity ─── */}
                <Text style={styles.sectionHeader}>ACCOUNT & IDENTITY</Text>
                <View style={styles.menuGroup}>
                    <Pressable style={styles.menuBtn} onPress={() => { setMode('recovery-requests'); }} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🛡️</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>Recovery Requests</Text>
                            <Text style={styles.menuSub}>Help a friend recover their identity</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>

                    <Pressable style={[styles.menuBtn, styles.menuBtnLast]} onPress={() => { setMode('seed'); setSeedConfirm(''); setSeedVisible(false); }} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🔑</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>View Recovery Phrase</Text>
                            <Text style={styles.menuSub}>View your 12-word backup seed</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>
                </View>

                {/* ─── App Settings ─── */}
                <Text style={styles.sectionHeader}>APP SETTINGS</Text>
                <View style={styles.menuGroup}>
                    {/* Dark Mode Switch */}
                    <View style={styles.menuBtn}>
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🌙</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>Dark Mode</Text>
                            <Text style={styles.menuSub}>Toggle dark appearance</Text>
                        </View>
                        <Pressable 
                            style={[styles.toggle, theme === 'dark' && styles.toggleOn]} 
                            accessibilityRole="button" 
                            accessibilityLabel="Toggle dark mode" 
                            accessibilityState={{ checked: theme === 'dark' }} 
                            onPress={toggleTheme}
                        >
                            <View style={[styles.toggleThumb, theme === 'dark' && styles.toggleThumbOn]} />
                        </Pressable>
                    </View>

                    {/* App Lock Switch */}
                    <View style={styles.menuBtn}>
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🔒</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>App Lock</Text>
                            <Text style={styles.menuSub}>Require security passcode on app launch</Text>
                        </View>
                        <Pressable 
                            style={[styles.toggle, appLockEnabled && styles.toggleOn]} 
                            accessibilityRole="button" 
                            accessibilityLabel="Toggle App Lock" 
                            accessibilityState={{ checked: appLockEnabled }} 
                            onPress={handleToggleAppLock}
                        >
                            <View style={[styles.toggleThumb, appLockEnabled && styles.toggleThumbOn]} />
                        </Pressable>
                    </View>
                    {/* Light Mode Color Scheme Selector */}
                    {theme === 'light' && (
                        <View style={styles.colorSchemeContainer}>
                            <Text style={styles.colorSchemeLabel}>Light Color Scheme</Text>
                            <View style={styles.colorSchemeRow}>
                                <Pressable 
                                    style={[
                                        styles.schemeChip, 
                                        lightPalette === 'classic' && styles.schemeChipSelected,
                                        { borderColor: lightPalette === 'classic' ? colors.brand.primary : colors.border.default }
                                    ]}
                                    onPress={() => setLightPalette('classic')}
                                >
                                    <View style={[styles.schemeDot, { backgroundColor: '#10b981' }]} />
                                    <Text style={[styles.schemeText, lightPalette === 'classic' && styles.schemeTextActive]}>Classic</Text>
                                </Pressable>
                                <Pressable 
                                    style={[
                                        styles.schemeChip, 
                                        lightPalette === 'earth' && styles.schemeChipSelected,
                                        { borderColor: lightPalette === 'earth' ? '#647664' : colors.border.default }
                                    ]}
                                    onPress={() => setLightPalette('earth')}
                                >
                                    <View style={[styles.schemeDot, { backgroundColor: '#647664' }]} />
                                    <Text style={[styles.schemeText, lightPalette === 'earth' && styles.schemeTextActive]}>Earth</Text>
                                </Pressable>
                                <Pressable 
                                    style={[
                                        styles.schemeChip, 
                                        lightPalette === 'slate' && styles.schemeChipSelected,
                                        { borderColor: lightPalette === 'slate' ? '#2563eb' : colors.border.default }
                                    ]}
                                    onPress={() => setLightPalette('slate')}
                                >
                                    <View style={[styles.schemeDot, { backgroundColor: '#2563eb' }]} />
                                    <Text style={[styles.schemeText, lightPalette === 'slate' && styles.schemeTextActive]}>Slate</Text>
                                </Pressable>
                            </View>
                        </View>
                    )}
                    <Pressable style={styles.menuBtn} onPress={async () => {
                        setMode('notifications');
                        setNotifLoading(true);
                        try {
                            const url = await AsyncStorage.getItem('beanpool_anchor_url');
                            if (url && identity?.publicKey) {
                                const res = await fetch(`${url}/api/members/preferences?publicKey=${identity.publicKey}`);
                                if (res.ok) {
                                    const prefs = await res.json();
                                    setNotifChat(prefs.notify_chat !== 'false');
                                    setNotifMarketplace(prefs.notify_marketplace !== 'false');
                                    setNotifEscrow(prefs.notify_escrow !== 'false');
                                }
                            }
                        } catch (e) { console.warn('[Prefs] Failed to fetch preferences:', e); }
                        setNotifLoading(false);
                    }} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🔔</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>Notification Preferences</Text>
                            <Text style={styles.menuSub}>Control push alerts by category</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>
                    <View style={styles.menuBtn}>
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>📍</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>Location</Text>
                            <Text style={styles.menuSub}>{locationEnabled ? 'Enabled — used for nearby posts & map' : 'Disabled — tap to enable'}</Text>
                        </View>
                        <Pressable
                            style={[styles.toggle, locationEnabled && styles.toggleOn]}
                            accessibilityRole="button"
                            accessibilityLabel="Toggle Location permission"
                            accessibilityState={{ checked: locationEnabled }}
                            onPress={handleLocationToggle}
                        >
                            <View style={[styles.toggleThumb, locationEnabled && styles.toggleThumbOn]} />
                        </Pressable>
                    </View>
                    {/* Holiday Mode — pause your presence; hides your offers, stops new requests */}
                    <View style={[styles.menuBtn, styles.menuBtnLast]}>
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🌴</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>Holiday Mode</Text>
                            <Text style={styles.menuSub}>{holidayMode ? "You're away — offers hidden, no new requests" : 'Going away? Hide your offers and pause requests'}</Text>
                        </View>
                        <Pressable
                            style={[styles.toggle, holidayMode && styles.toggleOn, holidayLoading && { opacity: 0.5 }]}
                            accessibilityRole="button"
                            accessibilityLabel="Toggle Holiday Mode"
                            accessibilityState={{ checked: holidayMode }}
                            disabled={holidayLoading}
                            onPress={handleToggleHoliday}
                        >
                            <View style={[styles.toggleThumb, holidayMode && styles.toggleThumbOn]} />
                        </Pressable>
                    </View>
                </View>

                {/* ─── Legal & Privacy ─── */}
                <Text style={styles.sectionHeader}>LEGAL & PRIVACY</Text>
                <View style={styles.menuGroup}>
                    <Pressable style={styles.menuBtn} onPress={() => Linking.openURL('https://beanpool.org/privacy.html')} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🛡️</Text></View>
                        <Text style={[styles.menuText, { flex: 1 }]}>Privacy Policy</Text>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>
                    <Pressable style={styles.menuBtn} onPress={() => Linking.openURL('https://beanpool.org/terms.html')} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>⚖️</Text></View>
                        <Text style={[styles.menuText, { flex: 1 }]}>Terms of Service & EULA</Text>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>
                    <Pressable style={[styles.menuBtn, styles.menuBtnLast]} onPress={() => Linking.openURL('https://beanpool.org/safety.html')} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🚸</Text></View>
                        <Text style={[styles.menuText, { flex: 1 }]}>Child Safety Standards</Text>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>
                </View>

                {/* ─── Advanced ─── */}
                <Text style={styles.sectionHeader}>SYSTEM</Text>
                <View style={styles.menuGroup}>
                    <Pressable style={styles.menuBtn} onPress={async () => {
                        setMode('diagnostics');
                        await loadDiagnostics();
                    }} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>📊</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>Database Health & Stats</Text>
                            <Text style={styles.menuSub}>Local storage metrics & integrity checks</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>
                    <Pressable style={[styles.menuBtn, styles.menuBtnLast]} onPress={() => setMode('advanced')} accessibilityRole="button">
                        <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>⚙️</Text></View>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.menuText}>Advanced / Subsystem</Text>
                            <Text style={styles.menuSub}>Node management & cache controls</Text>
                        </View>
                        <Text style={styles.menuChevron}>›</Text>
                    </Pressable>
                </View>

                {/* ─── Danger Zone ─── */}
                <View style={{ marginTop: 24 }}>
                    <View style={styles.dangerGroup}>
                        <Pressable style={[styles.menuBtn, styles.menuBtnLast]} onPress={() => { setMode('wipe'); setWipeConfirm(''); }} accessibilityRole="button" accessibilityHint="Permanently deletes your identity and all local community data">
                            <View style={[styles.menuIconWrap, { backgroundColor: palette.red50 }]}><Text style={styles.menuIcon}>⚠️</Text></View>
                            <Text style={[styles.menuText, { flex: 1, color: palette.red600 }]}>Delete Account</Text>
                            <Text style={[styles.menuChevron, { color: palette.red300 }]}>›</Text>
                        </Pressable>
                    </View>
                </View>

                {/* ─── Version Footer ─── */}
                <Text style={styles.versionText}>
                    BEANPOOL OS {appConfig.expo.version} (Build {Platform.OS === 'ios' ? appConfig.expo.ios.buildNumber : appConfig.expo.android.versionCode})
                </Text>
                </>
            )}

            {mode === 'recovery-requests' && (
                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>🛡️ Recovery Requests</Text>
                    <Text style={styles.infoText}>These friends have requested to recover their identity on a new device. Verify it's really them before approving.</Text>
                    
                    {recoveryLoading ? (
                        <ActivityIndicator color={colors.brand.dark} style={{ marginVertical: 20 }} />
                    ) : recoveryReqs.length === 0 ? (
                        <View style={{ padding: 20, alignItems: 'center' }}>
                            <Text style={{ fontSize: 32, marginBottom: 8 }}>✨</Text>
                            <Text style={{ color: colors.text.muted }}>No pending requests.</Text>
                        </View>
                    ) : (
                        recoveryReqs.map(req => (
                            <View key={req.id} style={{ backgroundColor: colors.surface.subtle, padding: 16, borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: colors.border.default }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
                                    <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.border.strong, alignItems: 'center', justifyContent: 'center', marginRight: 12 }}>
                                        <Text style={{ fontSize: 18 }}>👤</Text>
                                    </View>
                                    <View>
                                        <Text style={{ color: colors.text.heading, fontSize: 16, fontWeight: 'bold' }}>{req.old_callsign}</Text>
                                        <Text style={{ color: colors.text.muted, fontSize: 12 }}>Requested: {new Date(req.created_at).toLocaleDateString()}</Text>
                                    </View>
                                </View>
                                
                                <View style={{ flexDirection: 'row', gap: 8 }}>
                                    <Pressable
                                        style={[styles.primaryBtn, { flex: 1, backgroundColor: colors.feedback.danger.solid }]}
                                        accessibilityRole="button"
                                        accessibilityHint="Rejects this identity recovery request"
                                        onPress={async () => {
                                            try {
                                                await rejectRecoveryRequest(req.id);
                                                setRecoveryReqs(prev => prev.filter(r => r.id !== req.id));
                                                Alert.alert('Rejected', 'Request has been rejected.');
                                            } catch(e) {
                                                Alert.alert('Error', 'Failed to reject request.');
                                            }
                                        }}
                                    >
                                        <Text style={styles.primaryBtnText}>Reject</Text>
                                    </Pressable>
                                    <Pressable
                                        style={[styles.primaryBtn, { flex: 1, backgroundColor: colors.brand.primary }]}
                                        accessibilityRole="button"
                                        onPress={async () => {
                                            try {
                                                await approveRecoveryRequest(req.id);
                                                setRecoveryReqs(prev => prev.filter(r => r.id !== req.id));
                                                Alert.alert('Approved', 'Request has been approved.');
                                            } catch(e) {
                                                Alert.alert('Error', 'Failed to approve request.');
                                            }
                                        }}
                                    >
                                        <Text style={styles.primaryBtnText}>Approve</Text>
                                    </Pressable>
                                </View>
                            </View>
                        ))
                    )}
                    
                    <Pressable style={styles.backBtn} onPress={() => setMode('menu')} accessibilityRole="button">
                        <Text style={styles.backBtnText}>← Back</Text>
                    </Pressable>
                </View>
            )}

            {mode === 'profile' && (
                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>Edit Profile</Text>
                    
                    {/* Avatar Picker */}
                    <View style={{ alignItems: 'center', marginBottom: 20 }}>
                        <Pressable onPress={handlePickImage} style={{ alignItems: 'center' }} accessibilityRole="button" accessibilityLabel="Change profile photo">
                            <View style={{ width: 100, height: 100, borderRadius: 50, backgroundColor: colors.surface.subtle, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: colors.border.default, overflow: 'hidden' }}>
                                {avatar && avatar !== 'null' && avatar !== 'undefined' && avatar.trim() !== '' ? (
                                    <Image source={avatar.startsWith('bundled://') ? resolveBundledAvatar(avatar)! : { uri: avatar }} style={{ width: 96, height: 96, borderRadius: 48, overflow: 'hidden' }} accessibilityLabel="Your profile avatar" />
                                ) : (
                                    <Text style={{ fontSize: 32 }}>📷</Text>
                                )}
                            </View>
                            <Text style={{ color: colors.text.secondary, fontSize: 12, marginTop: 8 }}>Tap to change photo</Text>
                        </Pressable>
                    </View>

                    <Text style={styles.label}>CALLSIGN</Text>
                    <TextInput
                        style={styles.input}
                        value={editCallsign}
                        onChangeText={setEditCallsign}
                        maxLength={32}
                        accessibilityLabel="Callsign"
                    />

                    <Text style={styles.label}>BIO</Text>
                    <TextInput
                        style={[styles.input, { height: 80, textAlignVertical: 'top' }]}
                        value={bio}
                        onChangeText={setBio}
                        multiline
                        maxLength={200}
                        placeholder="A short bio about yourself..."
                        placeholderTextColor={colors.text.secondary}
                        accessibilityLabel="Bio"
                    />

                    <Text style={styles.label}>CONTACT DETAILS</Text>
                    <TextInput
                        style={styles.input}
                        value={contact}
                        onChangeText={setContact}
                        placeholder="Phone, email, or WhatsApp"
                        placeholderTextColor={colors.text.secondary}
                        accessibilityLabel="Contact details"
                    />

                    {contact.trim().length > 0 && (
                        <View style={styles.visibilitySection}>
                            <Text style={styles.visibilityLabel}>Who can see this?</Text>
                            {([
                                { value: 'hidden' as const, emoji: '🔒', label: 'Hidden', desc: 'Only you can see it' },
                                { value: 'trade_partners' as const, emoji: '🤝', label: 'Trade Partners', desc: 'Visible when you enter a trade' },
                                { value: 'friends' as const, emoji: '👥', label: 'Friends', desc: 'People you have added as friends' },
                                { value: 'community' as const, emoji: '🌍', label: 'Community', desc: 'Anyone on this node' },
                            ]).map(opt => {
                                const isActive = contactVisibility === opt.value;
                                return (
                                    <Pressable
                                        key={opt.value}
                                        style={[styles.visibilityOption, isActive && styles.visibilityOptionActive]}
                                        onPress={() => setContactVisibility(opt.value)}
                                        accessibilityRole="button"
                                        accessibilityState={{ selected: isActive }}
                                    >
                                        <Text style={styles.visibilityEmoji}>{opt.emoji}</Text>
                                        <View style={{ flex: 1 }}>
                                            <Text style={[styles.visibilityOptionLabel, isActive && styles.visibilityOptionLabelActive]}>{opt.label}</Text>
                                            <Text style={[styles.visibilityOptionDesc, isActive && styles.visibilityOptionDescActive]}>{opt.desc}</Text>
                                        </View>
                                        {isActive && <Text style={styles.visibilityCheck}>✓</Text>}
                                    </Pressable>
                                );
                            })}
                        </View>
                    )}

                    <Pressable style={styles.primaryBtn} onPress={handleUpdateCallsign} disabled={loading} accessibilityRole="button">
                        {loading ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.primaryBtnText}>Save Profile</Text>}
                    </Pressable>
                    <Pressable style={styles.backBtn} onPress={() => setMode('menu')} accessibilityRole="button">
                        <Text style={styles.backBtnText}>Cancel</Text>
                    </Pressable>
                </View>
            )}



            {mode === 'notifications' && (
                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>🔔 Notification Preferences</Text>
                    <Text style={styles.infoText}>
                        Control which push notifications wake up your device. Changes are saved automatically.
                    </Text>

                    {notifLoading ? (
                        <ActivityIndicator color={colors.brand.primary} style={{ marginVertical: 20 }} />
                    ) : (
                        <View style={styles.menuGroup}>
                            <View style={styles.menuBtn}>
                                <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>💬</Text></View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.menuText}>Direct Messages</Text>
                                    <Text style={styles.menuSub}>Get notified when someone messages you</Text>
                                </View>
                                <Pressable style={[styles.toggle, notifChat && styles.toggleOn]} accessibilityRole="button" accessibilityLabel="Direct messages notifications" accessibilityState={{ checked: notifChat }} onPress={async () => {
                                    const next = !notifChat; setNotifChat(next);
                                    try { if (identity?.publicKey) { await signedRequest('/api/members/preferences', { publicKey: identity.publicKey, preferences: { notify_chat: next } }); } } catch (e) { console.warn('[Prefs]', e); }
                                }}>
                                    <View style={[styles.toggleThumb, notifChat && styles.toggleThumbOn]} />
                                </Pressable>
                            </View>
                            <View style={styles.menuBtn}>
                                <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>📬</Text></View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.menuText}>Marketplace Activity</Text>
                                    <Text style={styles.menuSub}>Requests, approvals & rejections</Text>
                                </View>
                                <Pressable style={[styles.toggle, notifMarketplace && styles.toggleOn]} accessibilityRole="button" accessibilityLabel="Marketplace activity notifications" accessibilityState={{ checked: notifMarketplace }} onPress={async () => {
                                    const next = !notifMarketplace; setNotifMarketplace(next);
                                    try { if (identity?.publicKey) { await signedRequest('/api/members/preferences', { publicKey: identity.publicKey, preferences: { notify_marketplace: next } }); } } catch (e) { console.warn('[Prefs]', e); }
                                }}>
                                    <View style={[styles.toggleThumb, notifMarketplace && styles.toggleThumbOn]} />
                                </Pressable>
                            </View>
                            <View style={[styles.menuBtn, styles.menuBtnLast]}>
                                <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🔒</Text></View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.menuText}>Held in Trust & System</Text>
                                    <Text style={styles.menuSub}>Credits held in trust, released, or disputed</Text>
                                </View>
                                <Pressable style={[styles.toggle, notifEscrow && styles.toggleOn]} accessibilityRole="button" accessibilityLabel="Held in trust and system notifications" accessibilityState={{ checked: notifEscrow }} onPress={async () => {
                                    const next = !notifEscrow; setNotifEscrow(next);
                                    try { if (identity?.publicKey) { await signedRequest('/api/members/preferences', { publicKey: identity.publicKey, preferences: { notify_escrow: next } }); } } catch (e) { console.warn('[Prefs]', e); }
                                }}>
                                    <View style={[styles.toggleThumb, notifEscrow && styles.toggleThumbOn]} />
                                </Pressable>
                            </View>
                        </View>
                    )}

                    <Pressable style={styles.backBtn} onPress={() => setMode('menu')} accessibilityRole="button">
                        <Text style={styles.backBtnText}>← Back</Text>
                    </Pressable>
                </View>
            )}

            {mode === 'advanced' && (
                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>Saved Communities</Text>
                    <Text style={styles.infoText}>
                        Your physical identity automatically ports between the dormant disconnected local states tracking below.
                    </Text>

                    {savedNodes.map((node, i) => {
                        const isActive = node.url === anchorUrl;
                        return (
                            <View key={i} style={[{ padding: 12, borderWidth: isActive ? 2 : 1, borderColor: isActive ? colors.accent.primary : colors.border.default, borderRadius: 14, marginBottom: 10 }]}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                                        <Text style={{ fontSize: 16 }}>{node.status === 'pinging' ? '🟡' : node.status === 'online' ? '🟢' : '🔴'}</Text>
                                        <Text style={{ fontSize: 14, fontWeight: 'bold', color: colors.text.heading }}>{node.url}</Text>
                                    </View>
                                    <Text style={{ fontSize: 12, color: colors.text.secondary, fontWeight: 'bold' }}>{(node.sizeBytes / 1024 / 1024).toFixed(1)} MB</Text>
                                </View>
                                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                                    {!isActive ? (
                                        <Pressable style={{ flex: 1, backgroundColor: colors.surface.subtle, padding: 8, borderRadius: 6, alignItems: 'center' }} onPress={() => handleSwitchNode(node.url)} disabled={advancedLoading} accessibilityRole="button">
                                            <Text style={{ fontSize: 12, fontWeight: 'bold', color: palette.gray700 }}>{advancedLoading ? 'Mounting...' : 'Switch to Town'}</Text>
                                        </Pressable>
                                    ) : (
                                        <View style={{ flex: 1, backgroundColor: colors.accent.tint, padding: 8, borderRadius: 6, alignItems: 'center' }}>
                                            <Text style={{ fontSize: 12, fontWeight: 'bold', color: colors.accent.primary }}>Active Node</Text>
                                        </View>
                                    )}
                                    {!isActive && (
                                        <Pressable style={{ padding: 8, backgroundColor: palette.red100, borderRadius: 6 }} onPress={() => handleForgetNode(node.url)} accessibilityRole="button" accessibilityHint="Removes this community and deletes its local data from this device">
                                            <Text style={{ fontSize: 12, fontWeight: 'bold', color: palette.red700 }}>Forget</Text>
                                        </Pressable>
                                    )}
                                </View>

                                {isActive && (
                                    <View style={{ marginTop: 12, padding: 12, backgroundColor: colors.surface.subtle, borderRadius: 8, borderWidth: 1, borderColor: colors.border.default }}>
                                        <Text style={{ fontSize: 13, fontWeight: 'bold', color: palette.gray700, marginBottom: 8 }}>Authenticate Identity on this Node</Text>
                                        <View style={{ flexDirection: 'row', gap: 8 }}>
                                            <TextInput
                                                style={{ flex: 1, backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 6, paddingHorizontal: 10, height: 36, fontSize: 13 }}
                                                placeholder="Invite Code (e.g. INV-...)"
                                                value={redeemInviteCode}
                                                onChangeText={setRedeemInviteCode}
                                                autoCapitalize="characters"
                                                accessibilityLabel="Invite code"
                                            />
                                            <Pressable
                                                style={{ backgroundColor: colors.brand.primary, paddingHorizontal: 16, borderRadius: 6, justifyContent: 'center' }}
                                                onPress={handleRedeemInvite}
                                                disabled={redeemLoading || !redeemInviteCode.trim()}
                                                accessibilityRole="button"
                                            >
                                                {redeemLoading ? <ActivityIndicator size="small" color={colors.text.inverse} /> : <Text style={{ color: colors.text.inverse, fontWeight: 'bold', fontSize: 13 }}>Redeem</Text>}
                                            </Pressable>
                                        </View>
                                        <View style={{ marginTop: 16, flexDirection: 'row', justifyContent: 'flex-start', paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border.default }}>
                                            <Pressable style={{ backgroundColor: palette.red50, padding: 8, borderRadius: 6, borderWidth: 1, borderColor: palette.red300 }} onPress={() => handleForceResync(node.url)} accessibilityRole="button" accessibilityHint="Deletes the local database for this community and redownloads everything">
                                                <Text style={{ fontSize: 12, fontWeight: 'bold', color: palette.red700 }}>Clear Cache & Resync</Text>
                                            </Pressable>
                                        </View>
                                    </View>
                                )}
                            </View>
                        );
                    })}

                    <View style={{ height: 1, backgroundColor: colors.border.default, marginVertical: 24 }} />

                    <Text style={{ fontSize: 16, fontWeight: 'bold', color: colors.text.heading, marginBottom: 8 }}>Add Manual Node</Text>
                    <Text style={styles.infoText}>You can manually append an offline Node IP Address to your keychain bypass, directly executing a forced sync pipeline setup.</Text>

                    <Text style={styles.label}>COMMUNITY ALIAS (OPTIONAL)</Text>
                    <TextInput
                        style={styles.input}
                        value={newNodeAlias}
                        onChangeText={setNewNodeAlias}
                        placeholder="e.g. My Secret Base"
                        placeholderTextColor={colors.text.secondary}
                        autoCapitalize="words"
                        autoCorrect={false}
                        accessibilityLabel="Community alias (optional)"
                    />

                    <Text style={styles.label}>NEW NODE IP</Text>
                    <TextInput
                        style={styles.input}
                        value={newAnchorInput}
                        onChangeText={setNewAnchorInput}
                        placeholder="e.g. http://192.168.1.55"
                        placeholderTextColor={colors.text.secondary}
                        autoCapitalize="none"
                        autoCorrect={false}
                        accessibilityLabel="New node IP"
                    />
                    
                    <Pressable style={[styles.primaryBtn, { backgroundColor: colors.brand.primary }, advancedLoading && { opacity: 0.5 }]} onPress={handleUpdateAnchor} disabled={advancedLoading} accessibilityRole="button">
                        {advancedLoading ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.primaryBtnText}>Add & Connect</Text>}
                    </Pressable>

                    <Pressable style={styles.backBtn} onPress={() => setMode('menu')} accessibilityRole="button">
                        <Text style={styles.backBtnText}>← Back</Text>
                    </Pressable>
                </View>
            )}

            {mode === 'diagnostics' && (
                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>📊 Database Diagnostics & Health</Text>
                    <Text style={styles.infoText}>
                        Transparency metrics for your local off-grid database cache. Structural check verifies zero data corruption natively.
                    </Text>

                    {diagLoading ? (
                        <View style={{ marginVertical: 40, alignItems: 'center' }}>
                            <ActivityIndicator size="large" color={colors.accent.primary} />
                            <Text style={{ marginTop: 12, color: colors.text.secondary, fontWeight: '600' }}>Running Structural Integrity Check...</Text>
                        </View>
                    ) : (
                        <>
                             {/* Database Health & Sync Status Indicator */}
                             <View style={{ backgroundColor: colors.surface.subtle, padding: 14, borderRadius: 12, marginBottom: 20 }}>
                                 <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                                      <Text style={{ fontWeight: 'bold', color: palette.gray700 }}>Database Status:</Text>
                                      {(() => {
                                          const hasIntegrityError = dbStats && dbStats.integrity !== 'ok';
                                          const isSynced = !remoteStats || (dbStats && 
                                              dbStats.members === remoteStats.members &&
                                              dbStats.posts === remoteStats.posts);

                                          let pillBg: string = palette.emerald100;
                                          let pillBorder: string = palette.emerald400;
                                          let textColor: string = palette.emerald800;
                                          let displayText = '🟢 Healthy & Synced';

                                          if (hasIntegrityError) {
                                              pillBg = palette.red100;
                                              pillBorder = palette.red300;
                                              textColor = palette.red700;
                                              displayText = `🔴 Corrupted: ${dbStats?.integrity}`;
                                          } else if (!remoteStats) {
                                              pillBg = colors.border.default;
                                              pillBorder = colors.border.strong;
                                              textColor = palette.gray600;
                                              displayText = '⚪ Offline / Local-First';
                                          } else if (!isSynced) {
                                              pillBg = palette.orange100;
                                              pillBorder = palette.orange300;
                                              textColor = palette.orange700;
                                              displayText = '⚠️ Out of Sync';
                                          }

                                          return (
                                              <View style={{ backgroundColor: pillBg, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: pillBorder }}>
                                                  <Text style={{ color: textColor, fontWeight: 'bold', fontSize: 13 }}>
                                                      {displayText}
                                                  </Text>
                                              </View>
                                          );
                                      })()}
                                 </View>
                             </View>

                            {/* Stats Grid */}
                            <Text style={styles.label}>LOCAL RECORD CACHE</Text>
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 8 }}>
                                <View style={{ width: '48%', backgroundColor: colors.surface.app, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 14, marginBottom: 12 }}>
                                    <Text style={{ fontSize: 24, marginBottom: 2 }}>👥</Text>
                                    <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text.heading }} numberOfLines={1}>{dbStats?.members ?? 0}</Text>
                                    <Text style={{ fontSize: 12, color: colors.text.muted, fontWeight: '600' }} numberOfLines={2}>Cached Members</Text>
                                    {remoteStats && (
                                        <Text style={{ fontSize: 10, color: dbStats?.members === remoteStats.members ? colors.brand.primary : palette.amber600, fontWeight: 'bold', marginTop: 4 }}>
                                            {dbStats?.members === remoteStats.members ? '🟢 Node In Sync' : `⚠️ Node has ${remoteStats.members}`}
                                        </Text>
                                    )}
                                </View>
                                <View style={{ width: '48%', backgroundColor: colors.surface.app, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 14, marginBottom: 12 }}>
                                    <Text style={{ fontSize: 24, marginBottom: 2 }}>🛒</Text>
                                    <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text.heading }} numberOfLines={1}>{dbStats?.posts ?? 0}</Text>
                                    <Text style={{ fontSize: 12, color: colors.text.muted, fontWeight: '600' }} numberOfLines={2}>Active Posts</Text>
                                    {remoteStats && (
                                        <Text style={{ fontSize: 10, color: dbStats?.posts === remoteStats.posts ? colors.brand.primary : palette.amber600, fontWeight: 'bold', marginTop: 4 }}>
                                            {dbStats?.posts === remoteStats.posts ? '🟢 Node In Sync' : `⚠️ Node has ${remoteStats.posts}`}
                                        </Text>
                                    )}
                                </View>
                                <View style={{ width: '48%', backgroundColor: colors.surface.app, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 14, marginBottom: 12 }}>
                                    <Text style={{ fontSize: 24, marginBottom: 2 }}>💸</Text>
                                    <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text.heading }} numberOfLines={1}>{dbStats?.transactions ?? 0}</Text>
                                    <Text style={{ fontSize: 12, color: colors.text.muted, fontWeight: '600' }} numberOfLines={2}>Your Ledger Deals</Text>
                                    {remoteStats && (
                                        <Text style={{ fontSize: 10, color: colors.brand.primary, fontWeight: 'bold', marginTop: 4 }}>
                                            🟢 Node History ({remoteStats.transactions})
                                        </Text>
                                    )}
                                </View>
                                <View style={{ width: '48%', backgroundColor: colors.surface.app, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 14, marginBottom: 12 }}>
                                    <Text style={{ fontSize: 24, marginBottom: 2 }}>💬</Text>
                                    <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text.heading }}>{dbStats?.messages ?? 0}</Text>
                                    <Text style={{ fontSize: 12, color: colors.text.muted, fontWeight: '600' }}>Messages</Text>
                                    {remoteStats && (
                                        <Text style={{ fontSize: 10, color: colors.brand.primary, fontWeight: 'bold', marginTop: 4 }}>
                                            🟢 Local First Offline
                                        </Text>
                                    )}
                                </View>
                            </View>

                            {/* Storage allocation */}
                            <Text style={styles.label}>STORAGE ALLOCATION</Text>
                            <View style={{ backgroundColor: colors.surface.app, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, padding: 14, marginTop: 8, marginBottom: 20 }}>
                                <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                                    <Text style={{ fontSize: 13, color: colors.text.secondary, fontWeight: '600' }}>Active DB File size:</Text>
                                    <Text style={{ fontSize: 13, color: colors.text.heading, fontWeight: 'bold' }}>{dbSize}</Text>
                                </View>
                                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                                    <Text style={{ fontSize: 13, color: colors.text.secondary, fontWeight: '600' }}>Active Connection Node:</Text>
                                    <Text style={{ fontSize: 11, color: colors.text.secondary, fontFamily: 'monospace' }}>{anchorUrl ? anchorUrl.slice(0, 32) : 'Detecting...'}{anchorUrl && anchorUrl.length > 32 ? '...' : ''}</Text>
                                </View>
                            </View>

                            {/* Action Buttons */}
                            <Pressable
                                style={[styles.primaryBtn, { backgroundColor: colors.accent.primary, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 }]}
                                onPress={loadDiagnostics}
                                accessibilityRole="button"
                            >
                                <Text style={{ fontSize: 16 }}>🔄</Text>
                                <Text style={styles.primaryBtnText}>Re-Run Structural Diagnostic Check</Text>
                            </Pressable>

                            {/* Re-Sync Database Button */}
                            <Pressable
                                style={[styles.primaryBtn, { backgroundColor: colors.feedback.danger.bg, borderWidth: 1, borderColor: colors.feedback.danger.border, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 12 }, resyncing && { opacity: 0.6 }]}
                                onPress={() => handleForceResync(anchorUrl)}
                                disabled={resyncing}
                                accessibilityRole="button"
                                accessibilityState={{ busy: resyncing, disabled: resyncing }}
                                accessibilityHint="Deletes the local database and redownloads everything from scratch"
                            >
                                {resyncing ? (
                                    <>
                                        <ActivityIndicator size="small" color={colors.feedback.danger.fg} />
                                        <Text style={[styles.primaryBtnText, { color: colors.feedback.danger.fg }]}>Clearing & re-syncing…</Text>
                                    </>
                                ) : (
                                    <>
                                        <Text style={{ fontSize: 16 }}>⚡</Text>
                                        <Text style={[styles.primaryBtnText, { color: colors.feedback.danger.fg }]}>Force Clear & Re-Sync Database</Text>
                                    </>
                                )}
                            </Pressable>
                        </>
                    )}

                    <Pressable style={styles.backBtn} onPress={() => setMode('menu')} accessibilityRole="button">
                        <Text style={styles.backBtnText}>← Back</Text>
                    </Pressable>
                </View>
            )}

            {mode === 'seed' && (
                <View style={styles.card}>
                    <Text style={styles.sectionTitle}>🔑 Recovery Phrase</Text>
                    {!identity?.mnemonic ? (
                        <Text style={styles.infoText}>
                            This identity was created before seed phrase support. Please create a new account to enable recovery phrase backups.
                        </Text>
                    ) : (
                        <>
                            {!seedVisible ? (
                                <>
                                    <Text style={styles.infoText}>
                                        Your 12-word recovery phrase allows you to restore your identity on any device. Anyone with these words can control your account.
                                    </Text>
                                    <Text style={styles.label}>TYPE 'CONFIRM' TO VIEW SEED</Text>
                                    <TextInput
                                        style={[styles.input, { textAlign: 'center', fontWeight: 'bold' }]}
                                        value={seedConfirm}
                                        onChangeText={setSeedConfirm}
                                        placeholder="CONFIRM"
                                        placeholderTextColor={colors.text.secondary}
                                        autoCapitalize="characters"
                                        autoCorrect={false}
                                        accessibilityLabel="Type CONFIRM to view recovery phrase"
                                    />
                                    <Pressable
                                        style={[styles.primaryBtn, seedConfirm !== 'CONFIRM' && { opacity: 0.5 }]}
                                        onPress={async () => {
                                            const success = await authenticateUser('Confirm your security to view your recovery phrase.');
                                            if (success) {
                                                setSeedVisible(true);
                                                await AsyncStorage.setItem('beanpool_identity_backed_up', 'true');
                                            }
                                        }}
                                        disabled={seedConfirm !== 'CONFIRM'}
                                        accessibilityRole="button"
                                    >
                                        <Text style={styles.primaryBtnText}>Show Recovery Phrase</Text>
                                    </Pressable>
                                </>
                            ) : (
                                <>
                                    <Text style={[styles.infoText, { color: colors.feedback.danger.solid, fontWeight: 'bold' }]}>
                                        Never share this phrase with anyone. Write it down on paper and keep it secure.
                                    </Text>
                                    <View style={styles.seedGrid}>
                                        {identity.mnemonic.map((word, i) => (
                                            <View key={i} style={styles.seedWord}>
                                                <Text style={styles.seedWordNum}>{i + 1}.</Text>
                                                <Text style={styles.seedWordText}>{word}</Text>
                                            </View>
                                        ))}
                                    </View>
                                    <Pressable
                                        style={[styles.primaryBtn, { backgroundColor: colors.brand.primary, marginTop: 16 }]}
                                        onPress={handleCopySeed}
                                        accessibilityRole="button"
                                    >
                                        <Text style={styles.primaryBtnText}>
                                            {seedCopied ? '✅ Copied!' : '📋 Copy Words'}
                                        </Text>
                                    </Pressable>
                                </>
                            )}
                        </>
                    )}
                    <Pressable style={[styles.backBtn, { marginTop: 24 }]} onPress={() => setMode('menu')} accessibilityRole="button">
                        <Text style={styles.backBtnText}>← Back</Text>
                    </Pressable>
                </View>
            )}

            {mode === 'wipe' && (
                <View style={styles.card}>
                    <Text style={{ fontSize: 16, fontWeight: 'bold', color: colors.feedback.danger.solid, marginBottom: 8 }}>Danger Zone</Text>
                    <Text style={styles.infoText}>This is a total nuke. It permanently destroys your private key from this phone AND removes every saved community, all of their local data, and all sync state.{'\n\n'}Your identity is one key shared across every community — without your 12-word recovery phrase (or an identity export) you will lose access to all communities and all ledger balances, everywhere. This cannot be undone.</Text>
                    
                    <Text style={styles.label}>TYPE 'WIPE' TO VERIFY</Text>
                    <TextInput
                        style={[styles.input, { textAlign: 'center', fontWeight: 'bold', color: colors.feedback.danger.solid, borderColor: colors.feedback.danger.border }]}
                        value={wipeConfirm}
                        onChangeText={setWipeConfirm}
                        placeholder="WIPE"
                        placeholderTextColor={colors.text.secondary}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        accessibilityLabel="Type WIPE to confirm deletion"
                    />

                    <Pressable style={[styles.dangerBtn, (advancedLoading || wipeConfirm !== 'WIPE') && { opacity: 0.5 }]} onPress={handleWipe} disabled={advancedLoading || wipeConfirm !== 'WIPE'} accessibilityRole="button" accessibilityHint="Permanently destroys your private key and all local community data">
                        <Text style={styles.dangerBtnText}>Permanently Delete Identity</Text>
                    </Pressable>

                    <Pressable style={styles.backBtn} onPress={() => setMode('menu')} accessibilityRole="button">
                        <Text style={styles.backBtnText}>← Back</Text>
                    </Pressable>
                </View>
            )}

            <AvatarPickerSheet
                visible={showAvatarPicker}
                onClose={() => setShowAvatarPicker(false)}
                onSelectImage={(uri) => {
                    const cleaned = (uri && uri !== 'null' && uri !== 'undefined' && uri.trim() !== '') ? uri : null;
                    setAvatar(cleaned);
                }}
            />
            </ScrollView>
        </KeyboardAvoidingView>
    );
}

