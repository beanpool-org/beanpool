/**
 * The example cards on a nearly empty Market (utils/example-listings.ts): a few made-up listings, each marked
 * Example, to show a newcomer what people post. Nothing here responds to a tap: no card opens, messages or trades,
 * and the words are the app's own, never a person's.
 *
 * Set apart from real cards: a dashed border, a muted ground and no photo or author row. Each card is one element to a
 * screen reader, read as text, with "Example" first. The words wrap at 320dp and 1.3× text rather than cut off.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../app/ThemeContext';
import { EXAMPLE_BADGE, EXAMPLE_LISTINGS, EXAMPLES_HEADING, EXAMPLES_NOTE, exampleCardA11y } from '../utils/example-listings';

export function ExampleListings() {
    const { colors } = useTheme();
    return (
        <View testID="example-listings" style={styles.section}>
            <Text accessibilityRole="header" style={[styles.heading, { color: colors.text.heading }]}>{EXAMPLES_HEADING}</Text>
            <Text style={[styles.note, { color: colors.text.secondary }]}>{EXAMPLES_NOTE}</Text>
            {EXAMPLE_LISTINGS.map(example => {
                const type = example.type === 'offer' ? colors.market.offer : colors.market.need;
                return (
                    <View
                        key={example.key}
                        testID="example-card"
                        {...exampleCardA11y(example)}
                        style={[styles.card, { borderColor: colors.border.strong, backgroundColor: colors.surface.subtle }]}
                    >
                        <View style={[styles.tile, { borderColor: colors.border.strong }]}>
                            <Text style={styles.emoji} maxFontSizeMultiplier={1.3}>{example.emoji}</Text>
                        </View>
                        <View style={styles.body}>
                            <View style={styles.badges}>
                                <View style={[styles.badge, { backgroundColor: colors.border.default, borderColor: colors.border.strong }]}>
                                    <Text style={[styles.badgeText, { color: colors.text.heading }]} maxFontSizeMultiplier={1.3}>{EXAMPLE_BADGE.toUpperCase()}</Text>
                                </View>
                                <View style={[styles.badge, { backgroundColor: type.bg, borderColor: type.bg }]}>
                                    <Text style={[styles.badgeText, { color: type.fg }]} maxFontSizeMultiplier={1.3}>
                                        {example.type === 'offer' ? 'OFFER' : 'NEED'}
                                    </Text>
                                </View>
                            </View>
                            <Text style={[styles.title, { color: colors.text.body }]}>{example.title}</Text>
                            <Text style={[styles.description, { color: colors.text.secondary }]}>{example.description}</Text>
                        </View>
                    </View>
                );
            })}
        </View>
    );
}

const styles = StyleSheet.create({
    section: { paddingTop: 12, paddingBottom: 4 },
    heading: { fontSize: 15, fontWeight: '800', marginBottom: 2 },
    note: { fontSize: 12.5, lineHeight: 17, marginBottom: 10 },
    card: {
        flexDirection: 'row', gap: 12, borderWidth: 1.5, borderStyle: 'dashed', borderRadius: 14, padding: 12, marginBottom: 10,
    },
    tile: {
        width: 48, height: 48, borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center',
        opacity: 0.8,
    },
    emoji: { fontSize: 24 },
    body: { flex: 1, minWidth: 0 },
    badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
    badge: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
    badgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
    title: { fontSize: 15, fontWeight: '800', marginBottom: 2 },
    description: { fontSize: 13, lineHeight: 18 },
});
