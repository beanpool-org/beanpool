// constants.test.mjs — the words:lint ratchet's second rule: an English sentence CONSTANT that reaches a screen counts, per
// directory, like the JSX text and alert literals do (scripts/words/README.md, "On-screen constants"). Imported by
// words.test.mjs, so test-all's "words" check runs it. In memory, but for one temporary folder under the OS temp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    BASELINE, ROOT, compareToBaseline, constantCounts, countStrings, extractFromSource, extractRepo, lintCounts, reachedConstants, unexplainedRises,
    updatedBaseline,
} from './words.mjs';

/** A package made of several files, as extractRepo would make it (facts per file, joined by reachedConstants). */
const pkgFrom = (files, extra = {}) => {
    const calls = [];
    const found = [];
    const problems = [];
    const constants = [];
    for (const [file, src] of Object.entries(files)) {
        const r = extractFromSource(file, src);
        calls.push(...r.calls);
        found.push(...r.found);
        problems.push(...r.problems);
        constants.push(r.constants);
    }
    return { name: 'fixture', dirs: [], words: 'fixture/words', lint: true, files: Object.keys(files).length, calls, found, problems, constants, ...extra };
};
const reached = (files, extra) => reachedConstants([pkgFrom(files, extra)]).map((c) => c.name).sort();

test('a sentence constant a screen shows is counted: a JSX child, a text prop, an alert, a share sheet, a push', () => {
    const files = {
        'app/lines.ts': [
            "export const SAVED_LINE = 'Your changes were saved to this phone.';",
            "export const INPUT_HINT = 'Type a few words about it';",
            "export const WARN_TITLE = 'Could not save this';",
            "export const WARN_BODY = 'Try again in a minute, please.';",
            "export const SHARE_TITLE = 'Your recovery kit file';",
            "export const PUSH_BODY = 'Someone answered your ask';",
        ].join('\n'),
        'app/Screen.tsx': [
            "import { Alert } from 'react-native';",
            "import * as Sharing from 'expo-sharing';",
            "import * as Notifications from 'expo-notifications';",
            "import { SAVED_LINE, INPUT_HINT, WARN_TITLE, WARN_BODY, SHARE_TITLE, PUSH_BODY } from './lines';",
            'export function Screen() {',
            '    Alert.alert(WARN_TITLE, WARN_BODY);',
            "    Sharing.shareAsync('file:///kit.pdf', { dialogTitle: SHARE_TITLE });",
            '    Notifications.scheduleNotificationAsync({ content: { body: PUSH_BODY } });',
            '    return (<View><Text>{SAVED_LINE}</Text><TextInput placeholder={INPUT_HINT} /></View>);',
            '}',
        ].join('\n'),
    };
    assert.deepEqual(reached(files), ['INPUT_HINT', 'PUSH_BODY', 'SAVED_LINE', 'SHARE_TITLE', 'WARN_BODY', 'WARN_TITLE']);
    // One per directory of the file that DECLARES it, however many screens show it.
    assert.deepEqual(constantCounts([pkgFrom(files)]), { app: 6 });
});

test('an alert through a function the caller passes in, as recovery-kit.ts asks its question, counts', () => {
    const src = [
        "export const ASK_LINE = 'Keep this file off cloud backups and chats.';",
        'export function ask(alert: (title: string, message: string) => void) {',
        '    alert(\'Save\', ASK_LINE);',
        '}',
    ].join('\n');
    assert.deepEqual(reached({ 'u/kit.ts': src }), ['ASK_LINE']);
});

test('the value is followed through a member path, a conditional, a template and an alias', () => {
    const files = {
        'u/copy.ts': [
            'export const COPY = {',
            "    title: 'Save your key now',",
            "    other: 'Never shown anywhere at all',",
            "    list: ['First read this line', 'Then this other line'],",
            '};',
            "export const ERROR_LINE = 'The community did not answer.';",
            "export const HINT_LINE = 'Check your connection and try again.';",
        ].join('\n'),
        'u/View.tsx': [
            "import { COPY, ERROR_LINE as ERR, HINT_LINE } from './copy';",
            'export const V = ({ bad, extra }: { bad: boolean; extra?: string }) => (',
            '    <View><Text>{COPY.title}</Text><Text>{COPY.list[0]}</Text><Text>{bad ? ERR : null}</Text><Text>{extra || `${HINT_LINE} Thanks`}</Text></View>',
            ');',
        ].join('\n'),
    };
    const got = reachedConstants([pkgFrom(files)]).map((c) => c.text).sort();
    // COPY.title and COPY.list[0] only: `other` and list[1] are not read by any screen.
    assert.deepEqual(got, ['Check your connection and try again.', 'First read this line', 'Save your key now', 'The community did not answer.']);
});

