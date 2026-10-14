#!/usr/bin/env node
// words.mjs — the words layer's tooling (scratch/global-node/DESIGN-translation-fable.md §2.2, §2.5, §5).
//
//   node scripts/words/words.mjs check     every t()/tn() call is a whole sentence written as a literal, and every catalog
//                                          (<package>/words/<lang>.json) is structurally sound against the sources: same
//                                          placeholders as the English, the plural forms its language needs, no key that no
//                                          source uses any more. A MISSING translation is never a failure (the English shows).
//   node scripts/words/words.mjs lint      the ratchet: English literals a member reads (JSX text, text props, alert
//                                          arguments) outside t(), per directory, may only go down. --update records today's.
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
/** The languages that have catalog files; en has none (the key is the English). */
export const CATALOG_LANGS = ['ru', 'fr', 'pt', 'es'];

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

/**
 * One file's t()/tn() calls and the English a member reads outside them.
 * A call counts only when `t`/`tn` is imported from @beanpool/core or a words module (or is words.ts's own), so a
 * local variable named `t` is never mistaken for it.
 */
export function extractFromSource(file, text) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const tNames = new Map();
    if (/(^|\/)beanpool-core\/src\/words\.ts$/.test(file)) { tNames.set('t', 't'); tNames.set('tn', 'tn'); }
    for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
        const spec = st.moduleSpecifier.text;
        const named = st.importClause?.namedBindings;
        if (!named || !ts.isNamedImports(named) || !(spec === '@beanpool/core' || WORDS_MODULE.test(spec))) continue;
        for (const el of named.elements) {
            const imported = (el.propertyName ?? el.name).text;
            if (imported === 't' || imported === 'tn') tNames.set(el.name.text, imported);
        }
    }

    const calls = [];
    const found = [];
    const counted = new Set();
    const at = (node) => `${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
    const lit = (n) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
    const isPlus = (n) => !!n && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;
    const add = (kind, node, value) => {
        if (counted.has(node)) return;
        counted.add(node);
        found.push({ kind, text: value, at: at(node) });
    };

    const visit = (node) => {
        if (ts.isCallExpression(node)) {
            const callee = calleeText(node.expression);
            if (callee && ts.isIdentifier(node.expression) && tNames.has(callee)) {
                const fn = tNames.get(callee);
                let up = node.parent;
                while (up && ts.isParenthesizedExpression(up)) up = up.parent;
                const concatenated = isPlus(up) || node.arguments.some(isPlus);
                const args = node.arguments;
                const call = fn === 'tn'
                    ? { fn, text: lit(args[1]), other: lit(args[2]), concatenated, at: at(node) }
                    : { fn, text: lit(args[0]), context: lit(args[2]) ?? undefined, concatenated, at: at(node) };
                calls.push(call);
                return; // what is inside t() is translated, not counted
            }
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
    return { calls, found };
}

export function extractRepo(root = ROOT, packages = PACKAGES) {
    return packages.map((pkg) => {
        const files = sourceFiles(root, pkg.dirs);
        const calls = [];
        const found = [];
        for (const file of files) {
            const r = extractFromSource(file, fs.readFileSync(path.join(root, file), 'utf8'));
            calls.push(...r.calls);
            found.push(...r.found);
        }
        return { ...pkg, files: files.length, calls, found };
    });
}

// ── Core's checks, compiled in memory ───────────────────────────────────────────────────────────────────────────

let corePromise = null;
/** words.ts and words-check.ts from the SOURCE, as ES modules, without writing a file. */
export function loadCoreChecks(root = ROOT) {
    corePromise ??= (async () => {
        const compile = (rel) => ts.transpileModule(fs.readFileSync(path.join(root, rel), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const asUrl = (js) => `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`;
        const wordsUrl = asUrl(compile('packages/beanpool-core/src/words.ts'));
        const checkJs = compile('packages/beanpool-core/src/words-check.ts').replace(/(['"])\.\/words\.js\1/g, JSON.stringify(wordsUrl));
        return import(asUrl(checkJs));
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
    const problems = [];
    const byFolder = new Map();
    for (const pkg of extracted) {
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
        for (const lang of CATALOG_LANGS) {
            let catalog = catalogs?.[folder]?.[lang];
            const file = path.join(folder, `${lang}.json`);
            if (!catalog) {
                const full = path.join(root, file);
                if (!fs.existsSync(full)) { problems.push(`${file}: missing (an empty catalog is { "_meta": … })`); continue; }
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
            const doc = {
                _about: 'English a member reads outside t() (JSX text, text props, alert arguments), per directory. scripts/words/words.mjs lint fails when a count rises; S3 sweeps take each to 0. Lower it with --update; raising it needs a reason in the PR.',
                counts: now,
            };
            fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
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
    console.error('usage: node scripts/words/words.mjs check | lint [--update] | extract | count [--json]');
    return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await main(process.argv.slice(2));
}
