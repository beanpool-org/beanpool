import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { contrastRatio } from '@beanpool/core';
import { darkColors, lightColors } from '../../constants/colors';

/**
 * In dark the sage accent is a light fill (nature-300) under charcoal words. White on it is 1.66:1, so words and icons
 * on `colors.accent.fill` take `colors.text.onAccent`, never `text.inverse`, `palette.white` or a white hex. #1904
 * moved 13 spots to `text.onAccent`, and the confirmation review (finding 2) put white back at three of them in a
 * scratch copy: every test still passed. This reads the source with the TypeScript parser and fails when it comes back.
 *
 * An element is "on the accent" when its `style` sets `backgroundColor: colors.accent.fill` inline or names a style
 * (in the same file or a file it imports by a relative path) that does. Every `color` on it and inside it, inline,
 * through a named style or as a `color=` prop, must not be white unless the same expression also names
 * `text.onAccent` (`selected ? colors.text.onAccent : colors.text.inverse` draws white only when the fill is off).
 * A fill handed to a component as a prop (FilterChipButton's `activeColor`) is not followed: that component's
 * `activeTextColor` must be set by hand, as market.tsx does for For You.
 *
 * The confirmation review's finding 1: the dark sage tint (`accent.tint`, nature-900) is lighter than the indigo it
 * replaced, so `text.secondary` on it is 4.22. Words on `accent.tint` must reach 4.5; the second block judges the pair
 * and bans a word token from the tint's styles while it reads below the bar.
 */
const NATIVE_ROOT = join(__dirname, '..', '..');
const PROTECTED = new Set(['app/(tabs)/map.tsx', 'components/GlobalHeader.tsx', 'components/UnifiedMapPin.tsx', 'components/Map.web.tsx']);
/** The names screens give their style objects: `styles.badge`, `s.chip`, `st.hint`, `chatStyles.sendBtnActive`. */
const STYLE_OBJECT = /^(?:s|st|ss|\w*styles?)$/i;
const WHITE = /colors\.text\.inverse\b|palette\.white\b|['"`]#fff(?:fff)?['"`]|['"`]white['"`]/i;

interface Source {
    file: string;
    path: string;
    sf: ts.SourceFile;
}

function sources(): Source[] {
    const out: Source[] = [];
    const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
            const path = join(dir, name);
            if (statSync(path).isDirectory()) {
                if (name !== '__tests__' && name !== 'node_modules') walk(path);
            } else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) {
                const file = relative(NATIVE_ROOT, path);
                if (PROTECTED.has(file)) continue;
                const kind = name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
                out.push({ file, path, sf: ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, kind) });
            }
        }
    };
    for (const dir of ['app', 'components', 'utils', 'hooks']) {
        if (existsSync(join(NATIVE_ROOT, dir))) walk(join(NATIVE_ROOT, dir));
    }
    return out;
}

const ALL = sources();
const BY_PATH = new Map(ALL.map((s) => [s.path, s]));
const where = (s: Source, node: ts.Node) => `${s.file}:${s.sf.getLineAndCharacterOfPosition(node.getStart(s.sf)).line + 1}`;

function visit(node: ts.Node, fn: (n: ts.Node) => void) {
    fn(node);
    node.forEachChild((child) => visit(child, fn));
}

function propName(p: ts.ObjectLiteralElementLike): string | undefined {
    if (!ts.isPropertyAssignment(p)) return undefined;
    return ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
}

/** A property of an object literal by name, as source text. */
function prop(obj: ts.ObjectLiteralExpression, name: string, s: Source): string | undefined {
    const p = obj.properties.find((x) => propName(x) === name);
    return p && ts.isPropertyAssignment(p) ? p.initializer.getText(s.sf) : undefined;
}

const isAccentFill = (text: string | undefined) => !!text && /\bcolors\.accent\.fill\b/.test(text);
const isAccentTint = (text: string | undefined) => !!text && /\bcolors\.accent\.tint\b/.test(text);

/** Each file's named styles (`key: { ... }` anywhere in it), with their background and words colours. */
interface NamedStyle {
    background?: string;
    color?: string;
    at: string;
}
function namedStyles(s: Source): Map<string, NamedStyle> {
    const out = new Map<string, NamedStyle>();
    visit(s.sf, (n) => {
        if (!ts.isPropertyAssignment(n) || !ts.isObjectLiteralExpression(n.initializer)) return;
        const name = propName(n);
        if (!name) return;
        const background = prop(n.initializer, 'backgroundColor', s);
        const color = prop(n.initializer, 'color', s);
        if (background || color) out.set(name, { background, color, at: where(s, n) });
    });
    return out;
}

