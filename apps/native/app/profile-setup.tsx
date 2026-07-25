import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator, Image } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIdentity } from './IdentityContext';
import { AvatarPickerSheet } from '../components/AvatarPickerSheet';
import { OnboardingGuide } from '../components/OnboardingGuide';
import { updateCallsign } from '../utils/identity';
import { updateMemberProfile, getMemberProfile } from '../utils/db';
import { getCanonicalAvatar } from '../utils/canonical-profile';
import { buildSignedHeaders } from '../utils/crypto';
import { resolveBundledAvatar } from '../utils/bundled-avatars';
import { colors, palette } from '../constants/colors';

type Step = 'name' | 'avatar' | 'guide';
const STEP_ORDER: Step[] = ['name', 'avatar', 'guide'];

/**
 * Re-runnable profile setup. The 12-word key is the identity; this is where the
 * profile that travels with it — name and photo (mandatory), and later bio /
 * contact / visibility (optional) — gets filled in. Reached from Settings and
 * from the "finish your profile" gates on posting/accepting. It edits the
 * EXISTING identity; it never creates a key or touches invites.
 */
export default function ProfileSetupScreen() {
    const { identity, setIdentity } = useIdentity();

    const [step, setStep] = useState<Step>('name');
    const [callsign, setCallsign] = useState(identity?.callsign ?? '');
    const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);
    const [showAvatarPicker, setShowAvatarPicker] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Seed from the existing profile, and open at the first thing that's missing
    // so someone who only needs a photo isn't walked back through their name.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!identity) { router.back(); return; }
            let avatar: string | null = null;
            try {
                const p = await getMemberProfile(identity.publicKey);
                avatar = p?.avatar_url || (await getCanonicalAvatar());
            } catch {
                avatar = await getCanonicalAvatar();
            }
            if (cancelled) return;
            if (avatar) setPendingAvatar(avatar);
            const nameOk = (identity.callsign?.trim().length ?? 0) >= 2;
            if (nameOk && !avatar) setStep('avatar');
        })();
        return () => { cancelled = true; };
    }, [identity]);

    const nameOk = callsign.trim().length >= 2;
    const stepIndex = STEP_ORDER.indexOf(step);

    const goBackStep = () => {
        if (stepIndex <= 0) { router.back(); return; }
        setError(null);
        setStep(STEP_ORDER[stepIndex - 1]);
    };

    async function handleFinish() {
        if (!identity || !nameOk || !pendingAvatar) return;
        setLoading(true);
        setError(null);
        try {
            const finalCallsign = callsign.trim();

            // 1. Name → the stored identity (so the app reflects it immediately).
            if (finalCallsign !== identity.callsign) {
                const updated = await updateCallsign(finalCallsign);
                if (updated) setIdentity(updated);
            }

            // 2. Name + avatar → local SQLite profile.
            await updateMemberProfile(identity.publicKey, {
                callsign: finalCallsign,
                avatar_url: pendingAvatar,
            });

            // 3. Publish to the node (best-effort; heals on next sync if offline).
            try {
                const url = await AsyncStorage.getItem('beanpool_anchor_url');
                if (url) {
                    const bodyString = JSON.stringify({
                        publicKey: identity.publicKey,
                        avatar: pendingAvatar,
                        callsign: finalCallsign,
                    });
                    const headers = await buildSignedHeaders('POST', '/api/profile/update', bodyString, identity.privateKey, identity.publicKey);
                    const res = await fetch(`${url}/api/profile/update`, { method: 'POST', headers, body: bodyString });
                    if (res.ok) await AsyncStorage.removeItem('pending_profile_sync');
                    else await AsyncStorage.setItem('pending_profile_sync', 'true');
                }
            } catch {
                await AsyncStorage.setItem('pending_profile_sync', 'true');
            }

            router.back();
        } catch (err: any) {
            setError(err?.message || 'Could not save your profile. Try again.');
        } finally {
            setLoading(false);
        }
    }

    return (
        <SafeAreaView style={styles.container}>
            <StatusBar style="dark" />
            <ScrollView contentContainerStyle={styles.scroll}>
                {/* Step indicator */}
                <View style={styles.steps}>
                    {STEP_ORDER.map((s, i) => (
                        <View key={s} style={[styles.stepDot, i <= stepIndex && styles.stepDotActive]} />
                    ))}
                    <Text style={styles.stepLabel}>Step {stepIndex + 1} of {STEP_ORDER.length}</Text>
                </View>

                <View style={styles.card}>
                    {step === 'name' && (
                        <>
                            <Text style={styles.title}>👋 Your name</Text>
                            <Text style={styles.subtitle}>
                                This is how neighbours will know you. You can change it any time.
                            </Text>
                            <TextInput
                                accessibilityLabel="Your callsign"
                                style={styles.input}
                                placeholder="Your name (e.g. Sally)"
                                placeholderTextColor={colors.text.muted}
                                value={callsign}
                                onChangeText={setCallsign}
                                maxLength={32}
                                autoCapitalize="words"
                            />
                            {error && <Text style={styles.error}>{error}</Text>}
                            <Pressable
                                style={[styles.primaryBtn, !nameOk && styles.disabledBtn]}
                                disabled={!nameOk}
                                onPress={() => { setError(null); setStep('avatar'); }}
                                accessibilityRole="button"
                            >
                                <Text style={styles.primaryBtnText}>Next →</Text>
                            </Pressable>
                            <Pressable style={styles.backBtn} onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Cancel">
                                <Text style={styles.backBtnText}>Cancel</Text>
                            </Pressable>
                        </>
                    )}

                    {step === 'avatar' && (
                        <>
                            <Text style={styles.title}>📸 Choose your look</Text>
                            <Text style={styles.subtitle}>
                                Add a photo, or pick a fun avatar — whatever feels like you.
                            </Text>
                            <View style={styles.previewContainer}>
                                {pendingAvatar ? (
                                    <Image
                                        source={pendingAvatar.startsWith('bundled://') ? resolveBundledAvatar(pendingAvatar)! : { uri: pendingAvatar }}
                                        style={styles.previewImage}
                                        accessibilityLabel="Your selected profile picture"
                                    />
                                ) : (
                                    <View style={styles.previewPlaceholder}>
                                        <Text style={styles.previewPlaceholderText}>
                                            {(callsign.trim()[0] || '?').toUpperCase()}
                                        </Text>
                                    </View>
                                )}
                                <Text style={styles.previewCallsign}>{callsign.trim()}</Text>
                            </View>
                            <Pressable style={styles.secondaryBtn} onPress={() => setShowAvatarPicker(true)} accessibilityRole="button">
                                <Text style={styles.secondaryBtnText}>
                                    {pendingAvatar ? 'Change Photo or Avatar' : 'Choose Photo or Avatar'}
                                </Text>
                            </Pressable>
                            {error && <Text style={styles.error}>{error}</Text>}
                            <Pressable
                                style={[styles.primaryBtn, !pendingAvatar && styles.disabledBtn]}
                                disabled={!pendingAvatar}
                                onPress={() => { setError(null); setStep('guide'); }}
                                accessibilityRole="button"
                            >
                                <Text style={styles.primaryBtnText}>Next →</Text>
                            </Pressable>
                            <Pressable style={styles.backBtn} onPress={goBackStep} accessibilityRole="button" accessibilityLabel="Back">
                                <Text style={styles.backBtnText}>← Back</Text>
                            </Pressable>
                        </>
                    )}

                    {step === 'guide' && (
                        <>
                            <Text style={styles.title}>🫘 How BeanPool works</Text>
                            <Text style={styles.subtitle}>A quick look at this community economy.</Text>
                            <OnboardingGuide />
                            {error && <Text style={styles.error}>{error}</Text>}
                            <Pressable
                                style={[styles.primaryBtn, loading && styles.disabledBtn]}
                                disabled={loading}
                                onPress={handleFinish}
                                accessibilityRole="button"
                            >
                                {loading ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.primaryBtnText}>Done ✓</Text>}
                            </Pressable>
                            <Pressable style={styles.backBtn} onPress={goBackStep} disabled={loading} accessibilityRole="button" accessibilityLabel="Back">
                                <Text style={styles.backBtnText}>← Back</Text>
                            </Pressable>
                        </>
                    )}
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

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface.app },
    scroll: { padding: 20, paddingBottom: 48 },
    steps: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
    stepDot: { width: 26, height: 4, borderRadius: 2, backgroundColor: colors.border.strong, marginRight: 6 },
    stepDotActive: { backgroundColor: palette.blue600 },
    stepLabel: { marginLeft: 6, fontSize: 12, color: colors.text.secondary },
    card: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 20 },
    title: { fontSize: 24, fontWeight: '800', color: colors.text.heading, marginBottom: 6 },
    subtitle: { fontSize: 14, color: colors.text.secondary, marginBottom: 16, lineHeight: 20 },
    input: {
        backgroundColor: colors.surface.app, borderWidth: 1, borderColor: colors.border.strong,
        borderRadius: 10, padding: 14, color: colors.text.heading, fontSize: 16, marginBottom: 16,
    },
    previewContainer: { alignItems: 'center', marginBottom: 16 },
    previewImage: { width: 96, height: 96, borderRadius: 48, backgroundColor: colors.surface.app },
    previewPlaceholder: {
        width: 96, height: 96, borderRadius: 48, backgroundColor: colors.surface.app,
        alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border.strong,
    },
    previewPlaceholderText: { fontSize: 40, fontWeight: '800', color: colors.text.secondary },
    previewCallsign: { marginTop: 8, fontSize: 16, fontWeight: '700', color: colors.text.heading },
    primaryBtn: { backgroundColor: palette.blue600, borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 4 },
    primaryBtnText: { color: colors.text.inverse, fontSize: 16, fontWeight: '700' },
    disabledBtn: { opacity: 0.5 },
    secondaryBtn: {
        backgroundColor: colors.surface.subtle, borderRadius: 12, padding: 14, alignItems: 'center',
        marginBottom: 12, borderWidth: 1, borderColor: colors.border.strong,
    },
    secondaryBtnText: { color: colors.text.body, fontSize: 15, fontWeight: '600' },
    backBtn: { padding: 12, alignItems: 'center', marginTop: 4 },
    backBtnText: { color: colors.text.secondary, fontSize: 14, fontWeight: '600' },
    error: { color: palette.red600 || '#dc2626', fontSize: 13, marginBottom: 12, textAlign: 'center' },
});
