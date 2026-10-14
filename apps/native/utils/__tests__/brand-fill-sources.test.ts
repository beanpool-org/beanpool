import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * "Change a colour once, every app follows" (docs/brand-colours.md) holds only while no screen keeps its own copy of a
 * brand fill. The review of #1904 (finding 2) found five `BUTTON_GREEN = palette.emerald700` copies of the commit fill
 * and three themed screens reading `lightColors.*.fill` / `.solid`, which would stay light if core ever gave the fill a
 * dark value. These read the source and fail when either pattern comes back. Protected files are not judged here.
 */
const NATIVE_ROOT = join(__dirname, '..', '..');
const PROTECTED = new Set(['app/(tabs)/map.tsx', 'components/GlobalHeader.tsx', 'components/UnifiedMapPin.tsx', 'components/Map.web.tsx']);

function sources(): { file: string; src: string }[] {
    const out: { file: string; src: string }[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) {
                if (name !== '__tests__' && name !== 'node_modules') walk(path);
            } else if (/\.tsx?$/.test(name)) {
                const file = relative(NATIVE_ROOT, path);
                if (!PROTECTED.has(file)) out.push({ file, src: readFileSync(path, 'utf8') });
            }
        }
    };
    for (const dir of ['app', 'components', 'utils', 'hooks']) {
        try {
            walk(join(NATIVE_ROOT, dir));
        } catch {
            // a folder this checkout does not have
        }
    }
    return out;
}

const ALL = sources();
const lineOf = (src: string, index: number) => src.slice(0, index).split('\n').length;

describe('screens take brand fills from the theme, never a copy', () => {
    it('reads the files', () => {
        expect(ALL.length).toBeGreaterThan(100);
    });

    it('no screen names the commit fill (emerald-700) itself: it uses colors.brand.fill, or brand.primary for words', () => {
        const hits: string[] = [];
        for (const { file, src } of ALL) {
            for (const m of src.matchAll(/palette\.emerald700\b|'#047857'|\bBUTTON_GREEN\b/gi)) hits.push(`${file}:${lineOf(src, m.index!)} ${m[0]}`);
        }
        expect(hits).toEqual([]);
    });

    it('no themed screen paints a fill from the light set (lightColors.*.fill / .solid / action.*)', () => {
        const hits: string[] = [];
        for (const { file, src } of ALL) {
            if (!/\buse(Theme|Styles)\(/.test(src)) continue; // an always-light banner may name the light set
            for (const m of src.matchAll(/\blightColors\.(?:(?:brand|accent)\.fill|feedback\.\w+\.solid|action\.\w+)/g)) {
                hits.push(`${file}:${lineOf(src, m.index!)} ${m[0]}`);
            }
        }
        expect(hits).toEqual([]);
    });
});
