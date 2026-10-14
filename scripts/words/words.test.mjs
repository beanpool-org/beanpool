// words.test.mjs — the words tooling (scripts/words/words.mjs): extraction, words:check and the words:lint ratchet.
// node --test scripts/words/words.test.mjs (test-all.sh runs it as the "words" check). In memory, but for one temporary
// folder of catalogs under the OS temp dir, removed after.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
    BASELINE, ROOT, catalogLangs, checkRepo, compareToBaseline, countStrings, extractFromSource, extractRepo, lintCounts, unexplainedRises,
    updatedBaseline,
} from './words.mjs';

const pkgOf = (file, text, extra = {}) => {
    const { calls, found, problems } = extractFromSource(file, text);
    return { name: 'fixture', dirs: [], words: 'fixture/words', lint: true, files: 1, calls, found, problems, ...extra };
};
const EMPTY = { 'fixture/words': { ru: {}, fr: {}, pt: {}, es: {} } };


test('a sentence fragment fails words:check: a space at an end, a "+" join', async () => {
    const src = `import { t } from '@beanpool/core';\nexport const line = (n: number) => t('You have ') + n + t(' messages');\n`;
    const { problems } = await checkRepo({ extracted: [pkgOf('fixture/a.ts', src)], catalogs: EMPTY });
    assert.equal(problems.length, 2);
    assert.match(problems[0], /^fixture\/a\.ts:2: .*fragment/);
    assert.match(problems[1], /^fixture\/a\.ts:2: .*fragment/);
});

test('a whole sentence with placeholders passes; a word that is not a literal fails (so no recovery word can pass through t())', async () => {
    const ok = `import { t, tn } from '@beanpool/core';\nexport const a = (n: number, name: string) => [t('{name} has {n} beans', { name, n }), tn(n, '{n} bean', '{n} beans')];\n`;
    assert.deepEqual((await checkRepo({ extracted: [pkgOf('fixture/ok.ts', ok)], catalogs: EMPTY })).problems, []);
    const bad = `import { t } from '@beanpool/core';\nexport const say = (words: string[]) => words.map((word) => t(word));\n`;
    const { problems } = await checkRepo({ extracted: [pkgOf('fixture/bad.ts', bad)], catalogs: EMPTY });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /takes a string literal/);
});

test('only t/tn imported from core or a words module count; an alias is followed; a local t is not mistaken for it', () => {
    const local = `const t = (s: string) => s;\nexport const x = t('Not the words layer ');\n`;
    assert.equal(extractFromSource('fixture/local.ts', local).calls.length, 0);
    const alias = `import { t as tr } from '../words.js';\nexport const x = tr('Save');\n`;
    assert.deepEqual(extractFromSource('fixture/alias.ts', alias).calls.map((c) => c.text), ['Save']);
});

test('catalogs: placeholder parity, plural forms and stale keys are refused; an untranslated key is not', async () => {
    const src = `import { t, tn } from '@beanpool/core';\nexport const a = (n: number, name: string) => [t('{name} joined', { name }), tn(n, '{n} bean', '{n} beans')];\n`;
    const catalogs = { 'fixture/words': {
        ru: { '{n} bean|{n} beans': { one: '{n} боб', other: '{n} боба' } },
        fr: { '{name} joined': 'a rejoint' },
        pt: { 'Gone sentence': 'Frase' },
        es: { '{name} joined': '' },
    } };
    const { problems } = await checkRepo({ extracted: [pkgOf('fixture/c.ts', src)], catalogs });
    // In LANGS order (pt, fr, ru).
    assert.deepEqual(problems.map((p) => p.replace(/^fixture\/words\//, '')), [
        'pt.json: "Gone sentence": no source uses this key any more (the English changed or the sentence was removed)',
        'fr.json: "{name} joined": placeholders differ from the English: dropped {name}',
        'ru.json: "{n} bean|{n} beans": ru needs the "few" form (one, few, many, other)',
        'ru.json: "{n} bean|{n} beans": ru needs the "many" form (one, few, many, other)',
    ]);
});

test('what a member reads outside t() is found: JSX text, text props, alerts, sentences; text inside t() is not', () => {
    const src = [
        "import { t } from '@beanpool/core';",
        "import { Alert } from 'react-native';",
        'export function A() {',
        "    Alert.alert('Could not save', 'Try again in a minute.');",
        "    console.log('Debug line with words');",
        "    const msg = 'Your offer is live now';",
        '    return (<View testID="Save button" className="Foo bar">',
        "        <Text>Hello there</Text><Text>{t('Translated already')}</Text>",
        '        <TextInput placeholder="Type a message" />',
        "        <Text>{'Literal child'}</Text>",
        '    </View>);',
        '}',
    ].join('\n');
    const { calls, found } = extractFromSource('fixture/A.tsx', src);
    assert.deepEqual(calls.map((c) => c.text), ['Translated already']);
    assert.deepEqual(found.map((f) => `${f.kind}:${f.text}`).sort(), [
        'alert:Could not save', 'alert:Try again in a minute.', 'jsx:Hello there', 'jsx:Literal child', 'jsx:Type a message',
        'sentence:Your offer is live now',
    ]);
    assert.deepEqual(lintCounts([pkgOf('fixture/A.tsx', src)]), { fixture: 5 });
});

test('the ratchet fails a rise, reports a fall, and counts a new directory from zero', () => {
    const { rises, falls } = compareToBaseline({ a: 3, b: 1, c: 2 }, { a: 2, b: 4 });
    assert.deepEqual(rises, [{ dir: 'a', was: 2, is: 3 }, { dir: 'c', was: 0, is: 2 }]);
    assert.deepEqual(falls, [{ dir: 'b', was: 4, is: 1 }]);
});

test('the repository passes words:check and is at or under the words:lint baseline', async () => {
    const extracted = extractRepo(ROOT);
    const { problems, catalogCount } = await checkRepo({ extracted });
    assert.deepEqual(problems, []);
    assert.equal(catalogCount, 16);
    const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE), 'utf8')).counts;
    assert.deepEqual(compareToBaseline(lintCounts(extracted), baseline).rises, []);
    // Every package is scanned (an empty row would mean a moved folder silently dropped out of the count).
    for (const row of countStrings(extracted)) assert.ok(row.files > 0 && row.total > 0, `${row.package} scanned nothing`);
});

