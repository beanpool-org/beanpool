/**
 * An Alert's words go in its MESSAGE; its title stays short (emulator walk 17 Nov, RESULT-walk-emulator-nov17b.md row 1,
 * FAIL (b)).
 *
 * Android draws an Alert's title on at most two lines and cuts the rest with "…" (React Native 0.83's
 * modules/dialog/DialogTitle.kt: singleLine, then maxLines = 2). Its message wraps freely. At 320 dp with text at 130 % a
 * title holds about 18 characters a line, so about 36 in all. A muted guest's send showed
 * `Alert.alert(outsideErrorWords(e))`: the whole refusal was the title, cut at "Three of your posts were removed by t…", so
 * they never read "You can still read, edit your profile and leave." The same cut hid the guest's address in
 * "Remove Cy · riverside.walk.example · guest?". iOS shows a long title whole, but in bold and large, so the same rule
 * reads better there too.
 *
 * This guard reads every Alert.alert in the phone app (app, components, utils, services, tools, constants). It follows a
 * title or a message through `?:`, `??` and `||`, and reads a word where it can: a literal, `t('…')`, `tn(n, '…', '…')`, a
 * word constant (`t(W.key)`, from core or this app's own object of words) or a core word function called with nothing.
 * Since review 6933630856 ("You're in {name}" reached a title through joinedNudgeWords and joinedTitle) it also follows a
 * helper, up to MAX_FOLLOW deep: what a function returns (this file's, another file's, or core's, read from core's
 * source), a method of an object of words called with an argument, `x.title` where `const x = helper(…)`, the two
 * paragraphs of utils/alert-words twoParagraphs, and English written as a template (`You're in ${name}` reads
 * "You're in {name}"). Then:
 *
 *   1. An Alert that can open with no message (one argument, or a message that can be undefined, null or '') must have a
 *      title it can read, and that title must be in SHORT_TITLE_ONLY with the reason it says enough alone (an options
 *      menu whose buttons are its content). Anything else puts its words in the message, under a short title.
 *   2. A title the guard can read is at most TITLE_MAX characters of English.
 *   3. A title that puts in a value other than a count (a name, an address, a guest line, a link) is in NAMED_TITLES with
 *      why that value stays short, or it moves to the message.
 *   4. A title made from an error or a server's words (`e.message`, `…ErrorWords(e)`, `…FailureWords(e)`) always fails.
 *   5. No part of an Alert stays English in a language another part of its message is shown in: each word of its title
 *      and of its message is in the phone's or core's catalog for every language one word of its message is. (Review
 *      6933630856: the guest Remove's question went English when its key left the phone's catalogs, and its new title
 *      was a key no catalog has.) A title may be translated where its message isn't yet: a screen not drafted.
 *
 * An entry in either list that no longer matches an Alert fails too, so the lists can't rot.
 *
 * What it cannot see: a value it can't follow (a function's parameter, state, a server's answer), which branch an `if`
 * already ruled out (so whether a message can be empty is read as written, not through a helper), and how long a title
 * is in another language: TITLE_MAX leaves some room for that, not all.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import * as core from '@beanpool/core';

const NATIVE = path.join(__dirname, '..', '..');
const ROOTS = ['app', 'components', 'utils', 'services', 'tools', 'constants'];

/** The longest title, in English characters. Two lines at 320 dp × 130 % hold about 36; less, for longer languages. */
const TITLE_MAX = 30;

/** Placeholders that are a count: a number stays short. */
const COUNT_PLACEHOLDERS = new Set(['n', 'count', 'max']);

/**
 * `<file>: <title in English>` → why a title with no message says enough. Short literal titles only (rule 1 still needs
 * the title to be readable and short).
 */
const SHORT_TITLE_ONLY: Record<string, string> = {
    'app/post/[id].tsx: Post options': "an options menu: the post's actions are its buttons",
    'components/EventDetail.tsx: Event options': "an options menu: the event's actions are its buttons",
    'components/PollCard.tsx: Poll options': "an options menu: the poll's actions are its buttons",
};

/** `<file>: <title in English>` → why the value it puts in stays short enough for a title. */
const NAMED_TITLES: Record<string, string> = {
    'app/(tabs)/settings.tsx: Disconnect {name}?': 'a sign-in provider: Apple, Google or Facebook (utils/sso-providers.ts SSO_PROVIDER_NAMES)',
    'app/channels.tsx: Disconnect {platform}?': "a platform's own short name (core channels.ts platformName: YouTube, TikTok, Instagram…)",
    'components/VaultMoveCard.tsx: Remove your {name} recovery?': 'a sign-in provider: Apple, Google or Facebook (SSO_PROVIDER_NAMES[offer.provider]); "Remove your Facebook recovery?" is 30',
};

/**
 * `<file>: <title code>` → a wrapper that hands on its caller's title and message, and where its callers are checked.
 * Rule 1 does not apply to it (rule 4 still does).
 */
