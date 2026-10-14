import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { tourStepCaption, type TourStep } from '@beanpool/core';
import type { AppColors } from '../constants/colors';
import type { TourHome } from '../utils/tour-store';

/** The bar's buttons and chips: the floor's touch target. */
export const TOUR_TARGET_DP = 48;
/**
 * What the tab screens give up at the bottom while the bar is up: the tabs' navigator ends at the bar's top, so each
 * tab's own bottom button (the Market's + ADD POST, the Map's, Commons') rides above the bar and can be tapped, with no
 * screen of its own changed. The bar reports its height (onHeight) as it lays out.
 */
export function tourSceneInset(running: boolean, barHeight: number): number {
    return running && barHeight > 0 ? Math.ceil(barHeight) : 0;
}

/** The app's own text cap (as Home's captions and the tab labels): four lines of a step at 320 dp keep the bar short. */
export const TOUR_TEXT_MAX_SCALE = 1.2;

/**
 * The tour's bar (scratch/global-node/DESIGN-getting-started-fable.md §2): a card-coloured strip at the bottom of the
 * screen, one or two sentences, "STEP 2 OF 7", Skip (left) and Next › (right). The app behind it is the real tab and
 * stays live: the bar takes only its own strip, so no tap behind it is ever held. The last step adds the three chips,
 * More cards › and Done. The words are a polite live region, so TalkBack reads each step as it comes.
 */
export function TourBar({ steps, index, home, colors, bottomInset, onHeight, onNext, onSkip, onDone }: {
    steps: readonly TourStep[];
    index: number;
    home: TourHome | null;
    colors: AppColors;
    bottomInset: number;
    onHeight?: (height: number) => void;
    onNext: () => void;
    onSkip: () => void;
    onDone: () => void;
}) {
    const step = steps[index];
    if (!step) return null;
    const last = index === steps.length - 1;
    const chips = last && home ? home.chips : [];
    return (
        <View
            style={[tourStyles.bar, { backgroundColor: colors.surface.card, borderTopColor: colors.border.default, paddingBottom: 8 + bottomInset }]}
            onLayout={onHeight ? e => onHeight(e.nativeEvent.layout.height) : undefined}
            testID="tour-bar"
        >
            <Text style={[tourStyles.caption, { color: colors.text.secondary }]} maxFontSizeMultiplier={TOUR_TEXT_MAX_SCALE} testID="tour-step-caption">
                {tourStepCaption(index, steps.length).toUpperCase()}
            </Text>
            <Text style={[tourStyles.words, { color: colors.text.heading }]} maxFontSizeMultiplier={TOUR_TEXT_MAX_SCALE} accessibilityLiveRegion="polite" accessible testID="tour-words">
                {step.words}
            </Text>
            {chips.length > 0 && home && (
                <View style={tourStyles.chips} testID="tour-chips">
                    {chips.map(type => {
                        const on = home.onHome(type);
                        const name = home.chipName(type);
                        return (
                            <Pressable
                                key={type}
                                onPress={on ? undefined : () => home.addChip(type)}
                                disabled={on}
                                style={[tourStyles.chip, { borderColor: on ? colors.border.default : colors.brand.dark, backgroundColor: on ? colors.surface.app : colors.surface.card }]}
                                accessibilityRole="button"
                                accessibilityLabel={on ? `${name} is on Home` : `Put ${name} on Home`}
                                accessibilityState={{ disabled: on }}
                                testID={`tour-chip-${type}`}
                            >
                                <Text style={[tourStyles.chipText, { color: on ? colors.text.secondary : colors.text.link }]} maxFontSizeMultiplier={TOUR_TEXT_MAX_SCALE} numberOfLines={2}>
                                    {on ? `${name} · On Home ✓` : name}
                                </Text>
                            </Pressable>
                        );
                    })}
                    <Pressable onPress={home.moreCards} style={tourStyles.more} accessibilityRole="button" accessibilityLabel="More cards: open Add a card" testID="tour-more-cards">
                        <Text style={[tourStyles.chipText, { color: colors.text.link }]} maxFontSizeMultiplier={TOUR_TEXT_MAX_SCALE}>More cards ›</Text>
                    </Pressable>
                </View>
            )}
            <View style={tourStyles.row}>
                <Pressable onPress={onSkip} style={tourStyles.skip} accessibilityRole="button" accessibilityLabel="Skip the tour" testID="tour-skip">
                    <Text style={[tourStyles.skipText, { color: colors.text.link }]} maxFontSizeMultiplier={TOUR_TEXT_MAX_SCALE}>Skip</Text>
                </Pressable>
                <Pressable
                    onPress={last ? onDone : onNext}
                    style={({ pressed }) => [tourStyles.next, { backgroundColor: colors.brand.fill }, pressed && { opacity: 0.85 }]}
                    accessibilityRole="button"
                    accessibilityLabel={last ? 'Done: end the tour' : `Next: step ${index + 2} of ${steps.length}`}
                    testID={last ? 'tour-done' : 'tour-next'}
                >
                    <Text style={[tourStyles.nextText, { color: colors.text.inverse }]} maxFontSizeMultiplier={TOUR_TEXT_MAX_SCALE}>{last ? 'Done' : 'Next ›'}</Text>
                </Pressable>
            </View>
        </View>
    );
}

/** Exported for the 320 dp checks (utils/__tests__/tour-render.test.ts). */
export const tourStyles = StyleSheet.create({
    bar: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopWidth: 1, paddingHorizontal: 16, paddingTop: 10, zIndex: 50, elevation: 8 },
    caption: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, marginBottom: 4 },
    words: { fontSize: 15, lineHeight: 21 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
    chip: { minHeight: TOUR_TARGET_DP, paddingHorizontal: 12, borderWidth: 1, borderRadius: 24, justifyContent: 'center', maxWidth: '100%' },
    chipText: { fontSize: 14, fontWeight: '700' },
    more: { minHeight: TOUR_TARGET_DP, paddingHorizontal: 8, justifyContent: 'center' },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
    skip: { minHeight: TOUR_TARGET_DP, minWidth: TOUR_TARGET_DP, paddingHorizontal: 8, justifyContent: 'center' },
    skipText: { fontSize: 15, fontWeight: '700' },
    next: { minHeight: TOUR_TARGET_DP, minWidth: 96, paddingHorizontal: 20, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
    nextText: { fontSize: 15, fontWeight: '700' },
});
