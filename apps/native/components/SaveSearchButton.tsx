/**
 * The Market's "Save this search to Home" (Marty, 7 Oct, the Home widgets list): shown while a member has words in the
 * search, it hands the search to Home, which opens the saved search's own sheet with the words, Offers or Needs, the
 * category and the distance filled in (core home-save-search.ts). Nothing is fixed-width: at 320dp and 1.3x font the
 * words wrap, and the whole row is the one target, at least 48 high. Colours are the library's accent roles.
 */
import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { SAVE_SEARCH_BUTTON, saveSearchLabel } from '@beanpool/core';
import { colors as defaultColors, type AppColors } from '../constants/colors';

export function SaveSearchButton({ q, onPress, colors = defaultColors }: { q: string; onPress: () => void; colors?: AppColors }): React.JSX.Element {
    return (
        <Pressable
            style={({ pressed }) => [styles.box, { backgroundColor: colors.accent.tint, borderColor: colors.accent.border, opacity: pressed ? 0.85 : 1 }]}
            onPress={onPress}
            accessibilityRole="button"
            accessibilityLabel={saveSearchLabel(q)}
            testID="market-save-search"
        >
            <Text style={[styles.icon, { color: colors.accent.primary }]} importantForAccessibility="no" accessibilityElementsHidden>＋</Text>
            <Text style={[styles.line, { color: colors.accent.primary }]}>{SAVE_SEARCH_BUTTON}</Text>
        </Pressable>
    );
}

const styles = StyleSheet.create({
    box: { borderWidth: 1, borderRadius: 12, paddingVertical: 10, paddingHorizontal: 12, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 8 },
    icon: { fontSize: 16, fontWeight: '800' },
    line: { flex: 1, fontSize: 14, lineHeight: 19, fontWeight: '700' },
});
