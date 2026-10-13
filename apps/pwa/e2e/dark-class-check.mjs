/**
 * Dark mode, every class string in the web app, measured in Chromium (PR #1833, lane dark-pwa-fix5, 13 Oct 2026).
 * Five review rounds on #1833 each found a new shape of one fault: a light hover fill with no dark partner, a dark hover
 * fill too close to the dark ink, then hover inks with no fill at all (check 4 §7: 2.20–4.25:1). Each round's test read
 * the class strings for the shape that round had found, so the next shape walked past it. This check reads no shapes:
 * it renders every class string with the CSS the app ships and asks Chromium what colours they come out as.
 *
 *   - Class strings: every quoted string and template literal in src (tests aside). Each `${}` is one branch per string
 *     it can end in, so a template is every combination of its branches; strings joined with `+` are one string; a
 *     `${NAME}` or className={NAME} uses the same file's `const NAME = '…'`.
 *   - Where a string is a JSX className it is drawn with its own tag, inside the classNames of its JSX parents in the
 *     same file (the card, sheet or row it sits on). A parent's className counts by its fixed text; a parent that is a
 *     component from another file adds what it is given and nothing of its own.
 *   - The CSS: src/index.css built by the app's vite config (Tailwind over src, postcss, the minifier). That is byte for
 *     byte the app's rules in the shipped bundle, which only puts Leaflet's stylesheet in front; and it needs no other
 *     package built, so it runs beside the build in test-all.
 *   - Dark mode as the app sets it (html.dark.dark-theme), 320 px wide, on the dark page colour.
 *   - States: at rest; under the pointer (:hover forced through the DevTools protocol on the element and every parent
 *     that has a hover class or is a `group`, as a pointer over the element hovers them all); with keyboard focus
 *     (:focus and :focus-visible) when the string has a focus class. `disabled:` never applies (WCAG exempts disabled
 *     controls), nor do `active:`, `peer-` or `aria-` states.
 *   - The words: the computed colour, judged where the string sets an ink, or sets a fill and holds words of its own
 *     (an element with only a fill and no text is a bar, a dot or a frame). An element holding only emoji is not judged
 *     (CSS colour does not reach an emoji). A placeholder: class is judged on an input's ::placeholder.
 *   - A branch with cursor-not-allowed is the app's disabled look, and WCAG exempts disabled controls.
 *   - A fill that is dark at rest and turns light under the pointer or with focus fails whatever its words read
 *     (a light-theme hover left in dark mode, check 3's shape).
 *   - A pair that comes out the same in light mode is the palette's, not dark mode's: it is listed, and does not fail
 *     (light is unchanged on purpose; white on emerald-500 is 2.54:1 in both themes).
 *   - What is behind the words: each layer from the element out to the page, gradients at every stop, the page's dark
 *     colour under all; opacity of the element and its parents. A background picture (the doodle wallpaper) counts as
 *     the colour it sits on, as dark-contrast-check.mjs counts it.
 *   - 4.5:1, or 3:1 when Chromium sizes the words large (24 px, or 18.66 px bold) or the element is an svg icon.
 *
 * Before it reads the source it measures CANARIES, class strings of each known shape that must fail and the fixes that
 * must pass, so a stylesheet that did not load or a state that was not forced fails the check instead of passing it.
 *
 * Run:  pnpm --filter @beanpool/pwa dark-class-check
 *   DARK_CLASSES_PWA=<dir>  check another checkout's apps/pwa (fail-first on an older commit; its node_modules linked)
 *   DARK_CLASSES_ALL=1      also write every measurement to e2e/screenshots/dark-classes.json
 *   DARK_CLASSES_JSON=<f>   also write the failures (and the palette's) to that file
 * Needs Chromium for Playwright once: pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium
 */
/* global console, process, document, getComputedStyle -- Node, and the page's side of evaluate() */
import { build } from 'vite';
import { chromium } from 'playwright';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PWA = process.env.DARK_CLASSES_PWA ? path.resolve(process.env.DARK_CLASSES_PWA) : HERE;
const SRC = path.join(PWA, 'src');
const started = Date.now();

