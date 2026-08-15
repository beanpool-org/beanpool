import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator, SafeAreaView, ScrollView, Image, Alert } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { MemberAvatar } from '../components/MemberAvatar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { lookupRecoveryCallsign } from '../utils/db';
import { normalizeNodeUrl, looksLikeNodeAddress, shouldBlockCleartextNodeUrl } from '../utils/node-url';
import { colors } from '../constants/colors';
import { useIdentity } from './IdentityContext';
import { verifyRecoveryPin } from '../utils/pin';
import {
    startFriendRecoverySession,
    pollFriendRecovery,
    completeFriendRecovery,
} from '../utils/friend-recovery';
import type { BeanPoolIdentity } from '../utils/identity';

export default function RecoverIdentityScreen() {
    const { setIdentity } = useIdentity();
    const [step, setStep] = useState<'lookup' | 'select' | 'pin' | 'waiting' | 'reconstructing'>('lookup');
    const [callsign, setCallsign] = useState('');
    const [anchorUrl, setAnchorUrl] = useState('');
    const [lookupResults, setLookupResults] = useState<any[]>([]);
    const [selectedProfile, setSelectedProfile] = useState<any>(null);
    const [pin, setPin] = useState('');
    const [pinVerified, setPinVerified] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    
    // Two-Layer Recovery tracking
    const [collectionId, setCollectionId] = useState<string | null>(null);
    const [ephIdentity, setEphIdentity] = useState<BeanPoolIdentity | null>(null);
    const [progress, setProgress] = useState<{
        collected: number;
        threshold: number;
        enough: boolean;
        hubAvailable: boolean;
    }>({ collected: 0, threshold: 3, enough: false, hubAvailable: false });

    const [isReconstructing, setIsReconstructing] = useState(false);
    const isPollingRef = React.useRef(false);

    // Pre-fill the node address if this device has ever been connected to one
    useEffect(() => {
        AsyncStorage.getItem('beanpool_anchor_url').then((url) => {
            if (url) setAnchorUrl(url);
        }).catch(() => {});
    }, []);

    const handleLookup = async () => {
        if (!callsign.trim()) return;
        const rawAnchor = anchorUrl.trim();
        if (!rawAnchor) {
            setError('Enter your community node address — we need it to find your account.');
            return;
        }
        const finalAnchorUrl = normalizeNodeUrl(rawAnchor);
        if (!looksLikeNodeAddress(finalAnchorUrl)) {
            setError("That node address doesn't look right. Use something like node.yourcommunity.org");
            return;
        }
        if (shouldBlockCleartextNodeUrl(finalAnchorUrl)) {
            setError('That node address is insecure (http on a public host). Ask whoever invited you for the https:// address.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            await AsyncStorage.setItem('beanpool_anchor_url', finalAnchorUrl);
            const results = await lookupRecoveryCallsign(callsign.trim());
            if (results.length === 0) {
                setError('No recovery-eligible accounts found with that callsign.');
            } else {
                setLookupResults(results);
                setStep('select');
            }
        } catch (e: any) {
            setError(e.message || 'Lookup failed. Check connection.');
        } finally {
            setLoading(false);
        }
    };

    const handleSelect = (profile: any) => {
        setSelectedProfile(profile);
        setPin('');
        setError(null);
        setStep('pin');
    };

    const handleVerifyPin = async () => {
        if (!/^\d{6}$/.test(pin)) {
            setError('PIN must be exactly 6 digits.');
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const rawAnchor = anchorUrl.trim();
            const finalAnchorUrl = normalizeNodeUrl(rawAnchor);
            const res = await verifyRecoveryPin(finalAnchorUrl, selectedProfile.callsign, pin);
            if (res.verified) {
                setPinVerified(true);
                setError(null);
                await startRecoveryFlow();
            } else if (res.error) {
                setError(res.error);
            } else {
                setError("PIN didn't match. If you forgot your PIN, tap 'Skip PIN' to continue.");
            }
        } catch (e: any) {
            setError(e.message || 'Verification failed. Try again or skip.');
        } finally {
            setLoading(false);
        }
    };

    const handleSkipPin = async () => {
        setError(null);
        await startRecoveryFlow();
    };

    const startRecoveryFlow = async () => {
        setLoading(true);
        setError(null);
        try {
            const rawAnchor = anchorUrl.trim();
            const finalAnchorUrl = normalizeNodeUrl(rawAnchor);
            const session = await startFriendRecoverySession({
                callsign: selectedProfile.callsign,
                anchorUrl: finalAnchorUrl,
            });

            setCollectionId(session.collectionId);
            setEphIdentity(session.ephIdentity);
            setProgress({
                collected: 0,
                threshold: session.threshold,
                enough: false,
                hubAvailable: false,
            });
            setIsReconstructing(false);
            setStep('waiting');
        } catch (e: any) {
            setError(e.message || 'Failed to start recovery session.');
        } finally {
            setLoading(false);
        }
    };

    const pollStatus = async () => {
        if (!collectionId || !ephIdentity || isPollingRef.current || isReconstructing) return;
        isPollingRef.current = true;
        try {
            const rawAnchor = anchorUrl.trim();
            const finalAnchorUrl = normalizeNodeUrl(rawAnchor);
            const p = await pollFriendRecovery(finalAnchorUrl, collectionId, ephIdentity);
            setProgress(p);

            if (p.enough) {
                setIsReconstructing(true);
                setStep('reconstructing');
                try {
                    const restored = await completeFriendRecovery(
                        finalAnchorUrl,
                        collectionId,
                        ephIdentity,
                        selectedProfile?.callsign,
                        selectedProfile?.publicKey,
                    );
                    setIdentity(restored);
                    router.replace('/(tabs)');
                } catch (recErr: any) {
                    setIsReconstructing(false);
                    setStep('waiting');
                    setError(recErr.message || 'Failed to reconstruct account from shares.');
                }
            }
        } catch (e: any) {
            console.warn('[recovery poll error]', e.message);
        } finally {
            isPollingRef.current = false;
        }
    };

    const handleCancel = () => {
        Alert.alert(
            'Cancel Recovery?',
            'Are you sure you want to cancel? This will stop waiting for friend approvals on this device.',
            [
                { text: 'Keep Waiting', style: 'cancel' },
                {
                    text: 'Yes, Cancel',
                    style: 'destructive',
                    onPress: async () => {
                        setCollectionId(null);
                        setEphIdentity(null);
                        setIsReconstructing(false);
                        setStep('lookup');
                        router.replace('/welcome');
                    }
                }
            ]
        );
    };

    useEffect(() => {
        let interval: any;
        if (step === 'waiting') {
            interval = setInterval(pollStatus, 4000);
            pollStatus();
        }
        return () => clearInterval(interval);
    }, [step, collectionId, ephIdentity, isReconstructing]);

    return (
        <SafeAreaView style={styles.container}>
            <StatusBar style="dark" />
            <KeyboardAvoidingView
                behavior="padding"
                style={{ flex: 1 }}
            >
                <ScrollView contentContainerStyle={styles.scroll}>
                    <View style={styles.card}>
                    {step === 'lookup' && (
                        <>
                            <Text style={styles.title}>🛡️ Social Recovery</Text>
                            <Text style={styles.subtitle}>Enter your old callsign and your community node. We'll look up your account so your Guardians can approve the transfer to this device.</Text>
                            <TextInput
                                accessibilityLabel="Your old callsign"
                                style={styles.input}
                                placeholder="Your old callsign"
                                placeholderTextColor={colors.text.muted}
                                value={callsign}
                                onChangeText={setCallsign}
                                autoCapitalize="none"
                            />
                            <TextInput
                                accessibilityLabel="Community Node URL"
                                style={styles.input}
                                placeholder="Community Node URL (e.g. node.yourcommunity.org)"
                                placeholderTextColor={colors.text.muted}
                                value={anchorUrl}
                                onChangeText={setAnchorUrl}
                                autoCapitalize="none"
                                autoCorrect={false}
                                keyboardType="url"
                            />
                            <Text style={styles.fieldHint}>
                                Required — the community node that holds your account. Ask whoever invited you if you're unsure.
                            </Text>
                            {error && <Text style={styles.error}>{error}</Text>}
                            <Pressable style={styles.primaryBtn} onPress={handleLookup} disabled={loading} accessibilityRole="button">
                                {loading ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.primaryBtnText}>Find Account</Text>}
                            </Pressable>
                             <Pressable style={styles.backBtn} onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/welcome'); }} accessibilityRole="button">
                                 <Text style={styles.backBtnText}>← Cancel</Text>
                             </Pressable>
                        </>
                    )}

                    {step === 'select' && (
                        <>
                            <Text style={styles.title}>Who are you?</Text>
                            <Text style={styles.subtitle}>Select your profile from the results below.</Text>
                            {lookupResults.map(p => (
                                <Pressable key={p.publicKey} style={styles.profileBtn} onPress={() => handleSelect(p)} accessibilityRole="button">
                                    <View style={styles.avatar}>
                                        <MemberAvatar avatarUrl={p.avatarUrl} pubkey={p.publicKey} callsign={p.callsign || '?'} size={44} />
                                    </View>
                                    <View style={{ flex: 1, minWidth: 0 }}>
                                        <Text style={styles.callsign} numberOfLines={1}>{p.callsign}</Text>
                                        <Text style={styles.joinedAt} numberOfLines={1}>Joined {new Date(p.joinedAt).toLocaleDateString()}</Text>
                                    </View>
                                </Pressable>
                            ))}
                            <Pressable style={styles.backBtn} onPress={() => setStep('lookup')} accessibilityRole="button">
                                <Text style={styles.backBtnText}>← Back</Text>
                            </Pressable>
                        </>
                    )}

                    {step === 'pin' && (
                        <>
                            <Text style={styles.title} accessibilityRole="header">🔢 Recovery PIN</Text>
                            <Text style={styles.subtitle}>
                                If you set a 6-digit Recovery PIN, enter it below to verify your account. If you don't have a PIN or forgot it, tap 'Skip PIN' — forgetting your PIN never locks you out.
                            </Text>

                            <TextInput
                                accessibilityLabel="6 digit recovery PIN"
                                style={styles.pinInput}
                                placeholder="••••••"
                                placeholderTextColor={colors.text.muted}
                                value={pin}
                                onChangeText={(text) => {
                                    const clean = text.replace(/[^0-9]/g, '').slice(0, 6);
                                    setPin(clean);
                                    setError(null);
                                }}
                                keyboardType="number-pad"
                                maxLength={6}
                                secureTextEntry={true}
                                autoFocus={true}
                                autoComplete="off"
                                textContentType="oneTimeCode"
                                editable={!loading}
                            />

                            {error && <Text style={styles.error} accessibilityLiveRegion="assertive">{error}</Text>}

                            <Pressable
                                style={[styles.primaryBtn, (loading || pin.length !== 6) && { opacity: 0.5 }]}
                                onPress={handleVerifyPin}
                                disabled={loading || pin.length !== 6}
                                accessibilityRole="button"
                                accessibilityState={{ disabled: loading || pin.length !== 6 }}
                            >
                                {loading ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.primaryBtnText}>Verify PIN</Text>}
                            </Pressable>

                            <Pressable
                                style={styles.secondaryBtn}
                                onPress={handleSkipPin}
                                disabled={loading}
                                accessibilityRole="button"
                            >
                                <Text style={styles.secondaryBtnText}>Skip PIN / I Don't Have One</Text>
                            </Pressable>

                            <Pressable style={styles.backBtn} onPress={() => setStep('select')} accessibilityRole="button">
                                <Text style={styles.backBtnText}>← Back</Text>
                            </Pressable>
                        </>
                    )}

                    {step === 'waiting' && (
                        <View style={{ alignItems: 'center' }}>
                            <Text style={styles.title}>👥 Ask Your Friends</Text>
                            <Text style={styles.subtitle}>
                                Contact 2 of your trusted friends by phone or in person. Ask them to open BeanPool and approve your recovery request in Settings.
                            </Text>
                            
                            <View
                                style={styles.statusBox}
                                accessibilityRole="summary"
                                accessibilityLiveRegion="polite"
                                accessibilityLabel={`Pieces collected: ${progress.collected} of ${progress.threshold}. ${progress.hubAvailable ? 'Community hub piece unlocked' : 'Waiting for first friend approval to unlock hub'}`}
                            >
                                <Text style={styles.statusLabel}>Pieces Collected</Text>
                                <Text style={styles.statusValue}>{progress.collected} / {progress.threshold}</Text>
                                <Text style={[styles.fieldHint, { marginTop: 8, marginBottom: 0 }]}>
                                    {progress.hubAvailable ? '✅ Community hub piece unlocked' : '⏳ Waiting for 1st friend approval to unlock hub'}
                                </Text>
                            </View>

                            {error ? <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">{error}</Text> : null}

                            <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 12 }}>
                                <ActivityIndicator size="small" color={colors.brand.primary} style={{ marginRight: 8 }} />
                                <Text style={{ color: colors.text.secondary, fontSize: 13 }}>Listening for approvals in real-time...</Text>
                            </View>

                            <Pressable style={styles.backBtn} onPress={handleCancel} accessibilityRole="button">
                                <Text style={[styles.backBtnText, { color: colors.feedback.danger.solid }]}>Cancel Recovery</Text>
                            </Pressable>
                        </View>
                    )}

                    {step === 'reconstructing' && (
                        <View style={{ alignItems: 'center', paddingVertical: 24 }}>
                            <ActivityIndicator size="large" color={colors.brand.primary} />
                            <Text style={[styles.title, { marginTop: 16 }]}>🔐 Restoring Your Account</Text>
                            <Text style={styles.subtitle}>
                                Unwrapping cryptographic pieces and restoring your original identity keypair...
                            </Text>
                        </View>
                    )}
                </View>
            </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface.app },
    scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
    card: { width: '100%', backgroundColor: colors.surface.card, padding: 24, borderRadius: 16, borderWidth: 1, borderColor: colors.border.default, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 10, elevation: 2 },
    title: { fontSize: 20, fontWeight: 'bold', color: colors.text.heading, marginBottom: 8 },
    subtitle: { fontSize: 14, color: colors.text.secondary, marginBottom: 24, lineHeight: 20 },
    input: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong, borderRadius: 12, padding: 14, color: colors.text.heading, fontSize: 16, marginBottom: 16 },
    fieldHint: { fontSize: 13, color: colors.text.secondary, marginTop: -8, marginBottom: 16, lineHeight: 18 },
    primaryBtn: { backgroundColor: colors.brand.primary, padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 8 },
    primaryBtnText: { color: colors.text.inverse, fontSize: 16, fontWeight: 'bold' },
    backBtn: { marginTop: 16, alignItems: 'center', padding: 10 },
    backBtnText: { color: colors.text.secondary, fontSize: 14 },
    error: { color: colors.feedback.danger.solid, fontSize: 14, marginBottom: 16, textAlign: 'center' },

    pinInput: {
        backgroundColor: colors.surface.card,
        borderWidth: 1,
        borderColor: colors.border.strong,
        borderRadius: 12,
        paddingHorizontal: 20,
        paddingVertical: 14,
        fontSize: 24,
        letterSpacing: 12,
        textAlign: 'center',
        color: colors.text.heading,
        marginBottom: 16,
        alignSelf: 'center',
        width: 220,
    },
    secondaryBtn: {
        backgroundColor: colors.surface.subtle,
        borderWidth: 1,
        borderColor: colors.border.default,
        padding: 14,
        borderRadius: 12,
        alignItems: 'center',
        marginTop: 10,
    },
    secondaryBtnText: {
        color: colors.text.body,
        fontSize: 14,
        fontWeight: '600',
    },

    profileBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface.subtle, padding: 12, borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: colors.border.default },
    avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface.subtle, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
    callsign: { color: colors.text.heading, fontSize: 16, fontWeight: '600' },
    joinedAt: { color: colors.text.secondary, fontSize: 12, marginTop: 4 },

    statusBox: { backgroundColor: colors.surface.subtle, padding: 24, borderRadius: 16, alignItems: 'center', marginBottom: 24, width: '100%' },
    statusLabel: { color: colors.text.secondary, fontSize: 14, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
    statusValue: { color: colors.brand.primary, fontSize: 36, fontWeight: '800' },

    infoBanner: { backgroundColor: colors.feedback.success.bg, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: colors.feedback.success.border, marginBottom: 24 },
    infoText: { color: colors.feedback.success.fg, fontSize: 14, lineHeight: 20 }
});
