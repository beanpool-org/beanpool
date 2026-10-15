import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { brandCssVariableMap, brandTailwindColours } from '../../../packages/beanpool-core/src/brand-colours';
// @ts-expect-error -- tailwind.config.js is plain JS with no types (the manager's tsconfig has no allowJs); the test reads its shape.
import tailwindConfig from '../tailwind.config.js';

/**
 * "Change a colour once, every app follows" (docs/brand-colours.md) holds in the manager only while no control keeps
 * its own Tailwind shade. Buttons with words take a fill role (`bg-bp-cta-fill text-bp-cta-on hover:bg-bp-cta-hover`,
 * likewise commit, danger, gold); chips and the tinted buttons that look like them take a chip role
 * (`bg-bp-chip-danger-tint text-bp-chip-danger-ink`). These read every class string in src and fail when a raw
 * terracotta, emerald, red, rose, amber, orange, green or yellow shade comes back on a control.
 *
 * Not judged: status dots, meters and progress bars (a fill with no words and no hover), words and icons on the page
 * (inks such as `text-red-300`), outlines, and notice panels (a deep tint with words but no hover).
 */
const SRC = __dirname;
const FAMILY = '(?:terra|emerald|red|rose|amber|orange|green|yellow)';

function sources(): { file: string; src: string }[] {
    const out: { file: string; src: string }[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) walk(path);
            else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push({ file: relative(SRC, path), src: readFileSync(path, 'utf8') });
        }
    };
    walk(SRC);
    return out;
}

/** Every quoted or template string, with its line: a class list is one of these. */
function classStrings(): { at: string; text: string }[] {
    const out: { at: string; text: string }[] = [];
    for (const { file, src } of sources()) {
        for (const m of src.matchAll(/(["'`])((?:(?!\1)[^\n\\])*)\1/g)) {
            out.push({ at: `${file}:${src.slice(0, m.index).split('\n').length}`, text: m[2] });
        }
    }
    return out;
}

const STRINGS = classStrings();
const token = (pattern: string) => new RegExp(`(?:^|\\s)${pattern}(?=\\s|$)`);
const WORDS = /(?:^|\s)text-(?!xs|sm|base|lg|xl|\d|\[|left|right|center|justify)[a-z]/;
const hits = (when: (text: string) => boolean) => STRINGS.filter((s) => when(s.text)).map((s) => `${s.at} ${s.text.trim().slice(0, 140)}`);

describe('manager controls take brand and status colours from the library, never a Tailwind shade', () => {
    it('reads the files', () => {
        expect(sources().length).toBeGreaterThan(70);
    });

    it('a filled control (words on it, or a hover) uses a fill role: no solid terracotta/emerald/red/amber shade', () => {
        const solid = token(`bg-${FAMILY}-[4-8]00`);
        expect(hits((t) => solid.test(t) && (WORDS.test(t) || /(?:^|\s)hover:/.test(t)))).toEqual([]);
    });

    it('a control that turns a status colour on hover uses a chip role (tinted buttons, alert pills)', () => {
        const hover = token(`hover:bg-${FAMILY}-\\d+(?:/\\d+)?`);
        expect(hits((t) => hover.test(t) && WORDS.test(t))).toEqual([]);
    });

    it('a chip (words on a pale status tint) uses a chip role', () => {
        const chip = token(`bg-${FAMILY}-[3-5]00/(?:5|10|15|20|25|30)`);
        expect(hits((t) => chip.test(t) && WORDS.test(t))).toEqual([]);
    });

    it('words on a role fill are that role\'s words: no white words on gold, no other role\'s ink', () => {
        const wrong: string[] = [];
        for (const { at, text } of STRINGS) {
            for (const m of text.matchAll(/(?:^|\s)(hover:)?bg-bp-(cta|commit|action|danger|gold|accent)-fill(?=\s|$)/g)) {
                const [, state = '', role] = m;
                if (!token(`${state}text-bp-${role}-on`).test(text)) wrong.push(`${at} ${state}bg-bp-${role}-fill without ${state}text-bp-${role}-on`);
            }
            if (/(?:^|\s)bg-bp-gold-fill(?=\s|$)/.test(text) && token('text-white').test(text)) wrong.push(`${at} white words on gold`);
        }
        expect(wrong).toEqual([]);
    });

    it('a chip tint carries its own ink', () => {
        const wrong: string[] = [];
        for (const { at, text } of STRINGS) {
            for (const m of text.matchAll(/(?:^|\s)bg-bp-chip-(ok|need|warn|danger|accent)-tint(?=\s|$)/g)) {
                if (!token(`text-bp-chip-${m[1]}-ink`).test(text)) wrong.push(`${at} chip-${m[1]}-tint without text-bp-chip-${m[1]}-ink`);
            }
        }
        expect(wrong).toEqual([]);
    });

    it('tailwind.config.js names the roles and declares their values from the library, light and dark', () => {
        const colours = (tailwindConfig as { theme: { extend: { colors: Record<string, unknown> } } }).theme.extend.colors;
        expect(colours.bp).toEqual(brandTailwindColours().bp);
        const base: Record<string, unknown> = {};
        const plugins = (tailwindConfig as { plugins: Array<(api: { addBase: (css: Record<string, unknown>) => void }) => void> }).plugins;
        for (const plugin of plugins) plugin({ addBase: (css) => Object.assign(base, css) });
        expect(base[':root']).toEqual(brandCssVariableMap('light'));
        expect(base[':root.dark']).toEqual(brandCssVariableMap('dark'));
        expect(readFileSync(join(SRC, '..', 'tailwind.config.js'), 'utf8')).not.toMatch(/#(?:b85236|047857|b91c1c|f59e0b)\b/i);
    });
});
