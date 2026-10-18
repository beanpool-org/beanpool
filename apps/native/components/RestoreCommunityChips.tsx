import { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useWords } from './LanguageProvider';
import { useOnboardingColors } from '../app/ThemeContext';
import { palette, type AppColors } from '../constants/colors';
import type { SavedNode } from '../utils/nodes';
import { chosenRestoreChoice, restoreCommunityChoices } from '../utils/restore-community-choices';

/**
 * "Which community?" above the 12-words restore's address field (utils/restore-community-choices.ts; DESIGN-global-entry-
 * fable.md §A row 8, decision 5): **Global community**, each community saved on this phone, then **another address**. A
 * chip puts its address in the field; **another address** empties a chip's address out of it and hands the field the
 * keyboard (`onAnother`), and shows chosen while the field holds an address no chip has. Nothing is sent by a tap.
 *
 * Chips wrap, so at 320 dp with text at 1.3× a long community name takes its own line rather than running off the edge.
 */
export function RestoreCommunityChips({ saved, value, onChoose, onAnother, disabled }: {
    saved: readonly SavedNode[];
    /** What the address field holds now. */
    value: string;
    /** A chip was tapped: the field's new text. */
    onChoose(text: string): void;
    /** "another address" was tapped: the field's new text (emptied of a chip's address, else as it was), then the keyboard. */
    onAnother(text: string): void;
    disabled?: boolean;
}) {
    const { t } = useWords();
    const { colors, dark } = useOnboardingColors();
    const styles = useMemo(() => makeStyles(colors, dark), [colors, dark]);
    const choices = useMemo(() => restoreCommunityChoices(saved), [saved]);
    const chosen = chosenRestoreChoice(value, choices);
    const chip = (key: string, label: string, selected: boolean, onPress: () => void) => (
        <Pressable
            key={key}
            style={[styles.chip, selected && styles.chipSelected]}
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled: !!disabled }}
            accessibilityLabel={label}
        >
            <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
        </Pressable>
    );
    return (
        <View style={styles.wrap}>
            <Text style={styles.label} accessibilityRole="header">{t('Which community?')}</Text>
            <View style={styles.chips}>
                {choices.map((c) => chip(
                    c.url,
                    c.kind === 'global' ? t('Global community') : c.name,
                    chosen !== null && chosen !== 'another' && chosen.url === c.url,
                    () => onChoose(c.fills),
                ))}
                {chip('another', t('another address'), chosen === 'another', () => onAnother(chosen === 'another' ? value : ''))}
            </View>
        </View>
    );
}

function makeStyles(colors: AppColors, dark: boolean) {
    return StyleSheet.create({
        wrap: { marginBottom: 10 },
        label: { fontSize: 14, color: dark ? colors.text.body : palette.gray700, fontWeight: '600', marginBottom: 8 },
        chips: { flexDirection: 'row', flexWrap: 'wrap' },
        chip: {
            minHeight: 48, justifyContent: 'center', paddingHorizontal: 14, paddingVertical: 8, marginRight: 8, marginBottom: 8,
            backgroundColor: colors.surface.app, borderRadius: 999, borderWidth: 1, borderColor: colors.border.default,
        },
        chipSelected: { borderColor: dark ? palette.blue400 : palette.blue600 },
        chipText: { color: colors.text.body, fontSize: 15, fontWeight: '600' },
        chipTextSelected: { color: colors.text.heading, fontWeight: '700' },
    });
}
