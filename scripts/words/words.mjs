#!/usr/bin/env node
// words.mjs — the words layer's tooling (scratch/global-node/DESIGN-translation-fable.md §2.2, §2.5, §5).
//
//   node scripts/words/words.mjs check     every t()/tn() call is a whole sentence written as a literal, and every catalog
//                                          (<package>/words/<lang>.json) is structurally sound against the sources: same
//                                          placeholders as the English, the plural forms its language needs, no key that no
//                                          source uses any more. A MISSING translation is never a failure (the English shows).
//                                          It also holds each translation to scripts/words/GLOSSARY.csv (glossary), to the
//                                          numbers in the English (numbers) and to the words that never change (untranslatable:
//                                          BeanPool, a typed CONFIRM). Those three have a recorded baseline of known problems
//                                          (glossary-baseline.json) that may only shrink: --update records a fall, a rise needs
//                                          --update --raise "<reason>"; --known lists what the baseline covers.
//   node scripts/words/words.mjs lint      the ratchet: English literals a member reads (JSX text, text props, alert
//                                          arguments) outside t(), and English sentence constants that reach a screen
//                                          (README "On-screen constants"), per directory, may only go down. --update records
//                                          a fall; a rise is refused unless --raise "<reason>", which the file records.
//   node scripts/words/words.mjs extract   writes <package>/words/en.sources.json (key → file:line), the drafting lane's
//                                          context. Not tracked: line numbers would conflict in every PR.
//   node scripts/words/words.mjs count     the user-facing strings per package (--json for the raw numbers).
//
// The checks themselves live in packages/beanpool-core/src/words-check.ts. This script compiles that file (and words.ts)
// in memory with the TypeScript it already parses with, so it never depends on a built dist: test-all runs it beside
// the build, not after it.

import ts from 'typescript';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readGlossary } from './glossary.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const BASELINE = 'scripts/words/lint-baseline.json';
export const GLOSSARY_BASELINE = 'scripts/words/glossary-baseline.json';
/** The rules the glossary baseline holds (core's WordRule). */
export const RULES = Object.freeze(['glossary', 'numbers', 'untranslatable']);
/** The languages that may have catalog files: core's LANGS but en (the key is the English). */
export async function catalogLangs(root = ROOT) {
    const { LANGS } = await loadCoreChecks(root);
    return LANGS.filter((l) => l !== 'en');
}

/**
 * What is scanned. `words`: the catalog folder the package's sentences are translated in (the server's catalog also
 * holds @beanpool/engine's, which the server renders). `lint`: the ratchet covers it (the screens a member reads).
 * The manager is measured only: operators' Settings stays English for launch (design M8).
 */
export const PACKAGES = [
    // apps/native/tools: the phone's tool halves (DESIGN-tool-template-fable.md §1.5). The web's (apps/pwa/src/tools) and core's
    // (packages/beanpool-core/src/tools) are inside the folders their packages already scan.
    { name: 'native', dirs: ['apps/native/app', 'apps/native/components', 'apps/native/utils', 'apps/native/services', 'apps/native/constants', 'apps/native/tools'], words: 'apps/native/words', lint: true },
    { name: 'pwa', dirs: ['apps/pwa/src'], words: 'apps/pwa/words', lint: true },
    { name: 'core', dirs: ['packages/beanpool-core/src'], words: 'packages/beanpool-core/words', lint: true },
    { name: 'server', dirs: ['apps/server/src'], words: 'apps/server/words', lint: false },
    { name: 'engine', dirs: ['packages/beanpool-engine/src'], words: 'apps/server/words', lint: false },
    { name: 'manager', dirs: ['apps/manager/src'], words: null, lint: false },
];

const SKIP_FILE = /(^|\/)(__tests__|__mocks__|e2e|node_modules|dist)(\/|$)|\.test\.tsx?$|\.d\.ts$|(^|\/)test-[^/]*\.ts$|test-harness\.ts$|-vectors\.ts$/;

export function sourceFiles(root, dirs) {
    const out = [];
    const walk = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir).sort()) {
            const full = path.join(dir, name);
            const rel = path.relative(root, full);
            if (SKIP_FILE.test(rel)) continue;
            if (fs.statSync(full).isDirectory()) walk(full);
            else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
        }
    };
    for (const d of dirs) walk(path.join(root, d));
    return out;
}

// ── Extraction ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Props whose string value a member reads. */
const TEXT_PROPS = new Set(['title', 'placeholder', 'label', 'subtitle', 'hint', 'message', 'description', 'heading',
    'accessibilityLabel', 'accessibilityHint', 'aria-label', 'alt']);
const ALERT_CALLS = new Set(['Alert.alert', 'Alert.prompt', 'alert', 'window.alert', 'confirm', 'window.confirm']);
const LOG_CALL = /^(console|logger|log)\.(log|info|warn|error|debug|trace)$/;
const SQL = /^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|PRAGMA|BEGIN|COMMIT|REPLACE)\b/;
const WORDS_MODULE = /(^|\/)words(\.js)?$/;

function calleeText(expr) {
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) return `${expr.expression.text}.${expr.name.text}`;
    return null;
}

function templateText(node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((s) => `{x}${s.literal.text}`).join('');
    return null;
}

function isSentence(text) {
    return /^[A-Z]/.test(text) && /\s/.test(text) && /[a-z]/.test(text) && !SQL.test(text);
}

/**
 * Where a module-level sentence constant counts as "on a screen" (the lint's constants rule, README §lint). Besides a JSX
 * child, a text prop and the first two arguments of an alert call (above): the title/message/body/text of an object handed
 * to a share sheet or a push call. A constant stored in state and shown later is not followed (a heuristic, said in the README).
 */
const SINK_PROPS = new Set(['title', 'message', 'body', 'text', 'subtitle', 'label', 'dialogTitle']);
const SHARE_OR_PUSH_CALL = /^(share|shareAsync|scheduleNotificationAsync|presentNotificationAsync|sendPush\w*|sendNotification\w*|pushNotification\w*)$/;

const WORDS_FNS = new Set(['t', 'tn', 'word', 'wordn']);
const FUNCTION_LIKE =(n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)
    || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)
    || (ts.isPropertyDeclaration(n) && !n.modifiers?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword));
const unwrapUp = (n) => { let up = n.parent; while (up && (ts.isParenthesizedExpression(up) || ts.isNonNullExpression(up) || ts.isAsExpression(up))) up = up.parent; return up; };
const unwrap = (n) => { while (n && (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n))) n = n.expression; return n; };

