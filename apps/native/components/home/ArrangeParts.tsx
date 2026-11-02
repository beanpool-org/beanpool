import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ARRANGE_WORDS, t } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { HOME_GUTTER_DP, HOME_TARGET_DP } from './HomeParts';

/**
 * Arrange's parts around the folded cards (DESIGN-home-layout-fable.md §3.2). The cards are the list; these say what to
 * do, add a card, put the defaults back and end it. Every move was saved as it was made, so Done only unfolds them.
 */

/** The one line at the top; under it, the line for a node that can't keep the cards on the account yet. */
export function ArrangeBar({ colors, notOnAccount }: { colors: AppColors; notOnAccount?: string | null }) {
    return (
        <View style={st.bar} testID="home-arrange-bar">
            <Text style={[st.barText, { color: colors.text.body }]}>{t(ARRANGE_WORDS.bar)}</Text>
            {!!notOnAccount && <Text style={[st.barText, { color: colors.text.secondary }]} testID="home-arrange-not-on-account">{notOnAccount}</Text>}
        </View>
    );
}

/** A folded card's one line; a card with nothing to show keeps its Settings… and Remove here, having no "…" to tap. */
export function FoldedLine({ id, text, colors, settings, remove }: {
    id: string;
    text: string;
    colors: AppColors;
    settings?: { a11y: string; onPress: () => void };
    remove?: { a11y: string; onPress: () => void };
}) {
    const word = (label: string, a11y: string, onPress: () => void, testID: string) => (
        <Pressable onPress={onPress} style={st.word} accessibilityRole="button" accessibilityLabel={a11y} testID={testID}>
            <Text style={[st.wordText, { color: colors.text.link }]}>{label}</Text>
        </Pressable>
    );
    return (
        <View>
            <Text style={[st.line, { color: colors.text.secondary }]} numberOfLines={2} testID={`home-arrange-${id}-line`}>{text}</Text>
            {(settings || remove) && (
                <View style={st.words}>
                    {settings && word(t('Settings…'), settings.a11y, settings.onPress, `home-arrange-${id}-settings`)}
                    {remove && word(t('Remove'), remove.a11y, remove.onPress, `home-arrange-${id}-remove`)}
                </View>
            )}
        </View>
    );
}

export function ArrangeAddTile({ colors, onPress }: { colors: AppColors; onPress: () => void }) {
    return (
        <Pressable onPress={onPress} style={[st.tile, { borderColor: colors.border.strong }]} accessibilityRole="button" accessibilityLabel={t('Add a card to Home')} testID="home-arrange-add">
            <Text style={[st.wordText, { color: colors.text.link }]}>{t('＋ Add a card')}</Text>
        </Pressable>
    );
}

export function ArrangeReset({ colors, onPress }: { colors: AppColors; onPress: () => void }) {
    return (
        <Pressable onPress={onPress} style={st.reset} accessibilityRole="button" accessibilityLabel={t('Reset Home to its default cards and order')} testID="home-arrange-reset">
            <Text style={[st.resetText, { color: colors.text.secondary }]}>{t('Reset to defaults')}</Text>
        </Pressable>
    );
}

/** Exported for the layout checks at 320dp (utils/__tests__/home-layout-320.test.ts). */
export const st = StyleSheet.create({
    bar: { marginHorizontal: HOME_GUTTER_DP, marginBottom: 10, gap: 4 },
    barText: { fontSize: 13, lineHeight: 18 },
    line: { fontSize: 13, lineHeight: 18, paddingVertical: 4 },
    words: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', columnGap: 16 },
    word: { minHeight: HOME_TARGET_DP, minWidth: HOME_TARGET_DP, justifyContent: 'center', alignItems: 'center' },
    wordText: { fontSize: 14, fontWeight: '700' },
    tile: {
        marginHorizontal: HOME_GUTTER_DP, marginBottom: 10, minHeight: HOME_TARGET_DP, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed',
        alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12,
    },
    reset: { marginHorizontal: HOME_GUTTER_DP, minHeight: HOME_TARGET_DP, alignItems: 'center', justifyContent: 'center' },
    resetText: { fontSize: 14, fontWeight: '700' },
});
