/**
 * No handler closes one Modal and opens another in the same go, except through useAfterDismiss (round 2 of #3250).
 *
 * On iOS a React Native `Modal` is a presented view controller. UIKit drops a present while the presenter is still dismissing
 * another one, and React Native has already marked the second Modal presented, so it never appears (utils/screen-presented.ts,
 * round 2 of #2984). The forum topic's ⋯ → **Link a group, listing or event** did exactly that: `setMenu(null); setPicking(true)`
 * in one handler, and on an iPhone the Link picker never opened. Android's Dialogs stack and the web has no Modal, so only an
 * iPhone shows it, and the test harness (a Modal is a plain div there) never can.
 *
 * The fix is the one components/NewPostTypeSheet.tsx and components/SharePost.tsx use: on iOS hold the second Modal until the
 * first one's `onDismiss` (useAfterDismiss's `release`, with its floor timer), and open it at once elsewhere.
 *
 * This guard reads every .tsx file of the phone app. It finds each Modal a screen draws (react-native's own, or a component of
 * this app that draws one, followed through the props that make it visible) and the `useState` setters its visibility reads.
 * Then it reads every function in that file: one that, before its first `await`, sets one Modal's state to closed (false, null,
 * undefined, '') and another Modal's state to open (anything else), directly or through a local function, fails, unless the
 * same function goes through a useAfterDismiss `hold`. One state behind two Modals (`sheet === 'a'`, `sheet === 'b'`) fails too
 * when a handler drawn inside one of them sets it open. A ternary is open on its condition only (`addOpen ? groups(layout) : null`
 * opens on `addOpen`, not on `layout`). A verified exception goes in ALLOWED with the reason; an entry that no longer matches
 * anything fails too, so the list cannot rot.
 *
 * What it cannot see, and was checked by hand instead (PR #3250 lists them): a close and an open split across components (a
 * sheet that calls `onClose()` and then a parent callback that opens a Modal, which is NewPostTypeSheet's own case), and an
 * open that goes through a timer of the screen's own (Home's `afterModal`, 350 ms on iOS).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

const NATIVE = path.join(__dirname, '..', '..');
const ROOTS = ['app', 'components', 'utils', 'services', 'tools', 'constants'];

/**
 * Verified exceptions: `<file>: <closing setter> -> <opening setter>`, each with why it is safe on iOS. Empty: every case found
 * was fixed (see the PR).
 */
const ALLOWED: Record<string, string> = {};

type Fn = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
type Source = { rel: string; sf: ts.SourceFile };
/** A component of this app that draws a Modal, and the props (by name) whose value makes it visible. */
type ModalComponents = Map<string, Set<string>>; // key `${rel}#${exportedOrLocalName}`

function isFn(n: ts.Node): n is Fn {
    return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
}

function listTsx(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) listTsx(full, out);
        else if (entry.name.endsWith('.tsx')) out.push(full);
    }
    return out;
}

function parseText(rel: string, text: string): Source {
    return { rel, sf: ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) };
}

/** The local names this file gives react-native's Modal. */
function rnModalNames(sf: ts.SourceFile): Set<string> {
    const names = new Set<string>();
    for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== 'react-native') continue;
        const b = st.importClause?.namedBindings;
        if (b && ts.isNamedImports(b)) for (const el of b.elements) if ((el.propertyName ?? el.name).text === 'Modal') names.add(el.name.text);
    }
    return names;
}

/** local name → `${rel}#${name}` of the component it imports (relative imports only), for resolving a tag to its definition. */
function importTargets(src: Source, known: Set<string>): Map<string, string> {
    const out = new Map<string, string>();
    for (const st of src.sf.statements) {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
        const spec = st.moduleSpecifier.text;
        if (!spec.startsWith('.')) continue;
        const base = path.join(path.dirname(src.rel), spec);
        const rel = [`${base}.tsx`, `${base}/index.tsx`].find((r) => known.has(r));
        if (!rel) continue;
        const clause = st.importClause;
        if (clause?.name) out.set(clause.name.text, `${rel}#default`);
        const b = clause?.namedBindings;
        if (b && ts.isNamedImports(b)) for (const el of b.elements) out.set(el.name.text, `${rel}#${(el.propertyName ?? el.name).text}`);
    }
    return out;
}

