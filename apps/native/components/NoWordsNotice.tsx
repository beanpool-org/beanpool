/**
 * The line a member reads when this phone holds no 12 words (utils/no-words-copy.ts), and the way on.
 *
 * - `way-back`: where a member with words is told the words are how they get back in.
 * - `before-wipe`: before anything that takes the account off this phone.
 *
 * `action` goes to Account Protection, so the notice is never a dead end on a screen that can reach it.
 * Nothing is fixed-width: at 320dp and 1.3x font the line and the button both wrap.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors as defaultColors, type AppColors } from '../constants/colors';
import { NO_WORDS_WAY_BACK, noWordsBeforeWipe } from '../utils/no-words-copy';

export function NoWordsNotice({
    kind,
    name,
    action,
    colors = defaultColors,
}: {
    kind: 'way-back' | 'before-wipe';
    /** The account's name, for a screen that is about to remove it by name. */
    name?: string;
    action?: { label: string; onPress: () => void };
    /** The screen's theme, where it has one (Settings). */
    colors?: AppColors;
}): React.JSX.Element {
    const warn = kind === 'before-wipe';
    const tone = warn ? colors.feedback.danger : colors.feedback.info;
    return (
        <View style={[styles.box, { backgroundColor: tone.bg, borderColor: tone.border }]}>
            <Text style={[styles.line, { color: warn ? tone.fg : colors.text.body }, warn && styles.bold]}>
                {warn ? `⚠️ ${noWordsBeforeWipe(name)}` : `🔑 ${NO_WORDS_WAY_BACK}`}
            </Text>
            {action && (
                <Pressable
                    style={[styles.btn, { borderColor: tone.border }]}
                    onPress={action.onPress}
                    accessibilityRole="button"
                    accessibilityLabel={action.label}
                >
                    <Text style={[styles.btnText, { color: tone.fg }]}>🛡️ {action.label}</Text>
                </Pressable>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    box: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 10 },
    line: { fontSize: 13, lineHeight: 18 },
    bold: { fontWeight: '600' },
    btn: {
        borderWidth: 1,
        borderRadius: 8,
        minHeight: 44,
        paddingVertical: 10,
        paddingHorizontal: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    btnText: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
});
