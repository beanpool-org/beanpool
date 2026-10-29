/**
 * Static check: every piece of words that a phone screen draws on a background THE SAME SCREEN sets reaches WCAG 4.5:1
 * (3:1 for 24px words, or 18.66px and bold) in the light AND the dark colour set.
 *
 * Why: Save Profile was white on white in dark for two weeks after the colour library moved (settings.tsx: background
 * `colors.text.heading` with words `colors.text.inverse`, both #ffffff in darkColors). text-ink-contrast.test.ts holds the
 * grey inks to the standard grounds, and the web has pwa_dark_classes; nothing read a button's own fill against its own
 * label. This does, without a device: it parses app/ and components/ with the TypeScript compiler, and for every JSX
 * element whose style sets a `color` (a <Text>) it finds the nearest enclosing element that sets a `backgroundColor`
 * (or the element's own), resolves both through lightColors and darkColors, and measures them with core's contrastRatio.
 *
 * What it reads, per theme:
 *   - style={styles.x}, arrays (later entries win), object literals, `cond && style`, `cond ? a : b`, spreads, StyleSheet.flatten,
 *     a Pressable's `({ pressed }) => [...]`, and a StyleSheet.create table found through `styles`, `useStyles(...)`,
 *     `useMemo(() => makeStyles(...))` or `makeStyles(...)`.
 *   - colours as `colors.a.b` (also `c.a.b`), `palette.x`, hex/rgb/rgba strings, and a local `const X = '#...'`.
 *   - `theme === 'dark'`, `dark`, `isDark` and their negations are folded for the theme being measured.
 *   - any other condition is a switch: the background and the words are measured under the SAME setting of it, so
 *     `active && bg` beside `active && ink` is never crossed with `!active`. A pair that exists only while the control is
 *     `disabled` is not measured (WCAG exempts inactive controls).
 *
 * What it does NOT judge (counted in the report, never silently passed as clean): words or backgrounds it cannot resolve
 * (`tone.fg`, `rgbaOf(...)`, a prop), words with no background set above them on the same screen (text-ink-contrast covers
 * the standard grounds), icons, and anything behind a component boundary (a custom component's own background).
 * Translucent fills are laid over the page, then over the card, and the worse result counts.
 *
 * Node only: this file reads the source tree and is never imported by the app.
 */
import * as ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { blendOver, contrastRatio } from '@beanpool/core';
import { darkColors, lightColors, palette } from '../constants/colors';
import { BUTTON_CONTRAST_EXCEPTIONS, type ContrastException } from './button-contrast-exceptions';

export type Theme = 'light' | 'dark';
const THEMES: readonly Theme[] = ['light', 'dark'];
const TREES = { light: lightColors, dark: darkColors } as const;

/** Names a screen binds the colour set to (`const { colors } = useTheme()`, `colors: c`). */
const COLOUR_ROOTS = new Set(['colors', 'c']);
/** Elements whose children are drawn on the element's own background and nothing else. */
const PLAIN_BOXES = new Set([
    'View', 'Pressable', 'TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback', 'ScrollView', 'SafeAreaView',
    'KeyboardAvoidingView', 'Animated.View', 'Animated.ScrollView',
]);
const TEXTS = new Set(['Text', 'Animated.Text', 'TextInput']);
const MAX_ALTS = 256;
const MAX_DEPTH = 14;

// ── Values ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface Rgba { r: number; g: number; b: number; a: number }
/** A colour a screen asked for: what it resolved to in this theme, how it was written, and on which line. */
interface Paint { rgba: Rgba; expr: string; line: number }
interface Unresolved { unresolved: string }
type Colour = Paint | Unresolved;
/** The settings of the unknown conditions this style assumes: `active` -> true. */
type Cond = Map<string, boolean>;
interface Props { bg?: Colour; color?: Colour; size?: number; bold?: boolean }
interface Alt { cond: Cond; props: Props }

const isUnresolved = (c: Colour): c is Unresolved => 'unresolved' in c;
const emptyAlt = (): Alt => ({ cond: new Map(), props: {} });

function mergeCond(a: Cond, b: Cond): Cond | null {
    const out = new Map(a);
    for (const [k, v] of b) {
        if (out.has(k) && out.get(k) !== v) return null;
        out.set(k, v);
    }
    return out;
}

const NAMED: Record<string, Rgba> = {
    transparent: { r: 0, g: 0, b: 0, a: 0 },
    white: { r: 255, g: 255, b: 255, a: 1 },
    black: { r: 0, g: 0, b: 0, a: 1 },
};

export function parseColour(raw: string): Rgba | null {
    const s = raw.trim().toLowerCase();
    if (NAMED[s]) return NAMED[s];
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
    if (hex) {
        let h = hex[1];
        if (h.length <= 4) h = [...h].map((ch) => ch + ch).join('');
        const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
        return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
    }
    const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
    if (fn) return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: fn[4] === undefined ? 1 : Number(fn[4]) };
    return null;
}

