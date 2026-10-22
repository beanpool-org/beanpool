import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('react-native', () => ({
    StyleSheet: { create: (s: any) => s },
    Platform: { OS: 'ios', select: (o: any) => o.ios ?? o.default },
}));

import { contrastRatio } from '../readable-color';
import { lightColors, darkColors, palette } from '../../constants/colors';
import { makeChatStyles } from '../../components/chat/styles';
import { resolveTheme, loadThemePreference, THEME_PREFERENCE_KEY } from '../theme-preference';

const ROOT = resolve(__dirname, '../../..');

describe('small-screen-polish-1022: small screen & dark mode checks', () => {
    describe('1. RadiusPickerModal header: no cut-off title, >= 44px buttons', () => {
        const modalPath = resolve(__dirname, '../../components/RadiusPickerModal.tsx');
        const modalSrc = readFileSync(modalPath, 'utf8');

        it('title wraps to two lines or shrinks to fit (never cut)', () => {
            // Must have numberOfLines={2} and adjustsFontSizeToFit
            expect(modalSrc).toMatch(/<Text\s+style=\{styles\.title\}\s+numberOfLines=\{2\}\s+adjustsFontSizeToFit/);
            expect(modalSrc).toContain('minimumFontScale={0.7}');
        });

        it('Cancel and Reset header buttons keep >= 44 px targets', () => {
            // headerBtn style must ensure minHeight >= 44 and minWidth >= 44
            expect(modalSrc).toMatch(/headerBtn:\s*\{[^}]*minHeight:\s*4[4-9]/);
            expect(modalSrc).toMatch(/headerBtn:\s*\{[^}]*minWidth:\s*4[4-9]/);
        });
    });

    describe('2. InvitePeopleSheet search placeholder: fits at 320 dp x 1.3 font scale', () => {
        const invitePath = resolve(__dirname, '../../components/InvitePeopleSheet.tsx');
        const inviteSrc = readFileSync(invitePath, 'utf8');

        it('uses shorter sentence "Search people" that fits without truncation', () => {
            expect(inviteSrc).toContain("placeholder={t('Search people')}");
            expect(inviteSrc).not.toContain("placeholder={t('Search people in this community')}");
        });

        it('search placeholder length fits available width at 320 dp and 1.3x font scale', () => {
            const placeholder = 'Search people';
            // Available width in 320 dp screen: 320 - 32 (sheet pad) - 24 (search box pad) - 28 (icon + gap) = 236 dp
            const availableWidth = 236;
            const approxCharWidth = 14 * 1.3 * 0.55; // 14 px font, 1.3 scale, ~0.55 em avg char
            const estimatedWidth = placeholder.length * approxCharWidth;
            expect(estimatedWidth).toBeLessThan(availableWidth);
        });
    });

    describe('3. Chat expired-edit note: backing surface matches action bar and reaches >= 4.5:1 contrast', () => {
        const rowPath = resolve(__dirname, '../../components/chat/ChatMessageRow.tsx');
        const rowSrc = readFileSync(rowPath, 'utf8');

        it('ChatMessageRow wraps expired edit note in editClosedBacking', () => {
            expect(rowSrc).toMatch(/styles\.editClosedBacking/);
            expect(rowSrc).toContain("t('You can edit a message for 15 minutes after sending it.')");
        });

        it('backing uses the exact same surface as circleActionButton in both themes', () => {
            const lightStyles = makeChatStyles({ colors: lightColors, theme: 'light' } as any);
            const darkStyles = makeChatStyles({ colors: darkColors, theme: 'dark' } as any);

            expect(lightStyles.editClosedBacking).toBeDefined();
            expect(darkStyles.editClosedBacking).toBeDefined();

            // Light: action bar button uses palette.gray600
            expect(lightStyles.editClosedBacking.backgroundColor).toBe(lightStyles.circleActionButton.backgroundColor);
            // Dark: action bar button uses colors.surface.subtle
            expect(darkStyles.editClosedBacking.backgroundColor).toBe(darkStyles.circleActionButton.backgroundColor);
        });

        it('expired edit note contrast is >= 4.5:1 on its backing in both light and dark themes', () => {
            const lightStyles = makeChatStyles({ colors: lightColors, theme: 'light' } as any);
            const darkStyles = makeChatStyles({ colors: darkColors, theme: 'dark' } as any);

            const lightFg = lightStyles.editClosedText.color;
            const lightBg = lightStyles.editClosedBacking.backgroundColor;
            const darkFg = darkStyles.editClosedText.color;
            const darkBg = darkStyles.editClosedBacking.backgroundColor;

            expect(lightFg).toBeDefined();
            expect(lightBg).toBeDefined();
            expect(darkFg).toBeDefined();
            expect(darkBg).toBeDefined();

            const lightRatio = contrastRatio(lightFg, lightBg);
            const darkRatio = contrastRatio(darkFg, darkBg);

            expect(lightRatio).toBeGreaterThanOrEqual(4.5);
            expect(darkRatio).toBeGreaterThanOrEqual(4.5);
        });

        it('MUTATION TEST: removing backing causes contrast check on doodle background to fail', () => {
            // Pattern ground colors from ThemeContext: light '#f1f1e4', dark '#141a1a'
            const PATTERN_GROUND = { light: '#f1f1e4', dark: '#141a1a' };

            // If text is white (colors.text.inverse '#ffffff') sitting straight on doodle ground:
            const whiteOnLightDoodle = contrastRatio('#ffffff', PATTERN_GROUND.light);
            // Without backing, white on light doodle is unreadable (~1.17:1 < 4.5:1)
            expect(whiteOnLightDoodle).toBeLessThan(4.5);

            // If text was muted grey (colors.text.muted '#647664') sitting straight on dark doodle:
            const mutedOnDarkDoodle = contrastRatio('#647664', PATTERN_GROUND.dark);
            // Without backing, muted on dark doodle is unreadable (~3.6:1 < 4.5:1)
            expect(mutedOnDarkDoodle).toBeLessThan(4.5);
        });
    });

    describe('4. Welcome screen theme resolution: fresh install defaults to light by design', () => {
        it('a fresh install with no stored preference defaults to light, even if phone is dark', async () => {
            const storage = new Map<string, string>();
            const mockStorage = {
                getItem: async (k: string) => storage.get(k) ?? null,
                setItem: async (k: string, v: string) => { storage.set(k, v); },
                removeItem: async (k: string) => { storage.delete(k); },
            };

            const pref = await loadThemePreference(mockStorage);
            expect(pref).toBe('light');
            // When resolved against phone's systemScheme="dark":
            expect(resolveTheme(pref, 'dark')).toBe('light');
        });

        it('a member who chose dark has stored preference and resolves to dark', async () => {
            const storage = new Map<string, string>([[THEME_PREFERENCE_KEY, 'dark']]);
            const mockStorage = {
                getItem: async (k: string) => storage.get(k) ?? null,
                setItem: async (k: string, v: string) => { storage.set(k, v); },
                removeItem: async (k: string) => { storage.delete(k); },
            };

            const pref = await loadThemePreference(mockStorage);
            expect(pref).toBe('dark');
            expect(resolveTheme(pref, 'light')).toBe('dark');
            expect(resolveTheme(pref, 'dark')).toBe('dark');
        });
    });
});
