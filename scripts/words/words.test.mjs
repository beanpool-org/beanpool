// words.test.mjs — the words tooling (scripts/words/words.mjs): extraction, words:check and the words:lint ratchet.
// node --test scripts/words/words.test.mjs (test-all.sh runs it as the "words" check). In memory; no file is written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BASELINE, ROOT, checkRepo, compareToBaseline, countStrings, extractFromSource, extractRepo, lintCounts } from './words.mjs';

const pkgOf = (file, text, extra = {}) => {
    const { calls, found } = extractFromSource(file, text);
    return { name: 'fixture', dirs: [], words: 'fixture/words', lint: true, files: 1, calls, found, ...extra };
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
    assert.deepEqual(problems.map((p) => p.replace(/^fixture\/words\//, '')), [
        'ru.json: "{n} bean|{n} beans": ru needs the "few" form (one, few, many, other)',
        'ru.json: "{n} bean|{n} beans": ru needs the "many" form (one, few, many, other)',
        'fr.json: "{name} joined": placeholders differ from the English: dropped {name}',
        'pt.json: "Gone sentence": no source uses this key any more (the English changed or the sentence was removed)',
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
