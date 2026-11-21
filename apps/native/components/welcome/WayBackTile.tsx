/**
 * One of the way-back step's two tiles (DESIGN-onboarding-home-landing-fable.md §3.1 E, slice S4): "Link a sign-in" and
 * "Write down 12 words", each a title, one short line and ›. A tap opens that way back in place, on the same screen: the
 * vault's sentences before any Protect button, or the 12 words with the paper line and the tick. Nothing is read or sent
 * by the tile itself.
 *
 * Colours from the central tokens only, as the onboarding screens draw them (app/ThemeContext.tsx `useOnboardingColors`: in a
 * dark set the strong border is raised to 3:1): the sunken row, the strong border, the heading and secondary inks.
 * Wraps at 320 dp and 1.3x text: the words column shrinks, › keeps its place.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useOnboardingColors } from '../../app/ThemeContext';

export function WayBackTile({ title, line, onPress, hint, testID }: {
    title: string;
    line: string;
    onPress: () => void;
    hint?: string;
    testID?: string;
}) {
    const { colors } = useOnboardingColors();
    return (
        <Pressable
            style={[styles.tile, { backgroundColor: colors.surface.subtle, borderColor: colors.border.strong }]}
            onPress={onPress}
            // No label of its own: a screen reader reads the title and the line, in the member's language, as one button.
            accessibilityRole="button"
            accessibilityHint={hint}
            testID={testID}
        >
            <View style={styles.words}>
                <Text style={[styles.title, { color: colors.text.heading }]}>{title}</Text>
                <Text style={[styles.line, { color: colors.text.secondary }]}>{line}</Text>
            </View>
            <MaterialCommunityIcons name="chevron-right" size={24} color={colors.text.secondary} />
        </Pressable>
    );
}

const styles = StyleSheet.create({
    tile: { flexDirection: 'row', alignItems: 'center', minHeight: 64, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 14, borderWidth: 1, marginBottom: 12, gap: 8 },
    words: { flex: 1, flexShrink: 1 },
    title: { fontSize: 16, fontWeight: '700', lineHeight: 22 },
    line: { fontSize: 13, lineHeight: 18, marginTop: 2 },
});
