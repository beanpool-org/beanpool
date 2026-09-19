/**
 * The "Manage <community>" press, shared by Settings (NodeAdminEntry) and the header's 🛡️ needs-you icon:
 * phone unlock → signed challenge → one-time sign-in link → the node's /settings (optionally at a section)
 * in an in-app browser tab, with the node's own 2FA prompt when it asks. utils/node-admin.ts has the steps.
 *
 * Returns `start` for the press and `dialog`, the 2FA prompt, which the caller renders.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, Modal, TextInput, ActivityIndicator, Alert, Keyboard, ScrollView } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import * as WebBrowser from 'expo-web-browser';
import { useIdentity } from '../app/IdentityContext';
import { useTheme } from '../app/ThemeContext';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import { manageNode, NO_DEVICE_LOCK_MESSAGE, type ManageOutcome, type SettingsSection } from '../utils/node-admin';

export function useManageNode() {
    const { identity } = useIdentity();
    const { colors } = useTheme();
    const [busy, setBusy] = useState(false);
    const [name, setName] = useState('this community');
    const [totp, setTotp] = useState<{ continueWith: (code: string) => Promise<ManageOutcome>; wrongCode: boolean } | null>(null);
    const [code, setCode] = useState('');

    const handle = (out: ManageOutcome, communityName: string) => {
        switch (out.kind) {
            case 'opened':
                setTotp(null);
                setCode('');
                return;
            case 'totp-required':
                setTotp({ continueWith: out.continueWith, wrongCode: out.wrongCode });
                setCode('');
                return;
            case 'no-device-lock':
                Alert.alert('Set a screen lock first', NO_DEVICE_LOCK_MESSAGE);
                return;
            case 'unlock-failed':
                return; // They cancelled, or the phone said no. Nothing to explain.
            case 'refused':
                setTotp(null);
                Alert.alert(`Can't open ${communityName}'s settings`, out.message);
                return;
            case 'error':
                setTotp(null);
                Alert.alert(`Can't open ${communityName}'s settings`, out.message);
                return;
        }
    };

    const start = async (communityName: string, section?: SettingsSection) => {
        if (busy || !identity) return;
        setBusy(true);
        setName(communityName);
        try {
            const url = await getAnchorUrl();
            if (!url) { Alert.alert('Not connected', 'Connect to your community first.'); return; }
            handle(await manageNode({
                nodeUrl: url,
                identity,
                communityName,
                section,
                openUrl: (u) => WebBrowser.openBrowserAsync(u),
            }), communityName);
        } finally {
            setBusy(false);
        }
    };

    const submitCode = async () => {
        if (!totp || busy || !/^\s*[0-9a-zA-Z-]{6,}\s*$/.test(code)) return;
        Keyboard.dismiss();
        setBusy(true);
        try {
            handle(await totp.continueWith(code), name);
        } finally {
            setBusy(false);
        }
    };

    const dialog = (
        <Modal visible={!!totp} transparent animationType="fade" onRequestClose={() => { setTotp(null); setCode(''); }}>
            <KeyboardAvoidingView style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' }} behavior="padding">
                <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: 16 }} keyboardShouldPersistTaps="handled">
                    <View style={{ backgroundColor: colors.surface.card, borderRadius: 20, padding: 20, borderWidth: 1, borderColor: colors.border.default }}>
                        <Text style={{ fontSize: 18, fontWeight: 'bold', color: colors.text.heading, marginBottom: 8 }} accessibilityRole="header">
                            2FA code for {name}
                        </Text>
                        <Text style={{ fontSize: 14, color: colors.text.secondary, lineHeight: 20, marginBottom: 12 }}>
                            This community's settings are also protected by a 2FA code. Enter the 6-digit code from your authenticator app, or a backup code.
                        </Text>
                        {totp?.wrongCode ? (
                            <Text style={{ fontSize: 14, color: colors.feedback.danger.solid, marginBottom: 8 }} accessibilityLiveRegion="polite">
                                That code didn't work. Codes change every 30 seconds — try the current one.
                            </Text>
                        ) : null}
                        <TextInput
                            value={code}
                            onChangeText={setCode}
                            autoFocus
                            keyboardType="number-pad"
                            autoComplete="one-time-code"
                            textContentType="oneTimeCode"
                            maxLength={20}
                            accessibilityLabel="2FA code"
                            placeholder="123456"
                            placeholderTextColor={colors.text.muted}
                            onSubmitEditing={submitCode}
                            style={{ minHeight: 48, borderWidth: 1, borderColor: colors.border.default, borderRadius: 12, paddingHorizontal: 12, fontSize: 18, color: colors.text.body, backgroundColor: colors.surface.app, marginBottom: 16, letterSpacing: 2 }}
                        />
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'flex-end' }}>
                            <Pressable
                                onPress={() => { Keyboard.dismiss(); setTotp(null); setCode(''); }}
                                accessibilityRole="button"
                                style={{ minHeight: 48, minWidth: 48, paddingHorizontal: 16, justifyContent: 'center' }}
                            >
                                <Text style={{ fontSize: 15, color: colors.text.secondary, fontWeight: '600' }}>Cancel</Text>
                            </Pressable>
                            <Pressable
                                onPress={submitCode}
                                disabled={busy}
                                accessibilityRole="button"
                                accessibilityState={{ busy, disabled: busy }}
                                style={{ minHeight: 48, paddingHorizontal: 20, justifyContent: 'center', borderRadius: 12, backgroundColor: colors.brand.primary }}
                            >
                                {busy
                                    ? <ActivityIndicator size="small" color={colors.text.inverse} />
                                    : <Text style={{ fontSize: 15, color: colors.text.inverse, fontWeight: '700' }}>Open settings</Text>}
                            </Pressable>
                        </View>
                    </View>
                </ScrollView>
            </KeyboardAvoidingView>
        </Modal>
    );

    return { busy, start, dialog };
}
