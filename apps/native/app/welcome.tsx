import React, { useState, useCallback } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator, Alert, Image, FlatList, BackHandler, Platform } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { hapticTick } from '../utils/haptics';
import { createIdentity, createIdentityFromMnemonic, loadIdentity, BeanPoolIdentity } from '../utils/identity';
import { importIdentity } from '../utils/identity';
import { useIdentity } from './IdentityContext';
import { useNodeStatus } from './NodeStatusContext';
import {
    getPendingOnboarding, setPendingOnboarding, updatePendingOnboarding, clearPendingOnboarding,
} from '../utils/onboarding-state';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { StatusBar } from 'expo-status-bar';
import { useGlobalSearchParams, router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import * as ImagePicker from 'expo-image-picker';
import { BUNDLED_AVATARS, BundledAvatar, resolveBundledAvatar } from '../utils/bundled-avatars';
import { AvatarPickerSheet } from '../components/AvatarPickerSheet';
import { updateMemberProfile } from '../utils/db';
import { buildSignedHeaders } from '../utils/crypto';
import { colors, palette } from '../constants/colors';

import { extractNodeOrigin, normaliseInviteCode } from '../utils/invite-parser';
import { normalizeNodeUrl, looksLikeNodeAddress, shouldBlockCleartextNodeUrl } from '../utils/node-url';

// Friendly Step-1 rejection copy for a dud invite. Reasons come from
// /api/invite/check; anything unrecognised falls back to the generic line.
function inviteProblemMessage(reason?: string): string {
    switch (reason) {
        case 'used':
            return 'This invite has already been used — each one works exactly once. Ask whoever invited you to send a fresh one (it only takes them a minute).';
        case 'expired':
            return 'This invite has expired — invites last 7 days. Ask whoever invited you to send a fresh one (it only takes them a minute).';
        case 'unknown_inviter':
            return "This community doesn't know the person who made this invite. Double-check you're joining the right community, or ask for a fresh invite.";
        default:
            return "That invite wasn't recognised by your community. Double-check the code, or ask whoever invited you for a fresh one.";
    }
}

export default function WelcomeScreen() {
    const params = useGlobalSearchParams();
    const incomingUrl = Linking.useURL();
    const { setIdentity } = useIdentity();
    const { recheck: recheckNodeStatus } = useNodeStatus();
    const [mode, setMode] = useState<'home' | 'member' | 'create' | 'recover' | 'profileSetup' | 'seedBackup' | 'onboardingGuide'>('home');
    const [callsign, setCallsign] = useState('');
    const [recoveryWords, setRecoveryWords] = useState<string[]>(Array(12).fill(''));
    const [recoveryCallsign, setRecoveryCallsign] = useState('');
    const [recoveryAnchorUrl, setRecoveryAnchorUrl] = useState('');
    const [createAnchorUrl, setCreateAnchorUrl] = useState('');

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pendingIdentity, setPendingIdentity] = useState<BeanPoolIdentity | null>(null);
    const [seedConfirmed, setSeedConfirmed] = useState(false);
    const [inviteCode, setInviteCode] = useState('');
    const [pendingInviteCode, setPendingInviteCode] = useState('');
    const [processingMagicLink, setProcessingMagicLink] = useState(false);
    const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);
    const [showAvatarPicker, setShowAvatarPicker] = useState(false);
    const [seedCopied, setSeedCopied] = useState(false);
    const [inviterName, setInviterName] = useState<string | null>(null);
    const [inviteCommunityName, setInviteCommunityName] = useState<string | null>(null);
    const [clipboardMayHaveInvite, setClipboardMayHaveInvite] = useState(false);

    // The web trampoline copies the invite link to the clipboard before sending
    // people to the app store, but nothing can read it for them automatically —
    // so offer a one-tap check on the first screen. hasStringAsync only reports
    // presence; the clipboard is READ solely on the user's tap (no iOS paste
    // prompt until then).
    React.useEffect(() => {
        if (mode !== 'home') return;
        Clipboard.hasStringAsync()
            .then(has => setClipboardMayHaveInvite(!!has))
            .catch(() => setClipboardMayHaveInvite(false));
    }, [mode]);

    async function handleCheckClipboardInvite() {
        try {
            const content = (await Clipboard.getStringAsync())?.trim() || '';
            const looksLikeInvite = content.startsWith('BP-') || content.startsWith('INV-') ||
                (content.startsWith('http') && content.includes('invite='));
            if (looksLikeInvite) {
                setProcessingMagicLink(true);
                await processFullUrl(content);
                setTimeout(() => setProcessingMagicLink(false), 1500);
            } else {
                Alert.alert(
                    'No invite found',
                    "Your clipboard doesn't have a BeanPool invite on it. No worries — you can paste or type the code on the next screen.",
                    [{ text: 'OK', onPress: () => setMode('create') }]
                );
            }
        } catch {
            setMode('create');
        }
    }

    const processFullUrl = useCallback(async (fullUrl: string) => {
        if (fullUrl.startsWith('http')) {
            const originMatch = fullUrl.match(/^https?:\/\/[^\/?#]+/);
            if (originMatch) {
                setCreateAnchorUrl(originMatch[0]);
            }
        }
        const inviteMatch = fullUrl.match(/[?&]invite=([^&]+)/);
        if (inviteMatch) {
            setInviteCode(decodeURIComponent(inviteMatch[1]));
        } else if (!fullUrl.startsWith('http') && (fullUrl.startsWith('BP-') || fullUrl.startsWith('INV-'))) {
            setInviteCode(fullUrl);
        }
        setMode('create');
    }, []);

    const handlePasteInvite = async () => {
        try {
            const content = await Clipboard.getStringAsync();
            const cleanContent = content?.trim() || '';
            if (!cleanContent) {
                Alert.alert("Nothing to paste", "Your clipboard is empty.");
                return;
            }

            // Check if it's an invite token OR an invite URL to use processFullUrl
            if (cleanContent.startsWith('BP-') || cleanContent.startsWith('INV-') ||
                (cleanContent.startsWith('http') && cleanContent.includes('invite='))) {
                setProcessingMagicLink(true);
                await processFullUrl(cleanContent);
                setTimeout(() => setProcessingMagicLink(false), 1500);
            } else {
                // Otherwise, just populate the input field text and don't auto-advance
                setInviteCode(cleanContent);
            }
        } catch (e) {
            Alert.alert("Failed to read clipboard", "Please try pasting the link manually.");
        }
    };

    React.useEffect(() => {
        AsyncStorage.getItem('beanpool_anchor_url').then(val => {
            if (val) {
                setCreateAnchorUrl(val);
                setRecoveryAnchorUrl(val);
            }
        });
        
        let mounted = true;

        const checkAutoIntercept = async () => {
            // Priority 1: Raw Expo Linking Intent (bypasses router segment hydration issues)
            if (incomingUrl) {
                const parsed = Linking.parse(incomingUrl);
                if (parsed.queryParams?.invite) {
                    if (mounted) {
                        if (incomingUrl.startsWith('http')) {
                            // Universal link - process fully
                            await processFullUrl(incomingUrl);
                        } else {
                            // Deep link (beanpool://)
                            setInviteCode(parsed.queryParams.invite as string);
                            if (parsed.queryParams.server) {
                                setCreateAnchorUrl(parsed.queryParams.server as string);
                            }
                            setMode('create');
                        }
                    }
                    return;
                }
            }

            // Priority 2: Standard Router Params
            if (params?.invite) {
                if (mounted) {
                    setInviteCode(params.invite as string);
                    if (params?.server) {
                        setCreateAnchorUrl(params.server as string);
                        setRecoveryAnchorUrl(params.server as string);
                    }
                    setMode('create');
                }
                return;
            }

            // Priority 3 (Android, once ever): Play Install Referrer. An invite
            // link tapped WITHOUT the app installed detours via the Play Store;
            // the web trampoline packs invite+server into the store link's
            // `referrer` param, which Google hands us here on first launch — so
            // the invite survives the install with no clipboard or retyping.
            if (Platform.OS === 'android') {
                const alreadyChecked = await AsyncStorage.getItem('beanpool_install_referrer_checked');
                if (!alreadyChecked) {
                    try {
                        const Application = await import('expo-application');
                        const referrer = await Application.getInstallReferrerAsync();
                        await AsyncStorage.setItem('beanpool_install_referrer_checked', 'true');
                        const inviteMatch = referrer?.match(/(?:^|&)invite=([^&]+)/);
                        if (inviteMatch && mounted) {
                            setInviteCode(decodeURIComponent(inviteMatch[1]));
                            const serverMatch = referrer.match(/(?:^|&)server=([^&]+)/);
                            const server = serverMatch ? decodeURIComponent(serverMatch[1]) : '';
                            // Same trust rule as deep links: never accept a
                            // cleartext-public node origin from an outside source.
                            if (server && !shouldBlockCleartextNodeUrl(server)) {
                                setCreateAnchorUrl(server);
                            }
                            setMode('create');
                        }
                    } catch {
                        // No Play Services (emulator, de-Googled device) — the
                        // clipboard offer below is the fallback. Left unchecked
                        // so a transient failure can retry on the next visit.
                    }
                }
            }
        };

        checkAutoIntercept();

        return () => { mounted = false; };
    }, [params?.invite, params?.t, incomingUrl]);

    // Resume a join wizard that was interrupted after the keypair was created
    // (Step 1) but before the invite was redeemed (final step). Without this,
    // the half-registered identity strands the user on node-mismatch at next
    // launch. A fresh incoming invite link outranks a stale half-done wizard.
    React.useEffect(() => {
        let mounted = true;
        (async () => {
            if (params?.invite || (incomingUrl && incomingUrl.includes('invite='))) return;
            const pending = await getPendingOnboarding();
            if (!pending || !mounted) return;
            const stored = await loadIdentity();
            if (!stored) {
                // Keypair never made it to storage — nothing to resume.
                await clearPendingOnboarding();
                return;
            }
            if (!mounted) return;
            setCallsign(pending.callsign || stored.callsign);
            setInviteCode(pending.inviteCode);
            setPendingInviteCode(pending.inviteCode);
            if (pending.anchorUrl) setCreateAnchorUrl(pending.anchorUrl);
            if (pending.avatar) setPendingAvatar(pending.avatar);
            if (pending.step !== 'create') setPendingIdentity(stored);
            setMode(pending.step);
        })();
        return () => { mounted = false; };
    }, []);

    async function handleCreate() {
        if (!inviteCode.trim()) {
            setError('An invite code is required to join the network.');
            return;
        }
        if (callsign.trim().length < 2) {
            setError('Callsign must be at least 2 characters.');
            return;
        }
        const rawInvite = inviteCode.trim();
        const extractedOrigin = extractNodeOrigin(rawInvite);
        // The invite link usually carries the node origin. If it doesn't (plain code),
        // the node address is required info — without it the account can't reach a
        // community, so block rather than let someone in half-set-up.
        const nodeUrl = normalizeNodeUrl(extractedOrigin || createAnchorUrl.trim() || (__DEV__ ? 'https://127.0.0.1:8443' : ''));
        if (!nodeUrl) {
            setError('Enter your community node address — you need it to connect to your community.');
            return;
        }
        if (!looksLikeNodeAddress(nodeUrl)) {
            setError("That node address doesn't look right. Use something like node.yourcommunity.org");
            return;
        }

        setLoading(true);
        setError(null);
        try {
            const parsedCode = normaliseInviteCode(rawInvite);

            // Pre-flight the invite BEFORE creating an identity — a dud code
            // should fail here, not after the name/photo/seed ceremony. A null
            // result (node unreachable / older node) fails open; redeemInvite
            // at the final step stays the definitive check.
            const { checkInvite } = await import('../utils/db');
            const check = await checkInvite(parsedCode, nodeUrl);
            if (check && !check.valid) {
                setError(inviteProblemMessage(check.reason));
                return;
            }
            setInviterName(check?.inviterCallsign || null);
            setInviteCommunityName(check?.communityName || null);

            await AsyncStorage.setItem('beanpool_anchor_url', nodeUrl);

            const identity = await createIdentity(callsign.trim());
            setPendingIdentity(identity);
            setPendingInviteCode(parsedCode);
            // A keypair now exists on-device but the node doesn't know it yet —
            // record the wizard so an interrupted join resumes instead of
            // stranding the user (see utils/onboarding-state.ts).
            await setPendingOnboarding({
                step: 'profileSetup',
                inviteCode: parsedCode,
                anchorUrl: nodeUrl,
                callsign: callsign.trim(),
            });
            // Go to avatar selection (Step 2) instead of seed phrase
            setMode('profileSetup');
        } catch (err: any) {
            setError(`Failed to generate identity: ${err?.message || err}`);
            console.error(err);
        } finally {
            setLoading(false);
        }
    }

    async function handleConfirmSeed() {
        if (!pendingIdentity) return;
        setLoading(true);
        setError(null);
        try {
            if (pendingInviteCode) {
                const { redeemInvite } = await import('../utils/db');
                await redeemInvite(pendingInviteCode, pendingIdentity.callsign, pendingIdentity);
            }

            // The member now exists on the node, so it's finally safe to publish the avatar/profile
            // chosen in Step 2 (publishing before redeemInvite always 404s). On failure we leave the
            // pending_profile_sync flag set so pillar-sync re-publishes on the next successful sync.
            if (pendingAvatar) {
                try {
                    const url = await AsyncStorage.getItem('beanpool_anchor_url');
                    if (url) {
                        const payloadObj = {
                            publicKey: pendingIdentity.publicKey,
                            avatar: pendingAvatar,
                            callsign: pendingIdentity.callsign,
                        };
                        const bodyString = JSON.stringify(payloadObj);
                        const headers = await buildSignedHeaders('POST', '/api/profile/update', bodyString, pendingIdentity.privateKey, pendingIdentity.publicKey);
                        const res = await fetch(`${url}/api/profile/update`, {
                            method: 'POST',
                            headers,
                            body: bodyString,
                        });
                        if (res.ok) {
                            await AsyncStorage.removeItem('pending_profile_sync');
                        } else {
                            const errText = await res.text().catch(() => '');
                            console.warn('[Welcome] Post-registration profile publish rejected:', res.status, errText);
                            await AsyncStorage.setItem('pending_profile_sync', 'true');
                        }
                    }
                } catch (publishErr) {
                    console.warn('[Welcome] Post-registration profile publish failed (will heal on next sync):', publishErr);
                    await AsyncStorage.setItem('pending_profile_sync', 'true');
                }
            }

            // Wizard complete: the member now exists on the node, so the
            // half-registered-identity rescue record can go, and the seed
            // backup the user confirmed at Step 3 counts as backed up (this
            // also stops the Settings red-dot nag from firing 24h later).
            await clearPendingOnboarding();
            await AsyncStorage.setItem('beanpool_identity_backed_up', 'true');

            // Refresh node recognition — on a resumed wizard it is still the
            // stale pre-redeem 'stranger', which would pin us to this screen.
            await recheckNodeStatus().catch(() => {});

            // Final step — enter the app
            setIdentity(pendingIdentity);
        } catch (err: any) {
            setError(err.message || 'Failed to redeem invite code.');
        } finally {
            setLoading(false);
        }
    }

    async function handleRecover() {
        if (recoveryCallsign.trim().length < 2) {
            setError('Callsign must be at least 2 characters.');
            return;
        }
        const words = recoveryWords.map(w => w.toLowerCase().trim());
        const valid = words.filter(w => w.length > 0).length === 12;
        if (!valid) {
            setError('Please enter all 12 recovery words.');
            return;
        }
        const rawAnchor = recoveryAnchorUrl.trim();
        if (!rawAnchor && !__DEV__) {
            setError('Enter your community node address — you need it to reconnect to your community.');
            return;
        }
        const finalAnchorUrl = normalizeNodeUrl(rawAnchor || (__DEV__ ? 'https://127.0.0.1:8443' : ''));
        if (finalAnchorUrl && !looksLikeNodeAddress(finalAnchorUrl)) {
            setError("That node address doesn't look right. Use something like node.yourcommunity.org");
            return;
        }
        setLoading(true);
        setError(null);
        try {
            await AsyncStorage.setItem('beanpool_anchor_url', finalAnchorUrl);

            const identity = await createIdentityFromMnemonic(words, recoveryCallsign.trim());
            // Recovering an existing account supersedes any half-finished join
            // wizard on this device — drop the rescue record so the gatekeeper
            // doesn't bounce a recovered member back into onboarding.
            await clearPendingOnboarding();
            setIdentity(identity);
        } catch (err) {
            setError('Recovery failed. Check words and try again.');
        } finally {
            setLoading(false);
        }
    }



    function goBack() {
        setMode('home');
        setError(null);
    }

    // --- Onboarding Progress Stepper ---
    function OnboardingStepper({ step }: { step: 1 | 2 | 3 | 4 }) {
        const steps = ['Your Name', 'Your Photo', 'Safety Backup', 'How it Works'];
        return (
            <View style={stepperStyles.container}>
                {steps.map((label, i) => {
                    const stepNum = i + 1;
                    const isActive = stepNum === step;
                    const isCompleted = stepNum < step;
                    return (
                        <React.Fragment key={i}>
                            {i > 0 && <View style={[stepperStyles.line, (isCompleted || isActive) && stepperStyles.lineActive]} />}
                            <View style={stepperStyles.stepItem}>
                                <View style={[stepperStyles.dot, isActive && stepperStyles.dotActive, isCompleted && stepperStyles.dotCompleted]}>
                                    {isCompleted && <Text style={stepperStyles.dotCheck}>✓</Text>}
                                </View>
                                <Text style={[stepperStyles.label, isActive && stepperStyles.labelActive]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{label}</Text>
                            </View>
                        </React.Fragment>
                    );
                })}
            </View>
        );
    }

    // --- Copy seed phrase to clipboard ---
    async function handleCopySeed() {
        if (!pendingIdentity?.mnemonic) return;
        await Clipboard.setStringAsync(pendingIdentity.mnemonic.join(' '));
        hapticTick();
        setSeedCopied(true);
        setTimeout(() => setSeedCopied(false), 2000);
    }

    // --- Back-button guard for seed phrase screen ---
    function handleSeedBackPress() {
        Alert.alert(
            'Have you saved your words?',
            'If you go back now, you\'ll need to start over.',
            [
                { text: 'Stay', style: 'cancel' },
                { text: 'Go Back', style: 'destructive', onPress: () => {
                    setPendingIdentity(null);
                    setPendingAvatar(null);
                    setSeedConfirmed(false);
                    setSeedCopied(false);
                    updatePendingOnboarding({ step: 'create', avatar: null }).catch(() => {});
                    setMode('create');
                    setError(null);
                }},
            ]
        );
    }

    // Android hardware back button handler for seed screen
    React.useEffect(() => {
        if (mode !== 'seedBackup') return;
        const sub = BackHandler.addEventListener('hardwareBackPress', () => {
            handleSeedBackPress();
            return true; // Prevent default back
        });
        return () => sub.remove();
    }, [mode]);

    // --- Profile image picker helpers for "Who Are You?" gate ---
    // Moved to AvatarPickerSheet component

    async function handleCompleteProfile() {
        if (!pendingIdentity || !pendingAvatar) return;
        setLoading(true);
        setError(null);
        try {
            // 1. Write avatar to local SQLite
            await updateMemberProfile(pendingIdentity.publicKey, {
                callsign: pendingIdentity.callsign,
                avatar_url: pendingAvatar,
            });

            // 2. Defer the server publish until AFTER the member is registered on the node.
            // `/api/profile/update` requires an existing member, so publishing here — before
            // redeemInvite (which runs in handleConfirmSeed, Step 3) — always 404s and silently
            // drops the avatar. We mark the profile pending; it is published the moment the
            // member is registered (handleConfirmSeed), with the pillar-sync heal as a backstop.
            await AsyncStorage.setItem('pending_profile_sync', 'true');

            await updatePendingOnboarding({ step: 'seedBackup', avatar: pendingAvatar });

            // 3. Profile done — go to seed phrase (Step 3) instead of entering app
            setMode('seedBackup');
        } catch (err: any) {
            setError(err.message || 'Failed to save profile.');
        } finally {
            setLoading(false);
        }
    }

    // --- STEP 2: PROFILE SETUP ("Choose your look") ---
    if (mode === 'profileSetup' && pendingIdentity) {
        return (
            <SafeAreaView style={styles.container}>
                <StatusBar style="dark" />
                <ScrollView contentContainerStyle={styles.scroll}>
                    <OnboardingStepper step={2} />
                    <View style={styles.card}>
                        {inviterName && (
                            <View style={styles.inviteVerifiedBox}>
                                <Text style={styles.inviteVerifiedText}>
                                    🎟️ Your invite from <Text style={{ fontWeight: 'bold' }}>{inviterName}</Text> checks out
                                    {inviteCommunityName ? <Text> — welcome to <Text style={{ fontWeight: 'bold' }}>{inviteCommunityName}</Text>!</Text> : <Text>!</Text>}
                                </Text>
                            </View>
                        )}
                        <Text style={styles.title}>📸 Choose your look</Text>
                        <Text style={styles.subtitle}>
                            Add a photo, or pick a fun avatar — whatever feels like you.
                        </Text>

                        {/* Preview circle */}
                        <View style={profileStyles.previewContainer}>
                            {pendingAvatar ? (
                                <Image
                                    source={pendingAvatar.startsWith('bundled://') ? resolveBundledAvatar(pendingAvatar)! : { uri: pendingAvatar }}
                                    style={profileStyles.previewImage}
                                    accessibilityLabel="Your selected profile picture"
                                />
                            ) : (
                                <View style={profileStyles.previewPlaceholder}>
                                    <Text style={profileStyles.previewPlaceholderText}>
                                        {pendingIdentity.callsign.charAt(0).toUpperCase()}
                                    </Text>
                                </View>
                            )}
                            <Text style={profileStyles.previewCallsign}>
                                {pendingIdentity.callsign}
                            </Text>
                        </View>

                        {/* Choose Photo Button */}
                        <Pressable
                            style={styles.secondaryBtn}
                            onPress={() => setShowAvatarPicker(true)}
                            disabled={loading}
                            accessibilityRole="button"
                        >
                            <Text style={styles.secondaryBtnText}>
                                {pendingAvatar ? 'Change Photo or Avatar' : 'Choose Photo or Avatar'}
                            </Text>
                        </Pressable>

                        {loading && (
                            <View style={{ alignItems: 'center', marginVertical: 12 }}>
                                <ActivityIndicator color={palette.blue600} />
                                <Text style={{ color: colors.text.secondary, fontSize: 12, marginTop: 4 }}>Processing image...</Text>
                            </View>
                        )}

                        {error && <Text style={styles.error}>{error}</Text>}

                        <Pressable
                            style={[styles.primaryBtn, !pendingAvatar && styles.disabledBtn]}
                            disabled={!pendingAvatar || loading}
                            onPress={handleCompleteProfile}
                            accessibilityRole="button"
                        >
                            {loading ? (
                                <ActivityIndicator color={colors.text.inverse} />
                            ) : (
                                <Text style={styles.primaryBtnText}>Next →</Text>
                            )}
                        </Pressable>

                        <Pressable
                            style={styles.backBtn}
                            onPress={() => {
                                updatePendingOnboarding({ step: 'create', avatar: null }).catch(() => {});
                                setMode('create'); setPendingIdentity(null); setPendingAvatar(null); setShowAvatarPicker(false); setError(null);
                            }}
                            disabled={loading}
                            accessibilityRole="button"
                            accessibilityLabel="Back"
                        >
                            <Text style={styles.backBtnText}>← Back</Text>
                        </Pressable>
                    </View>
                </ScrollView>
                
                <AvatarPickerSheet
                    visible={showAvatarPicker}
                    onClose={() => setShowAvatarPicker(false)}
                    onSelectImage={(uri) => setPendingAvatar(uri)}
                />
            </SafeAreaView>
        );
    }

    // --- STEP 3: SAFETY BACKUP (seed phrase — reframed) ---
    if (mode === 'seedBackup' && pendingIdentity) {
        return (
            <SafeAreaView style={styles.container}>
                <StatusBar style="dark" />
                <ScrollView contentContainerStyle={styles.scroll}>
                    <OnboardingStepper step={3} />
                    <View style={styles.card}>
                        <Text style={styles.title}>🛡️ Your Safety Backup</Text>
                        <Text style={styles.subtitle}>
                            These 12 words are your personal recovery key. If you ever lose your phone, these words will bring your account back.
                        </Text>
                        <Text style={{ color: colors.text.secondary, fontSize: 13, marginBottom: 16, lineHeight: 18 }}>
                            💡 Take a screenshot or write them down somewhere safe.
                        </Text>
                        <View style={styles.seedGrid}>
                            {pendingIdentity.mnemonic?.map((word, i) => (
                                <View key={i} style={styles.seedCell}>
                                    <Text style={styles.seedIndex}>{i + 1}.</Text>
                                    <Text style={styles.seedWord} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{word}</Text>
                                </View>
                            ))}
                        </View>

                        {/* Copy to clipboard */}
                        <Pressable
                            style={[styles.secondaryBtn, { marginBottom: 12 }]}
                            onPress={handleCopySeed}
                            accessibilityRole="button"
                        >
                            <Text style={styles.secondaryBtnText}>
                                {seedCopied ? '✅ Copied!' : '📋 Copy All Words'}
                            </Text>
                        </Pressable>

                        <Pressable
                            style={[styles.checkbox, seedConfirmed && styles.checkboxActive]}
                            onPress={() => setSeedConfirmed(!seedConfirmed)}
                            accessibilityRole="button"
                            accessibilityState={{ selected: seedConfirmed }}
                        >
                            <Text style={styles.checkboxText}>
                                {seedConfirmed ? '✅ ' : '⬜ '} I've saved these words ✓
                            </Text>
                        </Pressable>

                        {error && <Text style={styles.error}>{error}</Text>}

                        <Pressable
                            style={[styles.primaryBtn, !seedConfirmed && styles.disabledBtn]}
                            disabled={!seedConfirmed || loading}
                            onPress={() => {
                                updatePendingOnboarding({ step: 'onboardingGuide' }).catch(() => {});
                                setMode('onboardingGuide');
                            }}
                            accessibilityRole="button"
                        >
                            <Text style={styles.primaryBtnText}>Next →</Text>
                        </Pressable>

                        <Pressable
                            style={styles.backBtn}
                            onPress={handleSeedBackPress}
                            disabled={loading}
                            accessibilityRole="button"
                            accessibilityLabel="Back"
                        >
                            <Text style={styles.backBtnText}>← Back</Text>
                        </Pressable>
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // --- STEP 4: ONBOARDING GUIDE (What is BeanPool & ledger rules) ---
    if (mode === 'onboardingGuide' && pendingIdentity) {
        return (
            <SafeAreaView style={styles.container}>
                <StatusBar style="dark" />
                <ScrollView contentContainerStyle={styles.scroll}>
                    <OnboardingStepper step={4} />
                    <View style={styles.card}>
                        <Text style={styles.title}>🫘 Welcome to BeanPool</Text>
                        <Text style={styles.subtitle}>
                            Let's look at how this community economy works.
                        </Text>

                        {/* Card 1: Energy Exchange */}
                        <View style={guideStyles.card}>
                            <Text style={guideStyles.cardTitle}>⚡ Energy Exchange Marketplace</Text>
                            <Text style={guideStyles.cardText}>
                                BeanPool runs on cooperation, not accumulation. The goal is to keep energy flowing.
                            </Text>
                            <View style={guideStyles.highlightBox}>
                                <Text style={guideStyles.highlightText}>
                                    🟢 <Text style={{ fontWeight: 'bold' }}>The best place to be is zero (0 Beans).</Text> This means you have given as much value to your community as you have received from it.
                                </Text>
                            </View>
                            <View style={[guideStyles.highlightBox, { backgroundColor: 'rgba(245, 158, 11, 0.12)', borderColor: 'rgba(245, 158, 11, 0.35)' }]}>
                                <Text style={[guideStyles.highlightText, { color: palette.amber700 || '#b45309' }]}>
                                    🫘 <Text style={{ fontWeight: 'bold' }}>Contributions First.</Text> To keep the credit pool healthy, list at least one Offer of what you can give back before you can post Needs or accept Offers.
                                </Text>
                            </View>
                        </View>

                        {/* Card 2: The Ledger Rules */}
                        <View style={guideStyles.card}>
                            <Text style={guideStyles.cardTitle}>🪙 The Mutual Credit Ledger</Text>
                            
                            <View style={guideStyles.bulletRow}>
                                <Text style={guideStyles.bulletEmoji}>🤝</Text>
                                <View style={guideStyles.bulletContent}>
                                    <Text style={guideStyles.bulletTitle}>Trust-Backed Credit</Text>
                                    <Text style={guideStyles.bulletText}>
                                        Everyone starts with a 0 Bean limit. Complete your first real marketplace trade and your community credit line opens — then it deepens steadily with the value you trade and the people you trade with, up to -2000 Beans. No interest, no bank fees.
                                    </Text>
                                </View>
                            </View>

                            <View style={guideStyles.bulletRow}>
                                <Text style={guideStyles.bulletEmoji}>🌾</Text>
                                <View style={guideStyles.bulletContent}>
                                    <Text style={guideStyles.bulletTitle}>Community Commons Pool</Text>
                                    <Text style={guideStyles.bulletText}>
                                        Positive balances above 200 Beans decay by 1.5% monthly (progressive circulation). This prevents hoarding and funds local community projects.
                                    </Text>
                                </View>
                            </View>

                            <View style={guideStyles.bulletRow}>
                                <Text style={guideStyles.bulletEmoji}>⏱️</Text>
                                <View style={guideStyles.bulletContent}>
                                    <Text style={guideStyles.bulletTitle}>Reference Rate</Text>
                                    <Text style={guideStyles.bulletText}>
                                        40 Beans represents roughly 1 hour of community service or time, helping you easily value what you offer or need.
                                    </Text>
                                </View>
                            </View>
                        </View>

                        {/* Card 3: Safe Handshake Held in Trust */}
                        <View style={guideStyles.card}>
                            <Text style={guideStyles.cardTitle}>🔒 Held in Trust</Text>
                            <Text style={guideStyles.cardText}>
                                To ensure fairness, when you accept an offer or request a job, your credits are safely held in a temporary Trust Wallet. They are only released to the provider once you confirm delivery.
                            </Text>
                        </View>

                        {/* Card 4: Where to Start */}
                        <View style={guideStyles.card}>
                            <Text style={guideStyles.cardTitle}>🚀 Where to Start?</Text>
                            <Text style={guideStyles.bulletItem}>📍 Explore the <Text style={{ fontWeight: 'bold' }}>Map</Text> to find offers (blue) and needs (orange) near you.</Text>
                            <Text style={guideStyles.bulletItem}>💬 Tap <Text style={{ fontWeight: 'bold' }}>Message</Text> on any post to chat securely (E2E encrypted) with neighbors.</Text>
                            <Text style={guideStyles.bulletItem}>➕ Click <Text style={{ fontWeight: 'bold' }}>Post</Text> to list what you need or what you can offer to the community.</Text>
                            <Text style={guideStyles.bulletItem}>💳 Use the <Text style={{ fontWeight: 'bold' }}>Ledger</Text> tab to send credits to neighbors instantly.</Text>
                        </View>

                        {error && <Text style={styles.error}>{error}</Text>}

                        <Pressable
                            style={[styles.primaryBtn, loading && styles.disabledBtn]}
                            disabled={loading}
                            onPress={handleConfirmSeed}
                            accessibilityRole="button"
                        >
                            {loading ? (
                                <ActivityIndicator color={colors.text.inverse} />
                            ) : (
                                <Text style={styles.primaryBtnText}>Let's Begin! 🚀</Text>
                            )}
                        </Pressable>

                        <Pressable
                            style={styles.backBtn}
                            onPress={() => {
                                updatePendingOnboarding({ step: 'seedBackup' }).catch(() => {});
                                setMode('seedBackup');
                                setError(null);
                            }}
                            disabled={loading}
                            accessibilityRole="button"
                        >
                            <Text style={styles.backBtnText}>← Back to Backup</Text>
                        </Pressable>
                    </View>
                </ScrollView>
            </SafeAreaView>
        );
    }

    // --- CREATE NEW IDENTITY ---
    if (mode === 'create') {
        return (
            <SafeAreaView style={styles.container}>
                <StatusBar style="dark" />
                <KeyboardAvoidingView
                    behavior="padding"
                    style={{ flex: 1 }}
                >
                    <ScrollView contentContainerStyle={styles.scroll}>
                    <OnboardingStepper step={1} />
                    <View style={styles.card}>
                        <Text style={styles.title}>🎟️ Join BeanPool</Text>

                        <View style={styles.inputContainer}>
                            <TextInput
                                style={styles.inputFlex}
                                placeholder="Paste your invite link or code"
                                placeholderTextColor={colors.text.muted}
                                value={inviteCode}
                                onChangeText={setInviteCode}
                                autoCapitalize="none"
                                autoCorrect={false}
                                accessibilityLabel="Invite link or code"
                            />
                            <Pressable style={styles.pasteBtn} onPress={handlePasteInvite} accessibilityRole="button">
                                <Text style={styles.pasteBtnText}>Paste</Text>
                            </Pressable>
                        </View>

                        {inviteCode && !inviteCode.startsWith('http') && (
                            <>
                                <TextInput
                                    style={styles.input}
                                    placeholder="Community Node URL (e.g. node.yourcommunity.org)"
                                    placeholderTextColor={colors.text.muted}
                                    value={createAnchorUrl}
                                    onChangeText={setCreateAnchorUrl}
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    keyboardType="url"
                                    accessibilityLabel="Community Node URL"
                                />
                                <Text style={styles.fieldHint}>
                                    Required — the community node you're joining. Ask whoever invited you if you're unsure.
                                </Text>
                            </>
                        )}

                        <Text style={styles.callsignLabel}>What should we call you?</Text>
                        <TextInput
                            style={styles.callsignInput}
                            placeholder="Your name or nickname (e.g. Sarah)"
                            placeholderTextColor={colors.text.muted}
                            value={callsign}
                            onChangeText={setCallsign}
                            maxLength={32}
                            autoFocus={true}
                            autoCapitalize="words"
                            accessibilityLabel="Your name or nickname"
                        />
                        <Text style={styles.callsignHelper}>
                            This is your display name — how the community sees you. You can change it later.
                        </Text>
                        <Text style={styles.callsignTip}>
                            💡 Tip: adding your suburb helps locals find you!
                        </Text>

                        {error && <Text style={styles.error}>{error}</Text>}

                        <Pressable style={styles.primaryBtn} onPress={handleCreate} disabled={loading} accessibilityRole="button">
                            {loading ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.primaryBtnText}>Next →</Text>}
                        </Pressable>

                        <Pressable style={styles.backBtn} onPress={goBack} accessibilityRole="button" accessibilityLabel="Back">
                            <Text style={styles.backBtnText}>← Back</Text>
                        </Pressable>
                    </View>
                </ScrollView>
                </KeyboardAvoidingView>
            </SafeAreaView>
        );
    }

    // --- MEMBER SUB-MENU (Transfer Link or 12 Words) ---
    if (mode === 'member') {
        return (
            <SafeAreaView style={styles.container}>
                <StatusBar style="dark" />
                <View style={{ flex: 1, justifyContent: 'center', padding: 24, alignItems: 'center' }}>
                    <View style={styles.card}>
                        <Text style={styles.title}>Sign in to your account</Text>
                        <Text style={styles.subtitle}>Choose how to restore your identity on this device:</Text>



                        <Pressable style={styles.recoverBtn} onPress={() => { setMode('recover'); setError(null); }} accessibilityRole="button">
                            <Text style={styles.recoverBtnText}>🔑 Recover with 12 Words</Text>
                        </Pressable>

                        <Pressable style={styles.socialRecoverBtn} onPress={() => { router.push('/recover-identity'); }} accessibilityRole="button">
                            <Text style={styles.socialRecoverBtnText}>🛡️ Recover via Guardians</Text>
                        </Pressable>

                        <Pressable style={styles.backBtn} onPress={goBack} accessibilityRole="button" accessibilityLabel="Back">
                            <Text style={styles.backBtnText}>← Back</Text>
                        </Pressable>
                    </View>
                </View>
            </SafeAreaView>
        );
    }



    // --- RECOVER FROM 12 WORDS ---
    if (mode === 'recover') {
        return (
            <SafeAreaView style={styles.container}>
                <StatusBar style="dark" />
                <KeyboardAvoidingView
                    behavior="padding"
                    style={{ flex: 1 }}
                >
                    <ScrollView contentContainerStyle={styles.scroll}>
                    <View style={styles.card}>
                        <Text style={styles.title}>🔑 Recover Identity</Text>
                        <Text style={styles.subtitle}>Enter the 12 recovery words you wrote down.</Text>

                        <View style={styles.recoveryGrid}>
                            {recoveryWords.map((word, i) => (
                                <TextInput
                                    key={i}
                                    accessibilityLabel={`Recovery word ${i + 1}`}
                                    style={styles.recoveryInput}
                                    value={word}
                                    onChangeText={(t) => {
                                        const updated = [...recoveryWords];
                                        updated[i] = t;
                                        setRecoveryWords(updated);
                                    }}
                                    placeholder={`${i + 1}`}
                                    placeholderTextColor={colors.text.muted}
                                    autoCapitalize="none"
                                />
                            ))}
                        </View>

                        <TextInput
                            accessibilityLabel="Your callsign"
                            style={styles.input}
                            placeholder="Your callsign"
                            placeholderTextColor={colors.text.muted}
                            value={recoveryCallsign}
                            onChangeText={setRecoveryCallsign}
                        />

                        <TextInput
                            accessibilityLabel="Community Node URL"
                            style={styles.input}
                            placeholder="Community Node URL (e.g. node.yourcommunity.org)"
                            placeholderTextColor={colors.text.muted}
                            value={recoveryAnchorUrl}
                            onChangeText={setRecoveryAnchorUrl}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                        />
                        <Text style={styles.fieldHint}>
                            Required — this is the community node that holds your account. Ask whoever invited you if you're unsure.
                        </Text>

                        {error && <Text style={styles.error}>{error}</Text>}

                        <Pressable style={styles.primaryBtn} onPress={handleRecover} disabled={loading} accessibilityRole="button">
                            {loading ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.primaryBtnText}>Recover Identity</Text>}
                        </Pressable>

                        <Pressable style={styles.backBtn} onPress={() => { setMode('member'); setError(null); }} accessibilityRole="button" accessibilityLabel="Back">
                            <Text style={styles.backBtnText}>← Back</Text>
                        </Pressable>
                    </View>
                </ScrollView>
                </KeyboardAvoidingView>
            </SafeAreaView>
        );
    }

    // --- MAIN WELCOME SCREEN (two choices like the PWA) ---
    return (
        <SafeAreaView style={styles.container}>
            <StatusBar style="dark" />
            <View style={{ flex: 1, justifyContent: 'center', padding: 24, alignItems: 'center' }}>
                <Text style={styles.headerTitle}>Welcome to BeanPool</Text>
                <Text style={styles.headerSubtitle}>
                    Trade skills, goods and favours with your local community — no bank, no fees. Your account lives safely on this device: no passwords, no emails, nothing to remember.
                </Text>

                <Pressable style={styles.memberBtn} onPress={() => setMode('member')} accessibilityRole="button">
                    <Text style={styles.memberBtnText}>I'm Already a Member →</Text>
                </Pressable>

                <Pressable style={styles.secondaryBtn} onPress={() => setMode('create')} accessibilityRole="button">
                    <Text style={styles.secondaryBtnText}>I'm New Here</Text>
                </Pressable>

                {clipboardMayHaveInvite && (
                    <Pressable style={styles.clipboardHintBtn} onPress={handleCheckClipboardInvite} accessibilityRole="button">
                        <Text style={styles.clipboardHintText}>📋 Been sent an invite? Tap to check your clipboard</Text>
                    </Pressable>
                )}
            </View>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface.app },
    scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
    headerTitle: { fontSize: 24, fontWeight: 'bold', color: colors.text.heading, textAlign: 'center', marginBottom: 8 },
    headerSubtitle: { fontSize: 16, color: colors.text.secondary, textAlign: 'center', marginBottom: 32, lineHeight: 24 },
    card: { backgroundColor: colors.surface.card, padding: 24, borderRadius: 16, borderWidth: 1, borderColor: colors.border.default, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 10, elevation: 2 },
    inviteVerifiedBox: { backgroundColor: 'rgba(34, 197, 94, 0.10)', borderWidth: 1, borderColor: 'rgba(34, 197, 94, 0.35)', borderRadius: 12, padding: 12, marginBottom: 16 },
    inviteVerifiedText: { color: palette.green700 || '#15803d', fontSize: 14, lineHeight: 20 },
    clipboardHintBtn: { marginTop: 20, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 999, backgroundColor: 'rgba(59, 130, 246, 0.08)', borderWidth: 1, borderColor: 'rgba(59, 130, 246, 0.3)' },
    clipboardHintText: { color: palette.blue600, fontSize: 14, fontWeight: '600', textAlign: 'center' },
    title: { fontSize: 20, fontWeight: 'bold', color: colors.text.heading, marginBottom: 8 },
    subtitle: { fontSize: 14, color: colors.text.secondary, marginBottom: 24, lineHeight: 20 },
    input: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 12, padding: 14, color: colors.text.heading, fontSize: 16, marginBottom: 16 },
    fieldHint: { fontSize: 13, color: colors.text.secondary, marginTop: -8, marginBottom: 16, lineHeight: 18 },
    inputContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 12, marginBottom: 16, overflow: 'hidden' },
    inputFlex: { flex: 1, padding: 16, color: colors.text.heading, fontSize: 16 },
    pasteBtn: { backgroundColor: colors.surface.subtle, paddingHorizontal: 16, paddingVertical: 12, borderLeftWidth: 1, borderColor: colors.border.strong, justifyContent: 'center' },
    pasteBtnText: { color: palette.gray600, fontSize: 14, fontWeight: '600' },

    // Callsign (Step 1) — larger, labeled input
    callsignLabel: { fontSize: 18, fontWeight: '700', color: colors.text.body, marginBottom: 8, marginTop: 8 },
    callsignInput: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 12, padding: 18, color: colors.text.heading, fontSize: 18, marginBottom: 8 },
    callsignHelper: { fontSize: 13, color: colors.text.secondary, marginBottom: 4, lineHeight: 18 },
    callsignTip: { fontSize: 13, color: colors.text.muted, marginBottom: 20, fontStyle: 'italic' },

    // Main welcome buttons
    memberBtn: { backgroundColor: palette.blue600, padding: 18, borderRadius: 14, alignItems: 'center', width: '100%', marginBottom: 12, shadowColor: palette.blue600, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 14, elevation: 6 },
    memberBtnText: { color: colors.text.inverse, fontSize: 18, fontWeight: '700' },
    secondaryBtn: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border.strong, padding: 16, borderRadius: 14, alignItems: 'center', width: '100%' },
    secondaryBtnText: { color: palette.gray600, fontSize: 16, fontWeight: '600' },

    // Member sub-options

    recoverBtn: { width: '100%', padding: 16, borderRadius: 14, borderWidth: 1, borderColor: colors.onboarding.recoverBorder, backgroundColor: colors.onboarding.recoverBg, alignItems: 'center', marginBottom: 10 },
    recoverBtnText: { color: palette.amber800, fontSize: 16, fontWeight: '700' },
    socialRecoverBtn: { width: '100%', padding: 16, borderRadius: 14, borderWidth: 1, borderColor: colors.onboarding.socialRecoverBorder, backgroundColor: colors.onboarding.socialRecoverBg, alignItems: 'center', marginBottom: 10 },
    socialRecoverBtnText: { color: palette.emerald700, fontSize: 16, fontWeight: '700' },

    primaryBtn: { backgroundColor: palette.blue600, padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 8 },
    primaryBtnText: { color: colors.text.inverse, fontSize: 16, fontWeight: 'bold' },
    disabledBtn: { backgroundColor: palette.slate300 },
    backBtn: { marginTop: 16, alignItems: 'center', padding: 10 },
    backBtnText: { color: colors.text.secondary, fontSize: 14 },
    error: { color: colors.feedback.danger.solid, fontSize: 14, marginBottom: 16, textAlign: 'center' },
    checkbox: { flexDirection: 'row', alignItems: 'center', marginVertical: 16, padding: 12, backgroundColor: colors.surface.subtle, borderRadius: 8 },
    checkboxActive: { backgroundColor: palette.blue100 },
    checkboxText: { color: colors.text.heading, fontSize: 14, fontWeight: '600' },
    seedGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
    seedCell: { width: '31%', backgroundColor: colors.surface.subtle, borderRadius: 8, padding: 8, marginBottom: 8, alignItems: 'center' },
    seedIndex: { color: colors.text.muted, fontSize: 10 },
    seedWord: { color: colors.text.heading, fontSize: 14, fontWeight: 'bold', minHeight: 20 },
    recoveryGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 16 },
    recoveryInput: { width: '31%', backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 8, padding: 8, color: colors.text.heading, fontSize: 12, marginBottom: 8, textAlign: 'center' }
});

