import React, { useState, useMemo } from 'react';
import { Modal, View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform, ScrollView } from 'react-native';
import { type AppColors } from '../constants/colors';
import { useOnboardingColors } from '../app/ThemeContext';
import { anchorUrl } from '../utils/node-post';
import { hasVault, type SignInCopies } from '../utils/vault-config';
import { t } from '@beanpool/core';
import { SsoSignInError, returnToApp } from '../utils/sso-signin';
import { SSO_PROVIDER_NAMES, type SsoProvider } from '../utils/sso-providers';
import type { KeeperEnrolmentResult } from '../utils/keeper-enrolment';
import { signInReplacedWords, welcomeLineWords } from './welcome/welcome-lines';
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
    copyAt,
    copiesAt,
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
    /**
     * `community`: the copy goes to the community the phone is set to, whatever the build, never to BeanPool's key vault.
     * For an account a claim made (app/welcome.tsx, DESIGN-account-without-global-fable.md §2.2): nothing of ours in a
     * self-hosted community's first owner's path (Marty, 24 Oct). Otherwise where the community's rule sends it.
     */
    copyAt?: 'community';
    /**
     * Where the screen that opened the sheet said the copy goes (utils/vault-config.ts signInCopiesAt with the community's
     * rule, vault rethink VR2), for the words while it works. The connect asks the rule again itself, and the result says
     * where the copy went. Absent: where this build keeps copies.
     */
    copiesAt?: SignInCopies;
}): React.JSX.Element | null {
    const { colors } = useOnboardingColors();
    const styles = useMemo(() => makeStyles(colors), [colors]);
    const PROVIDER_NAME = SSO_PROVIDER_NAMES[provider];
    /** Where the copy goes, as the screen said it: the community's rule, or this build's place, unless `copyAt` says. */
    const atVault = (copiesAt ? copiesAt === 'vault' : hasVault()) && copyAt !== 'community';
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
            setErrorMessage(t('You must be signed in to connect {provider}.', { provider: PROVIDER_NAME }));
            setStep('error');
            return;
        }

        setStep('processing');
        abortRef.current?.abort();
        const abort = new AbortController();
        abortRef.current = abort;
        try {
            // The community this phone is set to: its rule says where the copy goes (utils/sso-sheet-connect.ts), at the
            // vault or at the community. A build without a vault needs it either way.
            const url = await anchorUrl();
            if (!url && !hasVault()) {
                setErrorMessage(t('No node configured yet.'));
                setStep('error');
                return;
            }
            const result = await connectAndDeposit({
                provider,
                url,
                identity,
                ...(copyAt ? { copyAt } : {}),
                phoneLock: askPhoneLock ? () => authenticateUser(t('Confirm authentication to link a sign-in to your account.')) : null,
                // The provider is done: Cancel comes down, and the deposit goes ahead.
                onSignedIn: async () => {
                    setStep('saving');
                    // Get them back here, with any sign-in page closed (iOS) or behind the app (Android).
                    await returnToApp();
                },
                signal: abort.signal,
            });

            if (result.error) {
                // The lower layers' sentences in the member's language (components/welcome/welcome-lines.ts); a node's
                // or the key vault's own words as they came.
                setErrorMessage(welcomeLineWords(result.error));
                setStep('error');
            } else {
                setEnrolResult(result);
                setStep('success');
                if (timerRef.current) clearTimeout(timerRef.current);
                // A copy that replaced another account's stays up until Done: that line has to be read.
                if (result.replaced) return;
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
                    setErrorMessage(t("This device can't sign in with {provider}. ({reason})", { provider: PROVIDER_NAME, reason: welcomeLineWords(e.message) }));
                } else if (e.reason === 'no-token' || e.reason === 'provider') {
                    setErrorMessage(t('{provider} sign-in failed: {reason}', { provider: PROVIDER_NAME, reason: welcomeLineWords(e.message) }));
                } else if (e.reason === 'nonce') {
                    setErrorMessage(t('Sign-in setup failed: {reason}', { reason: welcomeLineWords(e.message) }));
                } else {
                    setErrorMessage(welcomeLineWords(e.message));
                }
            } else {
                setErrorMessage((e as Error).message ? welcomeLineWords((e as Error).message) : t('An unknown error occurred.'));
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
                            <Text style={styles.processingText}>{t('Connecting with {provider}...', { provider: PROVIDER_NAME })}</Text>
                            <TouchableOpacity
                                style={[styles.secondaryButton, { marginTop: 24, alignSelf: 'stretch' }]}
                                onPress={closeAndStop}
                                accessibilityRole="button"
                                accessibilityLabel={t('Cancel connection')}
                            >
                                <Text style={styles.secondaryButtonText}>{t('Cancel')}</Text>
                            </TouchableOpacity>
                        </View>
                    )}

                    {/* No Cancel: the deposit is going ahead and cannot be called back once sent.
                        Android's back still closes the sheet, and a deposit that lands is still
                        reported (onEnrolled), because the node has it. */}
                    {step === 'saving' && (
                        <View style={styles.centerContent} accessibilityLiveRegion="polite">
                            <ActivityIndicator size="large" color={colors.brand.primary} />
                            <Text style={styles.processingText}>{t('Linking your {provider} sign-in...', { provider: PROVIDER_NAME })}</Text>
                        </View>
                    )}

                    {step === 'success' && (
                        <View style={styles.content}>
                            <View style={styles.successIconWrapper}>
                                <Text style={styles.successIcon}>✅</Text>
                            </View>
                            <Text style={styles.title} accessibilityRole="header">{t("You're covered")}</Text>
                            <Text style={styles.body}>
                                {(enrolResult?.keptAt ? enrolResult.keptAt === 'vault' : atVault)
                                    // Another phone, never a computer: only the phone app can answer a restore (the web app has no vault client).
                                    ? t("Your {name} sign-in is now linked, in every community. If you lose this phone, sign in with {name} to get back in: it takes a day, or less if another phone of yours says it's you.", { name: PROVIDER_NAME })
                                    : t('Your {name} sign-in is now linked. If you lose this phone, sign in with {name} to get back in.', { name: PROVIDER_NAME })}
                            </Text>
                            {enrolResult?.replaced && (
                                <Text style={styles.body}>{signInReplacedWords(PROVIDER_NAME)}</Text>
                            )}
                            <TouchableOpacity
                                style={styles.primaryButton}
                                onPress={handleDone}
                                accessibilityRole="button"
                            >
                                <Text style={styles.primaryButtonText}>{t('Done')}</Text>
                            </TouchableOpacity>
                        </View>
                    )}

                    {step === 'error' && (
                        <View style={styles.content} accessibilityLiveRegion="assertive">
                            <Text style={styles.title} accessibilityRole="header">{atVault ? t('Not linked') : t('Something went wrong')}</Text>
                            <Text style={styles.body} accessibilityRole="alert">{errorMessage}</Text>
                            <TouchableOpacity
                                style={styles.primaryButton}
                                onPress={handleConnect}
                                accessibilityRole="button"
                            >
                                <Text style={styles.primaryButtonText}>{t('Try again')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.secondaryButton}
                                onPress={onClose}
                                accessibilityRole="button"
                            >
                                <Text style={styles.secondaryButtonText}>{t('Cancel')}</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                </ScrollView>
            </View>
        </Modal>
    );
}

function makeStyles(colors: AppColors) {
    return StyleSheet.create({
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
            backgroundColor: colors.brand.fill,
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
}