/** A JSX child that is an element, not text: `<Row/>`, `{c && <Row/>}`, `{c ? <A/> : null}`, `{items.map(…)}`. */
function isJsxValued(e) {
    e = unwrap(e);
    if (!e) return true;
    if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return true;
    if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) return true;
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return isJsxValued(e.right);
    if (ts.isConditionalExpression(e)) return isJsxValued(e.whenTrue) && isJsxValued(e.whenFalse);
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'map') return true;
    return false;
}

/**
 * Is this words call glued to other text? `+`, a span of a template literal that has other text or spans, an element of
 * an array that is `.join()`ed, or a JSX child beside other text or values (`<Text>{t('You have')} {n} …</Text>`).
 */
function isFragment(node, isPlus) {
    const up = unwrapUp(node);
    if (isPlus(up) || node.arguments.some(isPlus)) return true;
    if (up && ts.isTemplateSpan(up)) {
        const tpl = up.parent;
        return !(tpl.head.text === '' && tpl.templateSpans.length === 1 && up.literal.text === '');
    }
    if (up && ts.isArrayLiteralExpression(up) && up.elements.length > 1) {
        const pa = unwrapUp(up);
        if (pa && ts.isPropertyAccessExpression(pa) && pa.name.text === 'join' && ts.isCallExpression(pa.parent) && pa.parent.expression === pa) return true;
    }
    if (up && ts.isJsxExpression(up) && up.parent && (ts.isJsxElement(up.parent) || ts.isJsxFragment(up.parent))) {
        return up.parent.children.some((c) => c !== up && (
            (ts.isJsxText(c) && c.text.trim().length > 0) || (ts.isJsxExpression(c) && c.expression && !isJsxValued(c.expression))));
    }
    return false;
}

// ── On-screen sentence constants (the lint's constants rule) ─────────────────────────────────────────────────────

const normaliseText = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * isSentence, and written as English words rather than as a name: a space then a lowercase letter ("Save as PDF"), or
 * closing punctuation. So "Tiếng Việt" and "Bahasa Indonesia" (the language list's own names, never translated), "Ho Chi
 * Minh" and the like are not sentences here.
 */
function isConstantSentence(s) {
    return isSentence(s) && (/\s[a-z]/.test(s) || /[.!?…:]$/.test(s));
}

/** `x as T`, `(x)`, `x!`, `x satisfies T`, `Object.freeze(x)`: the value underneath. */
function unwrapValue(n) {
    for (;;) {
        if (!n) return n;
        if (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n)) { n = n.expression; continue; }
        if (ts.isCallExpression(n) && n.arguments.length === 1 && calleeText(n.expression) === 'Object.freeze') { n = n.arguments[0]; continue; }
        return n;
    }
}

/**
 * The English sentences a module-level constant holds, each with the property path to it (`['title']` for
 * `COPY = { title: 'Save your key.' }`; a number for an array element; null for a computed key): the constant itself
 * when it is a string, the string members of an object or array literal. A call, a function or a variable is not read.
 */
function sentencesIn(node, trail, out, at) {
    const e = unwrapValue(node);
    if (!e) return;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)) {
        const s = templateText(e);
        if (s && isConstantSentence(s)) out.push({ path: trail, text: normaliseText(s), at: at(e) });
    } else if (ts.isObjectLiteralExpression(e)) {
        for (const p of e.properties) {
            if (!ts.isPropertyAssignment(p)) continue;
            const named = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name);
            sentencesIn(p.initializer, [...trail, named ? p.name.text : null], out, at);
        }
    } else if (ts.isArrayLiteralExpression(e)) {
        e.elements.forEach((el, i) => sentencesIn(el, [...trail, String(i)], out, at));
    }
}

function bindingNames(name, out) {
    if (ts.isIdentifier(name)) out.add(name.text);
    else for (const el of name.elements) if (ts.isBindingElement(el)) bindingNames(el.name, out);
}

/** Is `name` bound by a parameter, a local declaration, a catch or a loop variable around `node` (so it is not the module's constant)? */
function declaredAround(node, name) {
    for (let up = node.parent; up && !ts.isSourceFile(up); up = up.parent) {
        const names = new Set();
        if (FUNCTION_LIKE(up)) {
            for (const p of up.parameters ?? []) bindingNames(p.name, names);
            if ((ts.isFunctionExpression(up) || ts.isFunctionDeclaration(up)) && up.name) names.add(up.name.text);
        } else if (ts.isBlock(up) || ts.isCaseBlock(up)) {
            const statements = ts.isBlock(up) ? up.statements : up.clauses.flatMap((c) => [...c.statements]);
            for (const st of statements) {
                if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) bindingNames(d.name, names);
                else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) names.add(st.name.text);
            }
        } else if (ts.isCatchClause(up) && up.variableDeclaration) {
            bindingNames(up.variableDeclaration.name, names);
        } else if ((ts.isForStatement(up) || ts.isForOfStatement(up) || ts.isForInStatement(up)) && up.initializer && ts.isVariableDeclarationList(up.initializer)) {
            for (const d of up.initializer.declarations) bindingNames(d.name, names);
        }
        if (names.has(name)) return true;
    }
    return false;
}

/** Is this object literal (or one inside it) the argument of a share sheet or a push call? */
function inShareOrPushCall(object) {
    let o = object;
    for (let depth = 0; depth < 3; depth++) {
        let p = o.parent;
        while (p && (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p))) { o = p; p = p.parent; }
        if (p && ts.isCallExpression(p) && p.arguments.includes(o)) {
            const callee = calleeText(p.expression);
            return !!callee && SHARE_OR_PUSH_CALL.test(callee.split('.').pop());
        }
        if (p && ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.parent)) { o = p.parent; continue; }
        return false;
    }
    return false;
}

/**
 * Where does this identifier's value end up? 'jsx' (a JSX child), 'prop' (a text prop), 'alert' (one of an alert call's
 * first two arguments), 'share' (the title/message/body/text of an object given to a share sheet or a push call), or null.
 * The value is followed through `COPY.title` / `COPY['title']`, `(…)`, `as`, `!`, `a || b`, `a ?? b`, `c && a`, `c ? a : b`,
 * `a + b` and a template literal. `trail` is the static property path from the identifier (it stops at a computed key).
 */
