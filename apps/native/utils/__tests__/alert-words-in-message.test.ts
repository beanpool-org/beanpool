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
 * Then:
 *
 *   1. An Alert that can open with no message (one argument, or a message that can be undefined, null or '') must have a
 *      title it can read, and that title must be in SHORT_TITLE_ONLY with the reason it says enough alone (an options
 *      menu whose buttons are its content). Anything else puts its words in the message, under a short title.
 *   2. A title the guard can read is at most TITLE_MAX characters of English.
 *   3. A title that puts in a value other than a count (a name, an address, a guest line, a link) is in NAMED_TITLES with
 *      why that value stays short, or it moves to the message.
 *   4. A title made from an error or a server's words (`e.message`, `…ErrorWords(e)`, `…FailureWords(e)`) always fails.
 *
 * An entry in either list that no longer matches an Alert fails too, so the lists can't rot.
 *
 * What it cannot see: a title built by a function it can't call (a screen's own helper, a word function that takes an
 * argument), and translations. A title of 30 English characters can be longer in another language; TITLE_MAX leaves some
 * room for that, not all.
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
    | { kind: 'text'; en: string }
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

/** What a top-level name in this file stands for: a core export, another file's export, or a local declaration. */
type Binding = { core: string } | { node: ts.Expression; src: Source } | null;

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
                    const base = path.resolve(path.dirname(path.join(NATIVE, src.rel)), spec);
                    for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
                        const other = parseFile(cand);
                        if (other) return bindingOf(other, imported, depth + 1);
                    }
                }
                return null;
            }
        }
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
function wordOf(src: Source, objName: string, key: string, call: boolean): string | null {
    const w = wordOfRaw(src, objName, key, call);
    // A word with a translator's note is `text\u0004note` (core words.ts word()); t() shows the text.
    return w === null ? null : w.split('\u0004')[0];
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

/** `t('…')`'s or `word('…')`'s English, or null. */
function tLiteral(n: ts.Expression | ts.ConciseBody): string | null {
    const e = strip(n as ts.Expression);
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && (e.expression.text === 't' || e.expression.text === 'word')) return literalText(e.arguments[0]);
    return null;
}

function leaves(src: Source, n: ts.Expression | undefined): Leaf[] {
    if (!n) return [{ kind: 'empty' }];
    const e = strip(n);
    if (ts.isConditionalExpression(e)) return [...leaves(src, e.whenTrue), ...leaves(src, e.whenFalse)];
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
        return [...leaves(src, e.left), ...leaves(src, e.right)];
    }
    if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) return [{ kind: 'empty' }];
    const lit = literalText(e);
    if (lit !== null) return [lit === '' ? { kind: 'empty' } : { kind: 'text', en: lit }];
    const code = e.getText(src.sf).replace(/\s+/g, ' ');
    if (ts.isCallExpression(e)) {
        const callee = e.expression;
        // t('…'), t(W.key), word('…')
        if (ts.isIdentifier(callee) && (callee.text === 't' || callee.text === 'word')) {
            const a = e.arguments[0] && strip(e.arguments[0]);
            const direct = literalText(a);
            if (direct !== null) return [{ kind: 'text', en: direct }];
            if (a && ts.isPropertyAccessExpression(a) && ts.isIdentifier(a.expression)) {
                const w = wordOf(src, a.expression.text, a.name.text, false);
                if (w !== null) return [{ kind: 'text', en: w }];
            }
            return [{ kind: 'opaque', code }];
        }
        // tn(n, 'one', 'many'): both forms
        if (ts.isIdentifier(callee) && callee.text === 'tn') {
            const one = literalText(e.arguments[1]);
            const many = literalText(e.arguments[2]);
            return one !== null && many !== null ? [{ kind: 'text', en: one }, { kind: 'text', en: many }] : [{ kind: 'opaque', code }];
        }
        // W.key() and fn(): a word function called with nothing
        if (e.arguments.length === 0 && ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
            const w = wordOf(src, callee.expression.text, callee.name.text, true);
            if (w !== null) return [{ kind: 'text', en: w }];
        }
        if (e.arguments.length === 0 && ts.isIdentifier(callee)) {
            const b = bindingOf(src, callee.text);
            const fn = b && 'core' in b ? (core as Record<string, any>)[b.core] : null;
            if (typeof fn === 'function' && fn.length === 0) return [{ kind: 'text', en: String(fn()) }];
        }
        return [{ kind: 'opaque', code }];
    }
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
        const w = wordOf(src, e.expression.text, e.name.text, false);
        if (w !== null) return [{ kind: 'text', en: w }];
    }
    return [{ kind: 'opaque', code }];
}

/** An error's or a server's own words, used as a title. */
const ERRORISH = /\.message\b|ErrorWords|ErrorMessage|FailureWords|NotSentWords/;

type Found = { at: string; key: string; title: Leaf[]; messageCanBeEmpty: boolean };

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
            const message = n.arguments.length < 2 ? [{ kind: 'empty' } as Leaf] : leaves(src, n.arguments[1]);
            out.push({ at: `${src.rel}:${line}`, key: src.rel, title, messageCanBeEmpty: message.some((l) => l.kind === 'empty') });
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
        const pass = opaque.length === 1 && f.title.length === 1 ? `${f.key}: ${opaque[0].code}` : null;
        if (pass && PASS_THROUGH[pass]) usedPass.add(pass);
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
    return { problems, usedShort, usedNamed, usedPass };
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

describe('every Alert in the phone app', () => {
    const found = ROOTS.flatMap((r) => listSources(path.join(NATIVE, r))).flatMap((abs) => {
        const text = fs.readFileSync(abs, 'utf8');
        return text.includes('Alert.alert') ? alertsIn(parse(path.relative(NATIVE, abs).split(path.sep).join('/'), text)) : [];
    });
    const { problems, usedShort, usedNamed, usedPass } = check(found);

    it('reads hundreds of Alerts (the scan is not empty)', () => {
        expect(found.length).toBeGreaterThan(400);
    });
    it('keeps its words in the message, under a short title', () => {
        expect(problems).toEqual([]);
    });
    it('lists no entry that matches nothing', () => {
        expect(Object.keys(SHORT_TITLE_ONLY).filter((k) => !usedShort.has(k))).toEqual([]);
        expect(Object.keys(NAMED_TITLES).filter((k) => !usedNamed.has(k))).toEqual([]);
        expect(Object.keys(PASS_THROUGH).filter((k) => !usedPass.has(k))).toEqual([]);
    });
});
