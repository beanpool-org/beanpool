import React, { useState, useEffect } from 'react';
import {
    Modal,
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    TextInput,
    ActivityIndicator,
    Alert,
    KeyboardAvoidingView,
    Platform,
} from 'react-native';
import { colors } from '../constants/colors';
import { setRecoveryPin } from '../utils/pin';
import { anchorUrl } from '../utils/node-post';
import type { BeanPoolIdentity } from '../utils/identity';

interface RecoveryPinModalProps {
    visible: boolean;
    currentPinSet: boolean;
    identity: BeanPoolIdentity;
    onClose: () => void;
    onSuccess: (pinSet: boolean) => void;
}

export function RecoveryPinModal({
    visible,
    currentPinSet,
    identity,
    onClose,
    onSuccess,
}: RecoveryPinModalProps): React.JSX.Element | null {
    const [pin, setPin] = useState('');
    const [confirmPin, setConfirmPin] = useState('');
    const [step, setStep] = useState<'enter' | 'confirm'>('enter');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (visible) {
            setPin('');
            setConfirmPin('');
            setStep('enter');
            setError(null);
            setLoading(false);
        }
    }, [visible]);

    const handleNext = () => {
        if (!/^\d{6}$/.test(pin)) {
            setError('PIN must be exactly 6 digits.');
            return;
        }
        setError(null);
        setStep('confirm');
    };

    const handleSave = async () => {
        if (pin !== confirmPin) {
            setError('PINs do not match. Please try again.');
            setStep('enter');
            setPin('');
            setConfirmPin('');
            return;
        }

        setLoading(true);
        setError(null);
        try {
            const url = await anchorUrl();
            if (!url) {
                setError('No community node configured.');
                setLoading(false);
                return;
            }

            const res = await setRecoveryPin(url, identity, pin);
            if (!res.ok) {
                setError(res.error || 'Failed to set recovery PIN.');
                setLoading(false);
                return;
            }

            onSuccess(true);
            onClose();
        } catch (e: any) {
            setError(e.message || 'Failed to save PIN.');
            setLoading(false);
        }
    };

    const handleRemove = () => {
        Alert.alert(
            'Remove Recovery PIN?',
            'Removing your PIN means your friend list will be revealed to anyone initiating recovery with your callsign. Are you sure?',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Remove PIN',
                    style: 'destructive',
                    onPress: async () => {
                        setLoading(true);
                        setError(null);
                        try {
                            const url = await anchorUrl();
                            if (!url) {
                                setError('No community node configured.');
                                setLoading(false);
                                return;
                            }
                            const res = await setRecoveryPin(url, identity, null);
                            if (!res.ok) {
                                setError(res.error || 'Failed to remove PIN.');
                                setLoading(false);
                                return;
                            }
                            onSuccess(false);
                            onClose();
                        } catch (e: any) {
                            setError(e.message || 'Failed to remove PIN.');
                            setLoading(false);
                        }
                    },
                },
            ],
        );
    };

    return (
        <Modal
            visible={visible}
            animationType="slide"
            transparent={true}
            onRequestClose={onClose}
        >
            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                style={styles.overlay}
            >
                <View style={styles.sheet}>
                    <Text style={styles.title} accessibilityRole="header">
                        {currentPinSet ? '🔢 Recovery PIN' : '🔢 Set Recovery PIN'}
                    </Text>

                    <Text style={styles.subtitle}>
                        An optional 6-digit PIN that protects your trusted friends list during recovery so strangers cannot harvest your contacts.
                    </Text>

                    <View style={styles.noticeBox}>
                        <Text style={styles.noticeText}>
                            💡 <Text style={{ fontWeight: 'bold' }}>No Lockout Guarantee:</Text> Forgetting this PIN never locks you out. You can always recover by remembering your friends.
                        </Text>
                    </View>

                    {step === 'enter' ? (
                        <View style={styles.inputContainer}>
                            <Text style={styles.inputLabel}>
                                {currentPinSet ? 'Enter new 6-digit PIN' : 'Choose a 6-digit PIN'}
                            </Text>
                            <TextInput
                                style={styles.pinInput}
                                value={pin}
                                onChangeText={(text) => {
                                    const clean = text.replace(/[^0-9]/g, '').slice(0, 6);
                                    setPin(clean);
                                    setError(null);
                                }}
                                placeholder="••••••"
                                placeholderTextColor={colors.text.muted}
                                keyboardType="number-pad"
                                maxLength={6}
                                secureTextEntry={true}
                                autoFocus={true}
                                accessibilityLabel="6 digit recovery PIN"
                            />
                        </View>
                    ) : (
                        <View style={styles.inputContainer}>
                            <Text style={styles.inputLabel}>Confirm 6-digit PIN</Text>
                            <TextInput
                                style={styles.pinInput}
                                value={confirmPin}
                                onChangeText={(text) => {
                                    const clean = text.replace(/[^0-9]/g, '').slice(0, 6);
                                    setConfirmPin(clean);
                                    setError(null);
                                }}
                                placeholder="••••••"
                                placeholderTextColor={colors.text.muted}
                                keyboardType="number-pad"
                                maxLength={6}
                                secureTextEntry={true}
                                autoFocus={true}
                                accessibilityLabel="Confirm 6 digit recovery PIN"
                            />
                        </View>
                    )}

                    {error && (
                        <Text style={styles.errorText} accessibilityLiveRegion="assertive">
                            {error}
                        </Text>
                    )}

                    {loading ? (
                        <ActivityIndicator size="large" color={colors.brand.primary} style={{ marginVertical: 16 }} />
                    ) : (
                        <View style={styles.buttonGroup}>
                            {step === 'enter' ? (
                                <TouchableOpacity
                                    style={[styles.primaryButton, pin.length !== 6 && styles.buttonDisabled]}
                                    onPress={handleNext}
                                    disabled={pin.length !== 6}
                                    accessibilityRole="button"
                                >
                                    <Text style={styles.primaryButtonText}>Next</Text>
                                </TouchableOpacity>
                            ) : (
                                <TouchableOpacity
                                    style={[styles.primaryButton, confirmPin.length !== 6 && styles.buttonDisabled]}
                                    onPress={handleSave}
                                    disabled={confirmPin.length !== 6}
                                    accessibilityRole="button"
                                >
                                    <Text style={styles.primaryButtonText}>Save PIN</Text>
                                </TouchableOpacity>
                            )}

                            {step === 'confirm' && (
                                <TouchableOpacity
                                    style={styles.secondaryButton}
                                    onPress={() => {
                                        setStep('enter');
                                        setConfirmPin('');
                                    }}
                                    accessibilityRole="button"
                                >
                                    <Text style={styles.secondaryButtonText}>Back</Text>
                                </TouchableOpacity>
                            )}

                            {currentPinSet && step === 'enter' && (
                                <TouchableOpacity
                                    style={styles.dangerButton}
                                    onPress={handleRemove}
                                    accessibilityRole="button"
                                >
                                    <Text style={styles.dangerButtonText}>Remove PIN</Text>
                                </TouchableOpacity>
                            )}

                            <TouchableOpacity
                                style={styles.cancelButton}
                                onPress={onClose}
                                accessibilityRole="button"
                            >
                                <Text style={styles.cancelButtonText}>Cancel</Text>
                            </TouchableOpacity>
                        </View>
                    )}
                </View>
            </KeyboardAvoidingView>
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
        minHeight: 400,
    },
    title: {
        fontSize: 22,
        fontWeight: 'bold',
        color: colors.text.heading,
        marginBottom: 8,
    },
    subtitle: {
        fontSize: 14,
        color: colors.text.secondary,
        lineHeight: 20,
        marginBottom: 16,
    },
    noticeBox: {
        backgroundColor: colors.surface.subtle,
        borderColor: colors.border.default,
        borderWidth: 1,
        borderRadius: 12,
        padding: 12,
        marginBottom: 20,
    },
    noticeText: {
        fontSize: 13,
        color: colors.text.body,
        lineHeight: 18,
    },
    inputContainer: {
        alignItems: 'center',
        marginBottom: 16,
    },
    inputLabel: {
        fontSize: 14,
        fontWeight: '600',
        color: colors.text.body,
        marginBottom: 12,
    },
    pinInput: {
        backgroundColor: colors.surface.subtle,
        borderColor: colors.border.strong,
        borderWidth: 1,
        borderRadius: 12,
        paddingHorizontal: 20,
        paddingVertical: 14,
        fontSize: 24,
        letterSpacing: 12,
        textAlign: 'center',
        color: colors.text.heading,
        width: 220,
    },
    errorText: {
        color: colors.feedback.danger.solid,
        fontSize: 13,
        textAlign: 'center',
        marginBottom: 12,
    },
    buttonGroup: {
        gap: 10,
        marginTop: 8,
    },
    primaryButton: {
        backgroundColor: colors.text.heading,
        paddingVertical: 14,
        borderRadius: 12,
        alignItems: 'center',
    },
    primaryButtonText: {
        color: colors.text.inverse,
        fontSize: 15,
        fontWeight: 'bold',
    },
    buttonDisabled: {
        opacity: 0.4,
    },
    secondaryButton: {
        backgroundColor: colors.surface.subtle,
        borderWidth: 1,
        borderColor: colors.border.default,
        paddingVertical: 12,
        borderRadius: 12,
        alignItems: 'center',
    },
    secondaryButtonText: {
        color: colors.text.body,
        fontSize: 14,
        fontWeight: '600',
    },
    dangerButton: {
        backgroundColor: colors.feedback.danger.bg,
        borderWidth: 1,
        borderColor: colors.feedback.danger.border,
        paddingVertical: 12,
        borderRadius: 12,
        alignItems: 'center',
    },
    dangerButtonText: {
        color: colors.feedback.danger.fg,
        fontSize: 14,
        fontWeight: 'bold',
    },
    cancelButton: {
        paddingVertical: 10,
        alignItems: 'center',
    },
    cancelButtonText: {
        color: colors.text.secondary,
        fontSize: 14,
        fontWeight: '500',
    },
});