const PASS_THROUGH: Record<string, string> = {
    'components/RecoveryKitButtons.tsx: welcomeLineWords(title)':
        "askBeforeSavingKit's dialog in the member's language; its one caller (utils/recovery-kit.ts) passes 'Save as PDF' and a message",
};

// ---------------------------------------------------------------------------------------------------------------------

type Leaf =
    | { kind: 'empty' }
    /** `key`: the catalog key t() looks up (a translator's note kept, a plural's `one|other`); none for English written out. */
    | { kind: 'text'; en: string; key?: string }
    | { kind: 'opaque'; code: string };

type Source = { rel: string; sf: ts.SourceFile };

function listSources(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) listSources(full, out);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
    }
    return out;
}

function parse(rel: string, text: string): Source {
    return { rel, sf: ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) };
}

const parsedFiles = new Map<string, Source | null>();
function parseFile(abs: string): Source | null {
    if (!parsedFiles.has(abs)) {
        parsedFiles.set(abs, fs.existsSync(abs) ? parse(path.relative(NATIVE, abs), fs.readFileSync(abs, 'utf8')) : null);
    }
    return parsedFiles.get(abs)!;
}

function strip(n: ts.Expression): ts.Expression {
    let e = n;
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    return e;
}

function literalText(n: ts.Expression | undefined): string | null {
    if (!n) return null;
    const e = strip(n);
    return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : null;
}

/**
 * What a top-level name in this file stands for: a core export, another file's export, or a local declaration (a value,
 * or a function declared with `function`).
 */
type Binding = { core: string } | { node: ts.Node; src: Source } | null;

function bindingOf(src: Source, name: string, depth = 0): Binding {
    if (depth > 4) return null;
    for (const st of src.sf.statements) {
        if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
            const b = st.importClause?.namedBindings;
            if (!b || !ts.isNamedImports(b)) continue;
            for (const el of b.elements) {
                if (el.name.text !== name) continue;
                const imported = (el.propertyName ?? el.name).text;
                const spec = st.moduleSpecifier.text;
                if (spec === '@beanpool/core') return { core: imported };
                if (spec.startsWith('.')) {
                    // core's own files import './x.js' (ESM): its source is x.ts.
                    const base = path.resolve(path.dirname(path.join(NATIVE, src.rel)), spec.replace(/\.js$/, ''));
                    for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
                        const other = parseFile(cand);
                        if (other) return bindingOf(other, imported, depth + 1);
                    }
                }
                return null;
            }
        }
        if (ts.isFunctionDeclaration(st) && st.name?.text === name && st.body) return { node: st, src };
        if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) {
                if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
                    const init = strip(d.initializer);
                    if (ts.isIdentifier(init)) return bindingOf(src, init.text, depth + 1);
                    return { node: init, src };
                }
            }
        }
    }
    return null;
}

/** A word of `<object>.<key>`, when the object is a core export or an object literal of words; else null. */
function wordOf(src: Source, objName: string, key: string, call: boolean): { en: string; key: string } | null {
    const w = wordOfRaw(src, objName, key, call);
    // A word with a translator's note is `text\u0004note` (core words.ts word()); t() shows the text, and looks up the whole.
    return w === null ? null : { en: w.split('\u0004')[0], key: w };
}

function wordOfRaw(src: Source, objName: string, key: string, call: boolean): string | null {
    const b = bindingOf(src, objName);
    if (!b) return null;
    if ('core' in b) {
        const obj = (core as Record<string, any>)[b.core];
        const v = obj?.[key];
        if (call) return typeof v === 'function' && v.length === 0 ? String(v.call(obj)) : null;
        return typeof v === 'string' ? v : null;
    }
    if (!ts.isObjectLiteralExpression(b.node)) return null;
    for (const p of b.node.properties) {
        const pname = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
        if (pname !== key) continue;
        if (!call && ts.isPropertyAssignment(p)) return literalText(p.initializer) ?? tLiteral(p.initializer);
        if (call && ts.isPropertyAssignment(p) && ts.isArrowFunction(strip(p.initializer))) {
            const fn = strip(p.initializer) as ts.ArrowFunction;
            if (fn.parameters.length === 0 && !ts.isBlock(fn.body)) return tLiteral(fn.body);
        }
        return null;
    }
    return null;
}

/** `t('…')`'s or `word('…')`'s catalog key (its English, and a translator's note if it has one), or null. */
function tLiteral(n: ts.Expression | ts.ConciseBody): string | null {
    const e = strip(n as ts.Expression);
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && (e.expression.text === 't' || e.expression.text === 'word')) return callKey(e);
    return null;
}

/** The key `t('X', values, 'note')` or `word('X', 'note')` looks up: core words.ts wordKey. */
function callKey(e: ts.CallExpression): string | null {
    const en = literalText(e.arguments[0]);
    if (en === null) return null;
    const note = literalText(e.arguments[(e.expression as ts.Identifier).text === 'word' ? 1 : 2]);
    return note ? `${en}\u0004${note}` : en;
}

