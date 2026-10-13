import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { darkColors, palette } from '../../constants/colors';

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

/**
 * Every value given to `prop` in a source (`backgroundColor: …` in a style, `color={…}` on an icon), read up to the
 * comma, brace or paren that closes it, across lines. A ternary on the scheme yields only the branch dark mode draws:
 * `theme === 'dark' ? a : b` gives `a`, `theme === 'light' ? a : b` gives `b`. Any other value is drawn in dark as is,
 * whatever else its line says.
 */
function darkValues(file: string, src: string, prop: string): { at: string; value: string }[] {
    const out: { at: string; value: string }[] = [];
    const start = new RegExp(`\\b${prop}(?::\\s*|=\\{)`, 'g');
    for (let m = start.exec(src); m; m = start.exec(src)) {
        let i = m.index + m[0].length, depth = 0, quote = '';
        for (; i < src.length; i++) {
            const c = src[i];
            if (quote) { if (c === quote && src[i - 1] !== '\\') quote = ''; continue; }
            if (c === "'" || c === '"' || c === '`') quote = c;
            else if ('([{'.includes(c)) depth++;
            else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
            else if ((c === ',' || c === ';') && depth === 0) break;
        }
        out.push({ at: `${file}:${src.slice(0, m.index).split('\n').length}`, value: darkBranch(src.slice(m.index + m[0].length, i).trim()) });
    }
    return out;
}

function darkBranch(expr: string): string {
    const t = /^\(?\s*(theme\s*===\s*'dark'|isDark|theme\s*!==\s*'light')\s*\)?\s*\?([^:]*):([\s\S]*)$/.exec(expr);
    if (t) return t[2].trim();
    const f = /^\(?\s*(theme\s*===\s*'light'|!isDark|theme\s*!==\s*'dark')\s*\)?\s*\?([^:]*):([\s\S]*)$/.exec(expr);
    return f ? darkBranch(f[3].trim()) : expr;
}

