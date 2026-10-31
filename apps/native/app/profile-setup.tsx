import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, SafeAreaView, ScrollView, ActivityIndicator } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router, useLocalSearchParams, ErrorBoundary } from 'expo-router';

export { ErrorBoundary };
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useIdentity } from './IdentityContext';
import { AvatarPickerSheet } from '../components/AvatarPickerSheet';
import { OnboardingGuide } from '../components/OnboardingGuide';
import { useNodeProfile } from '../utils/use-node-profile';
import { beansOn } from '../utils/node-profile';
import { howItWorksSubtitle } from '../utils/beans-off';
import { updateCallsign } from '../utils/identity';
import { updateMemberProfile, getMemberProfile } from '../utils/db';
import { explicitEditAvatar, resolveProfilePublishAvatar, retireParkedPickAfterPublish, type ProfilePublishAvatar } from '../utils/avatar-value';
import { keepPendingProfileChange, nameRefusedForGood, pendingNameAccepted, pendingNameRefused, pendingProfileChange } from '../utils/pending-profile-sync';
import { buildSignedHeaders } from '../utils/crypto';
import { MemberAvatar } from '../components/MemberAvatar';
import { checkCallsignAvailable, suggestCallsigns, type CallsignStatus } from '../utils/callsign-suggest';
import { ownRowOf } from '../utils/own-profile-anchor';
import { palette, type AppColors } from '../constants/colors';
import { useOnboardingColors } from './ThemeContext';
import { AreaPicker } from '../components/AreaPicker';
import { profileSteps, rememberAreaPlace, type ProfileStep } from '../utils/member-area';
import { t } from '@beanpool/core';

type Step = ProfileStep;

/**
 * Re-runnable profile setup. The 12-word key is the identity; this is where the
 * profile that travels with it — name and photo (mandatory), and later bio /
 * contact / visibility (optional) — gets filled in. Reached from Settings and
 * from the "finish your profile" gates on posting/accepting. It edits the
 * EXISTING identity; it never creates a key or touches invites.
 */