// ── Following a helper (review 6933630856: "You're in {name}" reached a title through joinedNudgeWords and joinedTitle) ──

/** How many helpers deep a title or message is followed. */
const MAX_FOLLOW = 4;

const CORE_SRC = path.join(NATIVE, '..', '..', 'packages', 'beanpool-core', 'src');
let coreIndex: Map<string, Source> | null = null;
/** The core source file that declares an export, for a core function that takes an argument (it can't be called here). */
function coreSourceOf(name: string): Source | null {
    if (!coreIndex) {
        coreIndex = new Map();
        for (const abs of listSources(CORE_SRC)) {
            const text = fs.readFileSync(abs, 'utf8');
            for (const m of text.matchAll(/^export (?:async )?(?:function|const) ([A-Za-z0-9_$]+)/gm)) {
                if (!coreIndex.has(m[1])) coreIndex.set(m[1], parseFile(abs)!);
            }
        }
    }
    return coreIndex.get(name) ?? null;
}

/** A binding, with a core export taken to its source file. */
function sourceBinding(src: Source, name: string): { node: ts.Node; src: Source } | null {
    const b = bindingOf(src, name);
    if (!b) return null;
    if (!('core' in b)) return b;
    const file = coreSourceOf(b.core);
    const inCore = file ? bindingOf(file, b.core) : null;
    return inCore && !('core' in inCore) ? inCore : null;
}

type Fn = { fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration; src: Source };

function asFn(node: ts.Node, src: Source): Fn | null {
    const n = ts.isExpression(node) ? strip(node) : node;
    if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) return n.body ? { fn: n, src } : null;
    return null;
}

/** The function a call calls: a helper of this file or another, a core function, or a method of an object of words. */
function functionAt(src: Source, callee: ts.Expression): Fn | null {
    const c = strip(callee);
    if (ts.isIdentifier(c)) {
        if (['t', 'tn', 'word', 'wordn'].includes(c.text)) return null;
        const b = sourceBinding(src, c.text);
        return b ? asFn(b.node, b.src) : null;
    }
    if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression)) {
        const b = sourceBinding(src, c.expression.text);
        if (!b || !ts.isExpression(b.node)) return null;
        const obj = strip(b.node);
        if (!ts.isObjectLiteralExpression(obj)) return null;
        for (const p of obj.properties) {
            const pname = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
            if (pname !== c.name.text) continue;
            if (ts.isMethodDeclaration(p)) return asFn(p, b.src);
            if (ts.isPropertyAssignment(p)) return asFn(p.initializer, b.src);
        }
    }
    return null;
}

/** What a function returns: its expression body, or each `return` in its body (not in a function inside it). */
function returnsOf(f: Fn): ts.Expression[] {
    const body = f.fn.body!;
    if (!ts.isBlock(body)) return [body];
    const out: ts.Expression[] = [];
    const walk = (n: ts.Node) => {
        if (n !== body && ts.isFunctionLike(n)) return;
        if (ts.isReturnStatement(n) && n.expression) out.push(n.expression);
        ts.forEachChild(n, walk);
    };
    walk(body);
    return out;
}

/** The value a local name was given (`const nudge = await joinedNudgeWords(…)`), the nearest declaration before `at`. */
function localValue(src: Source, id: ts.Identifier): ts.Expression | null {
    for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
        const statements = ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope) ? scope.statements : null;
        if (!statements) continue;
        let found: ts.Expression | null = null;
        for (const st of statements) {
            if (st.getStart(src.sf) > id.getStart(src.sf)) break;
            if (!ts.isVariableStatement(st)) continue;
            for (const d of st.declarationList.declarations) {
                if (ts.isIdentifier(d.name) && d.name.text === id.text && d.initializer) found = d.initializer;
            }
        }
        if (found) return found;
    }
    return null;
}

function unwrapAwait(n: ts.Expression): ts.Expression {
    let e = strip(n);
    while (ts.isAwaitExpression(e)) e = strip(e.expression);
    return e;
}

/** `value.<prop>`, where value is an object a helper returns, or one written out: the property's leaves; null if unread. */
function pick(src: Source, n: ts.Expression, prop: string, depth: number): Leaf[] | null {
    if (depth > MAX_FOLLOW) return null;
    const e = unwrapAwait(n);
    if (ts.isConditionalExpression(e)) {
        const a = pick(src, e.whenTrue, prop, depth);
        const b = pick(src, e.whenFalse, prop, depth);
        return a && b ? [...a, ...b] : null;
    }
    if (ts.isObjectLiteralExpression(e)) {
        for (const p of [...e.properties].reverse()) {
            if (ts.isSpreadAssignment(p)) {
                const spread = pick(src, p.expression, prop, depth + 1);
                if (spread) return spread;
                continue;
            }
            const pname = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
            if (pname !== prop) continue;
            if (ts.isPropertyAssignment(p)) return leaves(src, p.initializer, depth);
            return null;
        }
        return null;
    }
    if (ts.isCallExpression(e)) {
        const f = functionAt(src, e.expression);
        if (!f) return null;
        const out: Leaf[] = [];
        for (const r of returnsOf(f)) {
            const got = pick(f.src, r, prop, depth + 1);
            if (!got) return null;
            out.push(...got);
        }
        return out.length ? out : null;
    }
    if (ts.isIdentifier(e)) {
        const v = localValue(src, e);
        return v ? pick(src, v, prop, depth + 1) : null;
    }
    return null;
}