/**
 * [file, a piece of the class string that marks the one place, why its dark words may read under AA]. The same four the
 * unit test (src/darkModeHover.test.ts) allows. White on terra-600 is matched by colour, not class, so another ink on
 * that fill is still measured (check 4 §4 found the class match let any ink through).
 */
const ALLOWED = [
    ['pages/LedgerPage.tsx', 'dark:bg-nature-800 text-nature-500 cursor-not-allowed', 'Send and Confirm while disabled'],
    ['components/ProfileSetup.tsx', 'dark:bg-nature-700 text-white/70 cursor-not-allowed', 'Continue while the name or photo is not ready (disabled)'],
    ['pages/MapPage.tsx', 'dark:bg-nature-800 dark:text-nature-400 cursor-not-allowed', 'Post while the form is incomplete (disabled)'],
];
/** White words on terra-600 (#c2583b) are 4.42:1 in light too: the brand's selected fill, a palette call deferred on #1833. */
const ALLOWED_PAIR = { ink: '255,255,255', fill: '194,88,59', why: 'white on terra-600, the brand fill (4.42:1 in both themes)' };

// ——— The CSS the app ships ———

async function builtCss() {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-dark-classes-'));
    const cwd = process.cwd();
    process.chdir(PWA); // Tailwind reads its content globs from here
    try {
        await build({
            root: PWA, configFile: path.join(PWA, 'vite.config.ts'), logLevel: 'error',
            build: { outDir: out, emptyOutDir: true, copyPublicDir: false, rollupOptions: { input: path.join(SRC, 'index.css') } },
        });
    } finally {
        process.chdir(cwd);
    }
    const dir = path.join(out, 'assets');
    const css = fs.readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    fs.rmSync(out, { recursive: true, force: true });
    if (!/\.dark-theme/.test(css) || css.length < 20000) throw new Error('the built CSS has no dark theme in it');
    return css;
}

// ——— Every class string in the source ———

const words = (text) => text.split(/\s+/).filter(Boolean);
const COLOURISH = /^(?:text|bg|from|via|to)-/;
const utilityOf = (token) => token.slice(token.lastIndexOf(':') + 1).replace(/^!/, '');

function sourceFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return sourceFiles(p);
        return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : [];
    });
}

/**
 * Each place a class string is used: { rel, line, cls, tag, holdsText, parents: [{ cls, tag }] (outermost first) }.
 * `cls` is one combination of the string's branches; `line` is the line of the branch that holds its colours.
 */
