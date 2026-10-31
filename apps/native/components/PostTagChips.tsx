/**
 * A listing's or an event's tags on its detail screen (DESIGN-owner-seeding-tags-fable.md §4.4): each in the member's language,
 * opening the Market filtered by it. A tag this app's library has no label for shows as nothing (§4.3); with none left, no row.
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { postTagsOf, t, tagIndex } from '@beanpool/core';
import { useTheme } from '../app/ThemeContext';

export function PostTagChips({ tags, inset = 0 }: { tags: unknown; inset?: number }) {
    const { colors } = useTheme();
    const index = tagIndex();
    const chips = postTagsOf(tags).flatMap(id => {
        const label = index.label(id);
        return label ? [{ id, label }] : [];
    });
    if (chips.length === 0) return null;
    return (
        <View style={[styles.row, { paddingHorizontal: inset }]} testID="detail-tags-row">
            {chips.map(({ id, label }) => (
                <Pressable
                    key={id}
                    style={[styles.chip, { backgroundColor: colors.surface.app, borderColor: colors.border.default }]}
                    onPress={() => router.push({ pathname: '/(tabs)/market', params: { tag: id } })}
                    accessibilityRole="button"
                    accessibilityLabel={t('Filter marketplace by tag {tag}', { tag: label })}
                >
                    <Text style={[styles.chipText, { color: colors.text.body }]}>{label}</Text>
                </Pressable>
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 16 },
    chip: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 22, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
    chipText: { fontSize: 13, fontWeight: '700' },
});