/** A template's English, a placeholder for each value: `You're in ${name}` reads "You're in {name}". */
function templateText(e: ts.TemplateExpression): string {
    const holder = (x: ts.Expression): string => {
        const s = strip(x);
        if (ts.isIdentifier(s)) return s.text;
        if (ts.isPropertyAccessExpression(s)) return s.name.text;
        return 'value';
    };
    return e.head.text + e.templateSpans.map((s) => `{${holder(s.expression)}}${s.literal.text}`).join('');
}

function leaves(src: Source, n: ts.Expression | undefined, depth = 0): Leaf[] {
    if (!n) return [{ kind: 'empty' }];
    const e = strip(n);
    if (ts.isConditionalExpression(e)) return [...leaves(src, e.whenTrue, depth), ...leaves(src, e.whenFalse, depth)];
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
        return [...leaves(src, e.left, depth), ...leaves(src, e.right, depth)];
    }
    if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) return [{ kind: 'empty' }];
    const lit = literalText(e);
    if (lit !== null) return [lit === '' ? { kind: 'empty' } : { kind: 'text', en: lit }];
    if (ts.isTemplateExpression(e)) return [{ kind: 'text', en: templateText(e) }];
    const code = e.getText(src.sf).replace(/\s+/g, ' ');
    // utils/alert-words.ts twoParagraphs(first, then): the message is both paragraphs.
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'twoParagraphs' && e.arguments.length === 2) {
        return [...leaves(src, e.arguments[0], depth), ...leaves(src, e.arguments[1], depth)];
    }
    if (ts.isCallExpression(e)) {
        const callee = e.expression;
        // t('…'), t(W.key), word('…')
        if (ts.isIdentifier(callee) && (callee.text === 't' || callee.text === 'word')) {
            const a = e.arguments[0] && strip(e.arguments[0]);
            const direct = literalText(a);
            if (direct !== null) return [{ kind: 'text', en: direct, key: callKey(e) ?? direct }];
            if (a && ts.isPropertyAccessExpression(a) && ts.isIdentifier(a.expression)) {
                const w = wordOf(src, a.expression.text, a.name.text, false);
                if (w !== null) return [{ kind: 'text', ...w }];
            }
            return [{ kind: 'opaque', code }];
        }
        // tn(n, 'one', 'many'): both forms
        if (ts.isIdentifier(callee) && callee.text === 'tn') {
            const one = literalText(e.arguments[1]);
            const many = literalText(e.arguments[2]);
            const key = `${one}|${many}`; // core words.ts pluralKey
            return one !== null && many !== null ? [{ kind: 'text', en: one, key }, { kind: 'text', en: many, key }] : [{ kind: 'opaque', code }];
        }
        // W.key() and fn(): a word function called with nothing
        if (e.arguments.length === 0 && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
            const w = wordOf(src, callee.expression.text, callee.name.text, true);
            if (w !== null) return [{ kind: 'text', ...w }];
        }
        if (e.arguments.length === 0 && ts.isIdentifier(callee)) {
            const b = bindingOf(src, callee.text);
            const fn = b && 'core' in b ? (core as Record<string, any>)[b.core] : null;
            if (typeof fn === 'function' && fn.length === 0) return [{ kind: 'text', en: String(fn()), key: String(fn()) }];
        }
        // joinedPlaceWords(place, …): what the helper returns, read in its own file.
        const f = depth < MAX_FOLLOW ? functionAt(src, callee) : null;
        if (f) {
            const returned = returnsOf(f);
            if (returned.length) return returned.flatMap((r) => leaves(f.src, r, depth + 1));
        }
        return [{ kind: 'opaque', code }];
    }
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
        const w = wordOf(src, e.expression.text, e.name.text, false);
        if (w !== null) return [{ kind: 'text', ...w }];
        // `nudge.title`, where `const nudge = joinedNudgeWords(…)`: what the helper returns as `title`.
        const v = depth < MAX_FOLLOW ? localValue(src, e.expression) : null;
        const picked = v ? pick(src, v, e.name.text, depth + 1) : null;
        if (picked) return picked;
    }
    return [{ kind: 'opaque', code }];
}