const toHex = ({ r, g, b }: Rgba) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// ── Reading the source ───────────────────────────────────────────────────────────────────────────────────────────

interface Ctx {
    sf: ts.SourceFile;
    theme: Theme;
    opaque: { count: number };
}

const lineOf = (n: ts.Node, sf: ts.SourceFile) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
const textOf = (n: ts.Node, sf: ts.SourceFile) => n.getText(sf).replace(/\s+/g, ' ');

function unwrap(e: ts.Expression): ts.Expression {
    while (
        ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) ||
        ts.isTypeAssertionExpression(e)
    ) e = e.expression;
    return e;
}

/** `a.b.c` or `a['b'].c` as a root name and a path; null for anything with a call or a computed key in it. */
function pathOf(e: ts.Expression): { root: string; path: string[] } | null {
    const path: string[] = [];
    let cur = unwrap(e);
    for (;;) {
        if (ts.isPropertyAccessExpression(cur)) {
            path.unshift(cur.name.text);
            cur = unwrap(cur.expression);
        } else if (ts.isElementAccessExpression(cur) && ts.isStringLiteralLike(cur.argumentExpression)) {
            path.unshift(cur.argumentExpression.text);
            cur = unwrap(cur.expression);
        } else break;
    }
    return ts.isIdentifier(cur) ? { root: cur.text, path } : null;
}

/** The initialiser (or function) a name was declared with, found by walking out through the enclosing blocks. */
function findDecl(name: string, from: ts.Node): ts.Node | undefined {
    for (let n: ts.Node | undefined = from.parent; n; n = n.parent) {
        if (!('statements' in n)) continue;
        for (const st of (n as ts.Block).statements) {
            if (ts.isVariableStatement(st)) {
                for (const d of st.declarationList.declarations) {
                    if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer;
                }
            } else if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
        }
    }
    return undefined;
}

const isStyleSheetCreate = (n: ts.Node): n is ts.CallExpression =>
    ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'create' &&
    ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'StyleSheet';

/** The object literal of the StyleSheet.create call a declaration leads to, following one local `makeStyles(...)` hop. */
function findCreate(n: ts.Node, hops = 0): ts.ObjectLiteralExpression | undefined {
    let found: ts.ObjectLiteralExpression | undefined;
    const visit = (x: ts.Node) => {
        if (found) return;
        if (isStyleSheetCreate(x)) {
            const arg = x.arguments[0];
            if (arg && ts.isObjectLiteralExpression(unwrap(arg))) found = unwrap(arg) as ts.ObjectLiteralExpression;
            return;
        }
        if (hops < 3 && ts.isCallExpression(x) && ts.isIdentifier(x.expression)) {
            const decl = findDecl(x.expression.text, x);
            const hit = decl && decl !== n ? findCreate(decl, hops + 1) : undefined;
            if (hit) { found = hit; return; }
        }
        ts.forEachChild(x, visit);
    };
    visit(n);
    return found;
}

function bindingNames(name: ts.BindingName, out = new Set<string>()): Set<string> {
    if (ts.isIdentifier(name)) out.add(name.text);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
    return out;
}

/**
 * True when `name` is bound by a parameter or a declaration around `from` (`const { colors } = useTheme()`, `useStyles(({ colors }) =>`):
 * the colours of the theme being drawn. False when it is only the module's import: `colors` there is the light set, in both themes.
 */
function isBoundAround(name: string, from: ts.Node): boolean {
    for (let n: ts.Node | undefined = from.parent; n; n = n.parent) {
        if (ts.isFunctionLike(n) && n.parameters.some((p) => bindingNames(p.name).has(name))) return true;
        if ('statements' in n) {
            for (const st of (n as ts.Block).statements) {
                if (ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => bindingNames(d.name).has(name))) return true;
            }
        }
    }
    return false;
}

function propName(p: ts.ObjectLiteralElementLike): string | undefined {
    const n = p.name;
    if (!n) return undefined;
    return ts.isIdentifier(n) || ts.isStringLiteralLike(n) ? n.text : undefined;
}

// ── Conditions ───────────────────────────────────────────────────────────────────────────────────────────────────

/** One way a test can go: the settings of the switches it reads, and what it comes to. */
interface Case { cond: Cond; value: boolean }
const constant = (value: boolean): Case[] => [{ cond: new Map(), value }];
const atom = (key: string, inverted: boolean): Case[] => [
    { cond: new Map([[key, true]]), value: !inverted },
    { cond: new Map([[key, false]]), value: inverted },
];

