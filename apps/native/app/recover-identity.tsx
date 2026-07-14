import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, Pressable, ActivityIndicator, SafeAreaView, ScrollView, Image, Alert } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { MemberAvatar } from '../components/MemberAvatar';
import { lookupRecoveryCallsign, createRecoveryRequest, getRecoveryStatus } from '../utils/db';
import { createIdentity, wipeIdentity } from '../utils/identity';
import { colors, palette } from '../constants/colors';
import { useIdentity } from './IdentityContext';

export default function RecoverIdentityScreen() {
    const { identity, setIdentity } = useIdentity();
    const [step, setStep] = useState<'lookup' | 'select' | 'guess' | 'creating' | 'waiting'>('lookup');
    const [callsign, setCallsign] = useState('');
    const [lookupResults, setLookupResults] = useState<any[]>([]);
    const [selectedProfile, setSelectedProfile] = useState<any>(null);
    const [guardianGuess, setGuardianGuess] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    
    // Status tracking
    const [statusData, setStatusData] = useState<any>(null);

    useEffect(() => {
        if (identity?.publicKey) {
            getRecoveryStatus(identity.publicKey).then((st) => {
                if (st && (st.status === 'pending' || st.status === 'approved')) {
                    setStatusData({ ...st, newPubkey: identity.publicKey });
                    setStep('waiting');
                }
            }).catch(console.warn);
        }
    }, [identity]);

    const handleLookup = async () => {
        if (!callsign.trim()) return;
        setLoading(true);
        setError(null);
        try {
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
        setStep('guess');
    };

    const handleSubmit = async () => {
        if (!guardianGuess.trim()) return;
        setLoading(true);
        setError(null);
        try {
            // 1. Generate new identity locally (which also saves it)
            const newId = await createIdentity(selectedProfile.callsign);

            // Guardian recovery supersedes any half-finished join wizard on this
            // device — drop the rescue record so the gatekeeper doesn't bounce
            // this user back into onboarding while they wait for approval.
            const { clearPendingOnboarding } = await import('../utils/onboarding-state');
            await clearPendingOnboarding();

            // Update global identity context immediately so node status and layouts align
            setIdentity(newId);
            
            // 2. Submit the request
            const req = await createRecoveryRequest(selectedProfile.publicKey, guardianGuess.trim(), newId);
            
            setStatusData(req);
            setStep('waiting');
        } catch (e: any) {
            setError(e.message || 'Failed to submit recovery request.');
        } finally {
            setLoading(false);
        }
    };

    const checkStatus = async () => {
        const pubkey = statusData?.newPubkey || identity?.publicKey;
        if (!pubkey) return;
        try {
            const st = await getRecoveryStatus(pubkey);
            if (st && st.status !== 'none') {
                setStatusData({ ...st, newPubkey: pubkey });
                if (st.status === 'executed') {
                    // Force app reload to main UI
                    router.replace('/(tabs)');
                }
            }
        } catch (e) {}
    };

    const handleCancel = () => {
        Alert.alert(
            'Cancel Recovery?',
            'Are you sure you want to cancel? This will wipe the pending recovery state from this device and let you create or recover another identity.',
            [
                { text: 'No, Keep Waiting', style: 'cancel' },
                {
                    text: 'Yes, Cancel',
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            await wipeIdentity();
                            setIdentity(null);
                            setStatusData(null);
                            setStep('lookup');
                            router.replace('/welcome');
                        } catch (e: any) {
                            Alert.alert('Error', e.message || 'Failed to wipe identity');
                        }
                    }
                }
            ]
        );
    };

    useEffect(() => {
        let interval: any;
        if (step === 'waiting') {
            interval = setInterval(checkStatus, 5000);
        }
        return () => clearInterval(interval);
    }, [step, statusData]);

    return (
        <SafeAreaView style={styles.container}>
            <StatusBar style="light" />
            <KeyboardAvoidingView
                behavior="padding"
                style={{ flex: 1 }}
            >
                <ScrollView contentContainerStyle={styles.scroll}>
                    <View style={styles.card}>
                    {step === 'lookup' && (
                        <>
                            <Text style={styles.title}>🛡️ Social Recovery</Text>
                            <Text style={styles.subtitle}>Enter your old callsign. We will look up your account on the community node.</Text>
                            <TextInput
                                accessibilityLabel="Your old callsign"
                                style={styles.input}
                                placeholder="Your old callsign"
                                placeholderTextColor={palette.slate500}
                                value={callsign}
                                onChangeText={setCallsign}
                                autoCapitalize="none"
                            />
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

                    {step === 'guess' && (
                        <>
                            <Text style={styles.title}>Guardian Knowledge Check</Text>
                            <Text style={styles.subtitle}>To prevent spam, please enter the exact callsign of at least ONE of your Guardians.</Text>
                            <TextInput
                                accessibilityLabel="A guardian's callsign"
                                style={styles.input}
                                placeholder="A guardian's callsign"
                                placeholderTextColor={palette.slate500}
                                value={guardianGuess}
                                onChangeText={setGuardianGuess}
                                autoCapitalize="none"
                            />
                            {error && <Text style={styles.error}>{error}</Text>}
                            <Pressable style={styles.primaryBtn} onPress={handleSubmit} disabled={loading} accessibilityRole="button">
                                {loading ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.primaryBtnText}>Submit Request</Text>}
                            </Pressable>
                            <Pressable style={styles.backBtn} onPress={() => setStep('select')} accessibilityRole="button">
                                <Text style={styles.backBtnText}>← Back</Text>
                            </Pressable>
                        </>
                    )}

                    {step === 'waiting' && statusData && (
                        <View style={{ alignItems: 'center' }}>
                            <Text style={styles.title}>⏳ Waiting for Guardians</Text>
                            <Text style={styles.subtitle}>Your request has been submitted! It will expire in 24 hours. Please contact your guardians directly and ask them to approve your request under Settings → Recovery Requests.</Text>
                            
                            <View style={styles.statusBox}>
                                <Text style={styles.statusLabel}>Approvals</Text>
                                <Text style={styles.statusValue}>{statusData.approvals || 0} / {statusData.quorumRequired}</Text>
                            </View>

                            {statusData.status === 'approved' && statusData.cooldownUntil && (
                                <View style={styles.infoBanner}>
                                    <Text style={styles.infoText}>
                                        ✅ Quorum reached! Your identity will automatically migrate after the 24-hour security cooldown.
                                    </Text>
                                    <Text style={[styles.infoText, {marginTop: 8, fontWeight: 'bold'}]}>
                                        Time remaining: {Math.max(0, Math.floor((new Date(statusData.cooldownUntil).getTime() - Date.now()) / 3600000))} hours
                                    </Text>
                                </View>
                            )}

                            <Pressable style={styles.backBtn} onPress={handleCancel} accessibilityRole="button">
                                <Text style={[styles.backBtnText, { color: colors.feedback.danger.solid }]}>Cancel Recovery & Start Fresh</Text>
                            </Pressable>
                        </View>
                    )}
                </View>
            </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: palette.neutral950 },
    scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 },
    card: { backgroundColor: palette.neutral900, padding: 24, borderRadius: 16, borderWidth: 1, borderColor: palette.neutral600 },
    title: { fontSize: 20, fontWeight: 'bold', color: colors.text.inverse, marginBottom: 8 },
    subtitle: { fontSize: 14, color: palette.slate400, marginBottom: 24, lineHeight: 20 },
    input: { backgroundColor: palette.neutral800, borderWidth: 1, borderColor: palette.neutral700, borderRadius: 12, padding: 14, color: colors.text.inverse, fontSize: 16, marginBottom: 16 },
    primaryBtn: { backgroundColor: colors.brand.primary, padding: 16, borderRadius: 12, alignItems: 'center', marginTop: 8 },
    primaryBtnText: { color: colors.text.inverse, fontSize: 16, fontWeight: 'bold' },
    backBtn: { marginTop: 16, alignItems: 'center', padding: 10 },
    backBtnText: { color: palette.slate400, fontSize: 14 },
    error: { color: colors.feedback.danger.solid, fontSize: 14, marginBottom: 16, textAlign: 'center' },
    
    profileBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: palette.neutral800, padding: 12, borderRadius: 12, marginBottom: 12, borderWidth: 1, borderColor: palette.neutral700 },
    avatar: { width: 44, height: 44, borderRadius: 22, backgroundColor: palette.neutral600, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
    callsign: { color: colors.text.inverse, fontSize: 16, fontWeight: '600' },
    joinedAt: { color: palette.slate400, fontSize: 12, marginTop: 4 },
    
    statusBox: { backgroundColor: palette.neutral800, padding: 24, borderRadius: 16, alignItems: 'center', marginBottom: 24, width: '100%' },
    statusLabel: { color: palette.slate400, fontSize: 14, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
    statusValue: { color: colors.brand.primary, fontSize: 36, fontWeight: '800' },
    
    infoBanner: { backgroundColor: colors.feedback.success.bg, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: colors.feedback.success.border, marginBottom: 24 },
    infoText: { color: palette.emerald300, fontSize: 14, lineHeight: 20 }
});
