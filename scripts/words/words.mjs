#!/usr/bin/env node
// words.mjs — the words layer's tooling (scratch/global-node/DESIGN-translation-fable.md §2.2, §2.5, §5).
//
//   node scripts/words/words.mjs check     every t()/tn() call is a whole sentence written as a literal, and every catalog
//                                          (<package>/words/<lang>.json) is structurally sound against the sources: same
//                                          placeholders as the English, the plural forms its language needs, no key that no
//                                          source uses any more. A MISSING translation is never a failure (the English shows).
//   node scripts/words/words.mjs lint      the ratchet: English literals a member reads (JSX text, text props, alert
//                                          arguments) outside t(), per directory, may only go down. --update records a
//                                          fall; a rise is refused unless --raise "<reason>", which the file records.
//   node scripts/words/words.mjs extract   writes <package>/words/en.sources.json (key → file:line), the drafting lane's
//                                          context. Not tracked: line numbers would conflict in every PR.
//   node scripts/words/words.mjs count     the user-facing strings per package (--json for the raw numbers).
//
// The checks themselves live in packages/beanpool-core/src/words-check.ts. This script compiles that file (and words.ts)
// in memory with the TypeScript it already parses with, so it never depends on a built dist: test-all runs it beside
// the build, not after it.

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const BASELINE = 'scripts/words/lint-baseline.json';
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
    { name: 'native', dirs: ['apps/native/app', 'apps/native/components', 'apps/native/utils', 'apps/native/services', 'apps/native/constants'], words: 'apps/native/words', lint: true },
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

const WORDS_FNS = new Set(['t', 'tn', 'word']);
const FUNCTION_LIKE = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)
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

/**
 * One file's t()/tn()/word() calls, the English a member reads outside them, and how the file reaches the words layer.
 *
 * What counts as a words call (N7: the extractor SEES these rather than refusing them):
 *   - `t` / `tn` / `word` imported by name from ANY module (core, a words module, or a module that re-exports them);
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
    for (const st of sf.statements) {
        if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
            const named = st.importClause?.namedBindings;
            if (named && ts.isNamespaceImport(named)) holders.add(named.name.text);
            if (named && ts.isNamedImports(named)) {
                for (const el of named.elements) {
                    const imported = (el.propertyName ?? el.name).text;
                    if (WORDS_FNS.has(imported)) tNames.set(el.name.text, imported);
                    if (imported === 'wordsFor') factories.add(el.name.text);
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
    /** 't' | 'tn' | 'word' when this call goes to the words layer, else null. */
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
                const first = unwrap(args[0]);
                const keyed = fn === 't' && !!first && (ts.isPropertyAccessExpression(first) || ts.isElementAccessExpression(first));
                const call = fn === 'tn'
                    ? { fn, text: lit(args[1]), other: lit(args[2]), concatenated, at: at(node) }
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
    return { calls, found, problems };
}

export function extractRepo(root = ROOT, packages = PACKAGES) {
    return packages.map((pkg) => {
        const files = sourceFiles(root, pkg.dirs);
        const calls = [];
        const found = [];
        const problems = [];
        for (const file of files) {
            const r = extractFromSource(file, fs.readFileSync(path.join(root, file), 'utf8'));
            calls.push(...r.calls);
            found.push(...r.found);
            problems.push(...r.problems);
        }
        return { ...pkg, files: files.length, calls, found, problems };
    });
}

// ── Core's checks, compiled in memory ───────────────────────────────────────────────────────────────────────────

