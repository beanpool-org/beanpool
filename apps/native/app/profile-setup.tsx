import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router, useLocalSearchParams } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIdentity } from './IdentityContext';
import { AvatarPickerSheet } from '../components/AvatarPickerSheet';
import { OnboardingGuide } from '../components/OnboardingGuide';
import { updateCallsign } from '../utils/identity';
import { updateMemberProfile, getMemberProfile } from '../utils/db';
import { getCanonicalAvatar } from '../utils/canonical-profile';
import { profileSetupAvatar, explicitEditAvatar } from '../utils/avatar-value';
import { buildSignedHeaders } from '../utils/crypto';
import { MemberAvatar } from '../components/MemberAvatar';
import { checkCallsignAvailable, suggestCallsigns, type CallsignStatus } from '../utils/callsign-suggest';
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
    // When launched as the wizard-on-join, `redirect` says where to land after
    // finishing (or cancelling) — the member has already joined, so there's no
    // sensible screen to router.back() to. Absent (Settings / gate launches) we
    // just pop back to wherever we came from.
    const params = useLocalSearchParams<{ redirect?: string }>();
    const leaveWizard = () => {
        if (params.redirect) router.replace(params.redirect as any);
        else router.back();
    };

    const [step, setStep] = useState<Step>('name');
    const [callsign, setCallsign] = useState(identity?.callsign ?? '');
    // Three separate things, deliberately not one `avatar` state:
    //  - `pendingAvatar`  the photo picked in THIS session, and the only thing an explicit edit
    //                     may publish;
    //  - `nodeAvatar`     what the node holds for us, read from the synced `members` row (since
    //                     #725 that is the node's own `/api/avatar/<pk>?size=thumb` URL, and
    //                     null when the node has no photo);
    //  - `canonicalAvatar` the node-independent copy, written only by a local pick.
    // Seeding one state from canonical made Re-run Setup PREVIEW the canonical copy as if it
    // were current and then publish it — so after a photo change on the PWA or a paired device
    // (where canonical is the PREVIOUS photo) finishing the wizard silently put the old picture
    // back. Canonical is now shown, and sent, only when the node has no photo of its own.
    const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);
    const [nodeAvatar, setNodeAvatar] = useState<string | null>(null);
    const [canonicalAvatar, setCanonicalAvatar] = useState<string | null>(null);
    const [showAvatarPicker, setShowAvatarPicker] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Per-node callsign availability for the name step. 'idle' before the first
    // check, 'checking' while a lookup is in flight. Suggestions are populated only
    // when the typed name is taken.
    const [nameStatus, setNameStatus] = useState<CallsignStatus | 'checking' | 'idle'>('idle');
    const [suggestions, setSuggestions] = useState<string[]>([]);

    // Seed from the existing profile, and open at the first thing that's missing
    // so someone who only needs a photo isn't walked back through their name.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!identity) { router.back(); return; }
            let row: string | null = null;
            try {
                row = (await getMemberProfile(identity.publicKey))?.avatar_url ?? null;
            } catch { row = null; }
            const canonical = await getCanonicalAvatar().catch(() => null);
            if (cancelled) return;
            setNodeAvatar(row && row !== 'null' && row !== 'undefined' && row.trim() !== '' ? row : null);
            setCanonicalAvatar(canonical ?? null);
            const haveAvatar = Boolean(row || canonical);
            const nameOk = (identity.callsign?.trim().length ?? 0) >= 2;
            if (nameOk && !haveAvatar) setStep('avatar');
        })();
        return () => { cancelled = true; };
    }, [identity]);

    const nameOk = callsign.trim().length >= 2;
    const stepIndex = STEP_ORDER.indexOf(step);

    // What the wizard SHOWS: this session's pick, else the node's current photo, else — only
    // when the node has none — the canonical copy. It is also what "do you have an avatar yet?"
    // means for the Next button, so someone whose photo is already on the node is not forced to
    // re-pick one to get through a step they only opened to change their name.
    const displayAvatar = pendingAvatar ?? nodeAvatar ?? canonicalAvatar;

    // Live per-node availability check while editing the name (debounced). Runs only
    // on the name step. 'unknown' (node unreachable) never blocks — the server still
    // enforces uniqueness at publish and we handle its 409 in handleFinish.
    useEffect(() => {
        if (step !== 'name') return;
        const c = callsign.trim();
        if (c.length < 2) { setNameStatus('too_short'); setSuggestions([]); return; }
        let cancelled = false;
        setNameStatus('checking');
        const t = setTimeout(async () => {
            const status = await checkCallsignAvailable(c, identity?.publicKey);
            if (cancelled) return;
            setNameStatus(status);
            if (status === 'taken') {
                const sugg = await suggestCallsigns(c, identity?.publicKey);
                if (!cancelled) setSuggestions(sugg);
            } else {
                setSuggestions([]);
            }
        }, 400);
        return () => { cancelled = true; clearTimeout(t); };
    }, [callsign, identity?.publicKey, step]);

    // Block "Next" on a taken/too-short/checking name; allow 'available' and also
    // 'unknown' (offline) so an unreachable node never traps the user.
    const canProceedName = nameOk && (nameStatus === 'available' || nameStatus === 'unknown');

    const goBackStep = () => {
        if (stepIndex <= 0) { router.back(); return; }
        setError(null);
        setStep(STEP_ORDER[stepIndex - 1]);
    };

    async function handleFinish() {
        if (!identity || !nameOk || !displayAvatar) return;
        setLoading(true);
        setError(null);
        const finalCallsign = callsign.trim();
        try {
            // 1. Publish to the node FIRST. Committing the name locally before the
            //    server accepts it risks a local/server split if the name was taken
            //    between the live check and now — so a 409 sends the user back to the
            //    name step (where the effect re-checks and offers fresh suggestions)
            //    without touching local state.
            let published = false;
            try {
                const url = await AsyncStorage.getItem('beanpool_anchor_url');
                if (url) {
                    // `avatar` goes only when the member picked one here, or when the node has
                    // no photo for us and the canonical copy can therefore overwrite nothing.
                    // Omitting it is how the node is told "avatar unchanged"; sending what the
                    // wizard merely displayed is what put an older photo back.
                    const publishAvatar = profileSetupAvatar(pendingAvatar, nodeAvatar, canonicalAvatar);
                    const bodyString = JSON.stringify({
                        publicKey: identity.publicKey,
                        ...(publishAvatar ? { avatar: publishAvatar } : {}),
                        callsign: finalCallsign,
                    });
                    const headers = await buildSignedHeaders('POST', '/api/profile/update', bodyString, identity.privateKey, identity.publicKey);
                    const res = await fetch(`${url}/api/profile/update`, { method: 'POST', headers, body: bodyString });
                    if (res.status === 409) {
                        setStep('name');
                        setError('That name was just taken — please pick another.');
                        return; // finally clears loading; name-step effect refreshes suggestions
                    }
                    published = res.ok;
                }
            } catch {
                published = false; // offline — commit locally and heal on next sync
            }

            // 2. Server accepted (or we're offline): commit the name to the stored
            //    identity and the local SQLite profile.
            if (finalCallsign !== identity.callsign) {
                const updated = await updateCallsign(finalCallsign);
                if (updated) setIdentity(updated);
            }
            await updateMemberProfile(identity.publicKey, {
                callsign: finalCallsign,
                // Only a pick from this session is written back to the members row; `undefined`
                // is COALESCEd away and leaves the synced value alone.
                avatar_url: pendingAvatar ?? undefined,
            });

            if (published) {
                await AsyncStorage.removeItem('pending_profile_sync');
                await AsyncStorage.removeItem('pending_profile_avatar');
            } else {
                await AsyncStorage.setItem('pending_profile_sync', 'true');
                // As in the settings Save: the pick is parked beside the flag so a members sync
                // overwriting the local row with the node's URL before the retry lands cannot
                // silently drop the photo the member chose on this phone.
                const offlinePick = explicitEditAvatar(pendingAvatar);
                if (offlinePick) await AsyncStorage.setItem('pending_profile_avatar', offlinePick);
            }

            leaveWizard();
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
                            {nameOk && nameStatus === 'checking' && (
                                <Text style={styles.hintMuted}>Checking availability…</Text>
                            )}
                            {nameOk && nameStatus === 'available' && (
                                <Text style={styles.hintOk}>✓ Available on this community</Text>
                            )}
                            {nameOk && nameStatus === 'unknown' && (
                                <Text style={styles.hintMuted}>Couldn't check right now — you can still continue.</Text>
                            )}
                            {nameOk && nameStatus === 'taken' && (
                                <>
                                    <Text style={styles.hintTaken}>
                                        ✗ That name's taken here. Pick one of these, or edit your own:
                                    </Text>
                                    {suggestions.length > 0 && (
                                        <View style={styles.suggestRow}>
                                            {suggestions.map((s) => (
                                                <Pressable
                                                    key={s}
                                                    style={styles.suggestChip}
                                                    onPress={() => { setError(null); setCallsign(s); }}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={`Use the name ${s}`}
                                                >
                                                    <Text style={styles.suggestChipText}>{s}</Text>
                                                </Pressable>
                                            ))}
                                        </View>
                                    )}
                                </>
                            )}
                            {error && <Text style={styles.error}>{error}</Text>}
                            <Pressable
                                style={[styles.primaryBtn, !canProceedName && styles.disabledBtn]}
                                disabled={!canProceedName}
                                onPress={() => { setError(null); setStep('avatar'); }}
                                accessibilityRole="button"
                            >
                                <Text style={styles.primaryBtnText}>Next →</Text>
                            </Pressable>
                            <Pressable style={styles.backBtn} onPress={leaveWizard} accessibilityRole="button" accessibilityLabel="Cancel">
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
                                {/* Through MemberAvatar, like every other avatar in the app: it
                                    resolves the node's RELATIVE `/api/avatar/<pk>` path against
                                    the anchor, handles `data:` and `bundled://`, and draws the
                                    initial when there is no picture at all. */}
                                <MemberAvatar
                                    avatarUrl={displayAvatar}
                                    pubkey={identity?.publicKey ?? ''}
                                    callsign={callsign.trim()}
                                    size={96}
                                />
                                <Text style={styles.previewCallsign}>{callsign.trim()}</Text>
                            </View>
                            <Pressable style={styles.secondaryBtn} onPress={() => setShowAvatarPicker(true)} accessibilityRole="button">
                                <Text style={styles.secondaryBtnText}>
                                    {displayAvatar ? 'Change Photo or Avatar' : 'Choose Photo or Avatar'}
                                </Text>
                            </Pressable>
                            {error && <Text style={styles.error}>{error}</Text>}
                            <Pressable
                                style={[styles.primaryBtn, !displayAvatar && styles.disabledBtn]}
                                disabled={!displayAvatar}
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
    container: { flex: 1, backgroundColor: colors.surface.page },
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
    // Name-step availability hints
    hintMuted: { color: colors.text.secondary, fontSize: 13, marginTop: -8, marginBottom: 12 },
    hintOk: { color: palette.green700 || '#15803d', fontSize: 13, fontWeight: '600', marginTop: -8, marginBottom: 12 },
    hintTaken: { color: palette.red600 || '#dc2626', fontSize: 13, fontWeight: '600', marginTop: -8, marginBottom: 10 },
    suggestRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12 },
    suggestChip: {
        backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.strong,
        borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8, marginBottom: 8,
    },
    suggestChipText: { color: colors.text.body, fontSize: 14, fontWeight: '600' },
});
