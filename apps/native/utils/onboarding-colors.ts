import { lightColors, darkColors, palette, type AppColors } from '../constants/colors';

/**
 * The dark tokens with the two inks onboarding needs raised: the app's dark `text.muted` (gray500) reads 3.60:1 on the
 * dark card and its `border.strong` (neutral700) 1.91:1 on the page, so the onboarding notes, placeholders and input
 * outlines would sit below 4.5:1 (text) and 3:1 (UI). gray400 reads 6.86:1 on the card; gray500 as an outline 3.17:1 on
 * the subtle chip, 3.60:1 on the card and 4.10:1 on the page.
 */
const onboardingDarkColors = {
    ...darkColors,
    text: { ...darkColors.text, muted: palette.gray400 },
    border: { ...darkColors.border, strong: palette.gray500 },
};

/**
 * The colours the onboarding screens (welcome, sign-up, restore, profile setup) draw with.
 *
 * They follow light/dark like the rest of the app (Marty, 13 Oct 2026; they were light-only until then). In light they
 * are the classic light tokens, exactly what these screens always drew, so light mode does not change: no Earth/Slate
 * palette and no see-through page, because these screens draw no doodle pattern. In dark they are the app's dark tokens,
 * whose page colour is solid (the pattern's see-through page is only applied by ThemeContext), with muted text and
 * strong borders raised as above.
 */
export function onboardingColors(theme: 'light' | 'dark'): { colors: AppColors; dark: boolean } {
    return theme === 'dark'
        ? { colors: onboardingDarkColors as unknown as AppColors, dark: true }
        : { colors: lightColors, dark: false };
}
