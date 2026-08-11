import React, { useState } from 'react';
import { Modal, View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { colors } from '../constants/colors';
import { anchorUrl } from '../utils/node-post';
import { startSsoSignIn, SsoSignInError } from '../utils/sso-signin';
import type { SsoProvider } from '../utils/sso-signin';
import { enrolSsoKeeper, KeeperEnrolmentResult } from '../utils/keeper-enrolment';
import { useIdentity } from '../app/IdentityContext';

/**
 * Decode the `sub` claim from a JWT id_token without signature verification.
 * Follows the same pattern as decodeJwtPayload in apple-probe.tsx.
 */
function extractSub(idToken: string): string {
    const parts = idToken?.split('.');
    if (!parts || parts.length !== 3 || !parts[1]) {
        throw new Error('Invalid ID token format.');
    }
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(globalThis.atob(pad)) as Record<string, unknown>;
    if (typeof payload?.sub !== 'string' || !payload.sub) {
        throw new Error('ID token missing subject claim (sub).');
    }
    return payload.sub;
}

export function SsoEnrolSheet({
    visible,
    onClose,
    onEnrolled,
    provider = Platform.OS === 'ios' ? 'apple' : 'google',
}: {
    visible: boolean;
    onClose: () => void;
    onEnrolled: (result: KeeperEnrolmentResult) => void;
    /** Which SSO provider to use. Defaults to Apple on iOS, Google elsewhere. */
    provider?: SsoProvider;
}): React.JSX.Element | null {
    const PROVIDER_NAME = provider === 'apple' ? 'Apple' : 'Google';
    const { identity } = useIdentity();
    const [step, setStep] = useState<'explain' | 'processing' | 'success' | 'error'>('explain');
    const [errorMessage, setErrorMessage] = useState('');
    const [enrolResult, setEnrolResult] = useState<KeeperEnrolmentResult | null>(null);

    // Reset state when opened
    React.useEffect(() => {
        if (visible) {
            setStep('explain');
            setErrorMessage('');
            setEnrolResult(null);
        }
    }, [visible]);

    const handleConnect = async () => {
        if (!identity) {
            setErrorMessage(`You must be signed in to connect ${PROVIDER_NAME}.`);
            setStep('error');
            return;
        }

        setStep('processing');
        try {
            const url = await anchorUrl();
            if (!url) {
                setErrorMessage('No node configured yet.');
                setStep('error');
                return;
            }

            const signin = await startSsoSignIn(provider, url, identity);
            const sub = extractSub(signin.idToken);

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
            }
        } catch (e) {
            if (e instanceof SsoSignInError) {
                if (e.reason === 'cancelled') {
                    onClose();
                    return;
                }
                if (e.reason === 'unsupported') {
                    setErrorMessage(`This device can't sign in with ${PROVIDER_NAME}.`);
                } else if (e.reason === 'no-token' || e.reason === 'provider') {
                    setErrorMessage(`${PROVIDER_NAME} couldn't complete the sign-in. Try again.`);
                } else if (e.reason === 'nonce') {
                    setErrorMessage("Couldn't reach your hub. Check your connection.");
                } else {
                    setErrorMessage(e.message);
                }
            } else {
                setErrorMessage((e as Error).message || 'An unknown error occurred.');
            }
            setStep('error');
        }
    };

    const handleDone = () => {
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
                    {step === 'explain' && (
                        <View style={styles.content}>
                            <Text style={styles.title} accessibilityRole="header">Protect with {PROVIDER_NAME} sign-in</Text>
                            <Text style={styles.body}>
                                If you lose this phone, signing in with {PROVIDER_NAME} on a new one will get you back into your account.
                            </Text>
                            <View style={styles.warningBox}>
                                <Text style={styles.warningText}>
                                    Your hub operator can reconstruct your account if they also control your {PROVIDER_NAME} sign-in. If full sovereignty matters, use trusted friends instead.
                                </Text>
                            </View>
                            <TouchableOpacity
                                style={styles.primaryButton}
                                onPress={handleConnect}
                                accessibilityRole="button"
                            >
                                <Text style={styles.primaryButtonText}>Connect {PROVIDER_NAME}</Text>
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

                    {step === 'processing' && (
                        <View style={styles.centerContent} accessibilityLiveRegion="polite">
                            <ActivityIndicator size="large" color={colors.brand.primary} />
                            <Text style={styles.processingText}>Connecting...</Text>
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
                                onPress={() => setStep('explain')}
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