function sinkOf(id, sf) {
    let node = id;
    const trail = [];
    let known = true;
    for (;;) {
        const p = node.parent;
        if (p && ts.isPropertyAccessExpression(p) && p.expression === node) { if (known) trail.push(p.name.text); node = p; continue; }
        if (p && ts.isElementAccessExpression(p) && p.expression === node) {
            const a = p.argumentExpression;
            if (known && a && (ts.isStringLiteral(a) || ts.isNumericLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) trail.push(a.text); else known = false;
            node = p;
            continue;
        }
        break;
    }
    for (;;) {
        const p = node.parent;
        if (!p) return null;
        if (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) || ts.isAsExpression(p) || ts.isTypeAssertionExpression(p) || ts.isSatisfiesExpression(p)) { node = p; continue; }
        if (ts.isConditionalExpression(p) && p.condition !== node) { node = p; continue; }
        if (ts.isBinaryExpression(p)) {
            const k = p.operatorToken.kind;
            if (k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.PlusToken
                || (k === ts.SyntaxKind.AmpersandAmpersandToken && p.right === node)) { node = p; continue; }
            return null;
        }
        if (ts.isTemplateSpan(p)) { node = p.parent; continue; }
        break;
    }
    const p = node.parent;
    let kind = null;
    if (!p) return null;
    if (ts.isJsxExpression(p)) {
        const gp = p.parent;
        if (gp && (ts.isJsxElement(gp) || ts.isJsxFragment(gp))) kind = 'jsx';
        else if (gp && ts.isJsxAttribute(gp) && TEXT_PROPS.has(gp.name.getText(sf))) kind = 'prop';
    } else if (ts.isCallExpression(p)) {
        const i = p.arguments.indexOf(node);
        const callee = calleeText(p.expression);
        if (i >= 0 && i < 2 && callee && ALERT_CALLS.has(callee)) kind = 'alert';
    } else if ((ts.isPropertyAssignment(p) && p.initializer === node && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && SINK_PROPS.has(p.name.text))
        || (ts.isShorthandPropertyAssignment(p) && p.name === node && SINK_PROPS.has(p.name.text))) {
        if (ts.isObjectLiteralExpression(p.parent) && inShareOrPushCall(p.parent)) kind = 'share';
    }
    return kind ? { kind, trail } : null;
}

/**
 * One file's t()/tn()/word()/wordn() calls, the English a member reads outside them, and how the file reaches the words layer.
 *
 * What counts as a words call (N7: the extractor SEES these rather than refusing them):
 *   - `t` / `tn` / `word` / `wordn` imported by name from ANY module (core, a words module, or a module that re-exports them);
 *     an alias is followed (`import { t as tr }`);
 *   - `X.t(…)` where X is a namespace import (`import * as core from '@beanpool/core'`), a variable bound to a hook or
 *     to wordsFor (`const w = useWords()`, `const w = wordsFor(lang)`), or `wordsFor(lang).t(…)` itself;
 *   - `t` / `tn` destructured from a hook or from wordsFor (`const { t } = useWords()`).
 * What it REFUSES: re-exporting t/tn/word by name from a module not named `words` (so every route to them is one the
 * extractor knows). A local function that merely happens to be called `t` is not a words call.
 */
