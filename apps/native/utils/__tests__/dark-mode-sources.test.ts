import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Dark mode on the phone (Damo via Marty, 13 Oct 2026): New Event's header stayed white, so its title vanished, and
 * the Approximate button was dark text on a dark-brown box. The screens are not rendered here (see vitest.config.ts),
 * so these read the source for the patterns that caused it, and fail when one creeps back into a themed screen.
 */
const NATIVE_ROOT = join(__dirname, '..', '..');

function sources(): { file: string; src: string }[] {
    const out: { file: string; src: string }[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) {
                if (name !== '__tests__' && name !== 'node_modules') walk(path);
            } else if (name.endsWith('.tsx')) {
                out.push({ file: relative(NATIVE_ROOT, path), src: readFileSync(path, 'utf8') });
            }
        }
    };
    walk(join(NATIVE_ROOT, 'app'));
    walk(join(NATIVE_ROOT, 'components'));
    return out;
}

const ALL = sources();
const themed = (src: string) => /\buse(Theme|Styles)\(/.test(src);

describe('dark mode: themed screens draw with the theme', () => {
    it('finds the sources it scans', () => {
        expect(ALL.length).toBeGreaterThan(100);
        expect(ALL.some(s => s.file === 'components/NewEventModal.tsx')).toBe(true);
    });

    // surface.page is 'transparent' while the doodle pattern is on (app/ThemeContext.tsx), and only screens draw the
    // pattern. Inside an opaque Modal nothing does, so the bare white window shows through: New Event's header.
    it('no component that opens a full-screen Modal paints surface.page', () => {
        const offenders = ALL
            .filter(s => s.file.startsWith('components/'))
            .filter(s => /<Modal\b(?![^>]*\btransparent\b)/.test(s.src))
            .filter(s => /backgroundColor:\s*\w+\.surface\.page\b/.test(s.src))
            .map(s => s.file);
        expect(offenders).toEqual([]);
    });

    it('New Event paints its sheet with the solid surface.app', () => {
        const src = ALL.find(s => s.file === 'components/NewEventModal.tsx')!.src;
        expect(src).toMatch(/container: \{ flex: 1, backgroundColor: colors\.surface\.app \}/);
    });

    // A faded card over the warning box's dark brown read as dark text on brown.
    it("New Event's disabled Approximate stays solid in dark and only dims its label", () => {
        const src = ALL.find(s => s.file === 'components/NewEventModal.tsx')!.src;
        expect(src).toMatch(/\(!pin \|\| approximate\) && styles\.secondaryBtnDisabled/);
        expect(src).toMatch(/secondaryBtnDisabled: theme === 'dark'\s*\?\s*\{ backgroundColor: colors\.surface\.subtle/);
        expect(src).not.toMatch(/styles\.approxBtn, \(!pin \|\| approximate\) && \{ opacity/);
    });

    // Dark status-bar icons vanish on the dark page. ('light' is right over the tabs' green header in both schemes.)
    it('no themed screen hard-codes dark status-bar icons', () => {
        const offenders = ALL
            .filter(s => themed(s.src))
            .filter(s => /<StatusBar\s+style="dark"/.test(s.src))
            .map(s => s.file);
        expect(offenders).toEqual([]);
    });

    // The static `colors` export is the light palette. A themed screen that also draws with it puts light pieces,
    // or dark text, into the dark theme.
    it('no themed screen draws with the static light colours', () => {
        const mixed = ALL
            .filter(s => themed(s.src))
            .filter(s => /import \{[^}]*\bcolors\b(?!\s+as)[^}]*\} from '(\.\.\/)+constants\/colors'/.test(s.src))
            .map(s => s.file)
            .sort();
        expect(mixed).toEqual([]);
    });

    // A dark palette step as text, with no dark branch on its line, is dark text on the dark card: gray600 is about
    // 2.3:1 on neutral900, gray700 about 1.5:1 on neutral800. These files keep such text only on pale pills and boxes
    // that stay pale in both schemes (red100, amber100, emerald100 …), where it reads.
    const DARK_TEXT_ON_PALE_OK = new Set([
        'components/DecideSection.tsx',        // debt warning on red100; status pills on green/red/amber/indigo 100
        'components/MyDealsSheet.tsx',         // "completed" on its emerald100 pill
        'components/ProposeDecisionModal.tsx', // removal warning on red100
    ]);
    it('no themed screen sets dark palette text without a dark branch', () => {
        const darkStep = /\bcolor: palette\.(gray[5-9]00|slate[5-9]00|neutral[6-9]00|neutral950|red[7-9]00|orange[7-9]00|amber[8-9]00|emerald[8-9]00|green[8-9]00|indigo[7-9]00|blue[7-9]00|violet700|purple[7-8]00|black)\b/;
        const offenders = ALL
            .filter(s => themed(s.src) && !DARK_TEXT_ON_PALE_OK.has(s.file))
            .flatMap(s => s.src.split('\n')
                .map((line, i) => ({ line, at: `${s.file}:${i + 1}` }))
                .filter(({ line }) => darkStep.test(line) && !/theme === 'dark'|isDark/.test(line))
                .map(({ at }) => at));
        expect(offenders).toEqual([]);
    });

    // The avatar sheet is shared with welcome and profile setup, which stay light; Settings hands it the dark colours.
    it('the avatar sheet follows the dark theme from Settings and keeps its own light look', () => {
        const sheet = ALL.find(s => s.file === 'components/AvatarPickerSheet.tsx')!.src;
        expect(sheet).toMatch(/colors \? makeStyles\(tonesFor\(colors\)\) : LIGHT_STYLES/);
        const settings = ALL.find(s => s.file === 'app/(tabs)/settings.tsx')!.src;
        expect(settings).toMatch(/<AvatarPickerSheet[^>]*colors=\{theme === 'dark' \? colors : undefined\}/);
    });

    it('the Settings protection cards follow the theme', () => {
        for (const file of ['components/KnownConsentCard.tsx', 'components/VaultMoveCard.tsx', 'components/RadiusPickerModal.tsx', 'components/ReviewModal.tsx']) {
            const src = ALL.find(s => s.file === file)!.src;
            expect(src, file).toMatch(/useStyles\(makeStyles\)/);
            expect(src, file).not.toMatch(/import \{[^}]*\bcolors\b(?!\s+as)[^}]*\} from '\.\.\/constants\/colors'/);
        }
        const settings = ALL.find(s => s.file === 'app/(tabs)/settings.tsx')!.src;
        expect(settings).toMatch(/<KeeperProtectionPanel\s+colors=\{colors\}/);
    });

    // White grounds that are right in both schemes: brand buttons, ticks and glyphs on coloured marks, dev-only probes.
    const WHITE_OK = new Set([
        'app/(tabs)/map.tsx',          // the pin glyph's white strokes (and the file is protected)
        'app/apple-probe.tsx',         // dev-only probe screen
        'app/google-probe.tsx',        // dev-only probe screen
        'components/CreditBar.tsx',    // ticks and the thumb on the coloured bar
        'components/SsoButton.tsx',    // the providers' own white button
    ]);
    it('no themed screen hard-codes a white background outside the known brand and glyph uses', () => {
        const offenders = ALL
            .filter(s => !WHITE_OK.has(s.file))
            .filter(s => s.src.split('\n').some(line =>
                /backgroundColor:\s*['"](#fff|#ffffff|white)['"]/i.test(line) && !/theme === 'dark'|isDark/.test(line)))
            .map(s => s.file);
        expect(offenders).toEqual([]);
    });
});
