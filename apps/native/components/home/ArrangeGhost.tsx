import React from 'react';
import { Text, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import type { CardHue } from '@beanpool/core';
import type { AppColors } from '../../constants/colors';
import { CAPTION_MAX_SCALE, HOME_CARD_PADDING_DP, homeStyles } from './HomeParts';
import { GHOST_DP } from '../../utils/arrange-drag';

/**
 * What a finger carries in Arrange (DESIGN-home-arrange-in-place-fable.md §2.3): the lifted card's band, its caption on its
 * tint in its ink, a band's height and the column's width, a little larger, with a 2 dp ring in the ink (dark has no
 * readable shadow) and a soft shadow in light. The card itself stays in the list, dimmed, where it would land.
 *
 * One view over the list that no touch and no screen reader reaches. It moves by a transform from two shared values that the
 * drag writes as the finger moves, so each frame is drawn on the UI thread with no call across per move.
 */
export function ArrangeGhost({ x, y, caption, hue, colors, dark, width }: {
    x: SharedValue<number>;
    y: SharedValue<number>;
    caption: string;
    hue: CardHue;
    colors: AppColors;
    dark: boolean;
    width: number;
}) {
    const s = homeStyles(colors);
    const { tint, ink } = colors.card[hue];
    const moved = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: 1.02 }] }));
    return (
        <Animated.View
            pointerEvents="none"
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
            style={[st.ghost, { width, backgroundColor: tint, borderColor: ink }, dark ? st.flat : st.shadow, moved]}
            testID="home-arrange-ghost"
        >
            <Text style={[s.caption, { color: ink }]} maxFontSizeMultiplier={CAPTION_MAX_SCALE} numberOfLines={1}>{caption}</Text>
        </Animated.View>
    );
}

const st = StyleSheet.create({
    ghost: {
        position: 'absolute', top: 0, left: 0, height: GHOST_DP, borderRadius: 13, borderWidth: 2,
        flexDirection: 'row', alignItems: 'center', paddingHorizontal: HOME_CARD_PADDING_DP, zIndex: 200,
    },
    // Elevation also keeps it over the floating Done (elevation 8) on Android; in dark its shadow can't be read, so none is asked for.
    shadow: { elevation: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 8 },
    flat: { elevation: 12, shadowColor: 'transparent', shadowOpacity: 0 },
});
