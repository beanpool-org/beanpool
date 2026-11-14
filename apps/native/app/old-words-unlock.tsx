/**
 * The old 12 words bring back a member's group history from before they changed phones (path A,
 * scratch/global-node/DESIGN-group-history-after-rekey-fable.md §3; utils/group-history-unlock.ts). The words are typed
 * here, box by box as on the restore screen (RecoveryWordsEntry), held in this screen's state for the one run and cleared
 * when it starts: never sent, never stored.
 *
 * The same words open the member's old contacts list too (private contacts C6, DESIGN-private-contacts-fable.md §6.2;
 * utils/contacts-former.ts): each community keeps it a year after a re-key, and its people are merged into the list on this
 * phone. Opened from Contacts (`?for=contacts`) the screen opens only the list, in its words; opened from a group chat it
 * unlocks the history, then merges an old list too when one opens, and says so in one more line.
 */
import React, { useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet, DeviceEventEmitter } from 'react-native';
import { router, ErrorBoundary, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from './ThemeContext';
import { lockedHistoryRows, unlockGroupHistoryWithWords } from '../utils/db';
import { yourGroupsStore } from '../components/useYourGroups';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { RecoveryWordsEntry } from '../components/RecoveryWordsEntry';
import { LOCKED_HISTORY_WORDS } from '../utils/group-history-unlock';
import { keyLineWords, oldWordsEndWords, oldWordsProgressWords } from '../components/key-lines';
import { CONTACTS_FORMER_CHANGED_EVENT, openFormerWithWords } from '../utils/contacts-former';
import { phoneSyncDeps } from '../utils/contacts-sync';
import { useIdentity } from './IdentityContext';
import { formerContactsEndWords, formerContactsWords, t } from '@beanpool/core';

export { ErrorBoundary };


export default function OldWordsUnlockScreen() {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const { identity } = useIdentity();
    // Opened from Contacts: the old contacts list only (C6).
    const forContacts = useLocalSearchParams<{ for?: string }>().for === 'contacts';
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
            if (forContacts) {
                if (!identity) throw new Error(t('Something went wrong. Try again in a moment.'));
                setProgress(formerContactsWords.busy());
                const r = await openFormerWithWords(typed, identity, phoneSyncDeps());
                // Contacts, under this screen, asks again: a merge goes from its notice even when it added nobody new.
                DeviceEventEmitter.emit(CONTACTS_FORMER_CHANGED_EVENT);
                setOutcome({ ...formerContactsEndWords(r), lines: [] });
                return;
            }
            // Each group with the lines its chat last showed locked, so one the node answers empty is named, never "Done".
            const locked = await lockedHistoryRows().catch(() => ({} as Record<string, number>));
            const groups = (yourGroupsStore.getState().items ?? []).filter((g) => g.kind === 'group')
                .map((g) => ({ id: g.id, name: g.name, locked: locked[g.id.toLowerCase()] ?? 0 }));
            const r = await unlockGroupHistoryWithWords(typed, groups, (d, total) => setProgress(oldWordsProgressWords(d, total)));
            setOutcome(oldWordsEndWords(r));
            // The same words may open an old contacts list (C6): merged in, and said in one more line; nothing said otherwise,
            // and nothing it does can change what was said of the groups.
            if (identity) {
                const contacts = await Promise.resolve().then(() => openFormerWithWords(typed, identity, phoneSyncDeps())).catch(() => null);
                if (contacts) DeviceEventEmitter.emit(CONTACTS_FORMER_CHANGED_EVENT);
                if (contacts?.kind === 'merged') {
                    const line = formerContactsEndWords(contacts).text;
                    setOutcome((o) => (o ? { ...o, lines: [...o.lines, line] } : o));
                }
            }
        } catch (e: any) {
            setOutcome({ text: e?.message ? keyLineWords(e.message) : t('Something went wrong. Try again in a moment.'), lines: [], ok: false });
        } finally {
            setProgress(null);
            setBusy(false);
        }
    };

    return (
        // The twelve boxes are mid-page: the scroll view keeps the box being typed in above the keyboard.
        <KeyboardAwareScrollView style={{ flex: 1, backgroundColor: colors.surface.app }} contentContainerStyle={[styles.page, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24 }]}
            keyboardShouldPersistTaps="handled" bottomOffset={24}>
            <Text style={[styles.title, { color: colors.text.heading }]}>{forContacts ? formerContactsWords.title() : keyLineWords(LOCKED_HISTORY_WORDS)}</Text>
            <Text style={[styles.body, { color: colors.text.secondary }]}>
                {forContacts ? formerContactsWords.body() : t('Type the 12 words of the key this account used before you changed phones. They open your earlier messages on this phone and are never sent or kept.')}
            </Text>
            <View>
                <RecoveryWordsEntry words={words} onChange={setWords} editable={!busy} label={t('Your old 12 words.')} colors={colors} />
            </View>
            <Pressable style={[styles.primaryBtn, { backgroundColor: colors.brand.fill, opacity: busy || !typedAny ? 0.6 : 1 }]}
                onPress={run} disabled={busy || !typedAny} accessibilityRole="button"
                accessibilityLabel={forContacts ? (busy ? formerContactsWords.busy() : formerContactsWords.button()) : busy ? t('Unlocking earlier messages...') : t('Unlock earlier messages')}
                accessibilityHint={forContacts ? undefined : t('Verifies the 12 words and unlocks group chat history')}
                accessibilityState={{ disabled: busy || !typedAny, busy }}>
                {busy ? <ActivityIndicator color={colors.text.inverse} /> : <Text style={[styles.primaryText, { color: colors.text.inverse }]}>{forContacts ? formerContactsWords.button() : t('Unlock earlier messages')}</Text>}
            </Pressable>
            {!!progress && <Text style={[styles.body, { color: colors.text.secondary }]} accessibilityLiveRegion="polite">{progress}</Text>}
            {!!outcome && (
                <View style={[styles.box, { borderColor: outcome.ok ? colors.border.default : colors.feedback.danger.solid }]} accessibilityLiveRegion="polite">
                    <Text style={[styles.boxText, { color: outcome.ok ? colors.text.body : colors.feedback.danger.fg }]}>{outcome.text}</Text>
                    {outcome.lines.map((l) => <Text key={l} style={[styles.boxText, { color: colors.text.secondary }]}>{l}</Text>)}
                </View>
            )}
            <Pressable style={styles.secondaryBtn} onPress={() => router.back()} accessibilityRole="button">
                <Text style={[styles.secondaryText, { color: colors.text.secondary }]}>{t('Back')}</Text>
            </Pressable>
        </KeyboardAwareScrollView>
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
