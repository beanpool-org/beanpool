import React, { useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform, Pressable } from 'react-native';
import * as Clipboard from 'expo-clipboard';
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
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => {
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, []);

    const handleConnect = async () => {
        if (!identity) {
            setErrorMessage(`You must be signed in to connect ${PROVIDER_NAME}.`);
            setStep('error');
            return;
        }

        setStep('processing');
        setDevicePrompt(null);
        try {
            const url = await anchorUrl();
            if (!url) {
                setErrorMessage('No node configured yet.');
                setStep('error');
                return;
            }

            const signin = await startSsoSignIn(provider, url, identity, setDevicePrompt);
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
            onRequestClose={onClose}
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
                                        onPress={() => Clipboard.setStringAsync(devicePrompt.userCode)}
                                        accessibilityRole="button"
                                        accessibilityLabel={`Copy code ${devicePrompt.userCode.split('').join(' ')}`}
                                        style={styles.deviceCodeBox}
                                    >
                                        <Text style={styles.deviceCodeText} selectable>{devicePrompt.userCode}</Text>
                                        <Text style={styles.deviceCodeHint}>tap to copy</Text>
                                    </Pressable>
                                    <Text style={styles.deviceCodeSub}>
                                        {devicePrompt.verificationUri.replace('https://', '')}
                                    </Text>
                                    <ActivityIndicator color={colors.brand.primary} style={{ marginTop: 16 }} />
                                    <Text style={styles.processingText}>Waiting for you to confirm…</Text>
                                </>
                            ) : (
                                <>
                                    <ActivityIndicator size="large" color={colors.brand.primary} />
                                    <Text style={styles.processingText}>Connecting with {PROVIDER_NAME}...</Text>
                                </>
                            )}
                            <TouchableOpacity
                                style={[styles.secondaryButton, { marginTop: 24, alignSelf: 'stretch' }]}
                                onPress={onClose}
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