function classStrings() {
    const out = [];
    for (const file of sourceFiles(SRC)) {
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        const spanOf = (node) => [lineOf(node), sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1];

        // The file's `const NAME = '…'` (or a template, or a `+` of them), for className={NAME} and `${NAME}`.
        const consts = new Map();
        (function find(node) {
            if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && stringish(node.initializer)) consts.set(node.name.text, node.initializer);
            ts.forEachChild(node, find);
        })(sf);

        /** Is this expression made only of strings (and branches of strings)? */
        function stringish(node) {
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) return true;
            if (ts.isParenthesizedExpression(node)) return stringish(node.expression);
            if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return stringish(node.left) && stringish(node.right);
            return false;
        }

        /** Each text this expression can be, as [{ text, node }] pieces (a piece's node gives the line). */
        function combos(node, depth = 0) {
            if (depth > 4) return [[]];
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [[{ text: node.text, node }]];
            if (ts.isParenthesizedExpression(node)) return combos(node.expression, depth);
            if (ts.isIdentifier(node) && consts.has(node.text)) return combos(consts.get(node.text), depth + 1);
            if (ts.isConditionalExpression(node)) return [...combos(node.whenTrue, depth), ...combos(node.whenFalse, depth)];
            if (ts.isBinaryExpression(node)) {
                const op = node.operatorToken.kind;
                if (op === ts.SyntaxKind.AmpersandAmpersandToken) return [...combos(node.right, depth), [{ text: '', node }]];
                if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return [...combos(node.left, depth), ...combos(node.right, depth)];
                if (op === ts.SyntaxKind.PlusToken) return cross([combos(node.left, depth), combos(node.right, depth)]);
            }
            if (ts.isTemplateExpression(node)) {
                const parts = [[[{ text: node.head.text, node }]]];
                for (const span of node.templateSpans) {
                    const options = combos(span.expression, depth);
                    parts.push(options.length ? options : [[]], [[{ text: span.literal.text, node }]]);
                }
                return cross(parts);
            }
            return [];
        }
        function cross(lists) {
            let acc = [[]];
            for (const options of lists) acc = acc.flatMap((a) => options.map((o) => [...a, ...o])).slice(0, 512);
            return acc;
        }

        /** The fixed text of a parent's className: what holds whichever branch it takes. */
        function fixedClass(attrs) {
            const attr = attrs.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'className');
            let init = attr?.initializer;
            if (!init) return '';
            if (ts.isJsxExpression(init)) init = init.expression;
            if (!init) return '';
            if (ts.isIdentifier(init) && consts.has(init.text)) init = consts.get(init.text);
            if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) return init.text;
            if (ts.isTemplateExpression(init)) return [init.head.text, ...init.templateSpans.map((s) => s.literal.text)].join(' ');
            return '';
        }
        const tagOf = (el) => el.tagName.getText(sf);
        const containsJsx = (n) => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n) || !!ts.forEachChild(n, containsJsx);
        /** Does the element hold words of its own: text, or a {value} that is not more elements? */
        const holdsText = (el) => ts.isJsxOpeningElement(el) && el.parent.children.some((c) => (ts.isJsxText(c) && c.text.trim() !== '')
            || (ts.isJsxExpression(c) && c.expression && !containsJsx(c.expression)));
        /** An element whose only content is emoji: CSS colour does not reach an emoji's own colours. */
        const emojiOnly = (el) => ts.isJsxOpeningElement(el) && el.parent.children.every((c) => ts.isJsxText(c))
            && /^[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s]+$/u.test(el.parent.children.map((c) => c.text).join('')) && el.parent.children.some((c) => c.text.trim());

        /** The JSX element this expression is the className of, or null. */
        function classNameOf(node) {
            for (let n = node.parent; n; n = n.parent) {
                if (ts.isJsxAttribute(n)) return n.name.getText(sf) === 'className' ? n.parent.parent : null;
                if (ts.isCallExpression(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) return null;
            }
            return null;
        }
        function parentsOf(el) {
            const chain = [];
            for (let n = el.parent; n; n = n.parent) {
                if (ts.isJsxElement(n) && n.openingElement !== el) chain.unshift({ cls: fixedClass(n.openingElement.attributes), tag: tagOf(n.openingElement) });
                if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isSourceFile(n)) break;
            }
            return chain;
        }

        function emit(root) {
            const el = classNameOf(root);
            const jsx = el ? { tag: tagOf(el), holdsText: holdsText(el), emoji: emojiOnly(el), parents: parentsOf(el) } : { tag: null, holdsText: false, parents: [] };
            for (const pieces of combos(root)) {
                const cls = words(pieces.map((p) => p.text).join(' ')).join(' ');
                if (!words(cls).some((t) => COLOURISH.test(utilityOf(t)) || t.includes('placeholder:'))) continue;
                const holder = [...pieces].reverse().find((p) => words(p.text).some((t) => COLOURISH.test(utilityOf(t)))) ?? pieces[0];
                out.push({ rel, line: lineOf(holder?.node ?? root), span: spanOf(root), cls, ...jsx });
            }
        }

        (function visit(node) {
            if (stringish(node)) return emit(node);
            // className={NAME}: the const, drawn where it is used (it is also drawn on its own, where it is declared).
            if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'className' && node.initializer && ts.isJsxExpression(node.initializer)
                && node.initializer.expression && ts.isIdentifier(node.initializer.expression) && consts.has(node.initializer.expression.text)) {
                const el = node.parent.parent;
                const root = consts.get(node.initializer.expression.text);
                for (const pieces of combos(root)) {
                    const cls = words(pieces.map((p) => p.text).join(' ')).join(' ');
                    if (!words(cls).some((t) => COLOURISH.test(utilityOf(t)))) continue;
                    out.push({ rel, line: lineOf(node), span: spanOf(root), cls, tag: tagOf(el), holdsText: holdsText(el), emoji: emojiOnly(el), parents: parentsOf(el) });
                }
            }
            ts.forEachChild(node, visit);
        })(sf);
    }
    return out;
}