/** An error's or a server's own words, used as a title. */
const ERRORISH = /\.message\b|ErrorWords|ErrorMessage|FailureWords|NotSentWords/;

/** One Alert: where, its title's code as written (for PASS_THROUGH), and what its title and message can read. */
type Found = { at: string; key: string; titleCode: string; title: Leaf[]; message: Leaf[]; messageCanBeEmpty: boolean };

function alertsIn(src: Source): Found[] {
    const out: Found[] = [];
    const visit = (n: ts.Node) => {
        if (
            ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'alert'
            && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === 'Alert'
            && !n.arguments.some((a) => ts.isSpreadElement(a)) // a pass-through (keyboard-alert, App Lock's cover)
        ) {
            const line = src.sf.getLineAndCharacterOfPosition(n.getStart(src.sf)).line + 1;
            const title = leaves(src, n.arguments[0]);
            const titleCode = n.arguments[0] ? strip(n.arguments[0]).getText(src.sf).replace(/\s+/g, ' ') : '';
            const message = n.arguments.length < 2 ? [{ kind: 'empty' } as Leaf] : leaves(src, n.arguments[1]);
            // Whether it can open with no message is read as written, not through a helper: a helper's `error` or `body` can be
            // null in a branch the screen has already ruled out (`if (billAsked.error) Alert.alert(…, billAsked.error)`).
            const asWritten = n.arguments.length < 2 ? [{ kind: 'empty' } as Leaf] : leaves(src, n.arguments[1], MAX_FOLLOW);
            out.push({ at: `${src.rel}:${line}`, key: src.rel, titleCode, title, message, messageCanBeEmpty: asWritten.some((l) => l.kind === 'empty') });
        }
        ts.forEachChild(n, visit);
    };
    visit(src.sf);
    return out;
}

/** Each rule a found Alert breaks, and the list entries it uses. */
function check(found: Found[]): { problems: string[]; usedShort: Set<string>; usedNamed: Set<string>; usedPass: Set<string> } {
    const problems: string[] = [];
    const usedShort = new Set<string>();
    const usedNamed = new Set<string>();
    const usedPass = new Set<string>();
    for (const f of found) {
        const texts = f.title.filter((l): l is Extract<Leaf, { kind: 'text' }> => l.kind === 'text');
        const opaque = f.title.filter((l): l is Extract<Leaf, { kind: 'opaque' }> => l.kind === 'opaque');
        // The title as written, before any helper is followed: a wrapper hands on its caller's.
        const pass = `${f.key}: ${f.titleCode}`;
        if (PASS_THROUGH[pass]) usedPass.add(pass);
        else if (f.messageCanBeEmpty) {
            if (opaque.length || f.title.some((l) => l.kind === 'empty')) {
                problems.push(`${f.at}: no message, and a title the guard can't read (${opaque.map((o) => o.code).join(' | ') || 'empty'}): put the words in the message, under a short title`);
            }
            for (const l of texts) {
                const k = `${f.key}: ${l.en}`;
                if (SHORT_TITLE_ONLY[k]) usedShort.add(k);
                else problems.push(`${f.at}: no message, title only: "${l.en}": put the words in the message, under a short title (or list it in SHORT_TITLE_ONLY with why it says enough)`);
            }
        }
        for (const l of texts) {
            if (l.en.length > TITLE_MAX) problems.push(`${f.at}: title of ${l.en.length} characters (max ${TITLE_MAX}): "${l.en}"`);
            const values = [...l.en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((v) => !COUNT_PLACEHOLDERS.has(v));
            if (values.length) {
                const k = `${f.key}: ${l.en}`;
                if (NAMED_TITLES[k]) usedNamed.add(k);
                else problems.push(`${f.at}: title puts in {${values.join('}, {')}}: "${l.en}": a name or address can be any length; put it in the message`);
            }
        }
        for (const o of opaque) {
            if (ERRORISH.test(o.code)) problems.push(`${f.at}: title made from an error or a server's words (${o.code}): put them in the message`);
        }
    }
    // A helper with several returns can give one title twice: one line each.
    return { problems: [...new Set(problems)], usedShort, usedNamed, usedPass };
}

/** Each language's words as the phone loads them: its own catalog and core's (setLanguage(lang, [phone, core])). */
type Catalogs = Record<string, Record<string, unknown>>;

function loadCatalogs(): Catalogs {
    const out: Catalogs = {};
    for (const f of fs.readdirSync(path.join(NATIVE, 'words')).filter((n) => n.endsWith('.json'))) {
        const lang = f.slice(0, -'.json'.length);
        const read = (dir: string) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : {});
        out[lang] = { ...read(path.join(CORE_SRC, '..', 'words')), ...read(path.join(NATIVE, 'words')) };
    }
    return out;
}

