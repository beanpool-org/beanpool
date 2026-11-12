import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

/**
 * The files that draw with the STATIC colour set (constants/colors.ts `colors`, `lightColors` or `darkColors`, or its
 * default export) instead of the set ThemeContext picked (`useTheme().colors`, or a `colors` prop). A colour set (Light,
 * Classic, Dark) cannot reach what such a file draws from them. Colour themes T2 (scratch/fable-design/DESIGN-themes-fable.md
 * §7) listed every one: each moved off the static set or carries a line `// Static colours: <why>` saying why it is fixed.
 *
 * The count may only go down. A new file on the static set fails here: draw it from useTheme() (or take a `colors` prop), or,
 * if it truly must stay fixed, give it the line and raise the ceiling in the same change so a reviewer sees it.
 */
const NATIVE_ROOT = join(__dirname, '..', '..');
const DIRS = ['app', 'components', 'tools', 'utils', 'hooks'];
/** 26 on 12 Nov 2026 (T2): 12 prop defaults every caller fills, 3 prop defaults a caller leaves empty, 9 module-level, the scanner, and one unused. */
const MAX_STATIC_COLOUR_FILES = 26;
const STATIC_NAMES = new Set(['colors', 'lightColors', 'darkColors']);
const REASON = /^\s*\/\/ Static colours: .{30,}/m;

/** The static bindings a source imports from constants/colors: value imports of the names above, or the default. */
export function staticColourImports(text: string, file = 'x.tsx'): string[] {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out: string[] = [];
    for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
        if (!/(^|\/)constants\/colors$/.test(st.moduleSpecifier.text)) continue;
        const clause = st.importClause;
        if (!clause || clause.isTypeOnly) continue;
        if (clause.name) out.push('default');
        const named = clause.namedBindings;
        if (named && ts.isNamedImports(named)) {
            for (const el of named.elements) {
                const imported = (el.propertyName ?? el.name).text;
                if (!el.isTypeOnly && STATIC_NAMES.has(imported)) out.push(imported);
            }
        }
    }
    return out;
}

function sources(): Array<{ file: string; text: string }> {
    const out: Array<{ file: string; text: string }> = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) {
                if (name !== '__tests__' && name !== 'node_modules') walk(path);
            } else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) {
                out.push({ file: relative(NATIVE_ROOT, path).split(sep).join('/'), text: readFileSync(path, 'utf8') });
            }
        }
    };
    for (const dir of DIRS) if (existsSync(join(NATIVE_ROOT, dir))) walk(join(NATIVE_ROOT, dir));
    return out;
}

const STATIC = sources().filter((s) => staticColourImports(s.text, s.file).length > 0);

describe('files on the static colour set: listed, each with its reason, never more', () => {
    it('finds them (a reader gone blind finds none)', () => {
        expect(STATIC.length, STATIC.map((s) => s.file).join('\n')).toBeGreaterThan(10);
    });

    it(`stay at or under ${MAX_STATIC_COLOUR_FILES}`, () => {
        expect(STATIC.length, `${STATIC.length} files import the static colours:\n${STATIC.map((s) => s.file).join('\n')}`).toBeLessThanOrEqual(MAX_STATIC_COLOUR_FILES);
    });

    it('each says why it is fixed, in a `// Static colours:` line', () => {
        expect(STATIC.filter((s) => !REASON.test(s.text)).map((s) => s.file)).toEqual([]);
    });

    it('ThemeContext and the onboarding colours pick the tree by set, never the static one', () => {
        const files = STATIC.map((s) => s.file);
        for (const f of ['app/ThemeContext.tsx', 'utils/onboarding-colors.ts', 'utils/drawn-colours.ts']) expect(files).not.toContain(f);
    });

    it('can fail: it reads value imports, aliased or default, and skips types and the palette', () => {
        expect(staticColourImports("import { colors } from '../constants/colors';")).toEqual(['colors']);
        expect(staticColourImports("import { colors as lightColors, type AppColors } from '../../constants/colors';")).toEqual(['colors']);
        expect(staticColourImports("import colours from '../constants/colors';")).toEqual(['default']);
        expect(staticColourImports("import { darkColors, palette } from '../constants/colors';")).toEqual(['darkColors']);
        expect(staticColourImports("import type { AppColors } from '../constants/colors';")).toEqual([]);
        expect(staticColourImports("import { palette, COLOUR_SETS, type AppColors } from '../constants/colors';")).toEqual([]);
        expect(staticColourImports("import { type lightColors } from '../constants/colors';")).toEqual([]);
        expect(REASON.test('// Static colours: why')).toBe(false);
    });
});
