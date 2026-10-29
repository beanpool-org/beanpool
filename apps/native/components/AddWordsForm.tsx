/**
 * "Add your 12 words to this phone": twelve boxes, checked against the word list as the member types, and a
 * save that keeps the words only if they make this account's key (utils/add-words.ts, identity.ts
 * `addMnemonicToIdentity`). Nothing is sent anywhere.
 *
 * Two columns rather than three: the phrase screen shows the words two to a row, and at 320dp with a 1.3x
 * font an eight-letter word needs the width. Nothing is fixed-height; the status line and the buttons wrap.
 *
 * utils/add-words.ts is on the 12 words' key path and never reaches the words layer, so its sentences are shown here in
 * the member's language: each ADD_WORDS_COPY line by its exact English (a line that reads otherwise is shown as it is),
 * and the status line again from the check's counts and box numbers, never from a word typed
 * (utils/__tests__/key-components-words-render.test.ts holds both to add-words.ts).
 */
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { colors as defaultColors, type AppColors } from '../constants/colors';
import { addMnemonicToIdentity, type BeanPoolIdentity } from '../utils/identity';
import { NoScreenCapture } from './WordsOnScreen';
import {
    ADD_WORDS_COPY,
    applyWordBoxChange,
    checkWordBoxes,
    emptyWordBoxes,
    wordBoxesFromPaste,
    type WordBoxesCheck,
} from '../utils/add-words';
import { settingsLineWords } from './settings/settings-lines';
import { formatNumber, t, word, type WordKey } from '@beanpool/core';

/** ADD_WORDS_COPY's lines this form shows (the intro is no-words-copy.ts's, which Settings' lines translate). */
const ADD_WORDS_WORDS = {
    title: word('Add your 12 words to this phone'),
    submit: word('Add these words'),
    checking: word('Checking…'),
    cancel: word('Cancel'),
    mismatch: word('Those 12 words belong to a different account. Nothing on this phone has changed.'),
    malformed: word('Those are not 12 words from the list. Nothing on this phone has changed.'),
    failed: word('The words could not be saved on this phone. Nothing has changed. Try again.'),
} as const satisfies Partial<Record<keyof typeof ADD_WORDS_COPY, WordKey>>;

/** One ADD_WORDS_COPY line in the member's language, when it reads as this form knows it. */
export function addWordsLine(which: keyof typeof ADD_WORDS_WORDS): string {
    return ADD_WORDS_WORDS[which] === ADD_WORDS_COPY[which] ? t(ADD_WORDS_WORDS[which]) : ADD_WORDS_COPY[which];
}

/** add-words.ts wordBoxesStatus, in the member's language: box numbers and counts only. */
export function wordBoxesStatusWords(check: WordBoxesCheck): string {
    if (check.unknown.length === 1) {
        return t('Word {n} is not on the list of recovery words. Check the spelling.', { n: check.unknown[0] });
    }
    if (check.unknown.length > 1) {
        return t('Words {numbers} are not on the list of recovery words. Check the spelling.', { numbers: check.unknown.map((n) => formatNumber(n)).join(', ') });
    }
    if (check.ready) return t('All 12 words are on the list.');
    return t('{n} of 12 words.', { n: check.listed });
}

