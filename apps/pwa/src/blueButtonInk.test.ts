/**
 * The page's ink (`var(--text-primary)`) is charcoal in light and oat in dark: on the blue fill (#2563eb) it reads in
 * dark only. Rehearsal 14 Oct 2026, S3: the onboarding's "Next →" and "Let's Begin! 🚀" were #1d231d on blue, 3.1:1, and
 * the install banner's How? and Install the same (B1). Words on the blue are the brand's white ink, `var(--bp-commit-on)`.
 *
 * This reads every inline style object in the source and fails on one whose background names the blue and whose
 * colour is the page's ink.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC = path.resolve(__dirname);
const BLUE = '#2563eb';

function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return files(p);
        return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : [];
    });
}

/** `{ background: … '#2563eb' …, color: 'var(--text-primary)' }` anywhere in `text`: where each one is. */
export function pageInkOnBlue(text: string, file = 'x.tsx'): number[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const lines: number[] = [];
    const prop = (o: ts.ObjectLiteralExpression, names: string[]) => o.properties.find(
        (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && names.includes(p.name.text));
    const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
            const bg = prop(node, ['background', 'backgroundColor']);
            const color = prop(node, ['color']);
            if (bg && color && bg.initializer.getText(source).toLowerCase().includes(BLUE)
                && ts.isStringLiteralLike(color.initializer) && color.initializer.text === 'var(--text-primary)') {
                lines.push(source.getLineAndCharacterOfPosition(color.getStart(source)).line + 1);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return lines;
}

describe('words on the blue fill are the white ink', () => {
    it("no inline style puts the page's ink on #2563eb", () => {
        const found: string[] = [];
        for (const file of files(SRC)) {
            for (const line of pageInkOnBlue(fs.readFileSync(file, 'utf8'), file)) found.push(`${path.relative(SRC, file)}:${line}`);
        }
        expect(found).toEqual([]);
    });

    it('catches what it is for', () => {
        expect(pageInkOnBlue(`const s = { background: loading ? '#555' : '#2563eb', color: 'var(--text-primary)' };`)).toEqual([1]);
        expect(pageInkOnBlue(`const s = { background: '#2563eb', color: 'var(--bp-commit-on)' };`)).toEqual([]);
        // The pale disabled fill keeps the page's ink: only the blue branch takes the white.
        expect(pageInkOnBlue(`const s = { background: off ? 'var(--border-primary)' : '#2563eb', color: off ? 'var(--text-primary)' : 'var(--bp-commit-on)' };`)).toEqual([]);
        expect(pageInkOnBlue(`const s = { background: 'var(--bg-secondary)', color: 'var(--text-primary)' };`)).toEqual([]);
    });
});
