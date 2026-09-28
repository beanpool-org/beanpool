import React, { useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform, ScrollView } from 'react-native';
import { colors } from '../constants/colors';
import { anchorUrl } from '../utils/node-post';
import { SsoSignInError, returnToApp } from '../utils/sso-signin';
import { SSO_PROVIDER_NAMES, type SsoProvider } from '../utils/sso-providers';
import type { KeeperEnrolmentResult } from '../utils/keeper-enrolment';
import { connectAndDeposit } from '../utils/sso-sheet-connect';
import { authenticateUser } from '../utils/LocalAuth';
import { signInOnOpen } from '../utils/sso-sheet-opening';
import { useIdentity } from '../app/IdentityContext';
import type { BeanPoolIdentity } from '../utils/identity';

export function SsoEnrolSheet({
    visible,
    onClose,
    onEnrolled,
    provider = Platform.OS === 'ios' ? 'apple' : 'google',
    identity: passedIdentity,
    askPhoneLock = true,
}: {
    visible: boolean;
    onClose: () => void;
    onEnrolled: (result: KeeperEnrolmentResult) => void;
    /** Which SSO provider to use. Defaults to Apple on iOS, Google elsewhere. */
    provider?: SsoProvider;
    /** Identity to use for enrolment. Defaults to useIdentity().identity if omitted. */
    identity?: BeanPoolIdentity | null;
    /**
     * Ask the phone's lock before the sign-in starts (Settings' check): linking a sign-in seals the account's key and 12
     * words to it. False only for a key the join wizard has just made, the member's own new account (welcome.tsx).
     */
    askPhoneLock?: boolean;
}): React.JSX.Element | null {
    const PROVIDER_NAME = SSO_PROVIDER_NAMES[provider];
    const { identity: contextIdentity } = useIdentity();
    const identity = passedIdentity ?? contextIdentity;
    /** `saving`: the provider is done and the deposit is going ahead, so no Cancel (utils/sso-sheet-connect.ts). */
    const [step, setStep] = useState<'processing' | 'saving' | 'success' | 'error'>('processing');
    const [errorMessage, setErrorMessage] = useState('');
    const [enrolResult, setEnrolResult] = useState<KeeperEnrolmentResult | null>(null);
    /** Closing the sheet mid-sign-in: the sign-in, once done, deposits nothing (utils/sso-sheet-connect.ts). */
    const abortRef = React.useRef<AbortController | null>(null);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            abortRef.current?.abort();
        };
    }, []);

    /**
     * Close, and stop what is running: a sign-in still going deposits nothing once it is done.
     *
     * The modal stays mounted with `visible={false}`, so unmount cleanup alone would not stop it.
     */
    const closeAndStop = React.useCallback(() => {
        abortRef.current?.abort();
        onClose();
    }, [onClose]);

    const handleConnect = async () => {
        if (!identity) {
            setErrorMessage(`You must be signed in to connect ${PROVIDER_NAME}.`);
            setStep('error');
            return;
        }

        setStep('processing');
        abortRef.current?.abort();
        const abort = new AbortController();
        abortRef.current = abort;
        try {
            const url = await anchorUrl();
            if (!url) {
                setErrorMessage('No node configured yet.');
                setStep('error');
                return;
            }

            const result = await connectAndDeposit({
                provider,
                url,
                identity,
                phoneLock: askPhoneLock ? () => authenticateUser('Confirm authentication to link a sign-in to your account.') : null,
                // The provider is done: Cancel comes down, and the deposit goes ahead.
                onSignedIn: async () => {
                    setStep('saving');
                    // Get them back here, with any sign-in page closed (iOS) or behind the app (Android).
                    await returnToApp();
                },
                signal: abort.signal,
            });

            if (result.error) {
                setErrorMessage(result.error);
                setStep('error');
            } else {
                setEnrolResult(result);
                setStep('success');
                if (timerRef.current) clearTimeout(timerRef.current);
                timerRef.current = setTimeout(() => {
                    onEnrolled(result);
                    onClose();
                }, 1000);
            }
        } catch (e) {
            console.error('[SSO Error]', e);
            if (e instanceof SsoSignInError) {
                if (e.reason === 'cancelled') {
                    onClose();
                    return;
                }
                if (e.reason === 'unsupported') {
                    setErrorMessage(`This device can't sign in with ${PROVIDER_NAME}. (${e.message})`);
                } else if (e.reason === 'no-token' || e.reason === 'provider') {
                    setErrorMessage(`${PROVIDER_NAME} sign-in failed: ${e.message}`);
                } else if (e.reason === 'nonce') {
                    setErrorMessage(`Sign-in setup failed: ${e.message}`);
                } else {
                    setErrorMessage(e.message);
                }
            } else {
                setErrorMessage((e as Error).message || 'An unknown error occurred.');
            }
            setStep('error');
        }
    };

    // Start the sign-in when the sheet opens, once (utils/sso-sheet-opening.ts). A new copy of the identity while it
    // is open, which welcome's resume effect hands over after an Android sign-in, started a second one.
    const startedThisOpening = React.useRef(false);
    React.useEffect(() => {
        const next = signInOnOpen(startedThisOpening.current, visible, !!identity);
        startedThisOpening.current = next.started;
        if (next.start) {
            setStep('processing');
            setErrorMessage('');
            setEnrolResult(null);
            handleConnect();
        }
    }, [visible, provider, identity]);

    const handleDone = () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        if (enrolResult) {
            onEnrolled(enrolResult);
        }
        onClose();
    };

    return (
        <Modal
            visible={visible}
            animationType="slide"
            transparent={true}
            onRequestClose={closeAndStop}
        >
            <View style={styles.overlay}>
                <ScrollView
                    style={styles.sheetScroll}
                    contentContainerStyle={styles.sheet}
                    keyboardShouldPersistTaps="handled"
                >
                    {step === 'processing' && (
                        <View style={styles.centerContent} accessibilityLiveRegion="polite">
                            <ActivityIndicator size="large" color={colors.brand.primary} />
                            <Text style={styles.processingText}>Connecting with {PROVIDER_NAME}...</Text>
                            <TouchableOpacity
                                style={[styles.secondaryButton, { marginTop: 24, alignSelf: 'stretch' }]}
                                onPress={closeAndStop}
                                accessibilityRole="button"
                                accessibilityLabel="Cancel connection"
                            >
                                <Text style={styles.secondaryButtonText}>Cancel</Text>
                            </TouchableOpacity>
                        </View>
                    )}

                    {/* No Cancel: the deposit is going ahead and cannot be called back once sent.
                        Android's back still closes the sheet, and a deposit that lands is still
                        reported (onEnrolled), because the node has it. */}
                    {step === 'saving' && (
                        <View style={styles.centerContent} accessibilityLiveRegion="polite">
                            <ActivityIndicator size="large" color={colors.brand.primary} />
                            <Text style={styles.processingText}>Linking your {PROVIDER_NAME} sign-in...</Text>
                        </View>
                    )}

                    {step === 'success' && (
                        <View style={styles.content}>
                            <View style={styles.successIconWrapper}>
                                <Text style={styles.successIcon}>✅</Text>
                            </View>
                            <Text style={styles.title} accessibilityRole="header">You're covered</Text>
                            <Text style={styles.body}>
                                Your {PROVIDER_NAME} sign-in is now linked. If you lose this phone, sign in with {PROVIDER_NAME} to get back in.
                            </Text>
                            <TouchableOpacity
                                style={styles.primaryButton}
                                onPress={handleDone}
                                accessibilityRole="button"
                            >
                                <Text style={styles.primaryButtonText}>Done</Text>
                            </TouchableOpacity>
                        </View>
                    )}

                    {step === 'error' && (
                        <View style={styles.content} accessibilityLiveRegion="assertive">
                            <Text style={styles.title} accessibilityRole="header">Something went wrong</Text>
                            <Text style={styles.body} accessibilityRole="alert">{errorMessage}</Text>
                            <TouchableOpacity
                                style={styles.primaryButton}
                                onPress={handleConnect}
                                accessibilityRole="button"
                            >
                                <Text style={styles.primaryButtonText}>Try again</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.secondaryButton}
                                onPress={onClose}
                                accessibilityRole="button"
                            >
                                <Text style={styles.secondaryButtonText}>Cancel</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                </ScrollView>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    overlay: {
        flex: 1,
        justifyContent: 'flex-end',
        backgroundColor: colors.overlay.scrim,
    },
    sheet: {
        backgroundColor: colors.surface.card,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
        padding: 24,
        // More on Android: set clear of the clipboard chip Android floats over the bottom-left
        // after a copy, back when this sheet copied a code, and not measured lower since. 96px
        // everywhere pushed content, including Cancel, off a 320dp screen at 1.3x font scale.
        paddingBottom: Platform.OS === 'android' ? 80 : 40,
        minHeight: 320,
    },
    sheetScroll: {
        // Bounded so the sheet cannot grow past the viewport, and scrollable so a small screen at
        // large font scale can still reach the Cancel button rather than having it clipped.
        maxHeight: '90%',
        flexGrow: 0,
    },
    content: {
        flex: 1,
    },
    centerContent: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 200,
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        color: colors.text.heading,
        marginBottom: 16,
    },
    body: {
        fontSize: 16,
        color: colors.text.body,
        lineHeight: 24,
        marginBottom: 24,
    },
    warningBox: {
        backgroundColor: colors.feedback.warning.bg,
        borderColor: colors.feedback.warning.border,
        borderWidth: 1,
        borderRadius: 12,
        padding: 16,
        marginBottom: 32,
    },
    warningText: {
        fontSize: 14,
        color: colors.feedback.warning.fg,
        lineHeight: 20,
    },
    processingText: {
        fontSize: 16,
        color: colors.text.secondary,
        marginTop: 16,
        textAlign: 'center',
    },
    successIconWrapper: {
        alignItems: 'center',
        marginBottom: 16,
    },
    successIcon: {
        fontSize: 48,
    },
    primaryButton: {
        backgroundColor: colors.brand.primary,
        borderRadius: 12,
        paddingVertical: 16,
        alignItems: 'center',
        marginBottom: 12,
    },
    primaryButtonText: {
        color: colors.text.inverse,
        fontSize: 16,
        fontWeight: 'bold',
    },
    secondaryButton: {
        paddingVertical: 16,
        alignItems: 'center',
    },
    secondaryButtonText: {
        color: colors.text.secondary,
        fontSize: 16,
    },
});