let corePromise = null;
/** words.ts (with words-dates.ts) and words-check.ts from the SOURCE, as ES modules, without writing a file. */
export function loadCoreChecks(root = ROOT) {
    corePromise ??= (async () => {
        const compile = (rel) => ts.transpileModule(fs.readFileSync(path.join(root, rel), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const asUrl = (js) => `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
        const datesUrl = asUrl(compile('packages/beanpool-core/src/words-dates.ts'));
        const wordsUrl = asUrl(compile('packages/beanpool-core/src/words.ts').replace(/(['"])\.\/words-dates\.js\1/g, JSON.stringify(datesUrl)));
        const checkJs = compile('packages/beanpool-core/src/words-check.ts').replace(/(['"])\.\/words\.js\1/g, JSON.stringify(wordsUrl));
        const [words, check] = await Promise.all([import(wordsUrl), import(asUrl(checkJs))]);
        return { ...words, ...check };
    })();
    return corePromise;
}

// ── check ───────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Problems in the extracted calls and in the catalogs. `catalogs` (tests) maps a words folder to { lang: object };
 * by default each folder's <lang>.json files are read.
 */
export async function checkRepo({ root = ROOT, extracted = extractRepo(root), catalogs = null } = {}) {
    const { callProblem, callKey, checkCatalog } = await loadCoreChecks(ROOT);
    const langs = await catalogLangs(ROOT);
    const problems = [];
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
            if (call.fn === 'tn') entry.plural.add(key);
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
        }
    }
    const callCount = extracted.reduce((n, p) => n + p.calls.length, 0);
    return { problems, callCount, catalogCount };
}

// ── lint ────────────────────────────────────────────────────────────────────────────────────────────────────────

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

/**
 * The rises in `doc` over `mainDoc` (the baseline on origin/main) that no `--raise "<reason>"` entry in `doc.raises`
 * accounts for. Empty when every count is at or under main's, or each rise was recorded with a reason.
 */
export function unexplainedRises(mainDoc, doc) {
    if (!mainDoc?.counts) return [];
    const known = new Set((mainDoc.raises ?? []).map((r) => JSON.stringify(r)));
    const added = (doc.raises ?? []).filter((r) => !known.has(JSON.stringify(r)) && typeof r.reason === 'string' && r.reason.trim().length > 0);
    return compareToBaseline(doc.counts ?? {}, mainDoc.counts).rises
        .filter((r) => !added.some((a) => Array.isArray(a.dirs?.[r.dir]) && a.dirs[r.dir][1] >= r.is));
}

/** The baseline document `lint --update` writes: today's counts; a rise only with a reason, recorded in `raises`. */
export function updatedBaseline(doc, now, { raise = null, date = new Date().toISOString().slice(0, 10) } = {}) {
    const { rises } = compareToBaseline(now, doc?.counts ?? {});
    if (rises.length && !(typeof raise === 'string' && raise.trim())) {
        return { error: rises.map((r) => `${r.dir}: ${r.was} → ${r.is}`) };
    }
    const raises = [...(doc?.raises ?? [])];
    if (rises.length) raises.push({ date, reason: raise.trim(), dirs: Object.fromEntries(rises.map((r) => [r.dir, [r.was, r.is]])) });
    return {
        doc: {
            _about: 'English a member reads outside t() (JSX text, text props, alert arguments), per directory. scripts/words/words.mjs lint fails when a count rises; S3 sweeps take each to 0. `lint --update` lowers it; a rise needs `--update --raise "<reason>"`, which is recorded in `raises` (words.test.mjs compares with origin/main).',
            counts: now,
            ...(raises.length ? { raises } : {}),
        },
    };
}

// ── count ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function countStrings(extracted) {
    return extracted.map((pkg) => {
        const by = (k) => pkg.found.filter((f) => f.kind === k).length;
        const distinct = new Set(pkg.found.map((f) => f.text));
        const words = [...distinct].reduce((n, s) => n + s.split(/\s+/).filter(Boolean).length, 0);
        return {
            package: pkg.name, files: pkg.files, tCalls: pkg.calls.length, jsx: by('jsx'), alert: by('alert'), sentence: by('sentence'),
            total: pkg.found.length, distinct: distinct.size, words,
        };
    });
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────────────────

async function main(argv) {
    const cmd = argv[0];
    const extracted = extractRepo(ROOT);
    if (cmd === 'check') {
        const { problems, callCount, catalogCount } = await checkRepo({ extracted });
        if (problems.length) {
            console.error(`words:check — ${problems.length} problem(s):`);
            for (const p of problems) console.error(`  ${p}`);
            return 1;
        }
        console.log(`words:check — ok: ${callCount} t()/tn() calls, ${catalogCount} catalogs`);
        return 0;
    }
    if (cmd === 'lint') {
        const now = lintCounts(extracted);
        const file = path.join(ROOT, BASELINE);
        if (argv.includes('--update')) {
            const i = argv.indexOf('--raise');
            const raise = i >= 0 ? argv[i + 1] ?? '' : null;
            const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { counts: {} };
            const next = updatedBaseline(doc, now, { raise });
            if (next.error) {
                console.error('words:lint --update — refused: these counts would RISE. Wrap the new text in t() instead, or, when a rise');
                console.error('is truly needed, say why: --update --raise "<reason>" (the reason is recorded in the baseline).');
                for (const e of next.error) console.error(`  ${e}`);
                return 1;
            }
            fs.writeFileSync(file, `${JSON.stringify(next.doc, null, 2)}\n`);
            console.log(`words:lint — recorded ${Object.keys(now).length} directories, ${Object.values(now).reduce((a, b) => a + b, 0)} literals`);
            return 0;
        }
        const baseline = JSON.parse(fs.readFileSync(file, 'utf8')).counts;
        const { rises, falls } = compareToBaseline(now, baseline);
        const total = Object.values(now).reduce((a, b) => a + b, 0);
        if (rises.length) {
            console.error('words:lint — more English outside t() than recorded. Wrap the new text in t() from @beanpool/core');
            console.error("(in English it returns the sentence unchanged): t('Save'), t('{name} joined', { name }).");
            for (const r of rises) console.error(`  ${r.dir}: ${r.was} → ${r.is}`);
            return 1;
        }
        for (const f of falls) console.log(`  ${f.dir}: ${f.was} → ${f.is} (lower: run with --update to keep it there)`);
        console.log(`words:lint — ok: ${total} literals outside t() in ${Object.keys(now).length} directories, none above the baseline`);
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
        console.log('package   files  t()  jsx+props  alerts  sentences   total  distinct   words');
        for (const r of rows) {
            console.log(`${r.package.padEnd(8)} ${String(r.files).padStart(6)} ${String(r.tCalls).padStart(4)} ${String(r.jsx).padStart(10)} ${String(r.alert).padStart(7)} ${String(r.sentence).padStart(10)} ${String(r.total).padStart(7)} ${String(r.distinct).padStart(9)} ${String(r.words).padStart(7)}`);
        }
        return 0;
    }
    console.error('usage: node scripts/words/words.mjs check | lint [--update [--raise "<reason>"]] | extract | count [--json]');
    return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await main(process.argv.slice(2));
}