/** The languages a key is translated into; none for English written out (no key). */
function langsOf(cats: Catalogs, key: string | undefined): Set<string> {
    const out = new Set<string>();
    if (key === undefined) return out;
    for (const [lang, c] of Object.entries(cats)) {
        const v = c[key];
        if ((typeof v === 'string' && v.length > 0) || (v && typeof v === 'object')) out.add(lang);
    }
    return out;
}

type TextLeaf = Extract<Leaf, { kind: 'text' }>;
/** A word with letters in it: '{first}\n\n{then}' joins, it says nothing. */
const worded = (ls: Leaf[]): TextLeaf[] => ls.filter((l): l is TextLeaf => l.kind === 'text' && /\p{L}/u.test(l.en.replace(/\{\w+\}/g, '')));

/**
 * Rule 5 (review 6933630856: the guest Remove's question lost its 24 translations when its key left the phone's catalogs,
 * and its new title was a key no catalog has): no part of an Alert stays English in a language another part of its message
 * is shown in. Every word the guard reads in its message, and every word of its title, is translated in each language any
 * word of its message is. A title may be translated where its message isn't yet (a screen not drafted).
 */
function translationGaps(found: Found[], cats: Catalogs): string[] {
    const problems: string[] = [];
    for (const f of found) {
        const message = worded(f.message);
        const shown = new Set<string>();
        for (const l of message) for (const lang of langsOf(cats, l.key)) shown.add(lang);
        if (!shown.size) continue;
        for (const [part, ls] of [['title', worded(f.title)], ['message', message]] as const) {
            for (const l of ls) {
                const have = langsOf(cats, l.key);
                const missing = [...shown].filter((lang) => !have.has(lang)).sort();
                if (missing.length) problems.push(`${f.at}: ${part} "${l.en}" stays English in ${missing.length} language(s) its message is shown in (${missing.join(', ')})`);
            }
        }
    }
    return [...new Set(problems)];
}

function checkSource(rel: string, text: string): string[] {
    return check(alertsIn(parse(rel, text))).problems;
}

// ---------------------------------------------------------------------------------------------------------------------

