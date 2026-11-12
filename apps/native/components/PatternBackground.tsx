/**
 * PatternBackground — the doodle wallpaper that stands in for the flat app background.
 *
 * Drawn once per stack screen, by the navigator's screenLayout (app/_layout.tsx). It used to
 * be rendered once behind the whole navigator instead, with screens left transparent over it
 * -- but a transparent screen is also see-through DURING a push, so the outgoing screen showed
 * through the incoming one. Each screen carrying its own copy is what keeps it opaque.
 *
 * Screens still don't reference the wallpaper themselves: they leave their page container on
 * `colors.surface.page`, which the theme re-points to 'transparent' while the pattern is on.
 * Elements that genuinely need a solid fill (inputs, chips, sunken rows) keep using
 * `colors.surface.app` and stay opaque.
 *
 * Tile sizing: the asset is a 2x2 block of a seamless tile, so one repeat covers four
 * tiles. `resizeMode="repeat"` lays it down at the asset's dp size — 890dp here, giving a
 * 445dp unique tile. The @2x file (1780px) is what a 2x screen actually samples, so the
 * line work stays crisp instead of being upscaled from the 1x file.
 *
 * A fractional draw size is what makes a tiled background show seams, so nothing here
 * scales the image: repeat at natural size lands on whole pixels by construction.
 */

import { Image, StyleSheet, View } from 'react-native';
import type { BrandSet } from '@beanpool/core';
import { useTheme } from '../app/ThemeContext';

// One tile per colour set (core's BRAND_SETS), so a new set cannot be added without its own wallpaper. `dark` is Classic's
// olive tile; `night` is Dark's charcoal one, baked from it by scripts/bake-dark-doodle.mjs (slice T5). The @2x file of each
// sits beside it and Metro picks it on a 2x screen.
const TILES: Record<BrandSet, number> = {
    light: require('../assets/images/pattern-light.webp'),
    dark: require('../assets/images/pattern-dark.webp'),
    night: require('../assets/images/pattern-night.webp'),
};

export default function PatternBackground() {
    const { set, colors, patternEnabled } = useTheme();

    // The solid colour stays underneath: it is what shows with the pattern switched off, and
    // what fills the frame for the moment before the tile decodes. While the pattern is on it
    // is the tile's OWN ground colour (surface.chrome is that ground then), so that first
    // moment matches the wallpaper instead of flashing a slightly different off-white.
    return (
        <View
            style={[StyleSheet.absoluteFill, { backgroundColor: patternEnabled ? colors.surface.chrome : colors.surface.app }]}
            pointerEvents="none"
        >
            {patternEnabled && (
                <Image
                    source={TILES[set]}
                    style={StyleSheet.absoluteFill}
                    resizeMode="repeat"
                    // Decorative only — never announced, never focusable.
                    accessible={false}
                    accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants"
                />
            )}
        </View>
    );
}
