/**
 * PatternBackground — the doodle wallpaper that stands in for the flat app background.
 *
 * Rendered once, behind the whole navigator (app/_layout.tsx). Screens don't draw it
 * themselves; they leave their page container on `colors.surface.page`, which the theme
 * re-points to 'transparent' while the pattern is on. Elements that genuinely need a solid
 * fill (inputs, chips, sunken rows) keep using `colors.surface.app` and stay opaque.
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
import { useTheme } from '../app/ThemeContext';

const TILES = {
    light: require('../assets/images/pattern-light.webp'),
    dark: require('../assets/images/pattern-dark.webp'),
} as const;

export default function PatternBackground() {
    const { theme, colors, patternEnabled } = useTheme();

    // The solid colour stays underneath: it is what shows with the pattern switched off,
    // and what fills the frame for the moment before the tile decodes.
    return (
        <View
            style={[StyleSheet.absoluteFill, { backgroundColor: colors.surface.app }]}
            pointerEvents="none"
        >
            {patternEnabled && (
                <Image
                    source={TILES[theme === 'dark' ? 'dark' : 'light']}
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
