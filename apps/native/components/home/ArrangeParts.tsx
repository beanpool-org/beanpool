import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ARRANGE_WORDS, t } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { HOME_GUTTER_DP, HOME_TARGET_DP } from './HomeParts';

/**
 * Arrange's parts around the cards (DESIGN-home-arrange-in-place-fable.md §2.1, §2.4). The cards are Home itself, in
 * their own places; these say what to do, keep the cards with nothing to show, add a card, put the defaults back and end
 * it. Every move was saved as it was made, so Done only gives the cards their insides back.
 */

/**
 * The one line at the top; under it, the line for a node that can't keep the cards on the account yet. `onHeight` is its
 * whole height with the gap under it, so the screen can keep the card the member is looking at where it was.
 */
export function ArrangeBar({ colors, notOnAccount, onHeight }: { colors: AppColors; notOnAccount?: string | null; onHeight?: (dp: number) => void }) {
    return (
        <View style={st.bar} testID="home-arrange-bar" onLayout={onHeight ? e => onHeight(e.nativeEvent.layout.height) : undefined}>
            <Text style={[st.barText, { color: colors.text.body }]}>{t(ARRANGE_WORDS.barDrag)}</Text>
            {!!notOnAccount && <Text style={[st.barText, { color: colors.text.secondary }]} testID="home-arrange-not-on-account">{notOnAccount}</Text>}
        </View>
    );
}

/** One card with nothing to show now: its name, a note where it has one, and its Settings… (where it has any) and Remove. */
export interface StripRow {
    id: string;
    /** The band's name for it (a saved search by its words), drawn. */
    name: string;
    /** Tips with every tip seen, Sun and moon with no place: what the card would say. */
    note?: string;
    settings?: { a11y: string; onPress: () => void };
    remove: { a11y: string; onPress: () => void; ref?: React.RefObject<View | null> };
}

/**
 * The cards on the member's list that have nothing to show right now (§2.4): one quiet block under the cards, drawn in
 * Arrange only. A card you can't see isn't moved, so there are no arrows here: it keeps its saved place and is drawn there
 * the day it has something. Settings… and Remove are 48dp targets and wrap rather than shrink.
 */
export function ArrangeStrip({ rows, colors }: { rows: StripRow[]; colors: AppColors }) {
    if (rows.length === 0) return null;
    const word = (label: string, a11y: string, onPress: () => void, testID: string, ref?: React.RefObject<View | null>) => (
        <Pressable ref={ref} onPress={onPress} style={st.word} accessibilityRole="button" accessibilityLabel={a11y} testID={testID}>
            <Text style={[st.wordText, { color: colors.text.link }]}>{label}</Text>
        </Pressable>
    );
    return (
        <View style={st.strip} testID="home-arrange-strip">
            <Text style={[st.stripHeading, { color: colors.text.secondary }]} accessibilityRole="header" testID="home-arrange-strip-heading">{t('Nothing to show now')}</Text>
            {rows.map(r => (
                <View key={r.id} style={[st.stripRow, { borderTopColor: colors.border.default }]} testID={`home-arrange-${r.id}-row`}>
                    <View style={st.stripName}>
                        <Text style={[st.stripNameText, { color: colors.text.body }]} testID={`home-arrange-${r.id}-name`}>{r.name}</Text>
                        {!!r.note && <Text style={[st.stripNote, { color: colors.text.secondary }]} testID={`home-arrange-${r.id}-note`}>{r.note}</Text>}
                    </View>
                    <View style={st.words}>
                        {r.settings && word(t('Settings…'), r.settings.a11y, r.settings.onPress, `home-arrange-${r.id}-settings`)}
                        {word(t('Remove'), r.remove.a11y, r.remove.onPress, `home-arrange-${r.id}-remove`, r.remove.ref)}
                    </View>
                </View>
            ))}
        </View>
    );
}

export function ArrangeAddTile({ colors, onPress, tileRef }: { colors: AppColors; onPress: () => void; tileRef?: React.RefObject<View | null> }) {
    return (
        <Pressable ref={tileRef} onPress={onPress} style={[st.tile, { borderColor: colors.border.strong }]} accessibilityRole="button" accessibilityLabel={t('Add a card to Home')} testID="home-arrange-add">
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

/** The name's room beside Settings… and Remove: below this the pair wraps under the name (home-layout-320.test.ts). */
export const STRIP_NAME_BASIS_DP = 140;

/** Exported for the layout checks at 320dp (utils/__tests__/home-layout-320.test.ts). */
export const st = StyleSheet.create({
    // The gap under the bar is padding, not margin, so the bar's measured height is the whole of what it adds.
    bar: { paddingHorizontal: HOME_GUTTER_DP, paddingBottom: 10, gap: 4 },
    barText: { fontSize: 13, lineHeight: 18 },
    strip: { marginHorizontal: HOME_GUTTER_DP, marginBottom: 10 },
    stripHeading: { fontSize: 13, lineHeight: 18, fontWeight: '700', paddingBottom: 6 },
    // The name takes what is left; Settings… and Remove go under it rather than shrink when the pair doesn't fit beside it.
    stripRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', columnGap: 8, borderTopWidth: StyleSheet.hairlineWidth },
    stripName: { flexGrow: 1, flexShrink: 1, flexBasis: STRIP_NAME_BASIS_DP, paddingVertical: 8 },
    stripNameText: { fontSize: 15, lineHeight: 20 },
    stripNote: { fontSize: 13, lineHeight: 18 },
    words: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', columnGap: 16, flexShrink: 0, marginLeft: 'auto' },
    word: { minHeight: HOME_TARGET_DP, minWidth: HOME_TARGET_DP, justifyContent: 'center', alignItems: 'center' },
    wordText: { fontSize: 14, fontWeight: '700' },
    tile: {
        marginHorizontal: HOME_GUTTER_DP, marginBottom: 10, minHeight: HOME_TARGET_DP, borderRadius: 14, borderWidth: 1, borderStyle: 'dashed',
        alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12,
    },
    reset: { marginHorizontal: HOME_GUTTER_DP, minHeight: HOME_TARGET_DP, alignItems: 'center', justifyContent: 'center' },
    resetText: { fontSize: 14, fontWeight: '700' },
});
