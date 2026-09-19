/**
 * The node's own 2FA code, asked for after the phone's unlock when the owner turned 2FA on. Shared by Manage
 * (useManageNode) and "Sign in on a computer" (app/settings-signin.tsx).
 */
import React from 'react';
import { View, Text, Pressable, Modal, TextInput, ActivityIndicator, Keyboard, ScrollView } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useTheme } from '../app/ThemeContext';

/** A plausible code: six digits, or a backup code. */
export const looksLikeTotpCode = (code: string) => /^\s*[0-9a-zA-Z-]{6,}\s*$/.test(code);

export function TotpCodeDialog(props: {
    visible: boolean;
    communityName: string;
    wrongCode: boolean;
    busy: boolean;
    code: string;
    onChangeCode: (code: string) => void;
    onSubmit: () => void;
    onCancel: () => void;
    submitLabel: string;
}) {
    const { colors } = useTheme();
    const { visible, communityName, wrongCode, busy, code, onChangeCode, onSubmit, onCancel, submitLabel } = props;
    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
            <KeyboardAvoidingView style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' }} behavior="padding">
                <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 16 }} keyboardShouldPersistTaps="handled">
                    <View style={{ backgroundColor: colors.surface.card, borderRadius: 20, padding: 20, borderWidth: 1, borderColor: colors.border.default }}>
                        <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text.heading, marginBottom: 8 }} accessibilityRole="header">
                            2FA code for {communityName}
                        </Text>
                        <Text style={{ fontSize: 14, color: colors.text.secondary, lineHeight: 20, marginBottom: 12 }}>
                            This community's settings are also protected by a 2FA code. Enter the 6-digit code from your authenticator app, or a backup code.
                        </Text>
                        {wrongCode ? (
                            <Text style={{ fontSize: 14, color: colors.feedback.danger.solid, marginBottom: 8 }} accessibilityLiveRegion="polite">
                                That code didn't work. Codes change every 30 seconds — try the current one.
                            </Text>
                        ) : null}
                        <TextInput
                            value={code}
                            onChangeText={onChangeCode}
                            autoFocus
                            keyboardType="number-pad"
                            autoComplete="one-time-code"
                            textContentType="oneTimeCode"
                            maxLength={20}
                            accessibilityLabel="2FA code"
                            placeholder="123456"
                            placeholderTextColor={colors.text.muted}
                            onSubmitEditing={onSubmit}
                            style={{ minHeight: 48, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, paddingHorizontal: 12, fontSize: 18, color: colors.text.body, backgroundColor: colors.surface.app, marginBottom: 16, letterSpacing: 2 }}
                        />
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'flex-end' }}>
                            <Pressable
                                onPress={() => { Keyboard.dismiss(); onCancel(); }}
                                accessibilityRole="button"
                                style={{ minHeight: 48, minWidth: 48, paddingHorizontal: 16, justifyContent: 'center' }}
                            >
                                <Text style={{ fontSize: 15, color: colors.text.secondary, fontWeight: '600' }}>Cancel</Text>
                            </Pressable>
                            <Pressable
                                onPress={onSubmit}
                                disabled={busy}
                                accessibilityRole="button"
                                accessibilityState={{ busy, disabled: busy }}
                                style={{ minHeight: 48, paddingHorizontal: 20, justifyContent: 'center', borderRadius: 12, backgroundColor: colors.brand.primary }}
                            >
                                {busy
                                    ? <ActivityIndicator size="small" color={colors.text.inverse} />
                                    : <Text style={{ fontSize: 15, color: colors.text.inverse, fontWeight: '700' }}>{submitLabel}</Text>}
                            </Pressable>
                        </View>
                    </View>
                </ScrollView>
            </KeyboardAvoidingView>
        </Modal>
    );
}
