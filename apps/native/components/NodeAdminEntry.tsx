/**
 * Settings → "🛡️ Manage <community>": shown ONLY to a member the node itself says is an owner or admin.
 *
 * The role is asked of the node each time Settings is focused (utils/node-admin.ts → GET /api/node-admin/me)
 * and never stored, so there is nothing on the phone to edit into a button. Pressing it asks for the phone's
 * own unlock, gets a one-time sign-in link, and opens the node's /settings in an in-app browser tab
 * (Custom Tabs / SFSafariViewController). /settings is not an app link, so the tab keeps it.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, Modal, TextInput, ActivityIndicator, Alert, Keyboard, ScrollView } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import * as WebBrowser from 'expo-web-browser';
import { useFocusEffect } from 'expo-router';
import { useIdentity } from '../app/IdentityContext';
import { useTheme } from '../app/ThemeContext';
import { anchorUrl as getAnchorUrl } from '../utils/node-post';
import {
    fetchMyNodeRole, canManageNode, manageNode, NO_DEVICE_LOCK_MESSAGE,
    type ManageOutcome, type ManageRole,
} from '../utils/node-admin';

/** The Settings screen's own menu styles, so the entry looks like every other row. */
interface MenuStyles {
    sectionHeader: any; menuGroup: any; menuBtn: any; menuBtnLast: any;
    menuIconWrap: any; menuIcon: any; menuText: any; menuSub: any; menuChevron: any;
}

export function NodeAdminEntry({ styles, fallbackCommunityName }: { styles: MenuStyles; fallbackCommunityName?: string | null }) {
    const { identity } = useIdentity();
    const { colors } = useTheme();
    const [role, setRole] = useState<ManageRole | null>(null);
    const [communityName, setCommunityName] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [totp, setTotp] = useState<{ continueWith: (code: string) => Promise<ManageOutcome>; wrongCode: boolean } | null>(null);
    const [code, setCode] = useState('');

    useFocusEffect(
        React.useCallback(() => {
            let cancelled = false;
            (async () => {
                const url = await getAnchorUrl();
                if (!url || !identity?.privateKey) { if (!cancelled) setRole(null); return; }
                const mine = await fetchMyNodeRole(url, identity);
                if (cancelled) return;
                setRole(mine.role);
                setCommunityName(mine.communityName);
            })().catch(() => { if (!cancelled) setRole(null); });
            return () => { cancelled = true; };
        }, [identity])
    );

    if (!canManageNode(role) || !identity) return null;
    const name = communityName || fallbackCommunityName || 'this community';

    const handle = (out: ManageOutcome) => {
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
                Alert.alert(`Can't open ${name}'s settings`, out.message);
                return;
            case 'error':
                setTotp(null);
                Alert.alert(`Can't open ${name}'s settings`, out.message);
                return;
        }
    };

    const onPress = async () => {
        if (busy) return;
        setBusy(true);
        try {
            const url = await getAnchorUrl();
            if (!url) { Alert.alert('Not connected', 'Connect to your community first.'); return; }
            handle(await manageNode({
                nodeUrl: url,
                identity,
                communityName: name,
                openUrl: (u) => WebBrowser.openBrowserAsync(u),
            }));
        } finally {
            setBusy(false);
        }
    };

    const submitCode = async () => {
        if (!totp || busy || !/^\s*[0-9a-zA-Z-]{6,}\s*$/.test(code)) return;
        Keyboard.dismiss();
        setBusy(true);
        try {
            handle(await totp.continueWith(code));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <Text style={styles.sectionHeader}>COMMUNITY ADMIN</Text>
            <View style={styles.menuGroup}>
                <Pressable
                    style={[styles.menuBtn, styles.menuBtnLast, { minHeight: 48 }]}
                    onPress={onPress}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={`Manage ${name}`}
                    accessibilityHint="Asks for your phone's unlock, then opens the community's admin settings in a browser tab"
                    accessibilityState={{ busy, disabled: busy }}
                >
                    <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🛡️</Text></View>
                    <View style={{ flex: 1 }}>
                        <Text style={styles.menuText}>Manage {name}</Text>
                        <Text style={styles.menuSub}>
                            {role === 'owner' ? "You're an owner" : "You're an admin"} · opens the node's settings, signed in as you
                        </Text>
                    </View>
                    {busy ? <ActivityIndicator size="small" color={colors.brand.primary} /> : <Text style={styles.menuChevron}>›</Text>}
                </Pressable>
            </View>

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
        </>
    );
}
