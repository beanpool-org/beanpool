import React from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, type StyleProp, type TextStyle } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { colors as lightColors, type AppColors } from '../constants/colors';
import { NoScreenCapture } from './WordsOnScreen';

/**
 * The 12 recovery words, one box each, as the restore screen takes them (welcome.tsx, "Recover Identity"); the old-words
 * unlock (old-words-unlock.tsx) takes them the same way. Typing or pasting the whole phrase into any box fans it out
 * across all 12; a single word fills its box; "📋 Paste" reads the clipboard. The boxes show the words as they are typed,
 * so they are kept out of screenshots.
 */

/** The 12 boxes after `text` was typed into box `i`: a whole phrase fans out from the first box, one word fills its box. */
export function wordsAfterTyping(words: readonly string[], i: number, text: string): string[] {
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 1) return wordsFromText(text) ?? [...words];
    const updated = [...words];
    updated[i] = text.toLowerCase().trim();
    return updated;
}

/** The 12 boxes from a pasted phrase, or null when it holds no word. */
export function wordsFromText(text: string): string[] | null {
    const tokens = (text || '').trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return null;
    const updated: string[] = Array(12).fill('');
    tokens.slice(0, 12).forEach((w, idx) => { updated[idx] = w.toLowerCase(); });
    return updated;
}

export function RecoveryWordsEntry({ words, onChange, label = 'Enter your 12 recovery words.', labelStyle, editable = true, colors = lightColors }: {
    words: readonly string[];
    onChange: (words: string[]) => void;
    label?: string;
    labelStyle?: StyleProp<TextStyle>;
    editable?: boolean;
    colors?: AppColors;
}) {
    return (
        <>
            <View style={styles.head}>
                <Text style={[{ fontSize: 14, lineHeight: 20, color: colors.text.secondary }, labelStyle, styles.label]}>{label}</Text>
                <Pressable
                    style={[styles.pasteBtn, { backgroundColor: colors.surface.subtle, borderColor: colors.border.strong }]}
                    disabled={!editable}
                    onPress={async () => {
                        try {
                            const updated = wordsFromText(await Clipboard.getStringAsync());
                            if (updated) onChange(updated);
                        } catch { /* clipboard unavailable — the words can still be typed */ }
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Paste 12 recovery words"
                >
                    <Text style={[styles.pasteBtnText, { color: colors.text.body }]}>📋 Paste</Text>
                </Pressable>
            </View>
            <View style={styles.grid}>
                <NoScreenCapture>
                    {words.map((word, i) => (
                        <TextInput
                            key={i}
                            accessibilityLabel={`Recovery word ${i + 1}`}
                            style={[styles.input, { backgroundColor: colors.surface.card, borderColor: colors.border.strong, color: colors.text.heading }]}
                            value={word}
                            onChangeText={(t) => onChange(wordsAfterTyping(words, i, t))}
                            editable={editable}
                            placeholder={`${i + 1}`}
                            placeholderTextColor={colors.text.muted}
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoComplete="off"
                            importantForAutofill="no"
                            spellCheck={false}
                        />
                    ))}
                </NoScreenCapture>
            </View>
        </>
    );
}

const styles = StyleSheet.create({
    head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 },
    label: { flex: 1, marginBottom: 0 },
    pasteBtn: { paddingHorizontal: 16, paddingVertical: 12, borderLeftWidth: 1, justifyContent: 'center', minHeight: 48 },
    pasteBtnText: { fontSize: 14, fontWeight: '600' },
    grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginBottom: 16 },
    input: { width: '31%', borderWidth: 1, borderRadius: 8, padding: 8, fontSize: 12, marginBottom: 8, textAlign: 'center' },
});