export function extractFromSource(file, text) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const tNames = new Map();
    const holders = new Set(); // identifiers whose .t / .tn / .word are words calls
    // words.ts is the layer itself: its own t/tn calls count (timeAgo's sentences), its plumbing (active.t(source)) does not.
    const isLayer = /(^|\/)beanpool-core\/src\/words\.ts$/.test(file);
    const factories = new Set(isLayer ? [] : ['wordsFor']);
    const problems = [];
    const at = (node) => `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
    if (isLayer) { tNames.set('t', 't'); tNames.set('tn', 'tn'); }
    const isWordsModuleFile = /(^|\/)words\.tsx?$/.test(file);
    // What the lint's constants rule needs of this file (reachedConstants joins the files): the module-level sentence
    // constants it declares, the names it imports, and where a name's value reaches a screen.
    const constants = { file, declared: [], imports: [], uses: [] };
    for (const st of sf.statements) {
        if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) {
                if (!ts.isIdentifier(d.name) || !d.initializer) continue;
                const items = [];
                sentencesIn(d.initializer, [], items, (n) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
                if (items.length) constants.declared.push({ name: d.name.text, items });
            }
        }
        if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
            const named = st.importClause?.namedBindings;
            if (named && ts.isNamespaceImport(named)) holders.add(named.name.text);
            if (named && ts.isNamedImports(named)) {
                for (const el of named.elements) {
                    const imported = (el.propertyName ?? el.name).text;
                    if (WORDS_FNS.has(imported)) tNames.set(el.name.text, imported);
                    if (imported === 'wordsFor') factories.add(el.name.text);
                    if (!el.isTypeOnly && !st.importClause?.isTypeOnly) constants.imports.push({ local: el.name.text, imported, spec: st.moduleSpecifier.text });
                }
            }
        }
        if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause) && !isWordsModuleFile) {
            for (const el of st.exportClause.elements) {
                const name = (el.propertyName ?? el.name).text;
                if (WORDS_FNS.has(name) || WORDS_FNS.has(el.name.text)) {
                    problems.push({ at: at(el), problem: `re-exports ${name}(): only a module named "words" may, so words:check can follow every route to it` });
                }
            }
        }
    }
    const isHookOrFactoryCall = (e) => {
        e = unwrap(e);
        if (!e || !ts.isCallExpression(e)) return false;
        const c = calleeText(e.expression);
        return !!c && (/^use[A-Z]/.test(c.split('.').pop()) || factories.has(c));
    };

    const calls = [];
    const found = [];
    const counted = new Set();
    const lit = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
    const isPlus = (n) => !!n && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;
    const add = (kind, node, value) => {
        if (counted.has(node)) return;
        counted.add(node);
        found.push({ kind, text: value, at: at(node) });
    };
    /** 't' | 'tn' | 'word' | 'wordn' when this call goes to the words layer, else null. */
    const wordsFn = (callee) => {
        if (ts.isIdentifier(callee)) return tNames.get(callee.text) ?? null;
        if (ts.isPropertyAccessExpression(callee) && WORDS_FNS.has(callee.name.text)) {
            const obj = unwrap(callee.expression);
            if (ts.isIdentifier(obj) && holders.has(obj.text)) return callee.name.text;
            if (isHookOrFactoryCall(obj)) return callee.name.text;
        }
        return null;
    };
    const isModuleLevel = (node) => {
        for (let up = node.parent; up; up = up.parent) if (FUNCTION_LIKE(up)) return false;
        return true;
    };

    const visit = (node) => {
        if (ts.isIdentifier(node)) {
            const sink = sinkOf(node, sf);
            if (sink && !declaredAround(node, node.text)) constants.uses.push({ name: node.text, trail: sink.trail, kind: sink.kind, at: at(node) });
            return;
        }
        // const w = wordsFor(lang) / useWords();  const { t, tn } = useWords();
        if (ts.isVariableDeclaration(node) && node.initializer && isHookOrFactoryCall(node.initializer)) {
            if (ts.isIdentifier(node.name)) holders.add(node.name.text);
            else if (ts.isObjectBindingPattern(node.name)) {
                for (const el of node.name.elements) {
                    const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : ts.isIdentifier(el.name) ? el.name.text : null;
                    if (prop && WORDS_FNS.has(prop) && ts.isIdentifier(el.name)) tNames.set(el.name.text, prop);
                }
            }
        }
        if (ts.isCallExpression(node)) {
            const fn = wordsFn(node.expression);
            if (fn) {
                const concatenated = isFragment(node, isPlus);
                const args = node.arguments;
                const fromTable = (a) => { const e = unwrap(a); return !!e && (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)); };
                // t(KINDS[kind].body) takes a word() key; tn(n, line.key.one, line.key.other) the two keys of a wordn() pair.
                const keyed = fn === 't' ? fromTable(args[0]) : fn === 'tn' && fromTable(args[1]) && fromTable(args[2]);
                const call = fn === 'tn'
                    ? { fn, text: lit(args[1]), other: lit(args[2]), concatenated, at: at(node) }
                    : fn === 'wordn'
                        ? { fn, text: lit(args[0]), other: lit(args[1]), concatenated, at: at(node) }
                        : { fn, text: lit(args[0]), context: lit(args[fn === 'word' ? 1 : 2]) ?? undefined, concatenated, at: at(node) };
                if (keyed) call.keyed = true;
                if (isModuleLevel(node)) call.moduleLevel = true;
                calls.push(call);
                return; // what is inside t() is translated, not counted
            }
            const callee = calleeText(node.expression);
            if (callee && LOG_CALL.test(callee)) return;
            if (callee && ALERT_CALLS.has(callee)) {
                for (const a of node.arguments.slice(0, 2)) {
                    const s = templateText(a);
                    if (s && /[A-Za-z]/.test(s)) add('alert', a, s);
                }
            }
        }
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node) || ts.isTaggedTemplateExpression(node)) return;
        if (ts.isJsxText(node)) {
            const s = node.text.replace(/\s+/g, ' ').trim();
            if (/[A-Za-z]/.test(s)) add('jsx', node, s);
        } else if (ts.isJsxAttribute(node)) {
            const name = node.name.getText(sf);
            let init = node.initializer;
            if (init && ts.isJsxExpression(init)) init = init.expression;
            const s = init ? templateText(init) : null;
            if (TEXT_PROPS.has(name) && s && /[A-Za-z]/.test(s)) add('jsx', init, s);
        } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
            const parent = node.parent;
            const isKey = (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodDeclaration(parent)) && parent.name === node;
            const s = templateText(node);
            // A text prop was counted above; any other attribute value (className, testID, …) is not read as words.
            if (!isKey && s && !ts.isJsxAttribute(parent)) {
                if (ts.isJsxExpression(parent) && parent.parent && (ts.isJsxElement(parent.parent) || ts.isJsxFragment(parent.parent))) {
                    if (/[A-Za-z]/.test(s)) add('jsx', node, s.replace(/\s+/g, ' ').trim());
                } else if (isSentence(s)) {
                    add('sentence', node, s);
                }
            }
            if (ts.isTemplateExpression(node)) ts.forEachChild(node, visit);
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return { calls, found, problems, constants };
}

export function extractRepo(root = ROOT, packages = PACKAGES) {
    return packages.map((pkg) => {
        const files = sourceFiles(root, pkg.dirs);
        const calls = [];
        const found = [];
        const problems = [];
        const constants = [];
        for (const file of files) {
            const r = extractFromSource(file, fs.readFileSync(path.join(root, file), 'utf8'));
            calls.push(...r.calls);
            found.push(...r.found);
            problems.push(...r.problems);
            if (r.constants.declared.length || r.constants.uses.length) constants.push(r.constants);
        }
        return { ...pkg, files: files.length, calls, found, problems, constants };
    });
}

// ── Core's checks, compiled in memory ───────────────────────────────────────────────────────────────────────────

const corePromises = new Map();
/** words.ts (with words-dates.ts and its per-language modules) and words-check.ts from the SOURCE, as ES modules, without writing a file. */
export function loadCoreChecks(root = ROOT) {
    const effectiveRoot = fs.existsSync(path.join(root, 'packages/beanpool-core/src/words-dates')) ? root : ROOT;
    if (!corePromises.has(effectiveRoot)) {
        corePromises.set(effectiveRoot, (async () => {
            const compile = (rel) => ts.transpileModule(fs.readFileSync(path.join(effectiveRoot, rel), 'utf8'), {
                compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
            }).outputText;
            const asUrl = (js) => `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
            // words-dates.ts gathers one module per language (words-dates/<lang>.ts): each becomes a URL of its own.
            const dateDir = 'packages/beanpool-core/src/words-dates';
            const dateUrls = Object.fromEntries(fs.readdirSync(path.join(effectiveRoot, dateDir)).filter((f) => f.endsWith('.ts'))
                .map((f) => [`./words-dates/${f.replace(/\.ts$/, '.js')}`, asUrl(compile(`${dateDir}/${f}`))]));
            const datesUrl = asUrl(compile('packages/beanpool-core/src/words-dates.ts')
                .replace(/(['"])(\.\/words-dates\/[^'"]+\.js)\1/g, (whole, _q, spec) => (dateUrls[spec] ? JSON.stringify(dateUrls[spec]) : whole)));
            const wordsUrl = asUrl(compile('packages/beanpool-core/src/words.ts').replace(/(['"])\.\/words-dates\.js\1/g, JSON.stringify(datesUrl)));
            const checkJs = compile('packages/beanpool-core/src/words-check.ts').replace(/(['"])\.\/words\.js\1/g, JSON.stringify(wordsUrl));
            const [words, check] = await Promise.all([import(wordsUrl), import(asUrl(checkJs))]);
            return { ...words, ...check };
        })());
    }
    return corePromises.get(effectiveRoot);
}

// ── check ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Problems in the extracted calls and in the catalogs. `catalogs` (tests) maps a words folder to { lang: object };
 * by default each folder's <lang>.json files are read. With a `glossary` (GlossaryTerm[], see glossary.mjs) the catalogs are also
 * held to the glossary, the numbers and the untranslatable words: those come back as `violations` ({ catalog, file, key, rule,
 * what, problem }), not `problems`, because words.mjs holds them to a baseline (glossary-baseline.json) instead of refusing outright.
 */
export async function checkRepo({ root = ROOT, extracted = extractRepo(root), catalogs = null, glossary = null } = {}) {
    const { callProblem, callKey, checkCatalog, checkCatalogRules } = await loadCoreChecks(ROOT);
    const langs = await catalogLangs(ROOT);
    const problems = [];
    const violations = [];
    const byFolder = new Map();
    for (const pkg of extracted) {
        for (const p of pkg.problems ?? []) problems.push(`${p.at}: ${p.problem}`);
        for (const call of pkg.calls) {
            const p = callProblem(call);
            if (p) problems.push(`${call.at}: ${p}`);
        }
        if (!pkg.words) continue;
        const entry = byFolder.get(pkg.words) ?? { keys: new Set(), plural: new Set() };
        for (const call of pkg.calls) {
            const key = callKey(call);
            if (!key) continue;
            entry.keys.add(key);
            if (call.fn === 'tn' || call.fn === 'wordn') entry.plural.add(key);
        }
        byFolder.set(pkg.words, entry);
    }
    let catalogCount = 0;
    for (const [folder, { keys, plural }] of byFolder) {
        // A language with no file yet is simply untranslated (the English shows); a file no language owns is a mistake.
        const dir = path.join(root, folder);
        if (!catalogs?.[folder] && fs.existsSync(dir)) {
            for (const name of fs.readdirSync(dir).sort()) {
                if (name === 'en.sources.json' || (name.endsWith('.json') && langs.includes(name.slice(0, -5)))) continue;
                problems.push(`${path.join(folder, name)}: not a catalog: a catalog is <tag>.json for one of ${langs.join(', ')}`);
            }
        }
        for (const lang of langs) {
            let catalog = catalogs?.[folder]?.[lang];
            const file = path.join(folder, `${lang}.json`);
            if (!catalog) {
                const full = path.join(root, file);
                if (catalogs?.[folder] || !fs.existsSync(full)) continue;
                try { catalog = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { problems.push(`${file}: not JSON (${e.message})`); continue; }
            }
            catalogCount++;
            for (const p of checkCatalog(lang, catalog, keys, plural)) problems.push(`${file}: ${JSON.stringify(p.key)}: ${p.problem}`);
            if (glossary) {
                for (const p of checkCatalogRules(lang, catalog, glossary)) violations.push({ catalog: `${folder}/${lang}`, file, key: p.key, rule: p.rule, what: p.what, problem: p.problem });
            }
        }
    }
    const callCount = extracted.reduce((n, p) => n + p.calls.length, 0);
    return { problems, callCount, catalogCount, violations };
}

// ── the glossary baseline ───────────────────────────────────────────────────────────────────────────────────────
//
// glossary, numbers and untranslatable problems are real mistakes that a sentence survives, so 1,000 or so of them are in the
// catalogs today (machine drafts). They are held to a baseline that may only shrink: a problem that is not recorded fails words:check.
// It records the problems themselves (a short hash of rule + key + cause, per catalog), not only how many, so fixing one sentence
// cannot hide a new mistake in another.

/**
 * A short, stable id for one violation: the rule, the key and what the problem is about (the glossary term, the missing number), not
 * the words that describe it, so giving a glossary row another variant does not turn its known problems into new ones.
 */
export function violationId({ rule, key, what }) {
    return crypto.createHash('sha1').update(`${rule}\n${key}\n${what}`).digest('hex').slice(0, 10);
}

const knownSets = (doc) => {
    const out = new Map();
    for (const [catalog, rules] of Object.entries(doc?.known ?? {})) {
        for (const [rule, ids] of Object.entries(rules)) out.set(`${catalog}\n${rule}`, new Set(ids));
    }
    return out;
};

/** The violations the baseline does not record (`fresh`), and how many recorded ones are gone (`fixed`). */
export function ratchetCompare(violations, doc) {
    const known = knownSets(doc);
    const fresh = [];
    const present = new Set();
    for (const v of violations) {
        const slot = `${v.catalog}\n${v.rule}`;
        const id = violationId(v);
        present.add(`${slot}\n${id}`);
        if (!known.get(slot)?.has(id)) fresh.push(v);
    }
    let fixed = 0;
    for (const [slot, ids] of known) for (const id of ids) if (!present.has(`${slot}\n${id}`)) fixed++;
    return { fresh, fixed };
}

/**
 * The baseline `check --update` writes: today's violations. A rise (a violation not recorded) needs a reason, which is kept in `raises`;
 * the first recording, when there is no baseline yet (`doc` null), needs none.
 */
export function updatedRatchet(doc, violations, { raise = null, date = new Date().toISOString().slice(0, 10) } = {}) {
    const { fresh } = ratchetCompare(violations, doc);
    if (doc && fresh.length && !(typeof raise === 'string' && raise.trim())) return { error: fresh };
    const sets = {};
    for (const v of violations) ((sets[v.catalog] ??= {})[v.rule] ??= new Set()).add(violationId(v));
    const known = {};
    for (const catalog of Object.keys(sets).sort()) {
        known[catalog] = {};
        for (const rule of RULES) if (sets[catalog][rule]) known[catalog][rule] = [...sets[catalog][rule]].sort();
    }
    const raises = [...(doc?.raises ?? [])];
    if (doc && fresh.length) raises.push({ date, reason: raise.trim(), added: fresh.length });
    return {
        doc: {
            _about: 'Known glossary / numbers / untranslatable problems in the catalogs (scripts/words/GLOSSARY.csv, packages/beanpool-core/src/words-check.ts), per catalog: a short hash of each problem. words.mjs check fails on a problem that is not listed here; `check --update` removes the ones that are fixed; adding one needs `check --update --raise "<reason>"`, which is recorded in `raises` (words.test.mjs compares with origin/main). `check --known` prints them in words.',
            known,
            ...(raises.length ? { raises } : {}),
        },
    };
}

/**
 * The entries `doc` records that main's baseline (`mainDoc`, see baselineBase) does not, when no new `--raise` entry accounts for
 * them: editing the file by hand to make a new problem pass. Empty when nothing was added, or a new raise with a reason says how many.
 */
export function unexplainedAdditions(mainDoc, doc) {
    if (!mainDoc?.known) return [];
    const was = knownSets(mainDoc);
    const added = [];
    for (const [slot, ids] of knownSets(doc)) for (const id of ids) if (!was.get(slot)?.has(id)) added.push(`${slot.replace('\n', ' ')} ${id}`);
    if (added.length === 0) return [];
    const old = new Set((mainDoc.raises ?? []).map((r) => JSON.stringify(r)));
    const covered = (doc.raises ?? []).filter((r) => !old.has(JSON.stringify(r)) && typeof r.reason === 'string' && r.reason.trim().length > 0)
        .reduce((n, r) => n + (Number.isInteger(r.added) ? r.added : 0), 0);
    return covered >= added.length ? [] : added;
}

export function readRatchet(root = ROOT) {
    const file = path.join(root, GLOSSARY_BASELINE);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/** The glossary as core's checks take it, with what is wrong with the file. */
export async function loadGlossary(root = ROOT) {
    return readGlossary(await catalogLangs(ROOT), root);
}

const describeViolation = (v) => `${v.file}: ${JSON.stringify(v.key.replace('\u0004', ' § '))}: ${v.rule}: ${v.problem}`;

// ── lint ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The module-level English sentence constants that reach a screen, joined across files (the lint's constants rule).
 *
 * A constant counts when it is declared at module level (exported or not) in a package the ratchet covers, holds an English
 * sentence (a string, or a string inside an object or array literal: sentencesIn), and its value reaches a screen: used as
 * a JSX child, a text prop, one of an alert call's first two arguments, or the title/message/body/text of an object given
 * to a share sheet or a push call (sinkOf), in the file that declares it or in any scanned file that imports it by name.
 * An import is followed by its path when that is relative, else by its name when exactly one scanned file declares an
 * exported constant of that name. A name that a parameter or a local variable shadows is not the constant. One count per
 * sentence, however many screens show it. Log lines, keys, URLs and test files never count: a log call is not a sink, a
 * sentence starts with a capital and has a space, and tests are not scanned.
 */
export function reachedConstants(extracted) {
    const facts = [];
    for (const pkg of extracted) for (const f of pkg.constants ?? []) facts.push({ ...f, pkg });
    const byFile = new Map(facts.map((f) => [f.file, f]));
    const declaredBy = new Map();
    for (const f of facts) for (const d of f.declared) declaredBy.set(d.name, [...(declaredBy.get(d.name) ?? []), f.file]);
    const declares = (file, name) => !!byFile.get(file)?.declared.some((d) => d.name === name);
    const fileOf = (from, spec) => {
        if (!spec.startsWith('.')) return null;
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec.replace(/\.(js|jsx|ts|tsx)$/, '')));
        return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((c) => byFile.has(c)) ?? null;
    };
    const trails = new Map(); // `${file}\0${name}` → the property paths its uses reach a screen by
    for (const f of facts) {
        for (const use of f.uses) {
            let target = f.declared.some((d) => d.name === use.name) ? { file: f.file, name: use.name } : null;
            if (!target) {
                const imp = f.imports.find((i) => i.local === use.name);
                if (imp) {
                    const file = fileOf(f.file, imp.spec);
                    const byName = declaredBy.get(imp.imported) ?? [];
                    if (file && declares(file, imp.imported)) target = { file, name: imp.imported };
                    else if (byName.length === 1) target = { file: byName[0], name: imp.imported };
                }
            }
            if (!target) continue;
            const key = `${target.file}\0${target.name}`;
            trails.set(key, [...(trails.get(key) ?? []), use.trail]);
        }
    }
    const matches = (use, item) => use.slice(0, item.length).every((k, i) => k === item[i] || k === null || item[i] === null);
    // A sentence that is already a words key (a table keyed by the English, welcome-lines.ts) is translated where it is shown.
    const keyed = new Set(extracted.flatMap((pkg) => pkg.calls.flatMap((c) => [c.text, c.other])).filter((s) => typeof s === 'string').map(normaliseText));
    const out = [];
    for (const [key, uses] of trails) {
        const [file, name] = key.split('\0');
        const f = byFile.get(file);
        if (!f.pkg.lint) continue;
        for (const d of f.declared.filter((x) => x.name === name)) {
            for (const item of d.items) {
                if (keyed.has(item.text)) continue;
                if (uses.some((u) => matches(u, item.path))) out.push({ kind: 'constant', name, text: item.text, at: item.at, package: f.pkg.name });
            }
        }
    }
    return out;
}

const sortedCounts = (counts) => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));

/** The constants rule's counts, per directory of the file that declares the constant. */
export function constantCounts(extracted) {
    const counts = {};
    for (const c of reachedConstants(extracted)) {
        const dir = path.dirname(c.at.replace(/:\d+$/, ''));
        counts[dir] = (counts[dir] ?? 0) + 1;
    }
    return sortedCounts(counts);
}

/** English a member reads outside t(), per directory: JSX text, text props, alert arguments. */
export function lintCounts(extracted) {
    const counts = {};
    for (const pkg of extracted) {
        if (!pkg.lint) continue;
        for (const f of pkg.found) {
            if (f.kind !== 'jsx' && f.kind !== 'alert') continue;
            const dir = path.dirname(f.at.replace(/:\d+$/, ''));
            counts[dir] = (counts[dir] ?? 0) + 1;
        }
    }
    return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function compareToBaseline(now, baseline) {
    const rises = [];
    const falls = [];
    for (const dir of new Set([...Object.keys(now), ...Object.keys(baseline)])) {
        const was = baseline[dir] ?? 0;
        const is = now[dir] ?? 0;
        if (is > was) rises.push({ dir, was, is });
        else if (is < was) falls.push({ dir, was, is });
    }
    return { rises, falls };
}

function gitIn(cwd, ...args) {
    try {
        return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
        return null;
    }
}

/**
 * The commit whose baseline this tree's is compared with (words.test.mjs), found as the guide check finds its base
 * (packages/beanpool-guide/scripts/build.mjs, findBase): where this branch left origin/main; else the commit before
 * HEAD. CI's shard for this check fetches origin/main (ci.yml, "Fetch origin/main"), on a pull request's merge commit
 * and on a train branch; with no origin/main, a pull request's merge commit has main's tip as its first parent. On a
 * push to main, origin/main is HEAD, so the base is main before the push. A merge queue entry's base is its first parent,
 * what it lands on: main and the entries ahead. A merge with no origin/main outside a pull request is not compared (its
 * first parent need not be main), and says so.
 */
export function baselineBase({ cwd = ROOT, env = process.env } = {}) {
    const head = gitIn(cwd, 'rev-parse', 'HEAD');
    if (!head) return { ref: null, why: 'this is not a git checkout' };
    if (env.GITHUB_EVENT_NAME === 'merge_group') {
        const landsOn = gitIn(cwd, 'rev-parse', '--verify', '--quiet', 'HEAD^1');
        if (landsOn) return { ref: landsOn, why: 'what this merge queue entry lands on' };
    }
    const hasOriginMain = gitIn(cwd, 'rev-parse', '--verify', '--quiet', 'origin/main^{commit}') !== null;
    const forked = hasOriginMain ? gitIn(cwd, 'merge-base', 'HEAD', 'origin/main') : null;
    if (forked && forked !== head) return { ref: forked, why: 'where this branch left origin/main' };
    const isMerge = gitIn(cwd, 'rev-parse', '--verify', '--quiet', 'HEAD^2') !== null;
    if (isMerge && !hasOriginMain && env.GITHUB_EVENT_NAME !== 'pull_request') {
        return { ref: null, why: "no origin/main (HEAD is a merge, and outside a pull request's merge commit its first parent need not be main; fetch origin/main to compare)" };
    }
    const parent = gitIn(cwd, 'rev-parse', '--verify', '--quiet', 'HEAD^1');
    if (parent) return { ref: parent, why: 'the commit before this one' };
    if (gitIn(cwd, 'rev-parse', '--is-shallow-repository') === 'true') {
        return { ref: null, why: 'this shallow clone lacks the commit before HEAD (check out with fetch-depth: 2)', broken: true };
    }
    return { ref: null, why: 'this is the first commit' };
}

/** A words baseline (the lint one by default; GLOSSARY_BASELINE for the glossary one) as committed at `ref`, or null when that commit has none. */
export function baselineAt(ref, cwd = ROOT, file = BASELINE) {
    const text = gitIn(cwd, 'show', `${ref}:${file}`);
    return text === null ? null : JSON.parse(text);
}

/**
 * The rises in `doc` over `mainDoc` (main's baseline: see baselineBase) that no `--raise "<reason>"` entry in `doc.raises`
 * accounts for. Empty when every count is at or under main's, or each rise was recorded with a reason.
 */
export function unexplainedRises(mainDoc, doc) {
    if (!mainDoc?.counts) return [];
    const known = new Set((mainDoc.raises ?? []).map((r) => JSON.stringify(r)));
    const added = (doc.raises ?? []).filter((r) => !known.has(JSON.stringify(r)) && typeof r.reason === 'string' && r.reason.trim().length > 0);
    const literals = compareToBaseline(doc.counts ?? {}, mainDoc.counts).rises
        .filter((r) => !added.some((a) => a.section !== 'constants' && Array.isArray(a.dirs?.[r.dir]) && a.dirs[r.dir][1] >= r.is));
    // The constants rule: when main has no section yet, this branch is the one that introduces it (nothing to compare with).
    const constants = !mainDoc.constants ? [] : compareToBaseline(doc.constants ?? {}, mainDoc.constants).rises
        .filter((r) => !added.some((a) => a.section === 'constants' && Array.isArray(a.dirs?.[r.dir]) && a.dirs[r.dir][1] >= r.is))
        .map((r) => ({ ...r, section: 'constants' }));
    return [...literals, ...constants];
}

/**
 * The baseline document `lint --update` writes: today's counts; a rise only with a reason, recorded in `raises`.
 * `constants` (the on-screen sentence constants, constantCounts) is its own section: the first time it is recorded there is
 * nothing to rise from, so `--update` writes it; after that it rises only with a reason, like the counts.
 */
export function updatedBaseline(doc, now, { raise = null, date = new Date().toISOString().slice(0, 10), constants } = {}) {
    const { rises } = compareToBaseline(now, doc?.counts ?? {});
    const constantRises = constants !== undefined && doc?.constants ? compareToBaseline(constants, doc.constants).rises : [];
    if ((rises.length || constantRises.length) && !(typeof raise === 'string' && raise.trim())) {
        return { error: [...rises.map((r) => `${r.dir}: ${r.was} → ${r.is}`), ...constantRises.map((r) => `(constants) ${r.dir}: ${r.was} → ${r.is}`)] };
    }
    const raises = [...(doc?.raises ?? [])];
    if (rises.length) raises.push({ date, reason: raise.trim(), dirs: Object.fromEntries(rises.map((r) => [r.dir, [r.was, r.is]])) });
    if (constantRises.length) raises.push({ date, reason: raise.trim(), section: 'constants', dirs: Object.fromEntries(constantRises.map((r) => [r.dir, [r.was, r.is]])) });
    const keptConstants = constants !== undefined ? constants : doc?.constants;
    return {
        doc: {
            _about: 'English a member reads outside t(), per directory. `counts`: JSX text, text props, alert arguments. `constants`: module-level English sentence constants that reach a screen (a JSX child, a text prop, an alert, a share sheet or a push; the rule is in scripts/words/README.md). scripts/words/words.mjs lint fails when a count rises; S3 sweeps take each to 0. `lint --update` lowers them; a rise needs `--update --raise "<reason>"`, which is recorded in `raises` (words.test.mjs compares with origin/main).',
            counts: now,
            ...(keptConstants ? { constants: keptConstants } : {}),
            ...(raises.length ? { raises } : {}),
        },
    };
}

// ── count ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function countStrings(extracted) {
    const onScreen = reachedConstants(extracted); // a subset of `sentence`: what `lint` counts under `constants`
    return extracted.map((pkg) => {
        const by = (k) => pkg.found.filter((f) => f.kind === k).length;
        const distinct = new Set(pkg.found.map((f) => f.text));
        const words = [...distinct].reduce((n, s) => n + s.split(/\s+/).filter(Boolean).length, 0);
        return {
            package: pkg.name, files: pkg.files, tCalls: pkg.calls.length, jsx: by('jsx'), alert: by('alert'), sentence: by('sentence'),
            total: pkg.found.length, distinct: distinct.size, words, constants: onScreen.filter((c) => c.package === pkg.name).length,
        };
    });
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function main(argv) {
    const cmd = argv[0];
    const extracted = extractRepo(ROOT);
    if (cmd === 'check') {
        const glossary = await loadGlossary();
        const { problems, callCount, catalogCount, violations } = await checkRepo({ extracted, glossary: glossary.terms });
        problems.push(...glossary.problems);
        const baseline = readRatchet();
        if (argv.includes('--update')) {
            if (problems.length) {
                console.error(`words:check --update — refused: fix the ${problems.length} problem(s) first (a baseline is recorded over a sound tree):`);
                for (const p of problems) console.error(`  ${p}`);
                return 1;
            }
            const i = argv.indexOf('--raise');
            const next = updatedRatchet(baseline, violations, { raise: i >= 0 ? argv[i + 1] ?? '' : null });
            if (next.error) {
                console.error(`words:check --update — refused: ${next.error.length} problem(s) are not in the baseline. Fix the translation (see`);
                console.error('scripts/words/GLOSSARY.csv), or, when a rise is truly needed (a new glossary row), say why: --update --raise "<reason>".');
                for (const v of next.error.slice(0, 20)) console.error(`  ${describeViolation(v)}`);
                return 1;
            }
            fs.writeFileSync(path.join(ROOT, GLOSSARY_BASELINE), `${JSON.stringify(next.doc, null, 2)}\n`);
            console.log(`words:check --update — recorded ${violations.length} known glossary/numbers/untranslatable problems`);
            return 0;
        }
        const { fresh, fixed } = ratchetCompare(violations, baseline);
        if (argv.includes('--known')) {
            const fresher = new Set(fresh);
            for (const v of violations) if (!fresher.has(v)) console.log(describeViolation(v));
            return 0;
        }
        if (problems.length || fresh.length) {
            if (problems.length) {
                console.error(`words:check — ${problems.length} problem(s):`);
                for (const p of problems) console.error(`  ${p}`);
            }
            if (fresh.length) {
                console.error(`words:check — ${fresh.length} glossary/numbers/untranslatable problem(s) not in ${GLOSSARY_BASELINE}${baseline ? '' : ' (no baseline: words:check --update records one)'}:`);
                console.error('  fix the translation (scripts/words/GLOSSARY.csv has the terms); never record a new problem.');
                for (const v of fresh.slice(0, 40)) console.error(`  ${describeViolation(v)}`);
                if (fresh.length > 40) console.error(`  … and ${fresh.length - 40} more`);
            }
            return 1;
        }
        console.log(`words:check — ok: ${callCount} t()/tn() calls, ${catalogCount} catalogs; ${violations.length} known glossary/numbers/untranslatable problems, none new`);
        if (fixed) console.log(`  ${fixed} recorded problem(s) are fixed: run words:check --update to keep them gone`);
        return 0;
    }
    if (cmd === 'draft') {
        const { draftCli } = await import('./draft.mjs');
        return draftCli(argv.slice(1));
    }
    if (cmd === 'lint') {
        const now = lintCounts(extracted);
        const nowConstants = constantCounts(extracted);
        const sum = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
        const file = path.join(ROOT, BASELINE);
        if (argv.includes('--update')) {
            const i = argv.indexOf('--raise');
            const raise = i >= 0 ? argv[i + 1] ?? '' : null;
            const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { counts: {} };
            const next = updatedBaseline(doc, now, { raise, constants: nowConstants });
            if (next.error) {
                console.error('words:lint --update — refused: these counts would RISE. Wrap the new text in t() instead, or, when a rise');
                console.error('is truly needed, say why: --update --raise "<reason>" (the reason is recorded in the baseline).');
                for (const e of next.error) console.error(`  ${e}`);
                return 1;
            }
            fs.writeFileSync(file, `${JSON.stringify(next.doc, null, 2)}\n`);
            console.log(`words:lint — recorded ${Object.keys(now).length} directories, ${sum(now)} literals; ${Object.keys(nowConstants).length} directories, ${sum(nowConstants)} on-screen constants`);
            return 0;
        }
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        // A baseline with no `constants` section reads as "none recorded", so every on-screen constant is a rise: never a silent pass.
        const { rises, falls } = compareToBaseline(now, doc.counts);
        const { rises: constantRises, falls: constantFalls } = compareToBaseline(nowConstants, doc.constants ?? {});
        if (rises.length || constantRises.length) {
            console.error('words:lint — more English outside t() than recorded. Wrap the new text in t() from @beanpool/core');
            console.error("(in English it returns the sentence unchanged): t('Save'), t('{name} joined', { name }).");
            for (const r of rises) console.error(`  ${r.dir}: ${r.was} → ${r.is}`);
            if (constantRises.length) {
                console.error("A sentence in a constant that a screen shows counts too: mark it word('…') where it is declared and t() it where it is shown");
                console.error('(scripts/words/README.md, "On-screen constants"). More than recorded:');
                for (const r of constantRises) console.error(`  (constants) ${r.dir}: ${r.was} → ${r.is}`);
            }
            return 1;
        }
        for (const f of falls) console.log(`  ${f.dir}: ${f.was} → ${f.is} (lower: run with --update to keep it there)`);
        for (const f of constantFalls) console.log(`  (constants) ${f.dir}: ${f.was} → ${f.is} (lower: run with --update to keep it there)`);
        console.log(`words:lint — ok: ${sum(now)} literals outside t() in ${Object.keys(now).length} directories and ${sum(nowConstants)} on-screen sentence constants in ${Object.keys(nowConstants).length}, none above the baseline`);
        return 0;
    }
    if (cmd === 'extract') {
        const { callKey } = await loadCoreChecks(ROOT);
        const byFolder = new Map();
        for (const pkg of extracted) {
            if (!pkg.words) continue;
            const map = byFolder.get(pkg.words) ?? {};
            for (const call of pkg.calls) {
                const key = callKey(call);
                if (key) (map[key] ??= []).push(call.at);
            }
            byFolder.set(pkg.words, map);
        }
        for (const [folder, map] of byFolder) {
            fs.mkdirSync(path.join(ROOT, folder), { recursive: true });
            fs.writeFileSync(path.join(ROOT, folder, 'en.sources.json'), `${JSON.stringify(map, null, 2)}\n`);
            console.log(`${folder}/en.sources.json: ${Object.keys(map).length} keys`);
        }
        return 0;
    }
    if (cmd === 'count') {
        const rows = countStrings(extracted);
        if (argv.includes('--json')) { console.log(JSON.stringify(rows, null, 2)); return 0; }
        console.log('package   files  t()  jsx+props  alerts  sentences   total  distinct   words  on-screen constants');
        for (const r of rows) {
            console.log(`${r.package.padEnd(8)} ${String(r.files).padStart(6)} ${String(r.tCalls).padStart(4)} ${String(r.jsx).padStart(10)} ${String(r.alert).padStart(7)} ${String(r.sentence).padStart(10)} ${String(r.total).padStart(7)} ${String(r.distinct).padStart(9)} ${String(r.words).padStart(7)} ${String(r.constants).padStart(20)}`);
        }
        return 0;
    }
    console.error('usage: node scripts/words/words.mjs check [--update [--raise "<reason>"] | --known] | draft [--report|--briefs <dir>] | lint [--update [--raise "<reason>"]] | extract | count [--json]');
    return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