/** `x < y` is read as "not `x >= y`", so a fill chosen by one and a state set by the other are the same switch. */
const COMPLEMENT: Partial<Record<ts.SyntaxKind, string>> = {
    [ts.SyntaxKind.LessThanToken]: '>=',
    [ts.SyntaxKind.GreaterThanToken]: '<=',
    [ts.SyntaxKind.ExclamationEqualsEqualsToken]: '===',
    [ts.SyntaxKind.ExclamationEqualsToken]: '==',
};

/**
 * Every way a condition can go for the theme being measured. The theme tests (`theme === 'dark'`, `dark`, `isDark`) are
 * answered; every other test is a switch, named by its text. `a && !b` is broken into `a` and `b` so it is measured under
 * the same settings as a style that tests `a` alone.
 */
function condCases(e0: ts.Expression, ctx: Ctx): Case[] {
    const e = unwrap(e0);
    if (e.kind === ts.SyntaxKind.TrueKeyword) return constant(true);
    if (e.kind === ts.SyntaxKind.FalseKeyword) return constant(false);
    if (ts.isIdentifier(e)) {
        if (e.text === 'dark' || e.text === 'isDark') return constant(ctx.theme === 'dark');
        if (e.text === 'isLight') return constant(ctx.theme === 'light');
    }
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
        return condCases(e.operand, ctx).map((c) => ({ cond: c.cond, value: !c.value }));
    }
    if (ts.isBinaryExpression(e)) {
        const op = e.operatorToken.kind;
        const eq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
        const ne = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
        if (eq || ne) {
            const [l, r] = [unwrap(e.left), unwrap(e.right)];
            const themeSide = ts.isIdentifier(l) && l.text === 'theme' ? r : ts.isIdentifier(r) && r.text === 'theme' ? l : undefined;
            if (themeSide && ts.isStringLiteralLike(themeSide) && (themeSide.text === 'dark' || themeSide.text === 'light')) {
                return constant((ctx.theme === themeSide.text) === eq);
            }
        }
        if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
            const and = op === ts.SyntaxKind.AmpersandAmpersandToken;
            const out: Case[] = [];
            for (const l of condCases(e.left, ctx)) {
                if (l.value !== and) { out.push(l); continue; } // `false && _` and `true || _` are decided by the left
                for (const r of condCases(e.right, ctx)) {
                    const cond = mergeCond(l.cond, r.cond);
                    if (cond) out.push({ cond, value: r.value });
                }
            }
            return out;
        }
        const complement = COMPLEMENT[op];
        if (complement) return atom(`${textOf(e.left, ctx.sf)} ${complement} ${textOf(e.right, ctx.sf)}`, true);
    }
    return atom(textOf(e, ctx.sf), false);
}

/** The settings of the switches under which `test` comes to `truthy` (none when the theme alone decides it the other way). */
const settingsWhere = (test: ts.Expression, truthy: boolean, ctx: Ctx): Cond[] =>
    condCases(test, ctx).filter((c) => c.value === truthy).map((c) => c.cond);

function withCond(alts: Alt[], cond: Cond): Alt[] {
    return alts.flatMap((a) => {
        const merged = mergeCond(a.cond, cond);
        return merged ? [{ cond: merged, props: a.props }] : [];
    });
}

// ── Colours ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface Option<T> { cond: Cond; v: T }

function lookup(tree: unknown, path: string[]): unknown {
    return path.reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as Record<string, unknown>)[k] : undefined), tree);
}

function colourLeaf(e: ts.Expression, ctx: Ctx, depth: number): Colour | null {
    const expr = textOf(e, ctx.sf);
    const line = lineOf(e, ctx.sf);
    const make = (raw: string): Colour => {
        const rgba = parseColour(raw);
        return rgba ? { rgba, expr, line } : { unresolved: expr };
    };
    if (ts.isStringLiteralLike(e)) return make(e.text);
    if (ts.isIdentifier(e) && e.text === 'undefined') return null;
    if (e.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isIdentifier(e) && depth < MAX_DEPTH) {
        const decl = findDecl(e.text, e);
        if (decl && !ts.isFunctionDeclaration(decl)) {
            const inner = colourOptions(decl as ts.Expression, ctx, depth + 1);
            if (inner.length === 1 && inner[0].cond.size === 0) {
                const v = inner[0].v;
                return v && !isUnresolved(v) ? { ...v, expr, line } : v;
            }
        }
        return { unresolved: expr };
    }
    const p = pathOf(e);
    if (p && p.path.length > 0) {
        const tree = COLOUR_ROOTS.has(p.root) ? (isBoundAround(p.root, e) ? TREES[ctx.theme] : lightColors) : p.root === 'palette' ? palette
            : p.root === 'lightColors' ? lightColors : p.root === 'darkColors' ? darkColors : undefined;
        if (tree) {
            const hit = lookup(tree, p.path);
            return typeof hit === 'string' ? make(hit) : { unresolved: expr };
        }
    }
    return { unresolved: expr };
}

