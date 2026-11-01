/**
 * A listing's or an event's tags on its detail screen (DESIGN-owner-seeding-tags-fable.md §4.4): each in the member's language,
 * opening the Market filtered by it. A tag this app's library has no label for shows as nothing (§4.3); with none left, no row.
 * The tags its author typed follow as `#word`, as typed, each opening the Market with exactly that tag
 * (DESIGN-tags-free-entry-fable.md §4).
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { freeTagsOf, postTagsOf, t, tagIndex } from '@beanpool/core';
import { useTheme } from '../app/ThemeContext';

export function PostTagChips({ tags, freeTags, inset = 0 }: { tags: unknown; freeTags?: unknown; inset?: number }) {
    const { colors } = useTheme();
    const index = tagIndex();
    const chips = postTagsOf(tags).flatMap(id => {
        const label = index.label(id);
        return label ? [{ id, label }] : [];
    });
    const typed = freeTagsOf(freeTags);
    if (chips.length === 0 && typed.length === 0) return null;
    return (
        <View style={[styles.row, { paddingHorizontal: inset }]} testID="detail-tags-row">
            {chips.map(({ id, label }) => (
                <Pressable
                    key={id}
                    style={[styles.chip, { backgroundColor: colors.surface.app, borderColor: colors.border.default }]}
                    // dismissTo, never push: this row sits in a modal over the tabs, and a push puts a second, inescapable tab navigator on top.
                    onPress={() => router.dismissTo({ pathname: '/(tabs)/market', params: { tag: id } })}
                    accessibilityRole="button"
                    accessibilityLabel={t('Filter marketplace by tag {tag}', { tag: label })}
                >
                    <Text style={[styles.chipText, { color: colors.text.body }]}>{label}</Text>
                </Pressable>
            ))}
            {typed.map((tag) => (
                <Pressable
                    key={`#${tag}`}
                    style={[styles.chip, { backgroundColor: colors.surface.app, borderColor: colors.border.default }]}
                    // dismissTo for the same reason as above. Encoded once more than the router does: useLocalSearchParams
                    // decodes what the router already has, and a tag can spell an escape ("a%20b" would arrive as "a b").
                    onPress={() => router.dismissTo({ pathname: '/(tabs)/market', params: { free: encodeURIComponent(tag) } })}
                    accessibilityRole="button"
                    accessibilityLabel={t('Filter marketplace by tag {tag}', { tag: `#${tag}` })}
                >
                    <Text style={[styles.chipText, { color: colors.text.body }]}>#{tag}</Text>
                </Pressable>
            ))}
        </View>
    );
}

const styles = StyleSheet.create({
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingBottom: 16 },
    chip: { minHeight: 44, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 22, borderWidth: 1, justifyContent: 'center', alignItems: 'center', maxWidth: '100%' },
    chipText: { fontSize: 13, fontWeight: '700', flexShrink: 1, minWidth: 0 },
});
