import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { brandSwatch, lookSwatchSets, t } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import { THEME_PREFERENCE_OPTIONS, type ThemePreference } from '../utils/theme-preference';

/**
 * Settings -> Appearance: the look, as one list of four rows (Same as phone, Classic, Light, Dark). A tap applies it at
 * once; there is no Save. Each row is a radio: its dots (the page, the card and the accent, read from the colour library for
 * that look, so the swatch cannot drift from the real colours), its name, a line under it, and a tick when it is the
 * chosen one. The chosen row also has a border in the heading's ink, so the choice never rests on colour alone.
 *
 * Rows are at least 48 dp tall and full width, and their words wrap rather than truncate (320 dp wide at 1.3x text, and in
 * the longest language). A screen reader hears the name, then the line as its hint, then whether it is selected. The
 * dots and the tick are decoration and are hidden from it.
 */
export function AppearanceChoice({ value, onChange }: { value: ThemePreference; onChange: (next: ThemePreference) => void }) {
    const styles = useStyles(({ colors }) => StyleSheet.create({
        list: { marginTop: 12, gap: 6 },
        row: {
            flexDirection: 'row', alignItems: 'center', minHeight: 48,
            paddingHorizontal: 12, paddingVertical: 8, borderRadius: 12,
            borderWidth: 2, borderColor: colors.border.default,
        },
        rowSelected: { borderColor: colors.text.heading, backgroundColor: colors.surface.subtle },
        // The dots overlap, like a stack of avatars, so the words keep the room at 320 dp with 1.3x text; the column is as wide for
        // every row (three dots: 14 + 8 + 8), so the names line up.
        dots: { flexDirection: 'row', alignItems: 'center', width: 30, marginRight: 10 },
        dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1, borderColor: colors.border.strong },
        dotOverlap: { marginLeft: -6 },
        text: { flex: 1 },
        name: { fontSize: 15, fontWeight: '700', color: colors.text.heading },
        line: { fontSize: 12, marginTop: 1, color: colors.text.secondary },
        tick: { width: 18, marginLeft: 6, textAlign: 'center', fontSize: 16, fontWeight: '700', color: colors.text.heading },
    }));

    return (
        <View style={styles.list} accessibilityRole="radiogroup" accessibilityLabel={t('Appearance')}>
            {THEME_PREFERENCE_OPTIONS.map((option) => {
                const selected = value === option.value;
                // One look shows three dots (page, card, accent); Same as phone shows the two pages it can be.
                const sets = lookSwatchSets(option.value);
                const dots = sets.flatMap((set) => {
                    const swatch = brandSwatch(set, 'phone');
                    return sets.length === 1 ? [swatch.page, swatch.card, swatch.accent] : [swatch.page];
                });
                return (
                    <Pressable
                        key={option.value}
                        style={[styles.row, selected && styles.rowSelected]}
                        accessibilityRole="radio"
                        accessibilityLabel={t(option.label)}
                        accessibilityHint={t(option.line)}
                        accessibilityState={{ checked: selected }}
                        onPress={() => onChange(option.value)}
                    >
                        <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                            {dots.map((hex, i) => <View key={i} style={[styles.dot, i > 0 && styles.dotOverlap, { backgroundColor: hex }]} />)}
                        </View>
                        <View style={styles.text}>
                            <Text style={styles.name}>{t(option.label)}</Text>
                            <Text style={styles.line}>{t(option.line)}</Text>
                        </View>
                        <Text style={styles.tick} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">{selected ? '✓' : ''}</Text>
                    </Pressable>
                );
            })}
        </View>
    );
}