/** The colours a value can take, with the switch each depends on; null means "sets nothing". */
function colourOptions(e0: ts.Expression, ctx: Ctx, depth = 0): Option<Colour | null>[] {
    const e = unwrap(e0);
    if (ts.isConditionalExpression(e)) {
        const [whenTrue, whenFalse] = [settingsWhere(e.condition, true, ctx), settingsWhere(e.condition, false, ctx)];
        const a = whenTrue.length ? colourOptions(e.whenTrue, ctx, depth + 1) : [];
        const b = whenFalse.length ? colourOptions(e.whenFalse, ctx, depth + 1) : [];
        return [
            ...whenTrue.flatMap((c) => a.flatMap((o) => withMerge(o, c))),
            ...whenFalse.flatMap((c) => b.flatMap((o) => withMerge(o, c))),
        ];
    }
    return [{ cond: new Map(), v: colourLeaf(e, ctx, depth) }];
}

function withMerge<T>(o: Option<T>, cond: Cond): Option<T>[] {
    const merged = mergeCond(o.cond, cond);
    return merged ? [{ cond: merged, v: o.v }] : [];
}

// ── Styles ───────────────────────────────────────────────────────────────────────────────────────────────────────

function override(base: Props, over: Props): Props {
    return {
        bg: over.bg ?? base.bg,
        color: over.color ?? base.color,
        size: over.size ?? base.size,
        bold: over.bold ?? base.bold,
    };
}

/** `base` then `next` on top: every consistent pairing of their alternatives. */
function cross(base: Alt[], next: Alt[]): Alt[] {
    const out: Alt[] = [];
    for (const a of base) {
        for (const b of next) {
            const cond = mergeCond(a.cond, b.cond);
            if (cond) out.push({ cond, props: override(a.props, b.props) });
            if (out.length >= MAX_ALTS) return out;
        }
    }
    return out;
}

function evalObject(o: ts.ObjectLiteralExpression, ctx: Ctx, depth: number): Alt[] {
    let acc: Alt[] = [emptyAlt()];
    for (const p of o.properties) {
        if (ts.isSpreadAssignment(p)) {
            acc = cross(acc, evalStyle(p.expression, ctx, depth + 1));
            continue;
        }
        const name = propName(p);
        const init = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : undefined;
        if (!name || !init) continue;
        if (name === 'backgroundColor' || name === 'color') {
            const options = colourOptions(init, ctx).flatMap((o2): Alt[] => (o2.v ? [{ cond: o2.cond, props: name === 'color' ? { color: o2.v } : { bg: o2.v } }] : []));
            if (options.length) acc = cross(acc, options);
        } else if (name === 'fontSize') {
            const v = unwrap(init);
            if (ts.isNumericLiteral(v)) acc = cross(acc, [{ cond: new Map(), props: { size: Number(v.text) } }]);
        } else if (name === 'fontWeight') {
            const v = unwrap(init);
            const w = ts.isStringLiteralLike(v) ? v.text : ts.isNumericLiteral(v) ? v.text : '';
            acc = cross(acc, [{ cond: new Map(), props: { bold: w === 'bold' || Number(w) >= 700 } }]);
        }
    }
    return acc;
}

function returnedExpression(fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration): ts.Expression | undefined {
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return fn.body;
    const body = fn.body;
    if (!body || !ts.isBlock(body)) return undefined;
    const ret = body.statements.find(ts.isReturnStatement);
    return ret?.expression;
}

/** Every setting of the background / words / size a style expression can produce. Anything unreadable adds nothing. */
function evalStyle(e0: ts.Expression, ctx: Ctx, depth = 0): Alt[] {
    const e = unwrap(e0);
    if (depth > MAX_DEPTH) { ctx.opaque.count++; return [emptyAlt()]; }
    if (ts.isArrayLiteralExpression(e)) {
        let acc: Alt[] = [emptyAlt()];
        for (const el of e.elements) acc = cross(acc, evalStyle(el, ctx, depth + 1));
        return acc;
    }
    if (ts.isObjectLiteralExpression(e)) return evalObject(e, ctx, depth);
    if (ts.isConditionalExpression(e)) {
        const [whenTrue, whenFalse] = [settingsWhere(e.condition, true, ctx), settingsWhere(e.condition, false, ctx)];
        const a = whenTrue.length ? evalStyle(e.whenTrue, ctx, depth + 1) : [];
        const b = whenFalse.length ? evalStyle(e.whenFalse, ctx, depth + 1) : [];
        return [...whenTrue.flatMap((c) => withCond(a, c)), ...whenFalse.flatMap((c) => withCond(b, c))];
    }
    if (ts.isBinaryExpression(e)) {
        const op = e.operatorToken.kind;
        if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
            const [off, on] = [settingsWhere(e.left, false, ctx), settingsWhere(e.left, true, ctx)];
            const right = on.length ? evalStyle(e.right, ctx, depth + 1) : [];
            return [...off.map((cond): Alt => ({ cond, props: {} })), ...on.flatMap((c) => withCond(right, c))];
        }
        if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
            return [...evalStyle(e.left, ctx, depth + 1), ...evalStyle(e.right, ctx, depth + 1)];
        }
    }
    if (e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) {
        return [emptyAlt()];
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
        const ret = returnedExpression(e);
        return ret ? evalStyle(ret, ctx, depth + 1) : [emptyAlt()];
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'flatten' && e.arguments[0]) {
        return evalStyle(e.arguments[0], ctx, depth + 1);
    }
    const p = pathOf(e);
    if (p && p.path.length === 1) {
        // styles.x, from the StyleSheet.create table `styles` was declared with
        const decl = findDecl(p.root, e);
        const table = decl ? findCreate(decl) : undefined;
        const entry = table?.properties.find((q) => propName(q) === p.path[0]);
        if (entry && ts.isPropertyAssignment(entry)) return evalStyle(entry.initializer, ctx, depth + 1);
    }
    if (ts.isIdentifier(e)) {
        const decl = findDecl(e.text, e);
        if (decl && !ts.isFunctionDeclaration(decl) && !ts.isArrowFunction(decl)) return evalStyle(decl as ts.Expression, ctx, depth + 1);
    }
    ctx.opaque.count++;
    return [emptyAlt()];
}