// ——— Drawing and measuring in Chromium ———

const INTRINSIC = new Set(['a', 'abbr', 'article', 'aside', 'b', 'button', 'caption', 'code', 'dd', 'details', 'div', 'dl', 'dt', 'em', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'i', 'input', 'kbd', 'label', 'legend', 'li', 'main', 'mark', 'nav', 'ol', 'option', 'p', 'pre', 'section', 'select', 'small', 'span', 'strong', 'summary', 'sup', 'sub', 'table', 'tbody', 'td', 'textarea', 'th', 'thead', 'time', 'tr', 'ul', 'svg', 'img', 'hr', 'progress', 'output', 'blockquote', 'dialog']);
const drawTag = (tag) => (tag && INTRINSIC.has(tag) ? tag : 'div');

/** The page's side: draw every place, each inside its parents, and measure one state. */
function pageDraw(places) {
    const page = document.getElementById('page');
    const make = (tag, cls) => {
        const el = tag === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement(tag);
        el.setAttribute('class', cls);
        return el;
    };
    places.forEach((p, i) => {
        let at = page;
        for (const parent of p.parents) {
            const wrap = make(parent.tag, parent.cls);
            if (/^(?:input|textarea|select|img|hr|svg|progress)$/.test(parent.tag)) continue;
            at.appendChild(wrap);
            at = wrap;
        }
        const el = make(p.tag, p.cls);
        el.id = `p${i}`;
        if (p.tag === 'input' || p.tag === 'textarea') {
            el.setAttribute('value', 'Ag words');
            el.setAttribute('placeholder', 'Ag words');
            if (p.tag === 'textarea') el.textContent = 'Ag words';
        } else if (p.tag === 'select') {
            const o = document.createElement('option');
            o.textContent = 'Ag words';
            el.appendChild(o);
        } else if (p.tag === 'svg') {
            el.setAttribute('viewBox', '0 0 10 10');
            el.innerHTML = '<rect width="10" height="10" fill="currentColor"/>';
        } else if (p.tag !== 'img' && p.tag !== 'hr') {
            el.textContent = 'Ag words';
        }
        at.appendChild(el);
    });
}