/** The named styles a file can reach: its own, then those of the files it imports by a relative path. */
function reachableStyles(s: Source): Map<string, NamedStyle> {
    const out = new Map<string, NamedStyle>();
    for (const stmt of s.sf.statements) {
        if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
        const spec = stmt.moduleSpecifier.text;
        if (!spec.startsWith('.')) continue;
        const base = resolve(dirname(s.path), spec);
        for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
            const dep = BY_PATH.get(candidate);
            if (dep) for (const [k, v] of namedStyles(dep)) out.set(k, v);
        }
    }
    for (const [k, v] of namedStyles(s)) out.set(k, v);
    return out;
}

function attr(el: ts.JsxOpeningLikeElement, name: string): ts.Expression | undefined {
    for (const a of el.attributes.properties) {
        if (ts.isJsxAttribute(a) && a.name.getText() === name && a.initializer && ts.isJsxExpression(a.initializer)) return a.initializer.expression;
    }
    return undefined;
}

/** The condition that switches an entry on: `c && x` or `c ? x : y` gives [c, true] for x, [c, false] for y. */
function guardOf(node: ts.Node, stop: ts.Node, s: Source): [string, boolean] | undefined {
    for (let child = node, p = node.parent; p && child !== stop; child = p, p = p.parent) {
        if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && p.right === child) return [p.left.getText(s.sf), true];
        if (ts.isConditionalExpression(p) && p.whenTrue === child) return [p.condition.getText(s.sf), true];
        if (ts.isConditionalExpression(p) && p.whenFalse === child) return [p.condition.getText(s.sf), false];
    }
    return undefined;
}

/** The entries of a style expression that set `key` (inline objects and named styles), in source order. */
function styleEntries(style: ts.Expression, key: 'backgroundColor' | 'color', s: Source, styles: Map<string, NamedStyle>) {
    const out: { node: ts.Node; text: string; via?: string }[] = [];
    visit(style, (n) => {
        if (ts.isObjectLiteralExpression(n)) {
            const v = prop(n, key, s);
            if (v) out.push({ node: n, text: v });
        } else if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && STYLE_OBJECT.test(n.expression.text)) {
            const st = styles.get(n.name.text);
            const v = key === 'color' ? st?.color : st?.background;
            if (v) out.push({ node: n, text: v, via: `${n.name.text}, ${st!.at}` });
        }
    });
    return out;
}

/**
 * Elements whose own style puts them on a ground `test` accepts, the subtree of each, and `off`: each condition that
 * takes the element off that ground, with the value that does it. In `[styles.badge, muted && styles.badgeMuted]`
 * the badge is off the fill when `muted` is true; in `[styles.card, isCreating && styles.cardActive]` it is on the
 * tint only while `isCreating`, so the chevron drawn in `isCreating ? <Spinner/> : <Chevron/>` is not on it.
 */
function elementsOn(s: Source, styles: Map<string, NamedStyle>, test: (bg: string | undefined) => boolean) {
    const out: { el: ts.JsxOpeningLikeElement; subtree: ts.Node; off: Map<string, boolean> }[] = [];
    visit(s.sf, (n) => {
        const el = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : undefined;
        if (!el) return;
        const style = attr(el, 'style');
        if (!style) return;
        const bgs = styleEntries(style, 'backgroundColor', s, styles).filter((b) => !/transparent/.test(b.text));
        const i = bgs.findIndex((b) => test(b.text));
        if (i < 0) return;
        const off = new Map<string, boolean>();
        const g = guardOf(bgs[i].node, style, s);
        if (g) off.set(g[0], !g[1]);
        for (const later of bgs.slice(i + 1)) {
            if (test(later.text)) continue;
            const h = guardOf(later.node, style, s);
            if (!h) return; // always painted over
            off.set(h[0], h[1]);
        }
        out.push({ el, subtree: n, off });
    });
    return out;
}

/** The entries of a style that apply while the element is on its ground; the last one that sets `color` wins. */
function styleColours(style: ts.Expression, s: Source, styles: Map<string, NamedStyle>, off: Map<string, boolean>) {
    const entries = styleEntries(style, 'color', s, styles).filter((e) => {
        const g = guardOf(e.node, style, s);
        return !(g && off.get(g[0]) === g[1]);
    });
    if (entries.length <= 1) return entries;
    const last = entries[entries.length - 1];
    let branch: ts.Node | undefined;
    for (let p = last.node.parent; p && p !== style.parent; p = p.parent) if (ts.isConditionalExpression(p)) branch = p;
    return branch ? entries.filter((e) => e.node.pos >= branch!.pos && e.node.end <= branch!.end) : [last];
}

/**
 * Every words/icon colour drawn by an element and its children while it is on its ground: [where, expression]. A child
 * that paints its own ground (any other backgroundColor) is not on this one, so its subtree is skipped.
 */