/** What an alternative sets, ignoring where it was written: two alternatives with the same signature read the same. */
function signature(p: Props): string {
    const c = (x?: Colour) => (x ? ('unresolved' in x ? x.unresolved : [x.expr, x.rgba.r, x.rgba.g, x.rgba.b, x.rgba.a]) : null);
    return JSON.stringify([c(p.bg), c(p.color), p.size ?? null, p.bold ?? null]);
}

/**
 * Drops the switches that change nothing: `patternEnabled && { opacity }` beside a fill gives two alternatives that set the
 * same colours, so a fault under both would be reported twice, once "while patternEnabled" and once "while !patternEnabled".
 * Two alternatives with one signature and conditions that differ in a single switch become one without it; one whose
 * conditions include another's is redundant.
 */
function simplify(alts: Alt[]): Alt[] {
    const cur = alts.map((a) => ({ cond: new Map(a.cond), props: a.props, sig: signature(a.props) }));
    for (let changed = true; changed;) {
        changed = false;
        search: for (let i = 0; i < cur.length; i++) {
            for (let j = i + 1; j < cur.length; j++) {
                if (cur[i].sig !== cur[j].sig) continue;
                const [a, b] = [cur[i].cond, cur[j].cond];
                const differing = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
                if (differing.length === 0 || [...a.keys()].every((k) => b.get(k) === a.get(k))) { cur.splice(j, 1); changed = true; break search; }
                if ([...b.keys()].every((k) => a.get(k) === b.get(k))) { cur.splice(i, 1); changed = true; break search; }
                if (differing.length === 1 && a.has(differing[0]) && b.has(differing[0])) {
                    cur[i].cond.delete(differing[0]);
                    cur.splice(j, 1);
                    changed = true;
                    break search;
                }
            }
        }
    }
    return cur.map(({ cond, props }) => ({ cond, props }));
}

// ── The screen's elements ────────────────────────────────────────────────────────────────────────────────────────

/** The backgrounds above a piece of words, outermost first, under the switch settings they assume. */
interface Chain {
    cond: Cond;
    paints: Paint[];
    poison?: string;
    /** Under a `disabled` setting of its control. */
    inactive?: boolean;
    /** The switches a style chose a colour by on the way down (the render guards in `cond` are left out of a report). */
    styled: string[];
}

export interface Finding {
    file: string;
    /** The line of the words' element. */
    line: number;
    theme: Theme;
    ratio: number;
    min: number;
    words: { expr: string; line: number; hex: string };
    background: { expr: string; line: number; hex: string };
    /** The switches the pair assumes, e.g. `pressed`. */
    when: string[];
    /** Other elements that draw the same pair. */
    alsoAt: number[];
}

export interface Stats {
    files: number;
    /** Pairs measured, per theme. */
    checked: Record<Theme, number>;
    /** Words with a colour that had no background set above them on the same screen. */
    noGround: number;
    /** Why a pair could not be measured -> how many. */
    skipped: Map<string, number>;
    /** Style expressions the scanner could not read (props, calls): they add nothing, as if layout only. */
    opaqueStyles: number;
}

export interface ContrastReport {
    stats: Stats;
    findings: Finding[];
    excused: Array<Finding & { reason: string }>;
    /** Exceptions that excuse nothing, or that are malformed. */
    badExceptions: string[];
}

