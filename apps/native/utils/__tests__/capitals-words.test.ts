/**
 * Translated words go into capitals through core's upperCase, the language's way (Turkish "i" is "İ", Greek drops its
 * accents), never `.toUpperCase()`, which is the English rule in every language. A code, an id or hex stays on
 * toUpperCase. This reads the phone's source for `.toUpperCase()` straight after a call that gives back translated words.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const NATIVE = path.resolve(__dirname, '../..');
/** Calls whose result is words in the member's language. */
const TRANSLATED = new Set(['t', 'tn', 'categoryLabel', 'chatLineWords', 'listingStatusWords', 'formatDate', 'timeAgo']);

function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === 'node_modules' || e.name === '__tests__' ? [] : sourceFiles(p);
        return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
}

/** The name of the call that ends just before `end` (`t(…)` → "t"), or null when it isn't a call. */
function calleeBefore(src: string, end: number): string | null {
    if (src[end - 1] !== ')') return null;
    let depth = 0;
    for (let i = end - 1; i >= 0; i--) {
        if (src[i] === ')') depth++;
        else if (src[i] === '(' && --depth === 0) return /([A-Za-z_$][\w$]*)\s*$/.exec(src.slice(Math.max(0, i - 80), i))?.[1] ?? null;
    }
    return null;
}

describe('translated words in capitals', () => {
    it('no `.toUpperCase()` on a call that gives back translated words, anywhere in the phone app', () => {
        const found: string[] = [];
        for (const dir of ['app', 'components', 'utils', 'constants']) {
            for (const file of sourceFiles(path.join(NATIVE, dir))) {
                const src = fs.readFileSync(file, 'utf8');
                for (const m of src.matchAll(/\.toUpperCase\(\)/g)) {
                    const callee = calleeBefore(src, m.index!);
                    if (callee && TRANSLATED.has(callee)) found.push(`${path.relative(NATIVE, file)}:${src.slice(0, m.index).split('\n').length} ${callee}(…)`);
                }
            }
        }
        expect(found).toEqual([]);
    });

    it('the check finds one', () => {
        const src = "<Text>{t('Ask to join as a {keeper}', { keeper: kw.keeper }).toUpperCase()}</Text>";
        expect(calleeBefore(src, src.indexOf('.toUpperCase()'))).toBe('t');
        const code = "const s = raw.trim().toUpperCase();";
        expect(calleeBefore(code, code.indexOf('.toUpperCase()'))).toBe('trim');
    });
});