test('a constant used by an indexed or computed read counts every sentence under it', () => {
    const files = {
        'u/copy.ts': "export const LINES = { a: 'First line is here', b: 'Second line is here' };",
        'u/View.tsx': "import { LINES } from './copy';\nexport const V = ({ k }: { k: 'a' | 'b' }) => <Text>{LINES[k]}</Text>;",
    };
    assert.deepEqual(reachedConstants([pkgFrom(files)]).map((c) => c.text).sort(), ['First line is here', 'Second line is here']);
});

test('log lines, URLs, keys, constants nobody shows, a name a parameter shadows, and a language\'s own name are not counted', () => {
    const files = {
        'u/lines.ts': [
            "export const LOG_LINE = 'Debug line with some words';",
            "export const HELP_URL = 'https://beanpool.org/Some page here';",
            "export const STORAGE_KEY = 'beanpool-language';",
            "export const NEVER_SHOWN = 'Declared but used by no screen';",
            "export const message = 'A constant that a parameter shadows';",
            "export const LANGUAGE_NAMES = { vi: 'Tiếng Việt', id: 'Bahasa Indonesia' };",
        ].join('\n'),
        'u/View.tsx': [
            "import { LOG_LINE, HELP_URL, STORAGE_KEY, message, LANGUAGE_NAMES } from './lines';",
            'export function V({ message }: { message: string }) {',
            '    console.log(LOG_LINE);',
            '    logger.info(HELP_URL);',
            '    localStorage.getItem(STORAGE_KEY);',
            '    return (<View><Text>{message}</Text><Text>{LANGUAGE_NAMES.vi}</Text><Link href={HELP_URL} /></View>);',
            '}',
            'export const unused = message;',
        ].join('\n'),
    };
    assert.deepEqual(reached(files), []);
    assert.deepEqual(constantCounts([pkgFrom(files)]), {});
});

test('a sentence that is already a words key is translated where it is shown (a table keyed by the English): not counted', () => {
    const files = {
        'u/recovery-kit.ts': [
            "export const KIT_SAVE_WARNING = 'Keep this file off cloud backups and chats.';",
            "export const KIT_TITLE = 'Your recovery kit';",
            'export function ask(alert: (title: string, message: string) => void) { alert(KIT_TITLE, KIT_SAVE_WARNING); }',
        ].join('\n'),
        'u/welcome-lines.ts': [
            "import { word } from '@beanpool/core';",
            "export const LINES = { 'Keep this file off cloud backups and chats.': word('Keep this file off cloud backups and chats.') };",
        ].join('\n'),
    };
    // KIT_TITLE has no entry in any table: it is the one that reaches an alert in English.
    assert.deepEqual(reached(files), ['KIT_TITLE']);
});

test('an import is followed by its path, or by its name when one file declares it; an ambiguous name is not guessed', () => {
    const screen = "import { LINE } from '@beanpool/core';\nexport const S = () => <Text>{LINE}</Text>;\n";
    const once = reached({ 'core/src/line.ts': "export const LINE = 'Said in one place only';", 'app/S.tsx': screen });
    assert.deepEqual(once, ['LINE']);
    const twice = reached({
        'core/src/a.ts': "export const LINE = 'Said in one place here';",
        'core/src/b.ts': "export const LINE = 'Said in another place here';",
        'app/S.tsx': screen,
    });
    assert.deepEqual(twice, []);
    // A relative path settles which one, even when the name is not unique.
    const byPath = reachedConstants([pkgFrom({
        'core/src/a.ts': "export const LINE = 'Said in one place here';",
        'core/src/b.ts': "export const LINE = 'Said in another place here';",
        'app/S.tsx': "import { LINE } from '../core/src/b.js';\nexport const S = () => <Text>{LINE}</Text>;\n",
    })]);
    assert.deepEqual(byPath.map((c) => c.text), ['Said in another place here']);
});

