import type { BrandSet } from '@beanpool/core';
import { COLOUR_SETS, doodleGround, type AppColors } from '../constants/colors';

/**
 * The tree a screen draws with in `set`, the colour set ThemeContext picked (core's BRAND_SETS: `light`, `dark` =
 * Classic, `night` = Dark).
 *
 * The pattern is drawn once per screen, underneath that screen's content. Page containers therefore go transparent so it
 * shows through; surface.app stays solid for the inputs, chips and sunken rows that share the token and must not become
 * see-through. Chrome that must stay opaque (the tab strip, the controls block that the feed slides under) takes the
 * tile's own ground colour, the library's doodle ground for the set, so it reads as the same surface as the wallpaper
 * rather than a second, paler one laid on top. With the pattern off, the set's tree as it is.
 */
export function drawnColours(set: BrandSet, patternEnabled: boolean): AppColors {
    const base = COLOUR_SETS[set];
    if (!patternEnabled) return base;
    return { ...base, surface: { ...base.surface, page: 'transparent', chrome: doodleGround(set) } };
}