const problemsOf = async (file, src) => (await checkRepo({ extracted: [pkgOf(file, src)], catalogs: EMPTY })).problems;

test('fragments the "+" rule missed: a template literal, a joined array, JSX siblings (N6)', async () => {
    const head = "import { t } from '@beanpool/core';\n";
    const tpl = await problemsOf('fixture/tpl.ts', `${head}export const a = (n: number) => \`\${t('You have')} \${n} \${t('messages')}\`;\n`);
    assert.equal(tpl.length, 2);
    assert.match(tpl[0], /fixture\/tpl\.ts:2: .*fragment/);
    const joined = await problemsOf('fixture/join.ts', `${head}export const a = (n: number) => [t('You have'), n, t('messages')].join(' ');\n`);
    assert.equal(joined.length, 2);
    assert.match(joined[0], /fragment/);
    const jsx = await problemsOf('fixture/J.tsx', `${head}export const J = ({ n }: { n: number }) => <Text>{t('You have')} {n} {t('messages')}</Text>;\n`);
    assert.equal(jsx.length, 2);
    assert.match(jsx[0], /fragment/);
    const words = await problemsOf('fixture/W.tsx', `${head}export const W = () => <Text>{t('You have')} new messages</Text>;\n`);
    assert.equal(words.length, 1);
    // Whole sentences are fine: alone in a template, beside elements, in a ternary, one per array element that is not joined.
    const ok = [
        `${head}export const a = () => \`\${t('Saved')}\`;`,
        `${head}export const B = ({ c }: { c: boolean }) => <View>{t('Saved')}<Icon />{c && <Badge />}{c ? <A /> : null}{items.map((i) => <Row key={i} />)}</View>;`,
        `${head}export const C = ({ c }: { c: boolean }) => <Text>{c ? t('Saving') : t('Save')}</Text>;`,
        `${head}export const d = () => [t('Save'), t('Cancel')];`,
        `${head}export const e = (n: number) => t('You have {n} messages', { n });`,
    ].join('\n');
    assert.deepEqual(await problemsOf('fixture/ok.tsx', ok), []);
});

test('word() marks a sentence in a table; t(table.key) is accepted (tsc checks it); a bare variable is not (N5)', async () => {
    const src = [
        "import { t, word } from '@beanpool/core';",
        "const KINDS = { paid: { body: word('{name} paid you') }, post: { label: word('Post', 'button: publish') } } as const;",
        "export const say = (kind: 'paid', name: string) => t(KINDS[kind].body, { name });",
        'export const label = () => t(KINDS.post.label);',
        'export const bad = (w: string) => t(w);',
    ].join('\n');
    const { calls } = extractFromSource('fixture/k.ts', src);
    assert.deepEqual(calls.map((c) => [c.fn, c.text, c.context ?? null, !!c.keyed, !!c.moduleLevel]), [
        ['word', '{name} paid you', null, false, true], ['word', 'Post', 'button: publish', false, true],
        ['t', null, null, true, false], ['t', null, null, true, false], ['t', null, null, false, false],
    ]);
    const problems = await problemsOf('fixture/k.ts', src);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /^fixture\/k\.ts:5: .*not a variable/);
    // The word() keys are what a catalog is checked against.
    const { problems: stale } = await checkRepo({
        extracted: [pkgOf('fixture/k.ts', src.split('\n').slice(0, 4).join('\n'))],
        catalogs: { 'fixture/words': { ...EMPTY['fixture/words'], fr: { '{name} paid you': '{name} vous a payé', 'Post\u0004button: publish': 'Publier' } } },
    });
    assert.deepEqual(stale, []);
});