/** Each component-like function declared at the top of the file: name → function (and `default` for a default export). */
function topComponents(sf: ts.SourceFile): Map<string, Fn> {
    const out = new Map<string, Fn>();
    const unwrap = (e: ts.Expression | undefined): Fn | undefined => {
        if (!e) return undefined;
        if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return e;
        // forwardRef(...), memo(...), React.memo(...)
        if (ts.isCallExpression(e) && e.arguments.length) return unwrap(e.arguments[0]);
        if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) return unwrap(e.expression);
        return undefined;
    };
    for (const st of sf.statements) {
        if (ts.isFunctionDeclaration(st) && st.body) {
            if (st.name) out.set(st.name.text, st);
            if (st.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) out.set('default', st);
        } else if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) {
                const fn = unwrap(d.initializer);
                if (fn && ts.isIdentifier(d.name)) out.set(d.name.text, fn);
            }
        } else if (ts.isExportAssignment(st) && ts.isIdentifier(st.expression)) {
            const fn = out.get(st.expression.text);
            if (fn) out.set('default', fn);
        }
    }
    return out;
}

function jsxAttrs(n: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttributes {
    return ts.isJsxElement(n) ? n.openingElement.attributes : n.attributes;
}
function jsxTag(n: ts.JsxElement | ts.JsxSelfClosingElement): string {
    return (ts.isJsxElement(n) ? n.openingElement.tagName : n.tagName).getText();
}

/** Strip parentheses, `!`-non-null and `as`. */
function bare(e: ts.Expression): ts.Expression {
    while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e)) e = e.expression;
    return e;
}

/**
 * The identifiers an expression reads to decide whether it is open (not property names after a dot), following the function's
 * own local consts. Of `a ? b : c` only the condition counts, and a branch that is itself a value that may be empty (a name,
 * `x.y`, `x[y]`, `x && y`): `addOpen ? pickerGroups(layout, tips) : null` is open on `addOpen`, never on `layout`.
 */
function readsOf(expr: ts.Node, scope: Fn | undefined, depth = 0): Set<string> {
    const out = new Set<string>();
    const visit = (n: ts.Node) => {
        if (isFn(n)) return;
        if (ts.isConditionalExpression(n)) {
            visit(n.condition);
            for (const branch of [n.whenTrue, n.whenFalse]) {
                const b = bare(branch);
                if (ts.isIdentifier(b) || ts.isPropertyAccessExpression(b) || ts.isElementAccessExpression(b) || ts.isBinaryExpression(b)) visit(b);
            }
            return;
        }
        if (ts.isPropertyAccessExpression(n)) { visit(n.expression); return; }
        if (ts.isIdentifier(n)) out.add(n.text);
        ts.forEachChild(n, visit);
    };
    visit(expr);
    if (scope && depth < 3) {
        for (const name of [...out]) {
            const init = localConst(scope, name);
            if (init) for (const r of readsOf(init, scope, depth + 1)) out.add(r);
        }
    }
    return out;
}

/** The initializer of `const name = ...` declared directly in this function's body (not in a nested one). */
function localConst(fn: Fn, name: string): ts.Expression | undefined {
    let found: ts.Expression | undefined;
    const visit = (n: ts.Node) => {
        if (found) return;
        if (n !== fn && isFn(n)) return;
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) found = n.initializer;
        else ts.forEachChild(n, visit);
    };
    visit(fn);
    return found;
}

/** The props a component reads, local name → prop name (from a destructured first parameter, or `props.x`). */
function propNames(fn: Fn): Map<string, string> {
    const out = new Map<string, string>();
    const p = fn.parameters[0];
    if (!p) return out;
    if (ts.isObjectBindingPattern(p.name)) {
        for (const el of p.name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            out.set(el.name.text, prop);
        }
    } else if (ts.isIdentifier(p.name)) {
        const props = p.name.text;
        const visit = (n: ts.Node) => {
            if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === props) out.set(`${props}.${n.name.text}`, n.name.text);
            ts.forEachChild(n, visit);
        };
        visit(fn);
    }
    return out;
}