function wordColours(
    subtree: ts.Node,
    s: Source,
    styles: Map<string, NamedStyle>,
    ground: (bg: string | undefined) => boolean,
    off: Map<string, boolean>,
): [string, string][] {
    const out: [string, string][] = [];
    const walk = (n: ts.Node, root: boolean) => {
        if (ts.isConditionalExpression(n) && off.has(n.condition.getText(s.sf))) {
            walk(off.get(n.condition.getText(s.sf)) ? n.whenFalse : n.whenTrue, false);
            return;
        }
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && off.get(n.left.getText(s.sf)) === true) return;
        const el = ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : undefined;
        if (el) {
            const style = attr(el, 'style');
            if (style && !root) {
                const own = styleEntries(style, 'backgroundColor', s, styles).map((b) => b.text).filter((bg) => !/transparent/.test(bg));
                if (own.length > 0 && !own.some(ground)) return;
            }
            const color = attr(el, 'color');
            if (color) {
                const c = ts.isConditionalExpression(color) && off.has(color.condition.getText(s.sf))
                    ? (off.get(color.condition.getText(s.sf)) ? color.whenFalse : color.whenTrue)
                    : color;
                out.push([where(s, el), c.getText(s.sf)]);
            }
            if (style) for (const c of styleColours(style, s, styles, off)) out.push([c.via ? `${where(s, el)} (${c.via})` : where(s, el), c.text]);
        }
        n.forEachChild((child) => walk(child, false));
    };
    walk(subtree, true);
    return out;
}

describe('words and icons on the sage accent fill are text.onAccent, never white', () => {
    const checked: string[] = [];
    const hits: string[] = [];
    for (const s of ALL) {
        if (!/colors\.accent\.fill/.test(s.sf.text) && !reachableStylesHaveFill(s)) continue;
        const styles = reachableStyles(s);
        // A style that sets both the fill and its words.
        for (const [name, st] of namedStyles(s)) {
            if (isAccentFill(st.background) && st.color && WHITE.test(st.color) && !/onAccent/.test(st.color)) hits.push(`${st.at} ${name}: ${st.color}`);
        }
        for (const { el, subtree, off } of elementsOn(s, styles, isAccentFill)) {
            checked.push(where(s, el));
            for (const [at, expr] of wordColours(subtree, s, styles, isAccentFill, off)) {
                if (WHITE.test(expr) && !/\btext\.onAccent\b/.test(expr)) hits.push(`${at} ${expr}`);
            }
        }
    }

    it('finds the elements on the accent (the badges, the send and react buttons, the ticks, For You, the CTAs)', () => {
        // 13 at #1904's round 3; fewer means the reader went blind, not that the screens changed.
        expect(checked.length, checked.join('\n')).toBeGreaterThanOrEqual(10);
    });

    it('none of them draws white words or icons (1.66:1 on the dark sage)', () => {
        expect(hits, 'use colors.text.onAccent on colors.accent.fill').toEqual([]);
    });
});

function reachableStylesHaveFill(s: Source): boolean {
    for (const st of reachableStyles(s).values()) if (isAccentFill(st.background)) return true;
    return false;
}

describe('words on the sage tint (accent.tint) reach 4.5 in both themes', () => {
    const WORDS = ['text.heading', 'text.body', 'text.secondary', 'accent.primary'] as const;
    const get = (tree: unknown, path: string) => path.split('.').reduce<unknown>((n, k) => (n as Record<string, unknown>)[k], tree) as string;
    const ratios = WORDS.map((token) => {
        const light = contrastRatio(get(lightColors, token), lightColors.accent.tint);
        const dark = contrastRatio(get(darkColors, token), darkColors.accent.tint);
        return { token, light, dark, min: Math.min(light, dark) };
    });

    it.each(ratios.filter((r) => r.token !== 'text.secondary').map((r) => [r.token, r] as const))('%s on accent.tint', (_t, r) => {
        expect(Number(r.min.toFixed(2)), `light ${r.light.toFixed(2)}, dark ${r.dark.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    });

    it('no style or element on accent.tint uses a word token that reads below 4.5 on it (text.secondary: 4.22 in dark)', () => {
        // text.muted on the tint is the open text.muted question for Marty (2.22 in dark), judged in its own round.
        const banned = ratios.filter((r) => r.min < 4.5).map((r) => r.token);
        const pattern = new RegExp(`\\bcolors\\.(?:${banned.map((t) => t.replace('.', '\\.')).join('|')})\\b`);
        const hits: string[] = [];
        if (banned.length === 0) return;
        for (const s of ALL) {
            if (!/colors\.accent\.tint/.test(s.sf.text)) continue;
            const styles = reachableStyles(s);
            for (const [name, st] of namedStyles(s)) {
                if (isAccentTint(st.background) && st.color && pattern.test(st.color)) hits.push(`${st.at} ${name}: ${st.color}`);
            }
            for (const { subtree, off } of elementsOn(s, styles, isAccentTint)) {
                for (const [at, expr] of wordColours(subtree, s, styles, isAccentTint, off)) {
                    if (pattern.test(expr)) hits.push(`${at} ${expr}`);
                }
            }
        }
        expect(hits, `${banned.join(', ')} on colors.accent.tint reads below 4.5: use text.body or accent.primary`).toEqual([]);
    });
});
