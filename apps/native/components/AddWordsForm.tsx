/**
 * "Add your 12 words to this phone": twelve boxes, checked against the word list as the member types, and a
 * save that keeps the words only if they make this account's key (utils/add-words.ts, identity.ts
 * `addMnemonicToIdentity`). Nothing is sent anywhere.
 *
 * Two columns rather than three: the phrase screen shows the words two to a row, and at 320dp with a 1.3x
 * font an eight-letter word needs the width. Nothing is fixed-height; the status line and the buttons wrap.
 */
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { colors as defaultColors, type AppColors } from '../constants/colors';
import { addMnemonicToIdentity, type BeanPoolIdentity } from '../utils/identity';
import {
    ADD_WORDS_COPY,
    applyWordBoxChange,
    checkWordBoxes,
    emptyWordBoxes,
    wordBoxesFromPaste,
    wordBoxesStatus,
} from '../utils/add-words';

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
            setError(result.reason === 'mismatch' ? ADD_WORDS_COPY.mismatch
                : result.reason === 'malformed' ? ADD_WORDS_COPY.malformed
                    : ADD_WORDS_COPY.failed);
        } catch {
            setError(ADD_WORDS_COPY.failed);
        } finally {
            setBusy(false);
        }
    };

    return (
        <View style={styles.wrap}>
            <Text style={[styles.title, { color: colors.text.heading }]} accessibilityRole="header">
                {ADD_WORDS_COPY.title}
            </Text>
            <Text style={[styles.intro, { color: colors.text.secondary }]}>{ADD_WORDS_COPY.intro}</Text>

            <Pressable
                style={[styles.pasteBtn, { borderColor: colors.border.strong, backgroundColor: colors.surface.subtle }]}
                onPress={paste}
                accessibilityRole="button"
                accessibilityLabel="Paste your 12 words"
            >
                <Text style={[styles.pasteText, { color: colors.text.body }]}>📋 {ADD_WORDS_COPY.paste}</Text>
            </Pressable>

            <View style={styles.grid}>
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
                                accessibilityLabel={`Word ${i + 1}`}
                                accessibilityHint={bad ? 'Not on the list of recovery words' : undefined}
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
            </View>

            <Text
                style={[styles.status, { color: check.unknown.length ? colors.feedback.danger.fg : colors.text.secondary }]}
                accessibilityLiveRegion="polite"
            >
                {wordBoxesStatus(check)}
            </Text>

            {error && (
                <View style={[styles.errorBox, { backgroundColor: colors.feedback.danger.bg, borderColor: colors.feedback.danger.border }]}>
                    <Text style={[styles.errorText, { color: colors.feedback.danger.fg }]} accessibilityLiveRegion="assertive">
                        {error}
                    </Text>
                </View>
            )}

            <Pressable
                style={[styles.submit, { backgroundColor: colors.text.heading }, (!check.ready || busy) && styles.disabled]}
                onPress={submit}
                disabled={!check.ready || busy}
                accessibilityRole="button"
                accessibilityState={{ disabled: !check.ready || busy, busy }}
            >
                {busy
                    ? <ActivityIndicator color={colors.text.inverse} accessibilityLabel={ADD_WORDS_COPY.checking} />
                    : <Text style={[styles.submitText, { color: colors.text.inverse }]}>{ADD_WORDS_COPY.submit}</Text>}
            </Pressable>
            <Pressable style={styles.cancel} onPress={onCancel} accessibilityRole="button" disabled={busy}>
                <Text style={[styles.cancelText, { color: colors.text.secondary }]}>{ADD_WORDS_COPY.cancel}</Text>
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