/** The JSX elements in `root` that draw a Modal, each with the attribute expressions that make it visible. */
function modalElements(src: Source, root: ts.Node, modals: ModalComponents, imports: Map<string, string>): { node: ts.Node; tag: string; vis: ts.Expression[] }[] {
    const rn = rnModalNames(src.sf);
    const out: { node: ts.Node; tag: string; vis: ts.Expression[] }[] = [];
    const visit = (n: ts.Node) => {
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
            const tag = jsxTag(n);
            const key = imports.get(tag) ?? `${src.rel}#${tag}`;
            const visProps = rn.has(tag) ? new Set(['visible']) : modals.get(key);
            if (visProps) {
                const vis: ts.Expression[] = [];
                for (const a of jsxAttrs(n).properties) {
                    if (ts.isJsxAttribute(a) && visProps.has(a.name.getText()) && a.initializer) {
                        const init = a.initializer;
                        if (ts.isJsxExpression(init) && init.expression) vis.push(init.expression);
                    }
                }
                out.push({ node: n, tag, vis });
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(root);
    return out;
}

/** Every component of the app that draws a Modal, and which of its props make it visible (followed through wrappers). */
function findModalComponents(sources: Source[]): ModalComponents {
    const known = new Set(sources.map((s) => s.rel));
    const modals: ModalComponents = new Map();
    const imports = new Map(sources.map((s) => [s.rel, importTargets(s, known)]));
    const comps = new Map(sources.map((s) => [s.rel, topComponents(s.sf)]));
    for (let changed = true, round = 0; changed && round < 10; round++) {
        changed = false;
        for (const src of sources) {
            for (const [name, fn] of comps.get(src.rel)!) {
                const props = propNames(fn);
                if (!props.size) continue;
                const key = `${src.rel}#${name}`;
                const have = modals.get(key) ?? new Set<string>();
                const before = have.size;
                for (const el of modalElements(src, fn, modals, imports.get(src.rel)!)) {
                    for (const v of el.vis) {
                        for (const r of readsOf(v, fn)) { const prop = props.get(r); if (prop) have.add(prop); }
                        // props.open
                        v.forEachChild(function walk(c): void {
                            if (ts.isPropertyAccessExpression(c)) { const prop = props.get(c.getText()); if (prop) have.add(prop); }
                            c.forEachChild(walk);
                        });
                    }
                }
                if (have.size > before) { modals.set(key, have); changed = true; }
            }
        }
    }
    return modals;
}

type Effect = { setter: string; open: boolean };
export type Finding = { rel: string; line: number; close: string; open: string; key: string };

/** `false`, `null`, `undefined`, `''`, no argument: a close. An updater function: unknown (null). Anything else: an open. */
function opens(call: ts.CallExpression): boolean | null {
    const a = call.arguments[0];
    if (!a) return false;
    if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return null;
    if (a.kind === ts.SyntaxKind.FalseKeyword || a.kind === ts.SyntaxKind.NullKeyword) return false;
    if (ts.isIdentifier(a) && a.text === 'undefined') return false;
    if (ts.isStringLiteral(a) && a.text === '') return false;
    if (ts.isVoidExpression(a)) return false;
    return true;
}

/** Calls made in `fn` itself (not in functions nested in it), up to its first `await`. */
function syncCalls(fn: Fn): ts.CallExpression[] {
    const body = fn.body;
    if (!body) return [];
    let firstAwait = Infinity;
    const findAwait = (n: ts.Node) => {
        if (n !== fn && isFn(n)) return;
        if (ts.isAwaitExpression(n)) firstAwait = Math.min(firstAwait, n.getStart());
        ts.forEachChild(n, findAwait);
    };
    findAwait(fn);
    const out: ts.CallExpression[] = [];
    const visit = (n: ts.Node) => {
        if (n !== fn && isFn(n)) return;
        if (ts.isCallExpression(n) && n.getStart() < firstAwait) out.push(n);
        ts.forEachChild(n, visit);
    };
    visit(fn);
    return out;
}

/** Names bound from useAfterDismiss in a component: the result object (`x.hold`) or a destructured `hold`. */
function afterDismissHolds(comp: Fn): { objects: Set<string>; fns: Set<string> } {
    const objects = new Set<string>();
    const fns = new Set<string>();
    const visit = (n: ts.Node) => {
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer) && n.initializer.expression.getText() === 'useAfterDismiss') {
            if (ts.isIdentifier(n.name)) objects.add(n.name.text);
            else if (ts.isObjectBindingPattern(n.name)) {
                for (const el of n.name.elements) {
                    const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.getText();
                    if (prop === 'hold' && ts.isIdentifier(el.name)) fns.add(el.name.text);
                }
            }
        }
        ts.forEachChild(n, visit);
    };
    visit(comp);
    return { objects, fns };
}

