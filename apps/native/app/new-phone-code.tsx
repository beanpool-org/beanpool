/**
 * The new phone's code for an in-person confirmation (path B, scratch/global-node/DESIGN-group-history-after-rekey-fable.md
 * §4; utils/group-history-unlock.ts): this phone's key, the old key from its own succession statement, and its name. A
 * member of the group scans it with "Confirm a member's new phone", in the same room.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { router, ErrorBoundary } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { useTheme } from './ThemeContext';
import { newPhoneCode } from '../utils/db';
import { NEW_PHONE_SHOW_BODY, NEW_PHONE_SHOW_TITLE } from '../utils/group-history-unlock';

export { ErrorBoundary };

export default function NewPhoneCodeScreen() {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const [code, setCode] = useState<string | null | undefined>(undefined);

    useEffect(() => {
        newPhoneCode().then(setCode).catch(() => setCode(null));
    }, []);

    return (
        <ScrollView style={{ flex: 1, backgroundColor: colors.surface.app }} contentContainerStyle={[styles.page, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 }]}>
            <Text style={[styles.title, { color: colors.text.heading }]}>{NEW_PHONE_SHOW_TITLE}</Text>
            <Text style={[styles.body, { color: colors.text.secondary }]}>{NEW_PHONE_SHOW_BODY}</Text>
            {code === undefined ? <ActivityIndicator /> : code ? (
                <View style={styles.qrWrap} accessibilityLabel="Your new-phone code">
                    <QRCode value={code} size={240} backgroundColor="#ffffff" color="#000000" />
                </View>
            ) : (
                <Text style={[styles.body, { color: colors.feedback.danger.solid }]}>
                    This phone doesn't know which key it replaced yet. Confirm your re-key when the app asks, then come back.
                </Text>
            )}
            <Pressable style={styles.secondaryBtn} onPress={() => router.back()} accessibilityRole="button">
                <Text style={[styles.secondaryText, { color: colors.text.secondary }]}>Back</Text>
            </Pressable>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    page: { paddingHorizontal: 16, gap: 12 },
    title: { fontSize: 19, fontWeight: '800' },
    body: { fontSize: 15, lineHeight: 21 },
    qrWrap: { alignSelf: 'center', padding: 16, borderRadius: 16, backgroundColor: '#ffffff' },
    secondaryBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
    secondaryText: { fontSize: 15, fontWeight: '700' },
});