export default function ProfileSetupScreen() {
    // Follows light/dark like the rest of the app; light draws exactly as before (utils/onboarding-colors.ts).
    const { colors, dark } = useOnboardingColors();
    const styles = useMemo(() => makeStyles(colors, dark), [colors, dark]);
    const { identity, setIdentity } = useIdentity();
    // When launched as the wizard-on-join, `redirect` says where to land after
    // finishing (or cancelling) — the member has already joined, so there's no
    // sensible screen to router.back() to. Absent (Settings / gate launches) we
    // just pop back to wherever we came from. `name`: the name the global community's door has just checked and
    // joined with (app/join-global.tsx), so the steps start from it rather than from the phone's own, and at the photo:
    // the name step has just been done there.
    const params = useLocalSearchParams<{ redirect?: string; name?: string }>();
    const joinedAs = typeof params.name === 'string' && params.name.trim().length >= 2 ? params.name.trim() : null;
    const leaveWizard = () => {
        if (params.redirect) router.replace(params.redirect as any);
        else router.back();
    };

    const [step, setStep] = useState<Step>('name');
    // The guide step: on a community with Beans off (the worldwide one) it says so, in place of the cards about Beans.
    const nodeProfile = useNodeProfile();
    // On a community that syncs listings by area (the worldwide one), "Roughly where are you?" comes after the photo
    // (utils/member-area.ts); a local community's wizard is unchanged.
    const stepOrder = profileSteps(nodeProfile?.features);
    const [anchorUrl, setAnchorUrl] = useState<string | null>(null);
    useEffect(() => {
        AsyncStorage.getItem('beanpool_anchor_url').then(setAnchorUrl).catch(() => setAnchorUrl(null));
    }, []);
    // The name the steps start from is this community's own (read from its members row below), never the phone's:
    // `identity.callsign` is only the join pre-fill, and is whatever name the member last chose in ANY community
    // (Profile S2). Until the row is read the box is empty, or holds the name the door joined with.
    const [callsign, setCallsign] = useState(joinedAs ?? '');
    // What the name steps started from, once read; Done tells a name the member gave here from one the wizard only showed.
    const nameStartedWith = useRef<string | null>(null);
    // Two separate things, deliberately not one `avatar` state:
    //  - `pendingAvatar`  the photo picked in THIS session, and the only thing an explicit edit
    //                     may publish;
    //  - `nodeAvatar`     what this community holds for us, read from the synced `members` row (since
    //                     #725 that is the node's own `/api/avatar/<pk>?size=thumb` URL, and
    //                     null when the node has no photo).
    // The phone's copy of the last photo chosen in ANY community is neither shown nor sent here (Profile S2):
    // it was previewed as if it were this community's and then published, so a picture chosen in one community
    // became the picture in the next. A fresh community shows no photo until one is chosen, and the wizard asks.
    const [pendingAvatar, setPendingAvatar] = useState<string | null>(null);
    const [nodeAvatar, setNodeAvatar] = useState<string | null>(null);
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
            let member: any = null;
            try {
                member = (await getMemberProfile(identity.publicKey)) ?? null;
            } catch { member = null; }
            if (cancelled) return;
            const row: string | null = member?.avatar_url ?? null;
            setNodeAvatar(row && row !== 'null' && row !== 'undefined' && row.trim() !== '' ? row : null);
            const haveAvatar = Boolean(row);
            // The name this community holds for the member; only where it holds none yet (no row, or one without a name)
            // does the phone's pre-fill stand in, as it does on the join form.
            const communityName = ownRowOf(member)?.callsign?.trim() ?? '';
            const seed = joinedAs ?? (communityName.length >= 2 ? communityName : (identity.callsign?.trim() ?? ''));
            if (nameStartedWith.current === null) {
                nameStartedWith.current = seed;
                // A name typed while the row was being read is the member's, and stays.
                setCallsign(typed => (typed.trim() === '' ? seed : typed));
            }
            const nameOk = seed.length >= 2;
            if (joinedAs || (nameOk && !haveAvatar)) setStep('avatar');
        })();
        return () => { cancelled = true; };
    }, [identity]);

    const nameOk = callsign.trim().length >= 2;
    const stepIndex = stepOrder.indexOf(step);
    const nextStep = () => { setError(null); setStep(stepOrder[stepIndex + 1] ?? 'guide'); };

    // What the wizard SHOWS: this session's pick, else this community's current photo. It is also what
    // "do you have an avatar yet?" means for the Next button, so someone whose photo is already on the
    // node is not forced to re-pick one to get through a step they only opened to change their name.
    const displayAvatar = pendingAvatar ?? nodeAvatar;

    // Live per-node availability check while editing the name (debounced). Runs only
    // on the name step. 'unknown' (node unreachable) never blocks — the server still
    // enforces uniqueness at publish and we handle its 409 in handleFinish.
    useEffect(() => {
        if (step !== 'name') return;
        const c = callsign.trim();
        if (c.length < 2) { setNameStatus('too_short'); setSuggestions([]); return; }
        let cancelled = false;
        setNameStatus('checking');
        const timer = setTimeout(async () => {
            // Signed by the member's key, so their own current name reads as theirs (the node takes it from the signature).
            const signer = identity ?? undefined;
            const status = await checkCallsignAvailable(c, undefined, { signer });
            if (cancelled) return;
            setNameStatus(status);
            if (status === 'taken') {
                const sugg = await suggestCallsigns(c, 3, undefined, undefined, { signer });
                if (!cancelled) setSuggestions(sugg);
            } else {
                setSuggestions([]);
            }
        }, 400);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [callsign, identity?.publicKey, step]);

    // Block "Next" on a taken/too-short/checking name; allow 'available' and also
    // 'unknown' (offline) so an unreachable node never traps the user.
    const canProceedName = nameOk && (nameStatus === 'available' || nameStatus === 'unknown');

    const goBackStep = () => {
        if (stepIndex <= 0) { router.back(); return; }
        setError(null);
        setStep(stepOrder[stepIndex - 1]);
    };

    async function handleFinish() {
        if (!identity || !nameOk || !displayAvatar) return;
        setLoading(true);
        setError(null);
        const finalCallsign = callsign.trim();
        // A name goes to the community, and into the phone's pre-fill, only when the member gave it: typed here, or at the
        // door that sent them. The name the wizard merely showed (this community's own, or the pre-fill where it holds none)
        // is left alone, so it cannot rename them here, clash, or carry a name chosen in one community into the next.
        const nameGiven = finalCallsign !== (nameStartedWith.current ?? joinedAs ?? '');
        const nameKept = nameGiven || joinedAs !== null;
        // The name this publish carries: the one given here, else one an earlier offline save is still holding for this
        // community. That save's retry is disarmed by a publish that carries it (retireParkedPickAfterPublish clears the
        // whole waiting change), so a publish that left it out would lose it.
        let sentName: string | null = nameGiven ? finalCallsign : null;
        try {
            // 1. Publish to the node FIRST. Committing the name locally before the
            //    server accepts it risks a local/server split if the name was taken
            //    between the live check and now — so a 409 sends the user back to the
            //    name step (where the effect re-checks and offers fresh suggestions)
            //    without touching local state.
            let published = false;
            // Kept in scope for the same reason as in settings Save: the pending keys may only be
            // retired on the strength of what the payload actually carried.
            let avatarDecision: ProfilePublishAvatar | null = null;
            // The community this wizard publishes to, and keeps an unsent change for (utils/pending-profile-sync.ts).
            let url: string | null = null;
            try {
                url = await AsyncStorage.getItem('beanpool_anchor_url');
                if (url) {
                    const pending = await pendingProfileChange(url, identity.publicKey);
                    if (!sentName && pending?.callsign) sentName = pending.callsign;
                    // The one shared rule, as in settings Save. `avatar` goes when the member
                    // picked one here, or when an earlier offline save parked a pick that nothing
                    // has published yet, or when this community's row still holds a portable pick
                    // that never reached it. Omitting it is how the node is told "avatar unchanged";
                    // sending what the wizard merely displayed is what put an older photo back.
                    avatarDecision = await resolveProfilePublishAvatar({
                        sessionPick: pendingAvatar,
                        parked: pending?.avatar,
                        catchUp: { localRow: nodeAvatar },
                    });
                    const publishAvatar = avatarDecision.avatar;
                    const bodyString = JSON.stringify({
                        publicKey: identity.publicKey,
                        ...(publishAvatar ? { avatar: publishAvatar } : {}),
                        ...(sentName ? { callsign: sentName } : {}),
                    });
                    const headers = await buildSignedHeaders('POST', `${url}/api/profile/update`, bodyString, identity.privateKey, identity.publicKey);
                    const res = await fetch(`${url}/api/profile/update`, { method: 'POST', headers, body: bodyString });
                    if (res.status === 409) {
                        const answer = await res.json().catch(() => null);
                        const serverMsg = answer?.message;
                        if (pending && sentName !== undefined && sentName === pending.callsign && nameRefusedForGood(res.status, answer?.error)) {
                            await pendingNameRefused(url, pending, sentName);
                        }
                        setStep('name');
                        setError(serverMsg || t('That name was just taken — please pick another.'));
                        return; // finally clears loading; name-step effect refreshes suggestions
                    }
                    published = res.ok;
                }
            } catch {
                published = false; // offline — commit locally and heal on next sync
            }

            // 2. Server accepted (or we're offline): commit the name to the stored
            //    identity and the local SQLite profile.
            if (nameKept && finalCallsign !== identity.callsign) {
                const updated = await updateCallsign(finalCallsign);
                if (updated) setIdentity(updated);
            }
            // The name this community's row is given back. One that was sent is the community's now. With none sent, the row
            // keeps the name it holds AT THIS MOMENT: the first members sync of a community just joined can land while the
            // member is on the other steps (the node may have registered "Rosa 2" for a join clash), after the wizard was
            // seeded from the pre-fill, and writing the name it merely showed would put the other community's name over it.
            // Only a community that holds none yet takes the shown name (callsign is NOT NULL); its first sync replaces it.
            const rowName = sentName ?? ownRowOf(await getMemberProfile(identity.publicKey))?.callsign ?? finalCallsign;
            await updateMemberProfile(identity.publicKey, {
                callsign: rowName,
                // Only a pick from this session is written back to the members row; `undefined`
                // is COALESCEd away and leaves the synced value alone.
                avatar_url: pendingAvatar ?? undefined,
            });

            if (published) {
                // Only what this payload carried is retired. A wizard run that published no
                // photo — the node already holds one, so the rule correctly inferred nothing —
                // used to clear a parked pick that had reached nothing, and the member's photo
                // was then lost with no retry armed to resend it.
                // The name this payload carried is no longer waiting there; one it did not carry still is.
                if (sentName) await pendingNameAccepted(url);
                if (avatarDecision) await retireParkedPickAfterPublish(avatarDecision, url);
            } else {
                // As in the settings Save: kept for this community, never for the phone, with the
                // name and the pick in it so a members sync overwriting the local row with the
                // node's before the retry lands cannot silently drop what the member chose here.
                const offlinePick = explicitEditAvatar(pendingAvatar);
                if (sentName || offlinePick) await keepPendingProfileChange(url, identity.publicKey, { callsign: sentName ?? undefined, avatar: offlinePick });
            }

            leaveWizard();
        } catch (err: any) {
            setError(err?.message || t('Could not save your profile. Try again.'));
        } finally {
            setLoading(false);
        }
    }

    return (
        <SafeAreaView style={styles.container}>
            <StatusBar style={dark ? 'light' : 'dark'} />
            <ScrollView contentContainerStyle={styles.scroll}>
                {/* Step indicator */}
                <View style={styles.steps}>
                    {stepOrder.map((s, i) => (
                        <View key={s} style={[styles.stepDot, i <= stepIndex && styles.stepDotActive]} />
                    ))}
                    <Text style={styles.stepLabel}>{t('Step {n} of {total}', { n: stepIndex + 1, total: stepOrder.length })}</Text>
                </View>

                <View style={styles.card}>
                    {step === 'name' && (
                        <>
                            <Text style={styles.title}>{t('👋 Your name')}</Text>
                            <Text style={styles.subtitle}>
                                {t('This is how neighbours will know you. You can change it any time.')}
                            </Text>
                            <TextInput
                                accessibilityLabel={t('Your callsign')}
                                style={styles.input}
                                placeholder={t('Your name (e.g. Sally)')}
                                placeholderTextColor={colors.text.muted}
                                value={callsign}
                                onChangeText={setCallsign}
                                maxLength={32}
                                autoCapitalize="words"
                            />
                            {nameOk && nameStatus === 'checking' && (
                                <Text style={styles.hintMuted}>{t('Checking availability…')}</Text>
                            )}
                            {nameOk && nameStatus === 'available' && (
                                <Text style={styles.hintOk}>{t('✓ Available on this community')}</Text>
                            )}
                            {nameOk && nameStatus === 'unknown' && (
                                <Text style={styles.hintMuted}>{t("Couldn't check right now — you can still continue.")}</Text>
                            )}
                            {nameOk && nameStatus === 'taken' && (
                                <>
                                    <Text style={styles.hintTaken}>
                                        {t("✗ That name's taken here. Pick one of these, or edit your own:")}
                                    </Text>
                                    {suggestions.length > 0 && (
                                        <View style={styles.suggestRow}>
                                            {suggestions.map((s) => (
                                                <Pressable
                                                    key={s}
                                                    style={styles.suggestChip}
                                                    onPress={() => { setError(null); setCallsign(s); }}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={t('Use the name {name}', { name: s })}
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
                                <Text style={styles.primaryBtnText}>{t('Next →')}</Text>
                            </Pressable>
                            <Pressable style={styles.backBtn} onPress={leaveWizard} accessibilityRole="button" accessibilityLabel={t('Cancel')}>
                                <Text style={styles.backBtnText}>{t('Cancel')}</Text>
                            </Pressable>
                        </>
                    )}

                    {step === 'avatar' && (
                        <>
                            <Text style={styles.title}>{t('📸 Choose your look')}</Text>
                            <Text style={styles.subtitle}>
                                {t('Add a photo, or pick a fun avatar — whatever feels like you.')}
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
                                    {displayAvatar ? t('Change Photo or Avatar') : t('Choose Photo or Avatar')}
                                </Text>
                            </Pressable>
                            {error && <Text style={styles.error}>{error}</Text>}
                            <Pressable
                                style={[styles.primaryBtn, !displayAvatar && styles.disabledBtn]}
                                disabled={!displayAvatar}
                                onPress={nextStep}
                                accessibilityRole="button"
                            >
                                <Text style={styles.primaryBtnText}>{t('Next →')}</Text>
                            </Pressable>
                            <Pressable style={styles.backBtn} onPress={goBackStep} accessibilityRole="button" accessibilityLabel={t('Back')}>
                                <Text style={styles.backBtnText}>{t('← Back')}</Text>
                            </Pressable>
                        </>
                    )}

                    {step === 'area' && (
                        <>
                            <AreaPicker
                                url={anchorUrl}
                                identity={identity}
                                features={nodeProfile?.features}
                                onSaved={(_area, placeName) => {
                                    if (anchorUrl) void rememberAreaPlace(anchorUrl, placeName);
                                    nextStep();
                                }}
                                onSkip={nextStep}
                            />
                            <Pressable style={styles.backBtn} onPress={goBackStep} accessibilityRole="button" accessibilityLabel={t('Back')}>
                                <Text style={styles.backBtnText}>{t('← Back')}</Text>
                            </Pressable>
                        </>
                    )}

                    {step === 'guide' && (
                        <>
                            <Text style={styles.title}>{t('🫘 How BeanPool works')}</Text>
                            <Text style={styles.subtitle}>{howItWorksSubtitle(nodeProfile?.features)}</Text>
                            <OnboardingGuide beansOn={beansOn(nodeProfile?.features)} />
                            {error && <Text style={styles.error}>{error}</Text>}
                            <Pressable
                                style={[styles.primaryBtn, loading && styles.disabledBtn]}
                                disabled={loading}
                                onPress={handleFinish}
                                accessibilityRole="button"
                                accessibilityLabel={loading ? t('Saving profile...') : t('Done')}
                                accessibilityState={{ disabled: loading, busy: loading }}
                            >
                                {loading ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={styles.primaryBtnText}>{t('Done ✓')}</Text>}
                            </Pressable>
                            <Pressable style={styles.backBtn} onPress={goBackStep} disabled={loading} accessibilityRole="button" accessibilityLabel={t('Back')}>
                                <Text style={styles.backBtnText}>{t('← Back')}</Text>
                            </Pressable>
                        </>
                    )}
                </View>
            </ScrollView>

            <AvatarPickerSheet
                visible={showAvatarPicker}
                colors={dark ? colors : undefined}
                onClose={() => setShowAvatarPicker(false)}
                onSelectImage={(uri) => setPendingAvatar(uri)}
            />
        </SafeAreaView>
    );
}

function makeStyles(colors: AppColors, dark: boolean) {
return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface.page },
    scroll: { padding: 20, paddingBottom: 48 },
    steps: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
    stepDot: { width: 26, height: 4, borderRadius: 2, backgroundColor: colors.border.strong, marginRight: 6 },
    stepDotActive: { backgroundColor: palette.blue600 },
    // Shrinks beside the dots, so a longer language's "Step 2 of 4" wraps rather than running off the edge.
    stepLabel: { marginLeft: 6, fontSize: 12, color: colors.text.secondary, flexShrink: 1 },
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
    error: { color: colors.feedback.danger.fg, fontSize: 13, marginBottom: 12, textAlign: 'center' },
    // Name-step availability hints
    hintMuted: { color: colors.text.secondary, fontSize: 13, marginTop: -8, marginBottom: 12 },
    hintOk: { color: dark ? palette.emerald400 : (palette.green700 || '#15803d'), fontSize: 13, fontWeight: '600', marginTop: -8, marginBottom: 12 },
    hintTaken: { color: colors.feedback.danger.fg, fontSize: 13, fontWeight: '600', marginTop: -8, marginBottom: 10 },
    suggestRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12 },
    suggestChip: {
        backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.strong,
        borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, marginRight: 8, marginBottom: 8,
    },
    suggestChipText: { color: colors.text.body, fontSize: 14, fontWeight: '600' },
});
}
