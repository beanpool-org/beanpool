/**
 * The doodle wallpaper behind every main screen (Marty, 14 Oct 2026, the Commons in dark mode: "missing doodle bg").
 * #root paints the wallpaper (index.css "Doodle wallpaper") and a screen sits on it transparently; its cards, inputs and
 * panels keep their own fills. The Commons header, its sticky Decide/Groups row and its filter row each painted
 * bg-nature-900 across the whole width (since #849, 17 Sep), so on a phone at 1.3x text no wallpaper showed at all.
 *
 * Read from the source: in each main tab screen, the element the screen returns and the rows directly inside it (through
 * conditionals and fragments, not into the rows) may not carry an opaque fill unless they are rounded (a card) or fixed
 * (a sheet or its backdrop). An opaque fill is bg-white, bg-black or a palette shade with no /opacity, in any theme or
 * breakpoint; a hover or focus fill is a state, not a ground. "Plain background" is .page-surface's job, not a screen's.
 *
 * e2e/wallpaper-shots.mjs measures the same thing in Chromium, and draws the pictures.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC = path.resolve(__dirname);

/** The tabs App.tsx mounts in the content column, by file and exported component. The Map is a map, edge to edge. */
const SCREENS: Array<[string, string]> = [
    ['pages/HomePage.tsx', 'HomePage'],
    ['pages/MarketplacePage.tsx', 'MarketplacePage'],
    ['pages/PulsePage.tsx', 'PulsePage'],
    ['pages/MessagesPage.tsx', 'MessagesPage'],
    ['pages/PeoplePage.tsx', 'PeoplePage'],
    ['pages/LedgerPage.tsx', 'LedgerPage'],
    ['pages/ProjectsPage.tsx', 'ProjectsPage'],
];

const OPAQUE = /(?<![\w:-])(?:(?:dark|sm|md|lg|xl):)*bg-(?:white|black|[a-z]+-(?:50|[1-9]00|950))(?![\w/-])/g;

function staticClass(attr: ts.JsxAttribute | undefined): string {
    const init = attr?.initializer;
    if (!init) return '';
    if (ts.isStringLiteral(init)) return init.text;
    if (ts.isJsxExpression(init) && init.expression) {
        const e = init.expression;
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
        if (ts.isTemplateExpression(e)) return [e.head.text, ...e.templateSpans.map(s => s.literal.text)].join(' ');
    }
    return '';
}

function opening(el: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxOpeningLikeElement {
    return ts.isJsxElement(el) ? el.openingElement : el;
}

/** The JSX elements an expression stands for: through parentheses, && and ?:, and fragments. */
function elementsOf(node: ts.Node | undefined): Array<ts.JsxElement | ts.JsxSelfClosingElement> {
    if (!node) return [];
    if (ts.isParenthesizedExpression(node)) return elementsOf(node.expression);
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) return [node];
    if (ts.isJsxFragment(node)) return node.children.flatMap(childElements);
    if (ts.isBinaryExpression(node)) return [...elementsOf(node.left), ...elementsOf(node.right)];
    if (ts.isConditionalExpression(node)) return [...elementsOf(node.whenTrue), ...elementsOf(node.whenFalse)];
    return [];
}

function childElements(child: ts.JsxChild): Array<ts.JsxElement | ts.JsxSelfClosingElement> {
    if (ts.isJsxExpression(child)) return elementsOf(child.expression);
    if (ts.isJsxText(child)) return [];
    return elementsOf(child);
}

/** Every opaque fill on a screen's own ground: its returned element(s) and the rows directly inside them. */
function grounds(file: string, component: string, text = fs.readFileSync(path.join(SRC, file), 'utf8')): string[] {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const fn = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === component);
    if (!fn?.body) throw new Error(`${file}: no function ${component}`);
    const roots = fn.body.statements.filter(ts.isReturnStatement).flatMap(r => elementsOf(r.expression));
    if (roots.length === 0) throw new Error(`${file}: ${component} returns no JSX`);
    const found: string[] = [];
    for (const root of roots) {
        const rows = ts.isJsxElement(root) ? root.children.flatMap(childElements) : [];
        for (const el of [root, ...rows]) {
            const o = opening(el);
            const cls = staticClass(o.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === 'className'));
            if (/(?<![\w:-])(?:rounded(?:-[\w[\]]+)*|fixed)(?![\w-])/.test(cls)) continue;
            for (const hit of cls.matchAll(OPAQUE)) {
                found.push(`${file}:${sf.getLineAndCharacterOfPosition(o.getStart()).line + 1} <${o.tagName.getText()}> ${hit[0]}`);
            }
        }
    }
    return found;
}

describe('main screens sit on the doodle wallpaper', () => {
    it('no main screen paints an opaque full-width ground at its root or on its top-level rows', () => {
        expect(SCREENS.flatMap(([file, component]) => grounds(file, component))).toEqual([]);
    });

    it('the check finds a ground where there is one (the Commons header as it was)', () => {
        const canary = `export function Canary({ on }: { on: boolean }) {
                if (!on) return null;
                return (
                    <div className="flex flex-col h-full">
                        <header className="bg-nature-900 px-4 pt-4"><h1>The Commons</h1></header>
                        <div className="sticky top-0 z-40 dark:bg-nature-950 px-4 py-2" />
                        {on ? <div className="p-4 bg-white">x</div> : <><div className="sm:bg-oat-50 px-4" /></>}
                        <div className="bg-white dark:bg-nature-900 rounded-xl p-3">a card</div>
                        <div className="px-4 hover:bg-nature-800 bg-nature-950/60">see-through, and a hover</div>
                        {on && <div className="fixed inset-0 bg-black">a sheet</div>}
                    </div>
                );
            }`;
        expect(grounds('Canary.tsx', 'Canary', canary).map(f => f.replace(/^[^:]+:\d+ /, ''))).toEqual([
            '<header> bg-nature-900',
            '<div> dark:bg-nature-950',
            '<div> bg-white',
            '<div> sm:bg-oat-50',
        ]);
    });
});