/** Every function in this file that closes one Modal and opens another before it yields, outside useAfterDismiss. */
export function findModalAfterModal(src: Source, modals: ModalComponents, known: Set<string>): Finding[] {
    const imports = importTargets(src, known);
    const findings: Finding[] = [];
    for (const comp of topComponents(src.sf).values()) {
        // The component's own state: setter → state name.
        const setterOf = new Map<string, string>();
        const visitState = (n: ts.Node) => {
            if (ts.isVariableDeclaration(n) && ts.isArrayBindingPattern(n.name) && n.initializer && ts.isCallExpression(n.initializer)
                && /(^|\.)useState$/.test(n.initializer.expression.getText())) {
                const [v, s] = n.name.elements;
                if (v && s && ts.isBindingElement(v) && ts.isBindingElement(s) && ts.isIdentifier(v.name) && ts.isIdentifier(s.name)) setterOf.set(v.name.text, s.name.text);
            }
            ts.forEachChild(n, visitState);
        };
        visitState(comp);
        if (!setterOf.size) continue;

        // Each Modal this component draws → the setters its visibility reads.
        const modalSetters: { id: string; node: ts.Node; setters: Set<string> }[] = [];
        for (const el of modalElements(src, comp, modals, imports)) {
            const setters = new Set<string>();
            for (const v of el.vis) for (const r of readsOf(v, comp)) { const s = setterOf.get(r); if (s) setters.add(s); }
            // Its position in the file is its identity: two Modals can share a line.
            if (setters.size) modalSetters.push({ id: `${el.tag}@${el.node.getStart()}`, node: el.node, setters });
        }
        if (modalSetters.length < 2) continue;
        const modalSetterNames = new Set(modalSetters.flatMap((m) => [...m.setters]));

        // Local named functions, to follow `close(); open();` one hop (or more) down.
        const locals = new Map<string, Fn>();
        const visitLocals = (n: ts.Node) => {
            if (ts.isFunctionDeclaration(n) && n.name && n !== comp) locals.set(n.name.text, n);
            if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
                let init: ts.Expression = n.initializer;
                // useCallback(() => ..., [...])
                if (ts.isCallExpression(init) && /(^|\.)useCallback$/.test(init.expression.getText()) && init.arguments[0]) init = init.arguments[0];
                if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) locals.set(n.name.text, init);
            }
            ts.forEachChild(n, visitLocals);
        };
        visitLocals(comp);
        const holds = afterDismissHolds(comp);

        const memo = new Map<Fn, { effects: Effect[]; held: boolean }>();
        const effectsOf = (fn: Fn, seen: Set<Fn>): { effects: Effect[]; held: boolean } => {
            const cached = memo.get(fn);
            if (cached) return cached;
            if (seen.has(fn)) return { effects: [], held: false };
            seen.add(fn);
            const effects: Effect[] = [];
            let held = false;
            for (const call of syncCalls(fn)) {
                const callee = call.expression;
                if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'hold' && ts.isIdentifier(callee.expression) && holds.objects.has(callee.expression.text)) held = true;
                if (!ts.isIdentifier(callee)) continue;
                const name = callee.text;
                if (holds.fns.has(name)) held = true;
                if (modalSetterNames.has(name)) {
                    const o = opens(call);
                    if (o !== null) effects.push({ setter: name, open: o });
                } else {
                    const local = locals.get(name);
                    if (local) {
                        const sub = effectsOf(local, seen);
                        effects.push(...sub.effects);
                        held = held || sub.held;
                    }
                }
            }
            const result = { effects, held };
            memo.set(fn, result);
            return result;
        };

        const visitFns = (n: ts.Node) => {
            if (isFn(n) && n !== comp) {
                const { effects, held } = effectsOf(n, new Set());
                if (!held) {
                    for (const c of effects.filter((e) => !e.open)) {
                        for (const o of effects.filter((e) => e.open && e.setter !== c.setter)) {
                            const closed = modalSetters.filter((m) => m.setters.has(c.setter));
                            const opened = modalSetters.filter((m) => m.setters.has(o.setter));
                            if (closed.some((a) => opened.some((b) => b.id !== a.id))) {
                                const key = `${src.rel}: ${c.setter} -> ${o.setter}`;
                                if (!findings.some((f) => f.key === key && f.line === src.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1)) {
                                    findings.push({ rel: src.rel, line: src.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, close: c.setter, open: o.setter, key });
                                }
                            }
                        }
                    }
                }
            }
            ts.forEachChild(n, visitFns);
        };
        visitFns(comp);

        // One state behind two Modals (`sheet === 'a'`, `sheet === 'b'`): a handler drawn inside one of them that sets that
        // state to anything open closes it and opens the other in the same go.
        for (const m of modalSetters) {
            const shared = [...m.setters].filter((s) => modalSetters.some((o) => o.id !== m.id && o.setters.has(s)));
            if (!shared.length) continue;
            const inside = (n: ts.Node) => {
                if (isFn(n)) {
                    const { effects, held } = effectsOf(n, new Set());
                    for (const e of effects) {
                        if (held || !e.open || !shared.includes(e.setter)) continue;
                        const key = `${src.rel}: ${e.setter} -> ${e.setter} (another Modal)`;
                        const line = src.sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
                        if (!findings.some((f) => f.key === key && f.line === line)) findings.push({ rel: src.rel, line, close: e.setter, open: e.setter, key });
                    }
                }
                ts.forEachChild(n, inside);
            };
            ts.forEachChild(m.node, inside);
        }
    }
    return findings;
}