function pageMeasure(count) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    const rgba = (c) => {
        cx.clearRect(0, 0, 1, 1);
        cx.fillStyle = 'rgba(0,0,0,0)';
        cx.fillStyle = c;
        cx.fillRect(0, 0, 1, 1);
        const d = cx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3] / 255];
    };
    // fillRect premultiplies; read a translucent colour from its own string instead.
    const colour = (c) => {
        const m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(c.trim());
        if (m) return [+m[1], +m[2], +m[3], m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]];
        return rgba(c);
    };
    const over = (t, u) => [t[0] * t[3] + u[0] * (1 - t[3]), t[1] * t[3] + u[1] * (1 - t[3]), t[2] * t[3] + u[2] * (1 - t[3]), 1];
    const mix = (a, b, k) => [a[0] * k + b[0] * (1 - k), a[1] * k + b[1] * (1 - k), a[2] * k + b[2] * (1 - k), 1];
    const lum = ([r, g, b]) => {
        const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const contrast = (a, b) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
    };
    const page = document.getElementById('page');
    const pageColour = colour(getComputedStyle(page).backgroundColor);
    const results = [];
    for (let i = 0; i < count; i++) {
        const el = document.getElementById(`p${i}`);
        const chain = [];
        for (let n = el; n && n !== page; n = n.parentElement) chain.unshift(n);
        // What is behind, from the page out to the element: every gradient stop is a possible background.
        let unders = [pageColour];
        let alpha = 1;
        for (const n of chain) {
            const cs = getComputedStyle(n);
            const before = unders;
            const fill = colour(cs.backgroundColor);
            const image = cs.backgroundImage;
            const stops = /gradient\(/.test(image) ? (image.match(/rgba?\([^)]*\)/g) || []).map(colour) : [];
            unders = unders.map((u) => over(fill, u));
            if (stops.length) unders = unders.flatMap((u) => stops.map((s) => over(s, u))).slice(0, 24);
            const o = parseFloat(cs.opacity);
            if (o < 1) {
                alpha *= o;
                unders = unders.map((u, k) => mix(u, before[Math.min(k, before.length - 1)], o));
            }
        }
        const cs = getComputedStyle(el);
        const size = parseFloat(cs.fontSize);
        const weight = parseInt(cs.fontWeight, 10);
        const read = (c) => {
            const ink = colour(c);
            if (ink[3] === 0 || alpha === 0) return null;
            const seen = unders.map((u) => contrast(over([ink[0], ink[1], ink[2], ink[3] * alpha], u), u));
            const k = seen.indexOf(Math.min(...seen));
            return { ratio: seen[k], ink: ink.slice(0, 3).map(Math.round).join(','), fill: unders[k].slice(0, 3).map(Math.round).join(',') };
        };
        const text = read(cs.color);
        let placeholder = null;
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') placeholder = read(getComputedStyle(el, '::placeholder').color);
        results.push({ text, placeholder, size, weight, alpha });
    }
    return results;
}

/** Does this class set a colour for the words, or a fill? Asked of Chromium once per utility, on a bare element. */
async function colourUtilities(page, tokens) {
    const utilities = [...new Set(tokens.map(utilityOf).filter((u) => COLOURISH.test(u)))];
    return page.evaluate((utilities) => {
        const host = document.getElementById('probe');
        const ink = new Set();
        const fill = new Set();
        for (const u of utilities) {
            const el = document.createElement('span');
            el.setAttribute('class', u);
            host.appendChild(el);
            const cs = getComputedStyle(el);
            if (cs.color !== 'rgb(1, 2, 3)') ink.add(u);
            if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.backgroundImage !== 'none') fill.add(u);
            el.remove();
        }
        return { ink: [...ink], fill: [...fill] };
    }, utilities);
}

const APPLIES = (token, state) => {
    const variants = token.split(':').slice(0, -1);
    return variants.every((v) => v === 'dark' || (state === 'hover' && (v === 'hover' || v === 'group-hover')) || (state === 'focus' && (v === 'focus' || v === 'focus-visible')));
};

