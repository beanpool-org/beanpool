import { BRAND_SETS, brandScheme, type BrandSet } from '@beanpool/core';
import { COLOUR_SETS, palette, type AppColors } from '../constants/colors';

/**
 * A dark set's tokens with the two inks onboarding needs raised: the app's dark `text.muted` (gray500) reads 3.60:1 on the
 * dark card and its `border.strong` (neutral700) 1.91:1 on the page, so the onboarding notes, placeholders and input
 * outlines would sit below 4.5:1 (text) and 3:1 (UI). gray400 reads 6.86:1 on the card; gray500 as an outline 3.17:1 on
 * the subtle chip, 3.60:1 on the card and 4.10:1 on the page. The raised greys are neutral, the same in every dark set.
 */
const raisedForOnboarding = (tree: AppColors): AppColors => ({
    ...tree,
    text: { ...tree.text, muted: palette.gray400 },
    border: { ...tree.border, strong: palette.gray500 },
} as unknown as AppColors);

/** Built once per set at start, so a screen's memo sees the same object every render. */
const ONBOARDING_SETS = Object.fromEntries(
    BRAND_SETS.map((set) => [set, brandScheme(set) === 'dark' ? raisedForOnboarding(COLOUR_SETS[set]) : COLOUR_SETS[set]]),
) as { readonly [S in BrandSet]: AppColors };

/**
 * The colours the onboarding screens (welcome, sign-up, restore, profile setup) draw with, in the colour set the app is
 * drawn in (ThemeContext's `set`: `light`, `dark` = Classic, `night` = Dark).
 *
 * They follow light/dark like the rest of the app (Marty, 13 Oct 2026; they were light-only until then). In light they
 * are the classic light tokens, exactly what these screens always drew, so light mode does not change: no Earth/Slate
 * palette and no see-through page, because these screens draw no doodle pattern. In a dark set they are that set's
 * tokens, whose page colour is solid (the pattern's see-through page is only applied by ThemeContext), with muted text
 * and strong borders raised as above.
 */
export function onboardingColors(set: BrandSet): { colors: AppColors; dark: boolean } {
    if (set === 'light') return { colors: COLOUR_SETS.light, dark: false };
    return { colors: ONBOARDING_SETS[set], dark: brandScheme(set) === 'dark' };
}