describe('the guard can fail', () => {
    const head = "import { t, tn } from '@beanpool/core';\nconst W = { ask: 'Remove {name}?', long: 'This sentence is far too long to be any title at all.' };\n";
    it('a one-argument Alert with an error\'s words', () => {
        expect(checkSource('app/x.tsx', `${head}Alert.alert(outsideErrorWords(e));`)).toEqual([
            expect.stringMatching(/no message, and a title the guard can't read/),
            expect.stringMatching(/title made from an error/),
        ]);
    });
    it('a refusal that is the title while the message is undefined', () => {
        const p = checkSource('app/x.tsx', `${head}Alert.alert(notSent ?? t('Reported'), notSent ? undefined : body, []);`);
        expect(p.some((s) => /no message, and a title the guard can't read \(notSent\)/.test(s))).toBe(true);
        expect(p.some((s) => /title only: "Reported"/.test(s))).toBe(true);
    });
    it('a short literal alone, not listed', () => {
        expect(checkSource('app/x.tsx', `${head}Alert.alert(t('At most {n} photos.', { n: 4 }));`)).toEqual([
            expect.stringMatching(/title only: "At most \{n\} photos\."/),
        ]);
    });
    it('a long title, read through a word constant', () => {
        expect(checkSource('app/x.tsx', `${head}Alert.alert(t(W.long), t('More.'));`)).toEqual([expect.stringMatching(/title of 53 characters/)]);
    });
    it('a name in the title', () => {
        expect(checkSource('app/x.tsx', `${head}Alert.alert(t(W.ask, { name }), t('What happens.'), []);`)).toEqual([expect.stringMatching(/title puts in \{name\}/)]);
    });
    it('an error\'s words as a title, even with a message', () => {
        expect(checkSource('app/x.tsx', `${head}Alert.alert(e?.message || t('Not saved'), t('Try again.'));`)).toEqual([expect.stringMatching(/title made from an error/)]);
    });
    it('a core word function called with nothing is read', () => {
        // addPeopleWords.row() is 43 characters of English.
        const src = "import { addPeopleWords } from '@beanpool/core';\nAlert.alert(addPeopleWords.row(), addPeopleWords.none());";
        expect(checkSource('app/x.tsx', src)).toEqual([expect.stringMatching(/title of 43 characters/)]);
    });
    it('passes: a short title, the words in the message', () => {
        expect(checkSource('app/x.tsx', `${head}Alert.alert(t('Not sent'), outsideErrorWords(e));`)).toEqual([]);
        expect(checkSource('app/x.tsx', `${head}Alert.alert(cond ? t('Not saved') : t('Not sent'), why || t('Try again.'), []);`)).toEqual([]);
    });
});

describe('the guard follows a helper, and can fail through one (review 6933630856)', () => {
    const head = "import { t, tn } from '@beanpool/core';\n";
    it("a name in a title a helper returns, read through a local: joinedNudgeWords's \"You're in {name}\"", () => {
        const src = `${head}function nudgeWords(kind, name) {
    if (kind === 'a') return { title: t("You're in {name}", { name }), body: t('A.') };
    return { title: t("You're in {name}", { name }), body: t('B.') };
}
async function joined() {
    const nudge = nudgeWords(await kindOf(), name);
    Alert.alert(nudge.title, nudge.body, []);
}`;
        expect(checkSource('app/x.tsx', src)).toEqual([expect.stringMatching(/title puts in \{name\}: "You're in \{name\}"/)]);
    });
    it("a name in a title a helper returns directly: joinedTitle's", () => {
        const src = `${head}function placeTitle(place) { return place.global ? t('Welcome') : t("You're in {name}", { name: place.name }); }
Alert.alert(placeTitle(p), t('Body.'), []);`;
        expect(checkSource('app/x.tsx', src)).toEqual([expect.stringMatching(/title puts in \{name\}: "You're in \{name\}"/)]);
    });
    it('English written as a template: join-another-community.ts\'s own words', () => {
        expect(checkSource('app/x.tsx', `${head}Alert.alert(\`You're in \${name}\`, body, []);`)).toEqual([expect.stringMatching(/title puts in \{name\}: "You're in \{name\}"/)]);
    });
    it('a word function with an argument, a method of an object of words', () => {
        const src = `${head}const COPY = { failed: (name) => t('Could not withdraw the invitation to {name}', { name }) };
Alert.alert(COPY.failed(who), t('Please try again.'));`;
        expect(checkSource('app/x.tsx', src)).toEqual([
            expect.stringMatching(/title of 43 characters/),
            expect.stringMatching(/title puts in \{name\}/),
        ]);
    });
    it('passes: the helper\'s title is short, the name leads its message', () => {
        const src = `${head}function nudgeWords(name) { return { title: t('Welcome'), body: twoParagraphs(t("You're in {name}", { name }), t('A.')) }; }
function go() { const nudge = nudgeWords(n); Alert.alert(nudge.title, nudge.body, []); }`;
        expect(checkSource('app/x.tsx', src)).toEqual([]);
        const found = alertsIn(parse('app/x.tsx', src));
        expect(worded(found[0].message).map((l) => l.en)).toEqual(["You're in {name}", 'A.']);
    });
    it("a helper's field the screen checked first is not read as a missing message (people.tsx's billAsked.error)", () => {
        const src = `${head}function ask(x) { return x ? { error: null } : { error: t('Too long.') }; }
function go() { const asked = ask(v); if (asked.error) { Alert.alert(t('Not sent'), asked.error); } }`;
        expect(checkSource('app/x.tsx', src)).toEqual([]);
    });
});

describe('rule 5 can fail: no part of an Alert stays English beside a translated part (review 6933630856)', () => {
    const head = "import { t, word } from '@beanpool/core';\nconst W = { remove: word('Remove', 'button: remove a guest'), ask: word('Remove {name}?'), what: word('What happens.') };\n";
    const both = { 'Remove': 'Entfernen', 'Remove {name}?': '{name} entfernen?', 'What happens.': 'Was passiert.' };
    const gaps = (src: string, cats: Catalogs) => translationGaps(alertsIn(parse('app/x.tsx', src)), cats);
    it("a title whose key carries a translator's note no catalog has (the guest Remove's t(W.remove))", () => {
        expect(gaps(`${head}Alert.alert(t(W.remove), twoParagraphs(t(W.ask, { name }), t(W.what)), []);`, { de: both, fr: both }))
            .toEqual([expect.stringMatching(/title "Remove" stays English in 2 language\(s\) its message is shown in \(de, fr\)/)]);
    });
    it("a paragraph of the message whose key left the catalogs (the guest Remove's 'Remove {name}?')", () => {
        const rest = Object.fromEntries(Object.entries(both).filter(([k]) => k !== 'Remove {name}?'));
        expect(gaps(`${head}Alert.alert(t('Remove'), twoParagraphs(t(W.ask, { name }), t(W.what)), []);`, { de: rest }))
            .toEqual([expect.stringMatching(/message "Remove \{name\}\?" stays English in 1 language\(s\) its message is shown in \(de\)/)]);
    });
    it('passes: every part translated; and a screen with no word translated yet (nothing beside it is shown translated)', () => {
        expect(gaps(`${head}Alert.alert(t('Remove'), twoParagraphs(t(W.ask, { name }), t(W.what)), []);`, { de: both, fr: both })).toEqual([]);
        expect(gaps(`${head}Alert.alert(t('Remove'), twoParagraphs(t(W.ask, { name }), t(W.what)), []);`, { de: {} })).toEqual([]);
    });
});

describe('every Alert in the phone app', () => {
    const found = ROOTS.flatMap((r) => listSources(path.join(NATIVE, r))).flatMap((abs) => {
        const text = fs.readFileSync(abs, 'utf8');
        return text.includes('Alert.alert') ? alertsIn(parse(path.relative(NATIVE, abs).split(path.sep).join('/'), text)) : [];
    });
    const { problems, usedShort, usedNamed, usedPass } = check(found);
    const cats = loadCatalogs();
    const LANGS = Object.keys(cats).sort();

    it('reads hundreds of Alerts (the scan is not empty), and all 24 languages', () => {
        expect(found.length).toBeGreaterThan(400);
        expect(LANGS).toHaveLength(24);
    });
    it('keeps its words in the message, under a short title', () => {
        expect(problems).toEqual([]);
    });
    it('lists no entry that matches nothing', () => {
        expect(Object.keys(SHORT_TITLE_ONLY).filter((k) => !usedShort.has(k))).toEqual([]);
        expect(Object.keys(NAMED_TITLES).filter((k) => !usedNamed.has(k))).toEqual([]);
        expect(Object.keys(PASS_THROUGH).filter((k) => !usedPass.has(k))).toEqual([]);
    });
    it('rule 5: no part of an Alert stays English in a language another part of its message is shown in', () => {
        expect(translationGaps(found, cats)).toEqual([]);
    });

    // Review 6933630856, finding 2 and the brief's class: every Alert that tells a member they joined a community. A
    // community's name can be 120 characters (REGISTRAR_COMMUNITY_NAME_MAX); in a title it was cut at two lines.
    const JOINED = ['app/(tabs)/people.tsx', 'app/community-card.tsx', 'app/find-community.tsx', 'app/node-mismatch.tsx', 'app/join-open-door.tsx'];
    it.each(JOINED)("%s: the joined Alert names the community in its message (\"You're in {name}\"), under the short title Welcome", (file) => {
        const joined = found.filter((f) => f.key === file && worded(f.message).some((l) => l.en === "You're in {name}"));
        expect(joined.map((f) => f.at)).toHaveLength(1);
        expect([...new Set(joined[0].title.map((l) => (l.kind === 'text' ? l.en : `<${l.kind}>`)))]).toEqual(['Welcome']);
        expect(problems.filter((p) => p.startsWith(`${joined[0].at}:`))).toEqual([]);
    });

    // Review 6933630856, finding 1 and the brief: a title this round chose, or a word it moved into a message, is shown in
    // all 24 languages: "Remove {name}?" went English when its key left the phone's catalogs, and t(W.remove) was a key no
    // catalog has. One row each; each failed on 05047cec.
    const MOVED: Array<[string, 'title' | 'message', string]> = [
        ['components/GroupGuestsList.tsx', 'title', 'Remove'],
        ['components/GroupGuestsList.tsx', 'message', 'Remove {name}?'],
        ['components/GroupGuestsList.tsx', 'message', 'Nothing more of this chat reaches them. What they already have stays with them.'],
        ['components/GroupGuestsList.tsx', 'message', 'Their invitation is withdrawn.'],
        ['app/contacts.tsx', 'title', 'Contacts'],
        ...JOINED.map((file): [string, 'title', string] => [file, 'title', 'Welcome']),
        ...JOINED.map((file): [string, 'message', string] => [file, 'message', "You're in {name}"]),
        ['app/(tabs)/index.tsx', 'title', 'From your community'],
        ['components/GroupInvitedList.tsx', 'title', 'Something went wrong'],
        ['components/GroupInvitedList.tsx', 'message', 'Could not withdraw the invitation'],
    ];
    it.each(MOVED)('%s: its %s "%s" is translated in all 24 languages', (file, part, en) => {
        const shown = found.filter((f) => f.key === file).flatMap((f) => worded(f[part])).filter((l) => l.en === en);
        expect(shown.length, `no Alert in ${file} shows "${en}" in its ${part}`).toBeGreaterThan(0);
        for (const l of shown) expect([...langsOf(cats, l.key)].sort(), `${file}: ${l.key}`).toEqual(LANGS);
    });

    // The titles the guard read for the first time once it followed a helper (review 6933630856's class), each too long
    // for two lines: none is a title now, and nothing in its file breaks a rule. One row each; each failed on 05047cec.
    const FOLLOWED: Array<[string, string]> = [
        ['app/(tabs)/index.tsx', 'An admin answered. Open Invites to read it.'], // core inviteAskNoticeHere: a notice's own title
        ['components/GroupInvitedList.tsx', 'Could not withdraw the invitation'], // core withdrawWords(p).failed
        ['components/ShowOnGlobalRow.tsx', 'Also show this on the global community'], // showOnGlobalLabel(), three Alerts
    ];
    it.each(FOLLOWED)('%s: "%s" is no Alert\'s title', (file, en) => {
        expect(found.filter((f) => f.key === file && worded(f.title).some((l) => l.en === en)).map((f) => f.at)).toEqual([]);
        expect(problems.filter((p) => p.startsWith(`${file}:`))).toEqual([]);
    });
});
