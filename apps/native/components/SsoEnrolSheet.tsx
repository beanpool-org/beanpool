import React, { useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform, Pressable, ScrollView } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { colors } from '../constants/colors';
import { anchorUrl } from '../utils/node-post';
import { SsoSignInError, returnToApp } from '../utils/sso-signin';
import type { SsoProvider, GithubDevicePrompt } from '../utils/sso-signin';
import type { KeeperEnrolmentResult } from '../utils/keeper-enrolment';
import { connectAndDeposit } from '../utils/sso-sheet-connect';
import { signInOnOpen } from '../utils/sso-sheet-opening';
import { useIdentity } from '../app/IdentityContext';
import type { BeanPoolIdentity } from '../utils/identity';
import { GithubCodeSteps } from './GithubCodeSteps';

export function SsoEnrolSheet({
    visible,
    onClose,
    onEnrolled,
    provider = Platform.OS === 'ios' ? 'apple' : 'google',
    identity: passedIdentity,
}: {
    visible: boolean;
    onClose: () => void;
    onEnrolled: (result: KeeperEnrolmentResult) => void;
    /** Which SSO provider to use. Defaults to Apple on iOS, Google elsewhere. */
    provider?: SsoProvider;
    /** Identity to use for enrolment. Defaults to useIdentity().identity if omitted. */
    identity?: BeanPoolIdentity | null;
}): React.JSX.Element | null {
    const PROVIDER_NAME = provider === 'apple' ? 'Apple'
        : provider === 'google' ? 'Google'
        : provider === 'facebook' ? 'Facebook'
        : 'GitHub';
    const { identity: contextIdentity } = useIdentity();
    const identity = passedIdentity ?? contextIdentity;
    /** `saving`: the provider is done and the deposit is going ahead, so no Cancel (utils/sso-sheet-connect.ts). */
    const [step, setStep] = useState<'processing' | 'saving' | 'success' | 'error'>('processing');
    const [errorMessage, setErrorMessage] = useState('');
    const [enrolResult, setEnrolResult] = useState<KeeperEnrolmentResult | null>(null);
    /**
     * GitHub's device flow has no redirect — the member types this code at github.com/login/device.
     * Both come from the node, which runs the flow (`signInWithGithubViaNode`).
     */
    const [devicePrompt, setDevicePrompt] = useState<GithubDevicePrompt | null>(null);
    /** Aborts the wait on the node's GitHub sign-in: closing the sheet must stop it, not orphan it. */
    const abortRef = React.useRef<AbortController | null>(null);
    const [codeCopied, setCodeCopied] = useState(false);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
            abortRef.current?.abort();
        };
    }, []);

    /**
     * Close, and stop what is running.
     *
     * A GitHub sign-in polls the node on a timer, and the modal stays mounted with `visible={false}`,
     * so unmount cleanup alone would leave a poll running unseen until the code expired.
     */
    const closeAndStop = React.useCallback(() => {
        abortRef.current?.abort();
        onClose();
    }, [onClose]);

    /**
     * Dash stripped deliberately. GitHub renders eight separate cells; handing them nine characters
     * is the likeliest reason the paste chip flashed and vanished. MEASURED 2026-08-28: ~5 failed
     * paste attempts before one landed.
     */
    const copyCode = (prompt: GithubDevicePrompt) => {
        Clipboard.setStringAsync(prompt.userCode.replace(/-/g, '')).then(
            () => setCodeCopied(true),
            () => setCodeCopied(false),
        );
    };

    const handleConnect = async () => {
        if (!identity) {
            setErrorMessage(`You must be signed in to connect ${PROVIDER_NAME}.`);
            setStep('error');
            return;
        }

        setStep('processing');
        setDevicePrompt(null);
        setCodeCopied(false);
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
                onGithubPrompt: (prompt) => {
                    setDevicePrompt(prompt);
                    // Copied before the member has done anything. The whole friction was having to
                    // return to the app for the code once GitHub was on screen.
                    copyCode(prompt);
                },
                // The provider is done: the code and Cancel come down, and the deposit goes ahead.
                onSignedIn: async () => {
                    setDevicePrompt(null);
                    setStep('saving');
                    // Get them back here. GitHub's success page says nothing about returning. On iOS this
                    // closes the page. On Android it only runs once the member is back (the app is paused
                    // behind GitHub's tab, and the poll with it: sso-signin.ts `sleep`), which is why the
                    // panel tells them to tap ✕.
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
                if (e.reason === 'unsupported' && provider === 'github') {
                    // Not this device: the community's server has to run GitHub's sign-in, and says
                    // so in full.
                    setErrorMessage(e.message);
                } else if (e.reason === 'unsupported') {
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
                            {devicePrompt ? (
                                <>
                                    {/* What to do on GitHub, first: Paste, then how to come back. At the top, well
                                        clear of the clipboard chip Android floats over the bottom-left after a copy,
                                        which covered the Paste line when it sat below. MEASURED 2026-08-28, Pixel 9 Pro. */}
                                    <GithubCodeSteps />
                                    {/* The code and the address both come from the node's answer. */}
                                    <Text style={styles.processingText}>
                                        Enter this code at{' '}
                                        <Text style={styles.deviceCodeEmphasis}>
                                            {devicePrompt.verificationUri.replace(/^https:\/\//, '')}
                                        </Text>
                                        {' '}to finish:
                                    </Text>
                                    <View style={styles.deviceCodeBox}>
                                        {/* One line, shrunk to fit. MEASURED (Roboto Bold widths): at 320dp the
                                            box is 212dp inside, and WDJB-MJHT needs 254dp at 1.0x and 330dp at
                                            1.3x, so it broke at the dash. Android shrinks until it fits (Fabric
                                            ignores minimumFontScale); iOS stops at 0.5, which fits MMMM-WWWW. */}
                                        <Text
                                            style={styles.deviceCodeText}
                                            selectable
                                            numberOfLines={1}
                                            adjustsFontSizeToFit
                                            minimumFontScale={0.5}
                                            accessibilityLabel={`Code ${devicePrompt.userCode.split('').join(' ')}`}
                                        >
                                            {devicePrompt.userCode}
                                        </Text>
                                        <Pressable
                                            onPress={() => copyCode(devicePrompt)}
                                            accessibilityRole="button"
                                            accessibilityLabel={codeCopied ? 'Code copied. Copy it again.' : 'Copy the code'}
                                            style={styles.copyButton}
                                            hitSlop={8}
                                        >
                                            <Text style={styles.copyButtonText}>{codeCopied ? '✓ Copied' : 'Copy'}</Text>
                                        </Pressable>
                                    </View>
                                    {/* The member taps when they have read the code and the steps, rather than the
                                        browser covering them the instant they appear. */}
                                    <TouchableOpacity
                                        style={[styles.primaryButton, { marginTop: 18, alignSelf: 'stretch' }]}
                                        onPress={() => {
                                            // No pre-fill parameter exists. GitHub returns no
                                            // verification_uri_complete and the device page ignores
                                            // ?user_code= / ?code= — checked against the live endpoint
                                            // and the docs. Entry is manual, so send a clean URL.
                                            WebBrowser.openBrowserAsync(devicePrompt.verificationUri).catch(() => {});
                                        }}
                                        accessibilityRole="button"
                                        accessibilityLabel="Open GitHub to enter the code"
                                    >
                                        <Text style={styles.primaryButtonText}>Open GitHub →</Text>
                                    </TouchableOpacity>
                                    <ActivityIndicator color={colors.brand.primary} style={{ marginTop: 14 }} />
                                    {/* It used to promise the tab would close on its own. On Android it cannot: GithubCodeSteps says what to do. */}
                                    <Text style={styles.deviceCodeSub}>Waiting for GitHub…</Text>
                                </>
                            ) : (
                                <>
                                    <ActivityIndicator size="large" color={colors.brand.primary} />
                                    <Text style={styles.processingText}>Connecting with {PROVIDER_NAME}...</Text>
                                </>
                            )}
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
        // Android only: it floats a clipboard preview chip over the bottom-left for a few seconds
        // after a copy, and this sheet copies automatically, so anything in that band is
        // unreadable. iOS has no such chip and does not need the clearance — 96px everywhere
        // pushed content, including Cancel, off a 320dp screen at 1.3x font scale.
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
    // Sized to stay legible at 320dp and 1.3x font scale: the code is the one thing on this screen
    // the member has to read off and retype, so it takes the space.
    deviceCodeBox: {
        marginTop: 20,
        paddingVertical: 18,
        paddingHorizontal: 28,
        borderRadius: 12,
        borderWidth: 2,
        borderColor: colors.brand.primary,
        backgroundColor: colors.surface.subtle,
        alignItems: 'center',
        alignSelf: 'stretch',
    },
    deviceCodeText: {
        fontSize: 34,
        fontWeight: 'bold',
        letterSpacing: 6,
        color: colors.text.heading,
        fontVariant: ['tabular-nums'],
        textAlign: 'center',
    },
    copyButton: {
        marginTop: 10,
        paddingVertical: 8,
        paddingHorizontal: 22,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.brand.primary,
    },
    copyButtonText: {
        fontSize: 15,
        fontWeight: 'bold',
        color: colors.brand.primary,
    },
    deviceCodeEmphasis: {
        fontWeight: 'bold',
        color: colors.text.heading,
    },
    deviceCodeSub: {
        fontSize: 15,
        color: colors.text.secondary,
        marginTop: 14,
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