/** Draw places, measure rest, hover and focus; return the failures. */
async function measurePlaces(browser, css, places) {
    const page = await browser.newPage({ viewport: { width: 320, height: 720 } });
    await page.setContent(`<!doctype html><html class="dark dark-theme"><head><meta charset="utf-8"><style>${css}</style>
<style>*,*::before,*::after{transition:none!important;animation:none!important}
#page{background-color:var(--pattern-bg,var(--bg-primary));color:var(--text-primary);padding:4px}
#probe{color:rgb(1,2,3);background:none}</style></head><body><div id="probe"></div><div id="page"></div></body></html>`);
    const kinds = await colourUtilities(page, places.flatMap((p) => words(p.cls)));
    const inkUtils = new Set(kinds.ink);
    const fillUtils = new Set(kinds.fill);
    for (const p of places) {
        const tokens = words(p.cls);
        p.setsInk = tokens.some((t) => inkUtils.has(utilityOf(t)) && !t.includes('placeholder:'));
        p.setsFill = tokens.some((t) => fillUtils.has(utilityOf(t)) && !t.includes('placeholder:'));
        p.placeholderClass = tokens.some((t) => t.includes('placeholder:'));
        p.hovers = tokens.some((t) => /(?:^|:)(?:group-)?hover:/.test(t)) || p.parents.some((q) => words(q.cls).some((t) => /(?:^|:)(?:group-)?hover:/.test(t)));
        p.focuses = tokens.some((t) => /(?:^|:)focus(?:-visible)?:/.test(t) && COLOURISH.test(utilityOf(t)));
        p.judged = !p.emoji && (p.setsInk || p.placeholderClass || (p.setsFill && p.holdsText));
    }
    const drawn = places.filter((p) => p.judged);
    await page.evaluate(pageDraw, drawn.map((p) => ({ cls: p.cls, tag: drawTag(p.tag), parents: p.parents.map((q) => ({ cls: q.cls, tag: drawTag(q.tag) })) })));

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const force = async (selector, classes) => {
        const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
        for (const nodeId of nodeIds) await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes });
        return nodeIds.length;
    };

    const theme = (cls) => page.evaluate((cls) => { document.documentElement.className = cls; }, cls);
    /** One state in dark, and the same in light (a pair that is the same in light is the palette's, not dark mode's). */
    const both = async () => {
        const dark = await page.evaluate(pageMeasure, drawn.length);
        await theme('');
        const light = await page.evaluate(pageMeasure, drawn.length);
        await theme('dark dark-theme');
        return [dark, light];
    };
    const [rest, restLight] = await both();
    // A pointer over the element hovers it and every parent; only those with a hover class (or a group) change.
    const hoverable = await page.evaluate(() => {
        let k = 0;
        for (const el of document.querySelectorAll('#page *')) {
            const c = el.getAttribute('class') || '';
            if (/^p\d+$/.test(el.id) || /(?:^|\s|:)(?:group-)?hover:|(?:^|\s)group(?:\s|$)/.test(c)) {
                el.setAttribute('data-h', String(k++));
            }
        }
        return k;
    });
    const hovered = await force('[data-h]', ['hover']);
    const [hover, hoverLight] = await both();
    await force('[data-h]', []);
    const focusable = drawn.map((p, i) => (p.focuses ? `#p${i}` : null)).filter(Boolean);
    let focus = [];
    let focusLight = [];
    if (focusable.length) {
        await force(focusable.join(','), ['focus', 'focus-visible']);
        [focus, focusLight] = await both();
    }
    await page.close();

    const failures = [];
    const palette = [];
    const big = (m) => m.size >= 24 || (m.size >= 18.66 && m.weight >= 700);
    drawn.forEach((p, i) => {
        if (ALLOWED.some(([f, piece]) => f === p.rel && p.cls.includes(piece))) return;
        if (words(p.cls).includes('cursor-not-allowed')) return; // the app's disabled look; WCAG exempts disabled controls
        const need = (m, which) => (which === 'text' && (p.tag === 'svg' || big(m)) ? 3 : 4.5);
        const states = [['rest', rest[i], restLight[i]]];
        if (p.hovers) states.push(['hover', hover[i], hoverLight[i]]);
        if (p.focuses) states.push(['focus', focus[i], focusLight[i]]);
        for (const [state, m, light] of states) {
            if (!m) continue;
            for (const which of ['text', 'placeholder']) {
                const seen = m[which];
                if (!seen || (which === 'text' && !p.setsInk && !(p.setsFill && p.holdsText)) || (which === 'placeholder' && !p.placeholderClass)) continue;
                // Under the pointer or with focus, only what that state changes (an unchanged pair is reported at rest).
                const base = rest[i][which];
                if (state !== 'rest' && base && base.ink === seen.ink && base.fill === seen.fill) continue;
                // Dark at rest and light under the pointer: a light-theme fill flashing in dark mode fails even when its
                // light-theme ink reads on it (that pair is light mode's, so the contrast alone would file it as the palette's).
                if (state !== 'rest' && base && lightness(seen.fill) > 0.4 && lightness(base.fill) < 0.2) {
                    failures.push({ state, why: 'turns light', ratio: seen.ratio, need: need(m, which), at: `${p.rel}:${p.line}`, span: p.span, tag: p.tag || '(string)', ink: seen.ink, fill: seen.fill, cls: p.cls, fills: [base.fill, seen.fill] });
                    continue;
                }
                if (seen.ratio >= need(m, which) - 0.005) continue;
                if (seen.ink === ALLOWED_PAIR.ink && seen.fill === ALLOWED_PAIR.fill) continue;
                const inLight = light?.[which];
                (inLight && inLight.ink === seen.ink && inLight.fill === seen.fill ? palette : failures).push({ state: which === 'placeholder' ? `${state} placeholder` : state, ratio: seen.ratio, need: need(m, which), at: `${p.rel}:${p.line}`, span: p.span, tag: p.tag || '(string)', ink: seen.ink, fill: seen.fill, cls: p.cls,
                    fills: states.map(([, d]) => d?.[which]?.fill).filter(Boolean) });
            }
        }
    });
    return { failures, palette, drawn: drawn.length, hovered, focused: focusable.length, rest, hover, focus, drawnPlaces: drawn, hoverable };
}