test('only the packages the ratchet covers count; test files are not scanned, so a test that shows a constant does not count it', () => {
    const files = { 'u/lines.ts': "export const LINE = 'A line that a screen shows';", 'u/S.tsx': "import { LINE } from './lines';\nexport const S = () => <Text>{LINE}</Text>;" };
    assert.deepEqual(reachedConstants([pkgFrom(files, { lint: false })]), []);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'words-constants-'));
    try {
        fs.mkdirSync(path.join(dir, 'src/__tests__'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src/lines.ts'), "export const SHOWN_ONLY_IN_TESTS = 'A line that only a test shows';\nexport const SHOWN = 'A line that a screen shows';\n");
        fs.writeFileSync(path.join(dir, 'src/Screen.tsx'), "import { SHOWN } from './lines';\nexport const S = () => <Text>{SHOWN}</Text>;\n");
        fs.writeFileSync(path.join(dir, 'src/__tests__/lines.test.tsx'), "import { SHOWN_ONLY_IN_TESTS } from '../lines';\nexport const T = () => <Text>{SHOWN_ONLY_IN_TESTS}</Text>;\n");
        const extracted = extractRepo(dir, [{ name: 'fixture', dirs: ['src'], words: null, lint: true }]);
        assert.deepEqual(reachedConstants(extracted).map((c) => c.name), ['SHOWN']);
        assert.deepEqual(constantCounts(extracted), { src: 1 });
        // The existing counts are untouched by the new rule: a constant is neither a JSX literal nor an alert argument.
        assert.deepEqual(lintCounts(extracted), {});
        assert.equal(countStrings(extracted)[0].constants, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the constants section of the baseline: recorded by --update the first time with no --raise, then it can only fall', () => {
    const before = { counts: { a: 2 } };
    const first = updatedBaseline(before, { a: 2 }, { constants: { 'core/src': 1 } });
    assert.deepEqual(first.doc.constants, { 'core/src': 1 });
    assert.deepEqual(first.doc.counts, { a: 2 });
    assert.equal(first.doc.raises, undefined);
    // A fall needs nothing; a rise is refused without a reason and recorded with one, in its own section.
    assert.deepEqual(updatedBaseline(first.doc, { a: 2 }, { constants: {} }).doc.constants, {});
    assert.deepEqual(updatedBaseline(first.doc, { a: 2 }, { constants: { 'core/src': 2 } }).error, ['(constants) core/src: 1 → 2']);
    const raised = updatedBaseline(first.doc, { a: 2 }, { constants: { 'core/src': 2 }, raise: 'a constant a screen shows', date: '2026-11-04' }).doc;
    assert.deepEqual(raised.raises, [{ date: '2026-11-04', reason: 'a constant a screen shows', section: 'constants', dirs: { 'core/src': [1, 2] } }]);
    // A call that says nothing of constants leaves the recorded section as it was.
    assert.deepEqual(updatedBaseline(first.doc, { a: 1 }).doc.constants, { 'core/src': 1 });
});

test('against main\'s baseline: a constants rise without a recorded reason is caught; main with no section yet is not compared', () => {
    const main = { counts: { a: 1 }, constants: { x: 1 } };
    assert.deepEqual(unexplainedRises(main, { counts: { a: 1 }, constants: { x: 2 } }), [{ dir: 'x', was: 1, is: 2, section: 'constants' }]);
    assert.deepEqual(unexplainedRises(main, { counts: { a: 1 }, constants: { x: 2, y: 1 }, raises: [{ date: 'd', reason: 'why', section: 'constants', dirs: { x: [1, 2], y: [0, 1] } }] }), []);
    // A raise recorded for the counts does not excuse a constants rise in a directory of the same name.
    assert.deepEqual(unexplainedRises(main, { counts: { a: 1 }, constants: { x: 2 }, raises: [{ date: 'd', reason: 'why', dirs: { x: [1, 2] } }] }),
        [{ dir: 'x', was: 1, is: 2, section: 'constants' }]);
    // This branch introduces the rule: nothing on main to compare with, so nothing is "risen".
    assert.deepEqual(unexplainedRises({ counts: { a: 1 } }, { counts: { a: 1 }, constants: { x: 9 } }), []);
    // The existing literal rises keep their shape.
    assert.deepEqual(unexplainedRises(main, { counts: { a: 2 }, constants: { x: 1 } }), [{ dir: 'a', was: 1, is: 2 }]);
});

test('the repository is at or under the recorded on-screen constants, and the baseline has the section', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE), 'utf8'));
    assert.ok(doc.constants && typeof doc.constants === 'object', 'lint-baseline.json has a "constants" section');
    assert.deepEqual(compareToBaseline(constantCounts(extractRepo(ROOT)), doc.constants).rises, []);
});
