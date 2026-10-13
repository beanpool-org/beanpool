/**
 * The new phone's code for an in-person confirmation (path B, scratch/global-node/DESIGN-group-history-after-rekey-fable.md
 * §4; utils/group-history-unlock.ts): this phone's key, the old key from its own succession statement, and its name. A
 * member of the group scans it with "Confirm a member's new phone", in the same room.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { router, ErrorBoundary } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import QRCode from 'react-native-qrcode-svg';
import { useTheme } from './ThemeContext';
import { newPhoneCode, newPhoneConfirmedNotes, newPhoneHandOvers } from '../utils/db';
import { yourGroupsStore } from '../components/useYourGroups';
import { NEW_PHONE_SHOW_BODY, NEW_PHONE_SHOW_TITLE, confirmedByText, type ConfirmedNote } from '../utils/group-history-unlock';

/** How often the open screen looks for a member's hand-over, so the history and the note arrive within seconds of the scan. */
const WATCH_MS = 5000;

export { ErrorBoundary };

export default function NewPhoneCodeScreen() {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const [code, setCode] = useState<string | null | undefined>(undefined);
    const [notes, setNotes] = useState<ConfirmedNote[]>([]);
    const before = useRef<Set<string> | null>(null);

    useEffect(() => {
        newPhoneCode().then(setCode).catch(() => setCode(null));
    }, []);

    // While the code is on screen: what members had handed this phone before, then every few seconds what they have now.
    // A new hand-over is a member's confirmation: kept as this phone's own "Confirmed by" note (§4), never published.
    useEffect(() => {
        if (!code) return;
        let live = true;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const groups = () => (yourGroupsStore.getState().items ?? []).filter((g) => g.kind === 'group').map((g) => ({ id: g.id, name: g.name }));
        const tick = async () => {
            try {
                if (!before.current) before.current = await newPhoneHandOvers(groups());
                const next = await newPhoneConfirmedNotes(before.current, groups());
                if (live) setNotes(next);
            } catch { /* the next look */ }
            if (live) timer = setTimeout(tick, WATCH_MS);
        };
        newPhoneConfirmedNotes(null, []).then((n) => live && setNotes(n)).catch(() => {});
        void tick();
        return () => { live = false; if (timer) clearTimeout(timer); };
    }, [code]);

    return (
        <ScrollView style={{ flex: 1, backgroundColor: colors.surface.app }} contentContainerStyle={[styles.page, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 }]}>
            <Text style={[styles.title, { color: colors.text.heading }]}>{NEW_PHONE_SHOW_TITLE}</Text>
            <Text style={[styles.body, { color: colors.text.secondary }]}>{NEW_PHONE_SHOW_BODY}</Text>
            {code === undefined ? <ActivityIndicator /> : code ? (
                <View style={styles.qrWrap} accessibilityLabel="Your new-phone code">
                    <QRCode value={code} size={240} backgroundColor="#ffffff" color="#000000" />
                </View>
            ) : (
                <Text style={[styles.body, { color: colors.feedback.danger.fg }]}>
                    This phone doesn't know which key it replaced yet. Confirm your re-key when the app asks, then come back.
                </Text>
            )}
            {notes.map((n) => (
                <Text key={`${n.name}-${n.at}`} style={[styles.body, { color: colors.text.body }]} accessibilityLiveRegion="polite">✓ {confirmedByText(n.name, n.at)}</Text>
            ))}
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