/** Relative luminance of an 'r,g,b' string. */
function lightness(rgb) {
    const [r, g, b] = rgb.split(',').map((v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ——— Canaries: each shape the rounds found must fail here, and its fix must pass ———

const CANARIES = [
    // [class string, tag, parents' classes (outermost first), the state that must fail, or null for must-pass]
    ['bg-white dark:bg-nature-800 text-nature-700 dark:text-nature-300 hover:bg-oat-200', 'button', [], 'hover'], // light hover fill, no dark partner (check 2)
    ['bg-white dark:bg-nature-800 text-nature-700 dark:text-nature-300 hover:bg-oat-200 dark:hover:bg-nature-700', 'button', [], 'hover'], // dark fill too close to the ink (check 3)
    ['bg-white dark:bg-nature-800 text-nature-700 dark:text-nature-300 hover:bg-oat-200 dark:hover:bg-nature-700 dark:hover:text-nature-200', 'button', [], null],
    ['text-nature-500 dark:text-nature-400 hover:text-nature-700', 'button', [], 'hover'], // hover ink, no fill (check 4 §7)
    ['text-nature-500 dark:text-nature-400 hover:text-nature-700 dark:hover:text-nature-200', 'button', [], null],
    ['text-nature-500 dark:text-nature-400', 'span', ['bg-white'], 'rest'], // a light parent left in dark
    ['text-nature-900 dark:text-white group-hover:text-terra-600', 'span', ['group'], 'hover'], // group-hover
    ['text-nature-900 dark:text-nature-200 group-hover:text-terra-600', 'span', ['group bg-white dark:bg-nature-900 hover:bg-oat-50'], 'hover'], // a row that flashes light (check 3)
    ['dark:text-nature-300 focus-visible:bg-nature-100', 'button', [], 'focus'], // a light focus fill
    ['dark:text-nature-300 focus-visible:bg-nature-100 dark:focus-visible:bg-nature-800', 'button', [], null],
    ['bg-white dark:bg-nature-800 text-nature-900 dark:text-white placeholder:text-nature-400', 'input', [], 'rest placeholder'],
    ['text-nature-700', 'span', [], 'rest'], // a light-theme ink with no dark partner
    ['text-nature-900 dark:text-white', 'span', [], null],
    ['bg-terra-500 dark:bg-terra-600 text-white', 'button', [], null], // the written brand exception
    ['bg-emerald-500 text-white', 'button', [], null], // the same pair in light: the palette's, listed apart
    ['bg-terra-500 dark:bg-terra-600 text-white dark:text-nature-900', 'button', [], 'rest'], // ...which does not excuse another ink
];

async function canaries(browser, css) {
    // Tailwind writes a rule only for a class the source uses, so a canary may use only those.
    const escape = (token) => token.replace(/([:/[\]#.%!])/g, '\\$1');
    const missing = [...new Set(CANARIES.flatMap(([cls, , parents]) => words([cls, ...parents].join(' '))))]
        .filter((t) => COLOURISH.test(utilityOf(t)) && !css.includes(`.${escape(t)}`));
    if (missing.length) throw new Error(`a canary uses a class the app no longer uses, so the CSS has no rule for it (pick another): ${missing.join(' ')}`);
    const places = CANARIES.map(([cls, tag, parents]) => ({ rel: 'canary', line: 0, cls, tag, holdsText: true, parents: parents.map((c) => ({ cls: c, tag: 'div' })) }));
    const { failures } = await measurePlaces(browser, css, places);
    const wrong = [];
    CANARIES.forEach(([cls, , , expect]) => {
        const got = failures.filter((f) => f.cls === cls).map((f) => f.state);
        if (expect ? !got.includes(expect) : got.length) wrong.push(`${cls} — expected ${expect ?? 'a pass'}, got ${got.join(', ') || 'a pass'}`);
    });
    if (wrong.length) throw new Error(`the check did not see what it must see:\n  ${wrong.join('\n  ')}`);
    return CANARIES.length;
}

// ——— Run ———

const css = await builtCss();
const browser = await chromium.launch();
try {
    const canaryCount = await canaries(browser, css);
    const all = classStrings();
    const unique = new Map();
    for (const p of all) {
        const key = JSON.stringify([p.rel, p.line, p.cls, p.tag, p.parents]);
        if (!unique.has(key)) unique.set(key, p);
    }
    const places = [...unique.values()];
    const result = await measurePlaces(browser, css, places);
    const seen = new Set();
    const failures = result.failures.filter((f) => {
        const key = `${f.state} ${f.at} ${f.ink} ${f.fill}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).sort((a, b) => a.at.localeCompare(b.at, 'en', { numeric: true }) || a.state.localeCompare(b.state));
    if (process.env.DARK_CLASSES_JSON) fs.writeFileSync(process.env.DARK_CLASSES_JSON, JSON.stringify({ failures, palette: result.palette }, null, 1));
    if (process.env.DARK_CLASSES_ALL === '1') {
        const file = path.join(HERE, 'e2e/screenshots/dark-classes.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(result.drawnPlaces.map((p, i) => ({ at: `${p.rel}:${p.line}`, cls: p.cls, tag: p.tag, rest: result.rest[i], hover: p.hovers ? result.hover[i] : undefined, focus: p.focuses ? result.focus[i] : undefined })), null, 1));
    }
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${canaryCount} canaries as expected; ${new Set(places.map((p) => p.cls)).size} class strings in ${places.length} places, ${result.drawn} drawn and measured in dark at rest, ${result.hovered} elements hovered, ${result.focused} focused (${secs} s).`);
    const show = (f) => {
        const tokens = words(f.cls).filter((t) => /(?:^|:)(?:text|bg|from|via|to)-|placeholder:/.test(t) && !/^(?:sm|md|lg|xl|2xl):/.test(t));
        return `  ${f.at} ${f.state}${f.why ? ` (${f.why})` : ''} ${f.ratio.toFixed(2)}:1 (needs ${f.need}) <${f.tag}> ink ${f.ink} on ${f.fill} | ${tokens.join(' ')}`;
    };
    const palette = [...new Set(result.palette.map(show))].sort();
    console.log(`${palette.length} place(s) under AA read the same in light mode: the palette's, not dark mode's (DARK_CLASSES_PALETTE=1 lists them).`);
    if (process.env.DARK_CLASSES_PALETTE === '1') console.log(palette.join('\n'));
    if (failures.length) {
        console.log(`\n${failures.length} place(s) whose words read under AA in dark mode:\n`);
        for (const f of failures) console.log(show(f));
        process.exitCode = 1;
    } else {
        console.log('Every class string reads at AA in dark mode, at rest, under the pointer and with focus.');
    }
} finally {
    await browser.close();
}
