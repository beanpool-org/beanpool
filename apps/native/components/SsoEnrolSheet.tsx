import React, { useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform, Pressable } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { colors } from '../constants/colors';
import { anchorUrl } from '../utils/node-post';
import { startSsoSignIn, SsoSignInError } from '../utils/sso-signin';
import type { SsoProvider, GithubDevicePrompt } from '../utils/sso-signin';
import { enrolSsoKeeper, KeeperEnrolmentResult } from '../utils/keeper-enrolment';
import { useIdentity } from '../app/IdentityContext';
import type { BeanPoolIdentity } from '../utils/identity';

/**
 * Decode the `sub` claim from a JWT id_token without signature verification,
 * or use the directly-resolved `fallbackSub` for OAuth providers (like GitHub).
 */
function extractSub(idToken: string, fallbackSub?: string): string {
    if (fallbackSub) return fallbackSub;
    const parts = idToken?.split('.');
    if (!parts || parts.length < 2 || !parts[1]) {
        throw new Error('Could not determine user identifier for this sign-in.');
    }
    try {
        const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
        const payload = JSON.parse(globalThis.atob(pad)) as Record<string, unknown>;
        if (typeof payload?.sub === 'string' && payload.sub) {
            return payload.sub;
        }
    } catch {}
    throw new Error('ID token missing subject claim (sub).');
}

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
    const [step, setStep] = useState<'processing' | 'success' | 'error'>('processing');
    const [errorMessage, setErrorMessage] = useState('');
    const [enrolResult, setEnrolResult] = useState<KeeperEnrolmentResult | null>(null);
    /** GitHub's device flow has no redirect — the member types this code at github.com/login/device. */
    const [devicePrompt, setDevicePrompt] = useState<GithubDevicePrompt | null>(null);
    /** Aborts an in-flight device-flow poll: closing the sheet must stop it, not orphan it. */
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
     * The device flow polls GitHub on a timer, and the modal stays mounted with `visible={false}`,
     * so unmount cleanup alone would leave a poll running unseen until the code expired.
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

            const signin = await startSsoSignIn(provider, url, identity, (prompt) => {
                setDevicePrompt(prompt);
                // Copied before the member has done anything. The whole friction was having to
                // return to the app for the code once GitHub was on screen.
                // Dash stripped deliberately. GitHub renders eight separate cells; handing them
                // nine characters is the likeliest reason the paste chip flashed and vanished.
                // MEASURED 2026-08-28: ~5 failed paste attempts before one landed.
                Clipboard.setStringAsync(prompt.userCode.replace(/-/g, '')).then(
                    () => setCodeCopied(true),
                    () => setCodeCopied(false),
                );
            }, abort.signal);

            // Close GitHub for them. Its own success page says nothing about returning here, and
            // the "come back" line in this sheet is behind the browser at that moment — so without
            // this the member is left on a finished web page wondering whether it worked.
            // MEASURED 2026-08-28: reported as "sitting at the copy screen for a bit" before it
            // completed. Harmless if no browser is open.
            try {
                await WebBrowser.dismissBrowser();
            } catch {}

            const sub = extractSub(signin.idToken, signin.sub);

            const result = await enrolSsoKeeper({
                identity,
                provider: signin.provider,
                sub,
                idToken: signin.idToken,
                nonce: signin.nonce,
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

    // Auto-trigger sign-in when opened
    React.useEffect(() => {
        if (visible && identity) {
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
                <View style={styles.sheet}>
                    {step === 'processing' && (
                        <View style={styles.centerContent} accessibilityLiveRegion="polite">
                            {devicePrompt ? (
                                <>
                                    <Text style={styles.processingText}>
                                        Enter this code on GitHub to finish:
                                    </Text>
                                    <Pressable
                                        onPress={() => {
                                            Clipboard.setStringAsync(devicePrompt.userCode.replace(/-/g, ''));
                                            setCodeCopied(true);
                                        }}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Code ${devicePrompt.userCode.split('').join(' ')}, copied. Tap to copy again.`}
                                        style={styles.deviceCodeBox}
                                    >
                                        <Text style={styles.deviceCodeText} selectable>{devicePrompt.userCode}</Text>
                                        <Text style={styles.deviceCodeHint}>
                                            {codeCopied ? '✓ copied — or just type it, it is 8 characters' : 'tap to copy'}
                                        </Text>
                                    </Pressable>
                                    {/* The member taps when they have read the code, rather than the
                                        browser covering it the instant it appears. */}
                                    <TouchableOpacity
                                        style={[styles.primaryButton, { marginTop: 20, alignSelf: 'stretch' }]}
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
                                    <Text style={styles.deviceCodeSub}>
                                        Enter it on {devicePrompt.verificationUri.replace('https://', '')},
                                        then come back — this finishes on its own.
                                    </Text>
                                    <ActivityIndicator color={colors.brand.primary} style={{ marginTop: 16 }} />
                                    <Text style={styles.processingText}>
                                        Waiting for GitHub… this screen closes itself.
                                    </Text>
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
                </View>
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
        paddingBottom: 40,
        minHeight: 320,
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
    deviceCodeHint: {
        fontSize: 12,
        color: colors.text.secondary,
        marginTop: 8,
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
