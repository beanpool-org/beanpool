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
 * A partner is not enough on its own: `dark:hover:bg-nature-700` under `dark:text-nature-300` is 4.01:1, and under
 * `dark:text-nature-400` 2.88:1 (PR #1833 check 4, 19 buttons). So each combination's colours are also resolved from
 * the app's Tailwind palette and its dark theme variables, the way the built CSS settles them in dark mode: with
 * `darkMode: 'selector'` a `dark:` class is `:where(.dark, .dark *)` and adds nothing to specificity, so under the
 * pointer `hover:text-x` (two classes' worth) beats `dark:text-y`, and `dark:hover:` beats both. A fill with /opacity
 * is laid over the dark page (--bg-primary); words with /opacity over the fill. Under 4.5:1 fails, or 3:1 when the
 * class string itself makes the words large (text-2xl and up, or text-xl bold).
 *
 * The few that may stay as they are go in ALLOWED, each with why.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import resolveConfig from 'tailwindcss/resolveConfig';

const SRC = path.resolve(__dirname);

/** [file, a piece of the class string that marks the one place, why it may keep a light hover in dark mode]. */
const ALLOWED: Array<[string, string, string]> = [];

/** [file, a piece of the class string that marks the one place, why its dark hover may read under AA]. */
const ALLOWED_HOVER_CONTRAST: Array<[string, string, string]> = [];

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

// ——— Colours, as the built CSS gives them in dark mode ———

type Rgba = [number, number, number, number];
type Palette = { colour: (name: string) => Rgba | null; page: Rgba };

function hex(value: string): Rgba | null {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
    if (!m) return null;
    const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}

/** The app's palette (tailwind.config.js over Tailwind's own) and the `:root.dark-theme` variables in index.css. */
async function darkPalette(): Promise<Palette> {
    const configUrl = pathToFileURL(path.resolve(SRC, '../tailwind.config.js')).href;
    const { default: config } = await import(/* @vite-ignore */ configUrl);
    const flat = new Map<string, string>();
    const walk = (prefix: string, value: unknown) => {
        if (typeof value === 'string') flat.set(prefix, value);
        else if (value && typeof value === 'object') {
            for (const [k, v] of Object.entries(value)) walk(k === 'DEFAULT' ? prefix : prefix ? `${prefix}-${k}` : k, v);
        }
    };
    walk('', resolveConfig(config).theme.colors);

    const vars = new Map<string, string>();
    const css = fs.readFileSync(path.join(SRC, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const block of css.matchAll(/:root\.dark-theme\s*\{([^}]*)\}/g)) {
        for (const decl of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars.set(decl[1], decl[2].trim());
    }
    const value = (v: string, depth = 0): Rgba | null => {
        const ref = /^var\((--[\w-]+)\)$/.exec(v.trim());
        if (ref) return depth < 5 && vars.has(ref[1]) ? value(vars.get(ref[1])!, depth + 1) : null;
        if (v === 'transparent') return [0, 0, 0, 0];
        return hex(v);
    };
    const page = value('var(--bg-primary)');
    if (!page) throw new Error('index.css has no dark --bg-primary');
    return {
        page,
        colour: (name) => {
            const arbitrary = /^\[(#[0-9a-f]{3,6})\]$/i.exec(name);
            if (arbitrary) return hex(arbitrary[1]);
            const known = flat.get(name);
            return known == null ? null : value(known);
        },
    };
}

/** `nature-700/50` → the colour at half strength; null for anything that is not a colour (`text-xs`, `bg-cover`). */
function paint(palette: Palette, utility: string, prefix: 'text-' | 'bg-'): Rgba | null {
    if (!utility.startsWith(prefix)) return null;
    const m = /^(.+?)(?:\/(\d+|\[[\d.]+\]))?$/.exec(utility.slice(prefix.length));
    if (!m) return null;
    const c = palette.colour(m[1]);
    if (!c) return null;
    const alpha = m[2] == null ? 1 : m[2].startsWith('[') ? Number(m[2].slice(1, -1)) : Number(m[2]) / 100;
    return [c[0], c[1], c[2], c[3] * alpha];
}

function over(top: Rgba, under: Rgba): Rgba {
    const a = top[3];
    return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1) as Rgba;
}

function luminance([r, g, b]: Rgba): number {
    const lin = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: Rgba, b: Rgba): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

/** Large text by WCAG, only when the class string says so: 24 px (text-2xl and up), or 18.66 px bold (text-xl bold). */
function large(classes: string[]): boolean {
    const base = classes.filter((t) => !t.includes(':'));
    const px = base.map((t) => {
        const named = { 'text-xl': 20, 'text-2xl': 24, 'text-3xl': 30, 'text-4xl': 36, 'text-5xl': 48 }[t];
        const arbitrary = /^text-\[(\d+(?:\.\d+)?)px\]$/.exec(t);
        return named ?? (arbitrary ? Number(arbitrary[1]) : 0);
    });
    const size = Math.max(0, ...px);
    const bold = base.some((t) => /^font-(?:bold|extrabold|black)$/.test(t));
    return size >= 24 || (bold && size >= 18.66);
}

type Seen = { text: string; bg: string; ratio: number; need: number };

/**
 * The words and the fill in dark mode, at rest or under the pointer, settled as the CSS settles them (dark:hover: over
 * hover: over dark: over plain), or null when this class string does not decide both, or does not style dark mode.
 */
function darkPair(palette: Palette, classes: string[], hovered: boolean): Seen | null {
    const rank = (variants: string[]) => {
        if (variants.some((v) => v !== 'dark' && v !== 'hover')) return -1;
        if (!hovered && variants.includes('hover')) return -1;
        return (variants.includes('hover') ? 2 : 0) + (variants.includes('dark') ? 1 : 0);
    };
    const pick = (prefix: 'text-' | 'bg-') => {
        let best: { token: string; colour: Rgba; rank: number } | null = null;
        for (const token of classes) {
            const { variants, utility } = split(token);
            const r = rank(variants);
            const colour = r < 0 ? null : paint(palette, utility, prefix);
            if (colour && (!best || r > best.rank)) best = { token, colour, rank: r };
        }
        return best;
    };
    const text = pick('text-');
    const bg = pick('bg-');
    if (!text || !bg) return null;
    // Only what this class string styles for dark mode; and under the pointer, only where the pointer changes something.
    if (text.rank % 2 === 0 && bg.rank % 2 === 0) return null;
    if (hovered && text.rank < 2 && bg.rank < 2) return null;
    const fill = over(bg.colour, palette.page);
    const ink = over(text.colour, fill);
    return { text: text.token, bg: bg.token, ratio: ratio(ink, fill), need: large(classes) ? 3 : 4.5 };
}

// ——— Every class string in the source ———

type Piece = { text: string; node: ts.Node };
type ClassString = { rel: string; line: (node: ts.Node) => number; classes: string[]; whole: string; pieces: Piece[]; node: ts.Node };

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

/** Each combination a class string can take, with what it is made of (for the line to name). */
function classStrings(): ClassString[] {
    const out: ClassString[] = [];
    for (const file of files(SRC)) {
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        const text = fs.readFileSync(file, 'utf8');
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const line = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
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
                    out.push({
                        rel, line, node, pieces: combo,
                        classes: [...words(fixed), ...combo.flatMap((p) => words(p.text))],
                        whole: [fixed, ...combo.map((p) => p.text)].join(' '),
                    });
                }
                // A template nested in a ${} is a class string of its own too.
                node.templateSpans.forEach((s) => (function inner(n: ts.Node): void {
                    if (ts.isTemplateExpression(n)) visit(n);
                    else ts.forEachChild(n, inner);
                })(s.expression));
                return;
            }
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
                out.push({ rel, line, node, pieces: [], classes: words(node.text), whole: node.text });
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return out;
}

/** The line of the branch that holds one of these classes, or of the class string. */
function where(cs: ClassString, tokens: string[]): string {
    const holder = cs.pieces.find((p) => words(p.text).some((w) => tokens.includes(w))) ?? { node: cs.node };
    return `${cs.rel}:${cs.line(holder.node)}`;
}

/** Each place whose dark words read under AA, at rest or under the pointer: `file:line text-x on bg-y 4.01:1`. */
function darkContrastFailures(palette: Palette, all: ClassString[], hovered: boolean, allowed: Array<[string, string, string]>): string[] {
    const found: string[] = [];
    for (const cs of all) {
        const seen = darkPair(palette, cs.classes, hovered);
        if (!seen || seen.ratio >= seen.need) continue;
        if (allowed.some(([f, piece]) => f === cs.rel && cs.whole.includes(piece))) continue;
        const entry = `${where(cs, [seen.text, seen.bg])} ${seen.text} on ${seen.bg} ${seen.ratio.toFixed(2)}:1`;
        if (!found.includes(entry)) found.push(entry);
    }
    return found;
}

describe('dark mode hover', () => {
    const all = classStrings();

    it('every light hover fill that sits beside a dark: ink or fill has a dark:hover:bg- partner', () => {
        const found: string[] = [];
        for (const cs of all) {
            const hover = lightHoverWithoutPartner(cs.classes);
            if (!hover) continue;
            if (ALLOWED.some(([f, piece]) => f === cs.rel && cs.whole.includes(piece))) continue;
            const entry = `${where(cs, [hover])} ${hover}`;
            if (!found.includes(entry)) found.push(entry);
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

    it('every dark hover keeps its words at 4.5:1 (3:1 when the class string makes them large)', async () => {
        const palette = await darkPalette();
        expect(darkContrastFailures(palette, all, true, ALLOWED_HOVER_CONTRAST)).toEqual([]);
    });

    it('settles dark colours the way the CSS does', async () => {
        const palette = await darkPalette();
        const pair = (s: string, hovered = true) => {
            const seen = darkPair(palette, words(s), hovered);
            return seen && { text: seen.text, bg: seen.bg, ratio: Number(seen.ratio.toFixed(2)), need: seen.need };
        };
        // The 19 of check 4: nature-300 words on the nature-700 hover fill, and nature-400 on it.
        expect(pair('bg-white dark:bg-nature-800 text-nature-700 dark:text-nature-300 hover:bg-nature-50 dark:hover:bg-nature-700'))
            .toEqual({ text: 'dark:text-nature-300', bg: 'dark:hover:bg-nature-700', ratio: 4.01, need: 4.5 });
        expect(pair('text-nature-600 dark:text-nature-400 bg-nature-100 hover:bg-nature-200 dark:bg-nature-800 dark:hover:bg-nature-700')?.ratio).toBe(2.88);
        // A hover ink partner settles it.
        expect(pair('dark:text-nature-300 dark:hover:bg-nature-700 dark:hover:text-nature-200')?.ratio).toBeGreaterThanOrEqual(4.5);
        // hover:text- outranks dark:text- under the pointer (a dark: class adds no specificity).
        expect(pair('dark:bg-nature-800 dark:text-nature-300 hover:text-nature-900')?.text).toBe('hover:text-nature-900');
        // At rest the hover classes play no part, and dark: wins over plain.
        expect(pair('bg-white dark:bg-nature-800 text-nature-700 dark:text-nature-300 hover:bg-nature-50', false))
            .toEqual({ text: 'dark:text-nature-300', bg: 'dark:bg-nature-800', ratio: 5.25, need: 4.5 });
        // /opacity: a fill over the dark page, words over the fill.
        expect(pair('dark:bg-white/10 dark:text-white/50', false)?.ratio).toBeLessThan(pair('dark:bg-white/10 dark:text-white', false)!.ratio);
        // Theme variables resolve to their dark values; arbitrary hex too.
        expect(pair('bg-bg-card dark:text-[#f6f4f0]', false)?.ratio).toBeGreaterThan(10);
        // Large only when the class string says so.
        expect(pair('text-2xl dark:text-nature-400 dark:hover:bg-nature-700')?.need).toBe(3);
        expect(pair('text-xl font-bold dark:text-nature-400 dark:hover:bg-nature-700')?.need).toBe(3);
        expect(pair('text-xl font-semibold dark:text-nature-400 dark:hover:bg-nature-700')?.need).toBe(4.5);
        // Nothing to judge: no fill known, nothing dark, or (under the pointer) nothing the pointer changes.
        expect(pair('dark:text-nature-300 hover:underline')).toBeNull();
        expect(pair('bg-white text-nature-700 hover:bg-oat-50')).toBeNull();
        expect(pair('dark:bg-nature-800 dark:text-nature-300')).toBeNull();
        // Other variants (focus:, md:, group-hover:) are not the hover this test reads.
        expect(pair('dark:bg-nature-800 dark:text-nature-300 focus:bg-white')).toBeNull();
    });
});