// Styles for the "Who Are You?" profile setup gate
const profileStyles = StyleSheet.create({
    previewContainer: {
        alignItems: 'center',
        marginBottom: 24,
    },
    previewImage: {
        width: 96,
        height: 96,
        borderRadius: 48,
        borderWidth: 3,
        borderColor: palette.blue600,
        overflow: 'hidden',
    },
    previewPlaceholder: {
        width: 96,
        height: 96,
        borderRadius: 48,
        backgroundColor: colors.surface.subtle,
        borderWidth: 2,
        borderColor: colors.border.strong,
        borderStyle: 'dashed',
        justifyContent: 'center',
        alignItems: 'center',
    },
    previewPlaceholderText: {
        fontSize: 36,
        fontWeight: '800',
        color: colors.text.muted,
    },
    previewCallsign: {
        fontSize: 16,
        fontWeight: '700',
        color: colors.text.body,
        marginTop: 8,
    },
    trinityRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        gap: 10,
        marginBottom: 20,
    },
    trinityCard: {
        flex: 1,
        backgroundColor: colors.surface.app,
        borderWidth: 1,
        borderColor: colors.border.default,
        borderRadius: 14,
        paddingVertical: 16,
        alignItems: 'center',
        gap: 6,
    },
    trinityCardActive: {
        borderColor: palette.blue600,
        backgroundColor: colors.onboarding.trinityActiveBg,
    },
    trinityEmoji: {
        fontSize: 28,
    },
    trinityLabel: {
        fontSize: 13,
        fontWeight: '600',
        color: palette.gray600,
    },
    avatarGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 10,
        marginBottom: 20,
        paddingVertical: 12,
        paddingHorizontal: 4,
        backgroundColor: colors.surface.subtle,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.border.default,
    },
    avatarGridItem: {
        width: 60,
        height: 60,
        borderRadius: 30,
        overflow: 'hidden',
        borderWidth: 2,
        borderColor: 'transparent',
    },
    avatarGridItemSelected: {
        borderColor: palette.blue600,
        shadowColor: palette.blue600,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.6,
        shadowRadius: 8,
        elevation: 6,
    },
    avatarGridImage: {
        width: '100%',
        height: '100%',
    },
});