function appSources(): Source[] {
    return ROOTS.flatMap((r) => listTsx(path.join(NATIVE, r))).map((full) => parseText(path.relative(NATIVE, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8')));
}

/** Run the guard over a set of in-memory files (for the detector's own checks below). */
function scan(files: Record<string, string>): Finding[] {
    const sources = Object.entries(files).map(([rel, text]) => parseText(rel, text));
    const known = new Set(sources.map((s) => s.rel));
    const modals = findModalComponents(sources);
    return sources.flatMap((s) => findModalAfterModal(s, modals, known));
}

describe('the detector itself (it can fail)', () => {
    const MENU = `
import React, { useState } from 'react';
import { Modal, Platform, Pressable } from 'react-native';
export function Menu({ items, onClose, onDismiss }: { items: any[] | null; onClose: () => void; onDismiss?: () => void }) {
    return <Modal visible={!!items} transparent onRequestClose={onClose} onDismiss={onDismiss}><Pressable onPress={onClose} /></Modal>;
}
export function Picker({ open, onClose }: { open: boolean; onClose: () => void }) {
    return <Modal visible={open} onRequestClose={onClose} />;
}`;

    it('flags the forum ⋯ → Link pattern: one Modal closed and another opened in one handler (through components that draw them)', () => {
        const found = scan({
            'components/menu.tsx': MENU,
            'app/topic.tsx': `
import React, { useState } from 'react';
import { Menu, Picker } from '../components/menu';
export default function Topic() {
    const [menu, setMenu] = useState<string | null>(null);
    const [picking, setPicking] = useState(false);
    const items = menu ? [['Link', () => { setMenu(null); setPicking(true); }]] : null;
    return <><Menu items={items} onClose={() => setMenu(null)} /><Picker open={picking} onClose={() => setPicking(false)} /></>;
}`,
        });
        expect(found.map((f) => f.key)).toEqual(['app/topic.tsx: setMenu -> setPicking']);
    });

    it('flags it through a local function, and through a derived const in the visible expression', () => {
        const found = scan({
            'app/a.tsx': `
import React, { useState } from 'react';
import { Modal } from 'react-native';
export default function A() {
    const [sheet, setSheet] = useState(false);
    const [report, setReport] = useState<string | null>(null);
    const shown = !!report && true;
    const close = () => setSheet(false);
    const pick = (x: string) => { close(); setReport(x); };
    return <><Modal visible={sheet} /><Modal visible={shown} /></>;
}`,
        });
        expect(found.map((f) => f.key)).toEqual(['app/a.tsx: setSheet -> setReport']);
    });

    it('flags one state switched from one Modal to another by a handler drawn inside the first', () => {
        const found = scan({
            'app/s.tsx': `
import React, { useState } from 'react';
import { Modal, Pressable } from 'react-native';
export default function S() {
    const [sheet, setSheet] = useState<'menu' | 'edit' | null>(null);
    return <>
        <Modal visible={sheet === 'menu'}><Pressable onPress={() => setSheet('edit')} /></Modal>
        <Modal visible={sheet === 'edit'}><Pressable onPress={() => setSheet(null)} /></Modal>
    </>;
}`,
        });
        expect(found.map((f) => f.key)).toEqual(['app/s.tsx: setSheet -> setSheet (another Modal)']);
    });

    it('a ternary is open on its condition: closing one sheet while the data drawn in another changes is not an open', () => {
        const found = scan({
            'app/d.tsx': `
import React, { useState } from 'react';
import { Modal } from 'react-native';
export default function D() {
    const [settings, setSettings] = useState<string | null>(null);
    const [addOpen, setAddOpen] = useState(false);
    const [layout, setLayout] = useState<string[]>([]);
    const picker = addOpen ? { groups: layout } : null;
    const done = (next: string[]) => { setSettings(null); setLayout(next); };
    return <><Modal visible={!!settings} /><Modal visible={!!picker} /></>;
}`,
        });
        expect(found).toEqual([]);
    });

    it('passes the useAfterDismiss pattern, a close alone, an open after an await, and a switch within one Modal', () => {
        const found = scan({
            'app/b.tsx': `
import React, { useState } from 'react';
import { Modal, Platform } from 'react-native';
import { useAfterDismiss } from '../utils/screen-presented';
export default function B() {
    const [menu, setMenu] = useState<{ confirm?: boolean } | null>(null);
    const [picking, setPicking] = useState(false);
    const after = useAfterDismiss<true>(() => setPicking(true));
    const link = () => { setMenu(null); if (Platform.OS === 'ios') after.hold(true); else setPicking(true); };
    const cancel = () => setMenu(null);
    const later = async () => { setMenu(null); await Promise.resolve(); setPicking(true); };
    const confirm = () => setMenu({ confirm: true });
    return <><Modal visible={!!menu} onDismiss={after.release} /><Modal visible={picking} /></>;
}`,
        });
        expect(found).toEqual([]);
    });
});

describe('phone app: no Modal opens while another closes in the same handler (iOS drops it)', () => {
    const sources = appSources();
    const known = new Set(sources.map((s) => s.rel));
    const modals = findModalComponents(sources);
    const findings = sources.flatMap((s) => findModalAfterModal(s, modals, known));

    it('reads the app: its Modal components are found, the forum menu and Link picker among them', () => {
        expect(sources.length).toBeGreaterThan(100);
        expect(modals.get('components/forum/ForumBits.tsx#ForumMenu')).toEqual(new Set(['items']));
        expect(modals.get('components/forum/ForumLinks.tsx#ForumLinkPicker')).toEqual(new Set(['open']));
        expect(modals.get('components/ReportMessageSheet.tsx#ReportMessageSheet')).toEqual(new Set(['isOpen']));
    });

    it('every handler that closes one Modal and opens another goes through useAfterDismiss (or is a verified exception)', () => {
        const unexplained = findings.filter((f) => !(f.key in ALLOWED)).map((f) => `${f.rel}:${f.line} ${f.close}(closed) then ${f.open}(open) in one handler`);
        expect(unexplained, 'hold the second Modal with useAfterDismiss on iOS (components/NewPostTypeSheet.tsx), or add a verified exception to ALLOWED').toEqual([]);
    });

    it('every exception in ALLOWED still matches a handler (no stale entries)', () => {
        const stale = Object.keys(ALLOWED).filter((k) => !findings.some((f) => f.key === k));
        expect(stale).toEqual([]);
    });
});
