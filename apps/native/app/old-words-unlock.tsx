/**
 * The old 12 words bring back a member's group history from before they changed phones (path A,
 * scratch/global-node/DESIGN-group-history-after-rekey-fable.md §3; utils/group-history-unlock.ts). The words are typed
 * here, box by box as on the restore screen (RecoveryWordsEntry), held in this screen's state for the one run and cleared
 * when it starts: never sent, never stored.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { router, ErrorBoundary } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './ThemeContext';
import { palette } from '../constants/colors';
import { unlockGroupHistoryWithWords } from '../utils/db';
import { yourGroupsStore } from '../components/useYourGroups';
import { RecoveryWordsEntry } from '../components/RecoveryWordsEntry';
import {
    OLD_WORDS_DONE, OLD_WORDS_NOT_THE_KEY, OLD_WORDS_OWNER, LOCKED_HISTORY_WORDS, oldWordsProgressText, oldWordsWithheldText,
} from '../utils/group-history-unlock';

export { ErrorBoundary };

/** The primary button's green: white on it is 5.5:1, where on brand.primary (emerald-500) it is 2.5:1 (e2e/locked-history-320.mjs). */
const BUTTON_GREEN = palette.emerald700;

export default function OldWordsUnlockScreen() {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const [words, setWords] = useState<string[]>(() => Array(12).fill(''));
    const typedAny = words.some((w) => w.trim());
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<string | null>(null);
    const [outcome, setOutcome] = useState<{ text: string; lines: string[]; ok: boolean } | null>(null);

    const run = async () => {
        if (busy) return;
        setBusy(true);
        setOutcome(null);
        const typed = words;
        setWords(Array(12).fill(''));
        try {
            const groups = (yourGroupsStore.getState().items ?? []).filter((g) => g.kind === 'group').map((g) => ({ id: g.id, name: g.name }));
            const r = await unlockGroupHistoryWithWords(typed, groups, (d, t) => setProgress(oldWordsProgressText(d, t)));
            if (r.outcome === 'not_the_key') setOutcome({ text: OLD_WORDS_NOT_THE_KEY, lines: [], ok: false });
            else if (r.outcome === 'owner') setOutcome({ text: OLD_WORDS_OWNER, lines: [], ok: false });
            else setOutcome({ text: OLD_WORDS_DONE, lines: r.withheld.map((g) => oldWordsWithheldText(g.name)), ok: true });
        } catch (e: any) {
            setOutcome({ text: e?.message || 'Something went wrong. Try again in a moment.', lines: [], ok: false });
        } finally {
            setProgress(null);
            setBusy(false);
        }
    };

    return (
        <ScrollView style={{ flex: 1, backgroundColor: colors.surface.app }} contentContainerStyle={[styles.page, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 }]}
            keyboardShouldPersistTaps="handled">
            <Text style={[styles.title, { color: colors.text.heading }]}>{LOCKED_HISTORY_WORDS}</Text>
            <Text style={[styles.body, { color: colors.text.secondary }]}>
                Type the 12 words of the key this account used before you changed phones. They open your earlier messages on this phone and are never sent or kept.
            </Text>
            <View>
                <RecoveryWordsEntry words={words} onChange={setWords} editable={!busy} label="Your old 12 words." colors={colors} />
            </View>
            <Pressable style={[styles.primaryBtn, { backgroundColor: BUTTON_GREEN, opacity: busy || !typedAny ? 0.6 : 1 }]}
                onPress={run} disabled={busy || !typedAny} accessibilityRole="button">
                {busy ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={[styles.primaryText, { color: colors.text.inverse }]}>Unlock earlier messages</Text>}
            </Pressable>
            {!!progress && <Text style={[styles.body, { color: colors.text.secondary }]} accessibilityLiveRegion="polite">{progress}</Text>}
            {!!outcome && (
                <View style={[styles.box, { borderColor: outcome.ok ? colors.border.default : colors.feedback.danger.solid }]} accessibilityLiveRegion="polite">
                    <Text style={[styles.boxText, { color: outcome.ok ? colors.text.body : colors.feedback.danger.fg }]}>{outcome.text}</Text>
                    {outcome.lines.map((l) => <Text key={l} style={[styles.boxText, { color: colors.text.secondary }]}>{l}</Text>)}
                </View>
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
    primaryBtn: { minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
    primaryText: { fontSize: 16, fontWeight: '800', textAlign: 'center' },
    box: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 6 },
    boxText: { fontSize: 15, lineHeight: 21 },
    secondaryBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
    secondaryText: { fontSize: 15, fontWeight: '700' },
});
