import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform, ScrollView } from 'react-native';
import { colors as lightColors, type AppColors } from '../constants/colors';
import { GoogleButton, AppleButton, FacebookButton } from './SsoButton';
import { SsoSignInError, returnToApp } from '../utils/sso-signin';
import { SSO_PROVIDER_NAMES, type SsoProvider } from '../utils/sso-providers';
import { authenticateUser } from '../utils/LocalAuth';
import { linkSignIn, linkedNotice, type LinkAnswer } from '../utils/join-link';
import { finishOneWayBack } from '../utils/one-way-back';
import type { BeanPoolIdentity } from '../utils/identity';

/**
 * "Add a sign-in as a second way back" (two-doors design §2.5), for a member who joined the global community with 12
 * words: Safety Backup, Settings and the "one way back" card open it. One sign-in, two jobs (utils/join-link.ts): it
 * becomes a way back, and the new-account limits become the usual ones. Every refusal is a sentence; a refusal
 * changes nothing. A sheet the member closes before the provider is done links nothing.
 *
 * No KeyboardProvider here (memory `keyboard-avoidance-pattern`): there is no text field.
 */
export function LinkSignInSheet({
    visible,
    onClose,
    onLinked,
    identity,
    url,
    askPhoneLock = true,
    colors = lightColors,
}: {
    visible: boolean;
    onClose: () => void;
    /** Added (or the node says this account already has one): the card is done. */
    onLinked: (answer: Extract<LinkAnswer, { kind: 'linked' }> | null) => void;
    identity: BeanPoolIdentity | null;
    /** The global community's address. */
    url: string;
    /** The phone's lock first (Settings); false only for a key the join has just made (Safety Backup). */
    askPhoneLock?: boolean;
    colors?: AppColors;
}): React.JSX.Element {
    const [step, setStep] = useState<'choose' | 'working' | 'saving' | 'done' | 'error'>('choose');
    const [provider, setProvider] = useState<SsoProvider | null>(null);
    const [message, setMessage] = useState('');
    const [notice, setNotice] = useState<string | null>(null);
    const [linked, setLinked] = useState<Extract<LinkAnswer, { kind: 'linked' }> | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const s = styles(colors);

    useEffect(() => {
        if (visible) {
            setStep('choose');
            setMessage('');
            setNotice(null);
            setLinked(null);
        }
    }, [visible]);
    useEffect(() => () => abortRef.current?.abort(), []);

    const close = () => {
        abortRef.current?.abort();
        onClose();
    };

    async function add(chosen: SsoProvider) {
        if (!identity) return;
        setProvider(chosen);
        setStep('working');
        setMessage('');
        abortRef.current?.abort();
        const abort = new AbortController();
        abortRef.current = abort;
        try {
            const answer = await linkSignIn({
                url,
                identity,
                provider: chosen,
                phoneLock: askPhoneLock ? () => authenticateUser('Confirm authentication to add a sign-in to your account.') : null,
                onSignedIn: async () => {
                    setStep('saving');
                    await returnToApp();
                },
                onSignInAgain: setNotice,
                signal: abort.signal,
            });
            if (answer.kind === 'linked') {
                await finishOneWayBack(identity.publicKey, 'linked');
                setLinked(answer);
                setStep('done');
                return;
            }
            // The node says this account has a sign-in already: nothing more to add, and the card has no reason to stay.
            if (answer.reason === 'already_linked') {
                await finishOneWayBack(identity.publicKey, 'linked');
                onLinked(null);
            }
            setMessage(answer.message);
            setStep('error');
        } catch (e) {
            if (e instanceof SsoSignInError && e.reason === 'cancelled') {
                setStep('choose');
                return;
            }
            setMessage((e as Error)?.message || 'Your sign-in could not be added, and nothing was changed. Please try again.');
            setStep('error');
        } finally {
            setNotice(null);
        }
    }

    const name = provider ? SSO_PROVIDER_NAMES[provider] : '';
    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={step === 'saving' ? () => {} : close}>
            <View style={s.overlay}>
                <ScrollView style={s.sheetScroll} contentContainerStyle={s.sheet}>
                    {step === 'choose' && (
                        <>
                            <Text style={s.title} accessibilityRole="header">Add a sign-in as a second way back</Text>
                            <Text style={s.body}>
                                Sign in once with an account you already have. If you lose this phone, it gets you back into your
                                account, and it lifts the limits on new 12-words accounts. BeanPool never sees your password and
                                never posts anything for you.
                            </Text>
                            {Platform.OS === 'ios' && (
                                <AppleButton title="Continue with Apple" onPress={() => add('apple')} style={s.sso} />
                            )}
                            <GoogleButton title="Continue with Google" onPress={() => add('google')} style={s.sso} />
                            <FacebookButton title="Continue with Facebook" onPress={() => add('facebook')} style={s.sso} />
                            <TouchableOpacity style={s.secondary} onPress={close} accessibilityRole="button">
                                <Text style={s.secondaryText}>Not now</Text>
                            </TouchableOpacity>
                        </>
                    )}
                    {(step === 'working' || step === 'saving') && (
                        <View style={s.center} accessibilityLiveRegion="polite">
                            <ActivityIndicator size="large" color={colors.brand.primary} />
                            <Text style={s.busyText}>{notice ?? (step === 'saving' ? `Adding your ${name} sign-in…` : `Connecting with ${name}…`)}</Text>
                            {step === 'working' && (
                                <TouchableOpacity style={[s.secondary, { alignSelf: 'stretch' }]} onPress={close} accessibilityRole="button">
                                    <Text style={s.secondaryText}>Cancel</Text>
                                </TouchableOpacity>
                            )}
                        </View>
                    )}
                    {step === 'done' && linked && (
                        <>
                            <Text style={s.title} accessibilityRole="header">✅ Sign-in added</Text>
                            <Text style={s.body}>{linkedNotice(linked)}</Text>
                            <TouchableOpacity style={s.primary} onPress={() => { onLinked(linked); onClose(); }} accessibilityRole="button">
                                <Text style={s.primaryText}>Done</Text>
                            </TouchableOpacity>
                        </>
                    )}
                    {step === 'error' && (
                        <>
                            <Text style={s.title} accessibilityRole="header">Not added</Text>
                            <Text style={s.body} accessibilityRole="alert">{message}</Text>
                            <TouchableOpacity style={s.primary} onPress={() => setStep('choose')} accessibilityRole="button">
                                <Text style={s.primaryText}>Try again</Text>
                            </TouchableOpacity>
                            <TouchableOpacity style={s.secondary} onPress={close} accessibilityRole="button">
                                <Text style={s.secondaryText}>Close</Text>
                            </TouchableOpacity>
                        </>
                    )}
                </ScrollView>
            </View>
        </Modal>
    );
}