const WIDE_BOLD = 18.66;
const WIDE = 24;
const needed = (size: number | undefined, bold: boolean | undefined) => ((size ?? 14) >= WIDE || ((size ?? 14) >= WIDE_BOLD && bold) ? 3 : 4.5);

function groundRatios(paints: Paint[], ink: Rgba, theme: Theme): { ratio: number; ground: string; inkHex: string } {
    const tree = TREES[theme];
    const bases: string[] = paints[0].rgba.a >= 0.995 ? [tree.surface.app] : [tree.surface.app, tree.surface.card];
    let worst = { ratio: Infinity, ground: '', inkHex: '' };
    for (const base of bases) {
        let ground: string = base;
        for (const p of paints) ground = p.rgba.a >= 0.995 ? toHex(p.rgba) : blendOver(toHex(p.rgba), p.rgba.a, ground);
        const inkHex = ink.a >= 0.995 ? toHex(ink) : blendOver(toHex(ink), ink.a, ground);
        const ratio = contrastRatio(inkHex, ground);
        if (ratio < worst.ratio) worst = { ratio, ground, inkHex };
    }
    return worst;
}

type Content = 'words' | 'glyph' | 'emoji' | 'chevron';

/**
 * What a <Text> draws, from its literal children. `emoji`: only emoji, or an expression named for one (`{opt.emoji}`,
 * `{categoryEmoji(x)}`): the emoji font ignores `color`. `chevron`: only `›` `‹` `»` `«`, a disclosure mark beside a labelled
 * row. `glyph`: other symbols with no letter or digit (a star, a tick, a cross): a graphical object, held to 3:1 not 4.5.
 * Anything with a letter, a digit, or an expression it cannot read is `words`.
 */
function contentOf(node: ts.Node, sf: ts.SourceFile): Content {
    if (!ts.isJsxElement(node)) return 'words';
    const literal: string[] = [];
    let emojiExpression = false;
    for (const child of node.children) {
        if (ts.isJsxText(child)) literal.push(child.text);
        else if (ts.isJsxExpression(child) && child.expression && ts.isStringLiteralLike(child.expression)) literal.push(child.expression.text);
        else if (ts.isJsxExpression(child) && child.expression && /emoji/i.test(child.expression.getText(sf))) emojiExpression = true;
        else if (ts.isJsxExpression(child) && !child.expression) continue; // a comment
        else return 'words';
    }
    const joined = literal.join('').trim();
    if (/[\p{L}\p{N}]/u.test(joined)) return 'words';
    if (!joined) return emojiExpression ? 'emoji' : 'words';
    // an emoji drawn by a variation selector (⚠️) or by default (🫘): what is left once those are taken out
    const rest = joined.replace(/.\uFE0F/gu, '').replace(/[\s\p{Emoji_Presentation}\p{Emoji_Modifier}\u200D]/gu, '');
    if (!rest) return 'emoji';
    if (/^[\s\u203A\u2039\u00BB\u00AB]+$/u.test(joined)) return 'chevron';
    return 'glyph';
}