test('t()/tn() at module level is refused: it would freeze the language the app started in (N5)', async () => {
    const src = "import { t, tn } from '@beanpool/core';\nexport const LABEL = t('Save changes');\nexport const N = tn(2, '{n} bean', '{n} beans');\nexport class X { label = t('Fine per instance'); static S = t('Not fine'); }\n";
    const problems = await problemsOf('fixture/m.ts', src);
    assert.deepEqual(problems.map((p) => p.split(': ')[0]), ['fixture/m.ts:2', 'fixture/m.ts:3', 'fixture/m.ts:4']);
    assert.match(problems[0], /module level/);
    assert.equal(problems.filter((p) => /Fine per instance/.test(p)).length, 0);
});

test('t is seen through a namespace import, a re-export, a hook and wordsFor; re-exporting it outside a words module is refused (N7)', async () => {
    const cases = {
        'fixture/ns.ts': "import * as core from '@beanpool/core';\nexport const a = (w: string) => core.t(w);\n",
        'fixture/re.ts': "import { t } from '../utils/i18n';\nexport const a = (w: string) => t(w);\n",
        'fixture/Hook.tsx': "import { useWords } from '../words/provider';\nexport function H({ w }: { w: string }) { const { t } = useWords(); return <Text>{t(w)}</Text>; }\n",
        'fixture/hook2.ts': "export function h(w: string) { const words = useWords(); return words.tn(2, w, w); }\n",
        'fixture/server.ts': "import { wordsFor } from '@beanpool/core';\nexport const a = (lang: 'fr', w: string) => wordsFor(lang).t(w);\nexport const b = (lang: 'fr', w: string) => { const x = wordsFor(lang); return x.t(w); };\n",
    };
    for (const [file, src] of Object.entries(cases)) {
        const problems = await problemsOf(file, src);
        assert.ok(problems.length >= 1 && problems.every((p) => /not a variable/.test(p)), `${file}: ${JSON.stringify(problems)}`);
    }
    const reexport = await problemsOf('fixture/i18n.ts', "export { t, tn as plural } from '@beanpool/core';\n");
    assert.equal(reexport.length, 2);
    assert.match(reexport[0], /re-exports t\(\): only a module named "words"/);
    assert.deepEqual(await problemsOf('fixture/words.ts', "export { t, tn } from '@beanpool/core';\n"), []);
    // A local function that happens to be called t is still not the words layer.
    assert.equal(extractFromSource('fixture/local.ts', "const t = (s: string) => s;\nexport const x = (w: string) => t(w);\n").calls.length, 0);
});

test('the baseline cannot rise without --raise "<reason>", which is recorded; a fall needs nothing (N8)', () => {
    const doc = { counts: { a: 3, b: 2 } };
    assert.deepEqual(updatedBaseline(doc, { a: 2, b: 2 }).doc.counts, { a: 2, b: 2 });
    assert.deepEqual(updatedBaseline(doc, { a: 4, b: 2 }).error, ['a: 3 → 4']);
    assert.deepEqual(updatedBaseline(doc, { a: 4, b: 2 }, { raise: '  ' }).error, ['a: 3 → 4']);
    const raised = updatedBaseline(doc, { a: 4, b: 2 }, { raise: 'merged #1931: one alert', date: '2026-10-15' }).doc;
    assert.deepEqual(raised.raises, [{ date: '2026-10-15', reason: 'merged #1931: one alert', dirs: { a: [3, 4] } }]);
    // Compared with main's file: an unexplained rise is caught, an explained one is not, a fall never is.
    assert.deepEqual(unexplainedRises(doc, { counts: { a: 4, b: 1 } }), [{ dir: 'a', was: 3, is: 4 }]);
    assert.deepEqual(unexplainedRises(doc, raised), []);
    assert.deepEqual(unexplainedRises(doc, { counts: { a: 1 } }), []);
    assert.deepEqual(unexplainedRises(null, { counts: { a: 99 } }), []);
});

test('the committed baseline has no rise over origin/main\'s that lacks a recorded reason (when main has the file)', (t) => {
    let main = null;
    try {
        main = JSON.parse(execFileSync('git', ['show', `origin/main:${BASELINE}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch {
        t.skip('origin/main has no words baseline yet (or no origin/main in this checkout)');
        return;
    }
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE), 'utf8'));
    assert.deepEqual(unexplainedRises(main, doc), []);
});

test('catalogs follow core\'s LANGS: 24 tags may have one, a missing one is untranslated, a stray file is refused', async () => {
    const langs = await catalogLangs();
    assert.equal(langs.length, 24);
    assert.ok(langs.includes('zh-Hant') && langs.includes('fil') && !langs.includes('en'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'words-'));
    try {
        fs.mkdirSync(path.join(root, 'fixture/words'), { recursive: true });
        for (const [name, body] of [['zh-Hant.json', { _meta: {}, Save: '儲存' }], ['zh.json', {}], ['en.json', {}], ['en.sources.json', {}]]) {
            fs.writeFileSync(path.join(root, 'fixture/words', name), JSON.stringify(body));
        }
        const { problems, catalogCount } = await checkRepo({ root, extracted: [pkgOf('fixture/a.ts', "import { t } from '@beanpool/core';\nexport const a = () => t('Save');\n")] });
        assert.equal(catalogCount, 1);
        assert.deepEqual(problems.map((p) => p.split(':')[0]), ['fixture/words/en.json', 'fixture/words/zh.json']);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
