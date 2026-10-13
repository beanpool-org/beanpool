/**
 * Dark mode: a light hover fill needs a dark hover fill beside it. `hover:bg-oat-200` beats `dark:bg-nature-800` under
 * the pointer, so in dark mode the button turns light while its `dark:text-*` stays light too: "← Back to Settings"
 * measured 1.34:1, Going/Interested 1.27:1, the channel buttons 1.22:1 (PR #1833 checks 2 and 3). The dark-contrast
 * check only hovers what its screens reach, so this test reads every class string in the source instead.
 *
 * A class string is a quoted string or a template literal. In a template the fixed text holds for every branch, and
 * each quoted string inside a `${}` is one branch, so `${on ? 'dark:text-x' : 'hover:bg-oat-50'}` is two buttons, not
 * one. A combination fails when it has a light `hover:bg-` (white, or a 50/100/200 shade, with or without /opacity)
 * and a `dark:text-` or `dark:bg-`, but no `dark:hover:bg-`.
 *
 * The few that may stay as they are go in ALLOWED, each with why.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC = path.resolve(__dirname);

/** [file, a piece of the class string that marks the one place, why it may keep a light hover in dark mode]. */
const ALLOWED: Array<[string, string, string]> = [];

const LIGHT_HOVER = /^bg-(?:white|[a-z]+-(?:50|100|200))(?:\/\d+)?$/;

function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return files(p);
        return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : [];
    });
}

/** The utility and its variants: `dark:hover:bg-x` → { variants: ['dark', 'hover'], utility: 'bg-x' }. */
function split(token: string) {
    const parts = token.split(':');
    return { variants: parts.slice(0, -1), utility: parts[parts.length - 1] };
}

/** The light hover fill that would show in dark mode, or null when this set of classes is fine. */
function lightHoverWithoutPartner(classes: string[]): string | null {
    let lightHover: string | null = null;
    let darkInkOrFill = false;
    let darkHover = false;
    for (const token of classes) {
        const { variants, utility } = split(token);
        if (variants.includes('dark') && variants.includes('hover') && utility.startsWith('bg-')) darkHover = true;
        else if (variants.length === 1 && variants[0] === 'dark' && /^(?:text|bg)-/.test(utility)) darkInkOrFill = true;
        else if (variants.includes('hover') && !variants.includes('dark') && LIGHT_HOVER.test(utility)) lightHover = token;
    }
    return lightHover && darkInkOrFill && !darkHover ? lightHover : null;
}

type Piece = { text: string; node: ts.Node };

/** What a `${}` can put into the class string: each string it may end in. `a && 'x'` may also put nothing. */
function branches(node: ts.Expression): Piece[] {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [{ text: node.text, node }];
    if (ts.isTemplateExpression(node)) return [{ text: [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' '), node }];
    if (ts.isParenthesizedExpression(node)) return branches(node.expression);
    if (ts.isConditionalExpression(node)) return [...branches(node.whenTrue), ...branches(node.whenFalse)];
    if (ts.isBinaryExpression(node)) {
        if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return [...branches(node.right), { text: '', node }];
        if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
            return [...branches(node.left), ...branches(node.right)];
        }
    }
    return [];
}

function words(text: string): string[] {
    return text.split(/\s+/).filter(Boolean);
}

describe('dark mode hover', () => {
    it('every light hover fill that sits beside a dark: ink or fill has a dark:hover:bg- partner', () => {
        const found: string[] = [];
        for (const file of files(SRC)) {
            const rel = path.relative(SRC, file).split(path.sep).join('/');
            const text = fs.readFileSync(file, 'utf8');
            const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
            const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            const check = (classes: string[], whole: string, at: ts.Node) => {
                const hover = lightHoverWithoutPartner(classes);
                if (!hover) return;
                if (ALLOWED.some(([f, piece]) => f === rel && whole.includes(piece))) return;
                const entry = `${rel}:${line(at)} ${hover}`;
                if (!found.includes(entry)) found.push(entry);
            };
            const visit = (node: ts.Node): void => {
                if (ts.isTemplateExpression(node)) {
                    // The fixed text goes with every branch; each ${} contributes one of its strings (or nothing).
                    const fixed = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
                    let combos: Piece[][] = [[]];
                    for (const span of node.templateSpans) {
                        const options = branches(span.expression);
                        if (options.length === 0) continue;
                        combos = combos.flatMap((c) => options.map((o) => [...c, o])).slice(0, 4096);
                    }
                    for (const combo of combos) {
                        const classes = [...words(fixed), ...combo.flatMap((p) => words(p.text))];
                        const hover = lightHoverWithoutPartner(classes);
                        const holder = combo.find((p) => words(p.text).includes(hover ?? '')) ?? { node };
                        check(classes, [fixed, ...combo.map((p) => p.text)].join(' '), holder.node);
                    }
                    // A template nested in a ${} is a class string of its own too.
                    node.templateSpans.forEach((s) => (function inner(n: ts.Node): void {
                        if (ts.isTemplateExpression(n)) visit(n);
                        else ts.forEachChild(n, inner);
                    })(s.expression));
                    return;
                }
                if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
                    check(words(node.text), node.text, node);
                    return;
                }
                ts.forEachChild(node, visit);
            };
            visit(source);
        }
        expect(found).toEqual([]);
    });

    it('sees a light hover in one branch and the dark ink in the fixed text, and lets branches that never meet pass', () => {
        expect(lightHoverWithoutPartner(words('bg-white dark:bg-nature-800 dark:text-nature-300 hover:bg-oat-50'))).toBe('hover:bg-oat-50');
        expect(lightHoverWithoutPartner(words('dark:text-nature-300 hover:bg-red-50/60'))).toBe('hover:bg-red-50/60');
        expect(lightHoverWithoutPartner(words('dark:text-nature-300 hover:bg-oat-200 dark:hover:bg-nature-700'))).toBeNull();
        expect(lightHoverWithoutPartner(words('text-nature-700 hover:bg-oat-50'))).toBeNull();
        expect(lightHoverWithoutPartner(words('dark:text-white hover:bg-emerald-700'))).toBeNull();
        expect(lightHoverWithoutPartner(words('dark:text-white group-hover:bg-oat-50'))).toBeNull();
    });
});