function scanFile(file: string, text: string, stats: Stats, found: Map<string, Finding>): void {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    stats.files++;
    for (const theme of THEMES) {
        const ctx: Ctx = { sf, theme, opaque: { count: 0 } };
        const skip = (why: string) => stats.skipped.set(why, (stats.skipped.get(why) ?? 0) + 1);

        const check = (el: ts.Node, words: Colour, props: Props, chain: Chain, cond: Cond, content: Content, extraKeys: string[] = []) => {
            if (chain.inactive) return; // a control held disabled is exempt from the bar
            if (chain.poison !== undefined) return skip(`background unresolved: ${chain.poison}`);
            if (chain.paints.length === 0) { if (theme === 'light') stats.noGround++; return; }
            if (isUnresolved(words)) return skip(`words unresolved: ${words.unresolved}`);
            // A border colour is never a text ink (text-ink-contrast holds those): words in one are a decorative glyph, the
            // list chevron `›` in border.strong.
            if (/^(colors|c)\.border\./.test(words.expr)) return skip('decorative glyph in a border colour');
            if (content === 'emoji') return skip('emoji, drawn in its own colours');
            if (content === 'chevron') return skip('decorative chevron');
            for (const [k, v] of cond) if (v && /\bdisabled\b/i.test(k)) return; // inactive controls are exempt
            const bg = chain.paints[chain.paints.length - 1];
            if (bg.rgba.a === 0) return;
            stats.checked[theme]++;
            const { ratio, ground, inkHex } = groundRatios(chain.paints, words.rgba, theme);
            // A symbol on its own (a star, a tick, a cross) is a graphical object, held to WCAG 1.4.11's 3:1, not to the text bar.
            const min = content === 'glyph' ? 3 : needed(props.size, props.bold);
            if (Number(ratio.toFixed(2)) >= min) return;
            const chosen = new Set([...chain.styled, ...extraKeys]);
            const when = [...cond].filter(([k]) => chosen.has(k)).map(([k, v]) => (v ? k : `!(${k})`));
            const line = lineOf(el, sf);
            const key = [file, theme, words.expr, words.line, bg.expr, bg.line, when.join('&')].join('|');
            const prior = found.get(key);
            if (prior) { if (!prior.alsoAt.includes(line) && prior.line !== line) prior.alsoAt.push(line); return; }
            found.set(key, {
                file, line, theme, ratio, min,
                words: { expr: words.expr, line: words.line, hex: inkHex },
                background: { expr: bg.expr, line: bg.line, hex: ground },
                when, alsoAt: [],
            });
        };

        const fresh = (): Chain[] => [{ cond: new Map<string, boolean>(), paints: [], styled: [] }];
        const visit = (node: ts.Node, chains: Chain[]): void => {
            if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) {
                // `on && <Text/>` and `a ? <X/> : <Y/>` draw their JSX only under that setting of the switch: the words
                // are measured on the fill that setting gives, and not at all in a theme where the test is false.
                const guarded = (test: ts.Expression, whenTrue: boolean, body: ts.Node) => {
                    const settings = settingsWhere(test, whenTrue, ctx);
                    if (settings.length === 0) return;
                    visit(body, chains.flatMap((ch) => settings.flatMap((setting) => {
                        const cond = mergeCond(ch.cond, setting);
                        return cond ? [{ ...ch, cond }] : [];
                    })));
                };
                if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
                    visit(node.left, chains);
                    guarded(node.left, true, node.right);
                    return;
                }
                if (ts.isConditionalExpression(node)) {
                    visit(node.condition, chains);
                    guarded(node.condition, true, node.whenTrue);
                    guarded(node.condition, false, node.whenFalse);
                    return;
                }
                ts.forEachChild(node, (c) => visit(c, chains));
                return;
            }
            const opening = ts.isJsxElement(node) ? node.openingElement : node;
            const tag = opening.tagName.getText(sf);
            const attr = (name: string) => opening.attributes.properties.find(
                (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(sf) === name,
            );
            const styleOf = (name: string): Alt[] | null => {
                const a = attr(name);
                const init = a?.initializer;
                return init && ts.isJsxExpression(init) && init.expression ? simplify(evalStyle(init.expression, ctx)) : null;
            };
            // A ScrollView's children are drawn on its contentContainerStyle (a sheet's fill is usually there).
            const scrolled = tag.endsWith('ScrollView') ? styleOf('contentContainerStyle') : null;
            const own = scrolled ? simplify(cross(styleOf('style') ?? [emptyAlt()], scrolled)) : styleOf('style') ?? [emptyAlt()];
            const boxed = PLAIN_BOXES.has(tag) || TEXTS.has(tag);
            // The element's own `disabled` prop says which settings leave it inactive, however its fill is chosen.
            const disabledProp = attr('disabled');
            const disabledCases: Case[] | null = !disabledProp ? null
                : !disabledProp.initializer ? constant(true)
                : ts.isJsxExpression(disabledProp.initializer) && disabledProp.initializer.expression ? condCases(disabledProp.initializer.expression, ctx)
                : null;

            const next: Chain[] = [];
            for (const chain of boxed ? chains : fresh()) {
                for (const alt of own) {
                    const cond = mergeCond(chain.cond, alt.cond);
                    if (!cond) continue;
                    const inactive = chain.inactive
                        || !!disabledCases?.some((dc) => dc.value && [...dc.cond].every(([k, v]) => cond.get(k) === v));
                    const styled = [...chain.styled, ...alt.cond.keys()];
                    let c: Chain = { cond, paints: chain.paints, poison: chain.poison, inactive, styled };
                    const bg = alt.props.bg;
                    if (bg && isUnresolved(bg)) c = { cond, paints: c.paints, poison: bg.unresolved, inactive, styled };
                    else if (bg && bg.rgba.a > 0) {
                        // An opaque fill hides what is above it: only its own switches chose the ground the words sit on.
                        c = bg.rgba.a >= 0.995 ? { cond, paints: [bg], inactive, styled: [...alt.cond.keys()] } : { cond, paints: [...c.paints, bg], poison: c.poison, inactive, styled };
                    }
                    if (TEXTS.has(tag) && alt.props.color) check(opening, alt.props.color, alt.props, c, cond, contentOf(node, sf));
                    next.push(c);
                    // A component taking its label's style as a prop: the label sits on this element's background.
                    if (!boxed) {
                        for (const labelProp of ['textStyle', 'labelStyle']) {
                            for (const lab of styleOf(labelProp) ?? []) {
                                const lc = mergeCond(cond, lab.cond);
                                if (lc && lab.props.color) check(opening, lab.props.color, lab.props, c, lc, 'words', [...lab.cond.keys()]);
                            }
                        }
                    }
                }
            }
            const down = next.slice(0, MAX_ALTS);
            // Attributes are not children: a prop's JSX (renderItem, ListHeaderComponent) is drawn elsewhere.
            ts.forEachChild(opening, (c) => visit(c, fresh()));
            if (ts.isJsxElement(node)) for (const child of node.children) visit(child, down);
        };

        visit(sf, fresh());
        stats.opaqueStyles += ctx.opaque.count;
    }
}