export function AddWordsForm({
    onAdded,
    onCancel,
    colors = defaultColors,
}: {
    /** The words were saved: the identity as it now is, with them. */
    onAdded: (identity: BeanPoolIdentity) => void;
    onCancel: () => void;
    colors?: AppColors;
}): React.JSX.Element {
    const [boxes, setBoxes] = useState<string[]>(emptyWordBoxes);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const check = useMemo(() => checkWordBoxes(boxes), [boxes]);

    const change = (next: string[]) => {
        setBoxes(next);
        setError(null);
    };

    const paste = async () => {
        try {
            const text = await Clipboard.getStringAsync();
            if (text?.trim()) change(wordBoxesFromPaste(text));
        } catch { /* clipboard unavailable: the member can still type */ }
    };

    const submit = async () => {
        if (!check.ready || busy) return;
        setBusy(true);
        setError(null);
        try {
            const result = await addMnemonicToIdentity(boxes);
            if (result.ok) {
                setBoxes(emptyWordBoxes());
                onAdded(result.identity);
                return;
            }
            setError(result.reason === 'mismatch' ? addWordsLine('mismatch')
                : result.reason === 'malformed' ? addWordsLine('malformed')
                    : addWordsLine('failed'));
        } catch {
            setError(addWordsLine('failed'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <View style={styles.wrap}>
            <Text style={[styles.title, { color: colors.text.heading }]} accessibilityRole="header">
                {addWordsLine('title')}
            </Text>
            <Text style={[styles.intro, { color: colors.text.secondary }]}>{settingsLineWords(ADD_WORDS_COPY.intro)}</Text>

            <Pressable
                style={[styles.pasteBtn, { borderColor: colors.border.strong, backgroundColor: colors.surface.subtle }]}
                onPress={paste}
                accessibilityRole="button"
                accessibilityLabel={t('Paste your 12 words')}
            >
                <Text style={[styles.pasteText, { color: colors.text.body }]}>{t('📋 Paste')}</Text>
            </Pressable>

            <View style={styles.grid}>
                {/* The boxes show the words as they are typed. */}
                <NoScreenCapture>
                {boxes.map((word, i) => {
                    const state = check.states[i];
                    const bad = state === 'unknown';
                    return (
                        <View
                            key={i}
                            style={[
                                styles.box,
                                { backgroundColor: colors.surface.card, borderColor: bad ? colors.feedback.danger.solid : colors.border.strong },
                            ]}
                        >
                            <Text style={[styles.num, { color: colors.text.muted }]} importantForAccessibility="no" accessibilityElementsHidden>
                                {i + 1}.
                            </Text>
                            <TextInput
                                style={[styles.input, { color: colors.text.heading }]}
                                value={word}
                                onChangeText={(t) => change(applyWordBoxChange(boxes, i, t))}
                                accessibilityLabel={t('Word {n}', { n: i + 1 })}
                                accessibilityHint={bad ? t('Not on the list of recovery words') : undefined}
                                autoCapitalize="none"
                                autoCorrect={false}
                                spellCheck={false}
                                autoComplete="off"
                                importantForAutofill="no"
                                // Android: no suggestion strip, and nothing learned from what is typed.
                                keyboardType={Platform.OS === 'android' ? 'visible-password' : 'default'}
                                editable={!busy}
                            />
                        </View>
                    );
                })}
                </NoScreenCapture>
            </View>

            <Text
                style={[styles.status, { color: check.unknown.length ? colors.feedback.danger.fg : colors.text.secondary }]}
                accessibilityLiveRegion="polite"
            >
                {wordBoxesStatusWords(check)}
            </Text>

            {error && (
                <View style={[styles.errorBox, { backgroundColor: colors.feedback.danger.bg, borderColor: colors.feedback.danger.border }]}>
                    <Text style={[styles.errorText, { color: colors.feedback.danger.fg }]} accessibilityLiveRegion="assertive">
                        {error}
                    </Text>
                </View>
            )}

            <Pressable
                style={[styles.submit, { backgroundColor: colors.brand.fill }, (!check.ready || busy) && styles.disabled]}
                onPress={submit}
                disabled={!check.ready || busy}
                accessibilityRole="button"
                accessibilityLabel={busy ? addWordsLine('checking') : addWordsLine('submit')}
                accessibilityHint={t('Saves recovery words to this device')}
                accessibilityState={{ disabled: !check.ready || busy, busy }}
            >
                {busy
                    ? <ActivityIndicator color={colors.text.onBrand} />
                    : <Text style={[styles.submitText, { color: colors.text.onBrand }]}>{addWordsLine('submit')}</Text>}
            </Pressable>
            <Pressable style={styles.cancel} onPress={onCancel} accessibilityRole="button" disabled={busy}>
                <Text style={[styles.cancelText, { color: colors.text.secondary }]}>{addWordsLine('cancel')}</Text>
            </Pressable>
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: { marginTop: 16 },
    title: { fontSize: 16, fontWeight: '700', marginBottom: 6 },
    intro: { fontSize: 13, lineHeight: 18, marginBottom: 10 },
    pasteBtn: {
        alignSelf: 'flex-start', borderWidth: 1, borderRadius: 8, minHeight: 44,
        paddingHorizontal: 14, paddingVertical: 10, justifyContent: 'center', marginBottom: 10,
    },
    pasteText: { fontSize: 14, fontWeight: '600' },
    grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
    box: {
        width: '48%', flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 8,
        paddingLeft: 8, marginBottom: 8, minHeight: 44,
    },
    num: { fontSize: 12, minWidth: 22 },
    input: { flex: 1, fontSize: 15, paddingVertical: 8, paddingRight: 8 },
    status: { fontSize: 13, lineHeight: 18, marginTop: 2, marginBottom: 10 },
    errorBox: { borderWidth: 1, borderRadius: 8, padding: 10, marginBottom: 10 },
    errorText: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
    submit: { minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 12 },
    submitText: { fontSize: 16, fontWeight: '700', textAlign: 'center' },
    disabled: { opacity: 0.5 },
    cancel: { alignItems: 'center', padding: 10, marginTop: 4 },
    cancelText: { fontSize: 14, fontWeight: '600' },
});