/** A dark-mode value as `#rrggbb` plus alpha: a `palette.` step, a themed `colors.` token, or a literal. */
function resolve(value: string): { hex: string; alpha: number } | undefined {
    const tok = /^(palette|colors|theme\.colors)\.([\w.]+)$/.exec(value);
    if (tok) {
        const root: any = tok[1] === 'palette' ? palette : darkColors;
        const v = tok[2].split('.').reduce((o, k) => (o == null ? o : o[k]), root);
        return typeof v === 'string' ? resolve(`'${v}'`) : undefined;
    }
    const lit = /^['"](.*)['"]$/.exec(value)?.[1].toLowerCase();
    if (!lit) return undefined;
    if (lit === 'white') return { hex: '#ffffff', alpha: 1 };
    if (lit === 'black') return { hex: '#000000', alpha: 1 };
    const h = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/.exec(lit);
    if (h) {
        const six = h[1].length === 3 ? h[1].replace(/./g, c => c + c) : h[1];
        return { hex: `#${six}`, alpha: h[2] ? parseInt(h[2], 16) / 255 : 1 };
    }
    const r = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(lit);
    if (r) return { hex: '#' + [r[1], r[2], r[3]].map(n => Number(n).toString(16).padStart(2, '0')).join(''), alpha: r[4] ? Number(r[4]) : 1 };
    return undefined;
}

function luminance(hex: string): number {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
};

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

    // Dark text in dark mode: a dark palette step (gray600 is about 2.3:1 on neutral900, gray700 about 1.5:1 on
    // neutral800) or a hard-coded colour under 4.5:1 on the dark card, given to a style's `color` or an icon's `color`
    // with no dark branch. Allowed only where it sits on a pale pill or box that stays pale in both schemes, by value.
    const DARK_TEXT_ON_PALE_OK: Record<string, string[]> = {
        'components/DecideSection.tsx': ['palette.red700', 'palette.red900', 'palette.amber800', 'palette.indigo700'], // debt warning on red100; status pills on 100 steps
        'components/ProposeDecisionModal.tsx': ['palette.red700', 'palette.red900'], // removal warning on red100
        'app/(tabs)/market.tsx': ["'#1e40af'"],                            // "YOU" on its #dbeafe pill
        'app/(tabs)/settings.tsx': ["'#000000'"],                          // Confirm Sign Out on the dark scheme's bright danger button
        'components/NeedsYouIcons.tsx': ["'#1f2937'"],                     // the count on its white or accent dot
    };
    const PROTECTED = new Set(['app/(tabs)/map.tsx', 'components/GlobalHeader.tsx']); // off-limits; map.tsx's are the map style's
    it('no themed screen sets dark text without a dark branch', () => {
        const darkStep = /^palette\.(gray[5-9]00|slate[5-9]00|neutral[6-9]00|neutral950|red[7-9]00|orange[7-9]00|amber[8-9]00|emerald[8-9]00|green[8-9]00|indigo[7-9]00|blue[7-9]00|violet700|purple[7-8]00|black)$/;
        const offenders = ALL
            .filter(s => themed(s.src) && !PROTECTED.has(s.file))
            .flatMap(s => darkValues(s.file, s.src, 'color')
                .filter(({ value }) => {
                    if (DARK_TEXT_ON_PALE_OK[s.file]?.includes(value)) return false;
                    if (darkStep.test(value)) return true;
                    const c = /^['"]/.test(value) ? resolve(value) : undefined;
                    return !!c && c.alpha >= 0.5 && contrast(c.hex, darkColors.surface.card) < 4.5;
                })
                .map(({ at, value }) => `${at} ${value}`));
        expect(offenders).toEqual([]);
    });

    // The avatar sheet is shared by Settings, welcome and profile setup; each hands it the dark colours in dark (onboarding went dark
    // in #1842, and the emulator showed the sheet white over the dark profile step).
    it('the avatar sheet follows the dark theme from every caller and keeps its own light look', () => {
        const sheet = ALL.find(s => s.file === 'components/AvatarPickerSheet.tsx')!.src;
        expect(sheet).toMatch(/colors \? makeStyles\(tonesFor\(colors\)\) : LIGHT_STYLES/);
        const settings = ALL.find(s => s.file === 'app/(tabs)/settings.tsx')!.src;
        expect(settings).toMatch(/<AvatarPickerSheet[^>]*colors=\{theme === 'dark' \? colors : undefined\}/);
        for (const file of ['app/welcome.tsx', 'app/profile-setup.tsx']) {
            const src = ALL.find(s => s.file === file)!.src;
            expect(src, file).toMatch(/<AvatarPickerSheet[^>]*colors=\{dark \? colors : undefined\}/);
        }
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
        'components/PhotoCarousel.tsx', // the page dots over the photo
        'components/RecoveryAlertBanner.tsx', // unthemed: a light card with its own red700/red800 text, reads in both
        'components/SsoButton.tsx',    // the providers' own white button
    ]);
    // Hard-coded (a palette step or a literal), not a theme token: tokens follow the scheme by design.
    const hardCoded = (value: string) => /^(palette\.|['"])/.test(value);
    it('no screen hard-codes a white background outside the known brand and glyph uses', () => {
        const offenders = ALL
            .filter(s => !WHITE_OK.has(s.file))
            .flatMap(s => darkValues(s.file, s.src, 'backgroundColor')
                .filter(({ value }) => {
                    const c = hardCoded(value) ? resolve(value) : undefined;
                    return !!c && c.alpha >= 0.5 && c.hex === '#ffffff';
                })
                .map(({ at, value }) => `${at} ${value}`));
        expect(offenders).toEqual([]);
    });

    // Pale grounds (slate50, gray100, red100, '#f8fafc', rgba(255,255,255,0.9) …) under the theme's light text. Allowed
    // only for a pale pill or box that brings its own dark text, which then reads in both schemes; by value.
    const PALE_OK: Record<string, string[]> = {
        'components/DecideSection.tsx': ['palette.red100', 'palette.green100', 'palette.amber100', 'palette.indigo100'], // debt warning, status pills
        'components/ProposeDecisionModal.tsx': ['palette.red100'],          // removal warning, red700/red900 text
        'app/(tabs)/market.tsx': ["'#dbeafe'"],                             // "YOU" pill, #1e40af text
        // Base styles whose dark look is laid over at render: `theme === 'dark' && { backgroundColor: … }` (lines 237, 296, 398)
        'components/ArchetypeQuizModal.tsx': ['palette.green50', 'palette.grayAlt100', 'palette.gray200'],
    };
    it('no themed screen hard-codes a pale ground without a dark branch', () => {
        const offenders = ALL
            .filter(s => themed(s.src) && !WHITE_OK.has(s.file))
            .flatMap(s => darkValues(s.file, s.src, 'backgroundColor')
                .filter(({ value }) => {
                    if (!hardCoded(value) || PALE_OK[s.file]?.includes(value)) return false;
                    const c = resolve(value);
                    return !!c && c.alpha >= 0.5 && luminance(c.hex) >= 0.6;
                })
                .map(({ at, value }) => `${at} ${value}`));
        expect(offenders).toEqual([]);
    });

    // Finding 2 and the review card (Sonnet check of #1834): parts of a control need 3:1 on the ground behind them,
    // text 4.5:1. Read from the source and computed from the dark tokens, so a later swap to a weak colour fails here.
    it('the distance slider and the review card reach 3:1 (parts) and 4.5:1 (text) in dark', () => {
        const value = (file: string, prop: string, near?: RegExp) => {
            const src = ALL.find(s => s.file === file)!.src;
            const all = darkValues(file, src, prop);
            const hit = near ? all.find(v => near.test(src.split('\n')[Number(v.at.split(':').pop()) - 1])) : all[0];
            return resolve(hit!.value)!.hex;
        };
        const card = darkColors.surface.card; // the slider's bottom panel and the review card
        const slider = 'components/RadiusPickerModal.tsx';
        expect(contrast(value(slider, 'thumbTintColor'), card)).toBeGreaterThanOrEqual(3);
        expect(contrast(value(slider, 'maximumTrackTintColor'), card)).toBeGreaterThanOrEqual(3);
        expect(contrast(value(slider, 'minimumTrackTintColor'), card)).toBeGreaterThanOrEqual(3);
        const review = 'components/ReviewModal.tsx';
        expect(contrast(value(review, 'color', /starInactive/), card)).toBeGreaterThanOrEqual(3);
        expect(contrast(value(review, 'color', /submitText/), value(review, 'backgroundColor', /submitBtn/))).toBeGreaterThanOrEqual(4.5);
    });

    // My Deals' History tab (showcase lane, 13 Oct): on main the Edit label was 2.00:1, the dates 3.60:1 (the shared
    // dark muted), and the Completed badge and Review button kept their pale light fills. Text needs 4.5:1 on what is behind it.
    it("My Deals' History rows read at 4.5:1 in dark and keep their light colours", () => {
        const file = 'components/MyDealsSheet.tsx';
        const src = ALL.find(s => s.file === file)!.src;
        const block = (name: string) => src.slice(src.indexOf(`        ${name}: {`), src.indexOf('},', src.indexOf(`        ${name}: {`)));
        const dark = (name: string, prop: string) => resolve(darkValues(file, block(name), prop)[0].value)!.hex;
        const light = (name: string, prop: string) => /\?[^:]*:\s*([^,\n]+)/.exec(block(name).split(`${prop}: `)[1])?.[1].trim() ?? block(name).split(`${prop}: `)[1].split(',')[0].trim();
        const card = darkColors.surface.card;
        expect(contrast(dark('dateText', 'color'), card)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(dark('statusTextCompleted', 'color'), dark('statusCompleted', 'backgroundColor'))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(dark('reviewBtnText', 'color'), dark('reviewBtn', 'backgroundColor'))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(dark('historyChipTextActive', 'color'), dark('historyChipActive', 'backgroundColor'))).toBeGreaterThanOrEqual(4.5); // the selected filter
        const edit = darkValues(file, src, 'color').find(v => />Edit<\/Text>/.test(src.split('\n')[Number(v.at.split(':').pop()) - 1]))!;
        const editGround = darkValues(file, src, 'backgroundColor').find(v => /borderColor: colors\.border\.strong/.test(src.split('\n')[Number(v.at.split(':').pop()) - 1]))!;
        expect(contrast(resolve(edit.value)!.hex, resolve(editGround.value)!.hex)).toBeGreaterThanOrEqual(4.5);
        // Light keeps the colours it had.
        expect(light('dateText', 'color')).toBe('colors.text.muted');
        expect(light('statusCompleted', 'backgroundColor')).toBe('palette.emerald100');
        expect(light('statusTextCompleted', 'color')).toBe('palette.emerald800');
        expect(light('reviewBtn', 'backgroundColor')).toBe('palette.amber100');
        expect(light('reviewBtn', 'borderColor')).toBe('palette.yellow300');
        expect(light('reviewBtnText', 'color')).toBe('palette.amber700');
        expect(light('historyChipTextActive', 'color')).toBe('colors.text.inverse');
    });
});