// Styles for the onboarding progress stepper
const stepperStyles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 24,
        paddingHorizontal: 8,
    },
    stepItem: {
        alignItems: 'center',
        flexShrink: 1,
        minWidth: 0,
    },
    dot: {
        width: 12,
        height: 12,
        borderRadius: 6,
        backgroundColor: colors.border.strong,
        marginBottom: 6,
    },
    dotActive: {
        backgroundColor: palette.blue600,
        width: 14,
        height: 14,
        borderRadius: 7,
    },
    dotCompleted: {
        backgroundColor: palette.green500,
        width: 14,
        height: 14,
        borderRadius: 7,
        alignItems: 'center',
        justifyContent: 'center',
    },
    dotCheck: {
        color: colors.text.inverse,
        fontSize: 9,
        fontWeight: '800',
    },
    label: {
        fontSize: 11,
        color: colors.text.secondary,
        fontWeight: '500',
    },
    labelActive: {
        color: colors.text.heading,
        fontWeight: '700',
    },
    line: {
        width: 20,
        height: 2,
        backgroundColor: colors.border.strong,
        marginBottom: 18,
        marginHorizontal: 2,
    },
    lineActive: {
        backgroundColor: palette.green500,
    },
});

const guideStyles = StyleSheet.create({
    card: {
        backgroundColor: colors.surface.app,
        borderWidth: 1,
        borderColor: colors.border.default,
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
    },
    cardTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: colors.text.body,
        marginBottom: 8,
    },
    cardText: {
        fontSize: 14,
        color: palette.gray600,
        lineHeight: 20,
    },
    highlightBox: {
        backgroundColor: colors.onboarding.highlightBg,
        borderWidth: 1,
        borderColor: colors.onboarding.highlightBorder,
        borderRadius: 8,
        padding: 12,
        marginTop: 10,
    },
    highlightText: {
        fontSize: 13,
        color: palette.green800,
        lineHeight: 18,
    },
    bulletRow: {
        flexDirection: 'row',
        marginTop: 12,
        alignItems: 'flex-start',
    },
    bulletEmoji: {
        fontSize: 18,
        marginRight: 10,
        marginTop: 2,
    },
    bulletContent: {
        flex: 1,
    },
    bulletTitle: {
        fontSize: 14,
        fontWeight: '600',
        color: palette.gray700,
        marginBottom: 2,
    },
    bulletText: {
        fontSize: 13,
        color: colors.text.secondary,
        lineHeight: 18,
    },
    bulletItem: {
        fontSize: 13,
        color: palette.gray600,
        lineHeight: 18,
        marginBottom: 8,
    }
});