const cache = new WeakMap<AppColors, ReturnType<typeof make>>();
function styles(colors: AppColors) {
    let s = cache.get(colors);
    if (!s) {
        s = make(colors);
        cache.set(colors, s);
    }
    return s;
}

function make(colors: AppColors) {
    return StyleSheet.create({
        overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: colors.overlay.scrim },
        // Bounded and scrollable, so Cancel is reachable on a 320dp screen at 1.3x text (as SsoEnrolSheet).
        sheetScroll: { maxHeight: '90%', flexGrow: 0 },
        sheet: {
            backgroundColor: colors.surface.card, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24,
            paddingBottom: Platform.OS === 'android' ? 48 : 40,
        },
        title: { fontSize: 20, fontWeight: 'bold', color: colors.text.heading, marginBottom: 12 },
        body: { fontSize: 15, color: colors.text.body, lineHeight: 22, marginBottom: 20 },
        sso: { marginBottom: 10, width: '100%' },
        center: { alignItems: 'center', justifyContent: 'center', minHeight: 180 },
        busyText: { fontSize: 15, color: colors.text.secondary, marginTop: 14, textAlign: 'center' },
        primary: { backgroundColor: colors.brand.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginBottom: 8 },
        primaryText: { color: colors.text.inverse, fontSize: 16, fontWeight: 'bold' },
        secondary: { minHeight: 48, paddingVertical: 12, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
        secondaryText: { color: colors.text.secondary, fontSize: 16 },
    });
}
