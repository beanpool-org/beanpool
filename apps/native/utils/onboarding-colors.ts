import { lightColors, darkColors, type AppColors } from '../constants/colors';

/**
 * The colours the onboarding screens (welcome, sign-up, restore, profile setup) draw with.
 *
 * They follow light/dark like the rest of the app (Marty, 13 Oct 2026; they were light-only until then). In light they
 * are the classic light tokens, exactly what these screens always drew, so light mode does not change: no Earth/Slate
 * palette and no see-through page, because these screens draw no doodle pattern. In dark they are the app's dark tokens,
 * whose page colour is solid (the pattern's see-through page is only applied by ThemeContext).
 */
export function onboardingColors(theme: 'light' | 'dark'): { colors: AppColors; dark: boolean } {
    return theme === 'dark'
        ? { colors: darkColors as unknown as AppColors, dark: true }
        : { colors: lightColors, dark: false };
}