// ── The tree, the exceptions, the report ─────────────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__tests__') walk(p, out); }
        else if (e.name.endsWith('.tsx')) out.push(p);
    }
    return out.sort();
}

function applyExceptions(found: Finding[], exceptions: readonly ContrastException[]) {
    const bad: string[] = [];
    const used = new Set<ContrastException>();
    const findings: Finding[] = [];
    const excused: Array<Finding & { reason: string }> = [];
    exceptions.forEach((x, i) => {
        const where = `exception ${i + 1} (${x.file || '?'})`;
        if (!x.file || !x.words || !x.background) bad.push(`${where}: file, words and background are all required`);
        if (!x.reason || x.reason.trim().length < 30) bad.push(`${where}: a reason of at least 30 characters is required`);
    });
    for (const f of found) {
        const hit = exceptions.find((x) => x.file === f.file && x.words === f.words.expr && x.background === f.background.expr && (!x.theme || x.theme === f.theme));
        if (hit && hit.reason && hit.reason.trim().length >= 30) { used.add(hit); excused.push({ ...f, reason: hit.reason }); }
        else findings.push(f);
    }
    exceptions.forEach((x, i) => {
        if (!used.has(x) && x.file && x.words && x.background) {
            bad.push(`exception ${i + 1} (${x.file}: ${x.words} on ${x.background}) excuses no failing pair: delete it`);
        }
    });
    return { findings, excused, bad };
}

function report(found: Map<string, Finding>, stats: Stats, exceptions: readonly ContrastException[]): ContrastReport {
    const { findings, excused, bad } = applyExceptions([...found.values()], exceptions);
    findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.theme.localeCompare(b.theme));
    return { stats, findings, excused, badExceptions: bad };
}

const newStats = (): Stats => ({ files: 0, checked: { light: 0, dark: 0 }, noGround: 0, skipped: new Map(), opaqueStyles: 0 });

/** Scan one source text (the canaries in utils/__tests__/button-contrast.test.ts use this). `file` is only a label. */
export function scanSource(file: string, text: string, exceptions: readonly ContrastException[] = []): ContrastReport {
    const stats = newStats();
    const found = new Map<string, Finding>();
    scanFile(file, text, stats, found);
    return report(found, stats, exceptions);
}

/** Scan app/ and components/ under `nativeRoot` (apps/native). */
export function scanTree(nativeRoot: string, exceptions: readonly ContrastException[] = BUTTON_CONTRAST_EXCEPTIONS): ContrastReport {
    const stats = newStats();
    const found = new Map<string, Finding>();
    for (const dir of ['app', 'components']) {
        for (const abs of walk(join(nativeRoot, dir))) {
            const rel = relative(nativeRoot, abs).split(sep).join('/');
            scanFile(rel, readFileSync(abs, 'utf8'), stats, found);
        }
    }
    return report(found, stats, exceptions);
}

export function formatReport(r: ContrastReport): string {
    const lines: string[] = [];
    const checked = r.stats.checked.light + r.stats.checked.dark;
    lines.push(`${checked} button/label pairs measured (${r.stats.checked.light} light, ${r.stats.checked.dark} dark) in ${r.stats.files} files; ` +
        `${r.stats.noGround} words had no background set above them; ${[...r.stats.skipped.values()].reduce((a, b) => a + b, 0)} could not be resolved; ` +
        `${r.excused.length} excused.`);
    for (const f of r.findings) {
        lines.push(
            '',
            `FAIL ${f.file}:${f.line}  ${f.theme}  ${f.ratio.toFixed(2)}:1 (needs ${f.min})${f.when.length ? `  while ${f.when.join(' and ')}` : ''}`,
            `     words       ${f.words.expr} = ${f.words.hex}  (${f.file}:${f.words.line})`,
            `     background  ${f.background.expr} = ${f.background.hex}  (${f.file}:${f.background.line})`,
            ...(f.alsoAt.length ? [`     also drawn at lines ${f.alsoAt.join(', ')}`] : []),
        );
    }
    for (const b of r.badExceptions) lines.push('', `BAD EXCEPTION ${b}`);
    return lines.join('\n');
}

/** For the coverage report: the most common reasons pairs could not be measured. */
export function topSkips(r: ContrastReport, n = 12): string[] {
    return [...r.stats.skipped].sort((a, b) => b[1] - a[1]).slice(0, n).map(([why, count]) => `${count}  ${why}`);
}
